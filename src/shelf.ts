// SPDX-License-Identifier: Apache-2.0
// W-27 (v0.6): the downloads shelf. Every file warning (W-20) is put on the shelf: kind, size, fingerprint,
// URL, the owner's scanner's verdict (W-21) and the time, newest first, searchable by site and date, like
// Chrome's downloads list. Decisions: docs/v0.6/browse.md.
//
// One file per UTC day, append only: shelf/YYYY-MM-DD.jsonl (the date of the record's own time), so `clear`
// and the daily trim remove whole days (keep_receipts_days, the disk cap, --all), like the history the daily
// log is built from. A day file stops taking records at MAX_DAY_BYTES. Private calls put nothing on it (the
// store refuses the write too). Every value read back is checked and cut again, since the file is in a
// folder that could be edited; URLs, the declared type and name and the agent's name came from outside and
// are returned only inside untrusted_content.
import fs from "node:fs";
import path from "node:path";
import { NOFOLLOW, NONBLOCK, appendLine, isPrivate, ownFile, parseSince, subDir, utcDay } from "./store.js";
import { acquire, held, release } from "./browselock.js";
import { NOTICE, type FileWarning } from "./types.js";
import type { FileFacts } from "./safety.js";

export const SHELF_DIR = "shelf";
export const MAX_DAY_BYTES = 2 * 1024 * 1024; // a day file past this takes no more records
export const MAX_READ = 4 * 1024 * 1024; // the most read back from one day file (its last part, if bigger)
export const PAGE_BUDGET = 40_000; // UTF-8 bytes of records per page, like history
export const MAX_DIR_ENTRIES = 20_000; // the most entries of shelf/ one listing looks at (the rest: partial)
export const MAX_TOTAL_READ = 64 * 1024 * 1024; // the most one listing reads across all day files

// Fixed text only: a filter the caller passed is never repeated back (Codex browse round 1).
export class ShelfError extends Error {}
export const BAD_SINCE = "since must be a date like 2026-10-01, a full time like 2026-10-01T12:00:00Z, or 7d / 24h.";
export const BAD_UNTIL = "until must be a date like 2026-10-24 (through the end of that UTC day), a full time, or 7d / 24h.";
export const BAD_SITE = "A site filter takes a site name, like example.com.";
export const TOO_MANY = `The shelf folder holds more than ${MAX_DIR_ENTRIES} entries, more than one listing looks at, so some days may be missing. Run tiresias clear: it removes files there that Tiresias did not make and days past keep_receipts_days; folders it did not make are left for you to remove.`;
export const CANCELLED = "The listing was cancelled.";
export const SHELF_BUSY = "The shelf is busy (another tiresias process holds today's file). This warning was not put on it. If no other tiresias process is running, the owner can delete the .lock file in shelf/.";
const MAX_URL_LOG = 4096;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
export const MARK_FILE = /^(\d{4}-\d{2}-\d{2})\.incomplete$/;
const KINDS = new Set(["program", "script", "shortcut", "addon", "archive", "office", "image", "media", "unknown"]);
const RISKS = new Set(["high", "low"]);
const VERDICTS = new Set(["bad", "clean", "unknown", "failed"]);
const FLAGS = new Set(["type_mismatch", "double_extension", "macros"]);
const STOPS = new Set(["too_large", "not_downloaded", "timeout"]);
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export interface ShelfRecord {
  v: 1;
  time: string; // when the warning was given
  file_kind: string;
  risk: "high" | "low";
  size: number;
  fingerprint?: string; // sha256:<hex>
  no_fingerprint?: "too_large" | "not_downloaded" | "timeout"; // why there is none
  flags: string[];
  scan?: string; // the owner's scanner's verdict
  scan_by?: string; // the scanner's file name (or config.json when its setting is broken)
  url: string; // asked
  final_url: string; // where the file came from
  declared_type?: string;
  declared_name?: string;
  agent: string;
  source?: "provided_by_person";
  cut?: true;
}

