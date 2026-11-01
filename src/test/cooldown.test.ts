// SPDX-License-Identifier: Apache-2.0
// Codex round 3: B1 to B5 and the residual partials.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { freshHome, html, serve, text, type TestServer, timing } from "./helper.js";

const home = freshHome();
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
const engine = await import("../engine.js");
const rules = await import("../rules.js");
const store = await import("../store.js");
const cooldown = await import("../cooldown.js");
const { PARSER_VERSION } = await import("../types.js");
const fetcher = await import("../fetcher.js");
const doors = await import("../doors.js");
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ARTICLE = `<html><head><title>T</title></head><body><h1>Top</h1><p>Some article text here.</p></body></html>`;

test("B2: an already-aborted throttle call leaves no trace and does not move the clock", async () => {
  const origin = "http://b2.test";
  const dead = AbortSignal.abort();
  await assert.rejects(fetcher.throttle(origin, 30, dead, origin + "/x"));
  // If the clock had moved, this would wait 30 seconds.
  const t0 = Date.now();
  await fetcher.throttle(origin, 30, new AbortController().signal, origin + "/y");
  timing(Date.now() - t0 < 500, `waited ${Date.now() - t0}ms`);
});

test("B2: a queued entry that is cancelled leaves at once, not when its predecessor finishes", async () => {
  const origin = "http://b2b.test";
  await fetcher.throttle(origin, 0.6, new AbortController().signal, origin); // sets the clock
  const second = fetcher.throttle(origin, 0.6, new AbortController().signal, origin); // waits about 600ms
  const ctl = new AbortController();
  const third = fetcher.throttle(origin, 0.6, ctl.signal, origin);
  const t0 = Date.now();
  setTimeout(() => ctl.abort(), 50);
  await assert.rejects(third);
  timing(Date.now() - t0 < 300, `third left after ${Date.now() - t0}ms`);
  await second;
});

test("B3: an overlong heading keeps its full text for expansion and search", async () => {
  const h = "x".repeat(301) + " zebracontract";
  const s = await start((req, res) => (req.url === "/robots.txt" ? nf(res) : html(res, `<html><body><h1>${h}</h1><p>body</p></body></html>`)));
  const q = await engine.read(s.url + "/h", { question: "zebracontract" });
  assert.match(JSON.stringify(uc(q).passages), /zebracontract/);
  const o = await engine.read(s.url + "/h", { page: 1 });
  assert.equal(uc(o).outline[0].heading.length, 300); // display copy is bounded
  const sec = await engine.read(s.url + "/h", { section: 1 });
  assert.ok(uc(sec).section.text.includes("zebracontract"));
});

test("B4: URLs are never shortened. Oversized ones are omitted and counted", async () => {
  const longFeed = "/feed.xml?signature=" + "a".repeat(2200) + "&sig=required";
  const longLink = "/long?" + "b".repeat(3000);
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") return text(res, `User-agent: *\nSitemap: ${"http://x.test/" + "s".repeat(2100)}.xml\nSitemap: http://x.test/ok.xml\n`);
    html(res, `<html><head><title>T</title><link rel="alternate" type="application/rss+xml" href="${longFeed}"><link rel="alternate" type="application/rss+xml" href="/ok.xml"></head><body><h1>H</h1><p>text</p><a href="${longLink}">long</a> <a href="/short">short</a></body></html>`);
  });
  const r = await engine.read(s.url + "/p");
  const c = uc(r);
  assert.deepEqual(c.available_doors.feeds, [s.url + "/ok.xml"]); // whole URL or nothing
  assert.deepEqual(c.available_doors.sitemaps, ["http://x.test/ok.xml"]);
  assert.equal(c.available_doors.omitted, 2);
  assert.equal(c.links.length, 1);
  assert.equal(c.links[0].url, s.url + "/short");
  assert.equal(c.links_omitted, 1);
  assert.ok(c.available_doors.feeds.every((u: string) => u.length <= 2048));
  // the helper itself: budget as well as length
  const many = Array.from({ length: 40 }, (_, i) => `http://x.test/${"u".repeat(300)}${i}`);
  const b = doors.boundUrls(many);
  assert.ok(b.items.length <= 20 && b.items.join("").length <= 4000);
  assert.equal(b.items.length + b.omitted, 40);
});

