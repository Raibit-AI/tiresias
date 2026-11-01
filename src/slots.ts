// SPDX-License-Identifier: Apache-2.0
// v0.9 hardening (Codex round 4c, HIGH): a cap on how many heavy jobs run at once in one process. An MCP client
// (a prompt-injected agent included) can send many calls together; without a cap each one started its own parser
// worker (512 MB heap each) or its own Chrome. Jobs past the cap wait their turn, in order; a waiting job leaves the
// line when its call is cancelled or ends, and when the line itself is full a new job is refused at once instead of
// being held.
import { FetchError } from "./errors.js";

export class Busy extends Error {}

export class Slots {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(
    readonly max: number,
    readonly maxWaiting: number,
  ) {}
  get active(): number {
    return this.running;
  }
  get queued(): number {
    return this.waiting.length;
  }
  // Resolves with a release function once a slot is free. Throws `Busy` when the line is full, and a cancelled
  // FetchError when `sig` aborts first.
  async take(sig?: AbortSignal): Promise<() => void> {
    if (sig?.aborted) throw new FetchError("The request was cancelled.", "cancelled");
    if (this.running >= this.max) {
      if (this.waiting.length >= this.maxWaiting) throw new Busy("Too many heavy jobs at once.");
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          sig?.removeEventListener("abort", stop);
          resolve();
        };
        const stop = () => {
          const i = this.waiting.indexOf(go);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(new FetchError("The request was cancelled.", "cancelled"));
        };
        this.waiting.push(go);
        sig?.addEventListener("abort", stop, { once: true });
      });
      // The slot was handed over by the job that released it (`running` was never lowered), so nobody arriving in
      // between can take it first.
    } else this.running++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiting.shift();
      if (next) next(); // hand the slot straight to the next in line
      else this.running--;
    };
  }
}
