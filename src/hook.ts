// SPDX-License-Identifier: Apache-2.0
// The owner's hooks (W-21 scanner, v0.7 W-26 translator): ONE way to run an owner-set command. Split out of
// scanner.ts in v0.7, behavior unchanged for the scanner.
//
// The command is run DIRECTLY (no shell, a full path, no PATH lookup), started through hookrunner.ts (node
// itself), which leads the hook's own process group and kills the whole group at the time cap, once it has
// answered, or within 200 ms of Tiresias being gone. Tiresias also kills the group at the cap, on cancellation
// and once it has the answer, so a hook that starts helpers leaves nothing running. Its output is capped; its
// standard error is ignored. Hooks are never run on Windows (no process groups to kill).
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { currentSignal } from "./safety.js";

const live = new Set<ChildProcess>();
// No hook may outlive this process.
process.on("exit", () => {
  for (const c of live) killTree(c);
});
export function killTree(c: ChildProcess): void {
  try {
    if (c.pid && process.platform !== "win32") process.kill(-c.pid, "SIGKILL"); // its whole process group
    else c.kill("SIGKILL");
  } catch {
    try {
      c.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

export type HookFailure = "timeout" | "too_large" | "exit_code" | "cancelled" | "unsupported_platform" | "no_answer";
export type HookOutcome = { ok: true; out: Buffer } | { ok: false; reason: HookFailure };

// Runs `command` (a full path and its arguments) with `extra` arguments after them, `input` on standard input,
// and returns its standard output (at most `maxOut` bytes) when it exits with code 0. Never throws.
export function runHook(command: string[], extra: string[], timeoutMs: number, maxOut: number, input: string | Buffer): Promise<HookOutcome> {
  const sig = currentSignal();
  if (sig?.aborted) return Promise.resolve({ ok: false, reason: "cancelled" });
  if (process.platform === "win32") return Promise.resolve({ ok: false, reason: "unsupported_platform" });
  const started = Date.now();
  return new Promise<HookOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      const runner = fileURLToPath(new URL("./hookrunner.js", import.meta.url));
      const cap = maxOut === 4096 ? [] : [`max=${maxOut}`]; // the runner's default is the scanner's 4 KB
      child = spawn(process.execPath, [runner, String(process.pid), String(timeoutMs), ...cap, command[0], ...command.slice(1), ...extra], {
        // Always its own group: the runner kills its WHOLE group, which must never be ours.
        shell: false, stdio: ["pipe", "pipe", "ignore"], detached: true, windowsHide: true,
      });
    } catch {
      return resolve({ ok: false, reason: "no_answer" });
    }
    live.add(child);
    let out = Buffer.alloc(0);
    let done = false;
    const finish = (r: HookOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sig?.removeEventListener("abort", onAbort);
      live.delete(child);
      killTree(child); // nothing it started is left running (the runner kills its group too)
      child.stdout?.destroy();
      child.stdin?.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);
    const onAbort = () => finish({ ok: false, reason: "cancelled" });
    sig?.addEventListener("abort", onAbort, { once: true });
    child.on("error", () => finish({ ok: false, reason: "no_answer" })); // the runner could not start
    // The runner's one line: the hook's exit and its output (base64), or nothing at all when the group was
    // killed at the cap. The runner then kills its own group, so its own exit is a SIGKILL.
    child.stdout!.on("data", (c: Buffer) => {
      if (out.length + c.length > 3 * maxOut + 1024) return finish({ ok: false, reason: "too_large" });
      out = Buffer.concat([out, c]);
    });
    child.on("close", () => {
      let r: { code?: unknown; signal?: unknown; over?: unknown; out?: unknown };
      try {
        r = JSON.parse(out.toString("utf8"));
      } catch {
        // No answer: the runner killed the group at the cap (or died).
        return finish({ ok: false, reason: Date.now() - started >= timeoutMs * 0.9 ? "timeout" : "no_answer" });
      }
      if (r.over === true) return finish({ ok: false, reason: "too_large" });
      if (r.code !== 0 || r.signal !== null || r.over !== false || typeof r.out !== "string") return finish({ ok: false, reason: "exit_code" });
      finish({ ok: true, out: Buffer.from(r.out, "base64") });
    });
    child.stdin!.on("error", () => {}); // a hook that does not read its input is fine
    child.stdin!.end(input);
  });
}
