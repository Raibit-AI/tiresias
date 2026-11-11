// SPDX-License-Identifier: Apache-2.0
// W-05: permission slips. Scoped, signed, expiring permissions the OWNER grants ("may submit forms on
// example.com until Friday"). Only the owner grants, revokes or lists them with full detail, from the
// command line. There is no MCP tool or parameter that makes, extends or edits a slip: an agent can
// never give itself permission. The MCP server only lists them (read only), so an agent knows what it
// may do, and phase C (forms) asks claimSlip() before it sends anything.
//
// Storage, one file per item like bookmarks and tickets (no shared file, no counters, no locks):
// - slips/<id>.json: the slip fields and an Ed25519 signature over their canonical bytes. Written whole
//   to a temp file and hard-linked to its name (exclusive: link fails if the name exists).
// - slips/<id>.use-<n>: one use, claimed with an exclusive create of the lowest free n in 1..uses. When
//   every n is taken the slip is used up. A claim holds the time and a short fixed label.
// - Revoking renames <id>.json to .revoked-<id> FIRST (one atomic step, after which the slip can never
//   be used, since only <id>.json is ever read as a slip), then deletes its use files, then the renamed
//   file. A revoke cut short leaves only files that are never a slip; clear removes them.
//
// Signing: the slip key (keys/slips.private.jwk, keys.ts) signs the canonical bytes, which include the
// profile name. A slip whose signature, fields or profile do not verify is "damaged": counted, never
// used. This catches a hand-edited or corrupted slip file and a slip copied from another profile. It
// does NOT protect against a process running as the owner: such a process can read the slip key and
// sign whatever it likes (the same threat model as the whole store).
//
// v0.5.1 (W-05 hardened, structure review 2026-10-20):
// - Granting and revoking need a PERSON at a terminal who types the slip's site back (person.ts, called
//   by the CLI). An agent running the CLI from a shell cannot answer the prompt on its own.
// - Uses are tamper-evident: each use file holds the slip id, the use number, the time, the label and an
//   Ed25519 signature by the slip key. A slip's uses taken are counted up to the HIGHEST use number
//   present (claims always go upward), so deleting a lower use file gives nothing back, and a use file
//   that does not verify still counts as used.
// - Revocation survives a copied slip: every revoked id goes to slips/revoked.jsonl (append only, never
//   rewritten). A slip on that list is damaged: counted, never used.
import { randomBytes, sign as edSign, verify as edVerify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SlipError } from "./errors.js";
import { PATH_RE, pathAllowed } from "./forms.js";
import { readItem, writeItem } from "./itemfiles.js";
import * as history from "./history.js";
import { SLIP_KEY_FILE, ensureSlipKey, readSlipKey, replaceSlipKey, type SlipKeys } from "./keys.js";
import { NOFOLLOW, NONBLOCK, cliSafeId, isPrivate, ownFile, profileName, randomTmp, rmRegular, subDir } from "./store.js";

export { SlipError };

// The fixed allow-list of actions. v0.4 has exactly one.
export const ACTIONS = ["submit_form"] as const;
export type Action = (typeof ACTIONS)[number];

export const MAX_SLIPS = 200; // per profile, checked before each grant (two at once can pass it by one each)
export const MAX_USES = 100;
export const DEFAULT_USES = 1;
const HOUR = 3_600_000;
const DAY = 86_400_000;
export const DEFAULT_TTL = 24 * HOUR;
export const MAX_TTL = 30 * DAY;
const MAX_NOTE = 200; // characters
const MAX_SITE = 300; // characters of the --site value
const MAX_PATH = 512;
const MAX_FILE = 4096; // a slip is well under 1 KB; anything bigger is not one
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]); // http is allowed only here (tests)
const ID = /^[A-Za-z0-9_-]{24}$/;
const SLIP_FILE = /^([A-Za-z0-9_-]{24})\.json$/;
const USE_FILE = /^([A-Za-z0-9_-]{24})\.use-([1-9][0-9]{0,2})$/;
const REVOKED = /^\.revoked-[A-Za-z0-9_-]{24}$/;
export const REVOKED_LIST = "revoked.jsonl";
// The list is never rewritten (v0.5.1, after Codex rounds 69 to 71: every way of pruning it opened a
// window to lose a live line). One line is about 100 bytes, so 8 MB holds some 80,000 revocations; past
// that the list fails loudly and no slip is used until the owner clears it by hand.
const MAX_REVOKED_BYTES = 8 * 1024 * 1024;
// A claim's label says what the use was for. It is passed by Tiresias's own code (phase C), never by
// an agent, and is kept short and plain.
const LABEL = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

