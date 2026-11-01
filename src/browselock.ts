// SPDX-License-Identifier: Apache-2.0
// v0.6 Track 2: an owned lock file for the tab session and the shelf day files (Codex browse rounds 3 and 4).
//
// The shared lock helper (lockfile.ts) breaks any lock older than five seconds, so a writer that was paused
// could resume after another process took its lock. Here a lock is NEVER broken while its owner is alive,
// whatever its age, so an owner that has checked `held()` cannot lose the lock before it writes:
//   - the lock file holds a random token and the owner's process id;
//   - it is broken only when that process no longer exists, or when the file holds no owner at all (a lock
//     of ours never does: it is published already filled in, see create);
//   - breaking takes a second exclusive file, `<lock>.break`, so only one process breaks a given lock: it
//     re-reads the lock under `.break` and removes it only if it still holds the same dead owner. Nobody
//     can create a new lock while the dead one is still there, so a live lock is never removed by mistake.
//     A `.break` file left by a breaker that died is itself broken the same way (its owner is gone).
//   - the release deletes the lock only if it still holds the owner's token.
// A process id reused by an unrelated running program keeps a dead owner's lock looking alive; the lock
// then stays busy until the owner deletes it (the busy messages say which file).
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { NOFOLLOW, NONBLOCK, rmRegular } from "./store.js";

export const TRY_MS = 1_000; // how long to wait for a busy lock
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export interface Owned {
  file: string;
  token: string;
}

type Owner = { token: string; pid: number };
function readOwner(l: string): Owner | null | "missing" {
  let fd: number;
  try {
    fd = fs.openSync(l, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : null;
  }
  try {
    const buf = Buffer.alloc(128);
    const n = fs.readSync(fd, buf, 0, 128, 0);
    const m = /^([0-9a-f]{32}) (\d{1,10})$/.exec(buf.subarray(0, n).toString("utf8").trim());
    return m ? { token: m[1], pid: Number(m[2]) } : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}
export const alive = (pid: number): boolean => {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // it exists, it is someone else's
  }
};

// Create `l` exclusively, holding a new token and this process's id. Null if it exists.
// Round 8: the lock appears already filled in. The token is written to a private temp file first, which is
// then hard-linked to the lock's name (link fails if the name exists: as exclusive as O_EXCL), so no other
// process can ever see a lock of ours without its owner in it. An ownerless lock is therefore never ours.
function create(l: string): string | null {
  const token = randomBytes(16).toString("hex");
  const tmp = `${l}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    try {
      fs.writeSync(fd, `${token} ${process.pid}`);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(tmp, l);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw e;
    }
    return token;
  } finally {
    rmRegular(tmp);
  }
}

// Is the lock at `l` dead (its owner gone)? `seen` is what was read, for the re-check under `.break`.
function dead(l: string, now: number): { seen: Owner | null } | false {
  // Only a plain file is a lock. Anything else at that path (a link, a folder) is never "dead": it is left
  // for the owner, and the lock stays busy (Codex browse round 6: breaking it could never succeed).
  try {
    if (!fs.lstatSync(l).isFile()) return false;
  } catch {
    return false;
  }
  const o = readOwner(l);
  if (o === "missing") return false;
  if (o === null) return { seen: null }; // never one of ours: our locks appear with their owner already in them
  return alive(o.pid) ? false : { seen: o };
}
const same = (a: Owner | null | "missing", b: Owner | null) => (a === null || b === null ? a === b : a !== "missing" && a.token === b.token && a.pid === b.pid);

// Break the lock at `l` if it is dead, as the only breaker. Returns true when it was removed. `clear` uses
// this too, so it never removes a lock another process has just taken over (Codex browse round 5).
export function breakDead(l: string, now: number, depth = 0): boolean {
  const d = dead(l, now);
  if (!d) return false;
  const b = l + ".break";
  let bt = create(b);
  if (bt === null) {
    // Another breaker is at work, or one died: break its `.break` the same way (once, not recursively deeper).
    if (depth === 0 && breakDead(b, now, 1)) bt = create(b);
    if (bt === null) return false;
  }
  try {
    if (!same(readOwner(l), d.seen)) return false; // it changed: not ours to remove
    rmRegular(l);
    return readOwner(l) === "missing"; // broken only once it is really gone (Codex browse round 6)
  } finally {
    if (readOwner(b) !== "missing" && same(readOwner(b), { token: bt, pid: process.pid })) rmRegular(b);
  }
}

// Take the lock for `file` (its lock is `file + ".lock"`). Null when it stays busy for TRY_MS.
// `tryMs` 0 makes one attempt (plus breaking a dead lock) and never waits: what clear uses (round 8).
export function acquire(file: string, now: () => number = Date.now, tryMs = TRY_MS): Owned | null {
  const l = file + ".lock";
  const until = now() + tryMs;
  // Round 10: a dead lock is broken and the lock taken again at once, even with tryMs 0; breaking counts only
  // when the lock is confirmed gone, and at most a few times per call, so this can never loop for long.
  for (let breaks = 0; ; ) {
    let token: string | null;
    try {
      token = create(l);
    } catch {
      return null;
    }
    if (token) return { file: l, token };
    if (breaks < 3 && breakDead(l, now())) {
      breaks++;
      continue;
    }
    if (now() >= until) return null; // the deadline is checked on every turn, whatever happened
    sleepSync(5);
  }
}

// Is the lock still ours? Checked right before a change is committed. A live owner never loses its lock,
// so this guards against a lock file deleted or replaced by hand.
export const held = (o: Owned): boolean => {
  const r = readOwner(o.file);
  return r !== null && r !== "missing" && r.token === o.token;
};

// Release: only our own lock is deleted.
export function release(o: Owned): void {
  if (held(o)) rmRegular(o.file);
}

// For clear: a lock file (or `.break` file) whose owner is gone. A live owner's lock is never removed.
export const leftover = (l: string, now = Date.now()): boolean => !!dead(l, now);
