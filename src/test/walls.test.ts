// SPDX-License-Identifier: Apache-2.0
// Codex round 6: regex DoS, Retry-After at headers, challenged redirects, robots 402, legacy cooldowns.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { freshHome, html, serve, text, type TestServer, timing } from "./helper.js";

const home = freshHome();
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
const engine = await import("../engine.js");
const cooldown = await import("../cooldown.js");
const { detectWall, approxTextLength } = await import("../walls.js");
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
const timed = <T>(fn: () => T): [T, number] => {
  const t0 = Date.now();
  const v = fn();
  return [v, Date.now() - t0];
};
const H = new Headers();

test("1: hostile bodies cannot stall wall detection (Codex case: '<form ' x 128000)", async () => {
  const forms = "<form ".repeat(128_000);
  assert.equal(forms.length, 768_000);
  const [w, ms] = timed(() => detectWall({ status: 200, headers: H, html: forms, textChars: 0 }));
  timing(ms < 300, `detectWall took ${ms}ms`);
  assert.equal(w, null);
  for (const body of ["<input ".repeat(100_000), "<form captcha ".repeat(60_000), "<title>".repeat(100_000), "<".repeat(700_000), ("<form " + "x ".repeat(20) + "captcha ").repeat(20_000)]) {
    const [, t] = timed(() => detectWall({ status: 200, headers: H, html: body, textChars: 0 }));
    assert.ok(t < 500, `took ${t}ms on ${body.slice(0, 12)}`);
    assert.ok(timed(() => approxTextLength(body))[1] < 300);
  }
  // end to end, with the caller's 100 ms timeout
  const s = await start((req, res) => (req.url === "/robots.txt" ? nf(res) : html(res, forms)));
  const t0 = Date.now();
  const r = await engine.check(s.url + "/", { agent: "t", signal: AbortSignal.timeout(100) });
  timing(Date.now() - t0 < 1000, `check took ${Date.now() - t0}ms`);
  assert.notEqual((r.message ?? "").length, -1);
  // the markers still work
  assert.equal(detectWall({ status: 200, headers: H, html: `<form><div class="captcha"></div></form>`, textChars: 10 })?.code, "captcha");
  assert.equal(detectWall({ status: 200, headers: H, html: `<p>captcha</p><form></form>`, textChars: 10 }), null);
  assert.equal(detectWall({ status: 200, headers: H, html: `<input name=typed type='password'>`, textChars: 10 })?.code, "login_required");
  assert.equal(detectWall({ status: 200, headers: H, html: `<TITLE> Just a moment...</TITLE>`, textChars: 5000 })?.code, "bot_challenge");
});

test("1: no other reader regex is quadratic on hostile markdown, HTML or llms.txt", async () => {
  const cases: [string, string][] = [
    ["comments", "<!--".repeat(200_000)],
    ["brackets", "[".repeat(1_000_000)],
    ["links", "[a](".repeat(200_000)],
    ["close-brackets", "[a]".repeat(300_000) + "(x)"],
    ["heading whitespace", "# a" + " ".repeat(500_000) + "b"],
    ["heading hashes", "#### x " + "#".repeat(500_000) + " y"],
    ["parens", "[a](b ".repeat(150_000)],
  ];
  for (const [name, body] of cases) {
    const [, ms] = timed(() => parseMarkdown(body, "http://x.test/"));
    timing(ms < 1500, `${name} took ${ms}ms`);
  }
  assert.ok(timed(() => parseHtml("<a href=x>".repeat(100_000) + "<!--".repeat(100_000), "http://x.test/"))[1] < 3000);
  // llms.txt with hostile link syntax, through discovery
  const evil = "](".repeat(250_000);
  const s = await start((req, res) => (req.url === "/robots.txt" ? nf(res) : req.url === "/llms.txt" ? text(res, "# T\n\n" + evil) : nf(res)));
  const t0 = Date.now();
  await engine.read(s.url + "/");
  timing(Date.now() - t0 < 3000, `llms.txt read took ${Date.now() - t0}ms`);
  // and ordinary markdown still parses the same
  const p = parseMarkdown("# Title [x](/y)\n\nSee [the guide](/guide \"t\") and [two](http://a.test/b).\n", "http://s.test/");
  assert.equal(p.title, "Title x");
  assert.deepEqual(p.links.map((l) => l.url), ["http://s.test/guide", "http://a.test/b"]);
  assert.equal(p.sections[0].blocks[0].text, "See the guide and two.");
});

test("2: Retry-After is recorded when headers arrive, even if the body never finishes", async () => {
  for (const status of [429, 503]) {
    const s = await start((req, res) => {
      if (req.url !== `/busy${status}`) return nf(res);
      res.writeHead(status, { "retry-after": "3600", "content-type": "text/html" });
      res.write("partial body");
      setTimeout(() => res.destroy(), 40); // the connection dies mid-body
    });
    const first = await engine.read(s.url + `/busy${status}`);
    assert.notEqual(first.status, "ok");
    assert.ok(cooldown.cooldownLeft(new URL(s.url).origin) > 3000, `status ${status}`);
    const before = s.hits.length;
    const second = await engine.read(s.url + `/busy${status}`);
    assert.equal(second.status, "refused");
    assert.equal(s.hits.length, before, "no request reaches the site during the cooldown");
  }
  // an over-cap body does the same
  process.env.TIRESIAS_MAX_BYTES = "1000";
  try {
    const s = await start((req, res) => {
      if (req.url !== "/big429") return nf(res);
      res.writeHead(429, { "retry-after": "3600", "content-type": "text/html" });
      res.end("x".repeat(50_000));
    });
    assert.equal((await engine.read(s.url + "/big429")).status, "error");
    assert.ok(cooldown.cooldownLeft(new URL(s.url).origin) > 3000);
    assert.equal((await engine.read(s.url + "/big429")).status, "refused");
  } finally {
    delete process.env.TIRESIAS_MAX_BYTES;
  }
});