export const PAY_REFUSED = "Paying is not something a permission slip can allow: this version of Tiresias never pays. No slip was made.";
const UNKNOWN_ACTION = `A slip's action must be one of: ${ACTIONS.join(", ")}. That action was refused.`;
const BAD_SITE =
  "--site must be an exact origin: https://host or https://host:port, with no path, query, fragment or user name (http only for localhost, 127.0.0.1 or [::1]). Write an international name in its xn-- form.";
const BAD_PATH = '--path must start with "/", be at most 512 characters, and be a plain path with no "?", "#", "\\", "." or ".." parts or characters a URL would rewrite.';
const BAD_ID = 'A slip id is 24 characters of A-Z, a-z, 0-9, "-" and "_". That id was refused.';
const PRIVATE_TEXT = "Private mode: slips are not granted, revoked or used, because a private session creates and changes nothing in the store.";

export interface Slip {
  v: 1;
  id: string;
  profile: string;
  action: Action;
  site: string; // an origin, exactly as URL.origin writes it
  path: string | null; // a path prefix matched on whole segments, or null for the whole site
  created_at: string;
  expires_at: string;
  uses: number;
  note: string | null;
  sig: string; // base64url Ed25519 signature over canonical()
}
// v0.5.1: the slip format versions this build can verify (one so far).
export const SLIP_VERSIONS: readonly number[] = [1];
const FIELDS = ["v", "id", "profile", "action", "site", "path", "created_at", "expires_at", "uses", "note", "sig"].sort().join(",");

// The signed bytes: a JSON array in a fixed order (an array has no key order to argue about), led by a
// fixed tag so these bytes can never be mistaken for anything else the key might sign.
const canonical = (s: Omit<Slip, "sig">): Buffer =>
  Buffer.from(JSON.stringify(["tiresias-permission-slip", s.v, s.id, s.profile, s.action, s.site, s.path, s.created_at, s.expires_at, s.uses, s.note]), "utf8");

export function checkId(id: unknown): string {
  if (typeof id !== "string" || !ID.test(id)) throw new SlipError(BAD_ID);
  return id;
}

function checkAction(a: unknown): Action {
  if (a === "pay") throw new SlipError(PAY_REFUSED);
  if (typeof a !== "string" || !(ACTIONS as readonly string[]).includes(a)) throw new SlipError(UNKNOWN_ACTION);
  return a as Action;
}

const webOk = (u: URL) => u.protocol === "https:" || (u.protocol === "http:" && LOCAL.has(u.hostname));

// An exact origin. Returns it as URL.origin writes it (lower-case host, default port dropped).
// The RAW text must already be exactly an origin (scheme://host[:port], one optional trailing "/"),
// checked before any URL parsing: parsing first would turn https://host/contact/.. into a whole-site
// slip (Codex round 49). Hosts are ASCII (write an international name in its xn-- form).
const ORIGIN = /^https?:\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:[0-9]{1,5})?\/?$/;
export function parseSite(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > MAX_SITE || !ORIGIN.test(raw)) throw new SlipError(BAD_SITE);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SlipError(BAD_SITE);
  }
  if (!webOk(u) || u.username || u.password || u.search || u.hash || u.pathname !== "/") throw new SlipError(BAD_SITE);
  return u.origin;
}

// A path prefix, or null for the whole site. Trailing slashes are dropped ("/contact/" is "/contact",
// "/" is the whole site). It must already be in the form a URL parser keeps, so what the owner wrote
// is exactly what is matched.
export function parsePath(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.length > MAX_PATH || /[?#\\]/.test(raw)) throw new SlipError(BAD_PATH);
  let parsed: string;
  try {
    parsed = new URL(raw, "https://slip.invalid").pathname;
  } catch {
    throw new SlipError(BAD_PATH);
  }
  if (parsed !== raw || raw.startsWith("//") || !PATH_RE.test(raw)) throw new SlipError(BAD_PATH); // Codex round 53: the same plain-path allow-list as a form target
  const p = raw.replace(/\/+$/, "");
  return p === "" ? null : p;
}

// Whole path segments: "/contact" covers "/contact" and "/contact/x", never "/contactus".
export const pathCovers = (prefix: string | null, pathname: string): boolean =>
  prefix === null || pathname === prefix || pathname.startsWith(prefix + "/");

function checkNote(n: unknown): string | null {
  if (n === undefined || n === null) return null;
  if (typeof n !== "string" || n.length > MAX_NOTE || /[\u0000-\u001f\u007f]/.test(n)) throw new SlipError(`--note is at most ${MAX_NOTE} characters, on one line.`);
  return n;
}

function checkUses(u: unknown): number {
  if (u === undefined) return DEFAULT_USES;
  const n = typeof u === "string" && /^\d{1,4}$/.test(u) ? Number(u) : u;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || n > MAX_USES) throw new SlipError(`--uses is a whole number from 1 to ${MAX_USES}.`);
  return n;
}

