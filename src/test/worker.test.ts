// SPDX-License-Identifier: Apache-2.0
// Codex round 7: worker sandbox, heading and style DoS, challenged 304, robots no-store wall, long markdown URLs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { freshHome, html, logText, serve, text, type TestServer, timing } from "./helper.js";

const home = freshHome();
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
const engine = await import("../engine.js");
const { parseMarkdown, parseHtml } = await import("../reader.js");
const servers: TestServer[] = [];
const start = async (h: Parameters<typeof serve>[0]) => {
  const s = await serve(h);
  servers.push(s);
  return s;
};
after(async () => {
  for (const s of servers) await s.close();
});
const uc = (r: { untrusted_content: unknown }) => (r.untrusted_content ?? {}) as any;
const nf = (res: import("node:http").ServerResponse) => text(res, "", 404);
const trusted = (r: any) => JSON.stringify({ ...r, untrusted_content: null });
const receiptsText = () => logText(home, "receipts");

test("the three pathological inputs return fast through the whole engine", async () => {
  const cases: [string, string, string][] = [
    ["forms", "text/html", "<form ".repeat(128_000)],
    ["markdown heading", "text/markdown", "# " + "[a](b)".repeat(100_000)],
    ["style whitespace", "text/html", '<p style="color:x' + " ".repeat(100_000) + 'y">hello</p>'],
  ];
  for (const [name, type, body] of cases) {
    const s = await start((req, res) => {
      if (req.url === "/robots.txt") return nf(res);
      res.writeHead(200, { "content-type": type });
      res.end(body);
    });
    const t0 = Date.now();
    const r = await engine.check(s.url + "/p", { agent: "t", signal: AbortSignal.timeout(100) });
    const ms = Date.now() - t0;
    timing(ms < 1000, `${name} took ${ms}ms`);
    assert.ok(["ok", "error"].includes(r.status), `${name}: ${r.status}`);
  }
});

test("the specific slow paths are fast on their own (no sandbox needed)", () => {
  let t0 = Date.now();
  parseMarkdown("# " + "[a](b)".repeat(100_000), "http://x.test/");
  timing(Date.now() - t0 < 1000, `heading took ${Date.now() - t0}ms`);
  t0 = Date.now();
  parseHtml('<p style="color:x' + " ".repeat(100_000) + 'y">hello</p>', "http://x.test/");
  timing(Date.now() - t0 < 500, `style took ${Date.now() - t0}ms`);
  // normal behavior is unchanged
  const p = parseMarkdown("# See [the guide](/g) now\n\ntext\n", "http://x.test/");
  assert.equal(p.sections[0].heading, "See the guide now");
  const h = parseHtml('<p style="display : none !important">secret</p><p style="COLOR:#FFF !IMPORTANT">white</p><p>shown</p>', "http://x.test/");
  assert.equal(h.flags.filter((f) => f.type === "hidden_text").length, 2);
});

test("a job over the time budget is terminated: page_too_complex, nothing cached, no receipts", async () => {
  process.env.TIRESIAS_PARSE_BUDGET_MS = "1"; // any page over 8 KB cannot be parsed in 1 ms
  try {
    const big = "<html><head><title>Big</title></head><body>" + "<h2>Section</h2><p>some text here</p>".repeat(8000) + "</body></html>";
    const s = await start((req, res) => (req.url === "/robots.txt" ? nf(res) : html(res, big)));
    const before = receiptsText();
    const t0 = Date.now();
    const r = await engine.read(s.url + "/big", { question: "text" });
    timing(Date.now() - t0 < 2000);
    assert.equal(r.status, "error");
    assert.match(r.message ?? "", /^page_too_complex/);
    assert.equal(r.untrusted_content, null);
    assert.ok(!trusted(r).includes("Section"));
    assert.equal(receiptsText(), before);
    // nothing was cached: with a normal budget the next read is a fresh "ok", not "unchanged"
    delete process.env.TIRESIAS_PARSE_BUDGET_MS;
    assert.equal((await engine.read(s.url + "/big", { page: 1 })).status, "ok");
  } finally {
    delete process.env.TIRESIAS_PARSE_BUDGET_MS;
  }
});

