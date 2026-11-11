// SPDX-License-Identifier: Apache-2.0
import { getActionTarget } from "./getactions.js";

import { MAX_FORM_ACTIONS, MAX_FORM_ACTION_CHARS, MAX_FORM_BASES } from "./types.js";
// The limits live in types.ts so the page reader (forms.ts, run in the worker) does not load this
// module and, through it, the whole request path.
export { MAX_FORM_ACTIONS, MAX_FORM_ACTION_CHARS, MAX_FORM_BASES };
// Collectors cap source actions. The static union can emit one target per source
// for the page URL and each web base; deduplication can only reduce this bound.
export const MAX_FORM_ACTION_TARGETS = MAX_FORM_ACTIONS * (MAX_FORM_BASES + 1);
export const MAX_LIVE_ACTION = 8192;

// null means a valid non-network action. Invalid, credentialed and oversized actions
// throw instead, including on non-web schemes, so callers fail closed.
export function networkFormAction(raw: string, base: string | undefined, max: number): URL | null {
  if (raw.length > max) throw new Error("Oversized form action");
  const u = new URL(raw, base);
  if (u.href.length > max || u.username || u.password) throw new Error("Unsafe form action");
  return u.protocol === "http:" || u.protocol === "https:" ? u : null;
}

// Owned by one render, shared by its static scan and all live scans. FIFO eviction
// bounds both keys and values by entry count and source characters. A complete scan
// of live actions fits in the cache. Larger static scans may evict entries, but
// retain every target in the scan's separate result set. Later scans reuse
// retained entries and safely recompute evicted ones.
export class RenderActionCache {
  private entries = new Map<string, string | null>();
  private chars = 0;

  scan(input: unknown): string[] | null {
    if (!Array.isArray(input) || input.length > MAX_FORM_ACTION_TARGETS) return null;
    let total = 0;
    // Static input is already deduplicated, web-only and fragment-free: its
    // resolved lengths cannot exceed the collector's max(raw, resolved) charges.
    for (const a of input) {
      if (typeof a !== "string" || a.length > MAX_LIVE_ACTION) return null;
      total += a.length;
      if (total > MAX_FORM_ACTION_CHARS) return null;
    }
    const targets = new Set<string>();
    try {
      for (const a of new Set<string>(input)) {
        let target = this.entries.get(a);
        if (target === undefined) {
          // Both the static resolver and the native live getter return absolute
          // URLs. A relative getter value signals failed resolution (for example
          // under an opaque base); do not silently resolve it against the page.
          const u = networkFormAction(a, undefined, MAX_LIVE_ACTION);
          target = u ? getActionTarget(u) : null;
          while (this.entries.size >= MAX_FORM_ACTIONS || this.chars + a.length > MAX_FORM_ACTION_CHARS) {
            const first = this.entries.keys().next().value!;
            this.entries.delete(first);
            this.chars -= first.length;
          }
          this.entries.set(a, target);
          this.chars += a.length;
        }
        if (target !== null) targets.add(target);
      }
      return [...targets];
    } catch { return null; }
  }
}
