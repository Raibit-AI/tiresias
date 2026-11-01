// SPDX-License-Identifier: Apache-2.0
// N-01: the API ladder. Look for a better source than the page itself.
// Order, best first: mcp > api > feed > structured > text.
// v0.1 detects every rung but only CONSUMES llms.txt/markdown, structured
// data and text. Higher rungs are reported so the agent can choose them.
import { cooldownLeft } from "./cooldown.js";
import { canonOrigin } from "./sitekey.js";
import { FetchError, PaymentRequired, Refused, SafetyError, Walled } from "./errors.js";
import { politeFetch } from "./fetcher.js";
import { getRobots } from "./rules.js";
import { throwIfCancelled, type RawResponse } from "./safety.js";
import { cachePath, isPrivate, readJson, writeJson } from "./store.js";
import { MAX_URL, type AvailableDoors, type Door, type ParsedPage } from "./types.js";
import { scanBody } from "./sandbox.js";
import { detectWall } from "./walls.js";

// Bump when discovery output changes shape or meaning, so older cached entries are discarded.
export const DOORS_VERSION = 3; // v0.5.1: llms_full_listed

export interface OriginDoors {
  v?: number;
  origin: string;
  probed_at: number;
  llms_txt?: string;
  llms_full_txt?: string;
  llms_full_listed?: true; // W-23: llms.txt itself points to llms-full.txt, so a root read uses it
  // Markdown pages that llms.txt lists, so `read` can fetch the .md twin of a page.
  llms_md?: string[];
  mcp?: string;
  api?: string;
  sitemaps: string[];
  sitemaps_omitted?: number;
}

const TTL = 3_600_000;

// A URL is a destination: shortening it makes a different one. So an advertised
// URL is kept whole or left out, and the number left out is reported.
// Lists are bounded by a total size budget as well as by per-URL length.
export function boundUrls(urls: string[], budgetChars = 4000): { items: string[]; omitted: number } {
  const items: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const u of urls) {
    if (u.length > MAX_URL || used + u.length > budgetChars || items.length >= 20) {
      omitted++;
      continue;
    }
    items.push(u);
    used += u.length;
  }
  return { items, omitted };
}

export const noStore = (h: Headers) => /(^|[\s,])no-store\b/i.test(h.get("cache-control") ?? "");

// One probe. A challenge, a login wall or a 402 stops the whole discovery
// (it throws), and the caller cancels the other probes.
// `strict` (v0.6, background checks, Codex round 1): a probe that FAILED (no answer, a timeout, a 5xx, a 429)
// is not "no door": it throws, so the sequential checks stop and nothing is cached (the next read asks again).
async function probe(url: string, maxBytes: number, ctl: AbortController, strict = false): Promise<RawResponse | null> {
  try {
    const res = await politeFetch(url, { maxBytes, truncate: true, timeoutMs: 8000, signal: ctl.signal });
    if (res.status === 402) throw new PaymentRequired(res.headers, res.body, res.url);
    if (strict && (res.status >= 500 || res.status === 429)) throw new FetchError(`A door check answered HTTP ${res.status}.`, "network");
    const html = /html/i.test(res.headers.get("content-type") ?? "") ? res.body : undefined;
    // Header challenges first (cheap), then page markers in the time-boxed sandbox.
    const w = detectWall({ status: res.status, headers: res.headers }, true) ?? (html ? await scanBody(html, res.status, { lenient: true }) : null);
    if (w) throw new Walled(w, res.url);
    return res.status === 200 ? res : null;
  } catch (e) {
    if (e instanceof Walled || e instanceof PaymentRequired) {
      ctl.abort(e); // cancel the probes still in flight
      throw e;
    }
    // Cancellation by the caller must stop the whole call, never read as "no door".
    if (e instanceof FetchError && e.code === "cancelled") throw e;
    if (strict && e instanceof FetchError && !(e instanceof SafetyError)) throw e;
    // Robots said no or the site is slow: that door is simply not available.
    if (e instanceof Refused || (e instanceof FetchError && !(e instanceof SafetyError))) return null;
    throw e;
  }
}

const isHtml = (r: RawResponse) => /html/i.test(r.headers.get("content-type") ?? "") || /^\s*<(!doctype|html)/i.test(r.body);

function sitemapFields(all: string[]) {
  const b = boundUrls(all);
  return { sitemaps: b.items, sitemaps_omitted: b.omitted || undefined };
}

// The discovery cache alone, with no request (W-03: a page served fresh from the shared cache
// costs the site nothing, so its doors come from here or are left out). Private: never read.
export function cachedDoors(origin: string): OriginDoors | null {
  if (isPrivate()) return null;
  origin = canonOrigin(origin); // v0.6: one name per site (Codex round 4)
  const cached = readJson<OriginDoors>(cachePath("doors:" + origin));
  return cached && cached.v === DOORS_VERSION && Date.now() - cached.probed_at < TTL ? cached : null;
}

// The six discovery probes, in the order they are sent.
const PROBES: [string, number][] = [
  ["/llms.txt", 512 * 1024],
  ["/llms-full.txt", 1024],
  ["/.well-known/mcp.json", 64 * 1024],
  ["/.well-known/mcp", 64 * 1024],
  ["/openapi.json", 64 * 1024],
  ["/.well-known/openapi.json", 64 * 1024],
];

