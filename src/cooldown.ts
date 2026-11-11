// SPDX-License-Identifier: Apache-2.0
// N-06: Retry-After is enforced, not just reported. When a site says 429,
// 503 or asks for a wait on a redirect, we remember "do not call this origin until T", across processes, and
// every later request (page, probe, robots refresh) checks it first.
//
// Storage is an append-only log with no lock. A lock cannot be made safe
// against paused or crashed owners, but an append of one short line is a
// single atomic write, and the reader just takes the latest deadline per site.
//   cooldowns.jsonl   one {origin, until} line per cooldown
// W-18: the log is SHARED by every profile (it lives at the store root): a site's Retry-After applies
// to us whatever the profile. Obeying the site beats separation.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonOrigin } from "./sitekey.js";
import { Refused } from "./errors.js";
import { appendLine, cachePath, readJson, scanLogSync, rootDir, type LogCursor } from "./store.js";

// A wait over 10 years is not a real Retry-After. It is treated as invalid and
// replaced by a fixed 24 hour cooldown. Anything below that limit is kept in
// full, never shortened.
const ABSURD_SECONDS = 10 * 365 * 86_400;
export const ABSURD_FALLBACK_SECONDS = 86_400;

// The three HTTP-date spellings, excluding Date.parse's permissive numeric and ISO inputs.
const WEEKDAY = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
const CLOCK = "[0-2][0-9]:[0-5][0-9]:[0-5][0-9]";
const HTTP_DATE = new RegExp(`^(?:${WEEKDAY}, [0-3][0-9] ${MONTH} [0-9]{4} ${CLOCK} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), [0-3][0-9]-${MONTH}-[0-9]{2} ${CLOCK} GMT|${WEEKDAY} ${MONTH} (?: [1-9]|[0-3][0-9]) ${CLOCK} [0-9]{4})$`);
const httpDate = (s: string): number => HTTP_DATE.test(s) ? Date.parse(s) : NaN;

// Retry-After is either whole seconds or an HTTP date. Returns null when it
// is missing, unreadable or absurd.
export function parseRetryAfter(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = v.trim();
  let secs: number;
  if (/^\d+$/.test(t)) secs = Number(t);
  else {
    const when = httpDate(t);
    if (Number.isNaN(when)) return null;
    secs = Math.max(0, Math.ceil((when - Date.now()) / 1000));
  }
  return secs > ABSURD_SECONDS ? null : secs;
}

// One rule for how long to wait, shared by the cooldown and the reported value.
export function cooldownSeconds(status: number, header: string | null | undefined): number {
  const parsed = parseRetryAfter(header);
  if (parsed !== null) return parsed;
  if (header && header.trim()) {
    const t = header.trim();
    const absurd = /^\d+$/.test(t) || !Number.isNaN(httpDate(t));
    if (absurd) return ABSURD_FALLBACK_SECONDS;
  }
  return status === 429 ? 60 : 30; // no usable header: a polite default
}

// One file, append-only. Tiresias never renames, rewrites or truncates it at
// runtime, so no process can erase another's record. Nothing in Tiresias
// compacts or deletes it (not even `clear --all`): it grows by a few lines per
// 429/503. Deleting it by hand is safe only when no Tiresias process is running.
export const CUR = "cooldowns.jsonl";
export const LEGACY = "cooldowns"; // the v0.1.3 JSON store (cache/<hash>.json), read only, never written
const LEGACY_OLD = "cooldowns.old.jsonl"; // written by v0.1.4, read only, never written
const MAX_ORIGIN = 400; // keeps every line well under 512 bytes (one atomic append)

interface Entry {
  origin: string;
  until: number;
}
const mem = new Map<string, number>(); // cooldowns set by this process (at most MEM_MAX)
// v0.9 hardening (Codex round 6c, HIGH): `mem` no longer keeps every wait for the server's whole life: past MEM_MAX
// entries, the expired ones are dropped. A wait that has not ended is never dropped.
// v0.9 client trust (Travis approved, 2026-10-31; closes the class stopped in client-trust round 1): when `mem` is
// full of waits that have not ended, a new one goes into a FIXED-SIZE store instead of growing memory: SLOTS
// deadlines (8 MB), each origin written to K slots chosen by a keyed hash (a random key per process, so a site cannot
// pick names that land on another site's slots). Writing keeps the later deadline in each slot; reading takes the
// earliest of the origin's K slots. Every slot of a stored origin holds at least its deadline, so a wait is never
// forgotten or shortened; when other origins share all K slots, the answer can only be LATER (Tiresias waits longer
// than asked, never less). Expired slots simply read as past.
export const MEM_MAX = 10_000;
let memMax = MEM_MAX;
// Tests only (honored under Node's test runner): a smaller in-process list, so the overflow path is reached quickly.
export function setMemMaxForTests(n: number): void {
  if (process.env.NODE_TEST_CONTEXT) memMax = n;
}
export const SLOTS = 1 << 20; // 1,048,576 deadlines of 8 bytes: 8 MiB
const K = 3;
let sketch: Float64Array | null = null; // made on first use
const sketchKey = crypto.randomBytes(32);
function slotsOf(origin: string): number[] {
  const h = crypto.createHmac("sha256", sketchKey).update(origin).digest();
  const out: number[] = [];
  for (let i = 0; i < K; i++) out.push(h.readUInt32BE(i * 4) % SLOTS);
  return out;
}
function sketchSet(origin: string, until: number): void {
  sketch ??= new Float64Array(SLOTS);
  for (const i of slotsOf(origin)) if (until > sketch[i]) sketch[i] = until;
}
function sketchGet(origin: string): number {
  if (!sketch) return 0;
  let least = Infinity;
  for (const i of slotsOf(origin)) least = Math.min(least, sketch[i]);
  return least === Infinity ? 0 : least;
}
// Keep a wait this process learned: in `mem` while there is room (after dropping expired entries), else in the
// fixed-size store. A very long origin name goes to the fixed-size store at once, so `mem` stays bounded in bytes too.
function remember(origin: string, until: number): void {
  const had = mem.get(origin);
  if (had !== undefined) return void mem.set(origin, Math.max(had, until));
  if (origin.length <= MAX_ORIGIN) {
    if (mem.size >= memMax) {
      const now = Date.now();
      for (const [o, u] of mem) if (u <= now) mem.delete(o);
    }
    if (mem.size < memMax) return void mem.set(origin, until);
  }
  sketchSet(origin, until);
}
export const cooldownStoreBytes = () => sketch?.byteLength ?? 0; // for tests
export const cooldownMemSize = () => mem.size; // for tests

