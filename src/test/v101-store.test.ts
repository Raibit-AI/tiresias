// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { freshHome } from "./helper.js";
import { saveSnapshot, planCleanup, applyCleanup } from "../saved.js";
import { DEFAULT_LIMITS } from "../config.js";

const input = (bytes: number) => ({ url: "https://example.com/page", source_url: "https://example.com/page", final_url: "https://example.com/page", status: 200, content_type: "text/plain", read_as: "text" as const, file_flags: [], language_header: null, received: Buffer.alloc(bytes, 65) });

// Kill a real lock holder, including at the boundary before its prepared lock is published.
async function leaveDeadLock(file: string, beforePublish = false): Promise<number> {
  const script = `
    import fs from "node:fs";
    import { takeLock } from ${JSON.stringify(path.resolve("dist/savedlock.js"))};
    if (${beforePublish}) fs.renameSync = () => {
      process.send({ ready: true });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    };
    const token = takeLock(process.argv[1]);
    if (!token) process.exit(1);
    process.send({ ready: true });
    setInterval(() => {}, 1000);
  `;
  const p = spawn(process.execPath, ["--input-type=module", "-e", script, file], { env: process.env, stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const closed = new Promise<void>((resolve) => p.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      p.once("message", () => resolve());
      p.once("error", reject);
      p.once("exit", () => reject(new Error("lock holder exited before acquiring the lock")));
    });
  } finally {
    p.kill("SIGKILL");
    await closed;
  }
  assert.throws(() => process.kill(p.pid!, 0), { code: "ESRCH" });
  return p.pid!;
}

test("a dead process's lock does not block saving or cleanup", async () => {
  const home = freshHome();
  const file = path.join(home, "saved");
  await leaveDeadLock(file);
  assert.equal(saveSnapshot(input(1024), [], DEFAULT_LIMITS).status, "saved");
  const plan = planCleanup(Date.now() + 91 * 86_400_000, DEFAULT_LIMITS);
  assert.equal(plan.remove.length, 1);
  await leaveDeadLock(file);
  assert.equal(applyCleanup(plan).removed, 1);
});

test("a kill before publishing the lock and a legacy dead-pid lock do not block saving", async () => {
  const home = freshHome();
  const file = path.join(home, "saved");
  const pid = await leaveDeadLock(file, true);
  assert.equal(saveSnapshot(input(1024), [], DEFAULT_LIMITS).status, "saved");
  fs.writeFileSync(file + ".lock", JSON.stringify({ pid, token: "legacy-owner" }), { mode: 0o600 });
  assert.equal(saveSnapshot(input(1024), [], DEFAULT_LIMITS).status, "saved");
  const plan = planCleanup(Date.now() + 91 * 86_400_000, DEFAULT_LIMITS);
  fs.writeFileSync(file + ".lock", JSON.stringify({ pid, token: "legacy-owner" }), { mode: 0o600 });
  assert.equal(applyCleanup(plan).removed, 2);
});

test("concurrent snapshot saves cannot exceed the cap or evict earlier evidence", async () => {
  const home = freshHome();
  const limits = { ...DEFAULT_LIMITS, max_saved_mb: 1 };
  const original = saveSnapshot(input(300 * 1024), [], limits);
  assert.equal(original.status, "saved");
  const barrier = path.join(home, "continue");
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    import { saveSnapshot } from ${JSON.stringify(path.resolve("dist/saved.js"))};
    const mkdir = fs.mkdirSync, rename = fs.renameSync;
    fs.mkdirSync = function (p, ...args) {
      if (path.basename(String(p)).startsWith(".tmp-")) {
        process.send({ ready: true });
        const deadline = Date.now() + 5000;
        while (!fs.existsSync(process.argv[1]) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      return mkdir.call(this, p, ...args);
    };
    fs.renameSync = function (from, to) {
      if (String(to).endsWith("saved.lock")) process.send({ locking: true });
      return rename.call(this, from, to);
    };
    const input = ${JSON.stringify({ ...input(0), received: undefined })};
    input.received = Buffer.alloc(400 * 1024, 66);
    process.send({ result: saveSnapshot(input, [], ${JSON.stringify(limits)}) });
  `;
  const child = () => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", script, barrier], { env: process.env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const messages: any[] = [];
    let stderr = "";
    p.stderr!.on("data", (b) => stderr += b);
    p.on("message", (m) => messages.push(m));
    const done = new Promise<any>((resolve, reject) => p.on("exit", (code) => code === 0 ? resolve(messages.find((m) => m.result)?.result) : reject(new Error(stderr))));
    return { p, messages, done };
  };
  const waitFor = async (f: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!f() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    assert.ok(f(), "child reached the save barrier");
  };
  const first = child();
  let second: ReturnType<typeof child> | undefined;
  try {
    await waitFor(() => first.messages.some((m) => m.ready));
    second = child();
    await waitFor(() => second!.messages.some((m) => m.ready || m.locking));
    fs.writeFileSync(barrier, "go");
    const results = await Promise.all([first.done, second.done]);
    assert.equal(results.filter((r) => r.status === "saved").length, 1, JSON.stringify(results));
    assert.ok(results.some((r) => r.status === "over_cap"));
    assert.deepEqual(planCleanup(Date.now(), limits).remove, []);
    assert.ok(fs.existsSync(path.join(home, "saved", original.id!)));
  } finally {
    fs.writeFileSync(barrier, "go");
    first.p.kill();
    second?.p.kill();
  }
});

test("snapshot cleanup waits for the save lock before deleting evidence", async () => {
  const home = freshHome();
  const { takeLock, releaseLock } = await import("../savedlock.js");
  const snapshot = saveSnapshot(input(1024), [], DEFAULT_LIMITS);
  assert.equal(snapshot.status, "saved");
  const plan = planCleanup(Date.now() + 91 * 86_400_000, DEFAULT_LIMITS);
  assert.equal(plan.remove.length, 1);
  const file = path.join(home, "saved");
  const token = takeLock(file)!;
  assert.ok(token);
  try {
    fs.utimesSync(file + ".lock", new Date(0), new Date(0)); // age alone must never break a live owner's lock
    assert.deepEqual(saveSnapshot(input(1024), [], DEFAULT_LIMITS), { status: "failed", reason: "store" });
    assert.equal(applyCleanup(plan).removed, 0);
    assert.ok(fs.existsSync(path.join(file, snapshot.id!)));
  } finally {
    releaseLock(file, token);
  }
  assert.equal(applyCleanup(plan).removed, 1);
});

test("restored confirmed site restrictions do not reject otherwise valid configuration", async () => {
  const home = freshHome();
  const { parseSites, loadSites, ruleFor } = await import("../sites.js");
  const old = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`old${i}.example`, { never_visit: true }]));
  const next = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`new${i}.example`, { never_visit: true }]));
  fs.writeFileSync(path.join(home, "confirmations.json"), JSON.stringify({ v: 1, ask: true, confirmed: { sites: old }, recent: [] }), { mode: 0o600 });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ sites: next }), { mode: 0o600 });
  assert.equal(Object.keys(parseSites(next)).length, 500);
  const merged = loadSites();
  assert.equal(Object.keys(merged).length, 1000);
  assert.equal(ruleFor("old0.example", merged).never_visit, true);
  assert.equal(ruleFor("new499.example", merged).never_visit, true);
  const invalid = { ...next, "extra.example": { never_visit: true } };
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ sites: invalid }));
  assert.throws(loadSites, /more than 500 sites/);
});
