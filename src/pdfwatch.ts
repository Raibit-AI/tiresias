// SPDX-License-Identifier: Apache-2.0
// Only the parent starts this watchdog; no PDF bytes or page code reach it.
const pid = Number(process.argv[2]);
if (!Number.isSafeInteger(pid) || pid <= 0 || !process.send) process.exit(1);
process.once("disconnect", () => {
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  process.exit(0);
});
process.send({ ready: true });
