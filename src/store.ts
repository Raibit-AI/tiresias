// SPDX-License-Identifier: Apache-2.0
// The local store. Everything Tiresias remembers lives in one folder.
// The folder may sit in a shared or writable place, so: owner-only modes,
// no following symlinks for files, and random exclusive temp names.
import { callContext } from "./context.js";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { TiresiasError } from "./errors.js";

export const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
// Added to every file open: a pipe planted where a file should be then fails at once instead of
// hanging the process. It changes nothing for ordinary files.
export const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;
const checked = new Map<string, string>(); // folder -> "device:inode" last validated
const me = () => (typeof process.getuid === "function" ? process.getuid() : -1);

// Every folder above the store, from the real path up to $HOME (not including
// it) or the root, must be owned by this user or root, and must not be group
// or world writable unless it has the sticky bit (like /tmp).
function checkAncestors(d: string): void {
  let real: string;
  try {
    real = fs.realpathSync.native(d);
  } catch {
    return;
  }
  let home: string | null = null;
  try {
    home = fs.realpathSync.native(os.homedir());
  } catch {
    // no home: walk to the root
  }
  for (let p = path.dirname(real); p !== path.dirname(p); p = path.dirname(p)) {
    if (home && p === home) break;
    const a = fs.lstatSync(p);
    if (me() !== -1 && a.uid !== me() && a.uid !== 0) throw new Error(`${p} is owned by another user, so the Tiresias store under it is not safe.`);
    if (a.mode & 0o022 && !(a.mode & 0o1000)) throw new Error(`${p} is writable by other users, so the Tiresias store under it is not safe.`);
  }
}

// With create = false this is read only: a missing folder returns false, and
// nothing is created or chmodded (the checks still run).
// With mkdir = false a missing folder is never created, even when create (tighten modes) is true:
// a profile folder is made only by `tiresias profile create` (W-18).
function secureDir(d: string, create = true, mkdir = create): boolean {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(d);
  } catch (e) {
    // Only a folder that is truly absent counts as "not there". Any other trouble (no permission,
    // a link loop, a file in the way) is an error, never silently "nothing".
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    if (!create || !mkdir) return false;
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    st = fs.lstatSync(d);
  }
  // Never follow a symlink for the store folder: a chmod would land on its target.
  if (st.isSymbolicLink()) throw new Error(`Tiresias store ${d} is a symlink. Refusing to use it.`);
  if (!st.isDirectory()) throw new Error(`${d} is not a folder`);
  if (me() !== -1 && st.uid !== me()) throw new Error(`Tiresias store ${d} is owned by another user. Refusing to use it.`);
  // Ancestors are checked on EVERY call (a cheap chain of lstat calls), not
  // just the first, because a parent can be loosened or swapped later.
  checkAncestors(d);
  if (!create) return true;
  const id = `${st.dev}:${st.ino}`;
  if (checked.get(d) === id && !(st.mode & 0o077)) return true;
  if (st.mode & 0o077) {
    const fd = fs.openSync(d, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | NOFOLLOW);
    try {
      fs.fchmodSync(fd, 0o700);
    } finally {
      fs.closeSync(fd);
    }
  }
  checked.set(d, id);
  return true;
}

// ---- W-18 profiles ----
// The store ROOT is ~/.tiresias (or TIRESIAS_HOME). The `default` profile is the root itself, laid out
// exactly as before profiles existed. Every other profile is a folder of its own,
// <root>/profiles/<name>/, with its own full layout (cache/, history/, receipts/, bookmarks/,
// handoffs/, keys/, config.json). Two things are SHARED by every profile and always live at the
// root: the Retry-After log (cooldowns.jsonl, a site's rule applies to us whatever the profile) and
// safety/ (the public phishing list, no personal data).
//
// One process serves one profile: the CLI and the MCP server pick it once at start
// (`--profile <name>` or TIRESIAS_PROFILE) with selectProfile(). Every store path below is built
// from storeBase(), so a path cannot be built for the wrong profile by forgetting to ask.
export const PROFILE_RE = /^[a-z0-9-]{1,32}$/;
export const DEFAULT_PROFILE = "default";
export class ProfileError extends TiresiasError {
  readonly kind = "profile";
}
// Fixed text: a refused name is never repeated back.
export const BAD_PROFILE = 'A profile name is 1 to 32 characters of a-z, 0-9 and "-". That name was refused.';
const noProfile = (name: string) =>
  new ProfileError(`The profile "${name}" does not exist. Create it with: tiresias profile create ${name}. Nothing was created.`);

