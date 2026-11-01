// SPDX-License-Identifier: Apache-2.0
// Codex round 8: worker choice by all searchable content, deferred cache save, worker exit, parser version,
// expanded-text cap, worker heap limit.
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";
import { Worker } from "node:worker_threads";
import { freshHome, html, serve, text, type TestServer, timing } from "./helper.js";

const home = freshHome();
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
const engine = await import("../engine.js");
const sandbox = await import("../sandbox.js");
const { parseHtml, parseJsonText, MAX_EXPANDED } = await import("../reader.js");
const { PARSER_VERSION, VERSION } = await import("../types.js");
const servers: TestServer[] = [];
const start = async (h: Parameters<typeof serve>[0]) => {
  const s = await serve(h);
  servers.push(s);
  return s;
};
after(async () => {
  for (const s of servers) await s.close();
  sandbox.stopWorker();
});
const nf = (res: import("node:http").ServerResponse) => text(res, "", 404);
const json = (res: import("node:http").ServerResponse, body: string) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(body);
};
const { cachePath } = await import("../store.js");
const cached = (url: string) => fs.existsSync(cachePath(url));

// Records every job posted to a worker (and can kill the worker right after dispatch).
function spyOnWorkers(killAfterPost = false) {
  const jobs: string[] = [];
  const orig = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (this: Worker, ...args: Parameters<Worker["postMessage"]>) {
    jobs.push((args[0] as { op: string }).op);
    orig.apply(this, args);
    if (killAfterPost) void this.terminate();
  } as typeof orig;
  return { jobs, restore: () => (Worker.prototype.postMessage = orig) };
}

test("version matches package.json; parser version moved past v0.1.6", () => {
  assert.equal(VERSION, JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version);
  assert.ok(PARSER_VERSION >= 4, "v0.1.6/v0.1.7 caches must rebuild");
});

test("worker or inline is chosen by all searchable content, JSON-LD included", async () => {
  const ld = '<script type="application/ld+json">' + JSON.stringify({ data: "target ".repeat(5000) }) + "</script>";
  const page = "<html><head><title>T</title>" + ld + "</head><body></body></html>";
  const p = parseHtml(page, "http://x.test/");
  assert.equal(p.text_chars, 0);
  assert.ok(p.searchable_chars > 30_000, `searchable ${p.searchable_chars}`);
  const spy = spyOnWorkers();
  try {
    const s = await start((req, res) => (req.url === "/robots.txt" ? nf(res) : html(res, page)));
    const r = await engine.read(s.url + "/ld", { question: "target" });
    assert.equal(r.status, "ok");
    assert.ok(spy.jobs.includes("search"), `jobs: ${spy.jobs.join(",")}`);
  } finally {
    spy.restore();
  }
});

test("a passage search that times out leaves nothing cached", async () => {
  process.env.TIRESIAS_PARSE_BUDGET_MS = "1";
  sandbox.stopWorker();
  try {
    const body = "[".repeat(200) + JSON.stringify(Array(500).fill("target")) + "]".repeat(200);
    assert.ok(body.length < 8 * 1024, "parse must run inline so only the search hits the worker");
    const s = await start((req, res) => (req.url === "/robots.txt" ? nf(res) : json(res, body)));
    const r = await engine.read(s.url + "/j", { question: "target" });
    assert.equal(r.status, "error");
    assert.match(r.message ?? "", /^page_too_complex/);
    assert.ok(!cached(s.url + "/j"), "a failed call must not leave a cached page");
    delete process.env.TIRESIAS_PARSE_BUDGET_MS;
    assert.equal((await engine.read(s.url + "/j", { page: 1 })).status, "ok"); // fresh read, not "unchanged"
    assert.ok(cached(s.url + "/j"));
  } finally {
    delete process.env.TIRESIAS_PARSE_BUDGET_MS;
  }
});