// When the slip ends. `until` is a date (YYYY-MM-DD: through the end of that day, local time) or a full
// time (2026-10-24T17:00, optionally with Z or an offset); `for` is a span like 7d or 12h. Default 24 h,
// at most 30 days from now, and it must be in the future.
export function expiryFrom(o: { until?: string; for?: string }, now = Date.now()): number {
  if (o.until !== undefined && o.for !== undefined) throw new SlipError("Use --until or --for, not both.");
  let t: number;
  if (o.until !== undefined) {
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(o.until);
    if (day) {
      const [y, m, d] = [Number(day[1]), Number(day[2]), Number(day[3])];
      const start = new Date(y, m - 1, d);
      if (start.getFullYear() !== y || start.getMonth() !== m - 1 || start.getDate() !== d) throw new SlipError("--until is not a real date.");
      t = new Date(y, m - 1, d + 1).getTime(); // the end of that local day
    } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/.test(o.until)) {
      // Every calendar and clock part is checked: Date.parse would roll 2027-02-30 forward to March 2 (Codex round 49).
      const [y, m, d, hh, mm] = o.until.slice(0, 16).split(/[-T:]/).map(Number);
      const ss = o.until.length > 16 && o.until[16] === ":" ? Number(o.until.slice(17, 19)) : 0;
      const off = /([+-])(\d{2}):(\d{2})$/.exec(o.until);
      const real = new Date(Date.UTC(y, m - 1, d));
      if (real.getUTCFullYear() !== y || real.getUTCMonth() !== m - 1 || real.getUTCDate() !== d || hh > 23 || mm > 59 || ss > 59 || (off && (Number(off[2]) > 23 || Number(off[3]) > 59)))
        throw new SlipError("--until is not a real time.");
      t = Date.parse(o.until);
      if (Number.isNaN(t)) throw new SlipError("--until is not a real time.");
    } else throw new SlipError("--until takes a date like 2026-10-24 or a time like 2026-10-24T17:00.");
  } else if (o.for !== undefined) {
    const m = /^(\d{1,4})([dh])$/.exec(o.for);
    if (!m || Number(m[1]) < 1) throw new SlipError("--for takes whole days or hours, like 7d or 12h.");
    t = now + Number(m[1]) * (m[2] === "d" ? DAY : HOUR);
  } else t = now + DEFAULT_TTL;
  if (t <= now) throw new SlipError("That time has already passed. A slip must end in the future.");
  if (t - now > MAX_TTL) throw new SlipError("A slip lasts at most 30 days from now. Choose an earlier end.");
  return t;
}

const isoOk = (s: unknown): s is string => typeof s === "string" && s.length <= 30 && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s;

