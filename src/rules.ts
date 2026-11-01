// SPDX-License-Identifier: Apache-2.0
// N-06: obey the site. robots.txt per RFC 9309, for the user agent "Tiresias".
import { cooldownLeft, cooldownSeconds, setCooldown } from "./cooldown.js";
import { FetchError, PaymentRequired, Refused, Walled } from "./errors.js";
import { spacingMs } from "./hosts.js";
import { LruMap, MAX_HOSTS } from "./lru.js";
import { Turns, noteDelay } from "./queue.js";
import { READ_SLACK, WIRE_EXTRA, callCache, currentSignal, safeFetch } from "./safety.js";
import { isPrivate } from "./store.js";
import { callContext } from "./context.js";
import { scanBody } from "./sandbox.js";
import { detectWall, type WallInfo } from "./walls.js";

interface Rule {
  allow: boolean;
  pattern: string; // normalized
}

export interface Robots {
  mode: "parsed" | "missing" | "disallow_all" | "wall";
  rules: Rule[];
  crawlDelay: number; // seconds, 0 if none
  sitemaps: string[];
  retryAfter?: string;
  retrySeconds?: number;
  why?: string;
  wall?: WallInfo;
  wallUrl?: string;
  expires: number;
}

const ONE_HOUR = 3_600_000;
const MAX_RULES = 10_000;
const MAX_PATTERN = 2048;
const cache = new LruMap<string, Robots>(MAX_HOSTS); // bounded (v0.5.1)
export const rulesCache = cache; // for tests
// One robots.txt fetch per site at a time (v0.5.1): the probes of a first read all ask at once, and they
// share the one fetch instead of each sending its own. Not for private calls (they share nothing).
const inFlight = new Map<string, Promise<Robots>>();
export const resetRulesCache = () => cache.clear(); // for tests

// RFC 9309 2.2.2: compare percent-encoded octets. Encode non-ASCII as UTF-8
// octets, upper-case the hex, and decode unreserved characters (so %70 is p).
// Reserved characters stay as written, so /a%2Fb and /a/b remain different.
// v0.9 hardening (Codex round 3b, HIGH): in a rule, `*` and `$` are operators and a literal one is written %2A or
// %24 (RFC 9309 2.2.3). In the URL being checked they are only data, so they are encoded there, and a rule written
// /a%2Ab matches a request for /a*b.
export function normalizePath(s: string, pattern = false): string {
  const bytes = Buffer.from(s, "utf8");
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    let b = bytes[i];
    let encoded = false;
    if (b === 0x25) {
      const hex = bytes.subarray(i + 1, i + 3).toString("latin1");
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
        out += "%25"; // a lone % is data
        continue;
      }
      b = parseInt(hex, 16);
      i += 2;
      encoded = true;
    }
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-._~]/.test(c)) out += c; // unreserved: always the decoded form
    else if (!encoded && b > 0x20 && b < 0x7f && !'"<>\\^`{|}'.includes(c) && (pattern || (c !== "*" && c !== "$"))) out += c; // reserved or operator, as typed
    else out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

// Wildcard match without regex backtracking. "*" matches any run, matching is
// anchored at the start, and a trailing "$" (end = true) pins the end.
// Every step spends from a shared budget. Synchronous matching cannot be
// interrupted by a deadline, so when the budget runs out we stop and the
// caller fails closed (treats the path as disallowed).
export class BudgetExceeded extends Error {}
export const MATCH_BUDGET = 3_000_000; // steps per robots decision, roughly tens of milliseconds
export const MAX_PATH = 8192; // longer paths are refused, never truncated

export function globMatch(pat: string, s: string, end: boolean, budget: { left: number } = { left: MATCH_BUDGET }): boolean {
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  for (;;) {
    if (--budget.left < 0) throw new BudgetExceeded();
    if (i === pat.length) {
      if (!end || j === s.length) return true;
      if (star < 0 || mark >= s.length) return false;
      i = star + 1;
      mark++;
      j = mark;
      continue;
    }
    if (pat[i] === "*") {
      star = i;
      mark = j;
      i++;
      continue;
    }
    if (j < s.length && pat[i] === s[j]) {
      i++;
      j++;
      continue;
    }
    if (star >= 0 && mark < s.length) {
      i = star + 1;
      mark++;
      j = mark;
      continue;
    }
    return false;
  }
}

