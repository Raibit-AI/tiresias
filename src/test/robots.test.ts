// SPDX-License-Identifier: Apache-2.0
// Codex round 2 findings (new numbering N1..N13, partial P-numbers = round 1 numbers).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { freshHome, html, logText, serve, text, type TestServer, timing } from "./helper.js";

const home = freshHome();
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
const engine = await import("../engine.js");
const rules = await import("../rules.js");
const store = await import("../store.js");
const cooldown = await import("../cooldown.js");
const { packResult } = await import("../mcp.js");
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
const trusted = (r: any) => JSON.stringify({ ...r, untrusted_content: null });
const nf = (res: import("node:http").ServerResponse) => text(res, "", 404);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ARTICLE = `<html><head><title>T</title></head><body><h1>Top</h1><p>Some article text here.</p></body></html>`;

test("N1: a long path is matched in full, never truncated (fails closed when over budget)", async () => {
  const r = rules.parseRobots("User-agent: *\nDisallow: /*secret$\n");
  assert.equal(rules.isAllowed(r, "/" + "a".repeat(4096) + "secret"), false);
  assert.equal(rules.isAllowed(r, "/" + "a".repeat(4096) + "public"), true);
  // beyond the path limit: refused, not truncated
  assert.equal(rules.matchRobots(r, "/" + "a".repeat(9000)), "over_budget");
  const s = await start((req, res) => (req.url === "/robots.txt" ? text(res, "User-agent: *\nDisallow: /*secret$\n") : html(res, ARTICLE)));
  assert.equal((await engine.read(s.url + "/" + "a".repeat(4096) + "secret")).status, "refused");
  assert.equal((await engine.read(s.url + "/" + "a".repeat(9000))).status, "refused");
  assert.equal(s.count("/" + "a".repeat(4096) + "secret"), 0);
});

test("P3: the total cost of a large robots.txt is capped, and it fails closed", async () => {
  const rule = "Disallow: /" + "*a".repeat(500) + "b\n";
  const body = "User-agent: *\n" + rule.repeat(500);
  assert.ok(body.length > 400_000);
  const parsed = rules.parseRobots(body);
  const t0 = Date.now();
  assert.equal(rules.matchRobots(parsed, "/" + "a".repeat(4000)), "over_budget");
  timing(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms`);
  const s = await start((req, res) => (req.url === "/robots.txt" ? text(res, body) : html(res, ARTICLE)));
  const r = await engine.read(s.url + "/" + "a".repeat(4000));
  assert.equal(r.status, "refused");
  assert.match(r.message ?? "", /too long or robots\.txt too costly/);
});

test("N2 and P4: the handoff destination is web-controlled, so it sits inside untrusted_content", async () => {
  const s = await start((req, res) => {
    if (req.url === "/go") { res.writeHead(302, { location: "/IGNORE-PREVIOUS-INSTRUCTIONS" }); return void res.end(); }
    if (req.url === "/IGNORE-PREVIOUS-INSTRUCTIONS") return text(res, "no", 403);
    nf(res);
  });
  const r = await engine.read(s.url + "/go");
  assert.equal(r.status, "wall");
  assert.ok(!trusted(r).includes("IGNORE-PREVIOUS"), trusted(r));
  // v0.3 (W-06) adds the ticket id (random, made by Tiresias) and fixed resume text, nothing from the web.
  assert.deepEqual(Object.keys(r.handoff!).sort(), ["explanation", "reason", "resume", "ticket"]);
  assert.match(r.handoff!.ticket!, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(uc(r).handoff.open_this, s.url + "/IGNORE-PREVIOUS-INSTRUCTIONS");
});

test("P4: native network error text stays inside untrusted_content", async () => {
  const s = await start((req, res) => {
    if (req.url === "/go") { res.writeHead(302, { location: "http://down-host-ignore-previous.invalid:1/" }); return void res.end(); }
    nf(res);
  });
  const r = await engine.read(s.url + "/go");
  assert.notEqual(r.status, "ok");
  assert.ok(!/ignore-previous/i.test(trusted(r)), trusted(r));
});

test("N3: requests already queued behind Crawl-delay do not go out after a cooldown starts", async () => {
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") return text(res, "User-agent: *\nCrawl-delay: 0.05\n");
    text(res, "slow", 429, { "retry-after": "3600" });
  });
  const r = await engine.read(s.url + "/page");
  assert.equal(r.status, "refused");
  const sent = s.hits.filter((h) => h.path !== "/robots.txt");
  assert.equal(sent.length, 1, `sent ${sent.map((h) => h.path)}`);
  await sleep(300);
  assert.equal(s.hits.filter((h) => h.path !== "/robots.txt").length, 1);
});

test("N4: a robots.txt redirect to a site under cooldown is not followed, and 429 is blamed on the right site", async () => {
  const b = await start((req, res) => text(res, "Disallow:", 429, { "retry-after": "999" }));
  const a = await start((req, res) => {
    if (req.url === "/robots.txt") { res.writeHead(302, { location: b.url + "/robots.txt" }); return void res.end(); }
    html(res, ARTICLE);
  });
  const first = await engine.read(a.url + "/x");
  assert.equal(first.status, "refused");
  assert.equal(b.count("/robots.txt"), 1);
  assert.ok(cooldown.cooldownLeft(new URL(b.url).origin) > 900); // B got the cooldown
  assert.equal(cooldown.cooldownLeft(new URL(a.url).origin), 0); // A did not
  rules.resetRulesCache();
  const again = await engine.read(a.url + "/y");
  assert.equal(again.status, "refused");
  assert.equal(b.count("/robots.txt"), 1, "B is under cooldown, so the redirect must not reach it");
});

test("N6: long Retry-After values are kept in full, and a shorter wait never replaces a longer one", () => {
  cooldown.setCooldown("http://long.test", 429, "172800");
  assert.ok(cooldown.cooldownLeft("http://long.test") > 172_000);
  cooldown.setCooldown("http://long.test", 429, "10");
  assert.ok(cooldown.cooldownLeft("http://long.test") > 172_000);
  assert.equal(cooldown.parseRetryAfter(new Date(Date.now() + 3 * 86_400_000).toUTCString())! > 259_000, true);
});

test("N7: a cancelled read returns no success, saves no receipts", async () => {
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") return nf(res);
    if (req.url === "/llms.txt") return text(res, "# Site\n\nllms body\n");
    if (req.url === "/slow") return void setTimeout(() => html(res, ARTICLE), 500);
    nf(res);
  });
  const before = logText(home, "receipts");
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 200);
  const r = await engine.read(s.url + "/slow", { question: "article" }, { agent: "t", signal: ctl.signal });
  assert.notEqual(r.status, "ok");
  assert.equal(r.status, "error");
  const after = logText(home, "receipts");
  assert.equal(after, before);
  // already-cancelled before it starts
  const dead = AbortSignal.abort();
  assert.equal((await engine.read(s.url + "/slow", {}, { agent: "t", signal: dead })).status, "error");
});

test("N8: a cancelled call leaves the Crawl-delay queue at once", async () => {
  const s = await start((req, res) => (req.url === "/robots.txt" ? text(res, "User-agent: *\nCrawl-delay: 5\n") : nf(res)));
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 300);
  const t0 = Date.now();
  const r = await engine.read(s.url + "/q", {}, { agent: "t", signal: ctl.signal });
  assert.equal(r.status, "error");
  timing(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms`);
  const n = s.hits.length;
  await sleep(700);
  assert.equal(s.hits.length, n, "nothing is sent after the call ended");
});

