// SPDX-License-Identifier: Apache-2.0
// Saves run in killable MCP servers. Publish a nonempty lock directory atomically, so even a kill during
// acquisition leaves a named owner. Only ESRCH permits recovery; a live owner is never timed out.
// Recovery removes the dead owner's unique entry, then rmdir: a delayed recoverer cannot remove a new,
// nonempty lock. Config commands keep ownedlock.ts's deliberately manual recovery policy.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NOFOLLOW, NONBLOCK } from "./store.js";

const TRY_MS = 1_000;
const OWNER_RE = /^[1-9][0-9]*-[0-9a-f]{24}$/;
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function dead(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}
function recover(file: string): void {
  const l = file + ".lock";
  try {
    const st = fs.lstatSync(l);
    if (st.isDirectory()) {
      const d = fs.opendirSync(l);
      let owner: string | undefined;
      try {
        const entry = d.readSync();
        if (entry?.isFile() && OWNER_RE.test(entry.name) && d.readSync() === null) owner = entry.name;
      } finally {
        d.closeSync();
      }
      if (!owner || !dead(Number(owner.split("-")[0]))) return;
      releaseLock(file, owner);
    } else if (st.isFile()) {
      // Recover a lock left by the previous saved.ts implementation. unlink cannot remove a new directory.
      const fd = fs.openSync(l, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
      try {
        if (fs.fstatSync(fd).size > 256) return;
        const owner = JSON.parse(fs.readFileSync(fd, "utf8"));
        if (dead(owner?.pid)) fs.unlinkSync(l);
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    // Gone meanwhile, malformed, or not ours: retry acquisition without removing anything else.
  }
}

export function takeLock(file: string, tryMs = TRY_MS): string | null {
  const l = file + ".lock";
  const token = `${process.pid}-${randomBytes(12).toString("hex")}`;
  const tmp = l + "-" + token;
  const until = Date.now() + tryMs;
  try {
    fs.mkdirSync(tmp, { mode: 0o700 });
    fs.closeSync(fs.openSync(path.join(tmp, token), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600));
    for (;;) {
      try {
        fs.renameSync(tmp, l); // replaces an empty recovered directory, never a live nonempty one
        return token;
      } catch (e) {
        if (!["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) return null;
      }
      recover(file);
      if (Date.now() >= until) return null;
      sleepSync(5);
    }
  } catch {
    return null;
  } finally {
    try {
      fs.unlinkSync(path.join(tmp, token));
      fs.rmdirSync(tmp);
    } catch {
      // Renamed into place, or acquisition failed before the owner entry was written.
    }
  }
}
export function stillOwned(file: string, token: string): boolean {
  try {
    return fs.lstatSync(file + ".lock").isDirectory() && fs.lstatSync(path.join(file + ".lock", token)).isFile();
  } catch {
    return false;
  }
}
export function releaseLock(file: string, token: string): void {
  try {
    fs.unlinkSync(path.join(file + ".lock", token));
    fs.rmdirSync(file + ".lock");
  } catch {
    // Gone meanwhile, or a new nonempty lock has already replaced ours.
  }
}