test("B5: an expired global robots entry does not hide a valid per-call one", async () => {
  rules.resetRulesCache();
  let phase = "normal";
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") return text(res, "User-agent: *\nAllow: /\n", 200, phase === "nostore" ? { "cache-control": "no-store" } : {});
    html(res, ARTICLE);
  });
  const u = new URL(s.url + "/a");
  await rules.getRobots(u.origin); // cached globally
  assert.equal(s.count("/robots.txt"), 1);
  // expire the global entry, then answer no-store: the new policy lives only for this call
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 3_600_000;
  try {
    phase = "nostore";
    const { withSignal } = await import("../safety.js");
    await withSignal(new AbortController().signal, async () => {
      await rules.getRobots(u.origin);
      await rules.getRobots(u.origin); // must use the call-local entry
    });
  } finally {
    Date.now = realNow;
  }
  assert.equal(s.count("/robots.txt"), 2);
});

test("P14: section pages after the first still carry the heading receipt", async () => {
  const body = "<h1>Huge</h1>" + Array.from({ length: 300 }, (_, i) => `<p>${("paragraph " + i + " ").repeat(150)}</p>`).join("");
  const s = await start((req, res) => (req.url === "/robots.txt" ? nf(res) : html(res, `<html><head><title>H</title></head><body>${body}</body></html>`)));
  const p2 = await engine.read(s.url + "/big", { section: 1, page: 2 });
  assert.equal(uc(p2).section.page, 2);
  assert.ok(uc(p2).receipts.some((r: any) => r.quote === "Huge" && r.section === 1));
});

test("P16: a huge service-description URL is omitted, and the page stays readable", async () => {
  const s = await start((req, res) => (req.url === "/robots.txt" ? nf(res) : html(res, `<html><head><title>T</title><link rel="service-desc" href="/${"q".repeat(120_000)}"></head><body><h1>Top</h1><p>real content</p></body></html>`)));
  for (const opts of [{}, { section: 1 }, { question: "real content" }, { page: 2 }] as const) {
    const r = await engine.read(s.url + "/svc", opts);
    assert.notEqual(r.status, "error", JSON.stringify(opts));
    assert.ok(JSON.stringify(r).length < 30_000);
  }
  assert.equal(uc(await engine.read(s.url + "/svc", { page: 1 })).available_doors.omitted, 1);
  // and the final whole-reply guard drops optional parts when needed
  const big = { status: "ok", untrusted_content: { available_doors: { x: "y".repeat(120_000) }, outline: [1] } } as any;
  const fitted = engine.fitEnvelope(big);
  assert.ok(JSON.stringify(fitted).length < 100_000);
  assert.deepEqual(uc(fitted).dropped_for_size, ["available_doors"]);
});

test("P23: x402 bodies are validated against their version's required fields", async () => {
  const ok2 = { scheme: "exact", network: "base", asset: "0xA", payTo: "0xP", amount: "100", maxTimeoutSeconds: 30 };
  const ok1 = { scheme: "exact", network: "base", asset: "0xA", payTo: "0xP", maxAmountRequired: "100", maxTimeoutSeconds: 30, resource: "/p", description: "", mimeType: "text/html" };
  const res2 = { url: "http://x.test/p" };
  const mk = (body: unknown, hdr?: string) => start((req, res) => {
    if (req.url !== "/p") return nf(res);
    res.writeHead(402, { "content-type": "application/json", ...(hdr ? { "payment-required": hdr } : {}) });
    res.end(JSON.stringify(body));
  });
  const price = async (body: unknown, hdr?: string) => uc(await engine.read((await mk(body, hdr)).url + "/p")).price;
  assert.equal((await price({ x402Version: 2, resource: res2, accepts: [ok2] })).amount, "100");
  assert.equal((await price({ x402Version: 1, accepts: [ok1] })).amount, "100");
  const invalid: unknown[] = [
    { x402Version: 2, accepts: [ok2] }, // no top-level resource
    { x402Version: 2, resource: res2, accepts: [{ ...ok2, maxTimeoutSeconds: undefined }] },
    { x402Version: 2, resource: res2, accepts: [{ ...ok2, amount: undefined, maxAmountRequired: "100" }] }, // wrong-version field
    { x402Version: 2, resource: res2, accepts: [{ ...ok2, maxAmountRequired: "5" }] }, // both fields
    { x402Version: 1, accepts: [{ ...ok1, maxAmountRequired: undefined, amount: "100" }] },
    { x402Version: 1, accepts: [{ ...ok1, resource: undefined }] },
    { x402Version: 1, accepts: [{ ...ok1, mimeType: undefined }] },
    { x402Version: 1, accepts: [{ ...ok1, maxTimeoutSeconds: "30" }] },
  ];
  for (const bad of invalid) assert.equal((await price(bad)).method, "unknown", JSON.stringify(bad));
  // an invalid body never masks a valid header
  const hdr = Buffer.from(JSON.stringify({ x402Version: 2, resource: res2, accepts: [{ ...ok2, amount: "42" }] })).toString("base64");
  const masked = await price({ x402Version: 2, resource: res2, accepts: [{ ...ok2, amount: undefined, maxAmountRequired: "1" }] }, hdr);
  assert.equal(masked.amount, "42");
  const noRes = await price({ x402Version: 2, accepts: [ok2] }, hdr);
  assert.equal(noRes.amount, "42");
});

