// SPDX-License-Identifier: Apache-2.0
// W-11: history, the unofficial log. One compact line per call, like the
// History tab in a browser. It is also the raw data for finding what
// Tiresias is missing (W-12, needs.ts).
import { appendLine, listLogs, pageLog, parseSince, utcDay, type LogPage } from "./store.js";
import { LANG_SET } from "./lang.js";

export interface HistoryEntry {
  v?: number; // v0.5.1: the record's format version (absent on older lines)
  time: string;
  tool: string;
  url: string;
  agent: string;
  purpose?: string;
  status: string;
  door: string;
  // W-12 (v0.3, optional, written on new records only; older records simply lack them):
  reason?: string; // the fixed wall code when the call stopped at a wall
  matched?: number; // a read with a question: how many passages came back (0 = nothing found)
  best_door?: string; // the best door the site advertised (fixed ladder code), when it was looked up
  llms_txt?: true; // the site advertised an llms.txt
  // v0.3 W-06 and W-03 (optional, fixed codes only):
  ticket?: "created" | "refused_cap"; // a read stopped at a wall: was a handoff ticket kept, or refused at the cap
  source?: "provided_by_person"; // a resume that parsed a page a person saved (no request was sent)
  cache?: "fresh" | "revalidated" | "refetched"; // how the shared cache took part
  flag?: "phishing_list" | "web_risk"; // v0.3 W-19: the call was flagged, or read past a list flag with allow_flagged
  slip?: string; // v0.4 W-05: the permission slip a use was claimed from (tool "slip"; the purpose is the use label)
  file_kind?: string; // v0.5 W-20: the call ended in a file warning of this kind (fixed code)
  scan?: string; // v0.5 W-21: the owner's scanner's verdict on that file (fixed code)
  lang?: string; // v0.7 W-26: the detected language of what was read (a code from the fixed list, or "unknown")
  rendered?: true; // v0.7 W-10: the page was rendered (its JavaScript run) in this call
  saved?: true; // v0.8 W-28: a snapshot of the page was saved in this call
  // v0.9 W-32 (tool "settings"): a risky setting changed, with who made it (fixed codes and a validated site only)
  setting?: string; // the risky setting's name, or "confirmations"
  site_key?: string; // the site, for a site setting
  change?: "looser" | "stricter" | "never_ask" | "ask_again";
  by?: "terminal" | "not_terminal"; // best effort: whether standard input was a terminal
  confirmed?: "phrase" | "never_ask" | "not_needed";
  // v0.9 W-33 (tool "server"): the MCP server stopped at its memory ceiling (ceiling.ts), with the ceiling in MB
  event?: "memory_ceiling";
  memory_mb?: number;
  cut?: true; // a field was too long (or not a known code) and was cut or left out
}

// Bounds on what one record may hold, so a single line can never outgrow a history page.
const MAX_AGENT = 200;
const MAX_PURPOSE = 1000;
const MAX_URL_LOG = 4096;
// The W-12 fields hold fixed codes and small numbers only. Anything else is left out.
const REASONS = new Set(["bot_challenge", "captcha", "login_required", "forbidden", "owner_hand_off"]); // owner_hand_off: W-25 (v0.6)
const DOORS = new Set(["mcp", "api", "feed", "structured", "text", "none"]);
const MAX_MATCHED = 1000;
const TICKETS = new Set(["created", "refused_cap"]);
const CACHE = new Set(["fresh", "revalidated", "refetched"]);
const FLAGS = new Set(["phishing_list", "web_risk"]);
const SLIP_ID = /^[A-Za-z0-9_-]{24}$/;
const FILE_KINDS = new Set(["program", "script", "shortcut", "addon", "archive", "office", "image", "media", "unknown"]);
const SCANS = new Set(["bad", "clean", "unknown", "failed"]);
const SETTINGS = new Set(["saving", "rendering", "translator", "scanner", "anchoring", "anchor_calendars", "safe_browsing", "ports", "spacing_seconds", "never_visit", "hand_off", "confirmations"]);
const CHANGES = new Set(["looser", "stricter", "never_ask", "ask_again"]);
const BYS = new Set(["terminal", "not_terminal"]);
const HOWS = new Set(["phrase", "never_ask", "not_needed"]);
const SITE_KEY = /^[a-z0-9.*\-[\]:_]{1,260}$/;

