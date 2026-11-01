// SPDX-License-Identifier: Apache-2.0
// N-06 (v0.5.1): default politeness shared across processes. Each site (origin) has a small spacing file
// in the shared hosts/ folder at the store root, holding the earliest time the next request to it may
// start. A request reserves its slot under a short exclusive lock (an O_EXCL lock file, broken when
// older than LOCK_STALE_MS), so the CLI and the MCP server running side by side space their requests
// to one site as one queue does. Private mode and form_preview read the spacing but never write it (a
// private visit leaves no trace of which site it called; a preview writes nothing); their spacing then
// holds within the process only.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Refused } from "./errors.js";
import { holdLease } from "./lifetime.js";
import { lock } from "./lockfile.js";
import { releaseLock, takeLock } from "./ownedlock.js";
import { currentReadOnly } from "./safety.js";
import { NOFOLLOW, NONBLOCK, ensureRoot, isPrivate, ownFile, readRoot, sha256, checkSub, mkdirOne } from "./store.js";

export const HOSTS = "hosts";
export const DEFAULT_SPACING_MS = 1_000;

// The least time between two requests to one site. One second by default; TIRESIAS_HOST_SPACING_MS
// changes it only under Node's test runner (the suite reads its own local servers many times a second).
export function spacingMs(): number {
  const v = process.env.TIRESIAS_HOST_SPACING_MS;
  if (process.env.NODE_TEST_CONTEXT && v !== undefined && /^\d{1,6}$/.test(v)) return Number(v);
  return DEFAULT_SPACING_MS;
}

const fileOf = (dir: string, origin: string) => path.join(dir, sha256(origin).slice(0, 32));

// The earliest start the shared file allows for a request wanting `spacing` ms: after the next slot the
// last reservation left, AND `spacing` after that reservation's own start (Codex round 69: a 1-second
// reservation must not let a 30-second Crawl-delay request start a second later).
// The spacing file, read safely (no links, no blocking, a regular file of ours, at most 256 bytes).
function readSpacing(file: string): { last: number; next: number } {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch {
    return { last: 0, next: 0 };
  }
  try {
    ownFile(fd, file);
    if (fs.fstatSync(fd).size > 256) return { last: 0, next: 0 };
    const o = JSON.parse(fs.readFileSync(fd, "utf8"));
    const next = Number(o?.next);
    const last = Number(o?.last);
    return { last: Number.isFinite(last) ? last : 0, next: Number.isFinite(next) ? next : 0 };
  } catch {
    return { last: 0, next: 0 };
  } finally {
    fs.closeSync(fd);
  }
}
function readNext(file: string, spacing: number): number {
  const { last, next } = readSpacing(file);
  return Math.max(next, last ? last + spacing : 0);
}

// Reserve the next slot for `origin` with `spacing` ms between starts and return when it begins (epoch
// ms). `earliest` is this process's own earliest time. Store trouble never fails a request: the slot is
// then this process's own.
export function reserve(origin: string, spacing: number, earliest: number): number {
  const now = Date.now();
  let dir: string | null;
  try {
    if (isPrivate() || currentReadOnly()) {
      const r = readRoot();
      dir = r && checkSub(path.join(r, HOSTS)) ? path.join(r, HOSTS) : null;
      return Math.max(now, earliest, dir ? readNext(fileOf(dir, origin), spacing) : 0);
    }
    const root = ensureRoot();
    dir = path.join(root, HOSTS);
    if (!checkSub(dir)) {
      mkdirOne(dir);
      if (!checkSub(dir)) return Math.max(now, earliest);
    }
  } catch {
    return Math.max(now, earliest);
  }
  const file = fileOf(dir, origin);
  const held = lock(file);
  // No lock: the shared file is NOT written (Codex round 75), and this request takes the slot after the
  // one the file shows, one spacing later, to stay clear of whoever holds the lock.
  if (!held) return Math.max(now, earliest, readNext(file, spacing)) + spacing;
  try {
    const slot = Math.max(now, earliest, readNext(file, spacing));
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
      try {
        fs.writeSync(fd, JSON.stringify({ v: 1, last: slot, next: slot + spacing }));
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
    } catch {
      fs.rmSync(tmp, { force: true });
    }
    return slot;
  } finally {
    fs.rmSync(file + ".lock", { force: true });
  }
}