test("N6: Retry-After is never shortened; an absurd one becomes a fixed 24 hour cooldown", () => {
  cooldown.setCooldown("http://r1.test", 429, "5000000"); // ~58 days, kept in full
  assert.ok(cooldown.cooldownLeft("http://r1.test") > 4_999_000);
  cooldown.setCooldown("http://r2.test", 429, "400000000"); // ~12.7 years: absurd
  const left = cooldown.cooldownLeft("http://r2.test");
  assert.ok(left > 86_000 && left <= 86_400, `left ${left}`);
  assert.equal(cooldown.parseRetryAfter("400000000"), null);
  assert.equal(cooldown.cooldownSeconds(429, "400000000"), 86_400);
  assert.equal(cooldown.cooldownSeconds(429, undefined), 60);
  assert.equal(cooldown.cooldownSeconds(503, "garbage"), 30);
  const farDate = new Date(Date.now() + 20 * 365 * 86_400_000).toUTCString();
  assert.equal(cooldown.cooldownSeconds(503, farDate), 86_400);
});

test("N9: a cache from an older reader is read again; oversized JSON-LD reports why it was skipped", async () => {
  const s = await start((req, res) => (req.url === "/robots.txt" ? nf(res) : html(res, ARTICLE)));
  assert.equal((await engine.read(s.url + "/old")).status, "ok");
  assert.equal((await engine.read(s.url + "/old")).status, "unchanged");
  const file = store.cachePath(s.url + "/old");
  const entry = store.readJson<any>(file);
  assert.equal(entry.parser, PARSER_VERSION);
  delete entry.parser; // as written by v0.1.1
  store.writeJson(file, entry);
  const re = await engine.read(s.url + "/old", { question: "article" });
  assert.equal(re.status, "unchanged"); // same body, but the parsed form was rebuilt
  assert.ok(uc(re).receipts.length > 0);
  assert.equal(store.readJson<any>(file).parser, PARSER_VERSION);
  // a record above the 5 MiB allowance, with the fetch cap raised
  process.env.TIRESIAS_MAX_BYTES = "12000000";
  try {
    const huge = JSON.stringify({ "@type": "Product", name: "Big", blob: "z".repeat(5_300_000) });
    const t = await start((req, res) => (req.url === "/robots.txt" ? nf(res) : html(res, `<html><head><script type="application/ld+json">${huge}</script></head><body><h1>x</h1><p>hello</p></body></html>`)));
    const r = await engine.read(t.url + "/b");
    assert.equal(r.status, "ok");
    assert.deepEqual(uc(r).structured.skipped, { invalid: 0, too_large: 1 });
  } finally {
    delete process.env.TIRESIAS_MAX_BYTES;
  }
});

test("P20/N11: ancestors are validated on every call, not just the first", () => {
  if (process.platform === "win32") return;
  const base = fs.mkdtempSync(path.join(path.dirname(home), "anc-"));
  fs.chmodSync(base, 0o700);
  const mid = path.join(base, "mid");
  fs.mkdirSync(mid, { mode: 0o700 });
  const target = path.join(mid, "store");
  const keep = process.env.TIRESIAS_HOME;
  process.env.TIRESIAS_HOME = target;
  try {
    store.home(); // fine, and cached
    fs.chmodSync(mid, 0o777); // loosened after the first call
    assert.throws(() => store.home(), /writable by other users/);
    fs.chmodSync(mid, 0o770); // group-writable counts too
    assert.throws(() => store.home(), /writable by other users/);
    fs.chmodSync(mid, 0o700);
    store.home(); // fine again
    // sticky world-writable is allowed (like /tmp)
    fs.chmodSync(mid, 0o1777);
    store.home();
  } finally {
    process.env.TIRESIAS_HOME = keep;
    fs.chmodSync(mid, 0o700);
    fs.rmSync(base, { recursive: true });
  }
});