// The slip in `raw`, if every field is valid, it belongs to this profile and file, and the signature
// verifies with this profile's slip key. Otherwise null (damaged).
function verify(raw: unknown, id: string, keys: SlipKeys | null, profile: string): Slip | null {
  if (!keys || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Slip;
  if (Object.keys(s).sort().join(",") !== FIELDS) return null;
  if (!SLIP_VERSIONS.includes(s.v) || s.id !== id || s.profile !== profile) return null;
  try {
    checkAction(s.action);
    if (parseSite(s.site) !== s.site || parsePath(s.path) !== s.path || checkNote(s.note) !== s.note || checkUses(s.uses) !== s.uses) return null;
  } catch {
    return null;
  }
  if (!isoOk(s.created_at) || !isoOk(s.expires_at)) return null;
  const life = Date.parse(s.expires_at) - Date.parse(s.created_at);
  if (life <= 0 || life > MAX_TTL) return null;
  if (typeof s.sig !== "string" || s.sig.length > 200) return null;
  const sig = Buffer.from(s.sig, "base64url");
  if (sig.length !== 64 || sig.toString("base64url") !== s.sig) return null;
  try {
    return edVerify(null, canonical(s), keys.pub, sig) ? s : null;
  } catch {
    return null;
  }
}

type Read = Slip | "damaged" | null; // null: the file is not there

function readOne(d: string, id: string, keys: SlipKeys | null, profile: string, revoked?: Set<string>): Read {
  if ((revoked ?? revokedIds(d)).has(id)) return fs.existsSync(path.join(d, id + ".json")) ? "damaged" : null; // a copy of a revoked slip
  let raw: unknown;
  try {
    raw = readItem(d, id + ".json", MAX_FILE, () => new SlipError("damaged"));
  } catch {
    return "damaged";
  }
  return raw === null ? null : (verify(raw, id, keys, profile) ?? "damaged");
}

const slipIds = (d: string): string[] => fs.readdirSync(d).map((n) => SLIP_FILE.exec(n)?.[1]).filter((x): x is string => !!x).sort();
const useName = (id: string, n: number) => `${id}.use-${n}`;

// How many of a slip's uses are taken: the HIGHEST use number present (v0.5.1). Claims always go upward,
// so a missing lower use file was deleted, and deleting it gives nothing back. Anything at a use's name
// (even something that is not a plain file, or a use that does not verify) counts: an odd file can only
// take permission away, never give it.
function taken(d: string, s: Slip): number {
  for (let i = s.uses; i >= 1; i--) {
    try {
      fs.lstatSync(path.join(d, useName(s.id, i)));
      return i;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return i;
    }
  }
  return 0;
}

// The signed bytes of one use: fixed tag, the slip id, the use number, the time, the label and the profile.
const useBytes = (u: { id: string; use: number; time: string; label: string }, profile: string): Buffer =>
  Buffer.from(JSON.stringify(["tiresias-slip-use", 1, u.id, u.use, u.time, u.label, profile]), "utf8");

// Whether one use file is a use Tiresias signed for this slip and number (for the owner's look; an
// unverified use still counts as used).
export function useVerifies(d: string, id: string, n: number, keys: SlipKeys | null, profile = profileName()): boolean {
  if (!keys) return false;
  try {
    const st = fs.lstatSync(path.join(d, useName(id, n)));
    if (!st.isFile() || st.size > MAX_FILE) return false;
    const u = JSON.parse(fs.readFileSync(path.join(d, useName(id, n)), "utf8"));
    if (!u || u.v !== 1 || u.id !== id || u.use !== n || typeof u.time !== "string" || typeof u.label !== "string" || typeof u.sig !== "string") return false;
    const sig = Buffer.from(u.sig, "base64url");
    return sig.length === 64 && edVerify(null, useBytes(u, profile), keys.pub, sig);
  } catch {
    return false;
  }
}

// ---- the revocation list (slips/revoked.jsonl) ----

interface RevokedLine {
  v: 1;
  id: string;
  until: string; // when the slip would have expired (informational; the list is never pruned)
  time: string;
}
function readRevoked(d: string): RevokedLine[] {
  const file = path.join(d, REVOKED_LIST);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new SlipError("The list of revoked slips cannot be read, so no slip is used. Look at slips/revoked.jsonl.");
  }
  try {
    ownFile(fd, file);
    if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size > MAX_REVOKED_BYTES) throw new SlipError("The list of revoked slips is damaged or too large, so no slip is used. Look at slips/revoked.jsonl.");
    const out: RevokedLine[] = [];
    for (const line of fs.readFileSync(fd, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && typeof r.id === "string" && ID.test(r.id) && isoOk(r.until)) out.push({ v: 1, id: r.id, until: r.until, time: String(r.time ?? "") });
      } catch {
        // a torn last line from a crash: skip it (its slip file was renamed away first anyway)
      }
    }
    return out;
  } catch (e) {
    if (e instanceof SlipError) throw e;
    throw new SlipError("The list of revoked slips cannot be read, so no slip is used. Look at slips/revoked.jsonl.");
  } finally {
    fs.closeSync(fd);
  }
}
const revokedIds = (d: string): Set<string> => new Set(readRevoked(d).map((r) => r.id));