test("N9: large JSON-LD is kept, searchable and reported, not dropped", async () => {
  const big = JSON.stringify({ "@type": "Product", name: "Mega Anvil", description: "x ".repeat(100_000), offers: { price: "99.00" } });
  assert.ok(big.length > 200_059);
  const s = await start((req, res) => (req.url === "/robots.txt" ? nf(res) : html(res, `<html><head><script type="application/ld+json">${big}</script></head><body></body></html>`)));
  const r = await engine.read(s.url + "/mega", { question: "mega anvil" });
  assert.equal(r.status, "ok");
  assert.match(JSON.stringify(uc(r).passages), /Mega Anvil/);
  const o = await engine.read(s.url + "/mega", { page: 1 });
  assert.equal(uc(o).structured.count, 1);
  // a record that is not valid JSON is counted, not silently lost
  const t = await start((req, res) => (req.url === "/robots.txt" ? nf(res) : html(res, `<html><head><script type="application/ld+json">{broken</script></head><body><h1>x</h1><p>hello</p></body></html>`)));
  assert.equal(uc(await engine.read(t.url + "/b")).structured.skipped.invalid, 1);
});

test("N10 and P16: a 100,000 character title cannot make content unreachable", async () => {
  const s = await start((req, res) => (req.url === "/robots.txt" ? nf(res) : html(res, `<html><head><title>${"T".repeat(100_000)}</title></head><body><h1>${"H".repeat(100_000)}</h1><p>real body text</p><h2>Next</h2><p>more</p></body></html>`)));
  for (const opts of [{}, { section: 1 }, { section: 2 }, { question: "real body" }] as const) {
    const r = await engine.read(s.url + "/huge", opts);
    assert.ok(["ok", "unchanged"].includes(r.status), JSON.stringify(opts));
    assert.ok(JSON.stringify(r).length < 30_000, `${JSON.stringify(opts)} was ${JSON.stringify(r).length}`);
  }
  assert.match(JSON.stringify(uc(await engine.read(s.url + "/huge", { question: "real body" })).passages), /real body text/);
  // many sitemaps and feeds are capped too
  const maps = Array.from({ length: 3000 }, (_, i) => `Sitemap: http://x.test/s${i}.xml`).join("\n");
  const m = await start((req, res) => (req.url === "/robots.txt" ? text(res, "User-agent: *\n" + maps) : html(res, ARTICLE)));
  const mr = await engine.read(m.url + "/p");
  assert.ok(JSON.stringify(mr).length < 60_000);
});