// One request at a time across processes too (Codex round 75): while a request to a site is being
// answered, a small "active" file (the owner's pid and the time) sits beside its spacing file; others wait
// until it is gone. A file whose process is gone, or that is older than a call can live (75 s), is broken.
// Private calls and previews wait for it but never write it. Store trouble never blocks a request.
// v0.6 (coordinator's decision after Codex round 8): a lease is NEVER taken from a live process, however old it
// is; a lease whose process is gone is stale at once. Only a lease whose owner cannot be told (no process id) is
// judged by age, after this long (longer than any holder can live: a background job lasts up to 240 seconds).
// Residual, accepted and told to the user when a wait gives up: if an unrelated program reuses the process
// number, the site stays blocked until that program ends or the daily cleanup clears the lease file.
export const ACTIVE_STALE_MS = 300_000;
// How long a request waits for another live process's lease before giving up with that explanation.
// TIRESIAS_LEASE_WAIT_MS changes it only under Node's test runner.
export function leaseWaitMs(): number {
  const v = process.env.TIRESIAS_LEASE_WAIT_MS;
  if (process.env.NODE_TEST_CONTEXT && v !== undefined && /^\d{1,6}$/.test(v)) return Number(v);
  return 50_000;
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};
// v0.6 (Codex round 10): ONE bounded reader for lease metadata: no links followed, no blocking (a FIFO), a
// regular file of ours, at most 256 bytes; anything else reads as nothing.
export function readLeaseMeta(f: string): { pid?: number; token?: string } | undefined {
  let fd: number;
  try {
    fd = fs.openSync(f, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 256) return undefined;
    ownFile(fd, f);
    const o = JSON.parse(fs.readFileSync(fd, "utf8"));
    const pid = Number(o?.pid);
    return { pid: Number.isSafeInteger(pid) && pid > 0 ? pid : undefined, token: typeof o?.token === "string" ? o.token : undefined };
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}
const leaseToken = (f: string): string | undefined => readLeaseMeta(f)?.token;
// Read like every store file (Codex round 84): no links followed, no blocking (a FIFO), a regular file of
// ours, a few bytes at most. Anything else at that name is not a lease and counts as stale (removable).
function activeStale(f: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(f, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ENOENT"; // a link or something else at the name
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 256) return true;
    try {
      ownFile(fd, f);
    } catch {
      return true;
    }
    let pid = NaN;
    try {
      pid = Number(JSON.parse(fs.readFileSync(fd, "utf8"))?.pid);
    } catch {
      pid = NaN; // being written, or damaged: judged by age alone
    }
    if (!Number.isSafeInteger(pid) || pid <= 0) return Date.now() - st.mtimeMs > ACTIVE_STALE_MS;
    return pid !== process.pid && !alive(pid); // never for its age while its process lives
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

// A delay learned from robots.txt reaches other processes too (Codex round 84): the shared file's next
// slot is moved to `until` if later. Never in private mode or a preview; no write without the lock.
export function extendNext(origin: string, until: number): void {
  if (isPrivate() || currentReadOnly()) return;
  try {
    const r = readRoot();
    const dir = r && checkSub(path.join(r, HOSTS)) ? path.join(r, HOSTS) : null;
    if (!dir) return;
    const file = fileOf(dir, origin);
    if (!lock(file)) return;
    try {
      const { last, next } = readSpacing(file);
      if (until <= next) return;
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
      try {
        fs.writeSync(fd, JSON.stringify({ v: 1, last, next: until }));
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
    } finally {
      fs.rmSync(file + ".lock", { force: true });
    }
  } catch {
    // housekeeping never fails a call
  }
}
// v0.6 (Codex round 11, coordinator's decision): a held turn's completion is recorded WHOLE in the shared file:
// last = the completion time, next = the later of the old next and completion + delay. Every reader, whatever
// spacing it needs, then measures from the last completion. Never in private mode or a preview; under the lock.
export function noteCompletion(origin: string, t: number, until: number): void {
  if (isPrivate() || currentReadOnly()) return;
  try {
    const r = readRoot();
    const dir = r && checkSub(path.join(r, HOSTS)) ? path.join(r, HOSTS) : null;
    if (!dir) return;
    const file = fileOf(dir, origin);
    if (!lock(file)) return;
    try {
      const { last, next } = readSpacing(file);
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
      try {
        fs.writeSync(fd, JSON.stringify({ v: 1, last: Math.max(last, t), next: Math.max(next, until) }));
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
    } finally {
      fs.rmSync(file + ".lock", { force: true });
    }
  } catch {
    // housekeeping never fails a call
  }
}
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => (signal.removeEventListener("abort", stop), resolve()), ms);
    const stop = () => (clearTimeout(t), reject(signal.reason));
    signal.addEventListener("abort", stop, { once: true });
  });
export async function acquireActive(origin: string, signal: AbortSignal): Promise<() => void> {
  let dir: string | null = null;
  try {
    if (!isPrivate() && !currentReadOnly()) {
      // A writer makes hosts/ first, so the very first request to a site holds its lease too (round 77).
      const root = ensureRoot();
      const d = path.join(root, HOSTS);
      if (!checkSub(d)) mkdirOne(d);
      dir = checkSub(d) ? d : null;
    } else {
      const r = readRoot();
      dir = r && checkSub(path.join(r, HOSTS)) ? path.join(r, HOSTS) : null;
    }
  } catch {
    dir = null;
  }
  if (!dir) return () => {};
  const f = fileOf(dir, origin) + ".active";
  const writer = !isPrivate() && !currentReadOnly();
  const giveUp = Date.now() + leaseWaitMs();
  for (;;) {
    if (writer) {
      try {
        const token = randomBytes(12).toString("hex");
        const fd = fs.openSync(f, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
        try {
          fs.writeSync(fd, JSON.stringify({ v: 1, pid: process.pid, time: Date.now(), token }));
        } finally {
          fs.closeSync(fd);
        }
        // v0.6 (Codex round 7): removed only while it still holds OUR token, so a lease another process took
        // (after ours was judged stale) is never deleted by us, here or by the shutdown cleanup (lifetime.ts).
        const remove = () => {
          if (leaseToken(f) === token) fs.rmSync(f, { force: true });
        };
        const forget = holdLease(f, remove);
        return () => {
          remove();
          forget();
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") return () => {};
      }
    } else if (!fs.existsSync(f) || activeStale(f)) return () => {}; // read-only: a stale file is ignored, never removed (round 76)
    // Stale recovery under the per-site lock (Codex round 76): only the process holding the lock may check,
    // remove and replace an abandoned file, so two processes can never both remove and both take it.
    // v0.6 (Codex round 9): the recovery guard is an OWNED lock beside the lease (ownedlock.ts, "<lease>.lock"),
    // never broken for its age, released only by its taker, so a recoverer paused between its check and its delete
    // can never have its guard taken and the replacement lease deleted. One attempt per poll (no blocking wait).
    if (writer && activeStale(f)) {
      const g = takeLock(f, 0);
      if (g) {
        try {
          if (activeStale(f)) fs.rmSync(f, { force: true }); // only a writer ever recovers (round 77)
        } finally {
          releaseLock(f, g);
        }
        continue;
      }
    }
    if (Date.now() > giveUp) throw new Refused(leaseBusy(f));
    await pause(50, signal);
  }
}
const leasePid = (f: string): number | undefined => readLeaseMeta(f)?.pid;
const leaseBusy = (f: string): string => {
  const pid = leasePid(f);
  return `Another Tiresias process${pid ? ` (process ${pid})` : ""} is in the middle of a request to this site, so this request waited its turn and gave up. If no Tiresias process${pid ? " with that number" : ""} is running, another program has reused the number: the site stays blocked until that program ends or the daily cleanup clears the lease file. To unblock it now, delete ${JSON.stringify(f)}${fs.existsSync(f + ".lock") ? ` and ${JSON.stringify(f + ".lock")}` : ""}.`;
};

// clear and the daily trim: spacing files and locks over a day old are of no use. v0.6 (Codex rounds 9 and 10):
// leases and their recovery guards take part in the lease protocol. A day-old lease is removed only when it is
// stale (its process gone), checked again under its recovery guard. A recovery guard ("<lease>.lock", an owned
// lock) is NEVER removed automatically, like the config lock: a guard left by a process that crashed keeps its
// site's lease until a person deletes it, and a wait that gives up names the file to delete.
export function sweepHosts(now = Date.now()): void {
  const r = readRoot();
  if (!r) return;
  const dir = path.join(r, HOSTS);
  try {
    if (!checkSub(dir)) return;
    for (const n of fs.readdirSync(dir)) {
      const f = path.join(dir, n);
      try {
        const st = fs.lstatSync(f);
        if (!st.isFile() || now - st.mtimeMs <= 86_400_000) continue;
        if (n.endsWith(".active.lock")) continue; // a recovery guard: only its taker or a person removes it
        if (n.endsWith(".active")) {
          const g = takeLock(f, 0);
          if (!g) continue;
          try {
            if (activeStale(f)) fs.rmSync(f, { force: true });
          } finally {
            releaseLock(f, g);
          }
        } else fs.rmSync(f, { force: true });
      } catch {
        // gone meanwhile
      }
    }
  } catch {
    // housekeeping never fails a call
  }
}

