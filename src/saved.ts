// SPDX-License-Identifier: Apache-2.0
// W-28 (v0.8): save page. A read the owner allows to save keeps the exact bytes it received (and, for a
// rendered read, the HTML Chrome produced) as a snapshot in this profile's saved/ folder, with a manifest
// signed by the profile's slip key, so a receipt can point at the exact bytes it quoted.
//
//   saved/<id>/manifest.json   the manifest (below), signed
//   saved/<id>/received        the final response's body: after chunked framing and Content-Encoding are undone,
//                              before charset decoding (the bytes the reader starts from)
//   saved/<id>/rendered        the rendered HTML (UTF-8), only for a read rendered in this call
//
// Saved bytes are data: never executed, opened in another program, served or rendered. They are only hashed, and
// parsed by the reader inside its sandbox to check a receipt. A file warning saves its fingerprint only (W-20).
// The id is the SHA-256 of the manifest's canonical form without `id`, `receipts` and `sig`; every receipt of the
// read carries it as `snapshot`. Full design: docs/v0.8/save.md.
import fs from "node:fs";
import path from "node:path";
import { randomBytes, sign as edSign, verify as edVerify } from "node:crypto";
import { ensureSlipKey, readSlipKey } from "./keys.js";
import { bound as boundReceipt } from "./receipts.js";
import { DEFAULT_LIMITS, loadLimits, loadSavingMode, type Limits } from "./config.js";
import { NOFOLLOW, NONBLOCK, checkSub, rmRegular, isPrivate, ownFile, profileName, readBounded, readHome, sha256, subDir, PRIVATE_WRITE, PrivateWriteError } from "./store.js";
import { PARSER_VERSION, type Receipt } from "./types.js";

export const MANIFEST_VERSION = 1;
export const MAX_SNAPSHOTS = 1000; // per profile
const MAX_MANIFEST = 4 * 1024 * 1024; // a manifest is the URLs, hashes and the receipts of one read
const MAX_PART = 16 * 1024 * 1024;
const MAX_URL = 8192;
const MAX_CONTENT_TYPE = 64 * 1024; // keep the whole header, including the charset used by decode
const MAX_RECEIPTS = 2000; // per snapshot; a read returns far fewer
const MAX_QUOTE_CHARS = 2 * 1024 * 1024; // all quotes of one manifest together // a stored file is at most the page cap (5 MB by default) or the render's 5 MB of HTML
const ID_RE = /^[0-9a-f]{64}$/;
const PREFIX_RE = /^[0-9a-f]{8,64}$/;
const TMP_RE = /^\.tmp-[0-9a-f]{16}$/;
const PART_NAMES = ["received", "rendered"] as const;
type PartName = (typeof PART_NAMES)[number];
const DAY = 86_400_000;
const SIGN_TAG = "tiresias-saved-page";

export interface SavedPart {
  name: PartName;
  size: number;
  sha256: string;
}
// A file warning's fingerprint (W-20): Tiresias's own values, never the file.
export interface SavedFileFacts {
  kind: string;
  risk: string;
  size: number;
  sha256: string;
}
export interface RenderedFacts {
  mark: string;
  complete: boolean;
  wall_decided: boolean;
}
export interface Manifest {
  v: number;
  id: string;
  profile: string;
  saved_at: string;
  nonce: string;
  url: string;
  source_url: string;
  final_url: string;
  status: number;
  content_type: string;
  read_as: string | null;
  file_flags: string[];
  language_header: string | null;
  parser: number;
  rendered: RenderedFacts | null;
  files: SavedPart[];
  file: SavedFileFacts | null;
  receipts: Receipt[];
  sig: string;
}
const FIELDS = ["v", "id", "profile", "saved_at", "nonce", "url", "source_url", "final_url", "status", "content_type", "read_as", "file_flags", "language_header", "parser", "rendered", "files", "file", "receipts", "sig"].sort().join(",");

// What a read hands over to be saved.
export interface SaveInput {
  url: string;
  source_url: string;
  final_url: string;
  status: number;
  content_type: string;
  read_as: string | null;
  file_flags: string[];
  language_header: string | null;
  received?: Buffer;
  rendered?: { html: string; mark: string; complete: boolean; wallDecided: boolean };
  file?: SavedFileFacts;
}

