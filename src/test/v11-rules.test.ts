// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { check } from "../engine.js";
import { getRobots, parseRobots } from "../rules.js";
import { politeFetch } from "../fetcher.js";
import { Refused } from "../errors.js";
import { cooldownLeft } from "../cooldown.js";
import { freshHome, html, serve, text } from "./helper.js";

freshHome();
process.env.TIRESIAS_ALLOW_PRIVATE = "1";

test("5.1: a robots redirect cannot request another origin's arbitrary path", async () => {
  for (const destination of ["/private/export", "/robots.txt?export=1"]) {
    freshHome();
    const b = await serve((req, res) => text(res, "User-agent: *\nDisallow: /private"));
    const a = await serve((req, res) => {
      if (req.url === "/robots.txt") return text(res, "", 302, { location: b.url + destination });
      html(res, "<p>page</p>");
    });
    try {
      const r = await check(a.url + "/page");
      assert.equal(r.status, "refused");
      assert.equal(b.hits.length, 0, "the other origin's path was never requested");
      assert.equal(a.count("/page"), 0);
    } finally {
      await a.close();
      await b.close();
    }
  }
});

test("5.1: a cross-origin robots redirect to /robots.txt still supplies rules", async () => {
  freshHome();
  const b = await serve((_req, res) => text(res, "User-agent: *\nDisallow: /private"));
  const a = await serve((_req, res) => text(res, "", 302, { location: b.url + "/robots.txt" }));
  try {
    const r = await getRobots(a.url);
    assert.equal(r.mode, "parsed");
    assert.equal(r.rules[0].pattern, "/private");
    assert.deepEqual(b.hits.map((h) => h.path), ["/robots.txt"]);
  } finally {
    await a.close();
    await b.close();
  }
});
test("5.3: Retry-After stops page, robots and rendered redirects before following", async () => {
  for (const kind of ["page", "robots", "rendered"]) for (const cross of [false, true]) {
    freshHome();
    const b = await serve((_req, res) => html(res, "<p>destination</p>"));
    const a = await serve((req, res) => {
      const start = kind === "robots" ? "/robots.txt" : "/start";
      if (req.url === start) return text(res, "", 302, { location: (cross ? b.url : "") + (kind === "robots" ? "/robots.txt" : "/next"), "retry-after": "3600" });
      if (req.url === "/robots.txt") return text(res, "", 404);
      html(res, "<p>destination</p>");
    });
    try {
      const run = kind === "robots" ? getRobots(a.url) : politeFetch(a.url + "/start", { followRedirects: kind !== "rendered" });
      await assert.rejects(run, (e: unknown) => e instanceof Refused && (e.retrySeconds ?? 0) >= 3599);
      assert.ok(cooldownLeft(a.url) >= 3599);
      assert.equal(a.count("/next"), 0);
      assert.equal(b.hits.length, 0);
    } finally {
      await a.close();
      await b.close();
    }
  }
});

test("5.4: a learned 120-second Crawl-delay also protects later robots refreshes", async () => {
  freshHome();
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  const s = await serve((req, res) => req.url === "/robots.txt" ? text(res, "User-agent: *\nCrawl-delay: 120") : html(res, "<p>page</p>"));
  try {
    assert.equal((await check(s.url + "/page", { agent: "test", private: true })).status, "refused");
    offset = 31_000;
    const r = await check(s.url + "/page", { agent: "test", private: true, signal: AbortSignal.timeout(500) });
    assert.equal(s.count("/robots.txt"), 1, "the full learned delay still applies");
    assert.equal(r.status, "refused", "decline instead of waiting past the budget");
  } finally {
    Date.now = realNow;
    await s.close();
  }
});

test("5.5: matching robots groups and repeated directives keep the longest Crawl-delay", async () => {
  const texts = [
    "User-agent: Tiresias\nDisallow: /x\nCrawl-delay: 1\nUser-agent: Tiresias\nDisallow: /y\nCrawl-delay: 120",
    "User-agent: Tiresias\nDisallow: /x\nCrawl-delay: 120\nUser-agent: Tiresias\nDisallow: /y\nCrawl-delay: 1",
    "User-agent: *\nCrawl-delay: 120\nCrawl-delay: 1",
    "User-agent: *\nCrawl-delay: 1\nCrawl-delay: 120",
  ];
  for (const robots of texts) {
    assert.equal(parseRobots(robots).crawlDelay, 120);
    freshHome();
    const s = await serve((req, res) => req.url === "/robots.txt" ? text(res, robots) : html(res, "<p>page</p>"));
    try {
      assert.equal((await check(s.url + "/open")).status, "refused");
      assert.equal(s.count("/open"), 0);
    } finally {
      await s.close();
    }
  }
});