const cur = () => path.join(home, "cooldowns.jsonl");

test("cooldown log: 10 concurrent processes appending distinct origins all survive", async () => {
  const dir = path.join(path.dirname(home), `cd-${process.pid}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  const script = `const c = await import(${JSON.stringify(path.resolve("dist/cooldown.js"))}); for (let i = 0; i < 20; i++) c.setCooldown("http://p" + process.argv[1] + "-" + i + ".test", 429, "600");`;
  const procs = Array.from({ length: 10 }, (_, i) => spawn(process.execPath, ["--input-type=module", "-e", script, String(i)], { env: { ...process.env, TIRESIAS_HOME: dir }, stdio: "ignore" }));
  await Promise.all(procs.map((p) => new Promise((r) => p.on("exit", r))));
  const lines = fs.readFileSync(path.join(dir, "cooldowns.jsonl"), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  assert.equal(new Set(lines.map((l: any) => l.origin)).size, 200);
  assert.ok(lines.every((l: any) => JSON.stringify(l).length < 512));
  fs.rmSync(dir, { recursive: true });
});

test("cooldown log: it is never rotated or renamed, and more than 1,000 origins all stay", () => {
  fs.rmSync(cur(), { force: true });
  const inode = (() => {
    cooldown.setCooldown("http://first.test", 429, "900");
    return fs.statSync(cur()).ino;
  })();
  for (let i = 0; i < 1500; i++) cooldown.setCooldown(`http://many${i}.test`, 429, "900");
  assert.equal(fs.statSync(cur()).ino, inode, "same file: never renamed or replaced");
  assert.ok(!fs.existsSync(path.join(home, "cooldowns.old.jsonl")));
  for (const i of [0, 999, 1000, 1499]) assert.ok(cooldown.cooldownLeft(`http://many${i}.test`) > 800, "origin " + i);
  assert.ok(cooldown.cooldownLeft("http://first.test") > 800);
  // a shorter wait writes nothing
  const size = fs.statSync(cur()).size;
  cooldown.setCooldown("http://first.test", 429, "10");
  assert.equal(fs.statSync(cur()).size, size);
});

test("cooldown log: a damaged unterminated tail does not swallow the next record", () => {
  fs.rmSync(cur(), { force: true });
  fs.writeFileSync(cur(), '{"origin":"http://good.test","until":' + (Date.now() + 500_000) + '}\n{"origin":"http://interr');
  cooldown.setCooldown("http://after-damage.test", 429, "600");
  // an independent reader (no in-memory state) sees it
  const script = `const c = await import(${JSON.stringify(path.resolve("dist/cooldown.js"))}); console.log(c.cooldownLeft("http://after-damage.test"), c.cooldownLeft("http://good.test"));`;
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TIRESIAS_HOME: home } }).stdout.toString().trim().split(" ").map(Number);
  assert.ok(out[0] > 500, "the record after the damage is readable: " + out);
  assert.ok(out[1] > 400);
  assert.match(fs.readFileSync(cur(), "utf8"), /interr\n\{"v":1,"origin":"http:\/\/after-damage/); // the damaged line is closed off, then the record
});

test("cooldown log: the v0.1.3 JSON store is read (never written) and merged by max", () => {
  fs.rmSync(cur(), { force: true });
  const legacy = store.cachePath("cooldowns");
  store.writeJson(legacy, { "http://legacy.test": Date.now() + 700_000, "http://both.test": Date.now() + 100_000, "http://expired.test": Date.now() - 5000 });
  cooldown.setCooldown("http://both.test", 429, "5000"); // later in the new log
  const script = `const c = await import(${JSON.stringify(path.resolve("dist/cooldown.js"))}); console.log(["legacy","both","expired"].map((n) => c.cooldownLeft("http://" + n + ".test")).join(" "));`;
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TIRESIAS_HOME: home } }).stdout.toString().trim().split(" ").map(Number);
  assert.ok(out[0] > 600);
  assert.ok(out[1] > 4900, "the larger of the two wins");
  assert.equal(out[2], 0);
  assert.ok(!fs.readFileSync(cur(), "utf8").includes("legacy.test"), "legacy entries are not copied");
  const before = fs.readFileSync(legacy, "utf8");
  cooldown.setCooldown("http://legacy.test", 429, "9000");
  assert.equal(fs.readFileSync(legacy, "utf8"), before, "the legacy file is never modified");
  fs.rmSync(legacy);
});

