// SPDX-License-Identifier: Apache-2.0
// v0.6 (coordinator's decision after Codex round 3): ONE list of the work a process is doing, so a shutdown
// can wait for, or cancel, all of it, whatever started it.
// - `shutdownSignal` aborts every request (safeFetch listens to it), every call (guarded) and every background
//   job, and stops new work from starting.
// - work(): every foreground call and background job registers its promise for its whole life.
// - Every lease (hosts.ts acquireActive: the ".active" file saying "a request to this site is in progress") is
//   registered too, by its file, however it was taken: a page, robots.txt, a door check, the Safe Browsing list.
// shutdown() cancels everything, waits up to SHUTDOWN_MS for the work to finish its own cleanup, then removes
// any lease file still registered (each is this process's own) and exits.
import fs from "node:fs";

const ctl = new AbortController();
export const shutdownSignal = ctl.signal;
export const SHUTDOWN_MS = 10_000;

const works = new Set<Promise<unknown>>();
export function work<T>(p: Promise<T>): Promise<T> {
  works.add(p);
  const done = () => void works.delete(p);
  p.then(done, done);
  return p;
}
// A foreground call registers for its whole life; the returned function ends it.
export function enterCall(): () => void {
  let end!: () => void;
  work(new Promise<void>((r) => (end = r)));
  return () => end();
}

// Each lease with the function that removes it only while it is still ours (hosts.ts checks its token).
const leases = new Map<string, () => void>();
export function holdLease(file: string, remove: () => void = () => fs.rmSync(file, { force: true })): () => void {
  leases.set(file, remove);
  return () => void leases.delete(file);
}
export const leaseCount = (): number => leases.size; // for tests

export const workCount = (): number => works.size; // for tests

// Wait (yielding to the event loop for real) until no work and no lease is left, or `ms` has passed.
async function idle(ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while ((works.size || leases.size) && Date.now() < until) {
    const left = until - Date.now();
    let t: NodeJS.Timeout | undefined;
    const tick = new Promise<void>((r) => (t = setTimeout(r, Math.min(left, 50))));
    if (works.size) await Promise.race([Promise.allSettled([...works]).then(() => clearTimeout(t)), tick]);
    else await tick;
  }
  return !works.size && !leases.size;
}
// Cancel everything, give it SHUTDOWN_MS to clean up, then remove any lease file still registered (ours).
async function cancelAll(): Promise<void> {
  ctl.abort();
  await idle(SHUTDOWN_MS);
  for (const remove of leases.values()) {
    try {
      remove(); // only while it is still ours
    } catch {
      // gone
    }
  }
}

let started = false;
export const signalled = (): boolean => started; // a signal started the shutdown (it owns the exit)
// On a signal: cancel at once.
export function shutdown(code: number): void {
  if (started) return;
  started = true;
  void cancelAll().then(() => process.exit(code));
}
// The CLI's normal end (Codex round 5): every piece of registered work (background door checks, a shared Safe
// Browsing download...) may finish within `boundMs`; whatever is left is then cancelled and cleaned up.
export async function finish(boundMs: number): Promise<void> {
  if (await idle(boundMs)) return;
  await cancelAll();
}