export function checkProfileName(name: unknown): string {
  if (typeof name !== "string" || !PROFILE_RE.test(name)) throw new ProfileError(BAD_PROFILE);
  return name;
}

let selected: string | null = null;
// Fix the profile this process serves (CLI and MCP call it once, at start). `undefined` falls back to
// TIRESIAS_PROFILE, then `default`. An empty TIRESIAS_PROFILE counts as unset.
export function selectProfile(name?: string): string {
  const env = process.env.TIRESIAS_PROFILE;
  selected = checkProfileName(name ?? (env === undefined || env === "" ? DEFAULT_PROFILE : env));
  return selected;
}
// For tests: forget the selection, so TIRESIAS_PROFILE is read again.
export const resetProfile = (): void => {
  selected = null;
};
export function profileName(): string {
  if (selected !== null) return selected;
  const env = process.env.TIRESIAS_PROFILE;
  return checkProfileName(env === undefined || env === "" ? DEFAULT_PROFILE : env);
}

// The profile name for the top level of a reply: absent for `default`, else the validated name
// (Tiresias-made: it matched [a-z0-9-]{1,32}). A broken TIRESIAS_PROFILE stamps nothing; the call
// itself has already failed loudly on it.
export function stampProfile<T>(v: T): T {
  let p: string;
  try {
    p = profileName();
  } catch {
    return v;
  }
  if (p === DEFAULT_PROFILE || !v || typeof v !== "object" || Array.isArray(v)) return v;
  return { ...v, profile: p };
}

// The store root: never a profile's own folder.
export const rootDir = () => process.env.TIRESIAS_HOME ?? path.join(os.homedir(), ".tiresias");
// The folder that holds every non-default profile.
export const PROFILES_FOLDER = "profiles";
export const profilesRoot = () => path.join(rootDir(), PROFILES_FOLDER);
// The pure path of a profile's folder (no checks, nothing created).
export function profileDir(name: string): string {
  checkProfileName(name);
  return name === DEFAULT_PROFILE ? rootDir() : path.join(profilesRoot(), name);
}

// Top-level store entries every profile shares. Everything else belongs to one profile.
export const SHARED = new Set(["cooldowns.jsonl", "cooldowns.old.jsonl", "safety", "hosts"]);
export type Scope = "profile" | "shared";
export const scopeOf = (rel: string): Scope => (SHARED.has(rel.split(/[\\/]/)[0]) ? "shared" : "profile");

// THE one place a store path's base is chosen: the root for shared entries, else the folder of the
// profile this process serves. Pure (no checks).
export function storeBase(scope: Scope = "profile"): string {
  return scope === "shared" ? rootDir() : profileDir(profileName());
}
// The current profile's folder (the root for `default`).
export const homeDir = (): string => storeBase("profile");

// A non-default profile must already exist: a real folder owned by us, not a link, under a real
// profiles/ folder. Missing is a clear error and nothing is created. Never chmods.
function requireProfile(): string {
  const name = profileName();
  const dir = profileDir(name);
  if (name === DEFAULT_PROFILE) return dir;
  if (!secureDir(rootDir(), false)) throw noProfile(name);
  if (!checkSub(profilesRoot())) throw noProfile(name);
  if (!secureDir(dir, false)) throw noProfile(name);
  return dir;
}
// Checks that the profile this process serves can be used (CLI and MCP call it at start).
export const assertProfile = (): string => requireProfile();

