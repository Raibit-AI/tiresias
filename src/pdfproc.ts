// SPDX-License-Identifier: Apache-2.0
// W-17: runs a PDF job in a separate child process (no shell: fork starts node itself), under three limits that are enforced from here:
//   - time: the same budget as every parse (TIRESIAS_PARSE_BUDGET_MS, default 5 s), then SIGKILL
//   - memory: the child's real memory (RSS) is read every 50 ms and the child is SIGKILLed above
//     TIRESIAS_PDF_MEMORY_MB (default 1024). RSS counts decoder buffers that the V8 heap limit does not.
//     The child also gets --max-old-space-size (TIRESIAS_WORKER_HEAP_MB) for its JavaScript heap.
//   - the caller: a cancelled call kills the child.
// Anything that goes wrong (crash, signal, out of memory, oversized or odd result, timeout) is
// page_too_complex and nothing is kept. FAIL CLOSED: if the memory of the child cannot be watched (Windows, no
// `ps`, no /proc, or a probe that fails mid-way) PDFs are not read, with a clear message. The child has an empty environment, no shell, no stdin or
// stdout, and is killed when this process exits.
import { execFile, fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, FetchError, PdfError } from "./errors.js";
import { currentSignal } from "./safety.js";
import { PageTooComplex, budgetMs, workerHeapMb } from "./sandbox.js";
import { MAX_PDF_RESULT_CHARS, type Done, type Job } from "./work.js";
import { Slots } from "./slots.js";

export const PDF_MEMORY_MB = 1024;
const POLL_MS = 50;
const MAX_CONCURRENT = 2;

export function pdfMemoryMb(): number {
  const v = process.env.TIRESIAS_PDF_MEMORY_MB;
  if (v === undefined) return PDF_MEMORY_MB;
  const n = /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new ConfigError(`TIRESIAS_PDF_MEMORY_MB must be a positive whole number, got "${v.slice(0, 40)}".`);
  return n;
}

const live = new Set<ChildProcess>();

