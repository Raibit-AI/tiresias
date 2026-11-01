// SPDX-License-Identifier: Apache-2.0
// A short exclusive lock between processes: an O_EXCL lock file next to the file it guards, broken when
// older than LOCK_STALE_MS (its owner died). Used by the spacing file (hosts.ts) and the slip revocation
// list (slips.ts). lock() waits up to LOCK_TRY_MS and returns false if it could not take the lock.
import fs from "node:fs";
import { NOFOLLOW } from "./store.js";

const LOCK_STALE_MS = 5_000;
const LOCK_TRY_MS = 1_000;
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function lock(file: string): boolean {
  const l = file + ".lock";
  const until = Date.now() + LOCK_TRY_MS;
  while (Date.now() < until) {
    try {
      fs.closeSync(fs.openSync(l, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
      try {
        if (Date.now() - fs.lstatSync(l).mtimeMs > LOCK_STALE_MS) fs.rmSync(l, { force: true }); // its owner died
      } catch {
        // gone meanwhile
      }
      sleepSync(5);
    }
  }
  return false;
}

