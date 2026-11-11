// SPDX-License-Identifier: Apache-2.0
// Saves run in killable MCP servers. Publish a nonempty lock directory atomically, so even a kill during
// acquisition leaves a named owner. Recovery needs proof the owner is gone: ESRCH, or (v1.1, Codex K.9) the pid now
// belongs to a different process than the one whose start stamp the lock recorded. A live owner is never timed out.
// Recovery removes the dead owner's unique entry, then rmdir: a delayed recoverer cannot remove a new,
// nonempty lock. Config commands keep ownedlock.ts's deliberately manual recovery policy.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NOFOLLOW, NONBLOCK } from "./store.js";

const TRY_MS = 1_000;
const OWNER_RE = /^[1-9][0-9]*-[0-9a-f]{24}$/;
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// A process's start stamp, as the kernel recorded it, or null. Format: "<scope>|<value>".
// - Linux: scope = boot id + pid namespace + time namespace (ours), value = start time in clock ticks since boot
//   (/proc/<pid>/stat field 22).
// - Elsewhere: scope = "ps" + host name, value = ps's lstart, printed with TZ=UTC and LC_ALL=C so every reader
//   prints it the same way (Codex r4: time zone and locale change the text).
// The value stays the same for the life of a process whatever the wall clock does, and differs for a later
// process given the same pid.
function scope(): string | null {
  try {
    if (process.platform === "linux") {
      // Codex r5: stat's start time includes the READER's time-namespace offset, so the time namespace is part of
      // the scope too. Kernels without time namespaces have no such link: one shared clock.
      let timeNs = "no-time-ns";
      try {
        timeNs = fs.readlinkSync("/proc/self/ns/time");
      } catch {
        // kept as one shared clock
      }
      return `linux:${fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${fs.readlinkSync("/proc/self/ns/pid")}:${timeNs}`;
    }
    return `ps:${os.hostname()}`;
  } catch {
    return null;
  }
}
function startStamp(pid: number): string | null {
  const sc = scope();
  if (!sc) return null;
  try {
    if (process.platform === "linux") {
      // Only meaningful when this /proc numbers pids the way we do (Codex r6: a procfs mounted for another pid
      // namespace can map our number to someone else) and that pid lives in OUR pid namespace.
      if (fs.readlinkSync("/proc/self") !== String(process.pid)) return null;
      if (fs.readlinkSync(`/proc/${pid}/ns/pid`) !== fs.readlinkSync("/proc/self/ns/pid")) return null;
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      return ticks && /^\d+$/.test(ticks) ? `${sc}|${ticks}` : null;
    }
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", TZ: "UTC", LC_ALL: "C" };
    const t = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000, env, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return t ? `${sc}|${t}` : null;
  } catch {
    return null;
  }
}
let ownStamp: string | null | undefined;
const myStamp = (): string | null => (ownStamp === undefined ? (ownStamp = startStamp(process.pid)) : ownStamp);

// The owner is gone if its pid no longer exists (ESRCH). Codex K.9: a pid can be reused, so when the pid is alive
// and the lock recorded its owner's start stamp, a different stamp on that pid now means a different process,
// but only when the lock was taken in the same scope (same machine and boot, same pid namespace) as ours; a lock
// from another container or host is never judged this way. The wall clock is never used (Codex r3). Anything
// unclear, including an old lock with no stamp or a stamp that cannot be read, counts as alive.
export function dead(pid: number, recordedStamp?: string): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
  if (!recordedStamp) return false;
  const sep = recordedStamp.lastIndexOf("|");
  if (sep < 0) return false;
  const now = startStamp(pid);
  if (now === null) return false;
  const nowSep = now.lastIndexOf("|");
  // Both stamps must come from the same scope, checked on the stamp just read (Codex r6: a host name change
  // between two samples must not turn a scope change into a "different process").
  if (now.slice(0, nowSep) !== recordedStamp.slice(0, sep)) return false;
  return now.slice(nowSep + 1) !== recordedStamp.slice(sep + 1);
}
export const _startStamp = startStamp; // tests

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
      if (!owner) return;
      let stamp: string | undefined;
      try {
        const st = fs.lstatSync(path.join(l, owner));
        if (st.size > 0 && st.size <= 256) stamp = fs.readFileSync(path.join(l, owner), "utf8").trim() || undefined;
      } catch {
        return;
      }
      if (!dead(Number(owner.split("-")[0]), stamp)) return;
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
    const ofd = fs.openSync(path.join(tmp, token), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
    try {
      const stamp = myStamp(); // K.9: who holds this pid, so a later process given the same pid is told apart
      if (stamp) fs.writeSync(ofd, stamp + "\n");
    } finally {
      fs.closeSync(ofd);
    }
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
