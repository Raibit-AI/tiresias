// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { abandonBackground } from "../background.js";
import { read as engineRead } from "../engine.js";
import { guarded } from "../envelope.js";
import { run } from "../pipeline.js";
import { setCooldown } from "../cooldown.js";
import { callContext, type CallContext } from "../context.js";
import { snapshotConfig } from "../config.js";
import { probeOrigin } from "../doors.js";
import { politeFetch } from "../fetcher.js";
import { extendNext } from "../hosts.js";
import { Turns, noteDelay } from "../queue.js";
import { getRobots } from "../rules.js";
import { safeFetch, withSignal } from "../safety.js";
import { loadSites } from "../sites.js";
import { sha256 } from "../store.js";
import { freshHome, html, neverAsk, serve, text, type TestServer } from "./helper.js";

const SPACING = 400;
process.env.TIRESIAS_HOST_SPACING_MS = String(SPACING);
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
process.env.TIRESIAS_DOORS_DEFAULT = "background";
const servers: TestServer[] = [];
afterEach(async () => { await abandonBackground(); for (const s of servers.splice(0)) await s.close(); });
const start = async (handler?: Parameters<typeof serve>[0]) => {
  const arrivals: { path: string; at: number }[] = [];
  const s = await serve((req, res) => {
    arrivals.push({ path: req.url!, at: Date.now() });
    if (handler) handler(req, res);
    else text(res, req.url === "/robots.txt" ? "User-agent: *\nAllow: /" : "page");
  });
  servers.push(s);
  return { ...s, arrivals };
};
const callStore = (context: CallContext = {}): CallContext => ({
  robotsPasses: { pending: new Map(), attempted: new Set() }, ...context,
});
const read = (url: string, context: CallContext = callStore()) => callContext.run(context, () => politeFetch(url));
const full = (gap: number, spacing = SPACING) => assert.ok(gap >= spacing - 15, `gap ${gap}ms, expected >= ${spacing}ms`);
const early = (gap: number) => assert.ok(gap < SPACING / 2, `gap ${gap}ms, expected < ${SPACING / 2}ms`);
const hostFile = (home: string, origin: string) => path.join(home, "hosts", sha256(origin).slice(0, 32));
// Check every triple too: a sub-spacing window may contain only robots.txt and its guarded page.
const invariant = (hits: { path: string; at: number }[]) => {
  for (let i = 1; i < hits.length; i++) {
    if (hits[i].at - hits[i - 1].at < SPACING - 15) {
      assert.equal(hits[i - 1].path, "/robots.txt");
      assert.notEqual(hits[i].path, "/robots.txt");
    }
    if (i > 1) full(hits[i].at - hits[i - 2].at);
  }
};

test("visit: fresh robots and first page pair; cached robots leave full page spacing", async () => {
  freshHome();
  const s = await start();
  await read(s.url + "/one");
  await read(s.url + "/two");
  assert.deepEqual(s.arrivals.map(h => h.path), ["/robots.txt", "/one", "/two"]);
  early(s.arrivals[1].at - s.arrivals[0].at);
  full(s.arrivals[2].at - s.arrivals[1].at);
  invariant(s.arrivals);
});

test("visit: Crawl-delay (including below default) and owner spacing disable the pass", async () => {
  for (const delay of [0.1, 0.65, "owner"] as const) {
    freshHome();
    const s = await start((req, res) => text(res, req.url === "/robots.txt"
      ? `User-agent: *\nAllow: /\n${delay === "owner" ? "" : `Crawl-delay: ${delay}`}` : "page"));
    await read(s.url + "/page", callStore(delay === "owner" ? { sites: { "127.0.0.1": { spacing_seconds: 1 } } } : {}));
    full(s.arrivals[1].at - s.arrivals[0].at, delay === "owner" ? 1000 : Math.max(SPACING, delay * 1000));
  }
});

