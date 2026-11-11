// SPDX-License-Identifier: Apache-2.0
// N-07: the signing key. One Ed25519 key pair per store. The private half is a JWK file
// in <store>/keys/, owner-only (0600 in a 0700 folder), created exclusively, never printed,
// never logged, and never overwritten without --force. Only the public half is ever shown.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, type KeyObject } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifierFromJWK } from "web-bot-auth/crypto";
import { SigningError, SlipError } from "./errors.js";
import { releaseLock, takeLock } from "./savedlock.js";
import { NOFOLLOW, NONBLOCK, homeDir, isPrivate, ownFile, randomTmp, rmRegular, subDir } from "./store.js";

export const KEY_FILE = "ed25519.private.jwk";

export interface PublicInfo {
  public_jwk: { kty: "OKP"; crv: "Ed25519"; x: string };
  keyid: string;
  directory: { keys: { kty: "OKP"; crv: "Ed25519"; x: string }[] };
}

// A synced folder (OneDrive, iCloud Drive, Dropbox, Google Drive) would copy the private key to
// other machines and the cloud. Judged on the REAL path (links are followed), and only by real
// sync roots and exact folder names, so an unsynced folder that merely has "OneDrive" somewhere in a
// longer name is fine. Returns the reason, or null when the store is somewhere safe.
export function syncedFolderReason(dir = homeDir()): string | null {
  // Only plain paths are judged: full (with a drive on Windows) and without "..". Anything else is
  // refused, because "..", relative paths and links can be combined in ways that are easy to get
  // wrong (Codex rounds 22 and 23), and a wrong answer here puts the key in the cloud.
  if (!plain(dir))
    return `The Tiresias folder is set to "${dir}", which is not a plain full path (it is relative, has no drive, or contains ".."). Set TIRESIAS_HOME to a plain full path, such as ~/.tiresias written out in full, and try again.`;
  const real = realish(dir);
  const parts = real.split(SEP).filter(Boolean);
  const lower = parts.map(fold);
  const named = (x: string) => lower.includes(fold(x));
  let why: string | null = null;
  if (lower.some((x) => x === "onedrive" || x.startsWith("onedrive - "))) why = "a OneDrive folder";
  else if (lower.some((x) => x === "dropbox" || x.startsWith("dropbox ("))) why = "a Dropbox folder"; // "Dropbox (Personal)", "Dropbox (Team)"
  else if (named("Google Drive")) why = "a Google Drive folder";
  else if (named("UBF8T346G9.OneDriveSyncClientSuite")) why = "OneDrive's own storage";
  else if (lower.some((x, i) => x === "library" && (lower[i + 1] === "cloudstorage" || lower[i + 1] === "mobile documents"))) why = "a Library/CloudStorage or iCloud Drive folder";
  else {
    // Roots named by the system: the OneDrive variables (Windows, or anywhere they are set) and
    // the folders Dropbox records in ~/.dropbox/info.json.
    const roots: [string, string][] = [];
    for (const v of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) {
      const root = process.env[v];
      if (root) roots.push([root, `the folder %${v}%`]);
    }
    try {
      // A small regular file written by Dropbox; anything else is ignored.
      const f = path.join(os.homedir(), ".dropbox", "info.json");
      // non-blocking open, so a pipe planted here cannot hang us; fstat then rejects anything not a file
      const fd = fs.openSync(f, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
      let text = "";
      try {
        // checked and read through the same open file, and never more than 64 KB
        if (fs.fstatSync(fd).isFile()) {
          const buf = Buffer.alloc(64 * 1024 + 1);
          let n = 0;
          for (let got = 1; got > 0 && n < buf.length; n += got) got = fs.readSync(fd, buf, n, buf.length - n, n);
          if (n <= 64 * 1024) text = buf.subarray(0, n).toString("utf8");
        }
      } finally {
        fs.closeSync(fd);
      }
      if (text) {
        const info = JSON.parse(text);
        for (const acct of Object.values(info && typeof info === "object" ? info : {})) {
          const p = (acct as { path?: unknown })?.path;
          if (typeof p === "string" && path.isAbsolute(p)) roots.push([p, "a Dropbox folder"]);
        }
      }
    } catch {
      // no Dropbox here
    }
    for (const [root, label] of roots) {
      if (!plain(root)) {
        why = `${label}, which is set to a path Tiresias cannot judge (relative, no drive, or with "..")`;
        break;
      }
      if (inside(root, real)) why = label;
    }
  }
  return why
    ? `The Tiresias folder (${real}) is inside ${why} (a synced folder). Syncing would copy your private signing key to other machines and the cloud. Use a folder that is not synced; the default ~/.tiresias is fine. Set TIRESIAS_HOME to such a folder and try again.`
    : null;
}

// True when `p` is `root` or somewhere below it. Errs toward "inside", because a wrong refusal
// only means choosing another folder while a wrong pass would sync the private key. Two tests,
// either one is enough:
// - by name: the real paths compared without letter case (also covers roots that do not exist yet);
// - by identity: an existing ancestor of `p` IS the root (same device and inode), whatever the
//   spelling, case or links. Identities of 0 are unreliable and are skipped.
function inside(root: string, p: string): boolean {
  const r = realish(root);
  const q = realish(p);
  // Compared folder by folder, so a name that folds to ".." (fullwidth dots) is just a name, never a step up.
  const rs = segments(r);
  const qs = segments(q);
  if (rs.length <= qs.length && rs.every((x, i) => x === qs[i])) return true;
  let id: fs.BigIntStats;
  try {
    id = fs.statSync(root, { bigint: true });
  } catch {
    return false;
  }
  if (id.ino === 0n) return false;
  for (let d = q; ; d = path.dirname(d)) {
    try {
      const st = fs.statSync(d, { bigint: true });
      if (st.ino !== 0n && st.dev === id.dev && st.ino === id.ino) return true;
    } catch {
      // not there yet; keep walking up
    }
    if (path.dirname(d) === d) return false;
  }
}

// Folds the ways one folder name can be spelled: Unicode composed or decomposed (APFS treats "é"
// and "e" + accent as the same name), compatibility forms, and letter case including final sigma.
function fold(x: string): string {
  return x.normalize("NFKD").toUpperCase().toLowerCase().normalize("NFKD");
}

// The folded folder names of an absolute path, root first. On Windows the drive is one segment.
function segments(p: string): string[] {
  return p.split(SEP).filter(Boolean).map(fold);
}

// Folder separators: "/" everywhere, and also "\\" on Windows. On macOS and Linux a backslash is an
// ordinary character in a folder name, so splitting on it would misread the path.
const SEP = process.platform === "win32" ? /[\\/]+/ : /\/+/;

// A plain path: full (on Windows, with its drive or share), and no ".." anywhere.
function plain(p: string): boolean {
  return path.isAbsolute(p) && !p.split(SEP).includes("..") && path.parse(p).root === path.parse(path.resolve(p)).root;
}

// The real path of a plain path: each existing folder is resolved by the system itself
// (realpath.native), the rest is kept as written. With no ".." there is nothing to misread.
function realish(p: string): string {
  const abs = path.resolve(p);
  const top = path.parse(abs).root;
  let cur = top;
  for (const seg of abs.slice(top.length).split(SEP)) {
    if (seg === "" || seg === ".") continue;
    const next = path.join(cur, seg);
    try {
      cur = fs.realpathSync.native(next);
    } catch {
      cur = next; // not there (yet), or unresolvable: keep the name
    }
  }
  return cur;
}

function keysDir(create: boolean): string | null {
  const d = subDir("keys", create); // the current profile's keys/ (W-18)
  if (!d) return null;
  if (create) {
    // checkSub proved it is a real folder owned by us. Tighten a looser mode to 0700.
    const fd = fs.openSync(d, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | NOFOLLOW);
    try {
      if (fs.fstatSync(fd).mode & 0o077) fs.fchmodSync(fd, 0o700);
    } finally {
      fs.closeSync(fd);
    }
  }
  return d;
}

type PrivateJwk = JsonWebKey & { kty: "OKP"; crv: "Ed25519"; d: string; x: string };

const isKey = (j: unknown): j is PrivateJwk =>
  typeof j === "object" && j !== null && (j as JsonWebKey).kty === "OKP" && (j as JsonWebKey).crv === "Ed25519" && typeof (j as JsonWebKey).d === "string" && typeof (j as JsonWebKey).x === "string";

// What a key file is for, so one reader serves the signing key and the slip key (W-05) with the same
// storage rules and fixed texts. `Err` is the error class callers expect.
interface KeyKind {
  label: string; // "signing key" | "slip key"
  refuse: string; // what is refused when the file cannot be used
  fix: string; // how to replace a damaged file
  Err: new (m: string) => Error;
}
const SIGNING: KeyKind = { label: "signing key", refuse: "Refusing to send unsigned requests.", fix: "run `tiresias keys init --force` for a new key", Err: SigningError };

const damagedKey = (k: KeyKind, what: string) => new k.Err(`The ${k.label} file is damaged (${what}). Fix it, or ${k.fix}.`);

// The public key, DERIVED from the private seed. The stored `x` is never trusted: it must match.
function derive(jwk: PrivateJwk, k: KeyKind = SIGNING): PrivateJwk {
  let x: string | undefined;
  try {
    const pub = createPublicKey(createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x }, format: "jwk" })).export({ format: "jwk" });
    x = pub.x;
  } catch {
    throw damagedKey(k, "the key cannot be loaded");
  }
  if (!x || x !== jwk.x) throw damagedKey(k, "its public part does not match its private part");
  return { kty: "OKP", crv: "Ed25519", d: jwk.d, x };
}

