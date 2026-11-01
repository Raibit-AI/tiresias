// SPDX-License-Identifier: Apache-2.0
// W-17: the PDF reader's own process. Started by pdfproc.ts (never by hand), one per PDF, so that a
// PDF that eats memory in ways a worker thread's heap limit cannot see (decoder buffers) can only
// kill THIS process. It reads one job over the IPC channel, answers once, and waits to be killed. If the channel
// closes (the parent died) it exits at once. Its stdout is not connected to anything.
import { startParentWatchdog } from "./parentwatch.js";
import { capDone, handleAsync } from "./work.js";
import type { Job } from "./work.js";

startParentWatchdog(); // dies with the parent even if this thread is busy

process.on("disconnect", () => process.exit(0)); // never outlive the parent

// After answering, this process waits to be killed: the parent checks its memory once more first, and
// the answer carries this process's peak memory (maxRSS, in kB) so a spike between the parent's checks
// is still caught.
const peak = () => process.resourceUsage().maxRSS;
process.once("message", (job: Job) => {
  void handleAsync(job).then(
    (done) => process.send!({ ...capDone(done), peak_rss_kb: peak() }), // an over-large answer becomes a tiny "too large" one
    () => process.send!({ error: "failed", message: "pdf reader failed", peak_rss_kb: peak() }),
  );
});