test("visit: only the owner of a shared in-flight robots fetch gets an early page", async () => {
  freshHome();
  let seen!: () => void;
  const robotsSeen = new Promise<void>(r => { seen = r; });
  let finish!: () => void;
  const s = await start((req, res) => {
    if (req.url !== "/robots.txt") return text(res, "page");
    finish = () => text(res, "User-agent: *\nAllow: /");
    seen();
  });
  const first = read(s.url + "/owner");
  await robotsSeen;
  const second = read(s.url + "/waiter");
  // Policy reaches getRobots before yielding; drain its promise continuations before answering.
  await new Promise<void>(r => setImmediate(r));
  finish();
  await Promise.all([first, second]);
  assert.deepEqual(s.arrivals.map(h => h.path), ["/robots.txt", "/owner", "/waiter"]);
  early(s.arrivals[1].at - s.arrivals[0].at);
  full(s.arrivals[2].at - s.arrivals[1].at);
  invariant(s.arrivals);
});

test("visit: an intervening queued request defeats the local pass", async () => {
  freshHome();
  let seen!: () => void;
  const robotsSeen = new Promise<void>(r => { seen = r; });
  let finish!: () => void;
  const s = await start((req, res) => {
    if (req.url !== "/robots.txt") return text(res, "page");
    finish = () => text(res, "User-agent: *\nAllow: /");
    seen();
  });
  const owner = read(s.url + "/owner");
  await robotsSeen;
  const turns = new Turns();
  const probe = safeFetch(s.url + "/probe", { beforeRequest: (u, signal) => turns.take(u, SPACING / 1000, signal) })
    .finally(() => turns.giveBack());
  await new Promise<void>(r => setImmediate(r));
  finish();
  await Promise.all([owner, probe]);
  assert.deepEqual(s.arrivals.map(h => h.path), ["/robots.txt", "/probe", "/owner"]);
  full(s.arrivals[1].at - s.arrivals[0].at);
  full(s.arrivals[2].at - s.arrivals[1].at);
  invariant(s.arrivals);
});

test("visit: changed shared last/next, a lock, malformed state and write failure fail closed", async () => {
  for (const kind of ["last", "next", "lock", "parse", "write"] as const) {
    const home = freshHome();
    const s = await start();
    const file = hostFile(home, s.url);
    const rename = fs.renameSync;
    let changed = false;
    // Interpose immediately after robots completion is written, before the page can reserve.
    fs.renameSync = ((from, to) => {
      if (kind === "write" && changed && to === file) throw new Error("disk unavailable");
      rename(from, to);
      if (to !== file || changed) return;
      const stamp = JSON.parse(fs.readFileSync(file, "utf8"));
      // The initial reservation precedes the robots request; completion is the second write.
      if (s.arrivals.length !== 1) return;
      changed = true;
      if (kind === "last") stamp.last += 30;
      if (kind === "next") stamp.next += 80;
      if (kind === "last" || kind === "next") fs.writeFileSync(file, JSON.stringify(stamp), { mode: 0o600 });
      if (kind === "parse") fs.writeFileSync(file, "{broken", { mode: 0o600 });
      // reserve's lock: install it after completion releases its own lock.
      if (kind === "lock") queueMicrotask(() => {
        fs.writeFileSync(file + ".lock", "busy", { mode: 0o600 });
        setTimeout(() => fs.rmSync(file + ".lock", { force: true }), SPACING / 2);
      });
    }) as typeof fs.renameSync;
    try {
      await read(s.url + "/page");
      assert.equal(changed, true);
      full(s.arrivals[1].at - s.arrivals[0].at);
    } finally { fs.renameSync = rename; }
  }
});

