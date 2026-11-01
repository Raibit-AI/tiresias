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
import { NOFOLLOW, NONBLOCK, homeDir, isPrivate, ownFile, randomTmp, subDir } from "./store.js";

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
    return { stamp, jwk: derive(jwk, k) };
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

export async function publicInfo(jwk: { x: string }): Promise<PublicInfo> {
  const pub = { kty: "OKP" as const, crv: "Ed25519" as const, x: jwk.x };
  return { public_jwk: pub, keyid: (await verifierFromJWK(pub)).keyid, directory: { keys: [pub] } };
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
  const jwk = readPrivateJwk();
  if (!jwk) throw new Error("No signing key yet. Run: tiresias keys init");
  const info = await publicInfo(jwk);
  const created = Math.floor((opts.now ?? Date.now()) / 1000);
  const expires = created + opts.days * 86_400;
  const nonce = randomBytes(64).toString("base64");
  const params = `("@authority";req);created=${created};keyid="${info.keyid}";alg="ed25519";expires=${expires};nonce="${nonce}";tag="http-message-signatures-directory"`;
  const base = `"@authority";req: ${host}\n"@signature-params": ${params}`;
  const sig = edSign(null, Buffer.from(base), createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x }, format: "jwk" })).toString("base64");
  return {
    host,
    path: DIRECTORY_PATH,
    created_at: new Date(created * 1000).toISOString(),
    expires_at: new Date(expires * 1000).toISOString(),
    body: JSON.stringify(info.directory, null, 2) + "\n",
    headers: { "Content-Type": DIRECTORY_TYPE, Signature: `sig1=:${sig}:`, "Signature-Input": `sig1=${params}` },
    keyid: info.keyid,
  };
}

// Make a key. Never overwrites unless force. Returns only public facts.
export async function initKey(force = false): Promise<PublicInfo & { file: string; replaced: boolean }> {
  if (isPrivate()) throw new Error("Private mode: nothing is written, so no key is made."); // integration Codex round 2 (v0.8)
  const why = syncedFolderReason();
  if (why) throw new Error(why);
  const d = keysDir(true)!;
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
  return { ...(await publicInfo(jwk)), file, replaced: exists };
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
