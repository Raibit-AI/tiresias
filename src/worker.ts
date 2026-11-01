// SPDX-License-Identifier: Apache-2.0
// Worker thread entry: runs one untrusted-content job at a time.
import { parentPort } from "node:worker_threads";
import { handleAsync, type Job } from "./work.js";

parentPort!.on("message", (job: Job) => {
  void handleAsync(job).then((done) => parentPort!.postMessage(done));
});
