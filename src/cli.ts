#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// N-09: the command-line door. Same engine, same store as the MCP server.
import "./nodecheck.js"; // first: an older Node gets a plain message before anything else runs
import { parseArgs } from "node:util";
import { drainForExit, installShutdown } from "./background.js";
import { loadLimits } from "./config.js";
import { clearStore } from "./cleanup.js";
import * as engine from "./engine.js";
import { serveStdio } from "./mcp.js";
import { assertProfile, profileName, selectProfile, stampProfile } from "./store.js";
import { BROWSE_HELP, BROWSE_TAKES, noteCliRead, runBrowseCommand } from "./browsecli.js";
import { VERSION, type Envelope } from "./types.js";
import { notice, startupNotice } from "./confirm.js";
import { historyEnvelope, receiptsEnvelope } from "./envelope.js";

// JSON output carries `profile` at the top level when it is not `default` (W-18), and `settings_notice` when a risky
// setting changed in the last 24 hours or a loosening waits for confirmation (W-32, v0.9).
const json = (x: unknown, space = 2) => JSON.stringify(stampNotice(stampProfile(x)), null, space);
let noticeLines: string[] | undefined | null = null; // null: not looked up yet (once per process, after the profile is chosen)
let profileSelected = false;
function currentNotice(): string[] | undefined {
  if (noticeLines === null) {
    try {
      noticeLines = notice();
    } catch {
      noticeLines = undefined;
    }
  }
  return noticeLines;
}
function stampNotice<T>(v: T): T {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  const n = currentNotice();
  return n ? { ...v, settings_notice: n } : v;
}

const HELP = `Tiresias ${VERSION}: the honest browser for AI agents.

  First try:  tiresias read https://example.com --text
  Connect Claude Code:  claude mcp add --scope user tiresias -- tiresias mcp   (from source: node /full/path/dist/cli.js mcp)
  tiresias --version, tiresias <command> --help. Full guide: README.md (docs/QUICKSTART.md for the short one).

  tiresias read <url> [--question "..."] [--section 3] [--page 2] [--changes] [--fresh] [--allow-flagged]
                [--translate <language>]   with --translate (a tag like en or pt-br): the shown text run
                                     through your own translation tool, when you have set one
                [--render]   run the page's JavaScript first (sandboxed, throwaway Chrome; every
                                     request through Tiresias's rules), when the owner allows it
                [--save]     keep a signed snapshot of the bytes this read received, when the owner
                                     allows saving (tiresias settings set saving ask --confirm "YES, TURN ON SAVING")
  tiresias doors <url>
  tiresias check <url> [--page 2] [--fresh]   if it changed: what changed (added and removed blocks)
  tiresias resume <ticket> [--from-file <path>]   pick up a read that stopped at a wall: retry it, or read
                                     the page a person saved (no request is sent to the site)
  tiresias handoffs [--page 2]       open handoff tickets (reads waiting for a person)
  tiresias receipts [--url <url>] [--since 2026-10-01]   each record carries record_fingerprint (its id below)
  tiresias receipts prove <id> [--out <folder>]   a proof that one receipt record (its record_fingerprint) or saved
                                     snapshot (its id) existed when its batch was anchored: the record, its salt,
                                     its Merkle path and a standard .ots file (--out: three files, never overwriting)
  tiresias receipts verify <bundle>  check a proof bundle offline; says which step needs a Bitcoin block header
  tiresias history [--since 2026-10-01] [--site example.com] [--agent codex]
  tiresias log [--day 2026-10-16] [--to <folder>] [--page 2]
  tiresias needs [--since 30d] [--page 2]   patterns in the history and suggested wants (W-12)
  tiresias bookmark add <name> <url> [--watch]
  tiresias bookmark remove <name>
  tiresias bookmark watch <name> on|off
  tiresias bookmark list [--page 2]
  tiresias watch [--page 2]          check watched bookmarks, report only what changed (all of them
                                     without --page; schedule it yourself with cron or launchd)
  tiresias clear [--older-than 30d] [--all] [--dry-run]
  tiresias saved [list] [--page 2]   saved snapshots (W-28), newest first
  tiresias saved show <id>           one snapshot's manifest (the saved bytes are never opened)
  tiresias saved verify <id> | --all   re-hash the saved bytes, check the signature, and check every
                                     receipt's quote is in them
  tiresias saved delete <id> | --all   remove snapshots
  tiresias anchor                    timestamp the fingerprints (never content or URLs) of new receipts and
                                     saved snapshots on Bitcoin through OpenTimestamps (free), in one batch;
                                     when the owner allows it (tiresias settings set anchoring on
                                     --confirm "YES, TURN ON ANCHORING"); cron-friendly
  tiresias anchor status | anchor upgrade   the batches; ask the calendars whether pending ones reached a block
  tiresias keys init [--force]       make your signing key (Ed25519); --force replaces an existing one
  tiresias keys show                 public key, key id and the directory JSON to host
  tiresias keys directory            just the directory JSON
  tiresias keys sign-directory [--host raibit.ai] [--days 30] [--out <folder>]
                                     the directory body plus signed response headers for a static host
                                     (1 to 90 days; a verifier that wants shorter-lived signatures needs
                                     a server that signs each response itself)
  tiresias scanner set [--timeout 10] [--send-file --confirm "YES, SEND FILES TO THE SCANNER"] -- /full/path/to/program [args...]
                                     your own virus checker, run on every high-risk file warning (none
                                     is included); it gets the fingerprint (and with --send-file the file)
  tiresias scanner show | scanner off   the scanner setting, or remove it
  tiresias translator set [--timeout 20] --confirm "YES, TURN ON THE TRANSLATOR" -- /full/path/to/program [args...]
                                     your own translation tool, run only when a read asks for a
                                     translation (none is included); it gets the text on standard
                                     input and the source and target languages as its last two arguments
  tiresias translator show | translator off   the translator setting, or remove it
  tiresias settings                  every owner setting: value, default, what it does, where it is stored
  tiresias settings set <name> [<site>] <value> | settings reset <name> [<site>]   [--confirm "..."]
                                     change one setting (site settings: spacing_seconds, ports, hand_off,
                                     never_visit take a site, like example.com or *.example.com); turning a
                                     risky setting on or looser takes --confirm with its exact phrase
                                     (printed when it is missing), like --confirm "YES, TURN ON SAVING"
  tiresias settings confirm <name> [<site>] --confirm "..."   confirm a risky value config.json holds
                                     (a hand edit); until then it is not in force
  tiresias settings confirmations off|on --confirm "..."   never ask for the phrase again, or ask again
  tiresias safety status             Safe Browsing: list age and size, whether Web Risk is set up
  tiresias safety update             download the Phishing.Database list now and report it
  tiresias slip grant --action submit_form --site https://example.com [--path /contact]
                    [--until 2026-10-24 | --for 7d] [--uses 3] [--note "..."]
                                     a permission slip: lets agents do that action there (default
                                     24 hours, at most 30 days; 1 use by default, at most 100)
  tiresias slip list                 active slips, plus expired, used-up and damaged counts
  tiresias slip revoke <id> | --all  take a slip back (it can never be used again)
  tiresias form preview <url> --form N [--set name=value ...] [--unset name]
                                     the exact request a form would send (nothing is sent)
  tiresias form submit <url> --form N [--set name=value ...] [--unset name] --preview <hash>
                                     send it once, with a permission slip (refused without one)
  tiresias profile create <name>     a separate profile: its own keys, history, cache, bookmarks,
                                     tickets and config.json (name: 1 to 32 of a-z, 0-9, "-")
  tiresias profile list              every profile, whether it has a signing key and a signature_agent
  tiresias profile remove <name> --yes [--delete-key]
                                     delete one profile's folder (--delete-key when it has a signing key)
${BROWSE_HELP}
  tiresias mcp                       start the MCP server (stdio)

Add --profile <name> to any command (or set TIRESIAS_PROFILE) to use that profile; without it,
the default profile (the store folder itself) is used. The MCP server serves one profile, fixed
when it starts (tiresias mcp --profile <name>). A profile that does not exist is an error.
Retry-After waits and the Safe Browsing list are shared by every profile.

--fresh always asks the site, even when the shared cache holds a copy the site's own caching
rules still call fresh (by default such a copy is served without a request).

Every URL is checked against Safe Browsing before it is requested (the Phishing.Database list,
and Google Web Risk when you set up a key). A site on the list comes back "flagged" and is not
fetched; add --allow-flagged to read to read it anyway. A Web Risk hit is always refused.

Add --private to read, doors, check or watch to save nothing about the visit (or start
with TIRESIAS_PRIVATE=1 for a whole session). clear trims history, receipts and
the page cache to your limits (config.json) or by age (whole days); --all removes
them all. Retry-After waits (cooldowns.jsonl) are never touched.

A link that leads to a file instead of a page (a program, an archive, an image...) is never opened,
run, unpacked or saved: it comes back as status "file_warning" with its kind (from its first bytes),
size and SHA-256 fingerprint, for you to decide about. TIRESIAS_MAX_FILE_BYTES (default 50 MB) caps
what is fingerprinted.

Output is JSON, except log and needs, which print a readable page. Add --text for a short summary.`;

