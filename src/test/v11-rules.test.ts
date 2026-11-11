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