export interface KeyState {
  stamp: string; // changes whenever the file changes
  jwk?: PrivateJwk; // present only when the contents were (re)read
  raw?: Record<string, unknown>; // the file's own JSON, for the extra fields of the previous key (v1.1)
}

// Look at the key file, with the FULL set of checks on every call: the store and keys/ folders (real
// folders, ours), the file (a plain file, ours, not readable by others, not a link). Only a file that
// is truly absent returns null ("no key"); anything else wrong is a SigningError. The contents are
// read and derived only when `knownStamp` is not the current stamp.
export function inspectKey(knownStamp?: string): KeyState | null {
  return inspectKeyFile(KEY_FILE, SIGNING, knownStamp);
}

function inspectKeyFile(name: string, k: KeyKind, knownStamp?: string): KeyState | null {
  let d: string | null;
  try {
    d = keysDir(false);
  } catch (e) {
    throw new k.Err(`The ${k.label} folder cannot be used: ${(e as Error).message.replace(/[\r\n]/g, " ").slice(0, 200)}`);
  }
  if (!d) return null;
  const file = path.join(d, name);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new k.Err(`The ${k.label} file cannot be opened (${(e as NodeJS.ErrnoException).code ?? "error"}). ${k.refuse}`);
  }
  try {
    ownFile(fd, file);
    const st = fs.fstatSync(fd);
    if (st.mode & 0o077) throw new k.Err(`The ${k.label} file ${file} can be read by other users. Run: chmod 600 "${file}"`);
    if (st.size > 8192) throw new k.Err(`The ${k.label} file is not a key (too large).`);
    const stamp = `${st.ino}:${st.size}:${st.mtimeMs}`;
    if (stamp === knownStamp) return { stamp };
    let jwk: unknown;
    try {
      jwk = JSON.parse(fs.readFileSync(fd, "utf8"));
    } catch {
      throw damagedKey(k, "not valid JSON");
    }
    if (!isKey(jwk)) throw damagedKey(k, "not an Ed25519 key");
    return { stamp, jwk: derive(jwk, k), raw: jwk as unknown as Record<string, unknown> };
  } catch (e) {
    if (e instanceof k.Err) throw e;
    throw new k.Err(`The ${k.label} file cannot be used (${(e as Error).message.replace(/[\r\n]/g, " ").slice(0, 120)}). ${k.refuse}`);
  } finally {
    fs.closeSync(fd);
  }
}