// Put one warning on the shelf. Never in private mode. A full day file takes no more records (the warning
// itself is unchanged and the receipts log still has it).
export function record(w: { url: string; finalUrl: string; fw: FileWarning; f: FileFacts; agent?: string; source?: "provided_by_person" }, now = Date.now()): boolean {
  if (isPrivate()) return false;
  const day = utcDay(now);
  let cut = false;
  const c = (s: string, n: number) => (s.length > n ? ((cut = true), s.slice(0, n)) : s);
  const row: ShelfRecord = {
    v: 1, time: new Date(now).toISOString(), file_kind: w.fw.kind, risk: w.fw.risk, size: w.fw.size,
    ...(w.fw.fingerprint ? { fingerprint: w.fw.fingerprint } : { no_fingerprint: w.f.stopped ?? "too_large" }),
    flags: [...w.fw.flags],
    ...(w.fw.scan ? { scan: w.fw.scan.verdict, scan_by: c(w.fw.scan.by, 100) } : {}),
    url: c(w.url, MAX_URL_LOG), final_url: c(w.finalUrl, MAX_URL_LOG),
    ...(w.f.declared_type ? { declared_type: c(w.f.declared_type, 200) } : {}),
    ...(w.f.declared_name !== undefined ? { declared_name: c(w.f.declared_name, 255) } : {}),
    agent: c(w.agent ?? "unknown", 200), ...(w.source ? { source: w.source } : {}),
  };
  if (cut) row.cut = true;
  // Codex browse round 2: the size check and the append are one step under the day file's lock, counting
  // this record's own bytes, so concurrent writers cannot push a day past the cap. Round 5: a record that is
  // NOT put on the shelf for any reason (the day is full, the lock stayed busy, a write failed) marks its day
  // incomplete (an empty YYYY-MM-DD.incomplete beside it), so a listing never presents that day as complete,
  // and the caller says so on the warning (shelf: "not_recorded").
  const d = subDir(SHELF_DIR, true)!;
  const file = path.join(d, `${day}.jsonl`);
  const mark = () => markIncomplete(path.join(d, `${day}.incomplete`));
  const o = acquire(file);
  if (!o) {
    mark();
    return false;
  }
  try {
    let size = 0;
    try {
      size = fs.lstatSync(file).size;
    } catch {
      // no file yet
    }
    if (size + Buffer.byteLength(JSON.stringify(row), "utf8") + 2 > MAX_DAY_BYTES || !held(o)) {
      mark();
      return false;
    }
    appendLine(`${SHELF_DIR}/${day}.jsonl`, row);
    return true;
  } catch (e) {
    mark();
    throw e;
  } finally {
    release(o);
  }
}
function markIncomplete(f: string): void {
  try {
    fs.closeSync(fs.openSync(f, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600));
  } catch {
    // already marked (or cannot be marked: the warning itself still says shelf: "not_recorded")
  }
}

// A record read back: every field checked and cut again. Anything that is not a record is skipped (null).
export function clean(x: unknown): ShelfRecord | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (typeof o.time !== "string" || !ISO.test(o.time) || Number.isNaN(Date.parse(o.time))) return null;
  if (typeof o.file_kind !== "string" || !KINDS.has(o.file_kind) || typeof o.risk !== "string" || !RISKS.has(o.risk)) return null;
  if (typeof o.size !== "number" || !Number.isSafeInteger(o.size) || o.size < 0) return null;
  if (typeof o.url !== "string" || typeof o.final_url !== "string") return null;
  let cut = o.cut === true;
  const c = (s: string, n: number) => (s.length > n ? ((cut = true), s.slice(0, n)) : s);
  const str = (k: string, n: number) => (typeof o[k] === "string" ? { [k]: c(o[k] as string, n) } : o[k] !== undefined ? ((cut = true), {}) : {});
  const flags = Array.isArray(o.flags) ? [...new Set(o.flags.filter((f): f is string => typeof f === "string" && FLAGS.has(f)))] : [];
  const r: ShelfRecord = {
    v: 1, time: o.time, file_kind: o.file_kind, risk: o.risk as "high" | "low", size: o.size,
    ...(typeof o.fingerprint === "string" && FINGERPRINT.test(o.fingerprint) ? { fingerprint: o.fingerprint } : {}),
    ...(typeof o.no_fingerprint === "string" && STOPS.has(o.no_fingerprint) ? { no_fingerprint: o.no_fingerprint as ShelfRecord["no_fingerprint"] } : {}),
    flags,
    ...(typeof o.scan === "string" && VERDICTS.has(o.scan) ? { scan: o.scan } : {}),
    ...str("scan_by", 100),
    url: c(o.url, MAX_URL_LOG), final_url: c(o.final_url, MAX_URL_LOG),
    ...str("declared_type", 200), ...str("declared_name", 255),
    agent: typeof o.agent === "string" ? c(o.agent, 200) : "unknown",
    ...(o.source === "provided_by_person" ? { source: "provided_by_person" as const } : {}),
  };
  if (cut) r.cut = true;
  return r;
}

const hostOf = (u: string): string | null => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};
const siteMatch = (r: ShelfRecord, site: string) =>
  [r.url, r.final_url].some((u) => {
    const h = hostOf(u);
    return h !== null && (h === site || h.endsWith("." + site));
  });