test("a worker that exits without an error event fails the job promptly, and the next job works", async () => {
  process.env.TIRESIAS_PARSE_BUDGET_MS = "20000";
  sandbox.stopWorker();
  const spy = spyOnWorkers(true);
  const big = "word ".repeat(5000);
  try {
    const t0 = Date.now();
    await assert.rejects(sandbox.runUntrusted({ op: "parse", kind: "text", body: big, url: "http://x.test/" }, big.length), /worker failed/);
    timing(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`);
  } finally {
    spy.restore();
    delete process.env.TIRESIAS_PARSE_BUDGET_MS;
  }
  const ok = await sandbox.runUntrusted<{ parsed: { text_chars: number } }>({ op: "parse", kind: "text", body: big, url: "http://x.test/" }, big.length);
  assert.ok(ok.parsed.text_chars > 0);
});

test("expanded JSON text is capped and the omission is counted, not silent", async () => {
  const nested = "[".repeat(600) + "1" + "]".repeat(600);
  assert.ok(nested.length < 2000);
  const small = parseJsonText('{"a":[1,2]}', "http://x.test/");
  assert.equal(small.text_omitted, undefined);
  const p = parseJsonText(nested, "http://x.test/");
  assert.equal(p.text_omitted, undefined); // 600 levels is still small
  // a document that expands past the cap: wide arrays nested to depth
  const wide = JSON.stringify({ a: Array.from({ length: 150_000 }, (_, i) => ({ k: i, v: "x" })) });
  const big = parseJsonText(wide, "http://x.test/");
  assert.ok(big.text_omitted && big.text_omitted > 0, "omission counted");
  assert.ok(big.text_chars <= MAX_EXPANDED + 10, `kept ${big.text_chars}`); // the cap plus the section heading
  assert.equal(big.searchable_chars, big.text_chars);
  // through the engine: reported in the result
  const s = await start((req, res) => (req.url === "/robots.txt" ? nf(res) : json(res, wide)));
  const r = await engine.read(s.url + "/wide", { page: 1 });
  assert.equal(r.status, "ok");
  assert.equal((r.untrusted_content as any).text_omitted, big.text_omitted);
});

test("a worker that runs out of heap fails as page_too_complex and the parent keeps working", async () => {
  process.env.TIRESIAS_WORKER_HEAP_MB = "4";
  sandbox.stopWorker();
  const body = "word ".repeat(2_000_000); // 10 MB of text cannot be parsed inside a 4 MB heap
  try {
    await assert.rejects(sandbox.runUntrusted({ op: "parse", kind: "text", body, url: "http://x.test/" }, body.length), sandbox.PageTooComplex);
  } finally {
    delete process.env.TIRESIAS_WORKER_HEAP_MB;
  }
  sandbox.stopWorker();
  const small = "word ".repeat(5000);
  const ok = await sandbox.runUntrusted<{ parsed: { text_chars: number } }>({ op: "parse", kind: "text", body: small, url: "http://x.test/" }, small.length);
  assert.ok(ok.parsed.text_chars > 0);
  assert.equal(sandbox.workerHeapMb(), sandbox.WORKER_HEAP_MB);
});

test("a no-store response removes the old copy even when the search then fails (round 9)", async () => {
  sandbox.stopWorker();
  const body = "[".repeat(200) + JSON.stringify(Array(500).fill("target")) + "]".repeat(200);
  let noStore = false;
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") return nf(res);
    res.writeHead(200, { "content-type": "application/json", ...(noStore ? { "cache-control": "no-store" } : {}) });
    res.end(body);
  });
  assert.equal((await engine.read(s.url + "/n", { page: 1 })).status, "ok");
  assert.ok(cached(s.url + "/n"), "first read is cached");
  noStore = true;
  process.env.TIRESIAS_PARSE_BUDGET_MS = "1";
  try {
    const r = await engine.read(s.url + "/n", { question: "target" });
    assert.match(r.message ?? "", /^page_too_complex/);
    assert.ok(!cached(s.url + "/n"), "no-store must remove the old copy whatever happens next");
  } finally {
    delete process.env.TIRESIAS_PARSE_BUDGET_MS;
  }
});

test("a no-store response removes the old copy even when parsing fails (round 10)", async () => {
  sandbox.stopWorker();
  const page = "<html><body>" + "<p>target words here</p>".repeat(2000) + "</body></html>";
  assert.ok(page.length > 8 * 1024, "parse must go to the worker so the budget can stop it");
  let noStore = false;
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") return nf(res);
    res.writeHead(200, { "content-type": "text/html", ...(noStore ? { "cache-control": "no-store" } : {}) });
    res.end(page + (noStore ? "<p>changed</p>" : ""));
  });
  assert.equal((await engine.read(s.url + "/p", { page: 1 })).status, "ok");
  assert.ok(cached(s.url + "/p"), "first read is cached");
  noStore = true;
  process.env.TIRESIAS_PARSE_BUDGET_MS = "1";
  try {
    const r = await engine.read(s.url + "/p", { page: 1 });
    assert.match(r.message ?? "", /^page_too_complex/);
    assert.ok(!cached(s.url + "/p"), "no-store must remove the old copy before parsing");
  } finally {
    delete process.env.TIRESIAS_PARSE_BUDGET_MS;
  }
});