test("3: a challenged redirect stops the call at that hop and is not followed", async () => {
  const s = await start((req, res) => {
    if (req.url === "/start") { res.writeHead(302, { location: "/passed", "cf-mitigated": "challenge" }); return void res.end(); }
    if (req.url === "/passed") return html(res, "<h1>passed</h1><p>content</p>");
    nf(res);
  });
  const r = await engine.read(s.url + "/start");
  assert.equal(r.status, "wall");
  assert.equal(r.handoff?.reason, "bot_challenge");
  assert.equal(uc(r).handoff.open_this, s.url + "/start");
  assert.equal(s.count("/passed"), 0);
  // a challenged hop later in a chain: the handoff names THAT hop
  const t = await start((req, res) => {
    if (req.url === "/a") { res.writeHead(302, { location: "/b" }); return void res.end(); }
    if (req.url === "/b") { res.writeHead(302, { location: "/c", "cf-mitigated": "challenge" }); return void res.end(); }
    if (req.url === "/c") return html(res, "<p>c</p>");
    nf(res);
  });
  const tr = await engine.read(t.url + "/a");
  assert.equal(tr.status, "wall");
  assert.equal(uc(tr).handoff.open_this, t.url + "/b");
  assert.equal(t.count("/c"), 0);
  // the same rule applies on the way to robots.txt
  const u = await start((req, res) => {
    if (req.url === "/robots.txt") { res.writeHead(302, { location: "/robots-ok.txt", "cf-mitigated": "challenge" }); return void res.end(); }
    html(res, "<p>page</p>");
  });
  const ur = await engine.read(u.url + "/p");
  assert.equal(ur.status, "wall");
  assert.equal(u.count("/robots-ok.txt"), 0);
  assert.equal(u.count("/p"), 0);
});

test("4: a 402 on robots.txt is a payment demand, not permission", async () => {
  const s = await start((req, res) => (req.url === "/robots.txt" ? text(res, "pay", 402, { "crawler-price": "USD 0.01" }) : html(res, "<p>article</p>")));
  const r = await engine.read(s.url + "/article");
  assert.equal(r.status, "payment_required");
  assert.equal(uc(r).price.currency, "USD");
  assert.equal(uc(r).price.amount, "0.01");
  assert.deepEqual(s.hits.map((h) => h.path), ["/robots.txt"]); // nothing else was requested
});

test("4: robots 401, 403 and 404 mean no rules (RFC 9309); 429 and 5xx mean stop", async () => {
  for (const status of [401, 403, 404]) {
    const s = await start((req, res) => (req.url === "/robots.txt" ? text(res, "nope", status) : req.url === "/page" ? html(res, "<h1>Hi</h1><p>text</p>") : nf(res)));
    assert.equal((await engine.read(s.url + "/page")).status, "ok", `robots ${status}`);
  }
  const t = await start((req, res) => (req.url === "/robots.txt" ? text(res, "slow", 429, { "retry-after": "900" }) : html(res, "<p>x</p>")));
  const tr = await engine.read(t.url + "/page");
  assert.equal(tr.status, "refused");
  assert.ok(cooldown.cooldownLeft(new URL(t.url).origin) > 800);
  assert.deepEqual(t.hits.map((h) => h.path), ["/robots.txt"]);
  // a challenge on robots.txt is still a wall even when it is a 403
  const c = await start((req, res) => (req.url === "/robots.txt" ? html(res, "<title>Just a moment...</title>", { "cf-mitigated": "challenge" }, 403) : html(res, "<p>x</p>")));
  assert.equal((await engine.read(c.url + "/page")).status, "wall");
});

test("5: cooldowns left in a v0.1.4 cooldowns.old.jsonl are still honored (read only)", () => {
  const oldFile = path.join(home, "cooldowns.old.jsonl");
  fs.writeFileSync(oldFile, JSON.stringify({ origin: "http://from-old.test", until: Date.now() + 600_000 }) + "\n");
  const before = fs.readFileSync(oldFile, "utf8");
  const script = `const c = await import(${JSON.stringify(path.resolve("dist/cooldown.js"))}); console.log(c.cooldownLeft("http://from-old.test"));`;
  const out = Number(spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TIRESIAS_HOME: home } }).stdout.toString().trim());
  assert.ok(out > 500, `fresh process saw ${out}`);
  cooldown.setCooldown("http://from-old.test", 429, "9000");
  assert.equal(fs.readFileSync(oldFile, "utf8"), before, "the old file is never written");
});