export type SavedStatus = "saved" | "not_allowed" | "private" | "not_saved" | "over_cap" | "failed";
export type SavedReason = "no_page" | "no_store" | "no_fingerprint" | "too_large" | "key" | "store";
export interface SavedTop {
  status: SavedStatus;
  id?: string;
  files?: number;
  bytes?: number;
  rendered?: true;
  fingerprint_only?: true;
  reason?: SavedReason;
}
export const SAVED_TEXT: Record<SavedStatus, string> = {
  saved: "A signed snapshot of the bytes this read received was saved; each receipt names it (snapshot). The owner can check it with: tiresias saved verify <id>.",
  not_allowed: "Saving was asked for, but the owner has not allowed saving (the saving setting is off, or was turned on in config.json and not yet confirmed; tiresias settings shows which). Nothing was saved. Only the owner can change that, from the command line.",
  private: "Private mode: nothing was saved.",
  not_saved: "Nothing was saved.",
  over_cap: "Nothing was saved: this profile's saved snapshots are at their cap (max_saved_mb or 1,000 snapshots). The owner can remove some with tiresias saved delete.",
  failed: "Saving failed, so nothing was saved; the read itself is unaffected.",
};
const REASON_TEXT: Record<SavedReason, string> = {
  no_page: "There was no page to save (a wall, a price tag, a refusal or an error).",
  no_store: "The site asked that this page not be stored (no-store).",
  no_fingerprint: "The file has no fingerprint (it was stopped by a cap or a time limit).",
  too_large: "The page exceeds a snapshot limit (16 MB per part, 8,192 characters per URL or 64 KB for Content-Type).",
  key: "The profile's slip key, which signs snapshots, could not be used.",
  store: "The snapshot could not be written to the store.",
};
export const savedText = (t: SavedTop): string => (t.reason ? `${SAVED_TEXT[t.status]} ${REASON_TEXT[t.reason]}` : SAVED_TEXT[t.status]);

// ---- canonical form, id, signature and the two fingerprints (track 2, W-08, uses the last two) ----

// JSON with object keys sorted at every level and no spaces. Every manifest value is a string, a whole number,
// a boolean, null, an array or a plain object, so this form is unambiguous.
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}
type Unsigned = Omit<Manifest, "sig">;
type Core = Omit<Manifest, "id" | "receipts" | "sig">;
const coreOf = (m: Unsigned | Manifest): Core => {
  const { id: _i, receipts: _r, sig: _s, ...core } = m as Manifest;
  return core;
};
export const snapshotId = (m: Unsigned | Manifest): string => sha256(canonical(coreOf(m)));
const signedBytes = (m: Unsigned | Manifest): Buffer => {
  const { sig: _s, ...rest } = m as Manifest;
  return Buffer.from(`[${JSON.stringify(SIGN_TAG)},${canonical(rest)}]`, "utf8");
};
// W-08: exactly the bytes a snapshot's signature covers (what its fingerprint hashes; `receipts prove` writes them).
export const snapshotSignedBytes = (m: Unsigned | Manifest): Buffer => signedBytes(m);
// W-08: the fingerprint of a saved snapshot: SHA-256 of exactly the bytes its signature covers.
export const snapshotFingerprint = (m: Unsigned | Manifest): string => `sha256:${sha256(signedBytes(m))}`;
// W-08: the fingerprint of one receipt as recorded (canonical form; `recorded_at` and the log's own fields included
// when present, so a receipts-log line can be fingerprinted as it stands).
export const receiptFingerprint = (r: Receipt | Record<string, unknown>): string => `sha256:${sha256(canonical(r))}`;

// ---- who may save ----

// "ask": a read that asks may save. Checked on every read that asks (a bad setting fails the read, by name).
export function savePolicy(): "ask" | "not_allowed" | "private" {
  if (isPrivate()) return "private";
  return loadSavingMode() === "ask" ? "ask" : "not_allowed";
}

// ---- the folder ----

const savedDir = (create: boolean): string | null => subDir("saved", create);

interface Entry {
  id: string;
  dir: string;
  bytes: number;
  mtime: number;
  extra: boolean; // holds something other than our three file names (never removed whole: see removeDir)
}
const ROOT_BUDGET = MAX_SNAPSHOTS * 2 + 64; // entries of saved/ looked at; more means saved/ holds what is not ours
const CHILD_BUDGET = 8; // entries of one snapshot folder looked at
const OWN_NAMES = new Set<string>(["manifest.json", ...PART_NAMES]);

