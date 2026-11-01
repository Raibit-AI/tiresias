// SPDX-License-Identifier: Apache-2.0
// W-06: handoff tickets. When a normal (not private) read stops at a wall, Tiresias keeps a
// small ticket so the agent can pick up where it stopped once a person is through: retry the
// same read, or parse a page the person saved themselves (engine.ts, resume).
//
// One JSON file per ticket, handoffs/<id>.json, like bookmarks: created with an exclusive
// create, never rewritten, deleted whole when it is used, cleared or expired. No shared file,
// no locks. Tickets last `keep_handoff_days` (config.json, default 7); an expired ticket is
// ignored and removed by `clear` and the daily trim. At most MAX_TICKETS ticket files exist
// (checked before each create; two creates at the same moment can pass it by one each).
//
// A ticket holds the URL the caller asked for, the page to open (web-derived), the fixed wall
// reason, the question, section, render and translate options of the original read, and the agent's name. Everything in a
// ticket except id, created_at, reason and tool came from outside, so lists of tickets are
// returned inside untrusted_content.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readItem, removeItem, writeItem } from "./itemfiles.js";
import { cliSafeId, isPrivate, subDir } from "./store.js";
import { parseTarget } from "./translate.js";
import { TiresiasError } from "./errors.js";

export interface Ticket {
  id: string;
  created_at: string;
  url: string; // the URL the original read asked for
  open_this?: string; // the exact page that showed the wall (web-derived); absent when too long to keep whole
  reason: string; // fixed wall code
  tool: "read";
  question?: string;
  section?: number;
  render?: boolean;
  translate?: string;
  agent?: string;
  cut?: true; // a field was too long and was cut (agent) or left out (open_this)
}

export const MAX_TICKETS = 500;
export const DEFAULT_KEEP_DAYS = 7;
const DAY = 86_400_000;
const ID = /^[A-Za-z0-9_-]{16}$/;
const FILE = /^([A-Za-z0-9_-]{16})\.json$/;
const MAX_FILE = 20 * 1024; // a ticket is at most about 15 KB by the bounds below
const MAX_URL_KEEP = 4096; // same bound as history URLs
const MAX_QUESTION = 1000; // same bound as a history purpose
const MAX_AGENT = 200;
const REASONS = new Set(["bot_challenge", "captcha", "login_required", "forbidden"]);

export class HandoffError extends TiresiasError {
  readonly kind = "handoff";
}

const BAD_ID = "A handoff ticket id is 16 characters of A-Z, a-z, 0-9, \"-\" and \"_\". That id was refused.";

export function checkId(id: unknown): string {
  if (typeof id !== "string" || !ID.test(id)) throw new HandoffError(BAD_ID);
  return id;
}

// The handoffs folder, validated like every store sub-folder. With create = false nothing is created.
const folder = (create: boolean): string | null => subDir("handoffs", create);

const names = (d: string) => fs.readdirSync(d).filter((n) => FILE.test(n)).sort();

const valid = (t: Ticket, id: string) =>
  !!t && typeof t === "object" && t.id === id && typeof t.created_at === "string" && t.created_at.length <= 40 && !Number.isNaN(Date.parse(t.created_at)) &&
  typeof t.url === "string" && t.url.length <= MAX_URL_KEEP && (t.open_this === undefined || (typeof t.open_this === "string" && t.open_this.length <= MAX_URL_KEEP)) &&
  typeof t.reason === "string" && REASONS.has(t.reason) && t.tool === "read" &&
  (t.question === undefined || (typeof t.question === "string" && t.question.length <= MAX_QUESTION)) &&
  (t.section === undefined || (Number.isSafeInteger(t.section) && t.section > 0)) &&
  (t.render === undefined || typeof t.render === "boolean") &&
  (t.translate === undefined || parseTarget(t.translate) !== null) &&
  (t.agent === undefined || (typeof t.agent === "string" && t.agent.length <= MAX_AGENT));

// One ticket file: opened without following links and without blocking, checked to be a regular
// file of ours, size-capped, and checked to hold a valid ticket with the same id.
function readOne(d: string, id: string, name = id + ".json"): Ticket | null {
  {
    const t = readItem(d, name, MAX_FILE, (why) =>
      new HandoffError(why === "unreadable" ? "That ticket file cannot be read (it may be a link or not a plain file)." : why === "too_large" ? "That ticket file is damaged (too large)." : "That ticket file is damaged."),
    ) as Ticket | null;
    if (t === null) return null;
    if (!valid(t, id)) throw new HandoffError("That ticket file is damaged.");
    const out: Ticket = { id: t.id, created_at: t.created_at, url: t.url, reason: t.reason, tool: "read" };
    if (t.open_this !== undefined) out.open_this = t.open_this;
    if (t.question !== undefined) out.question = t.question;
    if (t.section !== undefined) out.section = t.section;
    if (t.render !== undefined) out.render = t.render;
    if (t.translate !== undefined) out.translate = t.translate;
    if (t.agent !== undefined) out.agent = t.agent;
    if (t.cut) out.cut = true;
    return out;
  }
}

export const expired = (t: { created_at: string }, keepDays: number, now = Date.now()) => Date.parse(t.created_at) + keepDays * DAY <= now;

export type Skipped = "cap" | "too_long";