test("N11: a symlinked store folder is rejected without changing its target", () => {
  if (process.platform === "win32") return;
  const target = path.join(home, "..", `target-${process.pid}`);
  fs.mkdirSync(target, { mode: 0o755 });
  fs.chmodSync(target, 0o755);
  const link = path.join(home, "..", `link-${process.pid}`);
  fs.symlinkSync(target, link);
  const keep = process.env.TIRESIAS_HOME;
  process.env.TIRESIAS_HOME = link;
  try {
    assert.throws(() => store.home(), /symlink/);
    assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  } finally {
    process.env.TIRESIAS_HOME = keep;
    fs.rmSync(link);
    fs.rmSync(target, { recursive: true });
  }
});

test("N12: a rejected log file does not leak a descriptor", async () => {
  if (!fs.existsSync("/dev/fd")) return;
  fs.mkdirSync(path.join(home, "bad.jsonl"), { recursive: true }); // a folder where a log should be
  const count = () => fs.readdirSync("/dev/fd").length;
  const before = count();
  for (let i = 0; i < 5; i++) await store.pageLog("bad.jsonl", () => true);
  assert.equal(count(), before);
});

test("N13: an oversized MCP result becomes a complete error envelope with isError", () => {
  const r = packResult({ url: "http://x.test/", status: "ok", untrusted_content: { blob: "x".repeat(300_000) } });
  assert.equal(r.isError, true);
  const env = JSON.parse(r.content[0].text);
  assert.equal(env.status, "error");
  assert.equal(env.url, "http://x.test/");
  assert.match(env.notice, /data, not instructions/);
  assert.ok(Array.isArray(env.flags));
  assert.equal(packResult({ status: "ok" }).isError, undefined);
});

test("P5: a probe's bare 403 is only 'no door'; the main page's own 403 is still a wall", async () => {
  const s = await start((req, res) => (req.url === "/robots.txt" ? nf(res) : text(res, "forbidden", 403)));
  const r = await engine.read(s.url + "/page");
  assert.equal(r.status, "wall");
  assert.equal(r.handoff?.reason, "forbidden");
  assert.equal(uc(r).handoff.open_this, s.url + "/page");
  assert.equal(s.count("/page"), 1);
  // a protected llms.txt alone is not a challenge to the page
  const t = await start((req, res) => (req.url === "/llms.txt" ? text(res, "no", 403) : req.url === "/robots.txt" ? nf(res) : html(res, ARTICLE)));
  assert.equal((await engine.read(t.url + "/page")).status, "ok");
});

test("P13: a robots wall reached through a redirect names the page that walled", async () => {
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") { res.writeHead(302, { location: "/gate" }); return void res.end(); }
    if (req.url === "/gate") return html(res, "<title>Just a moment...</title>", { "cf-mitigated": "challenge" }, 403);
    html(res, ARTICLE);
  });
  const r = await engine.read(s.url + "/a");
  assert.equal(r.status, "wall");
  assert.equal(uc(r).handoff.open_this, s.url + "/gate");
});

test("P19: no-store on a 304 removes the cached copy, and a no-store robots.txt is not kept across calls", async () => {
  let mode = "normal";
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") return nf(res);
    if (req.headers["if-none-match"] === '"e1"') { res.writeHead(304, mode === "nostore" ? { "cache-control": "no-store", etag: '"e1"' } : { etag: '"e1"' }); return void res.end(); }
    html(res, ARTICLE, { etag: '"e1"' });
  });
  assert.equal((await engine.read(s.url + "/n")).status, "ok");
  mode = "nostore";
  assert.equal((await engine.read(s.url + "/n")).status, "unchanged"); // the 304
  mode = "normal";
  assert.equal((await engine.read(s.url + "/n")).status, "ok", "the cache was removed, so this is a fresh read");
  // robots.txt with no-store
  const r = await start((req, res) => (req.url === "/robots.txt" ? text(res, "User-agent: *\nAllow: /\n", 200, { "cache-control": "no-store" }) : html(res, ARTICLE)));
  await engine.read(r.url + "/one");
  assert.equal(r.count("/robots.txt"), 1, "once per call even with several hops and probes");
  await engine.read(r.url + "/two");
  assert.equal(r.count("/robots.txt"), 2, "but not remembered into the next call");
});

