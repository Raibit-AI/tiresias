// SPDX-License-Identifier: Apache-2.0
// W-24 (v0.6): tabs and back/forward for agents. A working set of this session's reads, numbered like
// tabs, plus a navigation stack, so an agent can say "tab 3" or "back" and get the cached copy (W-03) with
// its receipts, with NO request to the site. Decisions: docs/v0.6/browse.md.
//
// A session:
//   - MCP: the life of one MCP server process (one client). Its tabs live in MEMORY only and are gone when
//     the server stops. Nothing about them is written to disk.
//   - CLI: every command is its own process, so the CLI's session is one small file per profile,
//     tabs/cli.json (mode 0600, written atomically). It ends after IDLE_MS without use (the next command
//     starts an empty one) or with `tiresias tabs close --all`; `clear --all` removes it.
// Only a non-private `read` that answered ok or unchanged opens or moves to a tab. A private call adds
// nothing, reads no tab, and never touches the CLI's file: a private read is not noted, and opening a
// tab (which reads the page cache) is refused in private mode.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildContent, paginate, recordReceipts, stampLanguage } from "./pipeline.js";
import { env, errorEnv } from "./envelope.js";
import type { CacheEntry } from "./pagecache.js";
import { cachePath, isPrivate, readJson, readOwnedFile, rmRegular, subDir, writeJson } from "./store.js";
import { enforceLimits } from "./cleanup.js";
import { INLINE_MAX } from "./sandbox.js";
import { acquire, held, release, type Owned } from "./browselock.js";
import { throwIfCancelled, withSignal } from "./safety.js";
import { SiteRefused, assertSiteAllowed } from "./sites.js";
import { PARSER_VERSION, MAX_URL, NOTICE, jsonBytes, type Envelope, type ParsedPage, type Receipt } from "./types.js";

// ---- caps ----
export const MAX_TABS = 50; // open tabs per session; past it the least recently used tab is closed
export const MAX_STACK = 100; // entries in the back/forward stack; past it the oldest entry goes
export const MAX_TITLE = 200; // a tab's title (web text) is kept cut to this many characters
export const IDLE_MS = 12 * 3_600_000; // the CLI session ends after 12 hours without use
export const MAX_FILE = 256 * 1024; // the CLI session file: a bigger one is not read (a fresh session starts)
export const LIST_BUDGET = 40_000; // one page of the tab list, like history pages
const TAB_URL_BYTES = MAX_URL; // a longer URL is never shortened: it gets no tab

export interface Tab {
  n: number; // the tab's number: given once, never reused in the session
  url: string; // the URL read (normalized, no fragment): the page cache key
  title?: string; // the page's title when last read (web text, cut)
  fetched_at: string; // the cached copy's own time when this session last read it
  opened_at: string;
  used_at: string;
}
export interface TabState {
  v: 1;
  id: string; // random, made when the session starts: a reset session is a different one
  rev: number; // counts every saved change, so a slow call can tell the session moved under it
  started_at: string;
  used_at: string;
  next: number; // the next tab number
  tabs: Tab[];
  stack: number[]; // tab numbers, oldest first
  pos: number; // index in stack of the current entry (-1 when empty)
}

export const emptyState = (now = Date.now()): TabState => {
  const t = new Date(now).toISOString();
  return { v: 1, id: randomBytes(8).toString("hex"), rev: 0, started_at: t, used_at: t, next: 1, tabs: [], stack: [], pos: -1 };
};