// Read a folder's entries as a stream, at most `budget` of them (never the whole listing at once, Codex v0.8 round 1).
// null: the folder could not be listed, or it holds more than the budget.
function listBounded(dir: string, budget: number): fs.Dirent[] | null {
  let d: fs.Dir;
  try {
    d = fs.opendirSync(dir);
  } catch {
    return null;
  }
  const out: fs.Dirent[] = [];
  try {
    for (let e = d.readSync(); e !== null; e = d.readSync()) {
      if (out.length >= budget) return null;
      out.push(e);
    }
  } catch {
    return null;
  } finally {
    d.closeSync();
  }
  return out;
}

const gone = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === "ENOENT";

// Every snapshot folder (by name; contents not trusted) and leftover temp folders, with their sizes. `complete` is
// false when anything could not be measured exactly (an unreadable folder, a name or entry that is not ours, a folder
// over its entry budget): then a save is refused, since the caps cannot be checked (fail closed).
function entries(d: string): { snaps: Entry[]; tmps: Entry[]; complete: boolean } {
  const snaps: Entry[] = [];
  const tmps: Entry[] = [];
  const top = listBounded(d, ROOT_BUDGET);
  if (!top) return { snaps, tmps, complete: false };
  let complete = true;
  for (const e of top) {
    const isId = ID_RE.test(e.name);
    if ((!isId && !TMP_RE.test(e.name)) || !e.isDirectory()) {
      complete = false; // not ours: never entered, never removed
      continue;
    }
    const dir = path.join(d, e.name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(dir);
    } catch (err) {
      if (!gone(err)) complete = false; // only a folder that vanished is not counted (Codex v0.8 round 2)
      continue;
    }
    if (!st.isDirectory()) continue;
    let bytes = 0;
    let extra = false;
    const kids = listBounded(dir, CHILD_BUDGET);
    if (!kids) (complete = false), (extra = true);
    else
      for (const k of kids) {
        if (!OWN_NAMES.has(k.name) || !k.isFile()) extra = true;
        try {
          const fst = fs.lstatSync(path.join(dir, k.name));
          if (fst.isFile()) bytes += fst.size;
          else complete = false;
        } catch (err) {
          if (!gone(err)) complete = false; // a file that cannot be measured is not "zero bytes"
        }
      }
    if (extra) complete = false;
    (isId ? snaps : tmps).push({ id: e.name, dir, bytes, mtime: st.mtimeMs, extra });
  }
  return { snaps, tmps, complete };
}

// The identity of a folder as first checked, so each later step can confirm it is still the same folder and not a
// link or another folder swapped in (Node has no openat; each step re-checks, as the rest of the store does).
type Ident = { dev: number; ino: number };
function identOf(dir: string): Ident {
  checkSub(dir); // a plain folder of ours, never a link (throws otherwise)
  const st = fs.lstatSync(dir);
  return { dev: st.dev, ino: st.ino };
}
function sameDir(dir: string, id: Ident): void {
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory() || st.dev !== id.dev || st.ino !== id.ino) throw new SavedError("The saved/ folder changed while it was being used. Nothing more was done.");
}