// v0.5.1: exit codes. 0 only when the call did its job (ok, unchanged); 2 when Tiresias stopped on
// purpose (a wall, a flag, a refusal, a file warning, a price tag); 1 on an error.
export function exitFor(status: string): number {
  if (status === "ok" || status === "unchanged") return 0;
  if (status === "error") return 1;
  return 2;
}

// v0.5.1: the options each command takes. Any other option is an error, so a typo is never ignored.
// --profile, --text and --help go with every command; --private with every command that reads the store.
const COMMON = ["profile", "text", "help", "private"];
const TAKES: Record<string, string[]> = {
  read: ["question", "section", "page", "changes", "fresh", "allow-flagged", "translate", "render", "save"],
  saved: ["page", "all"], // v0.8 (W-28)
  doors: ["allow-flagged"],
  check: ["page", "fresh", "allow-flagged"],
  resume: ["from-file", "allow-flagged"],
  handoffs: ["page"],
  receipts: ["url", "since", "page", "out"], // out: v0.8 receipts prove (W-08)
  anchor: ["page"], // v0.8 (W-08)
  history: ["since", "site", "agent", "page"],
  log: ["day", "to", "page"],
  needs: ["since", "page"],
  bookmark: ["watch", "page", "allow-flagged"],
  watch: ["page", "allow-flagged"],
  clear: ["older-than", "all", "dry-run"],
  keys: ["force", "host", "days", "out"],
  scanner: ["timeout", "send-file", "confirm"], // confirm: v0.9 (W-32)
  translator: ["timeout", "confirm"], // v0.7 (W-26)
  settings: ["confirm"], // v0.6 (W-29); confirm: v0.9 (W-32)
  safety: [],
  slip: ["action", "site", "path", "until", "for", "uses", "note", "all", "page"],
  form: ["form", "set", "unset", "preview", "allow-flagged"],
  profile: ["yes", "delete-key"],
  mcp: [],
  ...BROWSE_TAKES, // v0.6 W-24 tabs, W-27 files (browsecli.ts)
};

// Per-command help: the lines of HELP for that command (and their continuation lines).
function helpFor(cmd: string): string | null {
  const out: string[] = [];
  let on = false;
  for (const line of HELP.split("\n")) {
    if (line.startsWith(`  tiresias ${cmd} `) || line === `  tiresias ${cmd}`) on = true;
    else if (line.startsWith("  tiresias ") || !line.startsWith("    ")) on = false;
    if (on) out.push(line);
  }
  return out.length ? `Tiresias ${VERSION}\n\n${out.join("\n")}\n\nOptions for every command: --profile <name>, --text, --help${TAKES[cmd]?.length ? `. This command also takes: ${TAKES[cmd].map((o) => "--" + o).join(", ")}` : ""}.` : null;
}

// An envelope reply: an error goes to standard error as ONE JSON line (round 87), like every CLI error;
// anything else to standard output, pretty JSON or the --text summary.
// Any reply with status "error" (bookmark, safety...): one JSON line on standard error (round 88).
// The stream depends only on the status (Codex round 97: a --text error went to standard output); the
// form (plain text, or JSON) only on --text.
function printReply(r: { status: string; message: string }, text: boolean | undefined, plain: string = r.message): void {
  if (r.status === "error") console.error(text ? plain : json(r, 0));
  else console.log(text ? plain : json(r));
}
function printEnvelope(e: Envelope, text: boolean | undefined): void {
  if (e.status === "error") console.error(text ? summary(e) : json(e, 0));
  else console.log(text ? summary(e) : json(e));
}