test("cooldown log: only the last 8 MB is read, starting at the first full line", () => {
  fs.rmSync(cur(), { force: true });
  const now = Date.now();
  const early = JSON.stringify({ origin: "http://too-early.test", until: now + 900_000 }) + "\n";
  const filler = JSON.stringify({ origin: "http://filler.test", until: now + 1000 }) + "\n";
  const late = JSON.stringify({ origin: "http://recent.test", until: now + 900_000 }) + "\n";
  const body = early + filler.repeat(Math.ceil((8 * 1024 * 1024 + 4096) / filler.length)) + late;
  fs.writeFileSync(cur(), body);
  assert.ok(fs.statSync(cur()).size > 8 * 1024 * 1024);
  assert.ok(cooldown.cooldownLeft("http://recent.test") > 800);
  assert.equal(cooldown.cooldownLeft("http://too-early.test"), 0, "outside the 8 MB window, by design");
  // the cut lands mid-line; the partial line must not be mistaken for a record
  const lines = store.readLogSync<any>("cooldowns.jsonl", 100);
  assert.ok(lines.every((l) => l && typeof l.origin === "string"));
  fs.rmSync(cur());
});

test("B-1: after a parser upgrade, check keeps the old source and does not say First visit", async () => {
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") return nf(res);
    if (req.url === "/llms.txt") return text(res, "# Site\n\nllms body\n");
    html(res, ARTICLE);
  });
  assert.equal((await engine.read(s.url + "/")).door_detail, "llms.txt");
  const file = store.cachePath(s.url + "/");
  const entry = store.readJson<any>(file);
  delete entry.parser; // written by an older version
  store.writeJson(file, entry);
  const hitsBefore = s.count("/");
  const c = await engine.check(s.url + "/");
  assert.equal(c.status, "unchanged");
  assert.doesNotMatch(c.message ?? "", /First visit/);
  assert.equal(s.count("/"), hitsBefore, "it kept reading llms.txt, not the page");
  assert.equal(store.readJson<any>(file).source_url, s.url + "/llms.txt");
  assert.equal(store.readJson<any>(file).parser, PARSER_VERSION);
});

test("B4: an old discovery cache entry is discarded, not returned", async () => {
  const s = await start((req, res) => (req.url === "/robots.txt" ? text(res, "User-agent: *\nSitemap: http://x.test/real.xml\n") : html(res, ARTICLE)));
  const origin = new URL(s.url).origin;
  const file = store.cachePath("doors:" + origin);
  store.writeJson(file, { origin, probed_at: Date.now(), sitemaps: ["http://x.test/" + "t".repeat(490)] }); // a v0.1.2 style entry, no version
  const r = await engine.read(s.url + "/p");
  assert.deepEqual(uc(r).available_doors.sitemaps, ["http://x.test/real.xml"]);
});

test("P16: a very long URL does not push a section page past the budget (receipts counted)", async () => {
  const path7k = "/" + "p".repeat(7000);
  const body = "<h1>Long</h1>" + Array.from({ length: 40 }, (_, i) => `<p>${("para " + i + " ").repeat(20)}</p>`).join("");
  const s = await start((req, res) => (req.url === "/robots.txt" ? nf(res) : html(res, `<html><head><title>L</title></head><body>${body}</body></html>`)));
  const first = await engine.read(s.url + path7k, { section: 1 });
  assert.ok(JSON.stringify(first).length < 60_000, `page 1 was ${JSON.stringify(first).length}`);
  const pages = uc(first).section.pages;
  assert.ok(pages > 1, "the section is split into pages");
  for (let p = 2; p <= pages; p++) {
    const r = await engine.read(s.url + path7k, { section: 1, page: p });
    assert.ok(JSON.stringify(r).length < 60_000, `page ${p} was ${JSON.stringify(r).length}`);
  }
  const q = await engine.read(s.url + path7k, { question: "para" });
  assert.ok(JSON.stringify(q).length < 60_000, `question was ${JSON.stringify(q).length}`);
});
