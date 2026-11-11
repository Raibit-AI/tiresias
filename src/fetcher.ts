// SPDX-License-Identifier: Apache-2.0
// The polite fetcher: safety (safety.ts) plus the site's rules (rules.ts).
// Every request except robots.txt itself goes through politeFetch.
import { cooldownLeft, setCooldown } from "./cooldown.js";
import { Refused, Walled } from "./errors.js";
import { spacingMs } from "./hosts.js";
import { Turns, cooldownRefusal } from "./queue.js";
import { checkAllowed } from "./rules.js";
import { assertSiteAllowed } from "./sites.js";
import { safeFetch, type RawResponse, type SafeFetchOptions } from "./safety.js";
import { detectWall, type WallInfo } from "./walls.js";

export { Refused, Walled } from "./errors.js";
export { mapSizes, throttle } from "./queue.js";

const MAX_CRAWL_DELAY = 30; // seconds. Longer than this and we decline rather than stall an agent.

// The site's rules for one request, checked before anything is sent: a Retry-After wait, robots.txt (and a
// wall in front of it), a Crawl-delay Tiresias will not wait for. ONE check, used by politeFetch before
// every hop and by form_submit before it claims a slip (v0.5.1: it had its own copy).
export type Policy =
  | { ok: true; crawlDelay: number }
  | { ok: false; wall: WallInfo; wallUrl: string }
  | { ok: false; refused: string; retryAfter?: string; retrySeconds?: number };
export const COOLDOWN_TEXT = "The site asked Tiresias to wait (Retry-After). Not calling it again yet.";
export const CRAWL_DELAY_TEXT = "The site asks for a Crawl-delay longer than Tiresias will wait.";
export async function policyCheck(u: URL): Promise<Policy> {
  assertSiteAllowed(u); // W-25 (v0.6): before anything else, and before a form submit claims a slip
  if (cooldownLeft(u.origin) > 0) return { ok: false, refused: COOLDOWN_TEXT, retrySeconds: cooldownLeft(u.origin) };
  const d = await checkAllowed(u);
  if (d.wall) return { ok: false, wall: d.wall, wallUrl: d.wallUrl ?? u.href };
  if (!d.allowed) return { ok: false, refused: d.reason ?? "Not allowed by robots.txt.", retryAfter: d.retryAfter, retrySeconds: d.retrySeconds };
  if (d.crawlDelay > MAX_CRAWL_DELAY) return { ok: false, refused: CRAWL_DELAY_TEXT };
  return { ok: true, crawlDelay: d.crawlDelay };
}

export async function politeFetch(url: string, opts: SafeFetchOptions = {}): Promise<RawResponse> {
  const turns = new Turns();
  try {
    return await politeFetchHeld(url, opts, turns);
  } finally {
    turns.giveBack();
  }
}

async function politeFetchHeld(url: string, opts: SafeFetchOptions, turn: Turns): Promise<RawResponse> {
  const res = await safeFetch(url, {
    ...opts,
    onHeaders: (hop) => {
      // Record the wait the moment 429/503 headers arrive, even if the body never finishes.
      if (hop.status === 429 || hop.status === 503) setCooldown(hop.url.origin, hop.status, hop.headers.get("retry-after"));
      if (hop.redirect && hop.headers.has("retry-after")) {
        const seconds = setCooldown(hop.url.origin, hop.status, hop.headers.get("retry-after"));
        if (seconds > 0) throw new Refused(COOLDOWN_TEXT, undefined, seconds, hop.url.href);
      }
      // A challenge (cf-mitigated) on ANY hop is a wall at that hop: a redirect is not
      // followed, and a 304 is not accepted as a revalidation. Plain 401/402/403 final
      // responses are handled with their body by the engine.
      const w = detectWall({ status: hop.status, headers: hop.headers }, true);
      if (w) throw new Walled(w, hop.url.href);
      opts.onHeaders?.(hop);
    },
    beforeRequest: async (u, signal) => {
      turn.leaveOthers(u);
      const p = await policyCheck(u);
      if (!p.ok && "wall" in p) throw new Walled(p.wall, p.wallUrl);
      if (!p.ok) throw p.refused === COOLDOWN_TEXT ? cooldownRefusal(u.origin, u.href) : new Refused(p.refused, p.retryAfter, p.retrySeconds, u.href);
      const d = p;
      // v0.5.1: every request is queued and spaced, by at least the default spacing (1 s).
      // W-25 (v0.6): a site's own spacing raises it further, never lowers it (applied in the queue, queue.ts).
      await turn.take(u, Math.max(d.crawlDelay, spacingMs() / 1000), signal);
    },
  });
  return res;
}
