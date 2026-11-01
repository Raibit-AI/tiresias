// SPDX-License-Identifier: Apache-2.0
// W-18: profiles, like Chrome profiles. Separate keys, history, cache, bookmarks, handoff tickets and
// rules (config.json) per profile: per agent, per client, per project.
//
// `default` is the store root, laid out exactly as before profiles existed, so existing stores need
// no migration. Every other profile is <root>/profiles/<name>/ with its own full layout. The layout
// and the rule that picks the folder live in store.ts (storeBase); this file only makes, lists and
// removes profiles. Nothing here is reachable over MCP: an agent cannot switch, make or remove a
// profile, it is fixed when the server starts.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseSignatureAgent } from "./config.js";
import { KEY_FILE } from "./keys.js";
import {
  DEFAULT_PROFILE, NOFOLLOW, NONBLOCK, PROFILE_RE, ProfileError, checkProfileName, checkSub, ensureRoot, profileDir, profilesRoot, readOwnedFile, readRoot, rootDir,
} from "./store.js";

const META = "profile.json"; // { name, created_at }, written once at create
const me = () => (typeof process.getuid === "function" ? process.getuid() : -1);

const PRIVATE = "Private mode: profiles are not created or removed, because a private session creates and changes nothing.";
const DEFAULT_FIXED = 'The "default" profile is the store root itself. It always exists and cannot be created or removed (to empty it, use: tiresias clear --all).';
const missing = (name: string) => new ProfileError(`The profile "${name}" does not exist. Nothing was removed.`);

export interface ProfileInfo {
  name: string;
  folder: string;
  created_at: string | null; // null for `default` (the root predates profiles) or an unreadable profile.json
  signing_key: boolean; // keys/ed25519.private.jwk is there (never any key material)
  signature_agent: string | null; // the origin set in its config.json, or null
  problem?: string; // fixed text when the folder or its config.json cannot be used
}