test("D.3: a robots body cut inside Allow fails closed for plain and compressed successes", async () => {
  const zlib = await import("node:zlib");
  const { safeFetch } = await import("../safety.js");
  const { isAllowed, rulesCache } = await import("../rules.js");
  const { throttle } = await import("../queue.js");
  const limit = 512 * 1024;
  const prefix = "User-agent: *\nDisallow: /private\nCrawl-delay: 120\n";
  const allow = "\nAllow: /private";
  const body = prefix + "#" + "x".repeat(limit - prefix.length - 1 - allow.length) + allow + "-public\n";
  assert.equal(body.slice(0, limit).endsWith(allow), true);
  assert.equal(isAllowed(parseRobots(body), "/private/secret"), false);
  assert.equal(isAllowed(parseRobots(body.slice(0, limit)), "/private/secret"), true, "the shortened Allow would win");
  const encodings = [
    ["identity", Buffer.from(body)],
    ["gzip", zlib.gzipSync(body)],
    ["br", zlib.brotliCompressSync(body)],
    ["deflate", zlib.deflateSync(body)],
    ["deflate", zlib.deflateRawSync(body)],
  ] as const;
  for (const [encoding, bytes] of encodings) for (const status of [200, 201]) {
    freshHome();
    const s = await serve((req, res) => {
      if (req.url !== "/robots.txt") return html(res, "<p>must not be fetched</p>");
      res.writeHead(status, { "content-type": "text/plain", "content-encoding": encoding });
      res.end(bytes);
    });
    try {
      const fetched = await safeFetch(s.url + "/robots.txt", { maxBytes: limit, truncate: true });
      assert.equal(fetched.truncated, true, `${encoding} HTTP ${status}`);
      assert.equal(fetched.body.length, limit);
      const r = await check(s.url + "/private/secret");
      assert.equal(r.status, "refused");
      assert.match(r.message ?? "", /larger than 512 KB.*assumes the site says no/);
      assert.equal(s.count("/private/secret"), 0);
      const cached = rulesCache.get(s.url)!;
      assert.equal(cached.mode, "disallow_all");
      assert.deepEqual(cached.rules, []);
      assert.equal(cached.crawlDelay, 0);
      // No Crawl-delay may be learned from the refused prefix.
      const release = await throttle(s.url, 0, AbortSignal.timeout(500), s.url + "/probe");
      release();
    } finally { await s.close(); }
  }
});

test("D.3: robots bodies at and just under 512 KB still supply rules", async () => {
  const { isAllowed } = await import("../rules.js");
  const prefix = "User-agent: *\nDisallow: /private\nAllow: /public\n";
  for (const length of [512 * 1024 - 1, 512 * 1024]) {
    freshHome();
    const body = prefix + "#" + "x".repeat(length - prefix.length - 2) + "\n";
    assert.equal(Buffer.byteLength(body), length);
    const s = await serve((_req, res) => text(res, body));
    try {
      const r = await getRobots(s.url);
      assert.equal(r.mode, "parsed");
      assert.equal(isAllowed(r, "/private/secret"), false);
      assert.equal(isAllowed(r, "/public"), true);
      assert.equal(r.rules.length, 2);
    } finally { await s.close(); }
  }
});

test("D.3: safeFetch also marks a cut file stream as truncated", async () => {
  const { safeFetch } = await import("../safety.js");
  freshHome();
  const s = await serve((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    // Chunked, so the size is discovered during intake rather than from Content-Length.
    res.write(Buffer.alloc(req.url === "/cut" ? 2000 : 500, 0));
    res.end();
  });
  try {
    const cut = await safeFetch(s.url + "/cut", { files: { maxBytes: 1000 } });
    assert.equal(cut.file?.stopped, "too_large");
    assert.equal(cut.truncated, true);
    const whole = await safeFetch(s.url + "/whole", { files: { maxBytes: 1000 } });
    assert.ok(whole.file?.sha256);
    assert.equal(whole.file?.stopped, undefined);
    assert.equal(whole.truncated, false);
  } finally { await s.close(); }
});