// `sequential` (v0.6, W-30, background checks): each probe is queued only once the one before it is done,
// so a read of the same site that arrives meanwhile waits behind at most one probe, never all six; the
// first wall, price tag or failure stops the rest. Without it all six queue at once (spaced by the queue).
export async function probeOrigin(origin: string, opts: { sequential?: boolean } = {}): Promise<OriginDoors> {
  origin = canonOrigin(origin); // v0.6: "example.com." and "example.com" share one discovery answer (Codex round 4)
  const file = cachePath("doors:" + origin);
  // Private mode neither reads nor writes the discovery cache.
  const cached = cachedDoors(origin);
  if (cached) return cached;

  const ctl = new AbortController();
  const p = (path: string, max: number) => probe(origin + path, max, ctl, opts.sequential);
  let settled: PromiseSettledResult<unknown>[];
  if (opts.sequential) {
    settled = [];
    const steps: (() => Promise<unknown>)[] = [...PROBES.map(([path, max]) => () => p(path, max)), () => getRobots(origin)];
    for (const step of steps) {
      try {
        settled.push({ status: "fulfilled", value: await step() });
      } catch (e) {
        settled.push({ status: "rejected", reason: e });
        break;
      }
    }
  } else settled = await Promise.allSettled([...PROBES.map(([path, max]) => p(path, max)), getRobots(origin)]);
  // A wall or a price tag beats everything. After that, a cancellation from
  // the caller. Probes cancelled only because we stopped them are ignored.
  const reasons = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason);
  const first = (pred: (e: unknown) => boolean) => reasons.find(pred);
  const stop =
    first((e) => e instanceof Walled || e instanceof PaymentRequired) ??
    first((e) => !(e instanceof FetchError && e.code === "cancelled")) ??
    reasons[0];
  if (stop) throw stop;
  const [llms, full, mcp1, mcp2, api1, api2, robots] = settled.map((r) => (r as PromiseFulfilledResult<unknown>).value) as [
    RawResponse | null, RawResponse | null, RawResponse | null, RawResponse | null, RawResponse | null, RawResponse | null,
    Awaited<ReturnType<typeof getRobots>>,
  ];
  // Many sites answer 200 with their HTML homepage for any path. Check the shape.
  const jsonish = (r: RawResponse | null) => (r && !isHtml(r) && /^\s*[{[]/.test(r.body) ? r : null);
  const out: OriginDoors = { v: DOORS_VERSION, origin, probed_at: Date.now(), ...sitemapFields(robots.sitemaps) };
  if (llms && !isHtml(llms) && llms.body.trim()) {
    out.llms_txt = origin + "/llms.txt";
    const md = new Set<string>();
    // Plain indexOf scan with a bounded look-ahead: no regex on web content.
    let at = 0;
    for (let n = 0; n < 50_000 && md.size < 1000; n++) {
      at = llms.body.indexOf("](", at);
      if (at === -1) break;
      const start = at + 2;
      at = start;
      const window = llms.body.slice(start, start + 2200);
      const close = window.indexOf(")");
      if (close === -1) continue;
      const href = window.slice(0, close).trim().split(/\s/, 1)[0];
      if (!href) continue;
      try {
        const u = new URL(href, origin);
        u.hash = "";
        if (u.origin === origin && /\.md$/i.test(u.pathname)) md.add(u.href);
        if (u.origin === origin && u.pathname === "/llms-full.txt" && !u.search) out.llms_full_listed = true;
      } catch {
        // ignore unparseable links
      }
    }
    out.llms_md = [...md];
  }
  if (full && !isHtml(full) && full.body.trim()) out.llms_full_txt = origin + "/llms-full.txt";
  if (!out.llms_full_txt) delete out.llms_full_listed; // listed but not served: never used
  if (jsonish(mcp1)) out.mcp = origin + "/.well-known/mcp.json";
  else if (jsonish(mcp2)) out.mcp = origin + "/.well-known/mcp";
  const oa = (r: RawResponse | null) => (jsonish(r) && /"(openapi|swagger)"\s*:/.test(r!.body) ? r : null);
  if (oa(api1)) out.api = origin + "/openapi.json";
  else if (oa(api2)) out.api = origin + "/.well-known/openapi.json";
  // Cache-Control: no-store on any probe means do not keep what we learned from it on disk.
  const anyNoStore = [llms, full, mcp1, mcp2, api1, api2].some((r) => r && noStore(r.headers));
  // v0.6: a probe refused because the site asked Tiresias to wait (Retry-After) learned nothing: the answers
  // are used for this call but not kept, so the next read asks again once the wait is over.
  throwIfCancelled(); // a cancelled job (or call) caches nothing (Codex round 1)
  if (!anyNoStore && !isPrivate() && cooldownLeft(origin) === 0) writeJson(file, out);
  return out;
}

// Combine origin-level probes with what the page itself advertises.
export function summarize(o: OriginDoors, page?: ParsedPage): AvailableDoors {
  const feedB = boundUrls(page?.feeds ?? []);
  const svc = boundUrls(page?.service_desc ?? [], MAX_URL);
  const feeds = feedB.items;
  const api = o.api ?? svc.items[0];
  const structured = page && page.structured_count ? { count: page.structured_count, types: page.structured_types } : undefined;
  let best: Door = "text";
  if (o.mcp) best = "mcp";
  else if (api) best = "api";
  else if (feeds.length) best = "feed"; // v0.5.1: a sitemap alone lists pages; it is not a feed to read
  else if (structured) best = "structured";
  const omitted = feedB.omitted + (o.api ? 0 : svc.omitted) + (o.sitemaps_omitted ?? 0);
  return {
    best,
    llms_txt: o.llms_txt,
    llms_full_txt: o.llms_full_txt,
    mcp: o.mcp,
    api,
    feeds,
    sitemaps: o.sitemaps,
    structured_data: structured,
    omitted: omitted || undefined,
  };
}
