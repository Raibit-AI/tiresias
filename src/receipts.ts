// SPDX-License-Identifier: Apache-2.0
// N-03: receipts. Every quote an agent gets back is also written to a local
// log, so a human can later check exactly what was read, where, and when.
import { appendLine, listLogs, pageLog, parseSince, utcDay, type LogPage, type LogScan } from "./store.js";
import type { Receipt } from "./types.js";
import { receiptFingerprint } from "./saved.js";

// The logged copy of a quote is cut at 8,000 characters and of a URL at 4,096 (`cut: true`),
// so one line can never outgrow a page. The receipt the agent was handed is never cut.
const MAX_QUOTE = 8000;
const MAX_URL_LOG = 4096;

// One file per UTC day, append only: receipts/YYYY-MM-DD.jsonl. v0.1 wrote one receipts.jsonl; it is still read.
// In place; used when writing AND when reading, so oversized records from older files are readable.
export function bound<T extends { quote: string; url: string; cut?: true }>(r: T): T {
  let over = false;
  if (typeof r.quote === "string" && r.quote.length > MAX_QUOTE) (r.quote = r.quote.slice(0, MAX_QUOTE)), (over = true);
  if (typeof r.url === "string" && r.url.length > MAX_URL_LOG) (r.url = r.url.slice(0, MAX_URL_LOG)), (over = true);
  if (over) r.cut = true;
  return r;
}

// v0.5.1: every record carries `v` (its format version) and `kind`: "quote" (a receipt), "form" (a form
// sent) or "file" (a file warning). Older lines have neither: a line with `sent: "form"` is a form, one with
// `file: "warning"` a file (whose `kind` field there was the FILE's kind), anything else a quote.
export const RECORD_VERSION = 1;
export function record(receipts: Receipt[]): void {
  const now = Date.now();
  const recorded_at = new Date(now).toISOString();
  for (const r of receipts) {
    const row = bound({ v: RECORD_VERSION, kind: "quote" as const, ...r, recorded_at });
    appendLine(`receipts/${utcDay(now)}.jsonl`, row);
  }
}

export async function query(f: { url?: string; since?: string; page?: number }, scan: LogScan = {}): Promise<LogPage<Receipt>> {
  const since = parseSince(f.since);
  // The URL as typed, or as a URL parser writes it ("https://example.com" is recorded as "https://example.com/").
  let alt: string | undefined;
  try {
    if (f.url) alt = new URL(f.url).href;
  } catch {}
  return pageLog<Receipt & { recorded_at: string }>(
    listLogs("receipts").map((f) => f.rel),
    (r) => {
      if (!r || typeof r !== "object") return false; // a stray non-record line is skipped
      if (f.url && r.url !== f.url && r.url !== alt) return false;
      if (since !== null && !(Date.parse(r.recorded_at) >= since)) return false;
      // W-08 (v0.8): the record's fingerprint, of the line exactly as recorded (before any cut below): its id for
      // `tiresias receipts prove`. Named `record_fingerprint` so a file-warning record keeps its own `fingerprint`
      // (the file's SHA-256) unchanged (integration fix, 2026-10-31).
      const record_fingerprint = receiptFingerprint(r);
      bound(r); // filters match the stored values; only what is returned is cut
      (r as Receipt & { record_fingerprint?: string }).record_fingerprint = record_fingerprint;
      return true;
    },
    f.page ?? 1,
    40_000, scan,
  );
}

// W-04: the record of a form a call SENT in the owner's name: where, how, which slip use, the field
// names with the values sent from visible fields (the agent's, or the form's defaults), and the
// hidden fields by NAME only (their values were the site's, often a CSRF token, and are never kept).
// Written to the same day file as receipts, marked `sent: "form"`, so it is kept, cleared and read
// back with them. Bounded: names 200 characters, values 2,000, the record about 16 KB (`cut: true`).
export interface SentRecord {
  v: 1;
  kind: "form";
  sent: "form";
  page_url: string;
  url: string; // the target the request went to (for a GET, with the query)
  method: "GET" | "POST";
  slip: string;
  use: number;
  fields: { name: string; value: string }[];
  hidden: string[];
  outcome: number | "no_answer"; // the HTTP status of the final answer, or no_answer
  agent: string;
  recorded_at: string;
  cut?: true;
}
const MAX_SENT = 16_000;
export function recordSent(r: Omit<SentRecord, "v" | "kind" | "sent" | "recorded_at" | "cut">): void {
  let cut = false;
  const c = (s: string, n: number) => (s.length > n ? ((cut = true), s.slice(0, n)) : s);
  const row: SentRecord = {
    v: RECORD_VERSION, kind: "form", sent: "form", page_url: c(r.page_url, MAX_URL_LOG), url: c(r.url, MAX_URL_LOG), method: r.method, slip: r.slip, use: r.use,
    fields: [], hidden: [], outcome: r.outcome, agent: c(r.agent, 200), recorded_at: new Date().toISOString(),
  };
  let size = JSON.stringify(row).length;
  for (const f of r.fields) {
    const x = { name: c(f.name, 200), value: c(f.value, 2000) };
    const n = JSON.stringify(x).length + 1;
    if (size + n > MAX_SENT) {
      cut = true;
      break;
    }
    row.fields.push(x);
    size += n;
  }
  for (const h of r.hidden) {
    const x = c(h, 200);
    if (size + x.length + 3 > MAX_SENT) {
      cut = true;
      break;
    }
    row.hidden.push(x);
    size += x.length + 3;
  }
  if (cut) row.cut = true;
  appendLine(`receipts/${utcDay()}.jsonl`, row);
}

// W-20: the record of a file Tiresias flagged instead of reading: where, what kind, how big, its
// fingerprint, and the owner's scanner's verdict (W-21). Written to the same day file as receipts, marked
// `file: "warning"`, so it is kept, cleared and read back with them. Never in private mode (the caller
// checks). URLs, the declared type and name came from the web; they are bounded like every record.
export interface FileRecord {
  v: 1;
  kind: "file";
  file: "warning";
  url: string;
  final_url: string;
  file_kind: string; // v0.5.1: was `kind` (older lines)
  risk: "high" | "low";
  size: number;
  fingerprint?: string;
  flags: string[];
  declared_type: string;
  declared_name?: string;
  scan?: string;
  agent: string;
  source?: "provided_by_person" | "provided_by_agent";
  recorded_at: string;
  cut?: true;
}
export function recordFile(r: Omit<FileRecord, "v" | "kind" | "file" | "recorded_at" | "cut">): void {
  let cut = false;
  const c = (s: string, n: number) => (s.length > n ? ((cut = true), s.slice(0, n)) : s);
  const row: FileRecord = {
    v: RECORD_VERSION, kind: "file", file: "warning", url: c(r.url, MAX_URL_LOG), final_url: c(r.final_url, MAX_URL_LOG), file_kind: r.file_kind, risk: r.risk, size: r.size,
    ...(r.fingerprint ? { fingerprint: r.fingerprint } : {}), flags: r.flags, declared_type: c(r.declared_type, 200),
    ...(r.declared_name !== undefined ? { declared_name: c(r.declared_name, 255) } : {}), ...(r.scan ? { scan: r.scan } : {}),
    agent: c(r.agent, 200), ...(r.source ? { source: r.source } : {}), recorded_at: new Date().toISOString(),
  };
  if (cut) row.cut = true;
  appendLine(`receipts/${utcDay()}.jsonl`, row);
}