// "2026-10-24" is through the end of that UTC day; a full time is exact; "7d" / "24h" count back from now.
export function parseUntil(until?: string): number | null {
  if (until === undefined || until === "") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(until.trim())) {
    const t = Date.parse(until.trim() + "T00:00:00Z");
    if (Number.isNaN(t)) throw new ShelfError(BAD_UNTIL);
    return t + 86_400_000;
  }
  try {
    return parseSince(until);
  } catch {
    throw new ShelfError(BAD_UNTIL);
  }
}
function since(x?: string): number | null {
  try {
    return parseSince(x);
  } catch {
    throw new ShelfError(BAD_SINCE);
  }
}

export interface ShelfQuery {
  site?: string;
  since?: string;
  until?: string;
  page?: number;
}
export interface ShelfReply {
  status: "ok";
  message: string;
  notice: string;
  counts: { files: number; high: number; low: number; scanned_bad: number };
  page: number;
  pages: number;
  total: number;
  partial?: true; // some warnings are not counted: see days_incomplete and the message
  days_incomplete?: number; // days whose records are not all here: the day was full, or its file was read only from its end
  entries_unscanned?: true; // shelf/ holds more entries than one listing looks at: some days may be missing
  days_unreadable?: number; // day files that could not be read at all (a link, someone else's, no permission)
  untrusted_content: { files: ShelfRecord[] };
}

// One day file, read from its last MAX_READ bytes (starting at a full line when cut). Unlike readLogSync,
// any trouble other than "it is gone" THROWS, so the listing can say a day was unreadable.
// Round 7: `budget` is what is left of the listing's total read budget; the bytes are measured on the OPENED
// file and charged from what is really read, so a file swapped or grown after it was listed cannot read
// more than it was charged. "over" means this day would not fit what is left.
function readDay(file: string, budget: number): { lines: unknown[]; bytes: number; cut: boolean; damaged: number } | "over" {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { lines: [], bytes: 0, cut: false, damaged: 0 };
    throw e;
  }
  try {
    ownFile(fd, file);
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, MAX_READ);
    if (n > budget) return "over";
    const buf = Buffer.alloc(n);
    let got = 0;
    for (let r = -1; r !== 0 && got < n; got += r) r = fs.readSync(fd, buf, got, n - got, size - n + got);
    let raw = buf.subarray(0, got).toString("utf8");
    if (size > MAX_READ) raw = raw.slice(raw.indexOf("\n") + 1);
    const out: unknown[] = [];
    let damaged = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        damaged++; // skipped, and the day is reported incomplete
      }
    }
    return { lines: out, bytes: got, cut: size > MAX_READ, damaged };
  } finally {
    fs.closeSync(fd);
  }
}

// The day files, newest first. At most MAX_DIR_ENTRIES entries are looked at; more is an error.
// Codex browse round 6: a folder holding more entries than one listing looks at is listed from what was
// seen, with partial: true and a fixed note, never refused (folders Tiresias did not make are never removed
// by clear, so a refusal could not be recovered from).
function dayFiles(d: string): { days: string[]; full: Set<string>; unscanned: boolean; odd: string[] } {
  const odd: string[] = [];
  const out: string[] = [];
  const full = new Set<string>();
  const dir = fs.opendirSync(d);
  let unscanned = false;
  try {
    let seen = 0;
    for (let e = dir.readSync(); e !== null; e = dir.readSync()) {
      if (++seen > MAX_DIR_ENTRIES) {
        unscanned = true;
        break;
      }
      // A folder or link with a day file's name is not a readable day: it is counted as unreadable, so the
      // listing never looks complete (clear removes a link and reports a folder).
      if (DAY_FILE.test(e.name)) {
        if (e.isFile()) out.push(e.name);
        else odd.push(DAY_FILE.exec(e.name)![1]);
      }
      const f = MARK_FILE.exec(e.name);
      if (f) full.add(f[1]);
    }
  } finally {
    dir.closeSync();
  }
  return { days: out.sort().reverse(), full, unscanned, odd };
}