// ---- validating a state read back from disk (the file may be damaged or planted) ----
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const isIso = (x: unknown): x is string => typeof x === "string" && ISO.test(x) && !Number.isNaN(Date.parse(x));
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 1;
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x);
function validTab(x: unknown): Tab | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (!isNum(o.n) || typeof o.url !== "string" || !o.url || jsonBytes(o.url) - 2 > TAB_URL_BYTES) return null;
  if (!/^https?:\/\//i.test(o.url)) return null;
  if (!isIso(o.fetched_at) || !isIso(o.opened_at) || !isIso(o.used_at)) return null;
  if (o.title !== undefined && typeof o.title !== "string") return null;
  return { n: o.n, url: o.url, ...(typeof o.title === "string" ? { title: o.title.slice(0, MAX_TITLE) } : {}), fetched_at: o.fetched_at, opened_at: o.opened_at, used_at: o.used_at };
}
export function validState(x: unknown): TabState | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (o.v !== 1 || typeof o.id !== "string" || !/^[0-9a-f]{16}$/.test(o.id) || !isInt(o.rev) || (o.rev as number) < 0 || !isIso(o.started_at) || !isIso(o.used_at) || !isNum(o.next)) return null;
  if (!Array.isArray(o.tabs) || o.tabs.length > MAX_TABS || !Array.isArray(o.stack) || o.stack.length > MAX_STACK) return null;
  const tabs: Tab[] = [];
  const seenN = new Set<number>();
  const seenU = new Set<string>();
  for (const t of o.tabs) {
    const v = validTab(t);
    if (!v || seenN.has(v.n) || seenU.has(v.url) || v.n >= o.next) return null;
    seenN.add(v.n);
    seenU.add(v.url);
    tabs.push(v);
  }
  if (!o.stack.every((n) => isNum(n) && seenN.has(n))) return null;
  const stack = o.stack as number[];
  const pos = o.pos;
  if (typeof pos !== "number" || !Number.isSafeInteger(pos) || (stack.length ? pos < 0 || pos >= stack.length : pos !== -1)) return null;
  return { v: 1, id: o.id as string, rev: o.rev as number, started_at: o.started_at, used_at: o.used_at, next: o.next, tabs, stack: [...stack], pos };
}

// ---- pure operations on a state ----