function writeNew(file: string, data: Buffer): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW | NONBLOCK, 0o600);
  try {
    for (let off = 0; off < data.length; ) off += fs.writeSync(fd, data, off, data.length - off);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// ---- saving ----

// Write one snapshot for a read and stamp `snapshot` on its receipts (only once it is safely written). Never
// throws: saving never fails the read. The caller has checked the owner's setting and private mode.
export function saveSnapshot(input: SaveInput, receipts: Receipt[], limits?: Limits): SavedTop {
  if (isPrivate()) return { status: "private" };
  const parts: { name: PartName; data: Buffer }[] = [];
  if (input.received) parts.push({ name: "received", data: input.received });
  if (input.rendered) parts.push({ name: "rendered", data: Buffer.from(input.rendered.html, "utf8") });
  // Use the verifier's limits before creating a key or writing anything to the store.
  if (parts.some((p) => p.data.length > MAX_PART) || [input.url, input.source_url, input.final_url].some((u) => u.length > MAX_URL) || input.content_type.length > MAX_CONTENT_TYPE)
    return { status: "not_saved", reason: "too_large" };
  let keys;
  try {
    keys = ensureSlipKey();
  } catch {
    return { status: "failed", reason: "key" };
  }
  const unsigned: Unsigned = {
    v: MANIFEST_VERSION, id: "", profile: profileName(), saved_at: new Date().toISOString(), nonce: randomBytes(16).toString("hex"),
    url: input.url, source_url: input.source_url, final_url: input.final_url, status: input.status, content_type: input.content_type,
    read_as: input.read_as, file_flags: [...input.file_flags], language_header: input.language_header ? input.language_header.slice(0, 200) : null,
    parser: PARSER_VERSION,
    rendered: input.rendered ? { mark: input.rendered.mark, complete: input.rendered.complete, wall_decided: input.rendered.wallDecided } : null,
    files: parts.map((p) => ({ name: p.name, size: p.data.length, sha256: sha256(p.data) })),
    file: input.file ? { kind: input.file.kind, risk: input.file.risk, size: input.file.size, sha256: input.file.sha256 } : null,
    receipts: [],
  };
  const id = snapshotId(unsigned);
  unsigned.id = id;
  // The manifest's copies of the receipts, bounded like the receipts log (a cut quote is still an exact substring).
  unsigned.receipts = receipts.slice(0, MAX_RECEIPTS).map((r) => boundReceipt({ ...r, snapshot: id }));
  let manifestBytes: Buffer;
  try {
    manifestBytes = Buffer.from(JSON.stringify({ ...unsigned, sig: edSign(null, signedBytes(unsigned), keys.priv).toString("base64url") }) + "\n", "utf8");
  } catch {
    return { status: "failed", reason: "key" };
  }
  if (manifestBytes.length > MAX_MANIFEST) return { status: "failed", reason: "store" };
  // Everything this snapshot will take on disk, the manifest included (Codex v0.8 round 1).
  const newBytes = parts.reduce((n, p) => n + p.data.length, 0);
  let d: string;
  let dirId: Ident;
  try {
    const lim = limits ?? loadLimits();
    d = savedDir(true)!;
    dirId = identOf(d);
    const { snaps, tmps, complete } = entries(d);
    if (!complete) return { status: "failed", reason: "store" }; // the caps cannot be checked: fail closed
    // Temp folders take disk too (another save in progress, or one left behind): they count (Codex v0.8 round 3).
    const used = [...snaps, ...tmps].reduce((n, e) => n + e.bytes, 0);
    // A save never evicts: a prompt-injected agent saving again and again must not push out older evidence.
    if (snaps.length >= MAX_SNAPSHOTS || used + newBytes + manifestBytes.length > (lim.max_saved_mb ?? DEFAULT_LIMITS.max_saved_mb) * 1024 * 1024) return { status: "over_cap" };
  } catch (e) {
    if (e instanceof PrivateWriteError) return { status: "private" };
    return { status: "failed", reason: "store" };
  }
  const tmpName = `.tmp-${randomBytes(8).toString("hex")}`;
  const tmp = path.join(d, tmpName);
  let made = false;
  try {
    sameDir(d, dirId);
    fs.mkdirSync(tmp, { mode: 0o700 });
    made = true;
    const tmpId = identOf(tmp);
    for (const p of parts) {
      sameDir(d, dirId), sameDir(tmp, tmpId);
      writeNew(path.join(tmp, p.name), p.data);
    }
    sameDir(d, dirId), sameDir(tmp, tmpId);
    writeNew(path.join(tmp, "manifest.json"), manifestBytes);
    sameDir(d, dirId), sameDir(tmp, tmpId);
    fs.renameSync(tmp, path.join(d, id)); // one step: a reader never sees half a snapshot
    made = false;
    sameDir(path.join(d, id), tmpId); // the folder now named by the id is the one just written
  } catch {
    if (made) removeDir(tmp, true);
    return { status: "failed", reason: "store" };
  }
  for (const r of receipts.slice(0, MAX_RECEIPTS)) r.snapshot = id;
  return { status: "saved", id, files: parts.length, bytes: newBytes, ...(input.rendered ? { rendered: true as const } : {}), ...(input.file && !parts.length ? { fingerprint_only: true as const } : {}) };
}

// ---- reading back ----

export class SavedError extends Error {}
const BAD_ID = "A snapshot id is its 64-character hex id, or a unique start of it of at least 8 characters. That id was refused.";

function readFileChecked(file: string, max: number): Buffer | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SavedError(`${path.basename(file)} cannot be read (a link, or not ours).`);
  }
  try {
    ownFile(fd, file);
    return readBounded(fd, max);
  } finally {
    fs.closeSync(fd);
  }
}

