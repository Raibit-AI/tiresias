// SPDX-License-Identifier: Apache-2.0
// W-02: what changed since the last visit. A block-level diff between the cached
// copy of a page and the new one. It runs in the worker under the parse time
// budget (work.ts), because it is CPU work over untrusted text.
//
// A unit is a section heading or one block (paragraph, list item). Equal text is
// an equal unit. The diff trims the common start and end, then runs Myers' diff
// on what is left. Both the input and the edit count are capped; past a cap the
// result says `omitted` and nothing is guessed.
import type { Section } from "./types.js";

export const MAX_DIFF_BLOCKS = 5000; // units per side
export const MAX_EDITS = 2000; // added plus removed units
export const MAX_DIFF_TEXT = 2 * 1024 * 1024; // characters of changed text kept

export interface Change {
  kind: "added" | "removed";
  section: number; // the section number on its own page: the new page for added, the old one for removed
  heading: string; // that section's heading, for context
  text: string; // the exact block (or heading) text
}
export type DiffResult = { omitted: true; reason: "too_many_blocks" | "too_many_edits" | "too_much_text" } | { omitted?: undefined; items: Change[]; added: number; removed: number };

interface Unit {
  section: number;
  heading: string;
  text: string;
  key: string;
}

// The page as a flat list of units. A heading Tiresias generated (a PDF's
// "Page N") is a label, not page text, so it is not a unit. Null past the cap.
function units(sections: Section[]): Unit[] | null {
  const out: Unit[] = [];
  for (const s of sections) {
    if (!s.generated && s.heading) out.push({ section: s.n, heading: s.heading, text: s.heading, key: "h\u0000" + s.heading });
    for (const b of s.blocks) if (b.text) out.push({ section: s.n, heading: s.heading, text: b.text, key: "b\u0000" + b.text });
    if (out.length > MAX_DIFF_BLOCKS) return null;
  }
  return out;
}

// Myers' O((N+M)D) diff over small integers. Returns the edit script in page
// order, or null when more than maxD edits would be needed. Memory is about
// D squared integers (the saved diagonals), so maxD bounds it too.
export function myers(a: Int32Array, b: Int32Array, maxD: number): { del: boolean; i: number }[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d, off + d + 1)); // diagonals -d..d before this round
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], n: number, m: number): { del: boolean; i: number }[] {
  const edits: { del: boolean; i: number }[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const vd = trace[d];
    const get = (k: number) => vd[k + d];
    const k = x - y;
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
    }
    if (prevK === k + 1) edits.push({ del: false, i: prevY }); // b[prevY] was added
    else edits.push({ del: true, i: prevX }); // a[prevX] was removed
    x = prevX;
    y = prevY;
  }
  return edits.reverse();
}

export function diffSections(oldS: Section[], newS: Section[]): DiffResult {
  const a = units(oldS);
  const b = units(newS);
  if (!a || !b) return { omitted: true, reason: "too_many_blocks" };
  // Equal text gets the same number, so the diff compares integers, not strings.
  const ids = new Map<string, number>();
  const id = (u: Unit) => {
    let n = ids.get(u.key);
    if (n === undefined) ids.set(u.key, (n = ids.size));
    return n;
  };
  const ai = Int32Array.from(a, id);
  const bi = Int32Array.from(b, id);
  let start = 0;
  while (start < ai.length && start < bi.length && ai[start] === bi[start]) start++;
  let endA = ai.length;
  let endB = bi.length;
  while (endA > start && endB > start && ai[endA - 1] === bi[endB - 1]) endA--, endB--;
  const script = myers(ai.subarray(start, endA), bi.subarray(start, endB), MAX_EDITS);
  if (!script) return { omitted: true, reason: "too_many_edits" };
  const items: Change[] = [];
  let added = 0;
  let removed = 0;
  let chars = 0;
  for (const e of script) {
    const u = e.del ? a[start + e.i] : b[start + e.i];
    chars += u.text.length;
    if (chars > MAX_DIFF_TEXT) return { omitted: true, reason: "too_much_text" };
    items.push({ kind: e.del ? "removed" : "added", section: u.section, heading: u.heading, text: u.text });
    if (e.del) removed++;
    else added++;
  }
  return { items, added, removed };
}