// A read happened: open a tab for its URL (or reuse the URL's tab) and move the stack to it, dropping
// anything forward of the current entry, like a browser.
export function noteRead(s: TabState, read: { url: string; title?: string; fetched_at: string }, now = Date.now()): Tab | null {
  if (jsonBytes(read.url) - 2 > TAB_URL_BYTES || !/^https?:\/\//i.test(read.url) || !isIso(read.fetched_at)) return null;
  const t = new Date(now).toISOString();
  let tab = s.tabs.find((x) => x.url === read.url);
  if (tab) {
    tab.used_at = t;
    tab.fetched_at = read.fetched_at;
    if (read.title !== undefined) tab.title = read.title.slice(0, MAX_TITLE);
  } else {
    tab = { n: s.next++, url: read.url, ...(read.title !== undefined ? { title: read.title.slice(0, MAX_TITLE) } : {}), fetched_at: read.fetched_at, opened_at: t, used_at: t };
    s.tabs.push(tab);
  }
  if (s.stack[s.pos] !== tab.n) {
    s.stack = s.stack.slice(0, s.pos + 1);
    s.stack.push(tab.n);
    s.pos = s.stack.length - 1;
    if (s.stack.length > MAX_STACK) {
      const drop = s.stack.length - MAX_STACK;
      s.stack = s.stack.slice(drop);
      s.pos -= drop;
    }
  }
  // Past the cap the least recently used tab closes (never the one just read).
  while (s.tabs.length > MAX_TABS) {
    const lru = s.tabs.filter((x) => x.n !== tab!.n).sort((a, b) => a.used_at.localeCompare(b.used_at) || a.n - b.n)[0];
    closeTab(s, lru.n);
  }
  s.used_at = t;
  return tab;
}

// Close one tab: it leaves the list and the stack (the current position follows what is left).
export function closeTab(s: TabState, n: number): boolean {
  const i = s.tabs.findIndex((x) => x.n === n);
  if (i < 0) return false;
  s.tabs.splice(i, 1);
  const cur = s.pos >= 0 ? s.pos : -1;
  const kept: number[] = [];
  let pos = -1;
  s.stack.forEach((x, k) => {
    if (x === n) return;
    // Two neighbours that become equal after the removal collapse into one entry.
    if (kept.length && kept[kept.length - 1] === x) {
      if (k <= cur) pos = kept.length - 1;
      return;
    }
    kept.push(x);
    if (k <= cur) pos = kept.length - 1;
  });
  s.stack = kept;
  s.pos = kept.length ? Math.max(0, Math.min(pos, kept.length - 1)) : -1;
  return true;
}

// ---- where a session's state lives ----
export interface TabStore {
  readonly kind: "memory" | "disk";
  load(): TabState; // never throws: damaged or missing is an empty session
  save(s: TabState): void; // may throw (a store error); callers decide
  // Run one load-change-save as a whole, so two processes never hand out the same tab number.
  transact<T>(fn: () => T): T;
}

// MCP: one server, one session, in memory only.
export class MemoryTabs implements TabStore {
  readonly kind = "memory" as const;
  private state = emptyState();
  load(): TabState {
    return structuredClone(this.state);
  }
  save(s: TabState): void {
    this.state = structuredClone({ ...s, rev: s.rev + 1 });
  }
  transact<T>(fn: () => T): T {
    return fn(); // one process, and every change is synchronous
  }
}

// CLI: tabs/cli.json in the profile's folder. Read with the store's checks (a real folder owned by this
// user, never a link; the file never followed as a link, owned by this user, at most MAX_FILE bytes).
export const TABS_DIR = "tabs";
export const CLI_FILE = "cli.json";
export class DiskTabs implements TabStore {
  readonly kind = "disk" as const;
  constructor(private readonly now: () => number = Date.now) {}
  load(): TabState {
    try {
      const d = subDir(TABS_DIR, false);
      if (!d) return emptyState(this.now());
      const raw = readOwnedFile(path.join(d, CLI_FILE), MAX_FILE);
      if (raw === null) return emptyState(this.now());
      const s = validState(JSON.parse(raw));
      if (!s || this.now() - Date.parse(s.used_at) > IDLE_MS || Date.parse(s.used_at) > this.now() + 60_000) return emptyState(this.now());
      return s;
    } catch {
      return emptyState(this.now()); // damaged, too big, a link, someone else's: a fresh session
    }
  }
  save(s: TabState): void {
    const d = subDir(TABS_DIR, true)!; // refuses in private mode before anything is made (store.ts)
    // Inside a transaction the lock must still be ours right before the write (Codex browse round 3).
    if (this.owned && !held(this.owned)) throw new Error(BUSY);
    writeJson(path.join(d, CLI_FILE), { ...s, rev: s.rev + 1 });
  }
  // Codex browse round 1: an exclusive lock file next to the session file (lockfile.ts) around the whole
  // load-change-save, so concurrent CLI commands never give one number to two pages. A lock that cannot be
  // taken within a second is an error: the change is not made, rather than made unsafely.
  transact<T>(fn: () => T): T {
    if (isPrivate()) throw new Error(PRIVATE_TABS);
    const d = subDir(TABS_DIR, true)!;
    const f = path.join(d, CLI_FILE);
    const o = acquire(f);
    if (!o) throw new Error(BUSY);
    this.owned = o;
    try {
      return fn();
    } finally {
      this.owned = null;
      release(o);
    }
  }
  private owned: Owned | null = null;
  // `tabs close --all`: the file goes. Never follows a link.
  remove(): boolean {
    if (this.owned && !held(this.owned)) throw new Error(BUSY);
    const d = subDir(TABS_DIR, false);
    if (!d) return false;
    const f = path.join(d, CLI_FILE);
    try {
      if (!fs.lstatSync(f).isFile()) return false;
    } catch {
      return false;
    }
    fs.rmSync(f, { force: true });
    return true;
  }
}

// ---- noting a read (called by the MCP read tool and the CLI read command) ----

// What a read reply adds when it opened or moved to a tab: Tiresias-made numbers only.
export type TabNote = { number: number; tabs: number };

export function noteReply(store: TabStore, e: Envelope): TabNote | undefined {
  // Private calls leave no trace: not even the memory of an MCP session (section 9, 2026-10-16).
  if (e.private || isPrivate()) return undefined;
  if (e.status !== "ok" && e.status !== "unchanged") return undefined;
  if (e.source === "provided_by_person") return undefined; // never cached, so nothing to re-show
  const uc = (e.untrusted_content ?? {}) as Record<string, unknown>;
  try {
    return store.transact(() => {
      const s = store.load();
      const title = typeof uc.title === "string" ? uc.title : undefined;
      const tab = noteRead(s, { url: e.url, title, fetched_at: e.fetched_at });
      if (!tab) return undefined;
      store.save(s);
      return { number: tab.n, tabs: s.tabs.length };
    });
  } catch (err) {
    console.error(`Could not keep the tab: ${(err as Error).message}`); // a tab never fails the read
    return undefined;
  }
}

// ---- the replies ----

export const PRIVATE_TABS = "Private mode: tabs are not opened, moved or closed, and no cached copy is read, so a private call leaves no trace. Read the page instead.";
export const NO_TABS = "No tabs in this session yet. Every read (not private) opens a tab.";
export const MOVED = "The tab session changed while this page was being shown (another call read, moved or closed tabs), so nothing moved and nothing was logged. Try again.";
export const BUSY = "The tab session is busy (another tiresias command holds it). Try again. If no other tiresias command is running, the owner can delete tabs/cli.json.lock in the store.";
export const GONE =
  "The cached copy for this tab is gone: cleared, expired, made by an older reader, or the site asked that it not be kept (no-store). Nothing was sent to the site. Read the URL again (it is in untrusted_content.tab_url) to see the page; it keeps its tab number.";
const NOT_SENT = "Nothing was sent to the site.";
export const TOO_LARGE =
  "This page is larger than a tab shows (over 20,000 sections, 200,000 blocks or 10,000 links, a block over 1 MB, or a very long URL), so it was not shown from the cache. Nothing was sent to the site. Read the URL again (it is in untrusted_content.tab_url) to see it.";
// Round 10: the promise is about the session and the receipts log; the store's once-a-day trim may already
// have run before the cancel arrived.
export const CANCELLED = "The call was cancelled. No tab moved and nothing was logged.";
const CALL_MS = 60_000; // the same overall deadline as every other call (envelope.ts guarded)

// The fixed shape a tab reply adds at the top level. Numbers and fixed codes only.
export interface TabTop {
  number: number;
  tabs: number;
  position?: number; // back and forward only: the 1-based place they moved to in the back/forward stack
  stack: number; // entries in the stack
  // The kept copy against the one this session read, by the copy's own time: the same, a later one, an
  // earlier one (a slower writer finished last, or the cache was put back), or none.
  copy: "same" | "newer" | "older" | "gone" | "too_large";
  age_seconds?: number; // how old the copy is now (from its fetched_at)
}
export type TabEnvelope = Envelope & { tab?: TabTop };

const tabUc = (t: Tab) => ({ tab_url: t.url });

// ---- what of a cached entry may reach the top level (Codex browse round 1) ----
// The cache folder could be edited, so every value a tab reply puts OUTSIDE untrusted_content is checked
// against Tiresias's own fixed lists here; anything else makes the copy unusable ("gone").
const DOORS = new Set(["mcp", "api", "feed", "structured", "text", "none"]);
const DETAILS = new Set(["llms.txt", "llms-full.txt", "markdown", "html", "html+json-ld", "text", "json", "pdf"]);
const FLAG_TYPES = new Set([
  "hidden_text", "html_comment", "ai_directed_instruction", "type_mismatch", "double_extension", "script", "svg", "calendar", "contact",
  "csv_formulas", "pdf_javascript", "pdf_attachments", "pdf_launch", "invisible_characters",
]);
const count = (x: unknown) => x === undefined || (typeof x === "number" && Number.isSafeInteger(x) && x >= 0);
export function topSafe(e: CacheEntry): boolean {
  const p = e.parsed as unknown as Record<string, unknown>;
  if (!DOORS.has(e.door as string) || !DETAILS.has(e.door_detail as string)) return false;
  if (!Array.isArray(p.flags) || !p.flags.every((f) => !!f && typeof f === "object" && FLAG_TYPES.has((f as { type?: unknown }).type as string))) return false;
  const fd = p.flags_dropped;
  if (fd !== undefined && (!fd || typeof fd !== "object" || Array.isArray(fd) || !Object.entries(fd).every(([k, v]) => FLAG_TYPES.has(k) && count(v)))) return false;
  if (p.forms !== undefined && !Array.isArray(p.forms)) return false;
  return count(p.forms_omitted) && count(p.csv_formulas);
}

// Codex browse rounds 2, 4 and 5: the whole cached page is checked before any work is done on it, in two
// ways. Its SHAPE (every section, block, link marker and link of the right types) must be right, or the copy
// is unusable ("gone"). Its SIZE must fit what a tab is willing to build on the main thread, or the tab says
// it is too large ("too_large", with fixed text saying to read the page again), never that it is gone: a
// tab's outline builds a receipt for every section, so the work grows with sections times the URL's length,
// and that is bounded here rather than left to a page loaded from disk. The work estimate that decides
// whether a question search runs in the worker (searchable_chars) is recomputed from the checked page,
// counts structure, and is never under the inline limit, so such a search always runs in the worker.
export const PAGE_LIMITS = {
  sections: 20_000, blocks: 200_000, links: 10_000, chars: 32 * 1024 * 1024, blockChars: 1024 * 1024, marks: 100_000,
  heading: 4_096, title: 4_096, linkText: 4_096, url: 8_192, sideBytes: 4 * 1024 * 1024, receiptWork: 64 * 1024 * 1024,
};
const isStr = (x: unknown, n = Infinity): x is string => typeof x === "string" && x.length <= n;
type Checked = { page: ParsedPage } | { bad: "gone" | "too_large" };
export function checkPage(p: unknown, finalUrl = ""): Checked {
  const gone = { bad: "gone" as const };
  const big = { bad: "too_large" as const };
  if (!p || typeof p !== "object" || Array.isArray(p)) return gone;
  const o = p as Record<string, unknown>;
  const L = PAGE_LIMITS;
  if (!isStr(o.title) || !Array.isArray(o.sections) || !Array.isArray(o.links)) return gone;
  if (o.title.length > L.title || o.sections.length > L.sections || o.links.length > L.links) return big;
  // Every section's outline entry carries receipts that repeat the URL: bound that work before doing it.
  if (o.sections.length * (finalUrl.length + 600) > L.receiptWork) return big;
  let blocks = 0;
  let chars = 0;
  for (const sec of o.sections) {
    if (!sec || typeof sec !== "object") return gone;
    const x = sec as Record<string, unknown>;
    if (!isInt(x.n) || !isInt(x.level) || !isStr(x.heading) || !Array.isArray(x.blocks)) return gone;
    if (x.generated !== undefined && x.generated !== true) return gone;
    if (x.heading.length > L.heading) return big;
    chars += x.heading.length;
    for (const b of x.blocks) {
      if (!b || typeof b !== "object") return gone;
      const bb = b as Record<string, unknown>;
      if (!isStr(bb.text) || !Array.isArray(bb.marks)) return gone;
      if (++blocks > L.blocks || bb.text.length > L.blockChars || bb.marks.length > L.marks) return big;
      if (!bb.marks.every((m) => Array.isArray(m) && m.length === 2 && isInt(m[0]) && isInt(m[1]))) return gone;
      chars += bb.text.length;
    }
    if (chars > L.chars) return big;
  }
  for (const l of o.links) {
    if (!l || typeof l !== "object") return gone;
    const x = l as Record<string, unknown>;
    if (!isInt(x.n) || !isStr(x.url) || !isStr(x.text)) return gone;
    if (x.url.length > L.url || x.text.length > L.linkText) return big;
  }
  // Everything else that is copied into a reply is bounded as a whole.
  for (const k of ["forms", "meta", "structured_types", "structured_skipped", "feeds", "service_desc"] as const)
    if (o[k] !== undefined && jsonBytes(o[k]) > L.sideBytes) return big;
  for (const k of ["structured_count", "links_omitted", "text_omitted", "pdf_pages", "pdf_pages_omitted", "text_chars"] as const)
    if (o[k] !== undefined && !(isInt(o[k]) && (o[k] as number) >= 0)) return gone;
  if (o.text_omitted_at_least !== undefined && o.text_omitted_at_least !== true) return gone;
  return { page: { ...(o as unknown as ParsedPage), searchable_chars: Math.max(chars + 64 * (blocks + o.sections.length + o.links.length), INLINE_MAX + 1) } };
}

function usableEntry(entry: CacheEntry | null, t: Tab): { entry: CacheEntry } | { bad: "gone" | "too_large" } {
  if (!entry || typeof entry !== "object" || entry.url !== t.url || entry.parser !== PARSER_VERSION || entry.source) return { bad: "gone" };
  if (!isStr(entry.final_url) || !isIso(entry.fetched_at) || (entry.fetched_by !== undefined && !isStr(entry.fetched_by, 200))) return { bad: "gone" };
  if (entry.final_url.length > PAGE_LIMITS.url) return { bad: "too_large" };
  const c = checkPage(entry.parsed, entry.final_url);
  if ("bad" in c) return c;
  const e = { ...entry, parsed: c.page };
  return topSafe(e) ? { entry: e } : { bad: "gone" };
}

// Build one tab's reply from the page cache. Writes nothing (the caller records receipts once the call is
// known not to be cancelled). No request is sent; the reply says how old the copy is.
async function buildTab(t: Tab, view: { position?: number; stack: number; tabs: number }, opts: ViewOpts, now: number): Promise<{ e: TabEnvelope; receipts: Receipt[] }> {
  const top = (copy: TabTop["copy"], age?: number): TabTop => ({ number: t.n, ...view, copy, ...(age !== undefined ? { age_seconds: age } : {}) });
  assertSiteAllowed(new URL(t.url));
  const u = usableEntry(readJson<CacheEntry>(cachePath(t.url)), t); // at most MAX_JSON_READ bytes (store.ts)
  if ("bad" in u) {
    const e: TabEnvelope = env("", "error", { message: u.bad === "gone" ? GONE : TOO_LARGE, uc: tabUc(t) });
    e.tab = top(u.bad);
    return { e, receipts: [] };
  }
  const entry = u.entry;
  for (const url of [entry.source_url, entry.final_url]) assertSiteAllowed(new URL(url));
  const c = await buildContent(entry, opts);
  const age = Math.max(0, Math.floor((now - Date.parse(entry.fetched_at)) / 1000));
  const copy = entry.fetched_at === t.fetched_at ? "same" : Date.parse(entry.fetched_at) > Date.parse(t.fetched_at) ? "newer" : "older";
  const when = `Tab ${t.n}: the copy read at ${entry.fetched_at} (${age} seconds ago), shown from the local cache. ${NOT_SENT} It was NOT checked against the site now and may be out of date; read the URL again for the current page.`;
  const other =
    copy === "newer" ? " The kept copy is not the one this session read: the page was read again since (by this or another agent), and this is that later copy."
    : copy === "older" ? " The kept copy is not the one this session read: it is an EARLIER copy than the one this session saw (another read finished last, or the cache was restored)."
    : "";
  const cacheUc = { cached_at: entry.fetched_at, ...(entry.fetched_by !== undefined ? { cached_by: entry.fetched_by } : {}) };
  if (c.error) {
    // Round 8: an error about the copy (no such section) still says which copy, how old, and that it was not checked.
    const e: TabEnvelope = env("", "error", { fetched_at: entry.fetched_at, message: `${c.error} ${when}${other}`, uc: { ...tabUc(t), final_url: entry.final_url, ...cacheUc } });
    e.tab = top(copy, age);
    return { e, receipts: [] };
  }
  const e: TabEnvelope = env("", "ok", {
    door: entry.door, door_detail: entry.door_detail, fetched_at: entry.fetched_at, flags: entry.parsed.flags, flags_dropped: entry.parsed.flags_dropped,
    message: when + other, uc: { ...tabUc(t), ...c.uc, ...cacheUc }, receipts: c.receipts,
  });
  if (entry.parsed.forms && e.counts) e.counts.forms = entry.parsed.forms.length + (entry.parsed.forms_omitted ?? 0);
  if (entry.parsed.csv_formulas && e.counts && e.flags.includes("csv_formulas")) e.counts.csv_formulas = entry.parsed.csv_formulas;
  stampLanguage(e, entry.parsed.language); // W-26 (v0.7): languageTop passes only fixed codes and a number
  e.tab = top(copy, age);
  return { e, receipts: c.receipts };
}

export type TabAction = { action: "open"; number: number } | { action: "back" } | { action: "forward" } | { action: "close"; number: number } | { action: "close_all" };
export type ViewOpts = { question?: string; section?: number; page?: number };

class Busy extends Error {}
const locked = <T>(store: TabStore, fn: () => T): T => {
  try {
    return store.transact(fn);
  } catch (e) {
    if ((e as Error).message === BUSY) throw new Busy(BUSY);
    throw e;
  }
};

// One tab action: open (serve tab N), back, forward (move along the stack and serve), close N, close all.
// Refused in private mode (it would read the page cache or change the session). Runs under the same
// 60-second deadline and caller cancellation as any call; the page is built first, and the session and
// the receipts log are changed only once the call is known not to be cancelled.
export async function tabAction(store: TabStore, a: TabAction, opts: ViewOpts = {}, priv = false, now = Date.now(), signal?: AbortSignal): Promise<TabEnvelope> {
  if (priv || isPrivate()) {
    const e: TabEnvelope = env("", "refused", { message: PRIVATE_TABS });
    e.private = true;
    return e;
  }
  const sig = AbortSignal.any([AbortSignal.timeout(CALL_MS), ...(signal ? [signal] : [])]);
  if (sig.aborted) return env("", "error", { message: CANCELLED }); // nothing done, not even the trim (Codex browse round 2)
  await enforceLimits(); // the once-a-day trim, as on every other non-private call (Codex browse round 1)
  try {
    return await withSignal(sig, async () => {
      throwIfCancelled();
      if (a.action === "close_all")
        return locked(store, () => {
          throwIfCancelled();
          const n = store.load().tabs.length;
          if (store instanceof DiskTabs) store.remove();
          else store.save(emptyState(now));
          return env("", "ok", { message: n ? `Closed all ${n} tabs. The cached pages stay in the shared cache.` : NO_TABS });
        });
      if (a.action === "close")
        return locked(store, () => {
          throwIfCancelled();
          const s = store.load();
          if (!closeTab(s, a.number)) return env("", "error", { message: `There is no tab ${a.number} in this session. List them with tabs.` });
          s.used_at = new Date(now).toISOString();
          store.save(s);
          return env("", "ok", { message: `Closed tab ${a.number}. ${s.tabs.length} tabs open. The cached page stays in the shared cache.` });
        });
      // 1. Find the tab (reading only).
      const s = store.load();
      let t: Tab | undefined;
      let to = s.pos;
      if (a.action === "open") {
        t = s.tabs.find((x) => x.n === a.number);
        if (!t) return env("", "error", { message: s.tabs.length ? `There is no tab ${a.number} in this session. List them with tabs.` : NO_TABS });
      } else {
        to = a.action === "back" ? s.pos - 1 : s.pos + 1;
        if (to < 0 || to >= s.stack.length)
          return env("", "error", { message: a.action === "back" ? "Nothing to go back to in this session." : "Nothing to go forward to in this session." });
        t = s.tabs.find((x) => x.n === s.stack[to]);
        if (!t) throw new Error("The tab stack is damaged."); // validState makes this impossible
      }
      // 2. Build the reply (no writes).
      // Opening a tab by number does not move the back/forward position, so its reply carries none (Codex browse round 3).
      const r = await buildTab(t, { ...(a.action === "open" ? {} : { position: to + 1 }), stack: s.stack.length, tabs: s.tabs.length }, opts, now);
      throwIfCancelled();
      // 3. Move the session, under the lock, against its state as it is now.
      // Codex browse round 2: the move is made only if the session is still the one it was chosen from (same
      // id, no change saved since); otherwise nothing moves, nothing is logged, and the call says so.
      const n = t.n;
      const moved = locked(store, () => {
        throwIfCancelled();
        const cur = store.load();
        // Opening a tab moves nothing, so a changed session only skips noting when the tab was used.
        if (cur.id !== s.id || cur.rev !== s.rev) return a.action === "open";
        const tab = cur.tabs.find((x) => x.n === n)!;
        if (a.action !== "open") cur.pos = to;
        tab.used_at = new Date(now).toISOString();
        cur.used_at = tab.used_at;
        store.save(cur);
        return true;
      });
      if (!moved) return env("", "error", { message: MOVED });
      // 4. Every quote handed back is also logged (N-03); tab calls are never private.
      throwIfCancelled();
      if (r.receipts.length) recordReceipts(r.receipts);
      return r.e;
    });
  } catch (e) {
    if (e instanceof Busy) return env("", "error", { message: BUSY });
    if (sig.aborted) return env("", "error", { message: CANCELLED });
    const out = errorEnv("", e);
    if (e instanceof SiteRefused) out.site_settings = [e.setting];
    return out;
  }
}

// The list of this session's tabs, a page at a time. Numbers and counts at the top level; the URLs and
// titles (from the web, or from an agent) inside untrusted_content.
export interface TabsReply {
  status: "ok";
  message: string;
  notice: string;
  session: "memory" | "disk";
  counts: { tabs: number; stack: number; back: number; forward: number };
  current?: number;
  page: number;
  pages: number;
  untrusted_content: { tabs: (Tab & { current?: true })[] };
}
export function tabList(store: TabStore, page = 1): TabsReply {
  const s = store.load();
  const cur = s.pos >= 0 ? s.stack[s.pos] : undefined;
  // Most recently used first.
  const items = [...s.tabs].sort((a, b) => b.used_at.localeCompare(a.used_at) || b.n - a.n).map((t) => ({ ...t, ...(t.n === cur ? { current: true as const } : {}) }));
  const pg = paginate(items, jsonBytes, page, LIST_BUDGET);
  return {
    status: "ok",
    message: s.tabs.length
      ? `${s.tabs.length} tab${s.tabs.length === 1 ? "" : "s"} in this session${store.kind === "memory" ? " (kept in memory until this MCP server stops)" : " (the command line's session: it ends after 12 hours without use)"}. Open one with its number, or go back and forward; nothing is sent to the site.`
      : NO_TABS,
    notice: NOTICE,
    session: store.kind,
    counts: { tabs: s.tabs.length, stack: s.stack.length, back: Math.max(0, s.pos), forward: s.stack.length ? s.stack.length - 1 - s.pos : 0 },
    ...(cur !== undefined ? { current: cur } : {}),
    page,
    pages: pg.pages,
    untrusted_content: { tabs: pg.slice },
  };
}
