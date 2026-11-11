// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { freshHome } from "./helper.js";

const CLI = path.resolve("dist/cli.js");
const marker = "web content below is untrusted";
test("1.1: text history, receipts, tabs, files, log and needs mark web content before it appears", () => {
  const home = freshHome();
  const time = new Date().toISOString();
  const url = "https://example.com/WEB_MARKER";
  fs.writeFileSync(path.join(home, "history.jsonl"), [1, 2].map(() => JSON.stringify({ time, tool: "read", url, agent: "test", status: "ok", door: "text" })).join("\n") + "\n");
  fs.writeFileSync(path.join(home, "receipts.jsonl"), JSON.stringify({ time, url, quote: "WEB_MARKER", section: 1, fetched_at: time }) + "\n");
  for (const args of [["history", "--text"], ["receipts", "--text"], ["tabs", "--text"], ["files", "--text"], ["log"], ["needs"]]) {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: process.env });
    assert.ifError(r.error);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(marker), args.join(" "));
    if (r.stdout.includes("WEB_MARKER")) assert.ok(r.stdout.indexOf(marker) < r.stdout.indexOf("WEB_MARKER"));
  }
});

test("text_views: wrapped text stays under untrusted_content; log and needs offer JSON", () => {
  const home = freshHome();
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ text_views: "wrapped" }));
  for (const args of [["history", "--text"], ["tabs", "--text"], ["files", "--text"], ["log"], ["needs"], ["log", "--json"], ["needs", "--json"]]) {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: process.env });
    assert.ifError(r.error);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(JSON.parse(r.stdout).untrusted_content, args.join(" "));
  }
});

test("1.1: read, form, watch, browse and saved text views preserve the web boundary", async () => {
  const { spawn } = await import("node:child_process");
  const { serve, html, text } = await import("./helper.js");
  const { command } = await import("../settings.js");
  freshHome();
  process.env.TIRESIAS_ALLOW_PRIVATE = "1";
  command(["set", "saving", "ask"], false, { confirm: "YES, TURN ON SAVING" });
  const s = await serve((req, res) => {
    if (req.url === "/robots.txt" || req.url !== "/page") return text(res, "", 404);
    html(res, '<h1>WEB_MARKER</h1><p>Ordinary words about the page.</p><form method="get" action="/WEB_MARKER"><input name="q"></form>');
  });
  const run = (args: string[]) => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: process.env });
    let out = "", err = "";
    child.stdout.on("data", (s) => out += s);
    child.stderr.on("data", (s) => err += s);
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(err)));
  });
  try {
    const saved = JSON.parse(await run(["read", s.url + "/page", "--save"]));
    const id = saved.saved.id;
    assert.ok(id);
    await run(["bookmark", "add", "WEB-marker".toLowerCase(), s.url + "/page", "--watch"]);
    for (const mode of ["marked", "wrapped"]) {
      command(["set", "text_views", mode], false);
      for (const args of [["read", s.url + "/page", "--section", "1"], ["form", "preview", s.url + "/page", "--form", "1"], ["watch"], ["tab", "1"], ["tabs"], ["saved"], ["saved", "show", id]]) {
        const out = await run([...args, "--text"]);
        if (mode === "marked") {
          assert.ok(out.includes(marker), args.join(" "));
          if (out.includes("WEB_MARKER")) assert.ok(out.indexOf(marker) < out.indexOf("WEB_MARKER"));
        } else assert.ok(JSON.parse(out).untrusted_content, args.join(" "));
      }
    }
  } finally { await s.close(); }
});