// The private JWK (with the DERIVED public part), or null if there is no key.
export function readPrivateJwk(): PrivateJwk | null {
  return inspectKey()?.jwk ?? null;
}

export async function publicInfo(jwk: { x: string }, previous?: { x: string } | null): Promise<PublicInfo> {
  const pub = { kty: "OKP" as const, crv: "Ed25519" as const, x: jwk.x };
  const keys = [pub];
  if (previous && previous.x !== jwk.x) keys.push({ kty: "OKP", crv: "Ed25519", x: previous.x });
  return { public_jwk: pub, keyid: (await verifierFromJWK(pub)).keyid, directory: { keys } };
}

export const DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";
export const DIRECTORY_TYPE = "application/http-message-signatures-directory+json";

// A pre-signed directory response (Cloudflare wants the response signed, one signature per key).
// The signature covers only the authority (the Host a verifier asked for), so it can be made now,
// kept as fixed headers on the web server, and served until it expires. Returns public things only.
export async function signDirectory(opts: { host: string; days: number; now?: number }) {
  const raw = opts.host.trim().toLowerCase();
  const bad = () => new Error(`"${opts.host.slice(0, 80)}" is not a host name (use something like raibit.ai, without https:// or a path).`);
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(raw) || raw.length > 255) throw bad();
  // Normalized the way a verifier sees it (RFC 9421 2.2.3): the default port 443 and leading zeros go.
  let host: string;
  try {
    host = new URL(`https://${raw}`).host;
  } catch {
    throw bad();
  }
  if (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > 90) throw new Error("--days must be a whole number from 1 to 90.");
  const now = opts.now ?? Date.now();
  const pub = await publishedKeys(now);
  const created = Math.floor(now / 1000);
  let expires = created + opts.days * 86_400;
  // v1.1: during a rotation's overlap window the directory lists two keys and carries one signature per key.
  // Its signatures end when the window does, so a static copy never keeps publishing the old key past it.
  const signers: PrivateJwk[] = [pub.jwk];
  let capped: string | undefined;
  if (pub.previous) {
    const end = Math.floor(Date.parse(pub.previous.until) / 1000);
    if (end > created) {
      signers.push(pub.previous.jwk);
      if (end < expires) {
        expires = end;
        capped = pub.previous.until;
      }
    }
  }
  const body = { keys: signers.map((j) => ({ kty: "OKP" as const, crv: "Ed25519" as const, x: j.x })) };
  const sigs: string[] = [];
  const inputs: string[] = [];
  for (const [i, j] of signers.entries()) {
    const keyid = (await verifierFromJWK({ kty: "OKP", crv: "Ed25519", x: j.x })).keyid;
    const nonce = randomBytes(64).toString("base64");
    const params = `("@authority";req);created=${created};keyid="${keyid}";alg="ed25519";expires=${expires};nonce="${nonce}";tag="http-message-signatures-directory"`;
    const base = `"@authority";req: ${host}\n"@signature-params": ${params}`;
    const sig = edSign(null, Buffer.from(base), createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: j.d, x: j.x }, format: "jwk" })).toString("base64");
    sigs.push(`sig${i + 1}=:${sig}:`);
    inputs.push(`sig${i + 1}=${params}`);
  }
  return {
    host,
    path: DIRECTORY_PATH,
    created_at: new Date(created * 1000).toISOString(),
    expires_at: new Date(expires * 1000).toISOString(),
    body: JSON.stringify(body, null, 2) + "\n",
    headers: { "Content-Type": DIRECTORY_TYPE, Signature: sigs.join(", "), "Signature-Input": inputs.join(", ") },
    keyid: pub.info.keyid,
    ...(pub.previous && signers.length > 1 ? { previous_keyid: pub.previous.keyid, previous_until: pub.previous.until } : {}),
    ...(capped ? { capped_by_rotation: capped } : {}),
  };
}