// Make an empty profile: the folder (mode 0700) and its profile.json. Its sub-folders are made on
// first use, like the root's. Refuses `default`, a bad name, an existing profile, and private mode.
export function create(name: string, priv = false): { name: string; folder: string; created_at: string; message: string } {
  checkProfileName(name);
  if (name === DEFAULT_PROFILE) throw new ProfileError(DEFAULT_FIXED);
  if (priv) throw new ProfileError(PRIVATE);
  ensureRoot();
  const parent = profilesRoot();
  if (!checkSub(parent)) {
    try {
      fs.mkdirSync(parent, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; // made by another process first: recheck
    }
    if (!checkSub(parent)) throw new ProfileError(`${parent} could not be created.`);
  }
  const dir = profileDir(name);
  try {
    fs.mkdirSync(dir, { mode: 0o700 }); // exclusive: fails if anything is already there
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new ProfileError(`The profile "${name}" already exists.`);
    throw e;
  }
  if (!checkSub(dir)) throw new ProfileError(`${dir} could not be created.`);
  const created_at = new Date().toISOString();
  const fd = fs.openSync(path.join(dir, META), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW | NONBLOCK, 0o600);
  try {
    fs.writeSync(fd, JSON.stringify({ name, created_at }) + "\n");
  } finally {
    fs.closeSync(fd);
  }
  return { name, folder: dir, created_at, message: `Made the profile "${name}". Use it with --profile ${name} (or TIRESIAS_PROFILE=${name}). It has no signing key yet: tiresias keys init --profile ${name}.` };
}

function describe(name: string, dir: string): ProfileInfo {
  const info: ProfileInfo = { name, folder: dir, created_at: null, signing_key: false, signature_agent: null };
  try {
    if (name !== DEFAULT_PROFILE) {
      if (!checkSub(dir)) throw new Error("gone");
      const meta = JSON.parse(readOwnedFile(path.join(dir, META), 4096) ?? "null") as { created_at?: unknown } | null;
      if (typeof meta?.created_at === "string" && !Number.isNaN(Date.parse(meta.created_at))) info.created_at = meta.created_at;
    }
  } catch {
    info.problem = "The profile folder or its profile.json cannot be used (a link, a file, someone else's, or damaged).";
    return info;
  }
  try {
    const keys = path.join(dir, "keys");
    if (checkSub(keys)) info.signing_key = fs.lstatSync(path.join(keys, KEY_FILE), { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    info.problem = "The keys/ folder cannot be used (a link, a file or someone else's).";
  }
  try {
    const raw = readOwnedFile(path.join(dir, "config.json"));
    if (raw !== null) {
      const o = JSON.parse(raw) as Record<string, unknown>;
      if (o && typeof o === "object" && Object.hasOwn(o, "signature_agent")) info.signature_agent = parseSignatureAgent(o.signature_agent);
    }
  } catch {
    info.problem = "config.json cannot be read or is not valid.";
  }
  return info;
}

// Every profile: `default` first, then the others by name. Reads only; never creates anything.
export function list(): ProfileInfo[] {
  const out: ProfileInfo[] = [describe(DEFAULT_PROFILE, rootDir())];
  if (!readRoot()) return out;
  const parent = profilesRoot();
  if (!checkSub(parent)) return out;
  for (const n of fs.readdirSync(parent).sort()) if (PROFILE_RE.test(n) && n !== DEFAULT_PROFILE) out.push(describe(n, path.join(parent, n)));
  return out;
}

interface Plan {
  files: { file: string; size: number }[];
  dirs: string[]; // parents before children
  hasKey: boolean;
}

// Walk the profile folder WITHOUT following links. Every entry must be a regular file or a folder
// owned by us; anything else (a link, a pipe, a socket, someone else's file) stops the removal before
// anything is deleted.
function plan(dir: string): Plan {
  const p: Plan = { files: [], dirs: [], hasKey: false };
  const bad = (what: string) => new ProfileError(`The profile folder holds ${what}, so Tiresias will not remove it. Nothing was removed.`);
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    const st = fs.lstatSync(d);
    if (st.isSymbolicLink() || !st.isDirectory()) throw bad("a link where a folder should be");
    if (me() !== -1 && st.uid !== me()) throw bad("a folder owned by another user");
    p.dirs.push(d);
    for (const n of fs.readdirSync(d)) {
      const f = path.join(d, n);
      const rel = path.relative(dir, f);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw bad("a path outside itself"); // cannot happen with readdir names; checked anyway
      const s = fs.lstatSync(f);
      if (s.isSymbolicLink()) throw bad("a link");
      if (me() !== -1 && s.uid !== me()) throw bad("a file owned by another user");
      if (s.isDirectory()) stack.push(f);
      else if (s.isFile()) {
        p.files.push({ file: f, size: s.size });
        if (rel === path.join("keys", KEY_FILE)) p.hasKey = true;
      } else throw bad("something that is not a file or a folder");
    }
  }
  return p;
}

export interface RemoveReport {
  name: string;
  folder: string;
  removed: { files: number; folders: number; bytes: number };
  key_deleted: boolean;
  leftovers_finished: number; // `.removing-*` folders left by an interrupted removal, finished now
  message: string;
}

// An interrupted removal leaves `profiles/.removing-<random>`. Never a profile name (names cannot
// start with "."), finished by the next `profile remove`, reported by `profile list`.
const REMOVING = /^\.removing-[0-9a-f]{16}$/;
export function leftovers(): string[] {
  if (!readRoot() || !checkSub(profilesRoot())) return [];
  return fs.readdirSync(profilesRoot()).filter((n) => REMOVING.test(n)).sort();
}

type Tally = RemoveReport["removed"] & { key: boolean };

// Delete a folder's contents and then the folder, never following a link (Codex round 46). Every folder
// is lstat-checked (a real folder, ours, not a link) just before it is read, and every entry just
// before it is unlinked. Files go first, then sub-folders, deepest last. A link found here (one that
// appeared after the walk) is unlinked itself: unlink never follows it. A process that swaps folders
// inside our own store while this runs is outside the threat model (section 9, the export decision).
function deleteTree(d: string, t: Tally, keyFile: string | null): void {
  const st = fs.lstatSync(d);
  if (st.isSymbolicLink()) {
    fs.unlinkSync(d); // a folder swapped for a link: remove the link itself, never what it points at
    return;
  }
  if (!st.isDirectory() || (me() !== -1 && st.uid !== me())) throw new Error("not a plain folder of ours");
  const subs: string[] = [];
  for (const n of fs.readdirSync(d)) {
    const f = path.join(d, n);
    const s = fs.lstatSync(f, { throwIfNoEntry: false });
    if (!s) continue;
    if (s.isDirectory() && !s.isSymbolicLink()) {
      subs.push(f);
      continue;
    }
    if (me() !== -1 && s.uid !== me()) throw new Error("someone else's file");
    fs.unlinkSync(f); // a file, or a link (removed itself, never followed)
    if (s.isFile()) {
      t.files++;
      t.bytes += s.size;
      if (f === keyFile) t.key = true;
    }
  }
  for (const f of subs) deleteTree(f, t, keyFile);
  fs.rmdirSync(d);
  t.folders++;
}

// Finish the `.removing-*` folders an interrupted removal left. One that still holds a signing key
// is never deleted here (it is a profile whose removal was refused after its rename and whose name was
// taken meanwhile: only its owner decides); it is counted in `kept`.
function finishLeftovers(): { finished: number; kept: string[] } {
  const out = { finished: 0, kept: [] as string[] };
  for (const n of leftovers()) {
    const d = path.join(profilesRoot(), n);
    try {
      if (fs.lstatSync(path.join(d, "keys", KEY_FILE), { throwIfNoEntry: false })) {
        out.kept.push(d);
        continue;
      }
      deleteTree(d, { files: 0, folders: 0, bytes: 0, key: false }, null);
      out.finished++;
    } catch {
      // still in use or damaged: `profile list` keeps reporting it
    }
  }
  return out;
}

const leftoverNote = (l: { finished: number; kept: string[] }) =>
  (l.finished ? ` Finished ${l.finished} earlier removal(s) that had been interrupted.` : "") +
  (l.kept.length ? ` Left ${l.kept.length} interrupted removal(s) that still hold a signing key untouched: ${l.kept.join(", ")}.` : "");

// Delete one profile. Refuses without `yes`, refuses `default`, and refuses a profile with a signing
// key unless `deleteKey`. Leftovers of interrupted removals are finished first, even when `name` does
// not exist (Codex round 47). After a checked walk (and a friendly early refusal for a key), the folder
// is RENAMED to a hidden `.removing-<random>` name inside profiles/ (one atomic step), so the profile is
// gone for every process at once. The key decision is then made AGAIN on the renamed folder, which no
// other process can reach by name (Codex round 47: a key added, or the profile recreated with a key,
// between the first check and the rename was deleted without --delete-key). A refused one is renamed
// back, or, if its name was taken meanwhile, left as it is with nothing deleted. Only then is it deleted,
// the signing key first.
export function remove(name: string, o: { yes?: boolean; deleteKey?: boolean; priv?: boolean } = {}): RemoveReport {
  checkProfileName(name);
  if (name === DEFAULT_PROFILE) throw new ProfileError(DEFAULT_FIXED);
  if (o.priv) throw new ProfileError(PRIVATE);
  if (!o.yes)
    throw new ProfileError(`Removing a profile deletes all of its history, receipts, cached pages, bookmarks, handoff tickets, config and keys. Run again with --yes to confirm. Nothing was removed.`);
  const left = finishLeftovers();
  if (!readRoot() || !checkSub(profilesRoot())) throw new ProfileError(missing(name).message + leftoverNote(left));
  const dir = profileDir(name);
  if (!checkSub(dir)) throw new ProfileError(missing(name).message + leftoverNote(left));
  const keyRefused = () =>
    `The profile "${name}" has a signing key. Removing it deletes the key, and a deleted key cannot be recovered: sites and directories that know it will stop recognising this profile. Run again with --yes --delete-key to remove it anyway.`;
  if (plan(dir).hasKey && !o.deleteKey) throw new ProfileError(`${keyRefused()} Nothing was removed.${leftoverNote(left)}`); // friendly early refusal only
  const gone = path.join(profilesRoot(), `.removing-${randomBytes(8).toString("hex")}`);
  fs.renameSync(dir, gone); // atomic: from here the profile does not exist for anyone
  // Put a refused profile back under its name, unless that name was taken meanwhile.
  const restore = (why: string): never => {
    if (!fs.lstatSync(dir, { throwIfNoEntry: false })) {
      fs.renameSync(gone, dir);
      throw new ProfileError(`${why} Nothing was removed.`);
    }
    throw new ProfileError(
      `${why} Nothing was removed. The name "${name}" was taken by a new folder while this ran, so the profile was left, whole, in ${gone}. To get it back under another name, rename that folder to profiles/<new-name> (for example: mv "${gone}" "${path.join(profilesRoot(), name + "-restored")}"). "tiresias profile remove" never deletes a folder there that holds a signing key.`,
    );
  };
  let second: Plan;
  try {
    second = plan(gone); // the renamed folder: nobody else reaches it by name
  } catch (e) {
    return restore((e as Error).message.replace(/ Nothing was removed\.$/, ""));
  }
  if (second.hasKey && !o.deleteKey) return restore(keyRefused());
  const t: Tally = { files: 0, folders: 0, bytes: 0, key: false };
  const report: RemoveReport = { name, folder: dir, removed: t, key_deleted: false, leftovers_finished: left.finished, message: "" };
  try {
    // The key goes first, so an interrupted removal leaves no key behind in a leftover.
    const keyFile = path.join(gone, "keys", KEY_FILE);
    const k = fs.lstatSync(keyFile, { throwIfNoEntry: false });
    if (k?.isFile() && o.deleteKey) {
      fs.unlinkSync(keyFile);
      t.files++;
      t.bytes += k.size;
      t.key = true;
    }
    deleteTree(gone, t, keyFile);
  } catch (e) {
    throw new ProfileError(
      `The profile "${name}" is removed, but some of its files could not be deleted yet (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}). They are in ${gone}; the next "tiresias profile remove" finishes them.`,
    );
  }
  report.removed = { files: t.files, folders: t.folders, bytes: t.bytes };
  report.key_deleted = t.key;
  report.message =
    `Removed the profile "${name}": ${t.files} files and ${t.folders} folders (${t.bytes} bytes).` +
    (t.key ? " Its signing key was deleted and cannot be recovered." : "") +
    leftoverNote(left) +
    " Shared entries at the store root (the Retry-After log and the Safe Browsing list) were not touched.";
  return report;
}
