// SPDX-License-Identifier: Apache-2.0
// N-06: the per-site queue. Every request (pages, discovery probes, robots.txt) waits its turn here and
// is spaced from the one before it by the site's spacing (1 s by default, or a larger Crawl-delay).
import { cooldownLeft, onCooldown } from "./cooldown.js";
import { FetchError, Refused } from "./errors.js";
import { acquireActive, extendNext, noteCompletion, reserve } from "./hosts.js";
import { MAX_HOSTS } from "./lru.js";
import { canonOrigin } from "./sitekey.js";
import { noteApplied, siteSpacing } from "./sites.js";

// Bounded (v0.5.1): a long-running MCP server keeps at most MAX_HOSTS sites in each. A queue entry is
// removed when its last request has had its turn, and a site's waiting set when it is empty.
// When each site was last called. Kept while its spacing can still matter (the longest wait is a 30-second
// Crawl-delay), then pruned (Codex round 78: evicting by count could drop a spacing still owed).
const lastHit = new Map<string, number>();
const HIT_KEEP_MS = 60_000;
// The earliest the NEXT request may start, as the last request's own spacing said (Codex round 79: a
// 30-second Crawl-delay must hold even when the next request asks for only 1 second, private calls
// included, which write no shared file).
const nextOk = new Map<string, number>();
// A Crawl-delay learned from robots.txt applies from then on, even if no page request ever passes
// (Codex round 83: a denied path left the next robots refresh only the default spacing).
// v0.6 (Codex round 10): the largest spacing a site asked for lately (a request's own, or a Crawl-delay learned
// from robots.txt), so a held turn that completes late moves the clocks on by the FULL delay from completion.
const delayOf = new Map<string, number>();
const noteDelayMs = (origin: string, ms: number) => {
  delayOf.set(origin, Math.max(delayOf.get(origin) ?? 0, ms));
  if (delayOf.size > MAX_HOSTS) for (const k of delayOf.keys()) if (!lastHit.has(k)) delayOf.delete(k);
};
export function noteDelay(origin: string, seconds: number): void {
  if (seconds <= 0) return;
  origin = canonOrigin(origin);
  noteDelayMs(origin, seconds * 1000);
  const until = (lastHit.get(origin) ?? Date.now()) + seconds * 1000;
  nextOk.set(origin, Math.max(nextOk.get(origin) ?? 0, until));
  extendNext(origin, until); // other processes too (round 84)
}
function noteHit(origin: string, t: number, delayMs = 0): void {
  lastHit.set(origin, t);
  nextOk.set(origin, Math.max(nextOk.get(origin) ?? 0, t + delayMs));
  if (nextOk.size > MAX_HOSTS) for (const [k, v] of nextOk) if (v < t - HIT_KEEP_MS) nextOk.delete(k);
  if (lastHit.size > MAX_HOSTS) for (const [k, v] of lastHit) if (t - v > HIT_KEEP_MS) lastHit.delete(k);
  // v0.6 (Codex round 11): the delay map is pruned with the clocks it belongs to.
  if (delayOf.size > MAX_HOSTS) for (const k of delayOf.keys()) if (!lastHit.has(k)) delayOf.delete(k);
}
// The queues and waiting sets are never evicted (Codex round 77: evicting a live queue let a second request
// in); each entry is removed as soon as nobody waits in it, so they hold only the sites in use right now.
const chains = new Map<string, Promise<void>>();
const waiting = new Map<string, Set<AbortController>>(); // queued requests, per site
export const mapSizes = () => ({ lastHit: lastHit.size, chains: chains.size, waiting: waiting.size, delayOf: delayOf.size }); // for tests

export const cooldownRefusal = (origin: string, url?: string) =>
  new Refused("The site asked Tiresias to wait (Retry-After). Not calling it again yet.", undefined, cooldownLeft(origin), url);

// When a site starts a cooldown, every request still queued for it is cancelled.
onCooldown.push((origin) => {
  for (const c of waiting.get(origin) ?? []) c.abort();
});

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new FetchError("The request was cancelled.", "cancelled"));
    const t = setTimeout(done, ms);
    const stop = () => (clearTimeout(t), reject(signal.reason ?? new FetchError("The request was cancelled.", "cancelled")));
    function done() {
      signal.removeEventListener("abort", stop);
      resolve();
    }
    signal.addEventListener("abort", stop, { once: true });
  });
}