// Make a key. Never overwrites unless force. Returns only public facts.
export async function initKey(force = false): Promise<PublicInfo & { file: string; replaced: boolean }> {
  if (isPrivate()) throw new Error("Private mode: nothing is written, so no key is made."); // integration Codex round 2 (v0.8)
  const why = syncedFolderReason();
  if (why) throw new Error(why);
  const d = keysDir(true)!;
  // Codex K.8: replacing the key and dropping the previous one hold the rotation lock, like a rotation does, so a
  // rotation running at the same moment cannot have its freshly kept key deleted.
  const r = withRotateLock(d, 1000, () => initLocked(d, force));
  if (r === BUSY) throw new Error("A key rotation is under way. Try again in a moment. Nothing was changed.");
  return { ...(await publicInfo(r.jwk)), file: r.file, replaced: r.replaced };
}
function initLocked(d: string, force: boolean): { jwk: { x: string }; file: string; replaced: boolean } {
  const file = path.join(d, KEY_FILE);
  let exists = false;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) throw new Error(`${file} exists and is not a plain file. Not touching it.`);
    exists = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (exists && !force)
    throw new Error(`A signing key already exists (${file}). Not replacing it. Use \`tiresias keys init --force\` for a new one; sites that know the old key will stop recognising you until you publish the new directory.`);
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string; d: string };
  const body = Buffer.from(JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d }) + "\n");
  // Exclusive create (never follows or replaces anything); a forced replace goes through a temp file and a rename.
  const target = exists ? randomTmp(file) : file;
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    for (let off = 0; off < body.length; ) off += fs.writeSync(fd, body, off, body.length - off);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(target, { force: true });
    throw e;
  }
  fs.closeSync(fd);
  if (exists) fs.renameSync(target, file);
  // v1.1: a fresh start leaves no earlier key in the directory (a rotation's previous key goes too).
  rmRegular(path.join(d, PREVIOUS_KEY_FILE));
  sweepPreviousTmp(d);
  return { jwk, file, replaced: exists };
}

// ---- v1.1 workstream 4: rotating the signing key ----
// `keys rotate` makes a new key and keeps the old one for an overlap window (default 7 days, 0 to 30), so sites
// that cached the old directory still recognise requests signed before the switch, and so the new directory can
// carry one signature per key, as Cloudflare asks. During the window:
// - new requests are signed with the NEW key only (signing.ts reads only ed25519.private.jwk);
// - keys show, keys directory and keys sign-directory publish both public keys;
// - the old private key is kept in keys/ed25519.previous.jwk (same storage rules), used for nothing but signing
//   the directory response, and deleted when the window ends (at the next keys command that looks) or on
//   `keys rotate --finish`. `--overlap 0` keeps nothing: the old key is gone at once (the choice after a leak).
// A second rotation inside the window is refused until --finish, so no key is ever lost silently.
export const PREVIOUS_KEY_FILE = "ed25519.previous.jwk";
export const DEFAULT_OVERLAP_DAYS = 7;
export const MAX_OVERLAP_DAYS = 30;
const DAY_MS = 86_400_000;
const PREVIOUS: KeyKind = { label: "previous signing key", refuse: "Refusing to publish the key directory.", fix: "run `tiresias keys rotate --finish` to drop it", Err: SigningError };

export interface PreviousKey {
  jwk: PrivateJwk;
  keyid: string;
  rotated_at: string;
  until: string;
}

