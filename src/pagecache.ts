// SPDX-License-Identifier: Apache-2.0
// The page cache record (W-03, W-02): what a cached page holds, and the list of changes kept with it.
// (Split out of engine.ts in v0.5.1, behavior unchanged.)
import { type Freshness } from "./freshness.js";
import type { Change } from "./diff.js";
import { type Door, type Envelope, type ParsedPage } from "./types.js";
import type { RenderTop } from "./render.js";

export type RenderInspection = Pick<RenderTop, "walls" | "hidden_text" | "overlay" | "markers_uninspected">;

export interface CacheEntry extends Freshness {
  parser?: number; // reader version that produced `parsed`; older entries are re-read
  url: string; // what the caller asked for
  source_url: string; // what Tiresias chose to read (page, llms.txt, or a .md twin)
  final_url: string; // where that request ended up after redirects; validators belong to THIS URL
  door: Door;
  door_detail: NonNullable<Envelope["door_detail"]>;
  etag?: string;
  last_modified?: string;
  hash: string;
  fetched_at: string;
  checked_at: string;
  content_type: string;
  parsed: ParsedPage;
  shell?: true; // little HTML text with scripts: an unrendered read says it may need rendering
  // W-02: what changed between the copy this one replaced and this one, worked out when a check
  // (or a read with changes) found the page changed. Kept with the page so later pages of a long
  // list can still be read. A v0.2 entry has none, and v0.2 ignores the field.
  changes?: StoredChanges;
  // W-03: the agent whose request brought this body (caller-supplied, so untrusted; bounded).
  // Freshness fields (fresh_until, reuse_blocked) come from Freshness (freshness.ts).
  fetched_by?: string;
  // W-03: did the fetch that produced (or last revalidated) this copy follow any redirect at all?
  // Recorded from the fetch itself; fresh reuse needs `false` (Codex round 39).
  redirected?: boolean;
  // W-06: set only on the in-memory entry for a page a person provided. Such an entry is never saved.
  source?: "provided_by_person" | "provided_by_agent";
  // W-10 (v0.7): `parsed` was read from the page as Chrome rendered it (its JavaScript run), not from the plain body.
  rendered?: true;
  render_hash?: string; // W-10: the fingerprint of the rendered HTML
  plain_hash?: string; // W-10: the fingerprint of the page's own body it was rendered from (reused while unchanged)
  render_inspection?: RenderInspection; // fixed inspection codes kept with this rendering, without per-call counts
}
export interface StoredChanges {
  from: string; // fetched_at of the copy it was compared with
  at: string; // when the change was found
  omitted?: true; // too much changed to list (see diff.ts caps)
  items: Change[];
  // Exact totals. ABSENT when omitted: the diff gave up, so the totals are unknown, not zero (Codex round 36).
  added?: number;
  removed?: number;
}

