// SPDX-License-Identifier: Apache-2.0
// Runs CPU work on untrusted content under a hard time budget.
//
// Why: parsing hostile pages kept turning up new slow paths (regexes, quadratic
// copies), and synchronous code cannot be interrupted by a deadline. So any
// job on a non-trivial input runs in a worker thread, and the main thread
// terminates the worker when the budget (default 5 s, TIRESIAS_PARSE_BUDGET_MS)
// runs out or the caller cancels. Nothing from a terminated job is used.
// Small inputs run inline: even a quadratic parser is harmless on a few KB.
import { Worker } from "node:worker_threads";
import { ConfigError, FetchError, PdfError, TiresiasError } from "./errors.js";
import { currentSignal } from "./safety.js";
import { handle, type Job } from "./work.js";
import { ComplexityError } from "./errors.js";
import { Busy, Slots } from "./slots.js";

export class PageTooComplex extends TiresiasError {
  readonly kind = "page_too_complex";
  constructor() {
    super("page_too_complex");
  }
}

export const INLINE_MAX = 8 * 1024;

// Heap ceiling for the worker, in MB. A page that exhausts it ends the worker (not the process)
// and the call fails as page_too_complex. TIRESIAS_WORKER_HEAP_MB overrides it.
export const WORKER_HEAP_MB = 512;
export function workerHeapMb(): number {
  const v = process.env.TIRESIAS_WORKER_HEAP_MB;
  if (v === undefined) return WORKER_HEAP_MB;
  const n = /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new ConfigError(`TIRESIAS_WORKER_HEAP_MB must be a positive whole number, got "${v.slice(0, 40)}".`);
  return n;
}

export function budgetMs(): number {
  const v = process.env.TIRESIAS_PARSE_BUDGET_MS;
  if (v === undefined) return 5000;
  const n = /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new ConfigError(`TIRESIAS_PARSE_BUDGET_MS must be a positive whole number, got "${v.slice(0, 40)}".`);
  return n;
}

let idle: Worker | null = null; // one warm worker is kept between jobs

// Ends the warm worker. Used by tests that change the worker's limits.
export function stopWorker(): void {
  const w = idle;
  idle = null;
  if (w) void w.terminate();
}

function spawn(): Worker {
  const w = new Worker(new URL("./worker.js", import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: workerHeapMb() } });
  w.unref(); // an idle worker never keeps the process alive
  w.once("exit", () => {
    if (idle === w) idle = null;
  });
  return w;
}

function unwrap<T>(d: ReturnType<typeof handle>): T {
  if ("result" in d) return d.result as T;
  if (d.error === "complexity") throw new ComplexityError();
  if (d.error === "too_large") throw new PageTooComplex();
  if (d.error === "pdf") throw new PdfError(d.message ?? "This PDF could not be read.");
  throw new Error(d.message ?? "parse failed");
}

// v0.9 hardening (Codex round 4c, HIGH): at most WORKER_MAX parser workers at once in this process (each has its own
// heap limit), and at most WORKER_QUEUE jobs waiting; past that a job is refused at once (slots.ts).
export const WORKER_MAX = 4;
export const WORKER_QUEUE = 64;
export const BUSY_TEXT = "Tiresias is reading too many pages at once. Try again in a moment.";
const workerSlots = new Slots(WORKER_MAX, WORKER_QUEUE);
export const workerLoad = () => ({ active: workerSlots.active, queued: workerSlots.queued }); // for tests

export async function runUntrusted<T>(job: Job, size: number): Promise<T> {
  // A PDF is never parsed inline or in the worker thread: it gets its own process (pdfproc.ts), because
  // decoder buffers are not counted by a worker's heap limit.
  if (job.op === "pdf") return (await import("./pdfproc.js")).runPdfChild<T>(job);
  if (size <= INLINE_MAX && !(job.op === "parse" && job.kind === "plain" && job.mode === "calendar")) return unwrap<T>(handle(job));
  const sig = currentSignal();
  let release: () => void;
  try {
    release = await workerSlots.take(sig);
  } catch (e) {
    if (e instanceof Busy) throw new FetchError(BUSY_TEXT, "timeout");
    throw e;
  }
  try {
    return await runInWorker<T>(job, sig);
  } finally {
    release();
  }
}

async function runInWorker<T>(job: Job, sig: AbortSignal | undefined): Promise<T> {
  const budget = budgetMs();
  if (sig?.aborted) throw new FetchError("The request was cancelled.", "cancelled");
  const w = idle ?? spawn();
  idle = null;
  return new Promise<T>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      sig?.removeEventListener("abort", onAbort);
      w.off("message", onMessage);
      w.off("error", onError);
      w.off("exit", onExit);
    };
    const kill = (err: Error) => {
      finish();
      void w.terminate(); // the job is thrown away
      reject(err);
    };
    const timer = setTimeout(() => kill(new PageTooComplex()), budget);
    const onAbort = () => kill(new FetchError("The request was cancelled.", "cancelled"));
    const onMessage = (d: ReturnType<typeof handle>) => {
      finish();
      if (idle) void w.terminate();
      else idle = w;
      try {
        resolve(unwrap<T>(d));
      } catch (e) {
        reject(e);
      }
    };
    // Running out of heap is the page's fault: same outcome as running out of time.
    const onError = (e: Error & { code?: string }) =>
      kill(e.code === "ERR_WORKER_OUT_OF_MEMORY" ? new PageTooComplex() : new Error(`worker failed: ${e.message}`));
    // A worker that dies without an error event would otherwise be noticed only at the time budget.
    const onExit = (code: number) => kill(new Error(`worker failed: exited unexpectedly (code ${code})`));
    sig?.addEventListener("abort", onAbort, { once: true });
    w.on("message", onMessage);
    w.on("error", onError);
    w.on("exit", onExit);
    w.postMessage(job);
  });
}

// Wall detection for a response: headers first (cheap, inline), then the page
// body markers (in the sandbox when the body is large).
export async function scanBody(
  html: string,
  status: number,
  opts: { textChars?: number; lenient?: boolean; alsoThin?: boolean } = {},
) {
  return runUntrusted<import("./walls.js").WallInfo | null>({ op: "wall", status, html, ...opts }, html.length);
}