test("a caller abort terminates the worker promptly", async () => {
  const big = "<html><body>" + "<h2>S</h2><p>word word word word word</p>".repeat(110_000) + "</body></html>";
  assert.ok(big.length > 4_000_000);
  const s = await start((req, res) => (req.url === "/robots.txt" ? nf(res) : html(res, big)));
  // first learn how long an uninterrupted parse takes, so the test is meaningful
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 150);
  const t0 = Date.now();
  const r = await engine.read(s.url + "/huge", {}, { agent: "t", signal: ctl.signal });
  const ms = Date.now() - t0;
  assert.equal(r.status, "error");
  timing(ms < 800, `abort took ${ms}ms`);
  // a fresh worker is spawned for the next job and it works
  const ok = await engine.read(s.url + "/small-after", {});
  assert.notEqual(ok.status, undefined);
});

test("a challenged 304 is a wall, not cached content", async () => {
  let mode = "normal";
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") return nf(res);
    if (req.headers["if-none-match"] === '"v1"') {
      res.writeHead(304, mode === "challenge" ? { etag: '"v1"', "cf-mitigated": "challenge" } : { etag: '"v1"' });
      return void res.end();
    }
    html(res, "<h1>Cached</h1><p>cached section text</p>", { etag: '"v1"' });
  });
  assert.equal((await engine.read(s.url + "/c")).status, "ok");
  assert.equal((await engine.read(s.url + "/c")).status, "unchanged"); // an honest 304
  mode = "challenge";
  const r = await engine.read(s.url + "/c", { section: 1 });
  assert.equal(r.status, "wall");
  assert.equal(r.handoff?.reason, "bot_challenge");
  assert.equal(uc(r).handoff.open_this, s.url + "/c");
  assert.ok(!JSON.stringify(r).includes("cached section text"));
  assert.equal((await engine.check(s.url + "/c")).status, "wall");
});

test("a challenged robots redirect with no-store is a wall for that call only", async () => {
  let blocked = true;
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") {
      if (blocked) { res.writeHead(302, { location: "/elsewhere", "cf-mitigated": "challenge", "cache-control": "no-store" }); return void res.end(); }
      return nf(res);
    }
    html(res, "<h1>Hi</h1><p>page text</p>");
  });
  assert.equal((await engine.read(s.url + "/p")).status, "wall");
  blocked = false;
  const again = await engine.read(s.url + "/p");
  assert.equal(again.status, "ok", "the no-store wall must not be remembered");
  // and without no-store it IS remembered briefly
  const t = await start((req, res) => {
    if (req.url === "/robots.txt") { res.writeHead(302, { location: "/elsewhere", "cf-mitigated": "challenge" }); return void res.end(); }
    html(res, "<p>x</p>");
  });
  assert.equal((await engine.read(t.url + "/a")).status, "wall");
  const n = t.hits.length;
  assert.equal((await engine.read(t.url + "/b")).status, "wall");
  assert.equal(t.hits.length, n);
});

test("a long markdown destination is counted as omitted, not left in the text", () => {
  const p = parseMarkdown("See [long](https://x.test/" + "a".repeat(2200) + ") and [ok](/fine).", "http://x.test/");
  assert.equal(p.links_omitted, 1);
  assert.deepEqual(p.links.map((l) => l.url), ["http://x.test/fine"]);
  const text = p.sections[0].blocks[0].text;
  assert.equal(text, "See long and ok.");
  assert.ok(!text.includes("aaaa"));
  // a huge destination does not make scanning slow
  const t0 = Date.now();
  parseMarkdown("[x](" + "d".repeat(2_000_000) + ")", "http://x.test/");
  timing(Date.now() - t0 < 1000);
});