// Append one line (O_APPEND, one write). Before the slip file is renamed away, so a revoke cut short at any
// point leaves the id on the list.
// Append only, never rewritten, so no lock is needed: each record is one O_APPEND write, newline first.
function appendRevoked(d: string, id: string, until: string): void {
  const file = path.join(d, REVOKED_LIST);
  appendRevokedLocked(file, id, until);
}
function appendRevokedLocked(file: string, id: string, until: string): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | NOFOLLOW | NONBLOCK, 0o600);
  try {
    ownFile(fd, file);
    // Codex round 70 (HIGH): a newline FIRST, so a line torn by an earlier crash can never swallow this
    // record; the whole record is written (looping on short writes) and fsynced before the slip is retired.
    // ONE write (Codex round 72): a record split over two writes could be interleaved with another
    // process's record. A short write fails the revoke, before the slip is retired, so a success always
    // means a whole line (the newline first keeps the next record whole even after a torn one).
    const buf = Buffer.from("\n" + JSON.stringify({ v: 1, id, until, time: new Date().toISOString() }) + "\n");
    if (fs.writeSync(fd, buf, 0, buf.length) !== buf.length) throw new SlipError("The revocation could not be written whole, so the slip was not revoked. Try again.");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// When a slip file says it expires (signature not checked: a damaged slip is kept on the list for the
// longest a slip can live).
function expiryOf(d: string, id: string, now = Date.now()): string {
  try {
    const st = fs.lstatSync(path.join(d, id + ".json"));
    if (st.isFile() && st.size <= MAX_FILE) {
      const e = JSON.parse(fs.readFileSync(path.join(d, id + ".json"), "utf8"))?.expires_at;
      if (isoOk(e) && Date.parse(e) - now <= MAX_TTL) return e;
    }
  } catch {
    // damaged or gone
  }
  return new Date(now + MAX_TTL).toISOString();
}

export type State = "active" | "expired" | "used_up";
const stateOf = (d: string, s: Slip, now: number): { state: State; left: number } => {
  if (Date.parse(s.expires_at) <= now) return { state: "expired", left: 0 };
  const left = s.uses - taken(d, s);
  return { state: left > 0 ? "active" : "used_up", left };
};

export interface SlipView {
  id: string;
  action: Action;
  site: string;
  path: string | null;
  created_at: string;
  expires_at: string;
  uses: number;
  uses_left: number;
  note: string | null;
}
const view = (s: Slip, left: number): SlipView => ({
  id: s.id, action: s.action, site: s.site, path: s.path, created_at: s.created_at, expires_at: s.expires_at, uses: s.uses, uses_left: left, note: s.note,
});

const soonest = (a: SlipView, b: SlipView) => (a.expires_at < b.expires_at ? -1 : a.expires_at > b.expires_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Every slip of the current profile: the active ones (soonest to expire first) and counts of the rest.
// Reads only. The slip key is read only when there is a slip to check; trouble with it throws.
export function list(now = Date.now()): { items: SlipView[]; counts: { active: number; expired: number; used_up: number; damaged: number } } {
  const counts = { active: 0, expired: 0, used_up: 0, damaged: 0 };
  const items: SlipView[] = [];
  const d = subDir("slips", false);
  if (!d) return { items, counts };
  const ids = slipIds(d);
  if (!ids.length) return { items, counts };
  const keys = readSlipKey();
  const profile = profileName();
  const revoked = revokedIds(d);
  for (const id of ids) {
    const s = readOne(d, id, keys, profile, revoked);
    if (s === null) continue; // revoked while listing
    if (s === "damaged") {
      counts.damaged++;
      continue;
    }
    const st = stateOf(d, s, now);
    counts[st.state]++;
    if (st.state === "active") items.push(view(s, st.left));
  }
  items.sort(soonest);
  return { items, counts };
}

// ---- granting and revoking (owner only, CLI only) ----

export interface GrantInput {
  action: unknown;
  site: unknown;
  path?: unknown;
  until?: string;
  for?: string;
  uses?: unknown;
  note?: unknown;
}

// Refuses in private mode (before a person is asked anything).
export function assertWritable(priv = false): void {
  if (priv || isPrivate()) throw new SlipError(PRIVATE_TEXT);
}

// What the person types back to confirm a revoke: the slip's site, read from its file (or the id itself
// when the file is damaged). Throws when there is no such slip.
export function confirmTextFor(id: string): string {
  checkId(id);
  const d = subDir("slips", false);
  const file = d ? path.join(d, id + ".json") : "";
  try {
    const st = fs.lstatSync(file);
    if (st.isFile() && st.size <= MAX_FILE) return parseSite(JSON.parse(fs.readFileSync(file, "utf8"))?.site);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || !d) throw new SlipError("There is no slip with that id. Nothing was revoked.");
  }
  return id;
}

export function grant(o: GrantInput, priv = false, now = Date.now()): SlipView {
  if (priv || isPrivate()) throw new SlipError(PRIVATE_TEXT);
  const action = checkAction(o.action);
  const site = parseSite(o.site);
  const p = parsePath(o.path);
  const expires = expiryFrom({ until: o.until, for: o.for }, now);
  const uses = checkUses(o.uses);
  const note = checkNote(o.note);
  const keys = ensureSlipKey(); // made on the first grant
  const d = subDir("slips", true)!;
  if (slipIds(d).length >= MAX_SLIPS)
    throw new SlipError(`There are already ${MAX_SLIPS} slips in this profile, the most Tiresias keeps (expired and used-up ones count until tiresias clear removes them). Revoke some first.`);
  const body: Omit<Slip, "sig"> = {
    v: 1, id: cliSafeId(24), profile: profileName(), action, site, path: p,
    created_at: new Date(now).toISOString(), expires_at: new Date(expires).toISOString(), uses, note,
  };
  const slip: Slip = { ...body, sig: edSign(null, canonical(body), keys.priv).toString("base64url") };
  writeItem(d, slip.id + ".json", JSON.stringify(slip), "create");
  return view(slip, uses);
}

// Retire one slip: rename it away first (from then on it can never be used), then delete its use
// files, then the renamed file. Returns whether a slip file was there.
function retire(d: string, id: string): boolean {
  // On the revocation list FIRST (v0.5.1): a copy of the slip put back later is never used. Retired
  // expired and used-up slips go on it too, since their use files are deleted with them.
  if (fs.existsSync(path.join(d, id + ".json"))) appendRevoked(d, id, expiryOf(d, id));
  let had = true;
  try {
    fs.renameSync(path.join(d, id + ".json"), path.join(d, ".revoked-" + id));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    had = false;
  }
  for (const n of fs.readdirSync(d)) if (USE_FILE.exec(n)?.[1] === id) rmRegular(path.join(d, n));
  rmRegular(path.join(d, ".revoked-" + id));
  return had;
}

export function revoke(id: string, priv = false): void {
  checkId(id);
  if (priv || isPrivate()) throw new SlipError(PRIVATE_TEXT);
  const d = subDir("slips", false);
  if (!d || !retire(d, id)) throw new SlipError("There is no slip with that id. Nothing was revoked.");
}

// Every slip of this profile, damaged ones included, plus anything a cut-short revoke left.
export function revokeAll(priv = false): number {
  if (priv || isPrivate()) throw new SlipError(PRIVATE_TEXT);
  const d = subDir("slips", false);
  if (!d) return 0;
  let n = 0;
  for (const id of slipIds(d)) if (retire(d, id)) n++; // slip by slip, rename first, like one revoke
  for (const f of fs.readdirSync(d)) if (REVOKED.test(f)) rmRegular(path.join(d, f));
  for (const f of fs.readdirSync(d)) removeLooseUse(d, f);
  return n;
}

// ---- v1.1 workstream 4: rotating the slip key ----
// A new slip key makes every existing slip fail its signature check, so the rotation revokes them all, cleanly and
// on the record (revoked.jsonl), before the key is replaced, and once more after it (a slip granted meanwhile was
// signed by the old key). Saved pages are not touched: the old key's public half is kept for `saved verify`.
// Receipts never reference the slip key (a receipt names a snapshot by its SHA-256 id). An irreversible action, so
// it always needs its phrase, even with confirmations for risky settings turned off; the CLI also asks a person at
// a terminal to type "rotate slip key", like `slip revoke --all`. Written to history (tool "keys").
export const ROTATE_SLIP_PHRASE = "YES, ROTATE THE SLIP KEY";

export function checkRotatePhrase(confirm: string | undefined): void {
  if (confirm !== ROTATE_SLIP_PHRASE)
    throw new SlipError(`Rotating the slip key revokes every permission slip of this profile, and saved pages signed before it are then checked against the old key's public half. It needs the exact confirmation ${JSON.stringify(ROTATE_SLIP_PHRASE)}. Run it again with: tiresias keys rotate --slips --confirm '${ROTATE_SLIP_PHRASE}'  (type it exactly, in capitals; it is recorded in history). Nothing was changed.`);
}

export function rotateSlipKey(confirm: string | undefined, priv = false, now = Date.now()): { revoked: number; retired: boolean } {
  if (priv || isPrivate()) throw new SlipError("Private mode: nothing is written, so the slip key is not rotated.");
  checkRotatePhrase(confirm);
  const d = subDir("keys", false);
  if (!d || !fs.lstatSync(path.join(d, SLIP_KEY_FILE), { throwIfNoEntry: false }))
    throw new SlipError("There is no slip key yet, so there is nothing to rotate. One is made by the first slip grant or saved page.");
  // The slips are revoked inside replaceSlipKey, after every refusal (synced folder, another rotation, a full retired
  // list), so a refused rotation never destroys them (Codex K.4).
  let revoked = 0;
  const r = replaceSlipKey(now, () => {
    revoked = revokeAll(priv);
  });
  revoked += revokeAll(priv);
  history.record({ time: new Date(now).toISOString(), tool: "keys", url: "", agent: "cli", status: "ok", door: "none", event: "slip_key_rotated", revoked, by: process.stdin.isTTY === true ? "terminal" : "not_terminal" });
  return { revoked, retired: r.retired };
}

// A use file is deleted on its own only when its slip file is confirmed gone at that moment. A slip
// granted (and claimed) after any listing was made still has its <id>.json, so its uses are never
// touched (Codex round 49: a final sweep deleted a new slip's use and gave the use back). Uses only
// appear for a slip whose file exists, and an id never comes back, so "gone now" means gone for good.
function removeLooseUse(d: string, name: string): void {
  const m = USE_FILE.exec(name);
  if (!m) return;
  try {
    fs.lstatSync(path.join(d, m[1] + ".json"));
    return; // the slip is there (or something is in its place): keep its uses
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  rmRegular(path.join(d, name));
}

// ---- cleanup (clear and the daily trim) ----
// Expired and used-up slips are retired whole. Leftovers are removed: use files whose slip is gone,
// .revoked-* files from a cut-short revoke, and temp files over a day old. Active and damaged slips
// are kept (a damaged one stays for the owner to look at; slip revoke removes it).
export interface SlipCleanup {
  retire: { id: string; bytes: number }[];
  files: { file: string; bytes: number }[];
  kept: number;
}

export function planCleanup(now = Date.now()): SlipCleanup {
  const plan: SlipCleanup = { retire: [], files: [], kept: 0 };
  const d = subDir("slips", false); // throws if slips/ is a link or someone else's: then nothing is deleted
  if (!d) return plan;
  const names = fs.readdirSync(d);
  const size = (n: string) => {
    try {
      const st = fs.lstatSync(path.join(d, n));
      return st.isFile() ? { bytes: st.size, mtime: st.mtimeMs } : null;
    } catch {
      return null;
    }
  };
  const ids = new Set(slipIds(d));
  const keys = ids.size ? readSlipKey() : null;
  const profile = profileName();
  const revokedLines = readRevoked(d);
  const revoked = new Set(revokedLines.map((r) => r.id));
  for (const id of ids) {
    const s = readOne(d, id, keys, profile, revoked);
    if (s === null) continue;
    if (s === "damaged" || stateOf(d, s, now).state === "active") {
      plan.kept++;
      continue;
    }
    let bytes = size(id + ".json")?.bytes ?? 0;
    for (const n of names) if (USE_FILE.exec(n)?.[1] === id) bytes += size(n)?.bytes ?? 0;
    plan.retire.push({ id, bytes });
  }
  for (const n of names) {
    const st = size(n);
    if (!st) continue;
    const use = USE_FILE.exec(n);
    if ((use && !ids.has(use[1])) || REVOKED.test(n) || (n.endsWith(".tmp") && st.mtime < now - DAY)) plan.files.push({ file: path.join(d, n), bytes: st.bytes });
  }
  return plan;
}

export function applyCleanup(plan: SlipCleanup, now = Date.now()): void {
  const d = subDir("slips", false);
  if (!d) return;
  for (const r of plan.retire) retire(d, r.id);
  for (const f of plan.files) {
    if (path.dirname(f.file) !== d) continue;
    if (USE_FILE.test(path.basename(f.file))) removeLooseUse(d, path.basename(f.file)); // checked again now
    else rmRegular(f.file);
  }
}

// ---- the API for phase C (forms) ----
// Matching uses the URL the request will actually go to: the caller passes it. It must be https (http
// only on localhost) with no user name or password; its origin must equal the slip's site exactly and
// its path must be covered by the slip's path on whole segments.

export type Refusal = "private_mode" | "pay_never" | "unknown_action" | "bad_url" | "bad_label" | "no_slip" | "unusual_path";
const REFUSALS: Record<Refusal, string> = {
  private_mode: "Private mode: a permission slip is not used, because using one writes a use file and a private session writes nothing.",
  pay_never: PAY_REFUSED.replace(" No slip was made.", ""),
  unknown_action: `That action is not one a slip can allow (${ACTIONS.join(", ")}).`,
  bad_url: "That URL cannot be matched against a slip (it must be https, or http on localhost, with no user name or password).",
  bad_label: "A use label is 1 to 64 characters of a-z, 0-9, \"_\", \".\", \":\" and \"-\", starting with a letter or digit.",
  unusual_path: "That URL's path is not plain (only letters, digits, _ ~ - and single dots between them in each segment), so it could reach a different path than a slip names. No slip is used for it.",
  no_slip: "No permission slip allows this: none of this profile's slips is for this action on this site and path, unexpired, with a use left. Only the owner can grant one (tiresias slip grant).",
};
export interface Refused {
  refused: Refusal;
  message: string;
}
const no = (r: Refusal): Refused => ({ refused: r, message: REFUSALS[r] });

function target(url: unknown): { origin: string; pathname: string } | null {
  if (typeof url !== "string" || url.length > 8192) return null;
  try {
    const u = new URL(url);
    if (!webOk(u) || u.username || u.password) return null;
    return { origin: u.origin, pathname: u.pathname };
  } catch {
    return null;
  }
}

function matches(action: unknown, url: unknown, now: number): Refused | { d: string; keys: SlipKeys; found: SlipView[] } {
  try {
    checkAction(action);
  } catch {
    return no(action === "pay" ? "pay_never" : "unknown_action");
  }
  const t = target(url);
  if (!t) return no("bad_url");
  if (!pathAllowed(url as string) || !PATH_RE.test(t.pathname)) return no("unusual_path"); // Codex round 53: only plain paths are ever matched (allow-list)
  const d = subDir("slips", false);
  if (!d) return no("no_slip");
  const ids = slipIds(d);
  if (!ids.length) return no("no_slip");
  const keys = readSlipKey(); // trouble with the key throws (fail loudly)
  if (!keys) return no("no_slip");
  const profile = profileName();
  const revoked = revokedIds(d); // trouble with the list throws (fail loudly: no slip is used)
  const found: SlipView[] = [];
  for (const id of ids) {
    const s = readOne(d, id, keys, profile, revoked);
    if (!s || s === "damaged" || s.action !== action || s.site !== t.origin || !pathCovers(s.path, t.pathname)) continue;
    const st = stateOf(d, s, now);
    if (st.state === "active") found.push(view(s, st.left));
  }
  found.sort(soonest);
  return found.length ? { d, keys, found } : no("no_slip");
}

// Whether a slip would allow this, without using it (for a preview). Reads only; works in private mode.
export function checkSlip(action: unknown, url: unknown, opts: { now?: number } = {}): { slip_id: string; expires_at: string; uses_left: number } | Refused {
  const m = matches(action, url, opts.now ?? Date.now());
  if ("refused" in m) return m;
  const s = m.found[0];
  return { slip_id: s.id, expires_at: s.expires_at, uses_left: s.uses_left };
}


// Find the matching slip that expires soonest and claim one use of it, atomically: the use is an
// exclusive create of <id>.use-<n> for the lowest free n. The decision is made AFTER the claim, on the
// slip as it is then: if it was revoked, expired or became damaged meanwhile, the use file is removed
// and the next match is tried. A claim writes a history line (tool "slip").
export function claimSlip(
  action: unknown, url: unknown, label: unknown, opts: { agent?: string; private?: boolean; now?: number } = {},
): { slip_id: string; use: number } | Refused {
  if (opts.private || isPrivate()) return no("private_mode");
  if (typeof label !== "string" || !LABEL.test(label)) return no("bad_label");
  const at = () => opts.now ?? Date.now();
  const m = matches(action, url, at());
  if ("refused" in m) return m;
  const profile = profileName();
  for (const cand of m.found) {
    // Upward from the highest use present (v0.5.1): a gap left by a deleted use file is never filled.
    for (let n = cand.uses - cand.uses_left + 1; n <= cand.uses; n++) {
      const file = path.join(m.d, useName(cand.id, n));
      let fd: number;
      try {
        fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW | NONBLOCK, 0o600);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") continue; // taken: try the next n
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return no("no_slip"); // slips/ went away
        throw e;
      }
      try {
        const u = { id: cand.id, use: n, time: new Date(at()).toISOString(), label };
        fs.writeSync(fd, JSON.stringify({ v: 1, ...u, sig: edSign(null, useBytes(u, profile), m.keys.priv).toString("base64url") }));
      } finally {
        fs.closeSync(fd);
      }
      // Decide on the slip as it is now, with this use held.
      const now = readOne(m.d, cand.id, m.keys, profile);
      if (!now || now === "damaged" || Date.parse(now.expires_at) <= at()) {
        rmRegular(file);
        break; // gone, damaged or expired: try the next matching slip
      }
      try {
        history.record({ time: new Date().toISOString(), tool: "slip", url: String(url), agent: opts.agent ?? "tiresias", purpose: label, status: "ok", door: "none", slip: cand.id });
      } catch (e) {
        console.error(`Could not write history: ${(e as Error).message}`);
      }
      return { slip_id: cand.id, use: n };
    }
  }
  return no("no_slip");
}

// A claimed use stays spent, but may leave the queue only while its slip still permits this target.
export function claimedStillValid(claim: { slip_id: string; use: number }, action: string, url: string): boolean {
  const t = target(url);
  const d = subDir("slips", false);
  if (!d || !t || !pathAllowed(url) || !PATH_RE.test(t.pathname)) return false;
  const keys = readSlipKey();
  const profile = profileName();
  const s = readOne(d, claim.slip_id, keys, profile);
  return !!s && s !== "damaged" && s.action === action && s.site === t.origin && pathCovers(s.path, t.pathname)
    && Date.parse(s.expires_at) > Date.now() && claim.use >= 1 && claim.use <= s.uses
    && useVerifies(d, s.id, claim.use, keys, profile);
}
