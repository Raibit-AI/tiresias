// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { childExecArgv, hooks, runPdfChild } from "../pdfproc.js";
import { PageTooComplex, runUntrusted, stopWorker } from "../sandbox.js";
import type { ParsedPage } from "../types.js";

test("2.1: the PDF child cannot start a worker to read an owner file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-worker-probe-"));
  const file = path.join(dir, "owner.txt");
  fs.writeFileSync(file, "owner-only-probe");
  try {
    const code = `
      const fs = require("node:fs");
      const { Worker } = require("node:worker_threads");
      try { fs.readFileSync(${JSON.stringify(file)}); process.exit(2); }
      catch (e) { if (e.code !== "ERR_ACCESS_DENIED") throw e; }
      try {
        const w = new Worker(${JSON.stringify(`const { parentPort } = require("node:worker_threads"); parentPort.postMessage(require("node:fs").readFileSync(${JSON.stringify(file)}, "utf8"));`)}, { eval: true, execArgv: [] });
        w.on("message", (s) => { console.log(s); process.exit(3); });
      } catch (e) {
        if (e.code !== "ERR_ACCESS_DENIED") throw e;
        console.log("worker refused");
      }
    `;
    const r = spawnSync(process.execPath, [...childExecArgv(128), "-e", code], { encoding: "utf8", env: {}, timeout: 5000 });
    assert.equal(r.error, undefined);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(r.stdout.trim(), "worker refused");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("2.1: the restricted PDF child still parses with its external watchdog", async () => {
  const content = "BT /F1 12 Tf 20 180 Td (Watchdog test) Tj ET\n";
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>", "<</Type/Pages/Kids[4 0 R]/Count 1>>",
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 5 0 R/Resources<</Font<</F1 3 0 R>>>>>>",
    `<</Length ${content.length}>>\nstream\n${content}endstream`,
  ];
  const bytes = Buffer.from("%PDF-1.4\n" + objects.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj\n`).join("") + "trailer\n<</Root 1 0 R/Size 6>>\n%%EOF\n");
  const probe = hooks.probe;
  hooks.probe = () => 100; // this sandbox denies ps; this test checks launch, permissions and parsing
  try {
    const r = await runPdfChild<{ parsed: ParsedPage }>({ op: "pdf", bytes, url: "https://pdf.example/test.pdf" });
    assert.match(r.parsed.sections[0].blocks[0].text, /Watchdog test/);
  } finally {
    hooks.probe = probe;
  }
});

test("2.2: even a small calendar runs under the worker time budget", async () => {
  stopWorker();
  process.env.TIRESIAS_PARSE_BUDGET_MS = "1";
  const body = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Small invite\r\nEND:VEVENT\r\nEND:VCALENDAR";
  try {
    await assert.rejects(runUntrusted({ op: "parse", kind: "plain", mode: "calendar", body, url: "https://calendar.example/invite.ics" }, body.length), PageTooComplex);
  } finally {
    delete process.env.TIRESIAS_PARSE_BUDGET_MS;
    stopWorker();
  }
});
