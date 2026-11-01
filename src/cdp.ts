// SPDX-License-Identifier: Apache-2.0
// W-10 (v0.7): a minimal client for the Chrome DevTools Protocol over --remote-debugging-pipe.
// No dependency: Chrome reads commands from file descriptor 3 and writes answers and events to file descriptor 4,
// each message one JSON text ended by a NUL byte. A pipe (not a debugging port) means no other local process can
// connect to the browser. Every message from Chrome is bounded (MAX_MESSAGE) and parsed as plain data.
import type { Readable, Writable } from "node:stream";

export const MAX_MESSAGE = 64 * 1024 * 1024; // the largest single message accepted from Chrome
export const MAX_PENDING = 1_000; // commands waiting for an answer at once

export class CdpError extends Error {
  constructor(message: string, readonly code: "closed" | "timeout" | "protocol" | "too_large") {
    super(message);
  }
}

type Waiter = { resolve: (v: any) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout };
export type CdpEvent = { method: string; params: any; sessionId?: string };

export class Cdp {
  private nextId = 1;
  private waiting = new Map<number, Waiter>();
  private chunks: Buffer[] = [];
  private held = 0;
  private listeners = new Set<(e: CdpEvent) => void>();
  private failure: CdpError | null = null;

  constructor(private out: Writable, input: Readable) {
    input.on("data", (d: Buffer) => this.take(d));
    const end = () => this.fail(new CdpError("The browser closed.", "closed"));
    input.on("end", end);
    input.on("close", end);
    input.on("error", end);
    out.on("error", end);
  }

  get closed(): boolean {
    return this.failure !== null;
  }

  // Splits the stream at NUL bytes, never holding more than MAX_MESSAGE of one message.
  private take(d: Buffer): void {
    if (this.failure) return;
    let start = 0;
    for (;;) {
      const i = d.indexOf(0, start);
      if (i < 0) break;
      if (this.held + i - start > MAX_MESSAGE) return this.fail(new CdpError("The browser sent a message larger than Tiresias accepts.", "too_large"));
      this.chunks.push(d.subarray(start, i));
      const msg = Buffer.concat(this.chunks).toString("utf8");
      this.chunks = [];
      this.held = 0;
      start = i + 1;
      this.dispatch(msg);
      if (this.failure) return;
    }
    if (start < d.length) {
      this.held += d.length - start;
      if (this.held > MAX_MESSAGE) return this.fail(new CdpError("The browser sent a message larger than Tiresias accepts.", "too_large"));
      this.chunks.push(Buffer.from(d.subarray(start)));
    }
  }

  private dispatch(text: string): void {
    let m: any;
    try {
      m = JSON.parse(text);
    } catch {
      return this.fail(new CdpError("The browser sent something that is not a protocol message.", "protocol"));
    }
    if (typeof m !== "object" || m === null) return;
    if (typeof m.id === "number") {
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      if (w.timer) clearTimeout(w.timer);
      if (m.error) w.reject(new CdpError(`Browser command failed: ${String(m.error?.message ?? "error").slice(0, 200)}`, "protocol"));
      else w.resolve(m.result ?? {});
      return;
    }
    if (typeof m.method === "string") {
      const e: CdpEvent = { method: m.method, params: m.params ?? {}, ...(typeof m.sessionId === "string" ? { sessionId: m.sessionId } : {}) };
      for (const l of [...this.listeners]) {
        try {
          l(e);
        } catch {
          // a listener's own failure never stops the others
        }
      }
    }
  }

  fail(e: CdpError): void {
    if (this.failure) return;
    this.failure = e;
    for (const w of this.waiting.values()) {
      if (w.timer) clearTimeout(w.timer);
      w.reject(e);
    }
    this.waiting.clear();
    this.chunks = [];
  }

  on(l: (e: CdpEvent) => void): () => void {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 10_000): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.waiting.size >= MAX_PENDING) return Promise.reject(new CdpError("Too many browser commands at once.", "protocol"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const w: Waiter = { resolve, reject };
      w.timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new CdpError("The browser did not answer in time.", "timeout"));
      }, timeoutMs);
      this.waiting.set(id, w);
      try {
        this.out.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
      } catch {
        this.fail(new CdpError("The browser closed.", "closed"));
      }
    });
  }
}