// For readers: the store folder if it exists (fully checked), else null.
// Never creates or changes anything, so a read or a dry run leaves no trace.
// A non-default profile that does not exist is an error, not "nothing there".
export function readHome(): string | null {
  const dir = requireProfile();
  return secureDir(dir, false) ? dir : null;
}

// The store root, read only: null when it does not exist yet. For the shared entries.
export function readRoot(): string | null {
  const dir = rootDir();
  return secureDir(dir, false) ? dir : null;
}
const readBase = (scope: Scope): string | null => (scope === "shared" ? readRoot() : readHome());

// Only the store root, for the one write private mode is allowed (a Retry-After
// cooldown line) and for the shared safety/ folder. Creates the root if missing (mode 0700, on
// creation only) and runs the usual checks. It never chmods anything and never creates cache/.
export function ensureRoot(): string {
  const dir = rootDir();
  if (!secureDir(dir, false)) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    secureDir(dir, false); // revalidate whatever is there now
  }
  return dir;
}

// A sub-folder of the store (cache/, history/, receipts/) must be a real folder
// owned by this user, never a symlink. Missing is fine (null). Never creates or chmods.
export function checkSub(d: string): boolean {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(d);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${d} is not a plain folder (a link or a file). Refusing to use it.`);
  if (me() !== -1 && st.uid !== me()) throw new Error(`${d} is owned by another user. Refusing to use it.`);
  return true;
}

// A named sub-folder of the store (cache/, history/, receipts/, bookmarks/, handoffs/, keys/, or the
// shared safety/), validated like every store sub-folder. With create = false nothing is created and
// a missing folder is null. With create = true it is made (mode 0700) if missing: inside the current
// profile's folder, or at the root for a shared one.
export function subDir(name: string, create: boolean): string | null {
  const scope = scopeOf(name);
  if (!create) {
    const h = readBase(scope);
    if (!h) return null;
    const d = path.join(h, name);
    return checkSub(d) ? d : null;
  }
  const d = path.join(scope === "shared" ? ensureRoot() : home(), name);
  if (!checkSub(d)) {
    mkdirOne(d); // never recursive: a removed profile is not brought back (Codex round 46)
    if (!checkSub(d)) throw new Error(`${d} could not be created`);
  }
  return d;
}

// The cache folder if it exists and passes the checks, else null. Every cache
// read, write and deletion goes through this.
export const readCacheDir = (): string | null => subDir("cache", false);

// The current profile's folder, made ready for writing: for `default` the root is created if
// missing; a non-default profile must already exist (it is never created here). Modes are
// tightened to 0700 and cache/ is created.
export function home(): string {
  const dir = requireProfile();
  if (!secureDir(dir, true, profileName() === DEFAULT_PROFILE)) throw noProfile(profileName());
  // cache/ is made with a NON-recursive mkdir: if the profile was removed after the checks above, the
  // mkdir fails (ENOENT) instead of bringing the profile folder back (Codex round 46).
  const cache = path.join(dir, "cache");
  if (!secureDir(cache, true, false)) {
    mkdirOne(cache);
    if (!secureDir(cache, true, false)) throw new Error(`${cache} could not be created`);
  }
  return dir;
}

// One folder, never its parents. A missing parent (a profile removed meanwhile) is an error, so no
// write can recreate a removed profile. Another process making it first is fine.
export function mkdirOne(d: string): void {
  try {
    fs.mkdirSync(d, { mode: 0o700 });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return;
    if (code === "ENOENT" && profileName() !== DEFAULT_PROFILE) throw noProfile(profileName());
    throw e;
  }
}

// A random id for the command line: letters, digits and "_" only, so it can never start with "-" and be
// taken for an option (the slips test flake, 2026-10-20). Each character is one of 63, chosen without bias:
// 24 characters carry about 143 bits, 16 about 96, as the base64url ids they replace did (144 and 96).
const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_";
export function cliSafeId(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b >= 252) continue; // 252 = 4 x 63: keeps every character equally likely
      out += ID_ALPHABET[b % 63];
      if (out.length === length) break;
    }
  }
  return out;
}

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

// A pure path (plus the safety checks if the store exists). Writers call home() themselves.
// `shared` is only for the v0.1.3 cooldown store, which lived in the root's cache/.
export function cachePath(key: string, scope: Scope = "profile"): string {
  if (scope === "profile") readCacheDir(); // throws if cache/ is a link or someone else's
  else {
    // The root's cache/ is validated like any other read (Codex round 46): a link or someone else's
    // folder throws, and the caller skips the legacy store.
    const r = readRoot();
    if (r) checkSub(path.join(r, "cache"));
  }
  return path.join(storeBase(scope), "cache", sha256(key) + ".json");
}

// History and receipts live in one file per UTC day, named by the UTC date of the
// record's own timestamp. The writer's timezone is not recorded but the timestamp
// is, so UTC names stay correct after a timezone change or travel.
export const utcDay = (t: Date | number = Date.now()): string => new Date(t).toISOString().slice(0, 10);

// Local calendar day, "2026-10-16" (what the owner means by "today" in the daily log).
export const localDay = (t: Date | number = Date.now()): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface LogFile {
  rel: string; // relative to the store, e.g. "history/2026-10-16.jsonl"
  day: string | null; // null for the legacy single file
}

// Every file of a log group ("history" or "receipts"), oldest first: the legacy
// v0.1 single file (read only), then the day files. No creation, no changes.
export function listLogs(group: "history" | "receipts"): LogFile[] {
  const h = readHome();
  if (!h) return [];
  const out: LogFile[] = [];
  try {
    if (fs.lstatSync(path.join(h, group + ".jsonl")).isFile()) out.push({ rel: group + ".jsonl", day: null });
  } catch {
    // no legacy file
  }
  // A day folder that is a link, a file or someone else's is an error, not "no data":
  // callers (clear, the history, receipts and log tools) refuse with this message.
  const d = path.join(h, group);
  if (checkSub(d)) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(d).sort();
    } catch {
      // vanished while listing
    }
    for (const n of names) {
      const m = DAY_FILE.exec(n);
      if (m) out.push({ rel: `${group}/${n}`, day: m[1] });
    }
  }
  return out;
}

export function ownFile(fd: number, file: string): void {
  const st = fs.fstatSync(fd);
  if (!st.isFile()) throw new Error(`${file} is not a regular file`);
  if (me() !== -1 && st.uid !== me()) throw new Error(`${file} is owned by another user. Refusing to use it.`);
}

// v0.6 (Codex browse round 1): a JSON file in the store larger than this is never read into memory (a
// planted giant file reads as "no cache"). Every legitimate entry is far below it: a page is capped at 5 MB.
export const MAX_JSON_READ = 64 * 1024 * 1024;
// Read at most `max` bytes from an open file, whatever its size said and however it grows meanwhile (Codex
// browse round 7): null when there is more than `max`.
export function readBounded(fd: number, max: number): Buffer | null {
  if (fs.fstatSync(fd).size > max) return null;
  const parts: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, chunk, 0, chunk.length, null);
    if (n === 0) break;
    total += n;
    if (total > max) return null; // it grew past the limit while being read
    parts.push(chunk.subarray(0, n));
  }
  return Buffer.concat(parts, total);
}
export function readJson<T>(file: string): T | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    ownFile(fd, file);
    const b = readBounded(fd, MAX_JSON_READ);
    if (b === null) return null;
    return JSON.parse(b.toString("utf8")) as T;
  } catch {
    return null; // missing, a symlink, someone else's, or damaged: treat as no cache
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// v0.5.1: private mode fails CLOSED in the store itself, not only at each call site: writeJson and
// appendLine refuse inside a private call; the one exception is the Retry-After cooldown line.
export const PRIVATE_WRITE = "Private mode: Tiresias writes nothing to the store in a private call.";
export class PrivateWriteError extends TiresiasError {
  readonly kind = "private_write";
}
const PRIVATE_EXCEPT = new Set(["cooldowns.jsonl"]);

export function writeJson(file: string, data: unknown): void {
  if (isPrivate()) throw new PrivateWriteError(PRIVATE_WRITE);
  home(); // the store and its cache folder exist and are checked before anything is written
  // Exclusive random temp name (cannot be pre-planted as a symlink), then rename.
  // rename replaces a symlink at the destination instead of following it.
  const tmp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    try {
      const buf = Buffer.from(JSON.stringify(data));
      for (let off = 0; off < buf.length; ) {
        const written = fs.writeSync(fd, buf, off, buf.length - off);
        if (written <= 0) throw new Error("Could not finish writing JSON: no progress.");
        off += written;
      }
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// W-14 private mode. A call that runs inside runPrivate() keeps nothing about
// the visit: no history, no receipts, no page or discovery cache, read or
// write. The only exception is the Retry-After cooldown (cooldown.ts), which
// obeying the site requires. It is checked by the code that would write.
// v0.5.1: the private flag lives in the one call context (context.ts).
export const runPrivate = <T>(fn: () => T): T => callContext.run({ ...callContext.getStore(), private: true }, fn);
// The session itself can be private (TIRESIAS_PRIVATE=1 or --private): that counts everywhere too, so
// there is one way of asking "is this private" (v0.5.1).
export const sessionPrivate = (): boolean => /^(1|true)$/i.test(process.env.TIRESIAS_PRIVATE ?? "");
export const isPrivate = (): boolean => callContext.getStore()?.private === true || sessionPrivate();

// Read a small text file from the store with the same checks as the logs:
// no symlinks, owned by this user. Missing reads as null; other trouble throws.
export function readOwnedText(name: string, maxBytes = 1024 * 1024): string | null {
  const h = readBase(scopeOf(name));
  if (!h) return null;
  return readOwnedFile(path.join(h, name), maxBytes);
}

// The same checks for a file at a path already built from the store (W-18 `profile list` reads each
// profile's own config.json and profile.json this way). Missing reads as null; other trouble throws.
export function readOwnedFile(file: string, maxBytes = 1024 * 1024): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`${file} cannot be read: ${(e as Error).message}`);
  }
  try {
    ownFile(fd, file);
    const b = readBounded(fd, maxBytes); // bounded even if the file grows while it is read (Codex browse round 7)
    if (b === null) throw new Error(`${file} is too large (over ${maxBytes} bytes)`);
    return b.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export const randomTmp = (file: string) => `${file}.${randomBytes(8).toString("hex")}.tmp`;

export const MAX_LOG_READ = 8 * 1024 * 1024;

// Read a JSONL log synchronously (used for cooldowns). Missing, foreign or
// symlinked files read as empty; damaged and blank lines are skipped.
// A file over `maxBytes` is read from its LAST maxBytes only, starting at the
// first full line after the cut, so a runaway log cannot stall a request.
export function readLogSync<T>(name: string, maxBytes = MAX_LOG_READ): T[] {
  const h = readBase(scopeOf(name));
  if (!h) return [];
  const file = path.join(h, name);
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    ownFile(fd, file);
    const size = fs.fstatSync(fd).size;
    let raw: string;
    if (size <= maxBytes) raw = fs.readFileSync(fd, "utf8");
    else {
      const buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, size - maxBytes);
      raw = buf.toString("utf8");
      raw = raw.slice(raw.indexOf("\n") + 1); // drop the partial line at the cut
    }
    const out: T[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // skip a damaged line
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// Delete one cache file: the cache folder must pass its checks and the file must be
// a plain regular file (never a link), so a deletion cannot land outside the store.
export function removeCache(file: string): void {
  const dir = readCacheDir();
  if (!dir || path.dirname(file) !== dir) return;
  rmRegular(file);
}

export function rmRegular(file: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return;
  }
  if (st.isFile()) fs.rmSync(file, { force: true });
}

// `separated` writes a newline BEFORE the record as well as after it, so a
// damaged unterminated line left by a crash can never swallow this record.
// Readers skip the blank lines this makes.
// A shared entry (cooldowns.jsonl) is appended at the root with ensureRoot(): it never chmods and never
// creates cache/, so it is the one write a private call may make.
export function appendLine(name: string, obj: unknown): void {
  if (isPrivate() && !PRIVATE_EXCEPT.has(name)) throw new PrivateWriteError(PRIVATE_WRITE);
  const rootOnly = scopeOf(name) === "shared";
  const h = rootOnly ? ensureRoot() : home();
  const file = path.join(h, name);
  const sub = path.dirname(name);
  if (sub !== ".") {
    const d = path.join(h, sub);
    if (!checkSub(d)) {
      mkdirOne(d); // never recursive (Codex round 46); another process making it first is fine
      if (!checkSub(d)) throw new Error(`${d} could not be created`);
    }
  }
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW | NONBLOCK, 0o600);
  try {
    ownFile(fd, file);
    // v0.6 (Codex browse round 2): a log file with a second hard link could be a file outside the store
    // linked in; it is never written or chmodded.
    if (fs.fstatSync(fd).nlink > 1) throw new Error(`${file} has more than one hard link. Refusing to write to it.`);
    if (!rootOnly) fs.fchmodSync(fd, 0o600);
    // Always start with a newline: a crash can leave an unterminated last line, and this makes
    // sure it cannot swallow this record. Every reader skips the blank lines this makes.
    const buf = Buffer.from("\n" + JSON.stringify(obj) + "\n");
    for (let off = 0; off < buf.length; ) off += fs.writeSync(fd, buf, off, buf.length - off);
  } finally {
    fs.closeSync(fd);
  }
}

export interface LogPage<T> {
  items: T[];
  page: number;
  pages: number;
  total: number;
}

// Stream the log, never loading it whole. Matching lines are packed into pages
// of at most `budget` bytes; only the requested page is kept in memory.
// `names` may be several files (oldest first); they read as one log.
export async function pageLog<T>(names: string | string[], keep: (x: T) => boolean, page = 1, budget = 40_000): Promise<LogPage<T>> {
  const out: LogPage<T> = { items: [], page, pages: 0, total: 0 };
  const h = readHome();
  if (!h) return out;
  let cur = 0;
  let bytes = 0;
  for (const name of Array.isArray(names) ? names : [names]) {
    const file = path.join(h, name);
    let fd: number;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    } catch {
      continue;
    }
    try {
      ownFile(fd, file);
    } catch {
      fs.closeSync(fd); // do not leak the descriptor when the file is rejected
      continue;
    }
    const rl = readline.createInterface({ input: fs.createReadStream(file, { fd, autoClose: true }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let obj: T;
      try {
        obj = JSON.parse(line) as T;
      } catch {
        continue; // skip a damaged line rather than lose the whole log
      }
      if (!keep(obj)) continue;
      out.total++;
      const size = Buffer.byteLength(line, "utf8"); // UTF-8 bytes, not characters (Codex round 38)
      if (cur === 0 || bytes + size > budget) {
        cur++;
        bytes = 0;
      }
      bytes += size;
      if (cur === page) out.items.push(obj);
    }
  }
  out.pages = cur;
  return out;
}

// Accepts "2026-10-01", a full ISO time, or a relative span like "7d" / "24h".
export function parseSince(since?: string): number | null {
  if (!since) return null;
  const rel = /^(\d+)\s*([dh])$/i.exec(since.trim());
  if (rel) {
    const unit = rel[2].toLowerCase() === "d" ? 86_400_000 : 3_600_000;
    return Date.now() - Number(rel[1]) * unit;
  }
  const t = Date.parse(since);
  if (Number.isNaN(t)) throw new Error("Cannot read that date. Use 2026-10-01 or 7d."); // fixed text: the caller's input is never repeated (v0.9 hardening, Codex round 6c)
  return t;
}