// v0.5.1: the child runs under Node's permission model. It may READ only Tiresias's own folder (dist/) and
// the node_modules folder that holds pdfjs-dist (pdf.js, its fonts and cmaps, and the reader's own
// dependencies installed beside it); it may write nothing, start no process and load no native add-on.
// The one worker it may start is its parent watchdog (parentwatch.ts). So a PDF that took over the
// parser still cannot read ~/.tiresias (the keys) or the owner's files. (Node 22's permission model does
// not cover the network; the child is given no address and no code that fetches.)
export const childExecArgv = (heap: number): string[] => [`--max-old-space-size=${heap}`, ...childPermissions()];
export function childPermissions(): string[] {
  const app = fileURLToPath(new URL(".", import.meta.url));
  const pdfjs = fileURLToPath(import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
  const i = pdfjs.lastIndexOf(`${path.sep}node_modules${path.sep}`);
  const modules = i >= 0 ? pdfjs.slice(0, i + "/node_modules".length) : path.resolve(path.dirname(pdfjs), "..", "..");
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  const dirs = [...new Set([app, modules, real(app), real(modules)])];
  return ["--permission", ...dirs.map((d) => `--allow-fs-read=${path.join(d, "*")}`), "--allow-worker"];
}
export const activePdfPids = (): number[] => [...live].map((c) => c.pid!).filter(Boolean);
// No child may outlive this process. (The child also exits when its IPC channel closes.)
process.on("exit", () => {
  for (const c of live) c.kill("SIGKILL");
});

// Hand a released slot directly to the next waiter. Queue size is still governed by the trusted client.
export const pdfSlots = new Slots(MAX_CONCURRENT, Infinity);

// VmRSS from the text of /proc/<pid>/status, in MB; the kernel states the unit (kB), so no page size is assumed.
export function vmRssMb(status: string): number | null {
  const m = /^VmRSS:\s+(\d+)\s+kB\s*$/m.exec(status);
  return m ? Number(m[1]) / 1024 : null;
}

// Resident memory of a process in MB. REJECTS if it cannot be read: callers fail closed.
// Linux: VmRSS (in kB, stated by the kernel) from /proc/<pid>/status, so no page size is assumed.
// macOS and BSD: `ps -o rss= -p <pid>` (KiB), no shell, empty environment. Windows: not supported.
export function rssMb(pid: number): Promise<number> {
  if (process.platform === "win32") return Promise.reject(new Error("memory watching is not available on Windows"));
  if (process.platform === "linux") {
    try {
      const mb = vmRssMb(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
      return mb === null ? Promise.reject(new Error("no VmRSS in /proc")) : Promise.resolve(mb);
    } catch (e) {
      return Promise.reject(e);
    }
  }
  return new Promise((resolve, reject) => {
    try {
      execFile("ps", ["-o", "rss=", "-p", String(pid)], { timeout: 2000, env: {} }, (err, out) => {
        const kb = Number(String(out).trim());
        if (err || !/^\s*\d+\s*$/.test(String(out)) || !Number.isFinite(kb) || kb <= 0) return reject(err ?? new Error("unreadable ps output"));
        resolve(kb / 1024);
      });
    } catch (e) {
      reject(e); // execFile can throw at once (for example EPERM, ENOENT)
    }
  });
}

// The probe the watchdog uses. A test can replace it to prove that a failing probe is handled.
export const hooks = { probe: rssMb as (pid: number) => Promise<number> | number };

const NO_WATCH = "PDF reading needs memory watching, and this system does not have it (Windows, or no `ps` or /proc). PDFs are not read here. Web pages are unaffected.";
const WATCH_FAILED = "A PDF was not read because the memory of the PDF reader could not be checked.";

// Before any PDF child is started: can this system watch memory at all? Checked on this process's own memory.
async function memoryWatchAvailable(): Promise<boolean> {
  try {
    const mb = await hooks.probe(process.pid);
    return typeof mb === "number" && Number.isFinite(mb) && mb > 0;
  } catch {
    return false;
  }
}

export async function runPdfChild<T>(job: Job): Promise<T> {
  const release = await pdfSlots.take(currentSignal());
  try {
    return await runOne<T>(job);
  } finally {
    release();
  }
}

async function runOne<T>(job: Job): Promise<T> {
  if (currentSignal()?.aborted) throw new FetchError("The request was cancelled.", "cancelled");
  if (!(await memoryWatchAvailable())) throw new PdfError(NO_WATCH); // fail closed, before anything is started
  return start<T>(job);
}

function start<T>(job: Job): Promise<T> {
  const budget = budgetMs();
  const memCap = pdfMemoryMb();
  const heap = workerHeapMb();
  const sig = currentSignal();
  if (sig?.aborted) return Promise.reject(new FetchError("The request was cancelled.", "cancelled"));
  return new Promise<T>((resolve, reject) => {
    const child = fork(new URL("./pdfchild.js", import.meta.url), [], {
      execArgv: childExecArgv(heap),
      env: {}, // nothing from this process's environment (no keys, no tokens)
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "advanced",
    });
    live.add(child);
    child.stderr?.resume(); // drained and thrown away
    let settled = false;
    let polling = false;
    let pending: Promise<unknown> = Promise.resolve(); // the probe in flight, if any
    let answered = false; // a complete answer has arrived over IPC
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      sig?.removeEventListener("abort", onAbort);
      child.kill("SIGKILL"); // the child is done or being thrown away; it never stays
      live.delete(child);
      fn();
    };
    const tooComplex = () => finish(() => reject(new PageTooComplex()));
    const timer = setTimeout(tooComplex, budget);
    const onAbort = () => finish(() => reject(new FetchError("The request was cancelled.", "cancelled")));
    sig?.addEventListener("abort", onAbort, { once: true });
    const poll = setInterval(() => {
      if (polling || settled || !child.pid) return;
      polling = true;
      const failed = () => finish(() => reject(new PdfError(WATCH_FAILED))); // a probe that fails ends the request, never the process
      try {
        pending = Promise.resolve(hooks.probe(child.pid)).then((mb) => {
          polling = false;
          if (typeof mb !== "number" || !Number.isFinite(mb)) return failed();
          if (mb > memCap) tooComplex();
        }, failed);
      } catch {
        failed();
      }
    }, POLL_MS);
    // The contract (SPEC section 9): an answer is accepted when it arrived complete, the probe in flight
    // settles, one more probe of the child succeeds under the cap, and the child's own peak memory up to
    // the answer (maxRSS) is under the cap. A child that dies after sending a complete answer does not
    // make the answer wrong: it was doing nothing else. Any failed check fails closed.
    const accept = async (ok: () => void, peakKb: unknown) => {
      clearInterval(poll);
      await pending;
      if (settled) return;
      let mb: unknown;
      try {
        mb = await hooks.probe(child.pid!);
      } catch {
        return finish(() => reject(new PdfError(WATCH_FAILED)));
      }
      if (settled) return;
      if (typeof mb !== "number" || !Number.isFinite(mb)) return finish(() => reject(new PdfError(WATCH_FAILED)));
      if (typeof peakKb !== "number" || !Number.isFinite(peakKb)) return finish(() => reject(new PdfError(WATCH_FAILED)));
      if (mb > memCap || peakKb / 1024 > memCap) return tooComplex();
      finish(ok);
    };
    child.once("error", () => tooComplex());
    // The child never exits on its own (it waits to be killed after answering), so an exit BEFORE its answer
    // arrives is a crash, a signal or out of memory: fail at once. An exit AFTER a complete answer does not
    // undo it (see accept, and SPEC section 9).
    child.once("exit", () => {
      if (!answered) tooComplex();
    });
    child.once("message", (d: Done) => {
      answered = true;
      // The answer is checked before it is believed: right shape, bounded size.
      try {
        if (!d || typeof d !== "object") return tooComplex();
        const peakKb = (d as { peak_rss_kb?: unknown }).peak_rss_kb;
        if ("result" in d) {
          if (JSON.stringify(d.result).length > MAX_PDF_RESULT_CHARS) return tooComplex();
          return void accept(() => resolve(d.result as T), peakKb);
        }
        if (d.error === "pdf") {
          const msg = String(d.message ?? "This PDF could not be read.").slice(0, 300);
          return void accept(() => reject(new PdfError(msg)), peakKb);
        }
        return tooComplex(); // "complexity", "failed" or anything else
      } catch {
        tooComplex();
      }
    });
    try {
      child.send(job, (err) => {
        if (err) tooComplex();
      });
    } catch {
      tooComplex(); // a send that throws at once still goes through finish(): child, timers and listeners are cleaned up
    }
  });
}