function matches(rule: Rule, path: string, budget: { left: number }): boolean {
  const end = rule.pattern.endsWith("$");
  return globMatch(end ? rule.pattern.slice(0, -1) : rule.pattern, path, end, budget);
}

export function parseRobots(text: string, agent = "tiresias"): Pick<Robots, "rules" | "crawlDelay" | "sitemaps"> & { overflow: boolean } {
  type Group = { agents: string[]; rules: Rule[]; delay: number };
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  let total = 0;
  let overflow = false;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const i = line.indexOf(":");
    if (i < 0) continue;
    const field = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (field === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [], delay: 0 };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase().split(/[\s/]/)[0]);
      lastWasAgent = true;
      continue;
    }
    if (field === "allow" || field === "disallow" || field === "crawl-delay") {
      lastWasAgent = false; // only real rule records end a run of User-agent lines
      if (!cur) continue;
      if (field === "crawl-delay") {
        const d = parseFloat(value);
        if (d > 0) cur.delay = d;
      } else if (value) {
        if (++total > MAX_RULES || value.length > MAX_PATTERN) {
          overflow = true; // too big to apply faithfully: the caller fails closed
          continue;
        }
        cur.rules.push({ allow: field === "allow", pattern: normalizePath(value, true) });
      }
    } else if (field === "sitemap") {
      sitemaps.push(value); // an extension record: does not touch group state
    }
  }
  // A group that names us beats the "*" group. Never both.
  let chosen = groups.filter((g) => g.agents.includes(agent));
  if (!chosen.length) chosen = groups.filter((g) => g.agents.includes("*"));
  return {
    rules: chosen.flatMap((g) => g.rules),
    crawlDelay: chosen.map((g) => g.delay).find((d) => d > 0) ?? 0,
    sitemaps,
    overflow,
  };
}

export type Verdict = "allow" | "disallow" | "over_budget";

// The full normalized path is always matched (never a truncated one). If the
// path is too long, or the rules cost too much to check, the answer is
// "over_budget", which callers treat as a refusal.
export function matchRobots(r: Pick<Robots, "rules">, pathAndQuery: string): Verdict {
  const path = normalizePath(pathAndQuery);
  if (path.length > MAX_PATH) return "over_budget";
  const budget = { left: MATCH_BUDGET };
  let best: Rule | null = null;
  try {
    for (const rule of r.rules) {
      if (!matches(rule, path, budget)) continue;
      // Longest pattern wins; on a tie, Allow wins.
      if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
    }
  } catch (e) {
    if (e instanceof BudgetExceeded) return "over_budget";
    throw e;
  }
  return best && !best.allow ? "disallow" : "allow";
}

export const isAllowed = (r: Pick<Robots, "rules">, pathAndQuery: string) => matchRobots(r, pathAndQuery) === "allow";

const closed = (why: string, ms: number, extra: Partial<Robots> = {}): Robots => ({
  mode: "disallow_all", rules: [], crawlDelay: 0, sitemaps: [], why, expires: Date.now() + ms, ...extra,
});

function untilCancelled<T>(p: Promise<T>): Promise<T> {
  const s = currentSignal();
  if (!s) return p;
  const cancelled = () => new FetchError("The request was cancelled.", "cancelled");
  if (s.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(cancelled());
    s.addEventListener("abort", stop, { once: true });
    p.then(
      (v) => (s.removeEventListener("abort", stop), resolve(v)),
      (e) => (s.removeEventListener("abort", stop), reject(e)),
    );
  });
}

export async function getRobots(origin: string): Promise<Robots> {
  if (isPrivate()) return fetchRobots(origin);
  const pending = inFlight.get(origin);
  if (pending) {
    try {
      // v0.6 (Codex round 1): waiting on another call's robots fetch still ends with THIS call's cancellation
      // and deadline (a background door check must never outlive its own deadline here).
      const r = await untilCancelled(pending);
      // Shared only when the site let it be kept (Codex round 81): a no-store robots.txt is the fetching
      // call's alone, so this call asks for its own.
      return cache.get(origin) === r ? r : fetchRobots(origin);
    } catch (e) {
      // The call that started the fetch was cancelled or ran out of time; this call was not.
      if (currentSignal()?.aborted) throw e;
      // A render's spent byte budget (W-10) is that call's own limit, never another call's.
      if (!(e instanceof FetchError && (e.code === "cancelled" || e.code === "timeout" || e.code === "budget"))) throw e;
      return fetchRobots(origin);
    }
  }
  const p = fetchRobots(origin).finally(() => inFlight.delete(origin));
  inFlight.set(origin, p);
  return p;
}