// One file per UTC day, append only: history/YYYY-MM-DD.jsonl (the date of the entry's own
// timestamp). v0.1 wrote one history.jsonl; it is still read. Too-long fields are cut
// plainly and the record says `cut: true`.
// Applies the bounds to a record, in place. Used when writing AND when reading, so an
// oversized record from an older file (including a v0.1 history.jsonl) is readable too.
export function bound(e: HistoryEntry): HistoryEntry {
  let over = false;
  for (const [k, n] of [["agent", MAX_AGENT], ["purpose", MAX_PURPOSE], ["url", MAX_URL_LOG]] as const) {
    const v = e[k];
    if (typeof v === "string" && v.length > n) {
      e[k] = v.slice(0, n);
      over = true;
    }
  }
  const drop = (k: "reason" | "matched" | "best_door" | "llms_txt" | "ticket" | "source" | "cache" | "flag" | "slip" | "file_kind" | "scan" | "lang" | "rendered" | "saved" | "setting" | "site_key" | "change" | "by" | "confirmed" | "event" | "memory_mb") => {
    delete e[k];
    over = true;
  };
  if (e.reason !== undefined && !(typeof e.reason === "string" && REASONS.has(e.reason))) drop("reason");
  if (e.matched !== undefined && !(Number.isSafeInteger(e.matched) && e.matched >= 0 && e.matched <= MAX_MATCHED)) drop("matched");
  if (e.best_door !== undefined && !(typeof e.best_door === "string" && DOORS.has(e.best_door))) drop("best_door");
  if (e.llms_txt !== undefined && e.llms_txt !== true) drop("llms_txt");
  if (e.ticket !== undefined && !(typeof e.ticket === "string" && TICKETS.has(e.ticket))) drop("ticket");
  if (e.source !== undefined && e.source !== "provided_by_person") drop("source");
  if (e.cache !== undefined && !(typeof e.cache === "string" && CACHE.has(e.cache))) drop("cache");
  if (e.flag !== undefined && !(typeof e.flag === "string" && FLAGS.has(e.flag))) drop("flag");
  if (e.slip !== undefined && !(typeof e.slip === "string" && SLIP_ID.test(e.slip))) drop("slip");
  if (e.file_kind !== undefined && !(typeof e.file_kind === "string" && FILE_KINDS.has(e.file_kind))) drop("file_kind");
  if (e.scan !== undefined && !(typeof e.scan === "string" && SCANS.has(e.scan))) drop("scan");
  if (e.lang !== undefined && !(typeof e.lang === "string" && (e.lang === "unknown" || LANG_SET.has(e.lang)))) drop("lang");
  if (e.rendered !== undefined && e.rendered !== true) drop("rendered");
  if (e.saved !== undefined && e.saved !== true) drop("saved");
  if (e.setting !== undefined && !(typeof e.setting === "string" && SETTINGS.has(e.setting))) drop("setting");
  if (e.site_key !== undefined && !(typeof e.site_key === "string" && SITE_KEY.test(e.site_key))) drop("site_key");
  if (e.change !== undefined && !(typeof e.change === "string" && CHANGES.has(e.change))) drop("change");
  if (e.by !== undefined && !(typeof e.by === "string" && BYS.has(e.by))) drop("by");
  if (e.confirmed !== undefined && !(typeof e.confirmed === "string" && HOWS.has(e.confirmed))) drop("confirmed");
  if (e.event !== undefined && e.event !== "memory_ceiling") drop("event");
  if (e.memory_mb !== undefined && !(Number.isSafeInteger(e.memory_mb) && e.memory_mb >= 1 && e.memory_mb <= 65536)) drop("memory_mb");
  if (over) e.cut = true;
  return e;
}

export function record(e: HistoryEntry): void {
  const out = bound({ v: 1, ...e } as HistoryEntry); // v0.5.1: the record's format version
  const t = Date.parse(out.time);
  appendLine(`history/${utcDay(Number.isNaN(t) ? Date.now() : t)}.jsonl`, out);
}

export async function query(f: { since?: string; site?: string; agent?: string; page?: number }): Promise<LogPage<HistoryEntry>> {
  const since = parseSince(f.since);
  const site = f.site?.toLowerCase().replace(/^www\./, "");
  return pageLog<HistoryEntry>(
    listLogs("history").map((f) => f.rel),
    (e) => {
      if (!e || typeof e !== "object") return false; // a stray non-record line is skipped
      if (since !== null && Date.parse(e.time) < since) return false;
      if (f.agent && String(e.agent).toLowerCase() !== f.agent.toLowerCase()) return false;
      if (site) {
        let host = "";
        try {
          host = new URL(e.url).hostname.toLowerCase().replace(/^www\./, "");
        } catch {
          return false;
        }
        if (host !== site && !host.endsWith("." + site)) return false;
      }
      bound(e); // filters match the stored values; only what is returned is cut
      return true;
    },
    f.page ?? 1,
  );
}