test("visit: redirect hops after the passed page wait a full turn", async () => {
  freshHome();
  const s = await start((req, res) => text(res, req.url === "/robots.txt" ? "User-agent: *\nAllow: /" : "page",
    req.url === "/start" ? 302 : 200, req.url === "/start" ? { location: "/end" } : {}));
  await read(s.url + "/start");
  assert.deepEqual(s.arrivals.map(h => h.path), ["/robots.txt", "/start", "/end"]);
  early(s.arrivals[1].at - s.arrivals[0].at);
  full(s.arrivals[2].at - s.arrivals[1].at);
  invariant(s.arrivals);
});

test("visit: denied no-store robots stay spaced; a later page cannot inherit a refused pass", async () => {
  freshHome();
  const s = await start((req, res) => text(res, req.url === "/robots.txt" ? "User-agent: *\nDisallow: /denied" : "page", 200, { "cache-control": "no-store" }));
  const context = callStore({ robots: new Map() });
  await assert.rejects(read(s.url + "/denied", context), /disallows/);
  // Same call's robots cache, so the fresh fetch that refused /denied gives /open no pass.
  await read(s.url + "/open", context);
  full(s.arrivals[1].at - s.arrivals[0].at);
  for (let i = 0; i < 3; i++) await assert.rejects(read(s.url + "/denied"), /disallows/);
  assert.deepEqual(s.arrivals.map(h => h.path), ["/robots.txt", "/open", "/robots.txt", "/robots.txt", "/robots.txt"]);
  for (let i = 1; i < s.arrivals.length; i++) full(s.arrivals[i].at - s.arrivals[i - 1].at);
  invariant(s.arrivals);
});

test("visit: same-origin and cross-origin robots redirects never give a pass", async () => {
  for (const cross of [false, true]) {
    freshHome();
    const b = await start();
    const a = await start((req, res) => req.url === "/robots.txt"
      ? text(res, "", 302, { location: cross ? b.url + "/robots.txt" : "/rules" })
      : text(res, req.url === "/rules" ? "User-agent: *\nAllow: /" : "page"));
    await read(a.url + "/page");
    full(a.arrivals.at(-1)!.at - a.arrivals.at(-2)!.at);
    if (!cross) full(a.arrivals[1].at - a.arrivals[0].at);
  }
});

test("visit: private unshared calls pair locally, preserve shared state, and space later robots", async () => {
  const home = freshHome();
  neverAsk(home);
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ private_spacing: "none" }), { mode: 0o600 });
  const s = await start();
  const file = hostFile(home, s.url);
  fs.mkdirSync(path.dirname(file), { mode: 0o700 });
  const original = JSON.stringify({ v: 1, last: Date.now() - 2000, next: Date.now() - 1000 });
  fs.writeFileSync(file, original, { mode: 0o600 });
  await read(s.url + "/one", callStore({ private: true }));
  await read(s.url + "/two", callStore({ private: true }));
  assert.deepEqual(s.arrivals.map(h => h.path), ["/robots.txt", "/one", "/robots.txt", "/two"]);
  early(s.arrivals[1].at - s.arrivals[0].at);
  full(s.arrivals[2].at - s.arrivals[1].at);
  early(s.arrivals[3].at - s.arrivals[2].at);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
  invariant(s.arrivals);
});

test("visit: robots Retry-After refuses the page and leaves no pass in the same call", async () => {
  freshHome();
  const s = await start((_req, res) => text(res, "wait", 429, { "retry-after": "1", "cache-control": "no-store" }));
  const context = callStore({ robots: new Map() });
  await assert.rejects(read(s.url + "/one", context), /wait/);
  await assert.rejects(read(s.url + "/two", context), /wait/);
  await assert.rejects(read(s.url + "/three"), /wait/);
  assert.deepEqual(s.arrivals.map(h => h.path), ["/robots.txt"]);
});

test("visit: previously learned delay and extendNext remain owed after fresh robots", async () => {
  for (const local of [false, true]) {
    freshHome();
    const s = await start((_req, res) => {
      if (local) noteDelay(s.url, 0.7);
      else extendNext(s.url, Date.now() + 700);
      text(res, "User-agent: *\nAllow: /");
    });
    await read(s.url + "/page");
    full(s.arrivals[1].at - s.arrivals[0].at, 700);
  }
});

