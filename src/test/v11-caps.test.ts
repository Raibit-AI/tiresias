// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContent } from "../pipeline.js";
import type { CacheEntry } from "../pagecache.js";
import { parseHtml } from "../reader.js";
import { PageTooComplex } from "../sandbox.js";
import { PassThrough } from "node:stream";
import { Cdp, type CdpEvent } from "../cdp.js";
import fs from "node:fs";
import path from "node:path";
import { pageLog } from "../store.js";
import { withSignal } from "../safety.js";
import { freshHome, serve, text, html } from "./helper.js";
import { FetchError } from "../errors.js";
import { read } from "../engine.js";

test("8.1: outline receipt work is bounded before building it on the main thread", async () => {
  const url = new URL("https://caps.example/final#" + "ÿ".repeat(15_000)).href;
  const parsed = parseHtml("<h1>x</h1>".repeat(10_000), url);
  const entry: CacheEntry = {
    url, source_url: url, final_url: url, door: "text", door_detail: "html", hash: "test",
    fetched_at: new Date().toISOString(), checked_at: new Date().toISOString(), content_type: "text/html", parsed,
  };
  const start = Date.now();
  await assert.rejects(buildContent(entry, {}), PageTooComplex);
  assert.ok(Date.now() - start < 500, "rejected before serializing thousands of large receipts");
});

test("8.1: a long redirect URL and many headings return page_too_complex without saving", async () => {
  const home = freshHome();
  process.env.TIRESIAS_ALLOW_PRIVATE = "1";
  const s = await serve((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    if (req.url === "/start") return text(res, "", 302, { location: "/final#" + "ÿ".repeat(15_000) });
    if (req.url === "/final") return html(res, "<h1>x</h1>".repeat(10_000));
    text(res, "", 404);
  });
  try {
    const r = await read(s.url + "/start");
    assert.equal(r.status, "error");
    assert.match(r.message ?? "", /^page_too_complex/);
    assert.equal(r.untrusted_content, null);
    assert.ok(!fs.existsSync(path.join(home, "cache")) || fs.readdirSync(path.join(home, "cache")).every((name) => !fs.readFileSync(path.join(home, "cache", name), "utf8").includes('"parsed"')));
    assert.ok(!fs.existsSync(path.join(home, "receipts")));
  } finally {
    await s.close();
  }
});

test("8.2: paused requests waiting asynchronously retain bounded metadata, without page headers", () => {
  const input = new PassThrough();
  const cdp = new Cdp(new PassThrough(), input);
  const retained: CdpEvent[] = [];
  cdp.on((e) => retained.push(e)); // stand in for the render's pending asynchronous fetches
  try {
    for (let i = 0; i < 100; i++) input.write(JSON.stringify({
      method: "Fetch.requestPaused", sessionId: "page-session",
      params: { requestId: String(i), frameId: "frame", resourceType: "Fetch", request: {
        url: `https://caps.example/slow?i=${i}`, method: "GET", headers: { "X-Pad": "x".repeat(512 * 1024) },
        postData: "unused page data".repeat(1000),
      } },
    }) + "\0");
    assert.equal(retained.length, 100);
    assert.ok(Buffer.byteLength(JSON.stringify(retained)) < 2 * 1024 * 1024, "100 pending requests must not retain 50 MiB of page headers");
    assert.doesNotMatch(JSON.stringify(retained), /X-Pad|unused page data/);
  } finally {
    input.destroy();
  }
});

test("8.2: bounded preflight fields survive, but oversized request metadata fails closed", () => {
  const input = new PassThrough();
  const cdp = new Cdp(new PassThrough(), input);
  const events: CdpEvent[] = [];
  cdp.on((e) => events.push(e));
  const event = { method: "Fetch.requestPaused", sessionId: "s", params: { requestId: "r", resourceType: "Preflight", request: {
    url: "https://cors.example/x", method: "OPTIONS", headers: { Origin: "https://page.example", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-custom", "X-Pad": "x".repeat(100_000) },
  } } };
  try {
    input.write(JSON.stringify(event) + "\0");
    assert.deepEqual(events[0].params.request.headers, { Origin: "https://page.example", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-custom" });
    event.params.request.url += "x".repeat(8192);
    input.write(JSON.stringify(event) + "\0");
    assert.ok(cdp.closed);
    assert.equal(events.length, 1, "oversized metadata never enters an asynchronous fetch");
  } finally {
    input.destroy();
  }
});
test("8.3: cancelling a log scan stops before consuming the remaining records", async () => {
  const home = freshHome();
  fs.writeFileSync(path.join(home, "history.jsonl"), (JSON.stringify({ text: "x".repeat(1000) }) + "\n").repeat(500));
  const ctl = new AbortController();
  let seen = 0;
  const scan = withSignal(ctl.signal, () => pageLog("history.jsonl", () => {
    if (++seen === 2) ctl.abort();
    return true;
  }));
  await assert.rejects(scan, (e: unknown) => e instanceof FetchError && e.code === "cancelled");
  assert.equal(seen, 2);
});

test("8.3: a stalled log stream ends at its deadline and is destroyed", async () => {
  const home = freshHome();
  fs.writeFileSync(path.join(home, "history.jsonl"), "{}\n");
  const create = fs.createReadStream;
  const input = new PassThrough();
  fs.createReadStream = ((_file: unknown, options: any) => {
    fs.closeSync(options.fd);
    return input;
  }) as unknown as typeof create;
  try {
    await assert.rejects(pageLog("history.jsonl", () => true, 1, 40_000, { deadline: Date.now() + 20 }), (e: unknown) => e instanceof FetchError && e.code === "timeout");
    assert.ok(input.destroyed);
  } finally {
    fs.createReadStream = create;
    input.destroy();
  }
});

test("8.3: appends during a scan cannot extend its starting snapshot", async () => {
  const home = freshHome();
  const file = path.join(home, "history.jsonl");
  const row = JSON.stringify({ text: "x".repeat(1000) }) + "\n";
  fs.writeFileSync(file, row.repeat(500));
  let seen = 0;
  const r = await pageLog("history.jsonl", () => {
    if (++seen === 2) fs.appendFileSync(file, row.repeat(100));
    return true;
  });
  assert.equal(r.total, 500);
  assert.equal(seen, 500);
});