const isStr = (x: unknown, max = 8192): x is string => typeof x === "string" && x.length <= max;
const isIso = (x: unknown): x is string => isStr(x, 40) && !Number.isNaN(Date.parse(x)) && new Date(x).toISOString() === x;
const isHex64 = (x: unknown): x is string => typeof x === "string" && ID_RE.test(x);
// The manifest's shape: exactly these fields, each of its type. Values from the web (URLs, the content type, the
// quotes) are only bounded.
function shapeOk(m: unknown): m is Manifest {
  if (!m || typeof m !== "object" || Array.isArray(m)) return false;
  const o = m as Manifest;
  if (Object.keys(o).sort().join(",") !== FIELDS) return false;
  if (o.v !== MANIFEST_VERSION || !isHex64(o.id) || !isStr(o.profile, 32) || !isIso(o.saved_at) || !/^[0-9a-f]{32}$/.test(String(o.nonce))) return false;
  if (!isStr(o.url, MAX_URL) || !isStr(o.source_url, MAX_URL) || !isStr(o.final_url, MAX_URL) || !Number.isSafeInteger(o.status) || !isStr(o.content_type, MAX_CONTENT_TYPE)) return false;
  if (!(o.read_as === null || isStr(o.read_as, 20)) || !(o.language_header === null || isStr(o.language_header, 200)) || !Number.isSafeInteger(o.parser)) return false;
  if (!Array.isArray(o.file_flags) || o.file_flags.length > 20 || !o.file_flags.every((f) => isStr(f, 40))) return false;
  if (o.rendered !== null && !(o.rendered && typeof o.rendered === "object" && isStr(o.rendered.mark, 100) && typeof o.rendered.complete === "boolean" && typeof o.rendered.wall_decided === "boolean" && Object.keys(o.rendered).length === 3)) return false;
  if (!Array.isArray(o.files) || o.files.length > PART_NAMES.length) return false;
  const seen = new Set<string>();
  for (const f of o.files) {
    if (!f || typeof f !== "object" || Object.keys(f).length !== 3 || !(PART_NAMES as readonly string[]).includes(f.name) || seen.has(f.name)) return false;
    if (!Number.isSafeInteger(f.size) || f.size < 0 || f.size > MAX_PART || !isHex64(f.sha256)) return false;
    seen.add(f.name);
  }
  if (o.file !== null && !(o.file && typeof o.file === "object" && isStr(o.file.kind, 40) && isStr(o.file.risk, 10) && Number.isSafeInteger(o.file.size) && isHex64(o.file.sha256) && Object.keys(o.file).length === 4)) return false;
  if (!Array.isArray(o.receipts) || o.receipts.length > MAX_RECEIPTS || o.receipts.reduce((n, r) => n + (typeof r?.quote === "string" ? r.quote.length : 0), 0) > MAX_QUOTE_CHARS || !o.receipts.every((r) => r && typeof r === "object" && isStr(r.quote, 8000) && isStr(r.url, 4096) && (r.snapshot === undefined || isStr(r.snapshot, 64)))) return false;
  return typeof o.sig === "string" && o.sig.length <= 200;
}

function readManifest(dir: string): Manifest | "damaged" {
  const b = readFileChecked(path.join(dir, "manifest.json"), MAX_MANIFEST);
  if (!b) return "damaged";
  try {
    const m = JSON.parse(b.toString("utf8"));
    return shapeOk(m) ? m : "damaged";
  } catch {
    return "damaged";
  }
}

// The snapshot folder for an id or a unique prefix. Throws a SavedError with fixed text otherwise.
export function resolve(idOrPrefix: string): { id: string; dir: string } {
  if (!PREFIX_RE.test(idOrPrefix)) throw new SavedError(BAD_ID);
  const d = savedDir(false);
  const found = d ? entries(d).snaps.filter((e) => e.id.startsWith(idOrPrefix)) : [];
  if (found.length === 0) throw new SavedError("No saved snapshot has that id in this profile.");
  if (found.length > 1) throw new SavedError("More than one saved snapshot starts with that; give more of the id.");
  checkSub(found[0].dir); // a plain folder of ours, never a link
  return { id: found[0].id, dir: found[0].dir };
}

