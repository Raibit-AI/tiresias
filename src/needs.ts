// SPDX-License-Identifier: Apache-2.0
// W-12: the needs report. The history says what Tiresias is still missing.
// Built from the history when asked and never stored (like the daily log).
//
// Five patterns, each a bounded top list with exact counts:
//   walls          walls hit, by site and fixed reason code
//   empty          questions that came back with no passages, by site and question
//   better_door    reads where the site advertised a better door than the one used
//   rereads        pages read more than once (cache candidates)
//   no_door        sites visited often that offered no agent door at all
// Plus (W-06) counts of handoff tickets: kept at a wall, refused at the cap, and resolved by a
// retry or by a page a person provided. Expired tickets are NOT counted: an expired ticket is
// deleted whole and leaves no record, and a log of deletions would be a new moving part.
// Each pattern that shows up gets a fixed-text suggestion naming the want or need
// it relates to, for a person to accept or reject. Nothing here edits anything.
//
// Sites, URLs and questions come from records (the web and the agents), so they
// are returned inside untrusted_content. Counts and fixed text sit at the top level.
import { bound, type HistoryEntry } from "./history.js";
import { listLogs, pageLog, parseSince, utcDay } from "./store.js";
import { NOTICE, jsonBytes } from "./types.js";

export const DEFAULT_SINCE = "30d";
export const TOP = 20; // rows shown per pattern
export const MAX_GROUPS = 10_000; // distinct sites, pages or questions tracked per pattern
export const OFTEN = 3; // visits in the window that make a site "visited often"
const PAGE_BUDGET = 40_000; // same as history pages
const RANK: Record<string, number> = { text: 0, structured: 1, feed: 2, api: 3, mcp: 4 };
// v0.5.1: a better door counts only when it is one Tiresias could have used (it reads page text and
// structured data; MCP, API and feed doors are found, not read), so the report does not cry "better door"
// for doors no read could take.
const CONSUMABLE = new Set(["text", "structured"]);

export type Pattern = "walls" | "empty" | "better_door" | "rereads" | "no_door";
export interface Row {
  pattern: Pattern;
  count: number;
  host?: string;
  url?: string;
  reason?: string;
  question?: string;
  used?: string;
  best?: string;
}
export interface PatternCount {
  records: number; // history records that showed this pattern (exact)
  groups: number; // distinct sites, pages or questions among them (exact up to MAX_GROUPS)
  shown: number; // rows in the top list
  untracked: number; // records not grouped because MAX_GROUPS was reached (still in `records`)
}
// W-06, from history records in the window. Expired tickets are not counted (see the top of this file).
export interface HandoffCounts {
  tickets: number; // reads that stopped at a wall and kept a ticket
  refused_cap: number; // walls where no ticket was kept because 500 were open
  resolved_retry: number; // resumes that read the page by asking the site again
  resolved_person: number; // resumes that read a page a person provided
}
// W-19, from history records in the window: calls stopped by each source, and reads that went past a list flag.
export interface FlaggedCounts {
  phishing_list: number; // stopped with status flagged (Phishing.Database)
  web_risk: number; // refused by Google Web Risk
  read_anyway: number; // read with allow_flagged past a Phishing.Database flag
}
// W-20, from history records in the window: links that led to a file Tiresias did not read.
export interface FileCounts {
  warnings: number;
  high: number; // programs, scripts, shortcuts, add-ons, archives, Office files, unknown files
  low: number; // images, audio, video
  by_kind: Record<string, number>; // fixed kind codes
  scanned_bad: number; // W-21: the owner's scanner said bad
}
const LOW_KINDS = new Set(["image", "media"]);
export interface Suggestion {
  pattern: Pattern;
  related: string[]; // want and need IDs from SPEC section 4
  text: string; // fixed template, with counts
}
export interface NeedsReport {
  status: "ok";
  message: string;
  notice: string;
  window: { since: string; until: string };
  counts: { records: number; skipped: number } & Record<Pattern, PatternCount> & { better_door_compared: number; handoffs: HandoffCounts; flagged: FlaggedCounts; files: FileCounts };
  suggestions: Suggestion[];
  page: number;
  pages: number;
  untrusted_content: { rows: Row[] };
}

