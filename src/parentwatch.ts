// SPDX-License-Identifier: Apache-2.0
// W-17: a child that dies with its parent, even when the child is stuck in a loop that never yields.
// A tiny worker thread (its own event loop) checks every 200 ms whether the parent process changed
// (process.ppid differs from what it was at start: the parent died and the child was re-parented). If so it
// kills the whole child process with SIGKILL. The IPC "disconnect" event alone cannot do this, because it needs
// the child's main event loop, which a busy parser may never give it.
import { Worker } from "node:worker_threads";

export function startParentWatchdog(intervalMs = 200): Worker {
  const code = `
    const { workerData } = require("node:worker_threads");
    setInterval(() => {
      if (process.ppid !== workerData.ppid) process.kill(process.pid, "SIGKILL");
    }, workerData.intervalMs);
  `;
  const w = new Worker(code, { eval: true, workerData: { ppid: process.ppid, intervalMs } });
  w.unref(); // it never keeps the child alive on its own
  return w;
}
