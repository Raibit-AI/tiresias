// SPDX-License-Identifier: Apache-2.0
// v0.6 (W-29): a lock with an owner, for config.json. lockfile.ts breaks any lock older than 5 seconds, which
// suits the spacing file (held for microseconds) but could let a second config writer in beside a first.
// Here (coordinator's decision after Codex round 3): a lock is NEVER broken automatically. Every way of judging
// a lock "stale" and removing it left a rare interleaving in which two writers both commit (rounds 1 to 3).
// Only config commands take it, and they are owner-only command-line commands, so a person is always there: a
// lock left by a command that crashed is reported with the exact command that deletes it (config.ts).
// - the lock file holds its owner's pid and a random token;
// - release removes it only while it still holds our token, and `stillOwned` lets a writer check, right before
//   it renames its new file into place, that the lock is still its own (a person may have deleted it).
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { NOFOLLOW, NONBLOCK } from "./store.js";

const TRY_MS = 1_000;
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function readToken(l: string): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(l, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 256) return undefined;
    const o = JSON.parse(fs.readFileSync(fd, "utf8"));
    return typeof o?.token === "string" ? o.token : undefined;
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

// Take the lock beside `file`; returns its token, or null if another holds it after TRY_MS.
// `tryMs` 0: one attempt, no waiting (for callers in an event loop that poll on their own).
export function takeLock(file: string, tryMs = TRY_MS): string | null {
  const l = file + ".lock";
  const token = randomBytes(12).toString("hex");
  const until = Date.now() + tryMs;
  for (;;) {
    try {
      const fd = fs.openSync(l, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, token }));
      } finally {
        fs.closeSync(fd);
      }
      return token;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return null;
    }
    if (Date.now() >= until) return null;
    sleepSync(5);
  }
}
export const stillOwned = (file: string, token: string): boolean => readToken(file + ".lock") === token;
export function releaseLock(file: string, token: string): void {
  if (stillOwned(file, token)) fs.rmSync(file + ".lock", { force: true });
}