export interface SavedItem {
  id: string;
  saved_at: string | null;
  damaged?: true;
  rendered?: true;
  fingerprint_only?: true;
  files: number;
  bytes: number;
  receipts: number;
}
export interface SavedList {
  status: "ok";
  message: string;
  count: number;
  bytes: number;
  cap_bytes: number;
  page: number;
  pages: number;
  saved: SavedItem[];
  untrusted_content: { urls: { id: string; url: string; final_url: string; content_type: string }[] };
}
const PAGE = 50;
export function list(page = 1): SavedList {
  const d = savedDir(false);
  const snaps = d ? entries(d).snaps : [];
  const items: (SavedItem & { url?: string; final_url?: string; content_type?: string; t: number })[] = snaps.map((e) => {
    const m = readManifest(e.dir);
    if (m === "damaged") return { id: e.id, saved_at: null, damaged: true as const, files: 0, bytes: e.bytes, receipts: 0, t: e.mtime };
    return {
      id: e.id, saved_at: m.saved_at, ...(m.rendered ? { rendered: true as const } : {}), ...(m.file && !m.files.length ? { fingerprint_only: true as const } : {}),
      content_type: m.content_type.slice(0, 200), files: m.files.length, bytes: e.bytes, receipts: m.receipts.length, url: m.url, final_url: m.final_url, t: Date.parse(m.saved_at),
    };
  });
  items.sort((a, b) => b.t - a.t || (a.id < b.id ? -1 : 1));
  const pages = Math.max(1, Math.ceil(items.length / PAGE));
  const slice = items.slice((page - 1) * PAGE, page * PAGE);
  const total = snaps.reduce((n, e) => n + e.bytes, 0);
  return {
    status: "ok",
    message: items.length
      ? `${items.length} saved snapshot${items.length === 1 ? "" : "s"} in this profile, newest first. Check one with: tiresias saved verify <id>.`
      : "No saved snapshots in this profile. A read saves one only when the owner allows saving (tiresias settings set saving ask --confirm \"YES, TURN ON SAVING\") and the read asks (--save).",
    count: items.length,
    bytes: total,
    cap_bytes: (loadLimits().max_saved_mb ?? DEFAULT_LIMITS.max_saved_mb) * 1024 * 1024,
    page,
    pages,
    // Only Tiresias's own values at the top level; the URLs and the server's Content-Type are web text (Codex v0.8 round 1).
    saved: slice.map(({ url: _u, final_url: _f, content_type: _c, t: _t, ...rest }) => rest),
    untrusted_content: { urls: slice.filter((i) => i.url !== undefined).map((i) => ({ id: i.id, url: i.url!, final_url: i.final_url!, content_type: i.content_type! })) },
  };
}

// W-08: every snapshot of this profile whose manifest is whole and whose id checks, with its fingerprint (for
// `tiresias anchor`). A damaged one is skipped: anchoring it would timestamp something that does not verify.
export function anchorable(): { id: string; fingerprint: string }[] {
  const d = savedDir(false);
  if (!d) return [];
  const out: { id: string; fingerprint: string }[] = [];
  for (const e of entries(d).snaps) {
    const m = readManifest(e.dir);
    if (m === "damaged" || m.id !== e.id || snapshotId(m) !== e.id) continue;
    out.push({ id: e.id, fingerprint: snapshotFingerprint(m) });
  }
  return out;
}

export function show(idOrPrefix: string): { status: "ok"; id: string; folder: string; damaged?: true; message: string; untrusted_content: { manifest: Manifest } | null } {
  const { id, dir } = resolve(idOrPrefix);
  const m = readManifest(dir);
  if (m === "damaged") return { status: "ok", id, folder: dir, damaged: true, message: "This snapshot's manifest is damaged or not one of Tiresias's.", untrusted_content: null };
  return {
    status: "ok", id, folder: dir,
    message: "The manifest of this snapshot. The saved bytes are data: Tiresias never opens or runs them, and you should not either; check them with tiresias saved verify.",
    untrusted_content: { manifest: m },
  };
}

export type QuoteCheck = "found" | "not_found" | "not_checked";
export interface VerifyResult {
  id: string;
  ok: boolean;
  manifest: "ok" | "damaged";
  id_matches?: boolean;
  signature?: "ok" | "bad" | "no_key";
  files?: { name: string; ok: boolean; problem?: "missing" | "size" | "hash" }[];
  extra_files?: number;
  receipts?: { n: number; snapshot_matches: boolean; quote: QuoteCheck }[];
  reader?: "same" | "different";
  quotes_unchecked_reason?: "no_bytes" | "parse_failed" | "not_authentic";
  folder?: "unreadable";
  message: string;
}

// The texts a receipt can quote: the title, source headings and every block, never generated labels.
async function readerTexts(m: Manifest, parts: Map<string, Buffer>): Promise<string[] | null> {
  const { parsePage, looksHtml } = await import("./pipeline.js");
  const { decode } = await import("./safety.js");
  let parsed;
  if (m.rendered) {
    const html = parts.get("rendered");
    if (!html) return null;
    const body = html.toString("utf8");
    parsed = (await parsePage("html", body, undefined, m.final_url, m.file_flags as never, true, m.language_header, m.rendered.mark ? { mark: m.rendered.mark, complete: m.rendered.complete, wallDecided: m.rendered.wall_decided } : undefined)).parsed;
  } else {
    const raw = parts.get("received");
    if (!raw || !m.read_as) return null;
    const read = m.read_as as import("./files.js").ReadAs;
    const body = read === "pdf" ? "" : decode(raw, m.content_type || null);
    parsed = (await parsePage(read, body, read === "pdf" ? raw : undefined, m.final_url, m.file_flags as never, looksHtml(m.content_type, body), m.language_header)).parsed;
  }
  const out = [parsed.title];
  for (const s of parsed.sections) {
    if (!s.generated) out.push(s.heading);
    for (const b of s.blocks) out.push(b.text);
  }
  return out;
}

