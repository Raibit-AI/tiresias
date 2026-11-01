// SPDX-License-Identifier: Apache-2.0
// v0.9 (W-33, Travis 2026-10-31, item A): the MCP server's built-in memory ceiling.
//
// `tiresias mcp` watches its own JavaScript heap. A full garbage collection schedules a callback on a later turn;
// the heap is read when that callback runs, not at the end of the collection. Allocations in between count too.
// It also reads every second (at 1.5 times the ceiling between collections). Only two consecutive readings over
// their thresholds stop the server, so one inflated reading cannot stop it. It says so on standard error,
// records it in history (the daily log lists it), and exits through the usual cleanup so the app can restart it.
//
// Why not Node's --max-old-space-size (re-exec or NODE_OPTIONS): that flag is process-wide, and it overrides the
// worker threads' own resourceLimits, so the 512 MB cap of each page-parser worker would rise to the flag's value
// (measured: a worker asking for 64 MB got 1,072 MB under --max-old-space-size=1024; Codex client-trust round 1).
// The hard limit stays V8's own default; this ceiling is the clean stop below it.
import { PerformanceObserver, constants } from "node:perf_hooks";
import v8 from "node:v8";
import { ConfigError } from "./errors.js";
import * as history from "./history.js";
import { SHUTDOWN_MS, shutdown } from "./lifetime.js";

export const MEMORY_MB = 1024;
export const MIN_MEMORY_MB = 256;
export const MAX_MEMORY_MB = 65536;
const MB = 1024 * 1024;
const POLL_MS = 1000;
const FAR = 1.5; // the between-collections check: this many times the ceiling

// The ceiling in MB, or null when the owner turned it off. A bad value is an error naming the variable.
export function memoryMb(env: NodeJS.ProcessEnv = process.env): number | null {
  const v = env.TIRESIAS_MEMORY_MB;
  if (v === undefined || v.trim() === "") return MEMORY_MB;
  if (/^off$/i.test(v.trim())) return null;
  const n = /^\d{1,6}$/.test(v.trim()) ? Number(v.trim()) : NaN;
  if (!Number.isSafeInteger(n) || n < MIN_MEMORY_MB || n > MAX_MEMORY_MB)
    throw new ConfigError(`TIRESIAS_MEMORY_MB must be a whole number of MB from ${MIN_MEMORY_MB} to ${MAX_MEMORY_MB}, or off; got "${v.slice(0, 40)}".`);
  return n;
}

export const ceilingLine = (mb: number): string =>
  `Tiresias stopped: the MCP server reached its memory ceiling (${mb} MB, TIRESIAS_MEMORY_MB). Nothing was lost; your AI app can start it again.`;

// Over the ceiling? `afterFullGc`: the reading is in the callback reporting a full collection (a later turn).
export const over = (usedBytes: number, mb: number, afterFullGc: boolean): boolean => usedBytes > (afterFullGc ? mb : mb * FAR) * MB;

export function ceilingReached(mb: number): (usedBytes: number, afterFullGc: boolean) => boolean {
  let previous = false;
  return (usedBytes, afterFullGc) => {
    const high = over(usedBytes, mb, afterFullGc);
    const reached = previous && high;
    previous = high;
    return reached;
  };
}

// Two runs of readings: after full collections (over the ceiling) and polls (over 1.5 times it). Two in a row in
// either run stop the server. Any reading under the ceiling itself resets both (memory really went down); a poll
// between 1x and 1.5x resets only the polls' run, never the collections' (Claude review).
export function ceilingWatch(mb: number): { gc: (usedBytes: number) => boolean; poll: (usedBytes: number) => boolean } {
  let gcHigh = false;
  let pollHigh = false;
  const under = (u: number) => !over(u, mb, true);
  return {
    gc: (u) => {
      if (under(u)) return (gcHigh = pollHigh = false);
      const r = gcHigh;
      gcHigh = true;
      return r;
    },
    poll: (u) => {
      if (under(u)) return (gcHigh = pollHigh = false);
      if (!over(u, mb, false)) return (pollHigh = false);
      const r = pollHigh;
      pollHigh = true;
      return r;
    },
  };
}

let stopping = false;
function stop(mb: number): void {
  if (stopping) return;
  stopping = true;
  process.stderr.write(ceilingLine(mb) + "\n");
  try {
    // Private mode writes nothing (history.record refuses); a store that cannot be written never stops the exit.
    history.record({ time: new Date().toISOString(), tool: "server", url: "", agent: "tiresias", status: "error", door: "none", event: "memory_ceiling", memory_mb: mb });
  } catch {
    // the stderr line still says it
  }
  setTimeout(() => process.exit(1), SHUTDOWN_MS + 2000); // if the cleanup cannot finish, exit anyway
  shutdown(1); // cancels every call and background job, removes this process's leases, exits 1
}

// Start watching. Returns the ceiling in MB, or null when it is off. Throws a ConfigError on a bad setting.
export function startCeiling(): number | null {
  const mb = memoryMb();
  if (mb === null) return null;
  const used = () => v8.getHeapStatistics().used_heap_size;
  // (Claude review) Separate trackers: a poll under its 1.5x threshold must not reset the GC readings' run (and
  // the reverse), or a heap held between 1x and 1.5x with full collections less than a second apart never stops.
  const watch = ceilingWatch(mb);
  const obs = new PerformanceObserver((list) => {
    const fullGc = list.getEntries().some((e) => {
      const kind = (e as unknown as { detail?: { kind?: number } }).detail?.kind;
      return kind === constants.NODE_PERFORMANCE_GC_MAJOR;
    });
    // One callback is one reading, even if several GC entries were delivered together.
    if (fullGc && watch.gc(used())) stop(mb);
  });
  obs.observe({ entryTypes: ["gc"] });
  setInterval(() => {
    if (watch.poll(used())) stop(mb);
  }, POLL_MS).unref();
  return mb;
}

// Test hook (honored only under Node's test runner, like TIRESIAS_ALLOW_PRIVATE): `flood` keeps allocating and
// holding memory a little at a time, yielding between steps, as a flood of calls would.
// `probe` prints the heap limit a worker asking for 64 MB really gets in this process, and exits.
export async function testHook(): Promise<void> {
  if (!process.env.NODE_TEST_CONTEXT) return;
  if (process.env.TIRESIAS_TEST_MEMORY === "probe") {
    const { Worker } = await import("node:worker_threads");
    const w = new Worker(`require("node:worker_threads").parentPort.postMessage(require("node:v8").getHeapStatistics().heap_size_limit)`, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 64 } });
    const limit = await new Promise<number>((r) => w.once("message", r));
    process.stderr.write(`worker_limit_mb=${Math.round(limit / MB)}\n`);
    process.exit(0);
  }
  if (process.env.TIRESIAS_TEST_MEMORY !== "flood") return;
  const keep: string[][] = [];
  const step = () => {
    for (let i = 0; i < 20; i++) keep.push(Array.from({ length: 10_000 }, (_x, j) => `x${j}-${keep.length}`));
    setImmediate(step);
  };
  step();
}