// Write a private key file whole: a temp file made exclusively (0600, never following a link), synced, then put
// in place by rename (replace) or hard link (exclusive: fails with EEXIST when the name is taken). A reader never
// sees a half-written file. The temp file is always removed.
function writeSecret(file: string, body: Buffer, how: "replace" | "exclusive"): void {
  const tmp = randomTmp(file);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW | NONBLOCK, 0o600);
  try {
    try {
      for (let off = 0; off < body.length; ) off += fs.writeSync(fd, body, off, body.length - off);
      fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (how === "replace") fs.renameSync(tmp, file);
    else fs.linkSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const newKeyBody = (extra: Record<string, string> = {}): { jwk: PrivateJwk; body: Buffer } => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const j = privateKey.export({ format: "jwk" }) as { x: string; d: string };
  const jwk: PrivateJwk = { kty: "OKP", crv: "Ed25519", x: j.x, d: j.d };
  return { jwk, body: Buffer.from(JSON.stringify({ ...jwk, ...extra }) + "\n") };
};

// Rotations hold a lock (savedlock.ts: a dead owner is recovered, a live one never timed out), and anything that
// deletes a previous key holds it too and looks again first. Without it a `keys show` that read the current key just
// before a rotation could take the freshly kept old key for a leftover and delete it (Codex K.1).
export const ROTATE_LOCK = "ed25519.rotate"; // keys/ed25519.rotate.lock
const PREV_TMP = /^ed25519\.previous\.jwk\.[0-9a-f]{16}\.tmp$/;

function withRotateLock<T>(d: string, tryMs: number, fn: () => T, name = ROTATE_LOCK): T | typeof BUSY {
  const lock = path.join(d, name);
  const token = takeLock(lock, tryMs);
  if (!token) return BUSY;
  try {
    return fn();
  } finally {
    releaseLock(lock, token);
  }
}
const BUSY = Symbol("busy");

// A rotation killed between linking the previous-key temp file and removing it leaves a copy of the old private key
// under a temp name (Codex K.2). Only rotations make these, and only under the lock, so under the lock any is a leftover.
function sweepPreviousTmp(d: string): void {
  for (const n of fs.readdirSync(d)) if (PREV_TMP.test(n)) rmRegular(path.join(d, n));
}

// Under the rotation lock: look again, and drop the previous key only if it is STILL expired or the same as the
// current key. Busy (a rotation is running): nothing is deleted.
function cleanPrevious(now: number): void {
  if (isPrivate()) return; // a private session changes nothing; the expired key is only ignored
  const d = keysDir(false);
  if (!d) return;
  withRotateLock(d, 250, () => cleanPreviousLocked(d, now));
}
function cleanPreviousLocked(d: string, now: number): void {
  const s = inspectKeyFile(PREVIOUS_KEY_FILE, PREVIOUS);
  if (s?.jwk) {
    const until = typeof s.raw?.until === "string" ? Date.parse(s.raw.until) : NaN;
    const cur = readPrivateJwk();
    if (now >= until || (cur && cur.x === s.jwk.x)) rmRegular(path.join(d, PREVIOUS_KEY_FILE));
  }
  if (!fs.lstatSync(path.join(d, PREVIOUS_KEY_FILE), { throwIfNoEntry: false })) sweepPreviousTmp(d);
}

// The previous key while its window is open, or null. An expired window, and the leftover of a rotation cut short
// (the same key as the current one), are removed here, under the rotation lock and after a second look; a stale
// `current` from a caller never causes a delete. A damaged file is a SigningError (fix: --finish).
export async function previousKey(now = Date.now(), current: { x: string } | null = readPrivateJwk(), locked = false): Promise<PreviousKey | null> {
  const s = inspectKeyFile(PREVIOUS_KEY_FILE, PREVIOUS);
  if (!s?.jwk) return null;
  const until = typeof s.raw?.until === "string" ? Date.parse(s.raw.until) : NaN;
  const rotated = typeof s.raw?.rotated_at === "string" ? Date.parse(s.raw.rotated_at) : NaN;
  if (Number.isNaN(until) || Number.isNaN(rotated)) throw damagedKey(PREVIOUS, "its overlap dates are missing");
  if (now >= until || (current && current.x === s.jwk.x)) {
    if (locked) {
      const d = keysDir(false);
      if (d) cleanPreviousLocked(d, now);
    } else cleanPrevious(now);
    // Looked at again: a rotation may have finished meanwhile, making this a real previous key after all.
    const again = inspectKeyFile(PREVIOUS_KEY_FILE, PREVIOUS);
    const cur = readPrivateJwk();
    if (!again?.jwk || now >= until || again.jwk.x !== s.jwk.x || !cur || cur.x === s.jwk.x) return null;
  }
  const keyid = (await verifierFromJWK({ kty: "OKP", crv: "Ed25519", x: s.jwk.x })).keyid;
  return { jwk: s.jwk, keyid, rotated_at: new Date(rotated).toISOString(), until: new Date(until).toISOString() };
}

// What the directory publishes now: the current key, plus the previous one while its window is open.
export async function publishedKeys(now = Date.now()): Promise<{ jwk: PrivateJwk; info: PublicInfo; previous: PreviousKey | null }> {
  // A rotation can complete between these reads (and previousKey may await a verifier). Publish
  // only a pair whose current key is still current after all async work. Retrying also leaves the
  // existing busy-lock behaviour of read-only key commands intact.
  for (let attempt = 0; attempt < 4; attempt++) {
    const jwk = readPrivateJwk();
    if (!jwk) throw new Error("No signing key yet. Run: tiresias keys init");
    const previous = await previousKey(now, jwk);
    const info = await publicInfo(jwk, previous?.jwk);
    if (readPrivateJwk()?.x === jwk.x) return { jwk, info, previous };
  }
  throw new Error("The signing key changed while reading the directory. Try again in a moment.");
}

// The overlap value from the command line: whole days, 0 to 30.
export function parseOverlap(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_OVERLAP_DAYS;
  if (!/^\d{1,3}$/.test(raw.trim()) || Number(raw) > MAX_OVERLAP_DAYS) throw new Error(`--overlap takes whole days from 0 to ${MAX_OVERLAP_DAYS} (default ${DEFAULT_OVERLAP_DAYS}).`);
  return Number(raw);
}

export interface RotateResult extends PublicInfo {
  file: string;
  previous_keyid: string;
  overlap_days: number;
  overlap_until: string | null; // null: --overlap 0, the old key is gone already
  rotated_at: string;
}

// Rotate the signing key. Returns only public facts; nothing private is ever returned or printed.
export async function rotateKey(opts: { overlapDays?: number; now?: number } = {}): Promise<RotateResult> {
  if (isPrivate()) throw new Error("Private mode: nothing is written, so no key is rotated.");
  const why = syncedFolderReason();
  if (why) throw new Error(why);
  const days = opts.overlapDays ?? DEFAULT_OVERLAP_DAYS;
  if (!Number.isInteger(days) || days < 0 || days > MAX_OVERLAP_DAYS) throw new Error(`--overlap takes whole days from 0 to ${MAX_OVERLAP_DAYS} (default ${DEFAULT_OVERLAP_DAYS}).`);
  const now = opts.now ?? Date.now();
  if (!readPrivateJwk()) throw new Error("No signing key yet. Run: tiresias keys init");
  const d = keysDir(true)!;
  const r = await withRotateLockAsync(d, () => rotateLocked(d, days, now));
  if (r === BUSY) throw new Error("Another key rotation is under way. Try again in a moment. Nothing was changed.");
  return r;
}

// The lock is synchronous and the key checks are async, so the async version releases in its own finally.
async function withRotateLockAsync<T>(d: string, fn: () => Promise<T>): Promise<T | typeof BUSY> {
  const lock = path.join(d, ROTATE_LOCK);
  const token = takeLock(lock);
  if (!token) return BUSY;
  try {
    return await fn();
  } finally {
    releaseLock(lock, token);
  }
}

async function rotateLocked(d: string, days: number, now: number): Promise<RotateResult> {
  const cur = readPrivateJwk();
  if (!cur) throw new Error("No signing key yet. Run: tiresias keys init");
  const open = await previousKey(now, cur, true);
  if (open)
    throw new Error(`A rotation is still in its overlap window: the previous key (${open.keyid}) stays in your directory until ${open.until}. Run \`tiresias keys rotate --finish\` to drop it now, then rotate again. Nothing was changed.`);
  sweepPreviousTmp(d);
  const file = path.join(d, KEY_FILE);
  const prevFile = path.join(d, PREVIOUS_KEY_FILE);
  const rotatedAt = new Date(now).toISOString();
  const until = days > 0 ? new Date(now + days * DAY_MS).toISOString() : null;
  let kept = false;
  if (until) {
    try {
      writeSecret(prevFile, Buffer.from(JSON.stringify({ kty: "OKP", crv: "Ed25519", x: cur.x, d: cur.d, rotated_at: rotatedAt, until }) + "\n"), "exclusive");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Another rotation is under way (a previous key appeared meanwhile). Run `tiresias keys show` to see where things stand. Nothing was changed.");
      throw e;
    }
    kept = true;
  }
  const fresh = newKeyBody();
  try {
    // `keys init --force` since we read the key: stop, rather than lose a key nobody kept.
    const again = readPrivateJwk();
    if (!again || again.x !== cur.x) throw new Error("The signing key changed while rotating (another rotate or keys init ran). Nothing was replaced. Run `tiresias keys show` and try again.");
    writeSecret(file, fresh.body, "replace");
  } catch (e) {
    if (kept) rmRegular(prevFile);
    throw e;
  }
  const info = await publicInfo(fresh.jwk, until ? cur : null);
  return { ...info, file, previous_keyid: (await publicInfo(cur)).keyid, overlap_days: days, overlap_until: until, rotated_at: rotatedAt };
}

// End the overlap now: the previous key leaves the directory and its private half is deleted.
export async function finishRotation(): Promise<{ finished: boolean; previous_keyid?: string }> {
  if (isPrivate()) throw new Error("Private mode: nothing is written, so nothing is changed.");
  const d = keysDir(false);
  if (!d) return { finished: false };
  const r = await withRotateLockAsync(d, () => finishLocked(d));
  if (r === BUSY) throw new Error("A key rotation is under way. Try again in a moment. Nothing was changed.");
  return r;
}

async function finishLocked(d: string): Promise<{ finished: boolean; previous_keyid?: string }> {
  const file = path.join(d, PREVIOUS_KEY_FILE);
  sweepPreviousTmp(d); // a copy left by a rotation cut short goes too (Codex K.2)
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return { finished: false };
  let keyid: string | undefined;
  try {
    const s = inspectKeyFile(PREVIOUS_KEY_FILE, PREVIOUS);
    if (s?.jwk) keyid = (await verifierFromJWK({ kty: "OKP", crv: "Ed25519", x: s.jwk.x })).keyid;
  } catch {
    // damaged: removed all the same (that is the fix the error message names)
  }
  rmRegular(file);
  if (fs.lstatSync(file, { throwIfNoEntry: false })) throw new Error(`${file} is not a plain file, so it was not removed. Look at it yourself.`);
  return { finished: true, ...(keyid ? { previous_keyid: keyid } : {}) };
}

// ---- W-05: the slip key ----
// A SEPARATE Ed25519 key per profile, used only to sign and check permission slips (slips.ts), never
// for Web Bot Auth. Same storage rules as the signing key: keys/slips.private.jwk, 0600 in a 0700
// folder, never printed, refused when readable by others or not a plain file of ours, refused in a
// synced folder. Made automatically by the first `slip grant`, exclusively: written whole to a temp
// file, then hard-linked to its name (link fails if the name exists, so two first grants at once end
// with one key, and a reader never sees a half-written file).
export const SLIP_KEY_FILE = "slips.private.jwk";
const SLIP: KeyKind = { label: "slip key", refuse: "No permission slip can be used or granted.", fix: "revoke every slip (tiresias slip revoke --all) and delete the file, then grant again", Err: SlipError };

export interface SlipKeys {
  priv: KeyObject;
  pub: KeyObject;
}
const keyObjects = (jwk: PrivateJwk): SlipKeys => {
  const priv = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x }, format: "jwk" });
  return { priv, pub: createPublicKey(priv) };
};