export async function verify(idOrPrefix: string): Promise<VerifyResult> {
  const { id, dir } = resolve(idOrPrefix);
  const m = readManifest(dir);
  if (m === "damaged") return { id, ok: false, manifest: "damaged", message: "The manifest is damaged or not one of Tiresias's: this snapshot cannot be trusted." };
  const idMatches = m.id === id && snapshotId(m) === id;
  let signature: "ok" | "bad" | "no_key" = "bad";
  try {
    const keys = readSlipKey();
    if (!keys) signature = "no_key";
    else {
      const sig = Buffer.from(m.sig, "base64url");
      signature = sig.length === 64 && sig.toString("base64url") === m.sig && edVerify(null, signedBytes(m), keys.pub, sig) ? "ok" : "bad";
    }
  } catch {
    signature = "no_key";
  }
  const parts = new Map<string, Buffer>();
  const files = m.files.map((f) => {
    const b = readFileChecked(path.join(dir, f.name), MAX_PART);
    if (!b) return { name: f.name, ok: false, problem: "missing" as const };
    if (b.length !== f.size) return { name: f.name, ok: false, problem: "size" as const };
    if (sha256(b) !== f.sha256) return { name: f.name, ok: false, problem: "hash" as const };
    parts.set(f.name, b);
    return { name: f.name, ok: true };
  });
  // A folder that cannot be listed whole is not verified (Codex v0.8 round 1): its contents are not known.
  const listing = listBounded(dir, CHILD_BUDGET);
  const unreadable = listing === null;
  const extra = listing ? listing.filter((e) => e.name !== "manifest.json" && !m.files.some((f) => f.name === e.name)).length : 0;
  const filesOk = files.every((f) => f.ok);
  // Quotes are replayed only for a snapshot that is ours: the id, the signature and every file hash checked first
  // (Codex v0.8 round 1: a planted manifest must not choose work for the reader).
  let texts: string[] | null = null;
  let why: VerifyResult["quotes_unchecked_reason"];
  if (m.receipts.length && (!idMatches || signature !== "ok" || !filesOk)) why = "not_authentic";
  else if (m.receipts.length && m.files.length) {
    try {
      texts = await readerTexts(m, parts);
      if (!texts) why = "no_bytes";
    } catch {
      why = "parse_failed";
    }
  } else if (m.receipts.length) why = "no_bytes";
  // A quote must fit within ONE title, heading or block. NUL is ordinary page text, not a separator.
  // Work is bounded by MAX_PART, MAX_RECEIPTS and MAX_QUOTE_CHARS, checked before replay.
  const receipts = m.receipts.map((r, i) => ({
    n: i + 1,
    snapshot_matches: r.snapshot === id,
    quote: (texts ? (texts.some((t) => r.quote.length <= t.length && t.includes(r.quote)) ? "found" : "not_found") : "not_checked") as QuoteCheck,
  }));
  const quotesOk = receipts.every((r) => r.snapshot_matches && r.quote === "found");
  const ok = idMatches && signature === "ok" && filesOk && !unreadable && extra === 0 && quotesOk;
  const reader = m.parser === PARSER_VERSION ? "same" : "different";
  const problems = [
    !idMatches && "the id does not match the manifest",
    signature === "bad" && "the signature does not verify (the manifest was changed, or signed by another key)",
    signature === "no_key" && "this profile has no usable slip key to check the signature with",
    !filesOk && "a saved file is missing or was changed",
    extra > 0 && "the folder holds files the manifest does not list",
    unreadable && "the folder could not be listed whole, so it was not completely checked",
    receipts.some((r) => !r.snapshot_matches) && "a receipt names another snapshot",
    receipts.some((r) => r.quote === "not_found") && `a quote was not found in the saved bytes${reader === "different" ? " (the reader has changed since this snapshot was made, which can explain it)" : ""}`,
    receipts.some((r) => r.quote === "not_checked") && "some quotes could not be checked",
  ].filter((x): x is string => !!x);
  return {
    id, ok, manifest: "ok", id_matches: idMatches, signature, files, ...(extra ? { extra_files: extra } : {}), ...(unreadable ? { folder: "unreadable" as const } : {}), receipts, reader, ...(why ? { quotes_unchecked_reason: why } : {}),
    message: ok
      ? `Verified: the signature, the id and every saved file match, and all ${receipts.length} quotes are in the saved bytes.`
      : `Not verified: ${problems.join("; ")}.`,
  };
}