test("visit: robots fetched without a call holder grant no pass", async () => {
  for (const prefetch of [false, true]) {
    freshHome();
    const s = await start();
    if (prefetch) await callContext.run({}, () => getRobots(s.url));
    await politeFetch(s.url + "/page");
    full(s.arrivals[1].at - s.arrivals[0].at);
  }
});


test("visit: a cooldown or cancellation between robots and page still prevents sending", async () => {
  for (const cooldown of [false, true]) {
    const home = freshHome();
    const s = await start();
    const file = hostFile(home, s.url);
    const ctl = new AbortController();
    const rename = fs.renameSync;
    let stopped = false;
    fs.renameSync = ((from, to) => {
      rename(from, to);
      if (to !== file || s.arrivals.length !== 1 || stopped) return;
      stopped = true;
      if (cooldown) setCooldown(s.url, 429, "60");
      else ctl.abort();
    }) as typeof fs.renameSync;
    try {
      await assert.rejects(read(s.url + "/page", callStore({ signal: ctl.signal })), cooldown ? /Retry-After/ : /cancelled/);
      assert.equal(stopped, true);
      assert.deepEqual(s.arrivals.map(h => h.path), ["/robots.txt"]);
    } finally { fs.renameSync = rename; }
  }
});

test("visit: a failed active lease cannot authorize a shared waiver", async () => {
  for (const failRobots of [false, true]) {
    const home = freshHome();
    const s = await start();
    const active = hostFile(home, s.url) + ".active";
    const open = fs.openSync;
    let attempts = 0;
    fs.openSync = ((file, ...args) => {
      if (file === active && typeof args[0] === "number" && (args[0] & fs.constants.O_CREAT)) {
        attempts++;
        if (attempts === (failRobots ? 1 : 2)) throw new Error("lease unavailable");
      }
      return (open as any)(file, ...args);
    }) as typeof fs.openSync;
    try {
      await read(s.url + "/page");
      full(s.arrivals[1].at - s.arrivals[0].at);
    } finally { fs.openSync = open; }
  }
});

test("visit: repeated successful no-store visits keep pages and the next robots spaced", async () => {
  freshHome();
  const s = await start((req, res) => text(res, req.url === "/robots.txt" ? "User-agent: *\nAllow: /" : "page", 200, { "cache-control": "no-store" }));
  for (let i = 0; i < 3; i++) await read(s.url + "/page");
  assert.deepEqual(s.arrivals.map(h => h.path), ["/robots.txt", "/page", "/robots.txt", "/page", "/robots.txt", "/page"]);
  for (let i = 1; i < s.arrivals.length; i += 2) early(s.arrivals[i].at - s.arrivals[i - 1].at);
  invariant(s.arrivals);
});


test("visit: background door probes and form submissions never use a robots pass", async () => {
  for (const submit of [false, true]) {
    freshHome();
    const s = await start((req, res) => req.url === "/robots.txt"
      ? text(res, "User-agent: *\nAllow: /") : text(res, "", 404));
    if (submit) await callContext.run(callStore(), () => politeFetch(s.url + "/submit", { submit: true, method: "POST", body: Buffer.from("q=x") }));
    else await callContext.run(callStore(), () => probeOrigin(s.url, { sequential: true }));
    assert.ok(s.arrivals.length > 1);
    for (let i = 1; i < s.arrivals.length; i++) full(s.arrivals[i].at - s.arrivals[i - 1].at);
  }
});

