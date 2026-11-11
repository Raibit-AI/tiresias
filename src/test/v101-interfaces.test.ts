// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { freshHome, neverAsk, serve, text, html } from "./helper.js";
import { read } from "../engine.js";

process.env.TIRESIAS_ALLOW_PRIVATE = "1";

test("an active read retains its starting translator after the configured hook changes", async () => {
  const home = freshHome();
  neverAsk(home);
  const set = (name: string) => fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ translator: { command: [process.execPath, "-e", `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('${name}'));`], timeout_seconds: 5 } }));
  let started!: () => void, release!: () => void;
  const downloading = new Promise<void>((r) => started = r);
  const finish = new Promise<void>((r) => release = r);
  let wait = true;
  const s = await serve((req, res) => {
    if (req.url !== "/page") return text(res, "", 404);
    started();
    void (wait ? finish : Promise.resolve()).then(() => html(res, "<h1>Report</h1><p>The report contains the figures for the year and the details of the work.</p>"));
  });
  try {
    set("HOOK_A");
    const pending = read(s.url + "/page", { section: 1, translate: "es" });
    await downloading;
    set("HOOK_B");
    release();
    const reply = await pending;
    assert.equal(reply.translation?.status, "ok", JSON.stringify(reply));
    assert.equal((reply.untrusted_content as any).translation.text, "HOOK_A");
    wait = false;
    const next = await read(s.url + "/page", { section: 1, translate: "es", fresh: true });
    assert.equal((next.untrusted_content as any).translation.text, "HOOK_B");
  } finally {
    release();
    await s.close();
  }
});

test("all configuration loaders retain the call snapshot", async () => {
  const home = freshHome();
  neverAsk(home);
  const config = await import("../config.js");
  const { loadRenderMode } = await import("../render.js");
  const { guarded, env } = await import("../envelope.js");
  const first = { keep_cache_days: 12, signature_agent: "https://first.example", doors: "wait", rendering: "ask", saving: "ask", safe_browsing: false, scanner: { command: ["/bin/cat"] }, translator: { command: ["/bin/cat"] } };
  const second = { keep_cache_days: 24, signature_agent: "https://second.example", doors: "background", rendering: "off", saving: "off", safe_browsing: true };
  const file = path.join(home, "config.json");
  fs.writeFileSync(file, JSON.stringify(first));
  const values = () => [config.readConfigObject(), config.loadLimits(), config.loadSigningConfig(), config.loadDoorsMode(), loadRenderMode(), config.loadSavingMode(), config.loadSafetyConfig(), config.loadScanner(), config.loadTranslator()];
  let started!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => started = r), finish = new Promise<void>((r) => release = r);
  const pending = guarded("read", "https://example.com/", { agent: "snapshot-test" }, undefined, async () => {
    const before = values();
    started();
    await finish;
    assert.deepEqual(values(), before);
    return env("https://example.com/", "ok");
  }, {}, undefined, false, false);
  await ready;
  fs.writeFileSync(file, JSON.stringify(second));
  release();
  assert.equal((await pending).status, "ok");
  assert.deepEqual(config.readConfigObject(), second);
});

test("private settings listings neither create the store nor change its permissions", async () => {
  const home = freshHome();
  const { spawnSync } = await import("node:child_process");
  fs.rmdirSync(home);
  const listing = () => spawnSync(process.execPath, [path.resolve("dist/cli.js"), "settings"], { env: { ...process.env, TIRESIAS_PRIVATE: "1" }, encoding: "utf8" });
  let result = listing();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(home), false, "a listing must not create the store");
  fs.mkdirSync(home, { mode: 0o755 });
  fs.chmodSync(home, 0o755);
  result = listing();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.statSync(home).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(home), []);
});

test("unrelated invalid storage limits do not prevent ticket resume", async () => {
  const home = freshHome();
  const handoffs = await import("../handoffs.js");
  const { resume, keepDays } = await import("../resume.js");
  const s = await serve((req, res) => req.url === "/robots.txt" ? text(res, "", 404) : html(res, "<h1>Report</h1><p>The saved report is available to read.</p>"));
  try {
    const retry = handoffs.create({ url: s.url + "/retry", reason: "forbidden" }).ticket!;
    const provided = handoffs.create({ url: s.url + "/provided", reason: "forbidden" }).ticket!;
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ keep_cache_days: -1, keep_handoff_days: 7 }));
    assert.equal((await resume(retry.id)).status, "ok");
    const before = s.hits.length;
    const reply = await resume(provided.id, { text: "<h1>Report</h1><p>Provided text.</p>" });
    assert.equal(reply.status, "ok");
    assert.equal(reply.source, "provided_by_agent");
    assert.equal(s.hits.length, before);
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ keep_handoff_days: 0 }));
    assert.throws(keepDays, /keep_handoff_days/);
  } finally {
    await s.close();
  }
});

test("history preserves questions through its documented purpose bound and marks cuts", async () => {
  const home = freshHome();
  const { logText } = await import("./helper.js");
  const { buildNeeds } = await import("../needs.js");
  const s = await serve((req, res) => req.url === "/robots.txt" ? text(res, "", 404) : html(res, "<h1>Report</h1><p>The yearly report contains numbers.</p>"));
  try {
    const prefix = "z".repeat(599);
    const questions = [prefix + "a", prefix + "b", "q".repeat(1100)];
    for (const question of questions) assert.ok(["ok", "unchanged"].includes((await read(s.url + "/page", { question })).status));
    const records = logText(home, "history").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((r) => r.tool === "read");
    assert.equal(records[0].purpose, questions[0]);
    assert.equal(records[0].cut, undefined);
    assert.equal(records[1].purpose, questions[1]);
    assert.equal(records[2].purpose, questions[2].slice(0, 1000));
    assert.equal(records[2].cut, true);
    const needs = await buildNeeds();
    assert.equal(needs.counts.empty.groups, 3);
  } finally {
    await s.close();
  }
});