// Remove one snapshot folder. Only a plain folder of ours named by an id is ever removed; rmSync never follows links.
// Remove one snapshot (or temp) folder: only our own file names inside it, each a plain file, then the folder itself,
// which fails if anything else is in it (never a recursive delete; Codex v0.8 round 1). The folder is checked before
// and between steps to be the same plain folder of ours. Returns false when something was left.
function removeDir(dir: string, quiet = false): boolean {
  try {
    const id = identOf(dir);
    for (const n of OWN_NAMES) {
      sameDir(dir, id);
      rmRegular(path.join(dir, n));
    }
    sameDir(dir, id);
    fs.rmdirSync(dir);
    return true;
  } catch (e) {
    if (quiet) return false;
    throw e instanceof SavedError ? e : new SavedError("A snapshot folder holds files that are not Tiresias's, or could not be removed; it was left as it is.");
  }
}

export function remove(idOrPrefix: string | "all"): { status: "ok"; removed: number; message: string } {
  if (isPrivate()) throw new PrivateWriteError(PRIVATE_WRITE);
  if (idOrPrefix === "all") {
    const d = savedDir(false);
    const { snaps, tmps } = d ? entries(d) : { snaps: [], tmps: [] };
    let removed = 0;
    let left = 0;
    for (const e of snaps) removeDir(e.dir, true) ? removed++ : left++;
    for (const e of tmps) removeDir(e.dir, true);
    return { status: "ok", removed, message: `Removed ${removed} saved snapshots from this profile.${left ? ` ${left} could not be removed (a folder holding files that are not Tiresias's); remove them yourself.` : ""}` };
  }
  const { dir } = resolve(idOrPrefix);
  removeDir(dir);
  return { status: "ok", removed: 1, message: "Removed the saved snapshot." };
}

// ---- cleanup (clear and the daily trim) ----

export interface SavedCleanup {
  remove: { dir: string; bytes: number }[];
  kept: number;
}
// Snapshots past keep_saved_days (by saved_at; the folder's time when the manifest is damaged), temp folders over a
// day old, and, when the owner lowered max_saved_mb below what is kept, the oldest snapshots until under it.
// Never --all or --older-than: snapshots are a deliberate keep (tiresias saved delete removes them).
export function planCleanup(now: number, limits: Limits): SavedCleanup {
  const d = readHome() ? savedDir(false) : null;
  if (!d) return { remove: [], kept: 0 };
  const { snaps, tmps } = entries(d);
  const doomed = new Set<Entry>();
  for (const t of tmps) if (t.mtime < now - DAY) doomed.add(t);
  const aged = snaps.map((e) => {
    const m = readManifest(e.dir);
    return { e, t: m === "damaged" ? e.mtime : Date.parse(m.saved_at) };
  });
  for (const a of aged) if (a.t <= now - (limits.keep_saved_days ?? DEFAULT_LIMITS.keep_saved_days) * DAY) doomed.add(a.e);
  let total = aged.filter((a) => !doomed.has(a.e)).reduce((n, a) => n + a.e.bytes, 0);
  const cap = (limits.max_saved_mb ?? DEFAULT_LIMITS.max_saved_mb) * 1024 * 1024;
  for (const a of aged.filter((x) => !doomed.has(x.e)).sort((x, y) => x.t - y.t)) {
    if (total <= cap) break;
    doomed.add(a.e);
    total -= a.e.bytes;
  }
  return { remove: [...doomed].map((e) => ({ dir: e.dir, bytes: e.bytes })), kept: snaps.filter((e) => !doomed.has(e)).length };
}
export function applyCleanup(plan: SavedCleanup): { removed: number; kept: number; bytes_freed: number } {
  const result = { removed: 0, kept: plan.kept, bytes_freed: 0 };
  for (const r of plan.remove) {
    try {
      removeDir(r.dir);
      result.removed++;
      result.bytes_freed += r.bytes;
    } catch {
      result.kept++; // left for the next run
    }
  }
  return result;
}