// Entry-point regressions: these deliberately do not use read()/callStore() above. guarded() must
// create the holder before the pipeline's initial checkAllowed(), and withSignal/runPrivate must
// retain it. Record network arrivals, rather than inferring spacing from the call's total duration.
const ARTICLE = "<html><title>Spacing</title><body><h1>Spacing</h1><p>A local test page.</p></body></html>";
const PROBE_PATHS = ["/llms.txt", "/llms-full.txt", "/.well-known/mcp.json", "/.well-known/mcp", "/openapi.json", "/.well-known/openapi.json"];
const entryServer = (robots = "User-agent: *\nAllow: /") => start((req, res) => {
  if (req.url === "/robots.txt") return text(res, robots);
  if (PROBE_PATHS.includes(req.url!)) return text(res, "", 404);
  html(res, ARTICLE);
});
const ok = (out: Awaited<ReturnType<typeof engineRead>>) => assert.equal(out.status, "ok", JSON.stringify(out));

test("entry: first read pairs robots and page; the next page keeps full spacing", async () => {
  freshHome();
  const s = await entryServer();
  ok(await engineRead(s.url + "/one"));
  // Stop deferred discovery after the real read has returned, so this checks two foreground pages
  // without a background probe taking an intervening turn. No request or cache is stubbed.
  await abandonBackground();
  ok(await engineRead(s.url + "/two"));
  await abandonBackground();
  assert.deepEqual(s.arrivals.map(h => h.path), ["/robots.txt", "/one", "/two"]);
  early(s.arrivals[1].at - s.arrivals[0].at);
  full(s.arrivals[2].at - s.arrivals[1].at);
  invariant(s.arrivals);
});

test("entry: Crawl-delay keeps robots and both pages fully spaced, even below default", async () => {
  for (const delay of [0.1, 0.65]) {
    freshHome();
    const s = await entryServer(`User-agent: *\nAllow: /\nCrawl-delay: ${delay}`);
    ok(await engineRead(s.url + "/one"));
    await abandonBackground();
    ok(await engineRead(s.url + "/two"));
    await abandonBackground();
    assert.deepEqual(s.arrivals.map(h => h.path), ["/robots.txt", "/one", "/two"]);
    for (let i = 1; i < s.arrivals.length; i++) full(s.arrivals[i].at - s.arrivals[i - 1].at, Math.max(SPACING, delay * 1000));
  }
});

test("entry: parallel calls to a new site admit exactly one early page and no crowded window", async () => {
  freshHome();
  let seen!: () => void;
  const robotsSeen = new Promise<void>(r => { seen = r; });
  let finish!: () => void;
  const s = await start((req, res) => {
    if (req.url !== "/robots.txt") return PROBE_PATHS.includes(req.url!) ? text(res, "", 404) : html(res, ARTICLE);
    finish = () => text(res, "User-agent: *\nAllow: /");
    seen();
  });
  const owner = engineRead(s.url + "/owner");
  await robotsSeen;
  let joined!: () => void;
  const waiterJoined = new Promise<void>(r => { joined = r; });
  // Signal only after run() has reached checkAllowed/getRobots. Unlike a sleep, this proves the
  // second actual call is waiting on the owner's in-flight robots fetch before its response ends.
  const waiter = guarded("read", s.url + "/waiter", { agent: "test" }, undefined, m => {
    const pending = run("read", s.url + "/waiter", {}, m, "test");
    joined();
    return pending;
  });
  await waiterJoined;
  finish();
  const results = await Promise.all([owner, waiter]);
  results.forEach(ok);
  await abandonBackground();
  assert.deepEqual(s.arrivals.map(h => h.path), ["/robots.txt", "/owner", "/waiter"]);
  const robotsAt = s.arrivals[0].at;
  assert.equal(s.arrivals.slice(1).filter(h => h.at - robotsAt < SPACING - 15).length, 1);
  early(s.arrivals[1].at - robotsAt);
  full(s.arrivals[2].at - s.arrivals[1].at);
  // Adjacent short gaps must be exactly robots/page, and every triple spans a full spacing.
  invariant(s.arrivals);
});