// Keep a ticket for a wall. Returns the ticket, or why none was kept. Store errors throw (the
// engine turns them into a note; a ticket never fails the read).
export function create(o: { url: string; open_this?: unknown; reason: string; question?: string; section?: number; render?: boolean; translate?: string; agent?: string }): { ticket?: Ticket; skipped?: Skipped } {
  // The URL and the question are what a retry runs again, so they are kept whole or not at all.
  if (o.url.length > MAX_URL_KEEP || (o.question !== undefined && o.question.length > MAX_QUESTION)) return { skipped: "too_long" };
  if (!REASONS.has(o.reason)) throw new Error("unknown wall reason");
  const t: Ticket = { id: cliSafeId(16), created_at: new Date().toISOString(), url: o.url, reason: o.reason, tool: "read" };
  // The page to open is a URL: never cut, left out (and marked) when too long.
  if (typeof o.open_this === "string") {
    if (o.open_this.length <= MAX_URL_KEEP) t.open_this = o.open_this;
    else t.cut = true;
  }
  if (o.question !== undefined) t.question = o.question;
  if (o.section !== undefined && Number.isSafeInteger(o.section) && o.section > 0) t.section = o.section;
  if (o.render !== undefined) t.render = o.render;
  if (o.translate !== undefined) {
    const target = parseTarget(o.translate);
    if (!target) return { skipped: "too_long" };
    t.translate = target;
  }
  if (o.agent !== undefined) {
    t.agent = o.agent.slice(0, MAX_AGENT);
    if (o.agent.length > MAX_AGENT) t.cut = true;
  }
  const d = folder(true)!;
  if (names(d).length >= MAX_TICKETS) return { skipped: "cap" };
  writeItem(d, t.id + ".json", JSON.stringify({ v: 1, ...t }), "create");
  return { ticket: t };
}

// v0.5.1: `resume` CLAIMS its ticket before it reads anything: the ticket file is renamed to a claim name
// (one atomic step), so two resumes of one ticket never both run. Solved: the claim is deleted. Not solved
// (or the process died): the ticket goes back to its name; a claim older than CLAIM_STALE_MS is put back
// the next time tickets are read.
// The claim's own time is IN its name (a rename keeps the ticket's old mtime, so the mtime cannot say
// how old the claim is: Codex round 69).
const CLAIM = /^\.claimed-([A-Za-z0-9_-]{16})\.(\d{13})\.[0-9a-f]{16}$/;
const CLAIM_STALE_MS = 2 * 60_000; // a call lasts at most 60 seconds
export interface Claim {
  ticket: Ticket;
  name: string;
}
export function claim(id: string, keepDays: number, now = Date.now()): Claim | null {
  checkId(id);
  const d = folder(false);
  if (!d) return null;
  restoreStale(d, now);
  const t = readOne(d, id);
  if (!t || expired(t, keepDays, now)) return null;
  const name = `.claimed-${id}.${String(Date.now()).padStart(13, "0")}.${randomBytes(8).toString("hex")}`;
  try {
    fs.renameSync(path.join(d, id + ".json"), path.join(d, name));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; // another resume claimed it first
    throw e;
  }
  return { ticket: t, name };
}
// Done with a claim: delete it (solved) or put the ticket back under its own name (still open).
export function release(c: Claim, solved: boolean): void {
  const d = folder(false);
  if (!d) return;
  const from = path.join(d, c.name);
  if (solved) return void removeItem(d, c.name);
  try {
    fs.linkSync(from, path.join(d, c.ticket.id + ".json"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  removeItem(d, c.name);
}
function restoreStale(d: string, now: number): void {
  for (const n of fs.readdirSync(d)) {
    const m = CLAIM.exec(n);
    if (!m) continue;
    try {
      const st = fs.lstatSync(path.join(d, n));
      if (!st.isFile() || now - Number(m[2]) < CLAIM_STALE_MS) continue;
      release({ ticket: { id: m[1] } as Ticket, name: n }, false);
    } catch {
      // gone meanwhile
    }
  }
}

// An open ticket by id: null when there is none or it has expired (expired tickets are ignored).
export function get(id: string, keepDays: number, now = Date.now()): Ticket | null {
  checkId(id);
  const d = folder(false);
  const t = d ? readOne(d, id) : null;
  return t && !expired(t, keepDays, now) ? t : null;
}

// Deletes one ticket file, whole. Only a plain regular file in the validated folder.
export function remove(id: string): void {
  checkId(id);
  const d = folder(false);
  if (!d) return;
  const file = path.join(d, id + ".json");
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return; // already gone (another process used it, or it was cleared)
  }
  if (st.isFile()) fs.rmSync(file, { force: true });
}

// Open tickets, oldest first. Expired and damaged files are counted, not listed.
export function list(keepDays: number, now = Date.now()): { items: Ticket[]; expired: number; damaged: number } {
  const d = folder(false);
  if (!d) return { items: [], expired: 0, damaged: 0 };
  if (!isPrivate()) restoreStale(d, now);
  const items: Ticket[] = [];
  let old = 0;
  let damaged = 0;
  for (const n of names(d)) {
    try {
      const t = readOne(d, FILE.exec(n)![1]);
      if (!t) continue; // vanished while listing
      if (expired(t, keepDays, now)) old++;
      else items.push(t);
    } catch {
      damaged++;
    }
  }
  items.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1));
  return { items, expired: old, damaged };
}

// Every ticket file with its size and creation time, for cleanup. A damaged file's age is its mtime.
export function files(): { file: string; size: number; created: number }[] {
  const d = folder(false);
  if (!d) return [];
  const out: { file: string; size: number; created: number }[] = [];
  for (const n of names(d)) {
    const file = path.join(d, n);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(file);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    let created = st.mtimeMs;
    try {
      const t = readOne(d, FILE.exec(n)![1]);
      if (t) created = Date.parse(t.created_at);
    } catch {
      // damaged: judged by its mtime
    }
    out.push({ file, size: st.size, created });
  }
  return out;
}
