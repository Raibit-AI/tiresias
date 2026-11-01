// SPDX-License-Identifier: Apache-2.0
// v0.9 (W-33): the MCP server's built-in memory ceiling (ceiling.ts).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { freshHome } from "./helper.js";
import { MEMORY_MB, ceilingLine, ceilingWatch, ceilingReached, memoryMb, over } from "../ceiling.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const MB = 1024 * 1024;

function run(args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("exit", (code, signal) => resolve({ code, signal, out, err }));
    if (input !== undefined) c.stdin.end(input);
  });
}

test("W-33: TIRESIAS_MEMORY_MB is read and checked; off turns the ceiling off", () => {
  assert.equal(memoryMb({}), MEMORY_MB);
  assert.equal(MEMORY_MB, 1024);
  assert.equal(memoryMb({ TIRESIAS_MEMORY_MB: "2048" }), 2048);
  assert.equal(memoryMb({ TIRESIAS_MEMORY_MB: "OFF" }), null);
  for (const bad of ["12", "abc", "1e4", "-1", "99999999", "512.5"]) assert.throws(() => memoryMb({ TIRESIAS_MEMORY_MB: bad }), /TIRESIAS_MEMORY_MB must be/);
});

test("W-33: GC callbacks use the ceiling; between collections only far past it", () => {
  assert.equal(over(1000 * MB, 1024, true), false);
  assert.equal(over(1100 * MB, 1024, true), true);
  assert.equal(over(1100 * MB, 1024, false), false, "garbage not yet collected does not stop the server");
  assert.equal(over(1600 * MB, 1024, false), true);
});

test("9.23: one inflated reading never stops the server; a low reading resets consecutive highs", () => {
  for (const afterFullGc of [true, false]) {
    const reached = ceilingReached(256);
    const high = (afterFullGc ? 300 : 400) * MB;
    assert.equal(reached(high, afterFullGc), false, "one short-lived allocation is tolerated");
    assert.equal(reached(100 * MB, afterFullGc), false);
    assert.equal(reached(high, afterFullGc), false, "the low reading reset the streak");
    assert.equal(reached(high, afterFullGc), true, "a sustained flood still stops");
  }
  const mixed = ceilingReached(256);
  assert.equal(mixed(300 * MB, true), false);
  assert.equal(mixed(400 * MB, false), true, "GC and timer readings share the streak");
});

test("9.23: batched GC events take one reading at callback time, and an isolated high poll is tolerated", () => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import perf from "node:perf_hooks";
    import v8 from "node:v8";
    import { syncBuiltinESMExports } from "node:module";
    let callback, poll, used = 300 * ${MB}, reads = 0;
    perf.PerformanceObserver = class {
      constructor(cb) { callback = cb; }
      observe() {}
    };
    syncBuiltinESMExports();
    v8.getHeapStatistics = () => (reads++, { used_heap_size: used });
    globalThis.setInterval = (cb) => (poll = cb, { unref() {} });
    const { startCeiling } = await import(${JSON.stringify(new URL("../ceiling.js", import.meta.url).href)});
    startCeiling();
    const gc = { detail: { kind: perf.constants.NODE_PERFORMANCE_GC_MAJOR } };
    callback({ getEntries: () => [gc, gc] });
    if (reads !== 1) throw new Error("a batch must take only one reading");
    used = 100 * ${MB}; poll(); // low reading resets the streak
    used = 400 * ${MB}; poll(); // one high timer reading must also be tolerated
    used = 100 * ${MB}; poll();
    used = 300 * ${MB}; callback({ getEntries: () => [gc] });
    process.stdout.write("survived");
    process.exit(0);
  `], { env: { ...process.env, TIRESIAS_HOME: freshHome(), TIRESIAS_MEMORY_MB: "256" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "survived");
  assert.doesNotMatch(r.stderr, /reached its memory ceiling/);
});

test("W-33: tiresias mcp checks TIRESIAS_MEMORY_MB, and leaves the parser workers' own cap alone", async () => {
  const home = freshHome();
  const bad = await run(["mcp"], { ...process.env, TIRESIAS_HOME: home, TIRESIAS_MEMORY_MB: "10" });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /TIRESIAS_MEMORY_MB must be/);
  // Codex client-trust round 1 (HIGH): no process-wide heap flag, so a worker's resourceLimits still hold.
  const r = await run(["mcp"], { ...process.env, TIRESIAS_HOME: home, TIRESIAS_TEST_MEMORY: "probe" });
  const m = /worker_limit_mb=(\d+)/.exec(r.err);
  assert.ok(m, r.err);
  assert.ok(Number(m[1]) < 200, `a worker asking for 64 MB got ${m[1]} MB`);
});

test("W-33: a server that floods its heap stops cleanly at the ceiling, says so, and the daily log lists it", { timeout: 120_000 }, async () => {
  const home = freshHome();
  const env = { ...process.env, TIRESIAS_HOME: home, TIRESIAS_MEMORY_MB: "256", TIRESIAS_TEST_MEMORY: "flood" };
  const r = await run(["mcp"], env);
  assert.equal(r.code, 1);
  assert.equal(r.signal, null); // a plain exit through the cleanup, not a crash
  assert.ok(r.err.includes(ceilingLine(256)), r.err.slice(-2000));
  const log = await run(["log"], { ...process.env, TIRESIAS_HOME: home });
  assert.match(log.out, /## Server stopped/);
  assert.match(log.out, /memory ceiling reached \(256 MB\)/);
  // Private mode records nothing, but still says it on standard error.
  const home2 = freshHome();
  const p = await run(["mcp", "--private"], { ...env, TIRESIAS_HOME: home2 });
  assert.ok(p.err.includes(ceilingLine(256)));
  const log2 = await run(["log"], { ...process.env, TIRESIAS_HOME: home2 });
  assert.doesNotMatch(log2.out, /Server stopped/);
});

test("W-33: the capped server still answers MCP over its standard input and output", async () => {
  const home = freshHome();
  const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  const r = await run(["mcp"], { ...process.env, TIRESIAS_HOME: home, TIRESIAS_MEMORY_MB: "512" }, init + "\n");
  assert.equal(r.code, 0, r.err);
  const first = JSON.parse(r.out.split("\n")[0]);
  assert.equal(first.id, 1);
  assert.ok(first.result?.serverInfo, r.out);
});

test("9.23 (review): polls between full collections do not reset the collections' run of high readings", () => {
  const w = ceilingWatch(1024);
  const held = 1200 * MB; // over the ceiling after a full collection, under the 1.5x poll threshold
  assert.equal(w.gc(held), false, "one reading never stops it");
  assert.equal(w.poll(held), false);
  assert.equal(w.poll(held), false);
  assert.equal(w.gc(held), true, "the second full-collection reading in a row stops it, whatever the polls said");
  const v = ceilingWatch(1024);
  assert.equal(v.poll(1600 * MB), false);
  assert.equal(v.gc(1100 * MB), false);
  assert.equal(v.poll(1600 * MB), true, "two polls far past it in a row stop it");
  const x = ceilingWatch(1024);
  assert.equal(x.gc(held), false);
  assert.equal(x.poll(900 * MB), false, "a reading under the ceiling itself resets the run");
  assert.equal(x.gc(held), false);
});