const ROBOTS_MAX = 512 * 1024; // the most of a robots.txt that is read

async function fetchRobots(origin: string): Promise<Robots> {
  const left = cooldownLeft(origin);
  if (left > 0) // never refresh robots.txt while the site has asked us to wait
    return closed("The site asked Tiresias to wait, so robots.txt was not refreshed.", 0, { retrySeconds: left });
  // Check expiry BEFORE choosing between the long-lived and the per-call cache,
  // so an expired global entry cannot hide a valid per-call one.
  const priv = isPrivate(); // a private call shares no robots state with other calls, in either direction
  const g = priv ? undefined : cache.get(origin);
  if (g && g.expires <= Date.now()) cache.delete(origin);
  const local = callCache()?.get(origin) as Robots | undefined;
  const hit = g && g.expires > Date.now() ? g : local && local.expires > Date.now() ? local : undefined;
  if (hit) return hit;
  let robots: Robots;
  let keep = !priv; // false when the site said no-store (or the call is private)
  // W-10 (v0.7): a download made for a render is charged to its byte budget (a robots.txt served from the cache, above,
  // costs nothing). The whole 512 KB it may read is taken first, never waited for: when the budget cannot cover it,
  // the request that needed it is refused as over budget, and nothing is cached for the site.
  const budget = callContext.getStore()?.renderBudget;
  const ROBOTS_COST = ROBOTS_MAX + WIRE_EXTRA; // what its connections may receive (safety.ts Wire), plus one read of slack
  if (budget && !budget.take(ROBOTS_COST)) throw new FetchError("The render's byte budget is spent.", "budget");
  let charged = budget ? ROBOTS_COST : 0; // a failure is charged in full (bytes may have arrived)
  const turns = new Turns(); // robots.txt holds its site's turn until read AND parsed, its delay noted (rounds 74, 86)
  try {
  try {
    const res = await safeFetch(origin + "/robots.txt", {
      maxBytes: ROBOTS_MAX,
      wireBytes: ROBOTS_COST - READ_SLACK,
      truncate: true,
      // A robots.txt redirect can lead to another site that is under a cooldown.
      onHeaders: (hop) => {
        // Same header rules as every other request: record Retry-After at once,
        // and stop at a challenged response (any status, including a redirect).
        if (hop.status === 429 || hop.status === 503) setCooldown(hop.url.origin, hop.status, hop.headers.get("retry-after"));
        const w = detectWall({ status: hop.status, headers: hop.headers }, true);
        if (w) {
          keep = !priv && !/(^|[\s,])no-store\b/i.test(hop.headers.get("cache-control") ?? "");
          throw new Walled(w, hop.url.href);
        }
      },
      beforeRequest: async (u, signal) => {
        if (cooldownLeft(u.origin) > 0) throw new Refused("The site asked Tiresias to wait (Retry-After). Not calling it again yet.", undefined, cooldownLeft(u.origin), u.href);
        turns.leaveOthers(u);
        await turns.take(u, spacingMs() / 1000, signal); // v0.5.1: robots.txt waits its turn too (v0.6: and a site's own spacing, in the queue)
      },
    });
    if (budget) charged = res.size ?? ROBOTS_COST; // what its connections received
    keep = !priv && !/(^|[\s,])no-store\b/i.test(res.headers.get("cache-control") ?? "");
    const finalOrigin = new URL(res.url).origin; // the site that actually answered
    const ct = res.headers.get("content-type") ?? "";
    // A bot challenge is not a robots.txt. Parsing it would find no rules and
    // wave everything through, so check for one before parsing.
    // 402 means the site wants money to read even its robots.txt. That is a price
    // tag to report, never permission to carry on.
    if (res.status === 402) throw new PaymentRequired(res.headers, res.body, res.url);
    // RFC 9309: a plain 401/403/404 on robots.txt means "no robots rules" (lenient).
    // A real challenge (header or page markers) is still a wall.
    const w =
      detectWall({ status: res.status, headers: res.headers }, true) ??
      (await scanBody(res.body, res.status, { textChars: res.body.length, lenient: true, alsoThin: res.status === 200 && /html/i.test(ct) }));
    if (w) robots = { mode: "wall", rules: [], crawlDelay: 0, sitemaps: [], wall: w, wallUrl: res.url, expires: Date.now() + 60_000 };
    // v0.9 hardening (Codex round 3b, HIGH): every success is a robots.txt to follow (RFC 9309 2.3.1.1), not
    // only a 200; a partial one (206) cannot be followed faithfully, so it means "the site says no".
    else if (res.status === 206)
      robots = closed("robots.txt came back partial (HTTP 206), so Tiresias assumes the site says no.", 60_000);
    else if (res.status >= 200 && res.status < 300 && (res.bytes !== undefined || res.file !== undefined))
      // v0.9 hardening (Codex round 2b, HIGH): a robots.txt the fetcher took for a PDF or a file comes back with no
      // text, which would parse as "no rules". What Tiresias cannot read as text, it takes as "the site says no".
      robots = closed("robots.txt was not plain text (it was sent as a PDF or a file), so Tiresias assumes the site says no.", 60_000);
    else if (res.status >= 200 && res.status < 300) {
      const p = parseRobots(res.body);
      robots = p.overflow
        ? closed("robots.txt is too large to apply faithfully, so Tiresias assumes the site says no.", ONE_HOUR)
        : { mode: "parsed", rules: p.rules, crawlDelay: p.crawlDelay, sitemaps: p.sitemaps, expires: Date.now() + ONE_HOUR };
      if (!p.overflow) noteDelay(origin, Math.min(p.crawlDelay, 30));
    } else if (res.status === 429 || res.status >= 500) {
      // RFC 9309: if robots.txt cannot be reached because of a server error,
      // assume everything is disallowed. And a 429/503 starts a cooldown.
      // The cooldown itself was recorded when the headers arrived (onHeaders above).
      const ra = res.headers.get("retry-after") ?? undefined;
      const secs = res.status === 429 || res.status === 503 ? cooldownSeconds(res.status, ra ?? null) : undefined;
      robots = closed(`robots.txt returned HTTP ${res.status}, so Tiresias assumes the site says no.`, 60_000, { retryAfter: ra, retrySeconds: secs });
    } else robots = { mode: "missing", rules: [], crawlDelay: 0, sitemaps: [], expires: Date.now() + ONE_HOUR };
  } catch (e) {
    // A challenged redirect on the way to robots.txt is a wall at that hop.
    if (e instanceof Walled) {
      robots = { mode: "wall", rules: [], crawlDelay: 0, sitemaps: [], wall: e.wall, wallUrl: e.url, expires: Date.now() + 60_000 };
      if (keep) cache.set(origin, robots);
      else callCache()?.set(origin, robots); // no-store: this call only
      return robots;
    }
    // A blocked address is a safety refusal, not a robots problem. Pass it up.
    if (!(e instanceof FetchError)) throw e;
    if (e.code === "cancelled" || e.code === "budget") throw e; // budget: a render's own limit (Codex round 5), never cached as "assume no"
    robots = closed("robots.txt could not be fetched (the site did not answer, or this computer is offline), so Tiresias assumes the site says no.", 60_000);
  }
  } finally {
    turns.giveBack();
    if (budget) budget.release(ROBOTS_COST, charged);
  }
  // Cache-Control: no-store: keep it for this one call only, never across calls.
  if (keep) cache.set(origin, robots);
  else callCache()?.set(origin, robots);
  return robots;
}

export interface Decision {
  allowed: boolean;
  reason?: string;
  crawlDelay: number;
  retryAfter?: string;
  retrySeconds?: number;
  wall?: WallInfo;
  wallUrl?: string;
}

export async function checkAllowed(u: URL): Promise<Decision> {
  const r = await getRobots(u.origin);
  if (r.mode === "wall") return { allowed: false, crawlDelay: 0, wall: r.wall, wallUrl: r.wallUrl ?? u.origin + "/robots.txt", reason: "robots.txt was behind a wall." };
  if (r.mode === "disallow_all") return { allowed: false, reason: r.why, crawlDelay: 0, retryAfter: r.retryAfter, retrySeconds: r.retrySeconds };
  const v = matchRobots(r, u.pathname + u.search);
  if (v === "over_budget") return { allowed: false, reason: "This path is too long or robots.txt too costly to check, so Tiresias assumes the site says no.", crawlDelay: r.crawlDelay };
  if (v === "disallow") return { allowed: false, reason: "robots.txt disallows this path for Tiresias.", crawlDelay: r.crawlDelay };
  return { allowed: true, crawlDelay: r.crawlDelay };
}