// Check stamps on each request, retaining the replayed index and reading only new bytes when a log
// grows. A replaced or shrunken log is replayed; remembered waits still expire normally. The stamp
// names the store root, so a new TIRESIAS_HOME is read afresh.
interface Index {
  get: (origin: string) => number;
  exact: (origin: string) => number;
  take: (origin: unknown, until: unknown) => void;
  logs: Map<string, LogCursor | undefined>;
}
let memo: { root: string; stamp: string; map: Index } | null = null;
let reads = 0;
export const loadCount = () => reads; // for tests
function stamp(): string {
  const parts = [rootDir()];
  for (const f of [path.join(rootDir(), CUR), path.join(rootDir(), LEGACY_OLD), safePath(() => cachePath(LEGACY, "shared"))]) {
    try {
      const st = f ? fs.lstatSync(f) : null;
      parts.push(st ? `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.dev}:${st.ino}:${st.mode}` : "-");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      parts.push("-");
    }
  }
  return parts.join("|");
}
const safePath = (f: () => string): string | null => {
  try {
    return f();
  } catch {
    return null;
  }
};
function load(): Index {
  try {
    const st = stamp();
    if (memo && memo.stamp === st) return memo.map;
    const root = rootDir();
    const map = loadNow(memo?.root === root ? memo.map : undefined);
    memo = { root, stamp: st, map };
    return map;
  } catch {
    memo = null;
    throw new Refused("The site's Retry-After waits could not be read. No request was sent.");
  }
}

// Replay every live deadline. Overflow uses the same bounded, conservative slots as the in-process list.
function newIndex(): Index {
  const best = new Map<string, number>();
  let overflow: Float64Array | null = null;
  const take = (origin: unknown, until: unknown) => {
    if (typeof origin !== "string" || typeof until !== "number" || !Number.isFinite(until) || until <= Date.now()) return;
    const key = canonOrigin(origin); // v0.6: one name per site (sitekey.ts)
    if (best.has(key) || (best.size < MEM_MAX && key.length <= MAX_ORIGIN)) {
      if (until > (best.get(key) ?? 0)) best.set(key, until);
    } else {
      overflow ??= new Float64Array(SLOTS);
      for (const i of slotsOf(key)) if (until > overflow[i]) overflow[i] = until;
    }
  };
  return {
    take,
    logs: new Map(),
    exact: (origin) => best.get(origin) ?? 0,
    get: (origin) => {
      let least = Infinity;
      if (overflow) for (const i of slotsOf(origin)) least = Math.min(least, overflow[i]);
      return Math.max(best.get(origin) ?? 0, least === Infinity ? 0 : least);
    },
  };
}

function loadNow(index = newIndex()): Index {
  reads++;
  let legacy: Record<string, unknown> | null = null;
  try {
    legacy = readJson<Record<string, unknown>>(cachePath(LEGACY, "shared")); // W-18: shared, at the root
  } catch {
    // the root's cache/ is a link or someone else's: the legacy store is not read (Codex round 46)
  }
  if (legacy && typeof legacy === "object") for (const [origin, until] of Object.entries(legacy)) index.take(origin, until);
  for (const name of [LEGACY_OLD, CUR]) index.logs.set(name, scanLogSync<Entry>(name, (e) => index.take(e?.origin, e?.until), index.logs.get(name)));
  return index;
}

// Fetchers register here so queued requests can be cancelled the moment a
// cooldown starts for their site.
export const onCooldown: ((origin: string) => void)[] = [];

export function setCooldown(origin: string, status: number, header: string | null): number {
  origin = canonOrigin(origin);
  const seconds = cooldownSeconds(status, header);
  const until = Date.now() + seconds * 1000;
  // Exact sources only: the fixed-size store may answer later than the truth (a collision), and taking that as
  // "already written" would keep the line from other processes.
  const known = Math.max(mem.get(origin) ?? 0, load().exact(origin));
  remember(origin, until); // this process honors it at once
  // Only a later deadline is worth a line. Never shortens anything.
  if (until > known && origin.length <= MAX_ORIGIN) appendLine(CUR, { v: 1, origin, until }); // shared, at the root only: private mode may write nothing else
  for (const f of onCooldown) f(origin);
  return seconds;
}

export function cooldownLeft(origin: string): number {
  origin = canonOrigin(origin);
  const until = Math.max(load().get(origin) ?? 0, mem.get(origin) ?? 0, sketchGet(origin));
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}