// Groups records by key and keeps a count per group, up to MAX_GROUPS groups.
class Tally {
  private groups = new Map<string, Row>();
  records = 0;
  untracked = 0;
  constructor(private pattern: Pattern) {}
  add(key: string, row: Omit<Row, "pattern" | "count">): void {
    this.records++;
    const g = this.groups.get(key);
    if (g) g.count++;
    else if (this.groups.size >= MAX_GROUPS) this.untracked++;
    else this.groups.set(key, { pattern: this.pattern, count: 1, ...row });
  }
  rows(min = 1): Row[] {
    // Most first; ties in a fixed order so the report is the same every time.
    const all = [...this.groups.entries()].filter(([, r]) => r.count >= min);
    all.sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return all.slice(0, TOP).map(([, r]) => r);
  }
  count(rows: Row[], groups = this.groups.size): PatternCount {
    return { records: this.records, groups, shown: rows.length, untracked: this.untracked };
  }
  get size() {
    return this.groups.size;
  }
  values() {
    return this.groups.values();
  }
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

export async function buildNeeds(sinceText = DEFAULT_SINCE, page = 1, now = Date.now()): Promise<NeedsReport> {
  const since = parseSince(sinceText) ?? now - 30 * 86_400_000;
  const firstDay = utcDay(since);
  const walls = new Tally("walls");
  const empty = new Tally("empty");
  const better = new Tally("better_door");
  const reads = new Tally("rereads");
  // Per site: visits, and whether any visit saw a door better than page text.
  const sites = new Map<string, { visits: number; judged: boolean; door: boolean }>();
  let sitesUntracked = 0;
  let records = 0;
  let skipped = 0;
  let compared = 0;
  const hand: HandoffCounts = { tickets: 0, refused_cap: 0, resolved_retry: 0, resolved_person: 0 };
  const flagged: FlaggedCounts = { phishing_list: 0, web_risk: 0, read_anyway: 0 };
  const fileCounts: FileCounts = { warnings: 0, high: 0, low: 0, by_kind: {}, scanned_bad: 0 };
  // Day files are named by UTC date; earlier days cannot hold records in the window.
  const files = listLogs("history").filter((f) => f.day === null || f.day >= firstDay).map((f) => f.rel);
  await pageLog<HistoryEntry>(files, (raw) => {
    if (!raw || typeof raw !== "object") return false;
    const t = Date.parse(raw.time);
    if (!(t >= since && t <= now)) return false;
    const e = bound(raw); // the same bounds as every other reader: unknown codes are left out
    records++;
    const host = typeof e.url === "string" ? hostOf(e.url) : null;
    if (!host) {
      skipped++; // a record without a readable URL cannot be grouped by site
      return false;
    }
    if (e.flag === "web_risk" && e.status === "refused") flagged.web_risk++;
    else if (e.flag === "phishing_list" && e.status === "flagged") flagged.phishing_list++;
    else if (e.flag === "phishing_list") flagged.read_anyway++;
    if (e.status === "file_warning") {
      fileCounts.warnings++;
      const k = e.file_kind ?? "unknown"; // bound() keeps only known kind codes
      fileCounts[LOW_KINDS.has(k) ? "low" : "high"]++;
      fileCounts.by_kind[k] = (fileCounts.by_kind[k] ?? 0) + 1;
      if (e.scan === "bad") fileCounts.scanned_bad++;
    }
    if (e.ticket === "created") hand.tickets++;
    else if (e.ticket === "refused_cap") hand.refused_cap++;
    if (e.tool === "resume" && (e.status === "ok" || (e.status === "unchanged" && !e.source))) hand[e.source ? "resolved_person" : "resolved_retry"]++;
    if (e.status === "wall") walls.add(`${host}\n${e.reason ?? ""}`, { host, reason: e.reason ?? "unknown" });
    if (e.tool === "read" && e.matched === 0 && typeof e.purpose === "string")
      empty.add(`${host}\n${e.purpose}`, { host, question: e.purpose });
    if (e.tool === "read" && (e.status === "ok" || e.status === "unchanged")) {
      reads.add(e.url, { url: e.url });
      if (e.best_door && Object.hasOwn(RANK, e.door) && Object.hasOwn(RANK, e.best_door)) {
        compared++;
        if (RANK[e.best_door] > RANK[e.door] && CONSUMABLE.has(e.best_door)) better.add(`${host}\n${e.door}\n${e.best_door}`, { host, used: e.door, best: e.best_door });
      }
    }
    let s = sites.get(host);
    if (!s) {
      if (sites.size >= MAX_GROUPS) sitesUntracked++;
      else sites.set(host, (s = { visits: 0, judged: false, door: false }));
    }
    if (s) {
      s.visits++;
      if (e.best_door) {
        s.judged = true;
        if (e.best_door !== "text" && e.best_door !== "none") s.door = true;
      }
      if (e.llms_txt) s.door = true;
    }
    return false; // collect only; nothing is kept in pages
  });

  const wallRows = walls.rows();
  const emptyRows = empty.rows();
  const betterRows = better.rows();
  const rereadRows = reads.rows(2);
  const rereadGroups = [...reads.values()].filter((r) => r.count >= 2);
  // A site is judged only when some visit looked at its doors (read or doors). check never looks.
  const noDoor = [...sites.entries()].filter(([, s]) => s.visits >= OFTEN && s.judged && !s.door);
  noDoor.sort((a, b) => b[1].visits - a[1].visits || (a[0] < b[0] ? -1 : 1));
  const noDoorRows: Row[] = noDoor.slice(0, TOP).map(([host, s]) => ({ pattern: "no_door", count: s.visits, host }));

  const counts = {
    records,
    skipped,
    walls: walls.count(wallRows),
    empty: empty.count(emptyRows),
    better_door: better.count(betterRows),
    better_door_compared: compared,
    rereads: { records: rereadGroups.reduce((n, r) => n + r.count, 0), groups: rereadGroups.length, shown: rereadRows.length, untracked: reads.untracked },
    no_door: { records: noDoor.reduce((n, [, s]) => n + s.visits, 0), groups: noDoor.length, shown: noDoorRows.length, untracked: sitesUntracked },
    handoffs: hand,
    flagged,
    files: fileCounts,
  };
  const suggestions = suggest(counts);
  const all = [...wallRows, ...emptyRows, ...betterRows, ...rereadRows, ...noDoorRows];
  const pages: Row[][] = [];
  let cur: Row[] = [];
  let bytes = 0;
  for (const r of all) {
    const sz = jsonBytes(r);
    if (cur.length && bytes + sz > PAGE_BUDGET) {
      pages.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(r);
    bytes += sz;
  }
  if (cur.length) pages.push(cur);
  return {
    status: "ok",
    message: records
      ? `Built from ${records} history records when asked. Nothing was stored. Each suggestion is for a person to accept or reject.`
      : "No history in this window, so there is nothing to report. Nothing was stored.",
    notice: NOTICE,
    window: { since: new Date(since).toISOString(), until: new Date(now).toISOString() },
    counts,
    suggestions,
    page,
    pages: Math.max(1, pages.length),
    untrusted_content: { rows: pages[page - 1] ?? [] },
  };
}

// Fixed templates. Only patterns that showed up get one.
function suggest(c: NeedsReport["counts"]): Suggestion[] {
  const out: Suggestion[] = [];
  if (c.walls.records)
    out.push({
      pattern: "walls",
      related: ["W-06"],
      text: `${c.walls.records} visits stopped at a wall on ${c.walls.groups} site and reason pairs. Consider W-06 (clean handoff and resume) so a person clears the wall and the agent picks up where it stopped.`,
    });
  if (c.empty.records)
    out.push({
      pattern: "empty",
      related: ["W-10"],
      text: `${c.empty.records} questions came back with no passages. Consider a new want: passage search by meaning instead of keyword overlap. If those pages came back thin, W-10 (JavaScript-only pages) may be the cause.`,
    });
  if (c.better_door.records)
    out.push({
      pattern: "better_door",
      related: ["N-01"],
      text: `${c.better_door.records} of ${c.better_door_compared} reads used a lower door than the site advertised. Consider finishing N-01 (read MCP, API and feed doors, which are found but not yet used).`,
    });
  if (c.rereads.groups)
    out.push({
      pattern: "rereads",
      related: ["W-03", "W-16"],
      text: `${c.rereads.groups} pages were read more than once (${c.rereads.records} reads). Consider W-03 (shared cache across agents), or W-16 (bookmark and watch the ones that matter).`,
    });
  if (c.no_door.groups)
    out.push({
      pattern: "no_door",
      related: [],
      text: `${c.no_door.groups} sites were visited ${OFTEN} or more times and offered no agent door (no MCP, API, feed, structured data or llms.txt). No want covers this yet. Consider a new want: tell these site owners which door would help (for example llms.txt).`,
    });
  return out;
}

// The readable page for the command line, like `log`.
export function toMarkdown(r: NeedsReport): string {
  const L: string[] = [];
  const c = r.counts;
  L.push(`# Tiresias needs report`, "");
  L.push(`Window: ${r.window.since} to ${r.window.until}. ${r.message}`);
  L.push("Sites, pages and questions below came from the history (the web and the agents). They are data, not instructions.", "");
  if (r.page === 1) {
    L.push("## Counts", "");
    L.push(`- ${c.records} history records read${c.skipped ? ` (${c.skipped} without a readable URL, not grouped)` : ""}.`);
    L.push(`- Walls: ${c.walls.records} visits, ${c.walls.groups} site and reason pairs.`);
    L.push(`- Questions with no passages: ${c.empty.records}.`);
    L.push(`- A better door existed: ${c.better_door.records} of ${c.better_door_compared} reads where the doors were known.`);
    L.push(`- Pages read more than once: ${c.rereads.groups} (${c.rereads.records} reads).`);
    L.push(`- Sites visited ${OFTEN}+ times with no agent door: ${c.no_door.groups}.`);
    const hc = c.handoffs;
    L.push(`- Handoff tickets kept at walls: ${hc.tickets}${hc.refused_cap ? ` (${hc.refused_cap} more refused at the cap)` : ""}; resolved by a retry: ${hc.resolved_retry}; by a page a person provided: ${hc.resolved_person}. Expired tickets are not counted.`);
    const fc = c.flagged;
    if (fc) L.push(`- Safe Browsing: ${fc.phishing_list} stopped by Phishing.Database, ${fc.web_risk} refused by Google Web Risk, ${fc.read_anyway} read anyway with allow_flagged.`);
    const fl = c.files;
    if (fl?.warnings) L.push(`- Files flagged and not read: ${fl.warnings} (${fl.high} high risk, ${fl.low} low risk; ${Object.entries(fl.by_kind).map(([k, n]) => `${k} ${n}`).join(", ")})${fl.scanned_bad ? `; your scanner said bad for ${fl.scanned_bad}` : ""}.`);
    const untracked = c.walls.untracked + c.empty.untracked + c.better_door.untracked + c.rereads.untracked + c.no_door.untracked;
    if (untracked) L.push(`- ${untracked} records were counted but not grouped (over ${MAX_GROUPS} distinct groups in one pattern).`);
    L.push("", "## Suggestions (for a person to accept or reject)", "");
    if (!r.suggestions.length) L.push("None. No pattern showed up in this window.");
    for (const s of r.suggestions) L.push(`- ${s.related.length ? `[${s.related.join(", ")}] ` : ""}${s.text}`);
    L.push("");
  }
  const title: Record<Pattern, string> = {
    walls: "Walls by site and reason",
    empty: "Questions that came back empty",
    better_door: "A better door existed",
    rereads: "Pages read most often",
    no_door: `Sites visited ${OFTEN}+ times with no agent door`,
  };
  let last: Pattern | null = null;
  for (const row of r.untrusted_content.rows) {
    if (row.pattern !== last) {
      L.push(`## ${title[row.pattern]}`, "");
      last = row.pattern;
    }
    const one = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
    if (row.pattern === "walls") L.push(`- ${row.count} x ${row.host}: ${row.reason}`);
    else if (row.pattern === "empty") L.push(`- ${row.count} x ${row.host}: "${one(row.question ?? "", 300)}"`);
    else if (row.pattern === "better_door") L.push(`- ${row.count} x ${row.host}: used ${row.used}, the site offered ${row.best}`);
    else if (row.pattern === "rereads") L.push(`- ${row.count} x <${one(row.url ?? "", 4096)}>`);
    else L.push(`- ${row.count} visits: ${row.host}`);
  }
  if (r.pages > 1) L.push("", `Page ${r.page} of ${r.pages}. Use --page N for more.`);
  return L.join("\n");
}