// The slip key, or null when there is none. Any other trouble is a SlipError (fail loudly).
export function readSlipKey(): SlipKeys | null {
  const s = inspectKeyFile(SLIP_KEY_FILE, SLIP);
  return s?.jwk ? keyObjects(s.jwk) : null;
}

// The slip key, made now if there is none. Never replaces an existing key.
export function ensureSlipKey(): SlipKeys {
  const have = readSlipKey();
  if (have) return have;
  const why = syncedFolderReason();
  if (why) throw new SlipError(why.replace("your private signing key", "your private keys"));
  const d = keysDir(true)!;
  const file = path.join(d, SLIP_KEY_FILE);
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string; d: string };
  const body = Buffer.from(JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d }) + "\n");
  const tmp = randomTmp(file);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW | NONBLOCK, 0o600);
  try {
    try {
      for (let off = 0; off < body.length; ) off += fs.writeSync(fd, body, off, body.length - off);
      fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(tmp, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; // another grant made it first: use that one
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const k = readSlipKey();
  if (!k) throw new SlipError("The slip key could not be made.");
  return k;
}

// ---- v1.1 workstream 4: rotating the slip key ----
// The slip key signs permission slips, their use files and saved-page manifests (saved.ts). Replacing it makes
// every existing slip fail its signature check, so slips.rotateSlipKey revokes them all first (and again after,
// for any granted meanwhile). The old key's PUBLIC half is kept in keys/slips.retired.json, so `saved verify` can
// still check snapshots signed before the rotation and say which key signed them. A retired key never checks a
// slip. The private half is gone with the old file.
export const SLIP_RETIRED_FILE = "slips.retired.json";
// Every retired public half is kept (each is under 100 bytes); none is ever dropped (Codex K.5). The caps only stop a
// planted giant file; a rotation that would pass them is refused before anything changes.
const MAX_RETIRED = 100_000;
const MAX_RETIRED_BYTES = 16 * 1024 * 1024;
export const SLIP_ROTATE_LOCK = "slips.rotate"; // keys/slips.rotate.lock
const X_RE = /^[A-Za-z0-9_-]{43}$/;
export interface RetiredSlipKey {
  x: string;
  retired_at: string;
}

// The retired public halves, oldest first. Absent file: none. Anything else wrong is a SlipError.
function readRetired(): RetiredSlipKey[] {
  const d = keysDir(false);
  if (!d) return [];
  const file = path.join(d, SLIP_RETIRED_FILE);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new SlipError(`The list of retired slip keys cannot be opened (${(e as NodeJS.ErrnoException).code ?? "error"}).`);
  }
  try {
    ownFile(fd, file);
    const st = fs.fstatSync(fd);
    if (st.size > MAX_RETIRED_BYTES) throw new SlipError("The list of retired slip keys is too large to be one of Tiresias's.");
    let o: unknown;
    try {
      o = JSON.parse(fs.readFileSync(fd, "utf8"));
    } catch {
      throw new SlipError("The list of retired slip keys is damaged (not valid JSON). Look at keys/slips.retired.json.");
    }
    const keys = (o as { v?: unknown; keys?: unknown })?.keys;
    if ((o as { v?: unknown })?.v !== 1 || !Array.isArray(keys) || keys.length > MAX_RETIRED) throw new SlipError("The list of retired slip keys is damaged. Look at keys/slips.retired.json.");
    return keys.map((k) => {
      const x = (k as RetiredSlipKey)?.x;
      const at = (k as RetiredSlipKey)?.retired_at;
      if (typeof x !== "string" || !X_RE.test(x) || typeof at !== "string" || Number.isNaN(Date.parse(at))) throw new SlipError("The list of retired slip keys is damaged. Look at keys/slips.retired.json.");
      return { x, retired_at: at };
    });
  } catch (e) {
    if (e instanceof SlipError) throw e;
    throw new SlipError(`The list of retired slip keys cannot be used (${(e as Error).message.replace(/[\r\n]/g, " ").slice(0, 120)}).`);
  } finally {
    fs.closeSync(fd);
  }
}

// The retired slip keys as public key objects, newest first, for checking old saved pages only.
export function retiredSlipKeys(): { pub: KeyObject; retired_at: string }[] {
  return readRetired()
    .reverse()
    .map((k) => ({ pub: createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: k.x }, format: "jwk" }), retired_at: k.retired_at }));
}