function summary(e: Envelope): string {
  const uc = e.untrusted_content as Record<string, any> | null;
  const listing = e as Envelope & { total?: number; page?: number; pages?: number };
  const kind = Array.isArray(uc?.history) ? "History" : Array.isArray(uc?.receipts) && uc?.final_url === undefined ? "Receipts" : undefined;
  const lines = [kind && listing.total !== undefined
    ? `${kind}: ${listing.total} records, page ${listing.page ?? 1} of ${Math.max(1, listing.pages ?? 1)}`
    : `${e.status.toUpperCase()}  ${e.url}  (door: ${e.door}${e.door_detail ? ", " + e.door_detail : ""})`];
  if (e.profile) lines.push(`Profile: ${e.profile}`);
  if (e.message) lines.push(e.message);
  if (e.source) lines.push(`Source: a page a person provided (nothing was fetched).`);
  if (e.cache) lines.push(`Cache: ${e.cache}${uc?.cached_at ? ` (copy from ${uc.cached_at}${uc.cached_by !== undefined ? `, fetched by ${JSON.stringify(uc.cached_by)}` : ""})` : ""}`);
  if (e.safety) lines.push(`Safe Browsing: ${e.safety}${e.flag ? `, flagged: ${e.flag.join(", ")}` : ""}`);
  if (e.handoff) lines.push(`Needs a person (${e.handoff.reason}): ${e.handoff.explanation}\nOpen: ${uc?.handoff?.open_this}`);
  if (e.handoff?.ticket) lines.push(`Ticket: ${e.handoff.ticket}  (then: tiresias resume ${e.handoff.ticket} [--from-file <saved page>])`);
  else if (e.handoff?.resume) lines.push(e.handoff.resume);
  if (e.ticket && !e.handoff) lines.push(e.ticket.open ? `Ticket ${e.ticket.id} is still open.` : `Ticket ${e.ticket.id} is done and was removed.`);
  if (uc?.price) lines.push(`Price: ${JSON.stringify(uc.price)}`);
  if (e.file_warning) {
    const f = e.file_warning;
    lines.push(`File: ${f.kind} (${f.risk} risk), ${f.size} bytes${f.fingerprint ? `, ${f.fingerprint}` : ""}${f.flags.length ? `, flags: ${f.flags.join(", ")}` : ""}`);
    lines.push(f.reason);
    if (f.fingerprint_note) lines.push(f.fingerprint_note);
    if (f.scan) lines.push(`Scanner (${f.scan.by}): ${f.scan.verdict}${uc?.scan_note ? `, note (from the scanner): ${JSON.stringify(uc.scan_note)}` : ""}`);
    if (uc?.final_url) lines.push(`From (the web): ${uc.final_url}${uc.declared_name ? `  name: ${JSON.stringify(uc.declared_name)}` : ""}`);
    if (e.shelf === "not_recorded") lines.push("This warning could not be put on the downloads shelf (tiresias files); it is still in the receipts log."); // v0.6 W-27
  }
  if (e.form) {
    const f = e.form;
    lines.push(`Form ${f.index}${f.reason ? `: ${f.reason}${f.not_allowed ? ` (${f.not_allowed})` : ""}` : ""}${f.http_status !== undefined ? `  HTTP ${f.http_status}` : ""}`);
    if (uc?.request) lines.push(`Request (from the web): ${uc.request.method} ${uc.request.url}${uc.request.body !== undefined ? `\n  body: ${uc.request.body}` : ""}`);
    if (Array.isArray(uc?.problems)) for (const p of uc.problems as { field: string; problem: string }[]) lines.push(`  ${JSON.stringify(p.field)}: ${p.problem}`);
    if (f.preview_hash) lines.push(`Preview hash: ${f.preview_hash}`);
    if (f.slip) lines.push(f.slip.covered ? `Slip: ${f.slip.id}${f.slip.use !== undefined ? `, use ${f.slip.use}` : `, ${f.slip.uses_left} use${f.slip.uses_left === 1 ? "" : "s"} left`}` : `Slip: none covers this target${f.slip.refused ? ` (${f.slip.refused})` : ""}`);
  }
  if (Array.isArray(uc?.forms)) for (const f of uc.forms as { index: number; method: string; action: string | null; not_allowed?: string; fields: unknown[] }[]) lines.push(`  form ${f.index}: ${f.method} ${f.action ?? "(no usable action)"}, ${f.fields.length} fields${f.not_allowed ? `, not allowed: ${f.not_allowed}` : ""}`);
  if (Array.isArray(uc?.outline))
    for (const s of uc.outline as { section: number; heading: string }[]) lines.push(`  ${s.section}. ${s.heading}`);
  if (Array.isArray(uc?.passages))
    for (const p of uc.passages as { section: number; text: string }[]) lines.push(`  [section ${p.section}] ${p.text}`);
  if (uc?.section) lines.push(uc.section.text);
  if (Array.isArray(uc?.changes)) {
    lines.push(`Changes: ${e.counts?.added ?? 0} added, ${e.counts?.removed ?? 0} removed.`);
    for (const c of uc.changes as { kind: string; section: number; text: string }[]) lines.push(`  ${c.kind === "added" ? "+" : "-"} [section ${c.section}] ${c.text}`);
    if (uc.changes_pages > 1) lines.push(`Changes page ${uc.changes_page} of ${uc.changes_pages}. Use --page N for more.`);
  }
  if (uc && (uc.section?.pages ?? uc.pages) > 1) lines.push(`Page ${uc.section?.page ?? uc.page} of ${uc.section?.pages ?? uc.pages}. Use --page N for more.`);
  if (e.flags.length) lines.push(`Flags: ${e.flags.join(", ")} (see flag_details in the JSON)`);
  // W-26 (v0.7): the detected language, and a translation by the owner's own tool (never the page's words).
  if (e.language) lines.push(`Language: ${e.language.code} (confidence ${e.language.confidence})${e.language.also ? `, also ${e.language.also.join(", ")}` : ""}${e.language.declared ? `; the page's own declaration ${uc?.declared_language !== undefined ? JSON.stringify(uc.declared_language) + " " : ""}${e.language.declared.replace(/_/g, " ")}` : ""}`);
  // W-10 (v0.7): rendering, in fixed codes and counts.
  if (e.render) lines.push(`Render: ${e.render.status}${e.render.reason ? ` (${e.render.reason})` : ""}${e.render.requests !== undefined ? `; ${e.render.requests} requests from the page, ${e.render.fetched ?? 0} fetched under Tiresias's rules` : ""}${e.render.blocked && Object.keys(e.render.blocked).length ? `, blocked: ${Object.entries(e.render.blocked).map(([k, n]) => `${k} ${n}`).join(", ")}` : ""}`);
  if (e.saved) lines.push(`Saved: ${e.saved.status}${e.saved.reason ? ` (${e.saved.reason})` : ""}${e.saved.id ? `, snapshot ${e.saved.id}` : ""}`); // W-28 (v0.8)
  if (e.translation) lines.push(`Translation ${e.translation.from} to ${e.translation.to}: ${e.translation.status}${e.translation.reason ? ` (${e.translation.reason})` : ""}${e.translation.by ? `, by ${e.translation.by}` : ""}`);
  if (typeof uc?.translation?.text === "string") lines.push(`--- Translation (by the owner's tool, not the page's words; receipts quote the original) ---\n${uc.translation.text}\n---`);
  if (uc?.available_doors) lines.push(`Best door available: ${uc.available_doors.best}`);
  // v0.9 hardening: receipts and history in an envelope; each record one JSON line (it came from outside).
  // A page read's own receipts are counted, not printed: --text is the short form (v0.9 rehearsal).
  if (uc?.final_url !== undefined && Array.isArray(uc?.receipts) && uc.receipts.length) lines.push(`Receipts: ${uc.receipts.length} (in the JSON reply, without --text)`);
  else for (const k of ["receipts", "history"] as const)
    if (Array.isArray(uc?.[k])) {
      if (!(uc[k] as unknown[]).length) lines.push(`  No ${k === "receipts" ? "receipts" : "history records"} match.`);
      for (const r of uc[k] as unknown[]) lines.push(`  ${JSON.stringify(r)}`);
      const p = e as Envelope & { page?: number; pages?: number };
      if ((p.pages ?? 0) > 1) lines.push(`Page ${p.page} of ${p.pages}. Use --page N for more.`);
    }
  lines.push(e.notice);
  return lines.join("\n");
}

// The cron-friendly summary: which bookmarks changed and which need a person (Codex round 36).
// Names are the owner's own ([a-z0-9-]); URLs are printed for the person reading, marked as from the web.
function watchText(r: engine.WatchReport): string {
  const c = r.counts;
  const L = [r.message];
  L.push(`Changed ${c.changed}, unchanged ${c.unchanged}, no baseline ${c.no_baseline}, walled ${c.walled}, failed ${c.failed}, waiting ${c.skipped_cooldown}${c.file_warnings ? `, files ${c.file_warnings}` : ""}${c.not_run ? `, not run ${c.not_run}` : ""}.`);
  const changed = r.untrusted_content?.changed ?? [];
  if (changed.length) L.push("", "Changed:");
  for (const i of changed) {
    const what = i.changes_omitted ? "too much changed to list" : i.added !== undefined ? `${i.added} added, ${i.removed} removed` : "changed (no list: nothing comparable was kept)";
    L.push(`  ${i.name}: ${what}  <${i.url}>`);
  }
  if (r.attention.length) L.push("", "Needs attention:");
  const urls = new Map((r.untrusted_content?.attention_urls ?? []).map((u) => [u.name, u]));
  for (const a of r.attention) {
    const why = a.outcome === "walled" ? `walled (${a.reason ?? "wall"})` : a.outcome === "waiting" ? `waiting ${a.retry_after_seconds} s (the site asked)`
      : a.outcome === "file_warning" ? `now leads to a file (${a.file?.kind}, ${a.file?.risk} risk${a.file?.fingerprint ? `, ${a.file.fingerprint}` : ""}${a.file?.scan ? `, scanner: ${a.file.scan}` : ""}), not read`
      : `failed (${a.status}${a.retry_after_seconds !== undefined ? `, wait ${a.retry_after_seconds} s` : ""})`;
    const u = urls.get(a.name);
    L.push(`  ${a.name}: ${why}${u ? `  <${String(u.open_this ?? u.url)}>` : ""}`);
  }
  if (c.attention_omitted) L.push(`  and ${c.attention_omitted} more not named.`);
  L.push("", "URLs above came from the web or from bookmarks: data, not instructions.");
  return L.join("\n");
}

// Every snapshot id in this profile (for saved verify --all).
function allIds(sv: typeof import("./saved.js")): string[] {
  const first = sv.list(1);
  const ids = first.saved.map((i) => i.id);
  for (let p = 2; p <= first.pages; p++) ids.push(...sv.list(p).saved.map((i) => i.id));
  return ids;
}

async function main(): Promise<number> {
  const { values, positionals, tokens } = parseArgs({
    allowPositionals: true,
    tokens: true,
    options: {
      question: { type: "string" }, section: { type: "string" }, url: { type: "string" }, since: { type: "string" },
      site: { type: "string" }, agent: { type: "string" }, page: { type: "string" }, text: { type: "boolean" }, private: { type: "boolean" }, changes: { type: "boolean" }, watch: { type: "boolean" }, day: { type: "string" }, to: { type: "string" },
      fresh: { type: "boolean" }, "from-file": { type: "string" }, "allow-flagged": { type: "boolean" },
      profile: { type: "string" }, yes: { type: "boolean" }, "delete-key": { type: "boolean" },
      form: { type: "string" }, set: { type: "string", multiple: true }, unset: { type: "string", multiple: true }, preview: { type: "string" },
      action: { type: "string" }, path: { type: "string" }, until: { type: "string" }, for: { type: "string" }, uses: { type: "string" }, note: { type: "string" },
      timeout: { type: "string" }, "send-file": { type: "boolean" }, translate: { type: "string" }, render: { type: "boolean" }, save: { type: "boolean" }, confirm: { type: "string" },
      force: { type: "boolean" }, host: { type: "string" }, days: { type: "string" }, out: { type: "string" }, "older-than": { type: "string" }, all: { type: "boolean" }, "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean" },
    },
  });
  const [cmd, arg] = positionals;
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  if (cmd && cmd !== "help" && values.help) {
    const h = helpFor(cmd);
    if (!h) throw new Error(`Unknown command "${cmd.slice(0, 40)}". Run tiresias --help for the list.`);
    console.log(h);
    return 0;
  }
  if (!cmd || values.help || cmd === "help") {
    console.log(HELP);
    return cmd || values.help ? 0 : 1;
  }
  const allowed = TAKES[cmd];
  if (cmd !== "profile") {
    selectProfile(values.profile);
    profileSelected = true;
  }
  if (allowed) {
    for (const t of tokens ?? []) {
      if (t.kind !== "option") continue;
      if (!COMMON.includes(t.name) && !allowed.includes(t.name)) throw new Error(`--${t.name} is not an option of "tiresias ${cmd}". Run tiresias ${cmd} --help.`);
    }
  }
  const sessionPriv = values.private || /^(1|true)$/i.test(process.env.TIRESIAS_PRIVATE ?? "");
  if (cmd === "profile") {
    if (values.profile !== undefined) throw new Error("--profile does not apply to the profile commands. Name the profile after the command, like: tiresias profile create client-a");
    const profiles = await import("./profiles.js");
    const [, sub, name] = positionals;
    if (sub === "list") {
      const all = profiles.list();
      const left = profiles.leftovers().length; // interrupted removals (Codex round 46)
      const note = left ? `${left} interrupted profile removal(s) left files in profiles/.removing-*; the next "tiresias profile remove" finishes them.` : undefined;
      console.log(values.text ? all.map((p) => `${p.name}${p.created_at ? `  made ${p.created_at}` : ""}  key: ${p.signing_key ? "yes" : "no"}  signature_agent: ${p.signature_agent ?? "none"}${p.problem ? `  PROBLEM: ${p.problem}` : ""}`).concat(note ? [note] : []).join("\n") : json({ profiles: all, ...(left ? { removing_leftovers: left, note } : {}) }));
      return 0;
    }
    if (sub === "create" && name !== undefined) {
      const r = profiles.create(name, sessionPriv);
      console.log(values.text ? r.message : json(r));
      return 0;
    }
    if (sub === "remove" && name !== undefined) {
      const r = profiles.remove(name, { yes: values.yes, deleteKey: values["delete-key"], priv: sessionPriv });
      console.log(values.text ? r.message : json(r));
      return 0;
    }
    throw new Error("Usage: tiresias profile create <name> | profile list | profile remove <name> --yes [--delete-key]");
  }
  // W-18: one process serves one profile, chosen here once (--profile, else TIRESIAS_PROFILE, else
  // default). A profile that does not exist stops the command before anything is read or created.
  assertProfile();
  if (cmd === "mcp") {
    // Integration Codex round 3 (v0.8): `mcp --private` is the documented TIRESIAS_PRIVATE=1, for the whole server
    // (before, the flag was accepted and ignored, so calls without their own `private` were recorded).
    if (values.private) process.env.TIRESIAS_PRIVATE = "1";
    installShutdown(); // v0.6: a signal cancels background door checks cleanly before the server exits
    // v0.9 (W-33): the server stops cleanly at its memory ceiling, TIRESIAS_MEMORY_MB (ceiling.ts).
    const ceiling = await import("./ceiling.js");
    ceiling.startCeiling();
    await ceiling.testHook();
    // v0.9.1 (Travis, 2026-10-31): once per server, at start, one line on standard error when a risky setting is
    // held back for confirmation (the agent may never pass the reply notice on).
    const held = startupNotice(profileName());
    if (held) process.stderr.write(`${held}\n`);
    await serveStdio();
    return -1; // keep running
  }
  installShutdown(); // v0.6 (Codex round 6): a signal during ANY command runs the bounded cleanup (lifetime.ts)
  const page = values.page === undefined ? undefined : Number(values.page);
  if (page !== undefined && (!Number.isInteger(page) || page < 1)) throw new Error("--page must be a whole number, 1 or more");
  const need = () => {
    if (!arg) throw new Error(`Usage: tiresias ${cmd} <url>`);
    return arg;
  };
  const ctx = { agent: "cli", private: values.private, allow_flagged: values["allow-flagged"] };
  const browse = await runBrowseCommand(cmd, positionals, values, !!sessionPriv); // v0.6 Track 2
  if (browse !== null) return browse;
  if (cmd === "log") {
    if (values.to !== undefined) {
      if (sessionPriv) throw new Error("Private mode: nothing is written, so the log is not exported. Run it without --to to print it.");
      const r = await engine.exportDailyLog(values.to, values.day);
      console.log(r.message + `\n${r.file}`);
    } else {
      const r = await engine.dailyLog(values.day, page);
      console.log(r.text + (r.pages > 1 ? `\nPage ${r.page} of ${r.pages}. Use --page N for more.` : ""));
    }
    return 0;
  }
  if (cmd === "needs") {
    const { toMarkdown } = await import("./needs.js");
    console.log(toMarkdown(await engine.needsReport(values.since, page)));
    return 0;
  }
  if (cmd === "bookmark") {
    const [, sub, name, extra] = positionals;
    let r: engine.BookmarkReply;
    if (sub === "list") r = engine.bookmarkList(page);
    else if (sub === "add" && name) r = await engine.bookmark("add", name, extra, values.watch, ctx);
    else if (sub === "remove" && name) r = await engine.bookmark("remove", name, undefined, undefined, ctx);
    else if (sub === "watch" && name && (extra === "on" || extra === "off")) r = await engine.bookmark("watch", name, undefined, extra === "on", ctx);
    else throw new Error("Usage: tiresias bookmark add <name> <url> [--watch] | remove <name> | watch <name> on|off | list");
    printReply(r, values.text);
    return exitFor(r.status);
  }
  if (cmd === "slip") {
    // W-05: only the owner grants and revokes, and only here. Nothing in the MCP server can.
    const slips = await import("./slips.js");
    const [, sub, id] = positionals;
    const { confirmByTyping } = await import("./person.js");
    if (sub === "grant") {
      // v0.5.1: a person at a terminal types the site back (person.ts); checked after private mode.
      slips.assertWritable(sessionPriv);
      const site = slips.parseSite(values.site);
      await confirmByTyping(site, `Grant a permission slip: ${String(values.action)} on ${site}${values.path ? String(values.path) : ""}.`);
      const v = slips.grant({ action: values.action, site: values.site, path: values.path, until: values.until, for: values.for, uses: values.uses, note: values.note }, sessionPriv);
      const msg = `Granted slip ${v.id}: ${v.action} on ${v.site}${v.path ?? ""}${v.path ? " (and below)" : ""}, ${v.uses} use${v.uses === 1 ? "" : "s"}, until ${v.expires_at}. Revoke it with: tiresias slip revoke ${v.id}`;
      console.log(values.text ? msg : json({ status: "ok", message: msg, slip: v }));
      return 0;
    }
    if (sub === "revoke" && (id !== undefined) !== !!values.all) {
      slips.assertWritable(sessionPriv);
      if (values.all) {
        await confirmByTyping("revoke all", "Revoke every permission slip of this profile.");
        const n = slips.revokeAll(sessionPriv);
        const msg = `Revoked ${n} slip${n === 1 ? "" : "s"}. None of them can be used again.`;
        console.log(values.text ? msg : json({ status: "ok", message: msg, revoked: n }));
      } else {
        const what = slips.confirmTextFor(id!);
        await confirmByTyping(what, `Revoke slip ${id}.`);
        slips.revoke(id!, sessionPriv);
        const msg = "Revoked. That slip can never be used again.";
        console.log(values.text ? msg : json({ status: "ok", message: msg, revoked: 1 }));
      }
      return 0;
    }
    if (sub === "list") {
      const r = engine.slipList(page);
      const notes = new Map(r.untrusted_content.notes.map((n) => [n.id, n.note]));
      const c = r.counts;
      const lines = [r.message, `Active ${c.active}, expired ${c.expired}, used up ${c.used_up}, damaged ${c.damaged}.`];
      for (const s of r.slips) lines.push(`  ${s.id}  ${s.action} on ${s.site}${s.path ?? ""}  ${s.uses_left} of ${s.uses} uses left  until ${s.expires_at}${notes.has(s.id) ? `  note: ${JSON.stringify(notes.get(s.id))}` : ""}`);
      if (r.pages > 1) lines.push(`Page ${r.page} of ${r.pages}. Use --page N for more.`);
      console.log(values.text ? lines.join("\n") : json(r));
      return 0;
    }
    throw new Error("Usage: tiresias slip grant --action submit_form --site <origin> [--path /p] [--until <date> | --for 7d] [--uses N] [--note text] | slip list | slip revoke <id> | slip revoke --all");
  }
  if (cmd === "form") {
    // W-04. --set name=value (repeat a name for several checkbox or multiple-select values); --unset name
    // chooses nothing for a checkbox group or multiple select (an empty list).
    const [, sub, formUrl] = positionals;
    if ((sub !== "preview" && sub !== "submit") || !formUrl || values.form === undefined)
      throw new Error("Usage: tiresias form preview <url> --form N [--set name=value ...] [--unset name] | form submit <url> --form N [--set ...] --preview <hash>");
    if (!/^\d{1,3}$/.test(values.form)) throw new Error("--form must be a whole number from 1 to 20");
    const vals: Record<string, string[]> = Object.create(null);
    for (const kv of values.set ?? []) {
      const i = kv.indexOf("=");
      if (i < 1) throw new Error("--set takes name=value");
      (vals[kv.slice(0, i)] ??= []).push(kv.slice(i + 1));
    }
    for (const n of values.unset ?? []) {
      if (vals[n]?.length) throw new Error("--unset and --set name the same field");
      vals[n] = [];
    }
    // One value is passed as a string, so a plain field gets a string; repeated names stay a list.
    const v = Object.fromEntries(Object.entries(vals).map(([k, x]) => [k, x.length === 1 ? x[0] : x]));
    const r = sub === "preview" ? await engine.formPreview(formUrl, Number(values.form), v, ctx) : await engine.formSubmit(formUrl, Number(values.form), v, values.preview, ctx);
    printEnvelope(r, values.text);
    return exitFor(r.status);
  }
  if (cmd === "handoffs") {
    const r = engine.handoffList(page);
    printReply(r, values.text);
    return 0;
  }
  if (cmd === "resume") {
    if (!arg) throw new Error("Usage: tiresias resume <ticket> [--from-file <path>]");
    const r = await engine.resume(arg, values["from-file"] === undefined ? undefined : { file: values["from-file"] }, ctx);
    printEnvelope(r, values.text);
    return exitFor(r.status);
  }
  if (cmd === "watch") {
    const r = await engine.watch(ctx, page);
    console.log(values.text ? watchText(r) : json(r));
    return 0;
  }
  if (cmd === "scanner") {
    // W-21: the owner's own scanner hook. Only here, from the command line (or by editing config.json):
    // nothing in the MCP server reads, sets, changes or skips it.
    const scanner = await import("./scanner.js");
    const { loadScanner } = await import("./config.js");
    if (arg === "set") {
      const term = tokens.find((t) => t.kind === "option-terminator");
      const command = term ? tokens.filter((t) => t.kind === "positional" && t.index > term.index).map((t) => (t as { value: string }).value) : [];
      if (!command.length) throw new Error("Usage: tiresias scanner set [--timeout 10] [--send-file] -- /full/path/to/program [args...]");
      const cfg = scanner.setScanner(command, { timeout: values.timeout, sendFile: values["send-file"], confirm: values.confirm }, sessionPriv);
      const msg = `Scanner set: ${cfg.command[0]}${cfg.command.length > 1 ? ` with ${cfg.command.length - 1} argument(s)` : ""}, up to ${cfg.timeout_seconds} s per file, ${cfg.send_file ? "and it is handed the file itself (a quarantine copy, deleted after)" : "fingerprint only (not the file)"}. It runs on every high-risk file warning.`;
      console.log(values.text ? msg : json({ status: "ok", message: msg, scanner: cfg }));
      return 0;
    }
    if (arg === "show") {
      const cfg = loadScanner();
      const msg = cfg ? `Scanner: ${JSON.stringify(cfg.command)}, ${cfg.timeout_seconds} s, send_file ${cfg.send_file}.` : "No scanner is set. Tiresias includes none; set your own with: tiresias scanner set -- /full/path/to/program [args...]";
      console.log(values.text ? msg : json({ status: "ok", message: msg, scanner: cfg }));
      return 0;
    }
    if (arg === "off") {
      const was = scanner.clearScanner(sessionPriv);
      const msg = was ? "Scanner removed. File warnings are no longer checked by it." : "No scanner was set.";
      console.log(values.text ? msg : json({ status: "ok", message: msg }));
      return 0;
    }
    throw new Error("Usage: tiresias scanner set [--timeout 10] [--send-file] -- /full/path/to/program [args...] | scanner show | scanner off");
  }
  if (cmd === "saved") {
    // W-28 (v0.8): saved snapshots. Owner's commands: nothing in the MCP server lists, verifies or deletes them.
    const sv = await import("./saved.js");
    const [, sub = "list", id] = positionals;
    if (sub === "list") {
      const r = sv.list(page);
      const L = [r.message, ...r.saved.map((i) => `  ${i.id.slice(0, 16)}  ${i.saved_at ?? "(damaged)"}  ${i.fingerprint_only ? "fingerprint only" : `${i.bytes} bytes${i.rendered ? ", rendered" : ""}`}, ${i.receipts} receipts  <${r.untrusted_content.urls.find((u) => u.id === i.id)?.final_url ?? ""}>`)];
      if (r.pages > 1) L.push(`Page ${r.page} of ${r.pages}. Use --page N for more.`);
      console.log(values.text ? L.join("\n") : json(r));
      return 0;
    }
    if (sub === "show" && id) {
      const r = sv.show(id);
      console.log(values.text ? `${r.message}\nFolder: ${r.folder}${r.untrusted_content ? `\n${JSON.stringify(r.untrusted_content.manifest, null, 2)}` : ""}` : json(r));
      return 0;
    }
    if (sub === "verify" && (id || values.all)) {
      const ids = values.all ? allIds(sv) : [id!];
      const results = [];
      for (const x of ids) results.push(await sv.verify(x));
      const ok = results.every((r) => r.ok);
      const msg = values.all ? `${results.filter((r) => r.ok).length} of ${results.length} snapshots verified.` : results[0].message;
      const r = { ...(values.all ? { message: msg, results } : results[0]), status: ok ? "ok" : "error", ...(!ok ? { reason: "verification_failed" } : {}) };
      printReply(r, values.text, [msg, ...(values.all ? results.map((r) => `  ${r.id.slice(0, 16)}  ${r.ok ? "verified" : r.message}`) : [])].join("\n"));
      return ok ? 0 : 1;
    }
    if (sub === "delete" && (id || values.all)) {
      if (sessionPriv) throw new Error("Private mode: nothing in the store is changed, so no snapshot is deleted.");
      const r = sv.remove(values.all ? "all" : id!);
      console.log(values.text ? r.message : json(r));
      return 0;
    }
    throw new Error("Usage: tiresias saved [list] [--page N] | saved show <id> | saved verify <id> | --all | saved delete <id> | --all");
  }
  if (cmd === "anchor") {
    // W-08 (v0.8): owner's commands only (nothing in the MCP server anchors, proves or changes the setting).
    const an = await import("./anchor.js");
    const sub = arg ?? "run";
    if ((sub === "run" || sub === "upgrade") && sessionPriv) throw new Error("Private mode: nothing is anchored, and nothing is sent to a calendar.");
    if (sub === "run") {
      const r = await an.run();
      printReply(r, values.text);
      return r.status === "ok" ? 0 : 1;
    }
    if (sub === "upgrade") {
      const r = await an.upgrade();
      console.log(values.text ? r.message : json(r));
      return 0;
    }
    if (sub === "status") {
      const r = await an.status(page);
      const L = [r.message, `Calendars: ${r.calendars.join(", ")}`, ...r.batches.map((b) => `  ${b.id.slice(0, 16)}  ${b.created_at}  ${b.leaves} leaves  ${b.status === "complete" ? `in Bitcoin block ${b.bitcoin.join(", ")}` : "pending"}`)];
      if (r.pages > 1) L.push(`Page ${r.page} of ${r.pages}. Use --page N for more.`);
      console.log(values.text ? L.join("\n") : json(r));
      return 0;
    }
    throw new Error("Usage: tiresias anchor | anchor status [--page N] | anchor upgrade");
  }
  if (cmd === "receipts" && (arg === "prove" || arg === "verify")) {
    // W-08 (v0.8): proofs. Owner's commands; prove reads this profile's store, verify reads only the bundle file.
    const an = await import("./anchor.js");
    const target = positionals[2];
    if (!target) throw new Error("Usage: tiresias receipts prove <id> [--out <folder>] | receipts verify <bundle file>");
    if (arg === "prove") {
      const bd = await an.prove(target);
      const msg = an.proveText(bd);
      if (values.out !== undefined) {
        const files = an.writeBundle(bd, values.out, !!sessionPriv);
        console.log(values.text ? `${msg}\nWritten:\n${files.map((f) => `  ${f}`).join("\n")}\nCheck it with: tiresias receipts verify ${files[0]}${bd.batch.status === "complete" ? `  (or the official tool: ots verify ${files[files.length - 1]})` : ""}` : json({ status: "ok", message: msg, files }));
      } else console.log(values.text ? msg : json({ status: "ok", message: msg, notice: (await import("./types.js")).NOTICE, untrusted_content: { bundle: bd } }));
      return 0;
    }
    const r = an.verifyBundle(target);
    printReply({ ...r, status: r.offline_ok ? "ok" : "error", ...(!r.offline_ok ? { reason: "verification_failed" } : {}) }, values.text);
    // 1: a check failed. 2: the offline checks pass but the proof is not finished (the Bitcoin header step is outside
    // Tiresias, or it is still pending), never 0: an offline check alone proves nothing (Codex v0.8 anchor round 1).
    return r.offline_ok ? 2 : 1;
  }
  if (cmd === "translator") {
    // W-26 (v0.7): the owner's own translation tool. Only here, from the command line (or by editing
    // config.json): nothing in the MCP server reads, sets or changes it.
    const tr = await import("./translate.js");
    const { loadTranslator } = await import("./config.js");
    if (arg === "set") {
      const term = tokens.find((t) => t.kind === "option-terminator");
      const command = term ? tokens.filter((t) => t.kind === "positional" && t.index > term.index).map((t) => (t as { value: string }).value) : [];
      if (!command.length) throw new Error("Usage: tiresias translator set [--timeout 20] -- /full/path/to/program [args...]");
      const cfg = tr.setTranslator(command, { timeout: values.timeout, confirm: values.confirm }, sessionPriv);
      const msg = `Translator set: ${cfg.command[0]}${cfg.command.length > 1 ? ` with ${cfg.command.length - 1} argument(s)` : ""}, up to ${cfg.timeout_seconds} s per read. It runs only when a read asks for a translation, with the text on standard input and the source and target languages as its last two arguments.`;
      console.log(values.text ? msg : json({ status: "ok", message: msg, translator: cfg }));
      return 0;
    }
    if (arg === "show") {
      const cfg = loadTranslator();
      const msg = cfg ? `Translator: ${JSON.stringify(cfg.command)}, ${cfg.timeout_seconds} s.` : "No translator is set. Tiresias includes none; set your own with: tiresias translator set -- /full/path/to/program [args...]";
      console.log(values.text ? msg : json({ status: "ok", message: msg, translator: cfg }));
      return 0;
    }
    if (arg === "off") {
      const was = tr.clearTranslator(sessionPriv);
      const msg = was ? "Translator removed. Reads no longer offer translations." : "No translator was set.";
      console.log(values.text ? msg : json({ status: "ok", message: msg }));
      return 0;
    }
    throw new Error("Usage: tiresias translator set [--timeout 20] -- /full/path/to/program [args...] | translator show | translator off");
  }
  if (cmd === "settings") {
    // W-29 (v0.6): the settings page, CLI only: nothing in the MCP server reads or changes a setting.
    const r = (await import("./settings.js")).command(positionals.slice(1), sessionPriv, { confirm: values.confirm });
    noticeLines = null; // look again: this command may have just changed what the notice says
    if (r.code) console.error(values.text ? r.text : json(r.reply, 0));
    else console.log(values.text ? r.text : json(r.reply));
    return r.code;
  }
  if (cmd === "safety") {
    if (arg === "status") {
      const r = engine.safetyStatus();
      console.log(values.text ? `${r.message}\nList: ${r.list.state}${r.list.entries !== undefined ? `, ${r.list.entries} domains, confirmed ${r.list.verified_at}` : ""}\nWeb Risk: ${r.web_risk.configured ? `set up (${r.web_risk.from})` : "not set up"}` : json(r));
      return 0;
    }
    if (arg === "update") {
      if (values.private) throw new Error("Private mode: the list is not downloaded or saved (a private session creates nothing).");
      const r = await engine.safetyUpdate();
      printReply(r, values.text);
      return r.status === "ok" ? 0 : 1;
    }
    throw new Error("Usage: tiresias safety status | safety update");
  }
  if (cmd === "keys") {
    const keys = await import("./keys.js");
    const sub = arg;
    if (sub === "init") {
      if (sessionPriv) throw new Error("Private mode: nothing is written, so no key is made.");
      const r = await keys.initKey(values.force);
      console.log(json({ message: r.replaced ? "Replaced your signing key." : "Made your signing key.", private_key_file: r.file, keyid: r.keyid, public_jwk: r.public_jwk, directory: r.directory, next: 'Host "directory" at /.well-known/http-message-signatures-directory on your site, and set "signature_agent" in config.json. The private key was not printed.' }));
    } else if (sub === "show" || sub === "directory") {
      const jwk = keys.readPrivateJwk();
      if (!jwk) throw new Error("No signing key yet. Run: tiresias keys init");
      const info = await keys.publicInfo(jwk);
      if (sub === "directory") console.log(JSON.stringify(info.directory, null, 2)); // the exact JSON to host: nothing added
      else {
        let agent: string | null = null;
        try {
          agent = (await import("./config.js")).loadSigningConfig()?.signature_agent ?? null;
        } catch (e) {
          agent = `(config.json problem: ${(e as Error).message})`;
        }
        console.log(json({ public_jwk: info.public_jwk, keyid: info.keyid, directory: info.directory, signature_agent: agent, signing: agent && !agent.startsWith("(") ? "on" : "off (set signature_agent in config.json)" }));
      }
    } else if (sub === "sign-directory") {
      if (sessionPriv && values.out !== undefined) throw new Error("Private mode: nothing is written, so no files are made. Run it without --out to print the response.");
      let host = values.host;
      if (!host) {
        const agent = (await import("./config.js")).loadSigningConfig()?.signature_agent;
        if (!agent) throw new Error("Give --host (for example raibit.ai), or set signature_agent in config.json.");
        host = new URL(agent).host;
      }
      const days = values.days === undefined ? 30 : /^\d+$/.test(values.days) ? Number(values.days) : NaN;
      const r = await keys.signDirectory({ host, days });
      const reminder = `These signatures stop working on ${r.expires_at}. Run this command again and re-upload before then.`;
      if (values.out !== undefined) {
        const fsm = await import("node:fs");
        const pathm = await import("node:path");
        const folder = fsm.realpathSync.native(values.out);
        if (!fsm.statSync(folder).isDirectory()) throw new Error(`"${values.out}" is not a folder.`);
        const files: Record<string, string> = {
          "http-message-signatures-directory.json": r.body,
          "http-message-signatures-directory.headers.txt": Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join("\n") + "\n",
        };
        for (const [name, content] of Object.entries(files)) {
          const target = pathm.join(folder, name);
          const tmp = `${target}.${process.pid}.tmp`;
          fsm.writeFileSync(tmp, content, { flag: "wx", mode: 0o644 });
          fsm.renameSync(tmp, target);
        }
        console.log(json({ host: r.host, serve_at: `https://${r.host}${r.path}`, files: Object.keys(files).map((n) => pathm.join(folder, n)), expires_at: r.expires_at, reminder }));
      } else console.log(json({ host: r.host, serve_at: `https://${r.host}${r.path}`, created_at: r.created_at, expires_at: r.expires_at, body: JSON.parse(r.body), headers: r.headers, reminder }));
    } else throw new Error("Usage: tiresias keys init [--force] | keys show | keys directory | keys sign-directory");
    return 0;
  }
  if (cmd === "clear") {
    const rel = values["older-than"] === undefined ? undefined : /^(\d+)d$/i.exec(values["older-than"].trim());
    if (values["older-than"] !== undefined && (!rel || Number(rel[1]) < 1)) throw new Error("--older-than takes whole days, like 30d");
    if (rel && values.all) throw new Error("Use --older-than or --all, not both.");
    const olderThanMs = rel ? Number(rel[1]) * 86_400_000 : undefined;
    if (sessionPriv && !values["dry-run"]) throw new Error("Private mode: nothing in the store is changed, so nothing is cleared. Use --dry-run to see what clear would remove.");
    const r = await clearStore({ limits: loadLimits(), olderThanMs, all: values.all, dryRun: values["dry-run"] });
    console.log(values.text ? r.summary : json(r));
    return r.not_removed ? 1 : 0; // v0.6: something clear meant to remove is still there
  }
  let out: unknown;
  if (cmd === "read") {
    const section = values.section === undefined ? undefined : Number(values.section);
    if (section !== undefined && !Number.isInteger(section)) throw new Error("--section must be a whole number");
    // W-26 (v0.7): --translate takes a plain language tag only (translate.ts checks it again).
    if (values.translate !== undefined && !(await import("./translate.js")).parseTarget(values.translate)) throw new Error("--translate takes a language tag like en, es or pt-br.");
    out = noteCliRead(await engine.read(need(), { question: values.question, section, page, changes: values.changes, fresh: values.fresh, translate: values.translate, render: values.render, save: values.save }, ctx)); // W-24: a tab
  } else if (cmd === "doors") out = await engine.doors(need(), ctx);
  else if (cmd === "check") out = await engine.check(need(), ctx, { page, fresh: values.fresh });
  else if (cmd === "receipts") out = receiptsEnvelope(values.url ?? arg ?? "", await engine.queryReceipts({ url: values.url ?? arg, since: values.since, page }));
  else if (cmd === "history") out = historyEnvelope(await engine.queryHistory({ since: values.since, site: values.site, agent: values.agent, page }));
  else {
    throw new Error(`Unknown command "${cmd.slice(0, 40)}". Run tiresias --help for the list.`); // one JSON line (round 81)
  }
  const isEnv = typeof out === "object" && out !== null && "notice" in out;
  if (isEnv) printEnvelope(out as Envelope, values.text);
  else console.log(json(out));
  return isEnv ? exitFor((out as Envelope).status) : 0;
}

// W-30 (v0.6): the door checks a read started in the background finish (or end by their own deadline)
// before the process exits, so no request is cut off half-way and nothing is left behind.
main().then(
  async (code) => {
    if (code < 0) return;
    // W-32 (v0.9): a --text reply ends with the settings notice (a JSON reply carries it as settings_notice).
    const n = process.argv.includes("--text") ? currentNotice() : undefined;
    if (n) (code === 0 ? console.log : console.error)(`\nSettings notice:\n${n.map((l) => `  ${l}`).join("\n")}`);
    await drainForExit();
    process.exit(code);
  },
  async (e) => {
    // parseArgs can fail before the profile was selected. Recover only that option for the error's
    // notice, using the same parser (so program arguments after -- cannot select a profile).
    if (!profileSelected && process.argv[2] !== "profile") {
      try {
        const { values } = parseArgs({ allowPositionals: true, strict: false, options: { profile: { type: "string" } } });
        selectProfile(typeof values.profile === "string" ? values.profile : undefined);
      } catch {
        // An invalid profile has no readable notice; keep the original command error.
      }
    }
    // v0.5.1: one JSON line on standard error, unless --text asked for plain words.
    // A mistyped option gets plain words and where to look, not Node's advice about positional arguments.
    const opt = (e as { code?: string }).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? /'([^']{1,60})'/.exec((e as Error).message)?.[1] : undefined;
    const sub = process.argv[2] && /^[a-z]{1,20}$/.test(process.argv[2]) ? process.argv[2] : "<command>";
    const msg = opt !== undefined ? `Unknown option ${JSON.stringify(opt)}. Run tiresias ${sub} --help for the options it takes.` : (e as Error).message;
    const n = process.argv.includes("--text") ? currentNotice() : undefined;
    console.error(process.argv.includes("--text") ? msg + (n ? `\n\nSettings notice:\n${n.map((l) => `  ${l}`).join("\n")}` : "") : json({ status: "error", message: msg }, 0));
    await drainForExit();
    process.exit(1);
  },
);
