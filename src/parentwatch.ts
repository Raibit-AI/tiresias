// SPDX-License-Identifier: Apache-2.0
// W-17: watch the parent's IPC channel outside the PDF child, whose parser may never yield.
import { fork, type ChildProcess } from "node:child_process";

export function startParentWatchdog(pid: number): ChildProcess {
  return fork(new URL("./pdfwatch.js", import.meta.url), [String(pid)], {
    execArgv: [], env: {}, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
}
