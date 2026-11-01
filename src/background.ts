// SPDX-License-Identifier: Apache-2.0
// W-30 (v0.6): fast first read. A first read of a site returns its page right away; the six door checks
// (doors.ts) then run here, in the background, through the same per-site queue, spacing, Crawl-delay,
// Retry-After and Safe Browsing checks as any request, and their answers are cached for the next read.
//
// Rules:
// - A job is its own call: its own deadline (JOB_MS), its own Safe Browsing gate (never the asking call's
//   allow_flagged), its own request counter. It never runs in private mode (pipeline.ts reads privately
//   with the checks in the foreground instead), so it may write the discovery cache and the spacing file.
// - One job per site at a time in this process, and at most MAX_JOBS jobs at once; past that, no job is
//   started and the reply does not say doors_pending (the next read tries again).
// - Nothing outlives the process unfinished by design: the CLI waits for every job (drainBackground)
//   before it exits; abandonBackground() cancels them all and waits until each has stopped (a cancelled
//   job writes nothing). In the MCP server a job runs after the reply has gone.
import { callContext } from "./context.js";
import { probeOrigin } from "./doors.js";
import * as safebrowsing from "./safebrowsing.js";
import { withSignal } from "./safety.js";
import { canonOrigin } from "./sitekey.js";
import { MAX_SPACING_S, loadSites } from "./sites.js";
import { isPrivate, profileName } from "./store.js";
import { enterCall, finish, shutdown, shutdownSignal, signalled, work } from "./lifetime.js";
export { enterCall, shutdownSignal };

// A job's deadline (Codex round 5): a call's 60 seconds PLUS room for six probes at the largest spacing Tiresias
// keeps (a 30-second Crawl-delay or site spacing), so a slow site's checks can still finish and be cached.
export const JOB_MS = 60_000 + 6 * MAX_SPACING_S * 1000;
export const MAX_JOBS = 32;

interface Job {
  ctl: AbortController;
  done: Promise<void>;
}
const jobs = new Map<string, Job>();

export const backgroundCount = (): number => jobs.size; // for tests
export const doorsRunning = (origin: string): boolean => jobs.has(`${profileName()} ${canonOrigin(origin)}`);

// Start the door checks for `origin` unless they are already running. Returns whether checks for it are
// running now. Never throws: a job that cannot start (a bad Safe Browsing setting, too many jobs) is
// simply not started.
export function startDoorProbe(origin: string): boolean {
  origin = canonOrigin(origin); // one job per site, whatever its spelling (Codex round 4)
  if (isPrivate()) return false; // a private call starts nothing that could leave a record
  if (shutdownSignal.aborted) return false; // shutting down: nothing new starts
  const key = `${profileName()} ${origin}`;
  if (jobs.has(key)) return true;
  if (jobs.size >= MAX_JOBS) return false;
  let gate: safebrowsing.CallSafety;
  try {
    gate = safebrowsing.makeGate({ allowFlagged: false, priv: false });
  } catch {
    return false;
  }
  const ctl = new AbortController();
  const signal = AbortSignal.any([AbortSignal.timeout(JOB_MS), ctl.signal, shutdownSignal]);
  const sent = { requests: 0, signed: 0 };
  // Outside the asking call's context (callContext.exit): not its deadline, its cancellation, its
  // per-call robots cache or its private flag; withSignal then gives the job a context of its own.
  const done = callContext
    .exit(() =>
      withSignal(signal, () => {
        // A job is its own call: it reads the site settings once, when it starts (sites.ts).
        const store = callContext.getStore();
        if (store) store.sites = loadSites();
        return probeOrigin(origin, { sequential: true });
      }, sent, gate.check),
    )
    .then(
      () => undefined,
      () => undefined, // a wall, a price tag, a refusal or a cancellation: nothing is cached, the next read asks again
    )
    .finally(() => {
      if (jobs.get(key)?.done === done) jobs.delete(key);
    });
  work(done);
  jobs.set(key, { ctl, done });
  return true;
}

// Wait until every job has finished (each ends by its own deadline at the latest).
export async function drainBackground(): Promise<void> {
  while (jobs.size) await Promise.allSettled([...jobs.values()].map((j) => j.done));
}

// Cancel every job and wait until each has stopped.
export async function abandonBackground(): Promise<void> {
  for (const j of jobs.values()) j.ctl.abort();
  await drainBackground();
}

// The CLI's last step: wait for every job; Ctrl-C (or SIGTERM) meanwhile cancels them cleanly (each gives
// back its turn and its lease, writes nothing), and the process then exits with 130.
export async function drainForExit(boundMs = JOB_MS + 30_000): Promise<void> {
  const stop130 = () => shutdown(130);
  const stop143 = () => shutdown(143);
  process.once("SIGINT", stop130);
  process.once("SIGTERM", stop143);
  try {
    // Every registered piece of work, not only door checks (Codex round 5): a shared Safe Browsing download too.
    await finish(boundMs);
  } finally {
    process.off("SIGINT", stop130);
    process.off("SIGTERM", stop143);
  }
  // A signal arrived: the shutdown (lifetime.ts) owns the exit and its code (130 or 143); never return to the
  // caller's own exit with 0. Past the bound without a signal (Codex round 8), the leftover work was cancelled
  // and cleaned up by finish(): return, and the CLI exits with the command's own code.
  if (signalled()) await new Promise<never>(() => {});
}

// The MCP server's lifetime: Ctrl-C or SIGTERM runs the one process-wide shutdown (lifetime.ts): no new call
// or job starts, every call, job, request and lease is cancelled and waited for (within a bound), then exit.
let shutdownInstalled = false;
export function installShutdown(): void {
  if (shutdownInstalled) return;
  shutdownInstalled = true;
  process.once("SIGINT", () => shutdown(130));
  process.once("SIGTERM", () => shutdown(143));
}
