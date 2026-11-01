// SPDX-License-Identifier: Apache-2.0
// W-21: the small runner every scanner hook is started through (scanner.ts). It is node itself (no shell)
// and leads the hook's own process group. It passes Tiresias's input to the hook, keeps the hook's output
// (at most 4 KB, or the cap it is given; more is an overflow), and its one other job is that nothing in the group outlives what it
// was started for (Codex rounds 58 and 63):
//   - when the hook has exited and its output has ended, the runner writes ONE line to Tiresias
//     ({"code", "signal", "over", "out": base64}) and then kills its whole group, itself included, with
//     SIGKILL, so helpers the hook left behind (even ones that ignore SIGTERM) go too;
//   - at the time cap, or within 200 ms of Tiresias being gone (killed, crashed, stopped by a signal),
//     it kills the whole group at once, with no answer.
// The runner stays alive until the group is killed, so the watchdog never disappears before the helpers.
// Arguments: <Tiresias's pid> <time cap in ms> <program> [args...]. The pid is passed, never read at start:
// a runner whose parent is already gone must not take its new parent for Tiresias (Codex round 65).
import { spawn } from "node:child_process";

// Arguments: <Tiresias's pid> <time cap in ms> [max=<bytes>] <program> [args...]. The output cap is 4 KB (the
// scanner) unless "max=<bytes>" says otherwise (v0.7 W-26: the translation hook, at most 1 MB). A program is a
// full path, so it never looks like "max=".
const argv = process.argv.slice(2);
const capArg = /^max=(\d{1,7})$/.exec(argv[2] ?? "");
if (capArg) argv.splice(2, 1);
const MAX = capArg ? Math.min(1024 * 1024, Math.max(1, Number(capArg[1]))) : 4096;
const [parentPid, ms, program, ...args] = argv;
const parent = Number(parentPid);
const killGroup = (): void => {
  try {
    process.kill(0, "SIGKILL"); // this runner, the hook and anything the hook started
  } catch {
    process.exit(1);
  }
};
if (process.ppid !== parent) killGroup(); // Tiresias was gone before the hook could start
setTimeout(killGroup, Number(ms));
setInterval(() => {
  if (process.ppid !== parent) killGroup(); // Tiresias is gone
}, 200);

const child = spawn(program, args, { shell: false, stdio: ["inherit", "pipe", "ignore"], windowsHide: true });
let out = Buffer.alloc(0);
let over = false;
child.stdout!.on("data", (c: Buffer) => {
  if (over) return;
  if (out.length + c.length > MAX) over = true;
  else out = Buffer.concat([out, c]);
});
const answer = (code: number | null, signal: string | null) => {
  const line = JSON.stringify({ code, signal, over, out: over ? "" : out.toString("base64") }) + "\n";
  process.stdout.write(line, () => killGroup());
};
child.on("error", () => answer(127, null)); // could not start: the scan is "failed"
child.on("close", (code, signal) => answer(code, signal));
