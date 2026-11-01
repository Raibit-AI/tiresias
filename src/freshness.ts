// SPDX-License-Identifier: Apache-2.0
// W-03: may a cached page be served again without asking the site?
// Deliberately conservative (Codex round 38): instead of following RFC 9111 edge by edge,
// only one simple form of permission counts, and anything unusual turns reuse off for good.
//
//   - Only `Cache-Control: max-age=N` gives a lifetime. `Expires` and `Date` are never used.
//   - The lifetime is capped at 1 hour, whatever max-age says.
//   - Age at the response is the `Age` header (one plain whole number of at most 9 digits).
//     The copy's age is counted from the moment the REQUEST STARTED, so the time the
//     request took counts too.
//   - Reuse is BLOCKED for this copy (sticky: `reuse_blocked`) by any of: no-store, no-cache,
//     max-age=0, a Pragma header (any value), a Vary naming anything but accept,
//     accept-encoding or user-agent, a Cache-Control over 1,000 bytes or that does not parse,
//     a Vary over 500 bytes, max-age given twice or not a plain whole number, or an Age that
//     is not one plain whole number. A 304 can never clear the block; only a full new 200
//     starts again from scratch.
//   - A 304 never keeps an old deadline (Codex round 39). For a copy that was reusable, the
//     deadline is recomputed from the 304's OWN headers only (its max-age and Age, counted from
//     that request's start); a 304 with no valid max-age leaves the copy with no freshness (a
//     deadline equal to that request's start, already past) until a later response gives one.
//     A copy that never had a lifetime is not made reusable by a 304.
// The store belongs to one owner, so `private` is fine and `s-maxage` (shared caches) is ignored.

export interface Freshness {
  fresh_until?: number; // ms since the epoch; present = the copy is reusable in principle (it may be past)
  reuse_blocked?: true; // sticky until a full new 200 replaces the copy
}

export const MAX_LIFETIME_S = 3600;
const MAX_CC = 1000;
const MAX_VARY = 500;
const SAME_EVERY_TIME = new Set(["accept", "accept-encoding", "user-agent"]);
const WHOLE = /^\d{1,9}$/;
// One directive: a token, optionally = a token or a quoted string with no quote or backslash inside.
const DIRECTIVE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+(=([A-Za-z0-9!#$%&'*+.^_`|~-]+|"[^"\\]*"))?$/;
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

type Verdict = { block: true } | { block: false; maxAge?: number; age: number };

export function judge(h: Headers): Verdict {
  if (h.has("pragma")) return { block: true };
  let maxAge: number | undefined;
  const cc = h.get("cache-control");
  if (cc !== null) {
    if (bytes(cc) > MAX_CC) return { block: true };
    let seen = false;
    for (const raw of cc.split(",")) {
      const item = raw.trim();
      if (!item) continue;
      if (!DIRECTIVE.test(item)) return { block: true };
      const eq = item.indexOf("=");
      const name = (eq === -1 ? item : item.slice(0, eq)).toLowerCase();
      if (name === "no-store" || name === "no-cache") return { block: true };
      if (name === "max-age") {
        const v = eq === -1 ? "" : item.slice(eq + 1);
        if (seen || !WHOLE.test(v) || Number(v) === 0) return { block: true };
        seen = true;
        maxAge = Number(v);
      }
    }
  }
  const vary = h.get("vary");
  if (vary !== null) {
    if (bytes(vary) > MAX_VARY) return { block: true };
    for (const v of vary.split(",")) {
      const name = v.trim().toLowerCase();
      if (name && !SAME_EVERY_TIME.has(name)) return { block: true };
    }
  }
  let age = 0;
  const a = h.get("age");
  if (a !== null) {
    if (!WHOLE.test(a.trim())) return { block: true };
    age = Number(a.trim());
  }
  return { block: false, maxAge, age };
}

const until = (started: number, maxAge: number, age: number) => started + Math.min(maxAge, MAX_LIFETIME_S) * 1000 - age * 1000;

// A full 200: judged from scratch. `started` is when the request began; undefined means unknown,
// and then the copy is never reusable.
export function fromResponse(h: Headers, started: number | undefined): Freshness {
  const j = judge(h);
  if (j.block) return { reuse_blocked: true };
  if (j.maxAge === undefined || started === undefined) return {};
  return { fresh_until: until(started, j.maxAge, j.age) };
}

// A 304: never clears a block, may add one, never keeps an old deadline.
export function after304(prev: Freshness, h: Headers, started: number): Freshness {
  if (prev.reuse_blocked) return { reuse_blocked: true };
  const j = judge(h);
  if (j.block) return { reuse_blocked: true };
  if (prev.fresh_until === undefined) return {};
  return { fresh_until: j.maxAge === undefined ? started : until(started, j.maxAge, j.age) };
}

export const isFresh = (f: Freshness, now = Date.now()) => !f.reuse_blocked && typeof f.fresh_until === "number" && now < f.fresh_until;