// Put a new slip key in place of the old one. The old public half goes to the retired list FIRST, so a rotation cut
// short never leaves a saved page that nothing can check. A slip key that cannot be read (damaged, readable by
// others) is replaced all the same, without a retired entry: that is the fix. Callers (slips.rotateSlipKey) revoke
// the slips and check the confirmation; this only swaps the key.
export function replaceSlipKey(now = Date.now(), beforeSwap?: () => void): { had_key: boolean; retired: boolean } {
  if (isPrivate()) throw new SlipError("Private mode: nothing is written, so the slip key is not rotated.");
  const why = syncedFolderReason();
  if (why) throw new SlipError(why.replace("your private signing key", "your private keys"));
  const d = keysDir(true)!;
  // One slip rotation at a time (Codex K.3): two at once could both retire the same old key, losing the middle one.
  const r = withRotateLock(d, 1000, () => replaceSlipLocked(d, now, beforeSwap), SLIP_ROTATE_LOCK);
  if (r === BUSY) throw new SlipError("Another slip key rotation is under way. Try again in a moment. Nothing was changed.");
  return r;
}

function replaceSlipLocked(d: string, now: number, beforeSwap?: () => void): { had_key: boolean; retired: boolean } {
  const file = path.join(d, SLIP_KEY_FILE);
  const had = !!fs.lstatSync(file, { throwIfNoEntry: false });
  let x: string | null = null;
  try {
    x = inspectKeyFile(SLIP_KEY_FILE, SLIP)?.jwk?.x ?? null;
  } catch {
    x = null; // unusable: replaced without a retired entry
  }
  let body: Buffer | null = null;
  if (x) {
    const list = readRetired().filter((k) => k.x !== x);
    list.push({ x, retired_at: new Date(now).toISOString() });
    body = Buffer.from(JSON.stringify({ v: 1, keys: list }) + "\n");
    if (list.length > MAX_RETIRED || body.length > MAX_RETIRED_BYTES)
      throw new SlipError(`The list of retired slip keys is full (${MAX_RETIRED.toLocaleString("en-US")} keys). Rotating again would drop a key that old saved pages need, so it is refused. Nothing was changed.`);
  }
  // Every refusal is above this line: only now do the callers' irreversible steps (revoking the slips) run (Codex K.4).
  beforeSwap?.();
  // Looked at again just before the swap: the key being retired must still be the current one.
  let again: string | null = null;
  try {
    again = inspectKeyFile(SLIP_KEY_FILE, SLIP)?.jwk?.x ?? null;
  } catch {
    again = null;
  }
  if (again !== x) throw new SlipError("The slip key changed while rotating. Nothing was replaced. Run the rotation again.");
  if (body) writeSecret(path.join(d, SLIP_RETIRED_FILE), body, "replace");
  writeSecret(file, newKeyBody().body, "replace");
  return { had_key: had, retired: !!x };
}