test("entry: one guarded call pairs each of two new sites with its own robots fetch", async () => {
  freshHome();
  const a = await entryServer();
  const b = await entryServer();
  ok(await guarded("read", a.url + "/one", { agent: "test" }, undefined, async m => {
    const holder = callContext.getStore()!.robotsPasses!;
    assert.ok(holder);
    ok(await run("read", a.url + "/one", {}, m, "test"));
    await abandonBackground();
    assert.equal(callContext.getStore()!.robotsPasses, holder);
    const out = await run("read", b.url + "/two", {}, m, "test");
    assert.equal(callContext.getStore()!.robotsPasses, holder);
    assert.deepEqual([...holder.attempted].sort(), [a.url, b.url].sort());
    assert.equal(holder.pending.size, 0);
    return out;
  }));
  await abandonBackground();
  for (const [s, page] of [[a, "/one"], [b, "/two"]] as const) {
    assert.deepEqual(s.arrivals.map(h => h.path), ["/robots.txt", page]);
    early(s.arrivals[1].at - s.arrivals[0].at);
    invariant(s.arrivals);
  }
});

test("entry: doors wait probes between robots and page defeat the pass", async () => {
  const home = freshHome();
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ doors: "wait" }), { mode: 0o600 });
  const s = await entryServer();
  ok(await engineRead(s.url + "/page"));
  assert.deepEqual(s.arrivals.map(h => h.path), ["/robots.txt", ...PROBE_PATHS, "/page"]);
  for (let i = 1; i < s.arrivals.length; i++) full(s.arrivals[i].at - s.arrivals[i - 1].at);
  invariant(s.arrivals);
});

test("entry: private unshared reads pair in process and preserve shared hosts debt byte for byte", async () => {
  const home = freshHome();
  neverAsk(home);
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ private_spacing: "none" }), { mode: 0o600 });
  // Private reads always discover in the foreground. Robots forbids the probe paths so that the
  // page really is the next request; the wait-mode case above covers probes that do reach the site.
  const s = await entryServer("User-agent: *\nAllow: /\n" + PROBE_PATHS.map(p => `Disallow: ${p}$`).join("\n"));
  const file = hostFile(home, s.url);
  fs.mkdirSync(path.dirname(file), { mode: 0o700 });
  const next = Date.now() + SPACING;
  const original = JSON.stringify({ v: 1, last: next - SPACING, next });
  fs.writeFileSync(file, original, { mode: 0o600 });
  for (const page of ["/one", "/two"]) {
    const out = await engineRead(s.url + page, {}, { agent: "test", private: true });
    ok(out);
    assert.equal(out.private, true);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
  }
  assert.deepEqual(s.arrivals.map(h => h.path), ["/robots.txt", "/one", "/robots.txt", "/two"]);
  assert.ok(s.arrivals[0].at >= next - 15, "private robots must honor the existing shared debt");
  early(s.arrivals[1].at - s.arrivals[0].at);
  full(s.arrivals[2].at - s.arrivals[1].at);
  early(s.arrivals[3].at - s.arrivals[2].at);
  invariant(s.arrivals);
});

test("entry: a background-style context without a holder gives the pipeline no pass", async () => {
  freshHome();
  const s = await entryServer();
  const config = snapshotConfig();
  const sent = { requests: 0, signed: 0 };
  // Same fresh context and shallow withSignal copy as background.ts, deliberately without guarded().
  const out = await callContext.run({ config }, () => withSignal(AbortSignal.timeout(10_000), async () => {
    const store = callContext.getStore()!;
    store.sites = loadSites();
    assert.equal(store.robotsPasses, undefined);
    const result = await run("read", s.url + "/page", {}, {}, "test");
    assert.equal(store.robotsPasses, undefined);
    return result;
  }, sent));
  ok(out);
  await abandonBackground();
  assert.equal(sent.requests, 2);
  assert.deepEqual(s.arrivals.map(h => h.path), ["/robots.txt", "/page"]);
  full(s.arrivals[1].at - s.arrivals[0].at);
  invariant(s.arrivals);
});