// Serialise requests to one host and space them by `delay` seconds (the default spacing, or a larger
// Crawl-delay). The slot is reserved in the shared hosts/ file too (hosts.ts), so other processes space
// their requests to this site after it.
// A queued request that is cancelled (its call ended, or a cooldown began)
// leaves the queue at once and does not move the clock.
// With `hold`, the turn is kept until the returned function is called (Codex round 73: one request at a
// time means until its answer has been read, not only until it was sent); without it, the turn passes on
// as soon as the request may start.
export async function throttle(origin: string, delay: number, outer: AbortSignal, url: string, hold = false): Promise<() => void> {
  origin = canonOrigin(origin); // v0.6: "example.com." and "example.com" share one queue and one clock
  let target: URL | null = null;
  try {
    target = new URL(url);
  } catch {
    target = null;
  }
  const cancelledError = () => outer.reason ?? new FetchError("The request was cancelled.", "cancelled");
  // Already cancelled: never enqueue, never touch the clock.
  if (outer.aborted) throw cancelledError();
  const mine = new AbortController();
  // The rejection listener is attached BEFORE any abort path can run.
  const cancelled = new Promise<never>((_, rej) => mine.signal.addEventListener("abort", () => rej(new Error("queue-cancelled")), { once: true }));
  const link = () => mine.abort();
  outer.addEventListener("abort", link, { once: true });
  if (outer.aborted) mine.abort(); // aborted in between
  if (!waiting.has(origin)) waiting.set(origin, new Set());
  waiting.get(origin)!.add(mine);
  const prev = chains.get(origin) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => turn);
  chains.set(origin, tail);
  let activeRelease: () => void = () => {};
  let admittedMs = 0; // the spacing this request was admitted with
  const done = () => {
    // v0.6 (Codex round 9): a held turn ends when the answer has been read. The site's clocks are moved on from
    // THAT moment (conservative: spacing counts from completion, not from the start), before the lease is given
    // back, so time spent signing, resolving and connecting never eats the next request's spacing.
    if (hold && admittedMs > 0) {
      const t = Date.now();
      const d = Math.max(admittedMs, delayOf.get(origin) ?? 0); // a Crawl-delay learned meanwhile counts too
      lastHit.set(origin, t);
      nextOk.set(origin, Math.max(nextOk.get(origin) ?? 0, t + d)); // this process's clock (private calls too)
      noteCompletion(origin, t, t + d); // other processes: last = completion, next = max(next, completion + delay)
    }
    activeRelease();
    release();
    // Forget the site's queue only once this tail has really settled (every turn before it done), and only
    // if nobody queued behind it (Codex round 78: a cancelled waiter deleted a queue still in use).
    void tail.then(() => {
      if (chains.get(origin) === tail) chains.delete(origin);
    });
  };
  let ok = false;
  try {
    await Promise.race([prev, cancelled]);
    // Holding the turn: first the cross-process lease (Codex round 76: waiting for it AFTER reserving a
    // slot let the slot go stale), then the shared slot and its spacing.
    if (hold) activeRelease = await Promise.race([acquireActive(origin, mine.signal), cancelled]);
    // W-25 (v0.6): a site's own spacing (sites.ts) raises the spacing. Like every spacing since v0.5.1 it is per
    // ORIGIN (scheme, host and port). Settings are the call's snapshot, read once when the call started
    // (coordinator's rule after Codex round 11): a change saved meanwhile applies to calls that start after it.
    const site = target ? siteSpacing(target) : 0;
    const eff = Math.max(delay, site);
    const slot = reserve(origin, eff * 1000, Math.max((lastHit.get(origin) ?? 0) + eff * 1000, nextOk.get(origin) ?? 0));
    const wait = slot - Date.now();
    if (wait > 0) await Promise.race([sleep(wait, mine.signal), cancelled]);
    // The checks that matter: right before sending, not before queueing.
    if (mine.signal.aborted) throw new Error("queue-cancelled");
    if (cooldownLeft(origin) > 0) throw cooldownRefusal(origin, url);
    if (site > delay) noteApplied("spacing");
    noteHit(origin, Date.now(), eff * 1000);
    admittedMs = eff * 1000;
    delayOf.set(origin, admittedMs); // the latest admitted spacing; a Crawl-delay learned later raises it
    ok = true;
  } catch (e) {
    if (outer.aborted) throw cancelledError();
    if (mine.signal.aborted) throw cooldownRefusal(origin, url); // cancelled because a cooldown began
    throw e;
  } finally {
    outer.removeEventListener("abort", link);
    const w = waiting.get(origin);
    w?.delete(mine);
    if (w && !w.size) waiting.delete(origin);
    if (!ok || !hold) done();
  }
  let once = false;
  return hold ? () => void (once || ((once = true), done())) : () => {};
}

export class Turns {
  private held: { origin: string; release: () => void } | null = null;
  // Call first on every hop: the previous hop's answer is done (a redirect), so its turn is given back
  // BEFORE any policy work (its robots.txt may need the same site: Codex round 75), and the hop queues
  // again like any request (spacing, the shared slot, the cooldown, all in one place).
  leaveOthers(_u?: URL): void {
    this.giveBack();
  }
  async take(u: URL, delay: number, signal: AbortSignal): Promise<void> {
    this.giveBack();
    this.held = { origin: u.origin, release: await throttle(u.origin, delay, signal, u.href, true) };
  }
  giveBack(): void {
    this.held?.release();
    this.held = null;
  }
}