// The shelf, newest first, a page at a time. One day file at a time (each at most MAX_READ, the whole
// listing at most MAX_TOTAL_READ, the folder at most MAX_DIR_ENTRIES entries), yielding between files so
// a long listing never blocks the MCP server, and stopping when the caller cancels. A shelf/ folder that
// is a link or someone else's is an error.
export async function query(q: ShelfQuery = {}, signal?: AbortSignal): Promise<ShelfReply> {
  const from = since(q.since);
  const until = parseUntil(q.until);
  const site = q.site?.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (q.site !== undefined && (!site || site.length > 253 || /[\s/\\]/.test(site))) throw new ShelfError(BAD_SITE);
  const page = q.page ?? 1;
  const out: ShelfReply = {
    status: "ok", message: "", notice: NOTICE, counts: { files: 0, high: 0, low: 0, scanned_bad: 0 }, page, pages: 0, total: 0, untrusted_content: { files: [] },
  };
  const d = subDir(SHELF_DIR, false);
  const { days, full: fullDays, unscanned, odd } = d ? dayFiles(d) : { days: [], full: new Set<string>(), unscanned: false, odd: [] as string[] };
  const firstDay = from !== null ? utcDay(from) : null;
  const lastDay = until !== null ? utcDay(until - 1) : null;
  let cur = 0;
  let bytes = 0;
  let read = 0;
  let incomplete = 0;
  let unreadable = 0;
  let stopped = false;
  // A link or folder with a day's name counts as an unreadable day, within the date filter (round 7).
  for (const od of odd) if (!(firstDay && od < firstDay) && !(lastDay && od > lastDay)) unreadable++;
  // A day that is marked incomplete but has no records at all still counts as incomplete (Codex browse round 5).
  const dayNames = new Set(days.map((n) => DAY_FILE.exec(n)![1]));
  for (const md of fullDays)
    if (!dayNames.has(md) && !(firstDay && md < firstDay) && !(lastDay && md > lastDay)) incomplete++;
  for (const n of days) {
    const day = DAY_FILE.exec(n)![1];
    if ((firstDay && day < firstDay) || (lastDay && day > lastDay)) continue;
    await new Promise((r) => setImmediate(r));
    if (signal?.aborted) throw new ShelfError(CANCELLED);
    let got: ReturnType<typeof readDay>;
    try {
      got = readDay(path.join(d!, n), MAX_TOTAL_READ - read);
    } catch {
      unreadable++; // a day that cannot be read is said so, never shown as empty (Codex browse round 3)
      continue;
    }
    if (got === "over") {
      out.partial = true;
      stopped = true;
      break;
    }
    read += got.bytes;
    // A full day, or one read only from its end, is listed but said to be incomplete (Codex browse round 2).
    if (fullDays.has(day) || got.cut) incomplete++;
    const lines = got.lines;
    const cleaned = lines.map(clean);
    // Round 10: a damaged line or a record that does not check out means warnings may be missing from this day.
    if (!fullDays.has(day) && !got.cut && (got.damaged > 0 || cleaned.some((r) => r === null))) incomplete++;
    const recs = cleaned
      .filter((r): r is ShelfRecord => r !== null)
      .filter((r) => {
        const t = Date.parse(r.time);
        return (from === null || t >= from) && (until === null || t < until) && (!site || siteMatch(r, site));
      })
      .sort((a, b) => b.time.localeCompare(a.time));
    for (const r of recs) {
      out.total++;
      if (r.risk === "high") out.counts.high++;
      else out.counts.low++;
      if (r.scan === "bad") out.counts.scanned_bad++;
      const size = Buffer.byteLength(JSON.stringify(r), "utf8");
      if (cur === 0 || bytes + size > PAGE_BUDGET) {
        cur++;
        bytes = 0;
      }
      bytes += size;
      if (cur === page) out.untrusted_content.files.push(r);
    }
  }
  out.pages = Math.max(1, cur);
  out.counts.files = out.total;
  if (unscanned) {
    out.partial = true;
    out.entries_unscanned = true;
  }
  if (incomplete || unreadable) {
    out.partial = true;
    if (incomplete) out.days_incomplete = incomplete;
    if (unreadable) out.days_unreadable = unreadable;
  }
  const filtered = q.site !== undefined || q.since !== undefined || q.until !== undefined;
  out.message = out.total
    ? `${out.total} file warnings${filtered ? " match" : " on the shelf"}, newest first: links that led to a file Tiresias did not open, run or save. Each one is for your person to decide about.`
    : "No file warnings on the shelf" + (filtered ? " match." : ".") + " Warnings from before v0.6 are in the receipts log (file: \"warning\").";
  if (incomplete) out.message += ` ${incomplete} day${incomplete === 1 ? " is" : "s are"} incomplete (some warnings could not be put on the shelf that day: it reached its cap of ${MAX_DAY_BYTES / 1024 / 1024} MB, or the shelf was busy; or its file was too large to read whole, or holds damaged lines), so some warnings from ${incomplete === 1 ? "it" : "them"} are not listed; they are still in the receipts log.`;
  if (unreadable) out.message += ` ${unreadable} day file${unreadable === 1 ? "" : "s"} could not be read (a link, someone else's file, or no permission), so ${unreadable === 1 ? "its" : "their"} warnings are not listed.`;
  if (unscanned) out.message += ` ${TOO_MANY}`;
  if (stopped) out.message += ` The listing stopped after reading ${MAX_TOTAL_READ / 1024 / 1024} MB of the newest days, so older warnings are not counted; narrow it with since, until or site.`;
  return out;
}
