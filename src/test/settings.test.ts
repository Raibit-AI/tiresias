// SPDX-License-Identifier: Apache-2.0
// v0.6 track 3 (settings): W-30 fast first read, W-25 site settings, W-29 the settings command.
// Every site here is a LOCAL test server. Each test fails without the feature it names.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { freshHome, html, neverAsk, serve, text, type TestServer } from "./helper.js";

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-v06s-home-"));
process.env.HOME = FAKE_HOME;
freshHome();
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
delete process.env.TIRESIAS_PRIVATE;
delete process.env.TIRESIAS_PROFILE;

const engine = await import("../engine.js");
const background = await import("../background.js");
// Every import is at the top: node:test runs the `after` hook once the tests declared before a top-level
// await have finished, so a later await would leave later tests' servers open.
const sites = await import("../sites.js");
const { callContext } = await import("../context.js");
const httpMod = await import("node:http");
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

const servers: TestServer[] = [];
const start = async (h: Parameters<typeof serve>[0]) => {
  const s = await serve(h);
  servers.push(s);
  return s;
};
after(async () => {
  await background.abandonBackground();
  for (const s of servers) await s.close();
  (await import("../sandbox.js")).stopWorker();
});
const ctx = { agent: "v06-settings-tester" };
const home = () => process.env.TIRESIAS_HOME!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PROBE_PATHS = ["/llms.txt", "/llms-full.txt", "/.well-known/mcp.json", "/.well-known/mcp", "/openapi.json", "/.well-known/openapi.json"];

// A fresh store with the real 1-second spacing and background door checks (the suite's defaults are 0 ms and
// "wait"; see helper.ts).
function politeHome(): string {
  const h = freshHome();
  delete process.env.TIRESIAS_HOST_SPACING_MS;
  delete process.env.TIRESIAS_DOORS_DEFAULT;
  return h;
}
function quickHome(): string {
  const h = freshHome();
  process.env.TIRESIAS_HOST_SPACING_MS = "0";
  delete process.env.TIRESIAS_DOORS_DEFAULT;
  return h;
}
function writeConfig(o: Record<string, unknown>): void {
  fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home(), "config.json"), JSON.stringify(o), { mode: 0o600 });
}
const doorsCacheFiles = () => {
  const d = path.join(home(), "cache");
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((n) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(d, n), "utf8")).probed_at !== undefined;
    } catch {
      return false;
    }
  });
};

// A site with an llms.txt: a root read uses it once its doors are known.
type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
async function doorSite(extra: Record<string, Handler> = {}, robots = "") {
  const times: { path: string; t: number }[] = [];
  const s = await start((req, res) => {
    times.push({ path: req.url ?? "", t: Date.now() });
    const h = extra[req.url ?? ""];
    if (h) return h(req, res);
    if (req.url === "/robots.txt") return robots ? text(res, robots) : text(res, "", 404);
    if (req.url === "/llms.txt") return text(res, "# Door site\n\n> The agent version of this site.\n");
    if (req.url === "/" || req.url === "/p") return html(res, "<html><head><title>Door site</title></head><body><h1>Door site</h1><p>The human page.</p></body></html>");
    return text(res, "nothing", 404);
  });
  return { s, times };
}

// ---- W-30: fast first read ----

test("W-30: a first read returns the page after robots.txt alone; the door checks follow, spaced, and are cached (timing measured)", async (t) => {
  politeHome();
  const { s, times } = await doorSite();
  const t0 = Date.now();
  const r = await engine.read(s.url + "/", {}, ctx);
  const fast = Date.now() - t0;
  assert.equal(r.status, "ok", r.message);
  assert.equal(r.doors_pending, true, "the reply says the door checks are still running");
  assert.equal(r.door_detail, "html", "the first read reads the page itself");
  assert.deepEqual(times.slice(0, 2).map((x) => x.path), ["/robots.txt", "/"], "robots.txt, then the page, before any probe");
  assert.ok(fast < 2500, `first read took ${fast} ms`);
  assert.equal(background.backgroundCount(), 1);
  await background.drainBackground();
  for (const p of PROBE_PATHS) assert.equal(s.count(p), 1, `probe ${p} was sent once, after the reply`);
  for (let i = 1; i < times.length; i++) assert.ok(times[i].t - times[i - 1].t >= 950, `gap ${i} (${times[i].path}): ${times[i].t - times[i - 1].t} ms`);
  assert.equal(doorsCacheFiles().length, 1, "the door answers are cached");
  // The next read uses the cached doors: the root is read from llms.txt, with no probe and no doors_pending.
  const before = times.length;
  const r2 = await engine.read(s.url + "/", { fresh: true }, ctx);
  assert.equal(r2.status, "ok", r2.message);
  assert.equal(r2.doors_pending, undefined);
  assert.equal(r2.door_detail, "llms.txt", "the next read uses the cached door");
  assert.deepEqual(times.slice(before).map((x) => x.path), ["/llms.txt"], "one request: the door itself");

  // Before (v0.5.1 behaviour, doors: "wait"), measured the same way on a new site.
  const { s: s2 } = await doorSite();
  writeConfig({ doors: "wait" });
  const t1 = Date.now();
  const w = await engine.read(s2.url + "/", {}, ctx);
  const slow = Date.now() - t1;
  assert.equal(w.status, "ok", w.message);
  assert.equal(w.doors_pending, undefined);
  assert.ok(slow >= 6000, `the wait mode took ${slow} ms`);
  t.diagnostic(`first read with 1 s spacing: background ${fast} ms, wait ${slow} ms`);
  console.log(`# W-30 timing: first read with 1 s spacing: background ${fast} ms, wait ${slow} ms`);
});

test("W-30: doors \"wait\" restores v0.5.1: the probes go first and the reply has the doors", async () => {
  quickHome();
  writeConfig({ doors: "wait" });
  const { s, times } = await doorSite();
  const r = await engine.read(s.url + "/", {}, ctx);
  assert.equal(r.status, "ok", r.message);
  assert.equal(r.doors_pending, undefined);
  assert.equal(r.door_detail, "llms.txt", "the doors were known before the page was read");
  assert.equal(background.backgroundCount(), 0, "no background job");
  assert.ok(times.findIndex((x) => x.path === "/llms.txt") < times.length, "probed in the call");
  for (const p of PROBE_PATHS) assert.equal(s.count(p) >= 1, true, `${p} probed during the call`);
});

test("W-30: a private read starts no background work and keeps nothing: it checks the doors in the call, as before", async () => {
  quickHome();
  const { s } = await doorSite();
  const r = await engine.read(s.url + "/", {}, { ...ctx, private: true });
  assert.equal(r.status, "ok", r.message);
  assert.equal(r.private, true);
  assert.equal(r.doors_pending, undefined);
  assert.equal(background.backgroundCount(), 0, "no background job for a private read");
  assert.equal(r.door_detail, "llms.txt", "the doors were checked in the call");
  for (const p of PROBE_PATHS.slice(1)) assert.equal(s.count(p), 1, `${p} probed during the private call`);
  await sleep(100);
  assert.equal(doorsCacheFiles().length, 0, "nothing cached");
});

test("W-30: a session made private by TIRESIAS_PRIVATE starts no background work either", async () => {
  quickHome();
  const { s } = await doorSite();
  process.env.TIRESIAS_PRIVATE = "1";
  try {
    const r = await engine.read(s.url + "/p", {}, ctx);
    assert.equal(r.status, "ok", r.message);
    assert.equal(r.doors_pending, undefined);
    assert.equal(background.backgroundCount(), 0);
  } finally {
    delete process.env.TIRESIAS_PRIVATE;
  }
});

test("W-30: a wall, an error or a refusal starts no door checks", async () => {
  quickHome();
  const { s } = await doorSite({
    "/wall": (_q, res) => html(res, '<html><body><form><input type="password" name="pw"></form></body></html>', {}, 403),
    "/gone": (_q, res) => text(res, "gone", 404),
  });
  for (const p of ["/wall", "/gone"]) {
    const r = await engine.read(s.url + p, {}, ctx);
    assert.notEqual(r.status, "ok", p);
    assert.equal(r.doors_pending, undefined, p);
  }
  assert.equal(background.backgroundCount(), 0);
  await sleep(50);
  for (const p of PROBE_PATHS) assert.equal(s.count(p), 0, `${p} never probed`);
});

test("W-30: two reads of one new site start one job; a read during the checks waits behind at most one probe", async () => {
  politeHome();
  const { s, times } = await doorSite();
  const r1 = await engine.read(s.url + "/p", {}, ctx);
  assert.equal(r1.doors_pending, true);
  await sleep(1500); // the first probe or two are out
  const t0 = Date.now();
  const r2 = await engine.read(s.url + "/", { fresh: true }, ctx);
  const took = Date.now() - t0;
  assert.equal(r2.status, "ok", r2.message);
  assert.equal(r2.doors_pending, true, "still running: the same job");
  assert.ok(took < 2600, `a read during the checks took ${took} ms (sequential probes)`);
  assert.equal(background.backgroundCount(), 1, "one job per site");
  await background.drainBackground();
  for (const p of PROBE_PATHS) assert.equal(s.count(p), 1, `${p} probed once, not once per read`);
  for (let i = 1; i < times.length; i++) assert.ok(times[i].t - times[i - 1].t >= 950, `gap ${i}: ${times[i].t - times[i - 1].t} ms`);
});

test("W-30: background checks honour Crawl-delay; cancelling them leaves no lease and caches nothing", async () => {
  politeHome();
  const { s, times } = await doorSite({}, "User-agent: *\nCrawl-delay: 2\n");
  const r = await engine.read(s.url + "/p", {}, ctx);
  assert.equal(r.status, "ok", r.message);
  assert.equal(r.doors_pending, true);
  while (times.length < 4) await sleep(50); // robots, page, two probes
  await background.abandonBackground();
  for (let i = 2; i < times.length; i++) assert.ok(times[i].t - times[i - 1].t >= 1950, `gap ${i}: ${times[i].t - times[i - 1].t} ms (Crawl-delay 2)`);
  assert.ok(s.count("/.well-known/openapi.json") === 0, "the rest were never sent");
  assert.equal(background.backgroundCount(), 0);
  assert.equal(doorsCacheFiles().length, 0, "a cancelled job caches nothing");
  const leases = fs.readdirSync(path.join(home(), "hosts")).filter((n) => n.endsWith(".active") || n.endsWith(".lock"));
  assert.deepEqual(leases, [], "no lease or lock left behind");
});

test("W-30: a Retry-After answer to a probe stops the rest and nothing is cached", async () => {
  quickHome();
  const { s } = await doorSite({ "/llms-full.txt": (_q, res) => text(res, "slow down", 429, { "retry-after": "120" }) });
  const r = await engine.read(s.url + "/p", {}, ctx);
  assert.equal(r.doors_pending, true);
  await background.drainBackground();
  assert.equal(s.count("/llms.txt"), 1);
  assert.equal(s.count("/llms-full.txt"), 1);
  for (const p of PROBE_PATHS.slice(2)) assert.equal(s.count(p), 0, `${p} not sent during the wait`);
  assert.equal(doorsCacheFiles().length, 0, "answers learned under a Retry-After wait are not kept");
});

test("W-30: a bad doors setting fails the read with an error naming the key", async () => {
  quickHome();
  writeConfig({ doors: "sometimes" });
  const { s } = await doorSite();
  const r = await engine.read(s.url + "/p", {}, ctx);
  assert.equal(r.status, "error");
  assert.match(r.message ?? "", /"doors"/);
  assert.equal(s.count("/p"), 0);
});

test("W-30: without fresh door answers a read goes back to the kept copy's source (no flip between the twin and the page)", async () => {
  quickHome();
  writeConfig({ doors: "wait" });
  const { s } = await doorSite({
    "/llms.txt": (_q, res) => text(res, "# Site\n\n- [Guide](/guide.md)\n"),
    "/guide": (_q, res) => html(res, "<html><body><p>human guide</p></body></html>"),
    "/guide.md": (_q, res) => text(res, "# Guide\n\nThe markdown guide.\n", 200, { "content-type": "text/markdown" }),
  });
  const r1 = await engine.read(s.url + "/guide", {}, ctx);
  assert.equal(r1.door_detail, "markdown", r1.message);
  // The door answers expire; the owner switches back to background checks.
  for (const f of doorsCacheFiles()) fs.rmSync(path.join(home(), "cache", f));
  writeConfig({});
  const r2 = await engine.read(s.url + "/guide", { fresh: true }, ctx);
  assert.ok(r2.status === "ok" || r2.status === "unchanged", r2.message);
  assert.equal(r2.door_detail, "markdown", "read from where the kept copy came from");
  assert.equal(s.count("/guide"), 0, "the human page was never fetched");
  await background.drainBackground();
});

// The CLI waits for the background checks before it exits, and Ctrl-C cancels them cleanly.
function runCli(args: string[], env: NodeJS.ProcessEnv, onOut?: (child: ReturnType<typeof spawn>, out: string) => void): Promise<{ code: number | null; out: string; err: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const c = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => {
      out += d;
      onOut?.(c, out);
    });
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => resolve({ code, out, err, ms: Date.now() - t0 }));
  });
}

test("W-30: the CLI prints the page, then exits only after the background checks are done", async () => {
  politeHome();
  const { s } = await doorSite();
  let printedAt = 0;
  const t0 = Date.now();
  const r = await runCli(["read", s.url + "/p"], { TIRESIAS_HOST_SPACING_MS: "" }, (_c, out) => {
    if (!printedAt && out.includes("doors_pending")) printedAt = Date.now() - t0;
  });
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).doors_pending, true);
  for (const p of PROBE_PATHS) assert.equal(s.count(p), 1, `${p} probed before the CLI exited`);
  assert.ok(printedAt > 0 && printedAt < r.ms - 3000, `printed at ${printedAt} ms, exited at ${r.ms} ms`);
  assert.equal(doorsCacheFiles().length, 1, "the answers were cached before exit");
});

test("W-30: Ctrl-C while the CLI waits for background checks cancels them cleanly", async () => {
  politeHome();
  const { s } = await doorSite();
  let sent = false;
  const r = await runCli(["read", s.url + "/p"], { TIRESIAS_HOST_SPACING_MS: "" }, (c, out) => {
    if (!sent && out.includes("doors_pending")) {
      sent = true;
      setTimeout(() => c.kill("SIGINT"), 1300);
    }
  });
  assert.equal(r.code, 130, `exit ${r.code}: ${r.err}`);
  assert.ok(s.count("/.well-known/openapi.json") === 0, "the remaining probes were never sent");
  assert.equal(doorsCacheFiles().length, 0, "nothing cached");
  const leases = fs.readdirSync(path.join(home(), "hosts")).filter((n) => n.endsWith(".active") || n.endsWith(".lock"));
  assert.deepEqual(leases, [], "no lease left behind");
});

// ---- W-25: site settings ----


// A server on the IPv6 loopback ([::1]), so a test has two different hosts: 127.0.0.1 and [::1].
async function startV6(handler: Handler): Promise<TestServer> {
  const hits: { path: string; headers: http.IncomingHttpHeaders }[] = [];
  const server = httpMod.createServer((req, res) => {
    hits.push({ path: req.url ?? "", headers: req.headers });
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "::1", r));
  const port = (server.address() as { port: number }).port;
  const s: TestServer = {
    url: `http://[::1]:${port}`,
    hits,
    count: (p) => hits.filter((h) => h.path === p).length,
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
  servers.push(s);
  return s;
}
const plainSite = (body = "<html><body><h1>Plain</h1><p>A plain page.</p></body></html>", headers: Record<string, string> = {}) =>
  start((req, res) => (req.url === "/robots.txt" ? text(res, "", 404) : req.url === "/p" ? html(res, body, headers) : text(res, "nothing", 404)));

test("W-25: site names: one written form, wildcards cover the host and every name under it, the most specific entry wins per setting", () => {
  assert.equal(sites.normalizeSite("Example.COM.", true), "example.com");
  assert.equal(sites.normalizeSite("https://Example.com:8443/path?q", true), "example.com");
  assert.equal(sites.normalizeSite("*.example.com"), "*.example.com");
  assert.equal(sites.normalizeSite("[::1]"), "[::1]");
  assert.equal(sites.normalizeSite("bücher.example", true), "xn--bcher-kva.example");
  for (const badSite of ["", "example.com/x", "example.com:80", "user@example.com", "*.1.2.3.4", "*", "ex ample.com", "*.", "http://"]) assert.throws(() => sites.normalizeSite(badSite, true), /not a site/, badSite);
  assert.throws(() => sites.normalizeSite("Example.com"), /must be written as "example.com"/, "config.json keys must be the written form");
  const table = sites.parseSites({
    "*.example.com": { never_visit: true, spacing_seconds: 3 },
    "docs.example.com": { never_visit: false, hand_off: true },
    "example.com": { spacing_seconds: 2 },
  });
  assert.deepEqual(sites.ruleFor("a.b.example.com", table), { spacing_seconds: 3, never_visit: true });
  assert.deepEqual(sites.ruleFor("DOCS.example.com.", table), { spacing_seconds: 3, hand_off: true, never_visit: false }, "capitals and a trailing dot change nothing");
  assert.deepEqual(sites.ruleFor("example.com", table), { spacing_seconds: 2, never_visit: true }, "the wildcard covers the bare host too");
  assert.deepEqual(sites.ruleFor("notexample.com", table), {}, "a name merely ending the same is another site");
  assert.deepEqual(sites.ruleFor("127.0.0.1", sites.parseSites({ "127.0.0.1": { hand_off: true } })), { hand_off: true });
});

test("W-25: a bad site setting is refused by name, and spacing can only be raised (1 to 30 s)", () => {
  const cases: [unknown, RegExp][] = [
    [{ "example.com": { spacing_seconds: 0.5 } }, /"example.com": "spacing_seconds" must be a number of seconds from 1 to 30/],
    [{ "example.com": { spacing_seconds: 31 } }, /spacing_seconds/],
    [{ "example.com": { spacing_seconds: "5" } }, /spacing_seconds/],
    [{ "example.com": { ports: "80,abc" } }, /"ports"/],
    [{ "example.com": { ports: "0" } }, /"ports"/],
    [{ "example.com": { hand_off: "yes" } }, /"hand_off" must be true or false/],
    [{ "example.com": { colour: "red" } }, /unknown setting "colour"/],
    [{ "example.com": [] }, /must be an object/],
    [{ "EXAMPLE.com": {} }, /must be written as "example.com"/],
    [[], /"sites" must be an object/],
  ];
  for (const [v, re] of cases) assert.throws(() => sites.parseSites(v), re, JSON.stringify(v));
});

test("W-25: never_visit refuses before anything is sent, says so, and is recorded; a bad sites value fails reads by name but never clear", async () => {
  quickHome();
  const s = await plainSite();
  writeConfig({ sites: { "127.0.0.1": { never_visit: true, hand_off: true } } });
  const r = await engine.read(s.url + "/p", {}, ctx);
  assert.equal(r.status, "refused", r.message);
  assert.equal(r.message, sites.NEVER_VISIT, "never_visit beats hand_off");
  assert.deepEqual(r.site_settings, ["never_visit"]);
  assert.equal(s.hits.length, 0, "not even robots.txt");
  for (const call of [() => engine.check(s.url + "/p", ctx), () => engine.doors(s.url + "/p", ctx)]) {
    const x = await call();
    assert.equal(x.status, "refused");
    assert.deepEqual(x.site_settings, ["never_visit"]);
  }
  assert.equal(s.hits.length, 0);
  // A bad value: every call that sends a request fails, naming the setting; clear does not.
  writeConfig({ sites: { "127.0.0.1": { never_visit: "yes" } } });
  const b = await engine.read(s.url + "/p", {}, ctx);
  assert.equal(b.status, "error");
  assert.match(b.message ?? "", /"sites" → "127.0.0.1": "never_visit" must be true or false/);
  assert.equal(s.hits.length, 0, "fails closed: nothing sent");
  const { loadLimits } = await import("../config.js");
  assert.doesNotThrow(() => loadLimits(), "clear and the daily trim never read sites");
});

test("W-25: a redirect to a never_visit site is refused at that hop; a door probe sent there is just no door", async () => {
  quickHome();
  const far = await startV6((_q, res) => text(res, "should never be reached"));
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    if (req.url === "/go") return (res.writeHead(302, { location: far.url + "/landing" }), res.end());
    if (req.url === "/llms.txt") return (res.writeHead(302, { location: far.url + "/llms.txt" }), res.end());
    if (req.url === "/") return html(res, "<html><body><p>near page</p></body></html>");
    return text(res, "nothing", 404);
  });
  writeConfig({ doors: "wait", sites: { "[::1]": { never_visit: true } } });
  const p = await engine.read(s.url + "/", {}, ctx);
  assert.equal(p.status, "ok", p.message);
  assert.equal(p.door_detail, "html", "the llms.txt that redirected there is no door");
  assert.deepEqual(p.site_settings, ["never_visit"], "it applied to the probe that redirected there");
  const r = await engine.read(s.url + "/go", {}, ctx);
  assert.equal(r.status, "refused", r.message);
  assert.deepEqual(r.site_settings, ["never_visit"]);
  assert.equal((r.untrusted_content as { refused_url?: string }).refused_url, far.url + "/landing", "the hop that was refused, inside untrusted_content");
  assert.equal(far.hits.length, 0, "the never_visit site got nothing");
});

test("W-25: hand_off gives the person the link instead of reading, keeps no ticket, and is never served from the cache", async () => {
  quickHome();
  const s = await plainSite(undefined, { "cache-control": "max-age=600" });
  const first = await engine.read(s.url + "/p", {}, ctx);
  assert.equal(first.status, "ok", first.message);
  await background.drainBackground();
  const before = s.hits.length;
  writeConfig({ sites: { "127.0.0.1": { hand_off: true } } });
  const r = await engine.read(s.url + "/p", {}, { agent: "another-agent" });
  assert.equal(r.status, "wall", r.message);
  assert.equal(r.handoff?.reason, "owner_hand_off");
  assert.equal(r.handoff?.ticket, undefined, "no ticket");
  assert.match(r.handoff?.resume ?? "", /always go to a person/);
  assert.equal((r.untrusted_content as { handoff?: { open_this?: string } }).handoff?.open_this, s.url + "/p");
  assert.deepEqual(r.site_settings, ["hand_off"]);
  assert.equal(r.cache, undefined, "the fresh cached copy was not served");
  assert.equal(s.hits.length, before, "nothing sent");
  const { logText } = await import("./helper.js");
  assert.match(logText(home(), "history"), /"reason":"owner_hand_off"/, "history records why");
  assert.deepEqual(fs.existsSync(path.join(home(), "handoffs")) ? fs.readdirSync(path.join(home(), "handoffs")) : [], [], "no ticket file");
});

test("W-25: a site's spacing raises the gap between its requests (robots.txt included) and the reply says so", async () => {
  quickHome();
  const times: number[] = [];
  const s = await start((req, res) => {
    times.push(Date.now());
    if (req.url === "/robots.txt") return text(res, "", 404);
    return html(res, "<html><body><p>spaced page</p></body></html>");
  });
  writeConfig({ doors: "wait", sites: { "127.0.0.1": { spacing_seconds: 1.5 } } });
  const r = await engine.read(s.url + "/p", {}, ctx);
  assert.equal(r.status, "ok", r.message);
  assert.deepEqual(r.site_settings, ["spacing"]);
  assert.ok(times.length >= 3);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 1450, `gap ${i}: ${times[i] - times[i - 1]} ms`);
  // A site with no setting of its own is not slowed and the reply names nothing.
  const other = await startV6((req, res) => (req.url === "/robots.txt" ? text(res, "", 404) : html(res, "<html><body><p>x</p></body></html>")));
  const r2 = await engine.read(other.url + "/p", {}, ctx);
  assert.equal(r2.status, "ok", r2.message);
  assert.equal(r2.site_settings, undefined);
});

test("W-25: a site's ports allow a port the default list refuses, for that site only, and say so", async () => {
  quickHome();
  const saved = process.env.TIRESIAS_ALLOW_PRIVATE;
  delete process.env.TIRESIAS_ALLOW_PRIVATE; // assertPort is skipped for the suite's local servers
  try {
    const { assertPort } = await import("../safety.js");
    const u = new URL("https://example.com:9443/");
    assert.throws(() => assertPort(u), /port_blocked/);
    neverAsk(home()); // W-32 (v0.9): more ports written by hand
    writeConfig({ sites: { "example.com": { ports: "9443,10000-10010" } } });
    const used = new Set<"spacing" | "ports" | "hand_off" | "never_visit">();
    callContext.run({ site: used }, () => {
      assertPort(u);
      assertPort(new URL("https://example.com:10005/"));
      assert.throws(() => assertPort(new URL("https://example.com:9444/")), /port_blocked/);
      assert.throws(() => assertPort(new URL("https://other.example:9443/")), /port_blocked/, "another site keeps the default list");
    });
    assert.deepEqual([...used], ["ports"]);
    const plain = new Set<"spacing" | "ports" | "hand_off" | "never_visit">();
    callContext.run({ site: plain }, () => assertPort(new URL("https://example.com/")));
    assert.deepEqual([...plain], [], "a default port is not the site setting at work");
  } finally {
    process.env.TIRESIAS_ALLOW_PRIVATE = saved;
  }
});

test("W-25: a form's target on a never_visit site is refused before a slip is claimed, even with its robots.txt already known", async () => {
  quickHome();
  const s = await plainSite();
  writeConfig({ doors: "wait" });
  assert.equal((await engine.read(s.url + "/p", {}, ctx)).status, "ok"); // robots.txt is now cached in memory
  writeConfig({ sites: { "127.0.0.1": { never_visit: true } } });
  const before = s.hits.length;
  const { policyCheck } = await import("../fetcher.js");
  await assert.rejects(() => policyCheck(new URL(s.url + "/contact")), (e: Error) => e instanceof sites.SiteRefused && e.setting === "never_visit");
  assert.equal(s.hits.length, before);
});

test("W-25: a robots.txt that redirects to a never_visit site is refused at that hop", async () => {
  quickHome();
  const far = await startV6((_q, res) => text(res, "User-agent: *\nAllow: /\n"));
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") return (res.writeHead(302, { location: far.url + "/robots.txt" }), res.end());
    return html(res, "<html><body><p>page</p></body></html>");
  });
  writeConfig({ sites: { "[::1]": { never_visit: true } } });
  const r = await engine.read(s.url + "/p", {}, ctx);
  assert.equal(r.status, "refused", r.message);
  assert.deepEqual(r.site_settings, ["never_visit"]);
  assert.equal(far.hits.length, 0);
  assert.equal(s.count("/p"), 0, "no page without robots.txt");
});

test("W-25: robots.txt itself waits the site's spacing (a no-store robots.txt is asked again by the next call)", async () => {
  quickHome();
  const times: { path: string; t: number }[] = [];
  const s = await start((req, res) => {
    times.push({ path: req.url ?? "", t: Date.now() });
    if (req.url === "/robots.txt") return text(res, "", 200, { "cache-control": "no-store" });
    return html(res, "<html><body><p>page</p></body></html>");
  });
  writeConfig({ doors: "wait" });
  await engine.read(s.url + "/p", {}, ctx);
  writeConfig({ doors: "wait", sites: { "127.0.0.1": { spacing_seconds: 2 } } });
  const before = times.length;
  await engine.read(s.url + "/p", { fresh: true }, ctx);
  assert.equal(times[before].path, "/robots.txt");
  assert.ok(times[before].t - times[before - 1].t >= 1950, `robots.txt came ${times[before].t - times[before - 1].t} ms after the last request`);
});

// ---- W-29: the settings command ----

const cli = (args: string[], env: NodeJS.ProcessEnv = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr, json: (() => { try { return JSON.parse(r.stdout || r.stderr); } catch { return null; } })() };
};
const cfgPath = () => path.join(home(), "config.json");
const cfg = () => JSON.parse(fs.readFileSync(cfgPath(), "utf8"));

test("W-29: settings lists every owner setting with its value, default, description and where it is stored; never a key", async () => {
  quickHome();
  writeConfig({ keep_cache_days: 12, sites: { "example.com": { spacing_seconds: 4 } } });
  const r = cli(["settings"], { TIRESIAS_WEB_RISK_KEY: "very-secret-key-value", TIRESIAS_ALLOW_PORTS: "9000" });
  assert.equal(r.code, 0, r.err);
  const v = r.json;
  const { KNOWN_KEYS } = await import("../config.js");
  const names = v.settings.map((x: { name: string }) => x.name);
  for (const k of KNOWN_KEYS.filter((k) => k !== "sites")) assert.ok(names.includes(k), `${k} is listed`);
  for (const row of [...v.settings, ...v.site_settings, ...v.environment]) {
    for (const f of ["name", "value", "default", "description", "stored", "is_set"]) assert.ok(f in row, `${row.name} has ${f}`);
    assert.ok(row.description.length > 10, `${row.name} is described`);
  }
  const kc = v.settings.find((x: { name: string }) => x.name === "keep_cache_days");
  assert.deepEqual([kc.value, kc.default, kc.is_set, kc.stored], [12, 30, true, cfgPath()]);
  assert.equal(v.settings.find((x: { name: string }) => x.name === "doors").value, "background");
  const sp = v.site_settings.find((x: { name: string; site?: string }) => x.name === "spacing_seconds" && x.site === "example.com");
  assert.equal(sp.value, 4);
  for (const n of ["ports", "hand_off", "never_visit"]) assert.ok(v.site_settings.some((x: { name: string; site?: string }) => x.name === n && !x.site), `${n} is listed with its default`);
  assert.equal(v.environment.find((x: { name: string }) => x.name === "TIRESIAS_ALLOW_PORTS").value, "9000");
  assert.equal(v.environment.find((x: { name: string }) => x.name === "TIRESIAS_WEB_RISK_KEY").value, "set");
  assert.ok(!r.out.includes("very-secret-key-value"), "the key itself is never printed");
  const t = cli(["settings", "--text"], { TIRESIAS_WEB_RISK_KEY: "very-secret-key-value" });
  assert.equal(t.code, 0);
  assert.match(t.out, /keep_cache_days = 12/);
  assert.match(t.out, /example\.com: spacing_seconds = 4/);
  assert.ok(!t.out.includes("very-secret-key-value"));
});

test("W-29: settings set and reset change one setting, keep every other key, and write 0600 atomically", () => {
  quickHome();
  writeConfig({ keep_history_days: 45, scanner: { command: ["/bin/echo"], timeout_seconds: 5, send_file: false } });
  let r = cli(["settings", "set", "doors", "wait"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(cfg(), { keep_history_days: 45, scanner: { command: ["/bin/echo"], timeout_seconds: 5, send_file: false }, doors: "wait" });
  assert.equal(fs.statSync(cfgPath()).mode & 0o777, 0o600);
  r = cli(["settings", "set", "safe_browsing", "off", "--confirm", "YES, TURN OFF SAFE BROWSING"]); // W-32 (v0.9)
  assert.equal(r.code, 0, r.err);
  assert.equal(cfg().safe_browsing, false);
  r = cli(["settings", "set", "signature_agent", "https://Example.com"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(cfg().signature_agent, "https://example.com", "stored as the reader reads it");
  r = cli(["settings", "reset", "doors"]);
  assert.equal(r.code, 0, r.err);
  assert.equal("doors" in cfg(), false);
  r = cli(["settings", "reset", "scanner"]);
  assert.equal(r.code, 0, r.err);
  assert.equal("scanner" in cfg(), false, "reset scanner is scanner off");
  assert.deepEqual(fs.readdirSync(home()).filter((n) => n.includes(".tmp") || n.endsWith(".lock")), [], "no temp file or lock left");
  // Site settings take a site, written in one form.
  r = cli(["settings", "set", "never_visit", "Tracker.EXAMPLE.", "on"]);
  assert.equal(r.code, 0, r.err);
  r = cli(["settings", "set", "spacing_seconds", "*.example.org", "2.5"]);
  assert.equal(r.code, 0, r.err);
  r = cli(["settings", "set", "hand_off", "docs.example.org", "off", "--confirm", "YES, TURN OFF HAND_OFF FOR DOCS.EXAMPLE.ORG"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(cfg().sites, { "tracker.example": { never_visit: true }, "*.example.org": { spacing_seconds: 2.5 }, "docs.example.org": { hand_off: false } });
  r = cli(["settings", "reset", "never_visit", "tracker.example", "--confirm", "YES, TURN OFF NEVER_VISIT FOR TRACKER.EXAMPLE"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(Object.keys(cfg().sites), ["*.example.org", "docs.example.org"], "an empty site goes");
  cli(["settings", "reset", "spacing_seconds", "*.example.org", "--confirm", "YES, LOWER THE SPACING FOR *.EXAMPLE.ORG"]);
  cli(["settings", "reset", "hand_off", "docs.example.org"]);
  assert.equal("sites" in cfg(), false, "and an empty sites goes");
});

test("W-29: every value is checked; a refused change names the setting and leaves the file as it was", () => {
  quickHome();
  writeConfig({ keep_history_days: 45 });
  const before = fs.readFileSync(cfgPath(), "utf8");
  const refused: [string[], RegExp][] = [
    [["settings", "set", "keep_history_days", "0"], /"keep_history_days"/],
    [["settings", "set", "keep_history_days", "--", "-3"], /"keep_history_days"/],
    [["settings", "set", "doors", "sometimes"], /"doors" must be "background" or "wait"/],
    [["settings", "set", "safe_browsing", "maybe"], /"safe_browsing" takes on or off/],
    [["settings", "set", "signature_agent", "http://example.com"], /https/],
    [["settings", "set", "web_risk_key_file", "relative/key.env"], /full path/],
    [["settings", "set", "scanner", "/bin/echo"], /tiresias scanner set/],
    [["settings", "set", "colour", "red"], /"colour" is not a setting/],
    [["settings", "set", "spacing_seconds", "example.com", "0.5"], /"spacing_seconds" must be a number of seconds from 1 to 30/],
    [["settings", "set", "spacing_seconds", "example.com", "fast"], /"spacing_seconds" takes seconds/],
    [["settings", "set", "spacing_seconds", "5"], /Usage: tiresias settings set spacing_seconds <site> <value>/],
    [["settings", "set", "ports", "example.com", "99999"], /"ports"/],
    [["settings", "set", "hand_off", "example.com/path", "on"], /not a site/],
    [["settings", "set", "never_visit", "__proto__", "on"], /not a site/],
    [["settings", "set", "doors"], /Usage/],
    [["settings", "frobnicate"], /Usage/],
  ];
  for (const [args, re] of refused) {
    const r = cli(args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.json?.message ?? r.err, re, args.join(" "));
    assert.equal(fs.readFileSync(cfgPath(), "utf8"), before, `${args.join(" ")} changed nothing`);
  }
});

test("W-29: a bad config.json is reported by key; other changes wait until it is fixed, and reset repairs it", () => {
  quickHome();
  writeConfig({ keep_history_days: "ninety", wat: 1 });
  let r = cli(["settings"]);
  assert.equal(r.code, 1);
  assert.match(r.json.message, /"keep_history_days" must be a whole number/);
  assert.match(r.json.message, /unknown setting "wat"/);
  r = cli(["settings", "set", "doors", "wait"]);
  assert.equal(r.code, 1);
  assert.match(r.json.message, /^Not changed\. .*"keep_history_days"/);
  assert.equal("doors" in cfg(), false);
  assert.equal(cli(["settings", "reset", "keep_history_days"]).code, 1, "wat is still wrong");
  r = cli(["settings", "reset", "wat"]);
  assert.equal(r.code, 1, "keep_history_days is still wrong, so nothing is written");
  // Each fix needs every other key right: fix the file by hand for one, then reset the other.
  writeConfig({ keep_history_days: "ninety" });
  r = cli(["settings", "reset", "keep_history_days"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(cfg(), {});
  // A broken "sites" is reported, never overwritten by a site setting.
  writeConfig({ sites: "oops" });
  r = cli(["settings", "set", "never_visit", "example.com", "on"]);
  assert.equal(r.code, 1);
  assert.match(r.json.message, /^Not changed\. config\.json: "sites" must be an object/);
  assert.deepEqual(cfg(), { sites: "oops" });
  fs.writeFileSync(cfgPath(), "{ not json");
  r = cli(["settings"]);
  assert.equal(r.code, 1);
  assert.match(r.json.message, /not valid JSON/);
  r = cli(["settings", "set", "doors", "wait"]);
  assert.equal(r.code, 1);
  assert.match(r.json.message, /not valid JSON/);
});

test("W-29: a private session changes no setting and creates nothing", () => {
  quickHome();
  for (const env of [{ TIRESIAS_PRIVATE: "1" }, {}]) {
    const args = ["settings", "set", "doors", "wait", ...("TIRESIAS_PRIVATE" in env ? [] : ["--private"])];
    const r = cli(args, env);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.json.message, /Private mode/);
    assert.equal(fs.existsSync(cfgPath()), false);
  }
  assert.equal(cli(["settings", "reset", "doors"]).code, 0);
  assert.equal(fs.existsSync(cfgPath()), false, "resetting what is not set writes nothing");
});

test("W-29: changes from several processes at once are all kept (the config lock)", async () => {
  quickHome();
  const names = ["a", "b", "c", "d", "e", "f"].map((x) => `${x}.example`);
  await Promise.all(
    names.map(
      (n) =>
        new Promise<void>((resolve) => {
          const c = spawn(process.execPath, [CLI, "settings", "set", "spacing_seconds", n, "3"], { env: process.env });
          c.on("close", () => resolve());
        }),
    ),
  );
  assert.deepEqual(Object.keys(cfg().sites).sort(), names);
  // While another command holds the lock, a change waits, then gives up and writes nothing.
  const before = fs.readFileSync(cfgPath(), "utf8");
  fs.writeFileSync(cfgPath() + ".lock", "");
  const r = cli(["settings", "set", "doors", "wait"]);
  assert.equal(r.code, 1);
  assert.match(r.json.message, /being changed by another Tiresias command/);
  assert.equal(fs.readFileSync(cfgPath(), "utf8"), before);
  assert.ok(fs.existsSync(cfgPath() + ".lock"), "another command's lock is never removed");
  fs.rmSync(cfgPath() + ".lock");
});

test("W-29: no MCP tool or parameter reads or changes a setting", async () => {
  quickHome();
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createServer } = await import("../mcp.js");
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  const client = new Client({ name: "settings-probe", version: "1.0.0" });
  await client.connect(b);
  const { KNOWN_KEYS } = await import("../config.js");
  const forbidden = new Set([...KNOWN_KEYS, "settings", "setting", "config", "spacing_seconds", "ports", "hand_off", "never_visit"]);
  for (const t of (await client.listTools()).tools) {
    assert.ok(!/setting|config/i.test(t.name), `tool ${t.name}`);
    for (const p of Object.keys((t.inputSchema.properties ?? {}) as object)) assert.ok(!forbidden.has(p), `${t.name} takes ${p}`);
  }
  await client.close();
  const mcpSource = fs.readFileSync(path.join(path.dirname(CLI), "mcp.js"), "utf8");
  assert.ok(!/settings\.js|writeConfig/.test(mcpSource), "the MCP server does not load the settings code");
});

// ---- Codex round 1 ----

test("round 1 #1: one site, one clock: a trailing dot is the same site; a site's spacing is per origin", async () => {
  const { canonOrigin } = await import("../sitekey.js");
  assert.equal(canonOrigin("http://Example.COM.:8080"), "http://example.com:8080");
  assert.equal(canonOrigin("https://example.com."), "https://example.com");
  quickHome();
  const cd = await import("../cooldown.js");
  cd.setCooldown("https://dotted.example.", 429, "120");
  assert.ok(cd.cooldownLeft("https://dotted.example") > 0, "a Retry-After on the dotted name holds for the plain one");
  cd.setCooldown("https://plain.example", 429, "120");
  assert.ok(cd.cooldownLeft("https://plain.example.") > 0, "and the other way round");
  const fetcher = await import("../fetcher.js");
  const sig = new AbortController().signal;
  await fetcher.throttle("https://clock.example.", 1, sig, "https://clock.example./a");
  const t0 = Date.now();
  await fetcher.throttle("https://clock.example", 1, sig, "https://clock.example/b");
  assert.ok(Date.now() - t0 >= 900, `the plain name waited ${Date.now() - t0} ms behind the dotted one`);
  // Decision after round 3: a site spacing is per ORIGIN, like every spacing; another port has its own clock.
  const times: number[] = [];
  const mk = () => start((req, res) => (times.push(Date.now()), req.url === "/robots.txt" ? text(res, "", 404) : html(res, "<html><body><p>x</p></body></html>")));
  const a = await mk();
  const b = await mk();
  writeConfig({ doors: "wait", sites: { "127.0.0.1": { spacing_seconds: 1.5 } } });
  await engine.read(a.url + "/p", {}, ctx);
  const last = times[times.length - 1];
  const n = times.length;
  await engine.read(b.url + "/p", {}, ctx);
  assert.ok(times[n] - last < 1000, `the other port did not wait for this one (${times[n] - last} ms)`);
  for (let i = n + 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 1450, `within one origin the site spacing holds: ${times[i] - times[i - 1]} ms`);
});

test("round 1 #3 and #4: scanner and settings share one owned config lock, never broken automatically", async () => {
  quickHome();
  writeConfig({ keep_cache_days: 9 });
  const lockFile = cfgPath() + ".lock";
  // A live owner (this test process), older than the old 5-second rule: still held.
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: "someone-else" }));
  const old = new Date(Date.now() - 20_000);
  fs.utimesSync(lockFile, old, old);
  for (const args of [["scanner", "set", "--", "/bin/echo"], ["settings", "set", "doors", "wait"]]) {
    const r = cli(args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.json.message, /being changed by another Tiresias command/, args.join(" "));
  }
  assert.deepEqual(cfg(), { keep_cache_days: 9 }, "nothing written while the lock is held");
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).token, "someone-else", "another owner's lock is never removed");
  // Decision after round 3: never cleared automatically, even when its owner is gone; the message says how.
  const dead = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: Number(dead.stdout.trim()), token: "gone" }));
  const blocked = cli(["scanner", "set", "--", "/bin/echo"]);
  assert.equal(blocked.code, 1);
  assert.ok(blocked.json.message.includes(`rm ${JSON.stringify(lockFile)}`), blocked.json.message);
  assert.ok(fs.existsSync(lockFile), "left for the person to delete");
  fs.rmSync(lockFile); // the person runs the command
  const r = cli(["scanner", "set", "--", "/bin/echo"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(cfg().scanner.command, ["/bin/echo"]);
  assert.equal(fs.existsSync(lockFile), false, "our own lock is released");
  // Release and the last check before the rename both look at the token.
  const { takeLock, releaseLock } = await import("../ownedlock.js");
  const mine = takeLock(cfgPath())!;
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: "a-new-owner" }));
  releaseLock(cfgPath(), mine);
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).token, "a-new-owner", "a lock that is no longer ours is left alone");
  fs.rmSync(lockFile);
  const { writeConfig: write } = await import("../config.js");
  const before = fs.readFileSync(cfgPath(), "utf8");
  assert.throws(() => write((o) => {
    o.doors = "wait";
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: "took-it-meanwhile" })); // our lock was broken and taken
  }), /being changed by another/);
  assert.equal(fs.readFileSync(cfgPath(), "utf8"), before, "a writer that lost its lock does not rename its file into place");
  assert.deepEqual(fs.readdirSync(home()).filter((n) => n.endsWith(".tmp")), []);
  fs.rmSync(lockFile);
});

test("round 1 #5: waiting on another call's robots.txt ends with this call's own cancellation", async () => {
  quickHome();
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") return void setTimeout(() => text(res, "", 404), 2500);
    html(res, "<html><body><p>x</p></body></html>");
  });
  const { withSignal } = await import("../safety.js");
  const { getRobots } = await import("../rules.js");
  const origin = s.url;
  const first = withSignal(new AbortController().signal, () => getRobots(origin));
  await sleep(100);
  const ctl = new AbortController();
  const second = withSignal(ctl.signal, () => getRobots(origin));
  setTimeout(() => ctl.abort(), 200);
  const t0 = Date.now();
  await assert.rejects(second, (e: Error & { code?: string }) => e.code === "cancelled");
  assert.ok(Date.now() - t0 < 1500, `cancelled after ${Date.now() - t0} ms, not when the other call's fetch ended`);
  await first;
});

test("round 1 #6: the MCP server cancels its background checks cleanly on SIGTERM", async () => {
  politeHome();
  const { s } = await doorSite();
  const c = spawn(process.execPath, [CLI, "mcp"], { env: { ...process.env, TIRESIAS_HOST_SPACING_MS: "" } });
  let out = "";
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) => c.on("exit", (code, signal) => r({ code, signal })));
  const send = (m: unknown) => c.stdin.write(JSON.stringify(m) + "\n");
  const answered = new Promise<string>((resolve) =>
    c.stdout.on("data", (d) => {
      out += d;
      if (out.includes("doors_pending")) resolve(out);
    }),
  );
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sig-test", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read", arguments: { url: s.url + "/p" } } });
  await answered;
  await sleep(1300); // a door check is out or waiting its turn (holding the site's lease)
  c.kill("SIGTERM");
  const e = await exited;
  assert.equal(e.code, 143, `exit ${e.code} ${e.signal}`);
  assert.equal(s.count("/.well-known/openapi.json"), 0, "the rest were never sent");
  const leftovers = fs.readdirSync(path.join(home(), "hosts")).filter((n) => n.endsWith(".active") || n.endsWith(".lock"));
  assert.deepEqual(leftovers, [], "no lease left behind");
  assert.equal(doorsCacheFiles().length, 0);
});

test("round 1 #7: background checks stop at a failed probe (a 5xx) and cache nothing", async () => {
  quickHome();
  const { s } = await doorSite({ "/llms-full.txt": (_q, res) => text(res, "broken", 500) });
  const r = await engine.read(s.url + "/p", {}, ctx);
  assert.equal(r.doors_pending, true);
  await background.drainBackground();
  for (const p of PROBE_PATHS.slice(2)) assert.equal(s.count(p), 0, `${p} not sent after the failure`);
  assert.equal(doorsCacheFiles().length, 0, "a failed check is not an hour of 'no door'");
});

test("round 1 #8 and #9: a copy served from the cache restarts the checks; a pending read still lists the page's own doors", async () => {
  quickHome();
  const { s } = await doorSite({
    "/f": (_q, res) => html(res, '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body><p>with a feed</p></body></html>', { "cache-control": "max-age=600" }),
  });
  const r = await engine.read(s.url + "/f", {}, ctx);
  assert.equal(r.doors_pending, true);
  const ad = (r.untrusted_content as { available_doors?: { best: string; feeds: string[] } }).available_doors;
  assert.equal(ad?.best, "feed", "the page's own feed is listed while the origin checks run");
  assert.deepEqual(ad?.feeds, [s.url + "/feed.xml"]);
  await background.abandonBackground(); // the job is cancelled: nothing cached
  assert.equal(doorsCacheFiles().length, 0);
  const again = await engine.read(s.url + "/f", {}, { agent: "another" });
  assert.equal(again.cache, "fresh", again.message);
  assert.equal(again.doors_pending, true, "served from the cache, and the checks started again");
  assert.equal(background.backgroundCount(), 1);
  await background.drainBackground();
  assert.equal(doorsCacheFiles().length, 1);
});

test("round 1 #10: reset says what is in force afterwards, a wider wildcard's value included", () => {
  quickHome();
  writeConfig({ sites: { "*.example.com": { never_visit: true }, "docs.example.com": { never_visit: false } } });
  let r = cli(["settings", "reset", "never_visit", "docs.example.com"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.json.message, /Now in force: true, from the entry for \*\.example\.com/);
  assert.equal(r.json.value, true);
  r = cli(["settings", "reset", "never_visit", "*.example.com", "--confirm", "YES, TURN OFF NEVER_VISIT FOR *.EXAMPLE.COM"]); // W-32 (v0.9)
  assert.match(r.json.message, /Now in force: the default \(off\)/);
  assert.equal(r.json.value, null);
});

// ---- Codex round 2 ----

test("round 2 #1: a host name longer than DNS allows is refused at once, before any work on it", async () => {
  quickHome();
  writeConfig({ sites: { "example.com": { spacing_seconds: 2 } } });
  const t0 = Date.now();
  const r = await engine.read("http://" + "a.".repeat(200_000) + "example/", {}, ctx);
  assert.equal(r.status, "refused", r.message);
  assert.equal(r.message, sites.HOST_TOO_LONG);
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
  const ok253 = "a".repeat(63) + "." + "b".repeat(63) + "." + "c".repeat(63) + "." + "d".repeat(61);
  assert.equal(ok253.length, 253);
  assert.doesNotThrow(() => sites.candidates(ok253));
});

test("round 2 #2 and #3 (per origin since round 3): concurrent private calls get separate slots, and a spacing turned on later counts the earlier request, in this process and another", async () => {
  quickHome();
  const fetcher = await import("../fetcher.js");
  const { runPrivate } = await import("../store.js");
  const sig = new AbortController().signal;
  writeConfig({ sites: { "clockp.example": { spacing_seconds: 1.5 } } });
  const times: number[] = [];
  await runPrivate(() =>
    Promise.all([1, 2, 3].map(async (n) => {
      await fetcher.throttle("https://clockp.example", 0, sig, `https://clockp.example/${n}`);
      times.push(Date.now());
    })),
  );
  times.sort((a, b) => a - b);
  assert.ok(times[1] - times[0] >= 1400 && times[2] - times[1] >= 1400, `private slots: ${times.map((t) => t - times[0]).join(", ")} ms`);
  writeConfig({});
  await fetcher.throttle("https://clockq.example", 0, sig, "https://clockq.example/a");
  writeConfig({ sites: { "clockq.example": { spacing_seconds: 1.5 } } });
  const t0 = Date.now();
  await fetcher.throttle("https://clockq.example", 0, sig, "https://clockq.example/b");
  assert.ok(Date.now() - t0 >= 1400, `waited ${Date.now() - t0} ms after the earlier request`);
  writeConfig({});
  await fetcher.throttle("https://clockr.example", 0, sig, "https://clockr.example/a");
  writeConfig({ sites: { "clockr.example": { spacing_seconds: 2 } } });
  const mod = path.join(path.dirname(CLI), "fetcher.js");
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", `const f = await import(${JSON.stringify(mod)}); const t = Date.now(); await f.throttle("https://clockr.example", 0, new AbortController().signal, "https://clockr.example/b"); console.log(Date.now() - t);`], { env: process.env, encoding: "utf8" });
  assert.ok(Number(out.stdout) >= 1500, `the other process waited ${out.stdout.trim()} ms (${out.stderr.slice(0, 200)})`);
});

test("round 2 #4: a live owner's config lock is never broken for its age", () => {
  quickHome();
  writeConfig({ keep_cache_days: 9 });
  const lockFile = cfgPath() + ".lock";
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: "suspended-writer" }));
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(lockFile, old, old);
  const r = cli(["settings", "set", "doors", "wait"]);
  assert.equal(r.code, 1);
  assert.match(r.json.message, /being changed by another Tiresias command.*delete it with  rm /);
  assert.deepEqual(cfg(), { keep_cache_days: 9 });
  // Nor an empty, old one: only the person deletes a lock.
  fs.writeFileSync(lockFile, "");
  fs.utimesSync(lockFile, old, old);
  assert.equal(cli(["settings", "set", "doors", "wait"]).code, 1);
  assert.ok(fs.existsSync(lockFile));
  fs.rmSync(lockFile);
  assert.equal(cli(["settings", "set", "doors", "wait"]).code, 0);
});

test("round 2 #5: on SIGTERM the MCP server cancels a call still running and waits for its cleanup", async () => {
  quickHome();
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    if (req.url === "/slow") return void setTimeout(() => html(res, "<html><body><p>late</p></body></html>"), 6000);
    text(res, "nothing", 404);
  });
  writeConfig({ doors: "wait" });
  const c = spawn(process.execPath, [CLI, "mcp"], { env: process.env });
  const exited = new Promise<{ code: number | null; t: number }>((r) => c.on("exit", (code) => r({ code, t: Date.now() })));
  const send = (m: unknown) => c.stdin.write(JSON.stringify(m) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sig-test", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read", arguments: { url: s.url + "/slow" } } });
  while (s.count("/slow") === 0) await sleep(50); // the page request is out, its site's lease held
  const active = () => (fs.existsSync(path.join(home(), "hosts")) ? fs.readdirSync(path.join(home(), "hosts")).filter((n) => n.endsWith(".active")) : []);
  assert.equal(active().length, 1, "the running call holds its lease");
  const t0 = Date.now();
  c.kill("SIGTERM");
  const e = await exited;
  assert.equal(e.code, 143);
  assert.ok(e.t - t0 < 3000, `exited ${e.t - t0} ms after the signal, not when the page came`);
  assert.deepEqual(active(), [], "the cancelled call gave back its lease before the exit");
});

test("round 2 #6: a bad doors setting fails every read, private and cached ones too", async () => {
  quickHome();
  const { s } = await doorSite({ "/f": (_q, res) => html(res, "<html><body><p>cached</p></body></html>", { "cache-control": "max-age=600" }) });
  writeConfig({ doors: "wait" });
  assert.equal((await engine.read(s.url + "/f", {}, ctx)).status, "ok"); // door answers and the page are cached
  writeConfig({ doors: "nope" });
  for (const [what, r] of [["private", await engine.read(s.url + "/f", {}, { ...ctx, private: true })], ["cached", await engine.read(s.url + "/f", {}, ctx)]] as const) {
    assert.equal(r.status, "error", what);
    assert.match(r.message ?? "", /"doors"/, what);
  }
});

test("round 2 #7: resetting web_risk_key_file reports the key file the reader falls back to", () => {
  quickHome();
  writeConfig({ web_risk_key_file: "/tmp/elsewhere.env" });
  const r = cli(["settings", "reset", "web_risk_key_file"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.value, path.join(FAKE_HOME, ".config", "tiresias", "secrets.env"));
  assert.match(r.json.message, /secrets\.env/);
});

// ---- Codex round 3 (the coordinator's decisions) ----

test("round 3 #5: on SIGTERM the MCP server also stops shared work (a Safe Browsing list download) and leaves no lease", async () => {
  quickHome();
  writeConfig({ doors: "wait" });
  const list = await start((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    if (req.url === "/list.txt") return void setTimeout(() => text(res, "phish.example\n"), 8000);
    text(res, "nothing", 404);
  });
  const site = await plainSite();
  const env = { ...process.env, TIRESIAS_SAFE_BROWSING: "1", TIRESIAS_SAFETY_LIST_URL: list.url + "/list.txt" };
  const c = spawn(process.execPath, [CLI, "mcp"], { env });
  const exited = new Promise<{ code: number | null; t: number }>((r) => c.on("exit", (code) => r({ code, t: Date.now() })));
  const send = (m: unknown) => c.stdin.write(JSON.stringify(m) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sig-test", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read", arguments: { url: site.url + "/p" } } });
  while (list.count("/list.txt") === 0) await sleep(50); // the shared download is out, holding its site's lease
  const active = () => (fs.existsSync(path.join(home(), "hosts")) ? fs.readdirSync(path.join(home(), "hosts")).filter((n) => n.endsWith(".active")) : []);
  assert.equal(active().length, 1, "the download holds a lease");
  const t0 = Date.now();
  c.kill("SIGTERM");
  const e = await exited;
  assert.equal(e.code, 143);
  assert.ok(e.t - t0 < 4000, `exited ${e.t - t0} ms after the signal`);
  assert.deepEqual(active(), [], "no lease left behind");
});

test("round 3 #5: the shutdown bound: a lease still registered when the bound runs out is removed before exit", async () => {
  const lifetime = await import("../lifetime.js");
  assert.equal(lifetime.SHUTDOWN_MS, 10_000);
  const mod = path.join(path.dirname(CLI), "lifetime.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-lease-"));
  const f = path.join(dir, "x.active");
  // A child registers a lease whose work never ends, then shuts down; with a short bound for the test.
  const script = `import fs from "node:fs"; const l = await import(${JSON.stringify(mod)}); fs.writeFileSync(${JSON.stringify(f)}, "{}"); l.holdLease(${JSON.stringify(f)}); l.work(new Promise(() => {})); setInterval(() => {}, 1000); l.shutdown(143);`;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 143, r.stderr);
  assert.ok(Date.now() - t0 >= 9_000 && Date.now() - t0 < 15_000, `exited after ${Date.now() - t0} ms (the 10 s bound)`);
  assert.equal(fs.existsSync(f), false, "the leftover lease was removed");
});

test("round 3 #5: every lease joins the process-wide list while held, however it was taken", async () => {
  quickHome();
  const hosts = await import("../hosts.js");
  const lifetime = await import("../lifetime.js");
  const before = lifetime.leaseCount();
  const release = await hosts.acquireActive("https://lease-list.example", new AbortController().signal);
  assert.equal(lifetime.leaseCount(), before + 1);
  release();
  assert.equal(lifetime.leaseCount(), before);
});

// ---- Codex round 4 ----

test("round 4 #1: requests leave no listener behind on the process-wide shutdown signal", async () => {
  quickHome();
  writeConfig({ doors: "wait" });
  const { getEventListeners } = (await import("node:events")).default as unknown as { getEventListeners: (t: EventTarget, n: string) => unknown[] };
  const lifetime = await import("../lifetime.js");
  const { s } = await doorSite({ "/gone": (_q, res) => text(res, "gone", 404) });
  await engine.read(s.url + "/p", {}, ctx); // warm up: robots.txt and the door answers are cached
  const base = getEventListeners(lifetime.shutdownSignal, "abort").length;
  await engine.read(s.url + "/p", { fresh: true }, ctx);
  await engine.read(s.url + "/gone", {}, ctx);
  await engine.read(s.url + "/p", {}, { ...ctx, private: true });
  const ctl = new AbortController();
  const cancelled = engine.read(s.url + "/p", { fresh: true }, { ...ctx, signal: ctl.signal });
  ctl.abort();
  await cancelled;
  assert.equal(getEventListeners(lifetime.shutdownSignal, "abort").length, base);
});

test("round 4 #2: a shutdown with only a lease left yields to the event loop and exits as soon as the lease is given back", () => {
  const mod = path.join(path.dirname(CLI), "lifetime.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-lease-"));
  const f = path.join(dir, "y.active");
  const script = `import fs from "node:fs"; const l = await import(${JSON.stringify(mod)}); fs.writeFileSync(${JSON.stringify(f)}, "{}"); const forget = l.holdLease(${JSON.stringify(f)}); setTimeout(() => { fs.rmSync(${JSON.stringify(f)}); forget(); }, 200); l.shutdown(143);`;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 143, r.stderr);
  assert.ok(Date.now() - t0 < 3000, `exited after ${Date.now() - t0} ms, not at the 10 s bound`);
});

test("round 4 #4: one background job and one discovery answer per site, whatever its spelling", async () => {
  quickHome();
  const { writeJson, cachePath } = await import("../store.js");
  const doorsMod = await import("../doors.js");
  writeJson(cachePath("doors:https://spelled.example"), { v: doorsMod.DOORS_VERSION, origin: "https://spelled.example", probed_at: Date.now(), sitemaps: [] });
  assert.ok(doorsMod.cachedDoors("https://spelled.example."), "the dotted spelling finds the same answer");
  const before = background.backgroundCount();
  assert.equal(background.startDoorProbe("https://dup-job.example."), true);
  assert.equal(background.startDoorProbe("https://dup-job.example"), true);
  assert.equal(background.backgroundCount(), before + 1, "one job for both spellings");
  await background.abandonBackground();
});

// ---- Codex round 5 ----

test("round 5 #1: the CLI's normal end waits for every registered piece of work, a shared Safe Browsing download included", async () => {
  quickHome();
  // The shared list download registers as process work.
  const list = await start((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    setTimeout(() => text(res, "phish.example\n"), 800);
  });
  const savedSb = process.env.TIRESIAS_SAFE_BROWSING;
  const savedUrl = process.env.TIRESIAS_SAFETY_LIST_URL;
  process.env.TIRESIAS_SAFE_BROWSING = "1";
  process.env.TIRESIAS_SAFETY_LIST_URL = list.url + "/list.txt";
  try {
    const lifetime = await import("../lifetime.js");
    const sb = await import("../safebrowsing.js");
    const before = lifetime.workCount();
    const p = sb.ensureList(true);
    assert.equal(lifetime.workCount(), before + 1, "the download is registered");
    await p;
    assert.equal(lifetime.workCount(), before);
  } finally {
    process.env.TIRESIAS_SAFE_BROWSING = savedSb;
    if (savedUrl === undefined) delete process.env.TIRESIAS_SAFETY_LIST_URL;
    else process.env.TIRESIAS_SAFETY_LIST_URL = savedUrl;
  }
  // finish() waits for work holding a lease, and the lease is given back before the process ends.
  const mod = path.join(path.dirname(CLI), "lifetime.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-finish-"));
  const f = path.join(dir, "z.active");
  const script = `import fs from "node:fs"; const l = await import(${JSON.stringify(mod)}); fs.writeFileSync(${JSON.stringify(f)}, "{}"); const forget = l.holdLease(${JSON.stringify(f)}); l.work(new Promise((r) => setTimeout(() => { fs.rmSync(${JSON.stringify(f)}); forget(); r(); }, 1000))); await l.finish(5000); console.log(fs.existsSync(${JSON.stringify(f)}) ? "left" : "clean"); process.exit(0);`;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.stdout.trim(), "clean", r.stderr);
  assert.ok(Date.now() - t0 >= 900, "it waited for the work");
});

test("round 5 #2: a background job has time for six door checks at the largest spacing Tiresias keeps", () => {
  assert.ok(background.JOB_MS >= 60_000 + 6 * sites.MAX_SPACING_S * 1000, `JOB_MS ${background.JOB_MS}`);
});

test("round 5 #1: the CLI's last step (drainForExit) waits for work that is not a door check", () => {
  const lmod = path.join(path.dirname(CLI), "lifetime.js");
  const bmod = path.join(path.dirname(CLI), "background.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-drain-"));
  const f = path.join(dir, "w.active");
  const script = `import fs from "node:fs"; const l = await import(${JSON.stringify(lmod)}); const b = await import(${JSON.stringify(bmod)}); fs.writeFileSync(${JSON.stringify(f)}, "{}"); const forget = l.holdLease(${JSON.stringify(f)}); l.work(new Promise((r) => setTimeout(() => { fs.rmSync(${JSON.stringify(f)}); forget(); r(); }, 800))); await b.drainForExit(); console.log(fs.existsSync(${JSON.stringify(f)}) ? "left" : "clean"); process.exit(0);`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 20_000, env: process.env });
  assert.equal(r.stdout.trim(), "clean", r.stderr);
});

// ---- Codex round 6 ----

test("round 6 #1: a form's never_visit target is refused before Safe Browsing or DNS sees it", async () => {
  quickHome();
  const list = await start((req, res) => (req.url === "/list.txt" ? text(res, "blocked-target.example\n") : text(res, "", 404)));
  const page = await start((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    html(res, `<html><body><form method="post" action="https://blocked-target.example/submit"><input name="q" value=""><button>Go</button></form></body></html>`);
  });
  const saved = { sb: process.env.TIRESIAS_SAFE_BROWSING, url: process.env.TIRESIAS_SAFETY_LIST_URL };
  process.env.TIRESIAS_SAFE_BROWSING = "1";
  process.env.TIRESIAS_SAFETY_LIST_URL = list.url + "/list.txt";
  try {
    writeConfig({ doors: "wait", sites: { "blocked-target.example": { never_visit: true } } });
    const pv = await engine.formPreview(page.url + "/f", 1, { q: "x" }, ctx);
    assert.equal(pv.status, "ok", pv.message);
    const r = await engine.formSubmit(page.url + "/f", 1, { q: "x" }, pv.form!.preview_hash!, ctx);
    assert.equal(r.status, "refused", r.message);
    assert.deepEqual(r.site_settings, ["never_visit"], "the owner's setting, not the phishing list, stopped it");
    assert.equal(r.flag, undefined, "Safe Browsing never looked at the target");
  } finally {
    process.env.TIRESIAS_SAFE_BROWSING = saved.sb;
    if (saved.url === undefined) delete process.env.TIRESIAS_SAFETY_LIST_URL;
    else process.env.TIRESIAS_SAFETY_LIST_URL = saved.url;
  }
});

test("round 6 #2 (decision after round 8): the Web Risk endpoint obeys never_visit at send time; a site spacing does not apply to it", async () => {
  quickHome();
  const hits: number[] = [];
  const ep = await startV6((_q, res) => {
    hits.push(Date.now());
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const saved = process.env.TIRESIAS_WEB_RISK_ENDPOINT;
  process.env.TIRESIAS_WEB_RISK_ENDPOINT = ep.url + "/v1/uris:search";
  try {
    const sb = await import("../safebrowsing.js");
    writeConfig({ sites: { "[::1]": { never_visit: true } } });
    await assert.rejects(sb.webRiskForTest("https://a.example/", "secret-key", true, AbortSignal.timeout(5000)), (e: Error) => e instanceof sites.SiteRefused);
    assert.equal(hits.length, 0, "nothing sent to the endpoint");
    // An API call, not a visit: a spacing set for the endpoint's host is not waited for.
    writeConfig({ sites: { "[::1]": { spacing_seconds: 5 } } });
    const t0 = Date.now();
    await sb.webRiskForTest("https://b.example/", "secret-key", true, AbortSignal.timeout(5000));
    await sb.webRiskForTest("https://c.example/", "secret-key", true, AbortSignal.timeout(5000));
    assert.equal(hits.length, 2);
    assert.ok(Date.now() - t0 < 2000, `two lookups took ${Date.now() - t0} ms`);
  } finally {
    if (saved === undefined) delete process.env.TIRESIAS_WEB_RISK_ENDPOINT;
    else process.env.TIRESIAS_WEB_RISK_ENDPOINT = saved;
  }
});

test("round 6 #3: Ctrl-C during a foreground CLI read runs the cleanup: no lease left, exit 130", async () => {
  quickHome();
  const s = await start((req, res) => {
    if (req.url !== "/slow") return text(res, "", 404);
    setTimeout(() => html(res, "<html><body><p>late</p></body></html>"), 6000);
  });
  writeConfig({ doors: "wait" });
  const c = spawn(process.execPath, [CLI, "read", s.url + "/slow"], { env: process.env });
  const t0 = Date.now();
  const exited = new Promise<number | null>((r) => c.on("exit", (code) => r(code)));
  while (s.count("/slow") === 0) await sleep(50);
  c.kill("SIGINT");
  assert.equal(await exited, 130);
  assert.ok(Date.now() - t0 < 5000, `exited after ${Date.now() - t0} ms, before the page came`);
  const active = fs.readdirSync(path.join(home(), "hosts")).filter((n) => n.endsWith(".active"));
  assert.deepEqual(active, [], "no lease left behind");
});

test("round 6 #4: a trailing-dot URL finds the markdown twin in the site's door answers", async () => {
  const { pickSource } = await import("../pipeline.js");
  const od = { origin: "https://example.com", probed_at: Date.now(), sitemaps: [], llms_md: ["https://example.com/guide.md"] };
  assert.deepEqual(pickSource(new URL("https://example.com./guide"), od), { source: "https://example.com/guide.md", detail: "markdown" });
});

// ---- Codex round 7 ----

test("round 7 #1: a slow Safe Browsing check is a policy wait: it does not count against the site's request timer", async () => {
  quickHome();
  const s = await plainSite();
  const { withSignal, safeFetch } = await import("../safety.js");
  const slowGate = async () => void (await sleep(1200));
  const res = await withSignal(AbortSignal.timeout(30_000), () => safeFetch(s.url + "/p", { timeoutMs: 800 }), { requests: 0, signed: 0 }, slowGate);
  assert.equal(res.status, 200);
});

test("round 7 #2: a live holder's lease is not taken for its age, and a lease that is no longer ours is never deleted by us", async () => {
  quickHome();
  const hosts = await import("../hosts.js");
  const origin = "https://lease-age.example";
  const release = await hosts.acquireActive(origin, new AbortController().signal);
  const f = fs.readdirSync(path.join(home(), "hosts")).find((n) => n.endsWith(".active"))!;
  const file = path.join(home(), "hosts", f);
  const old = new Date(Date.now() - 10 * 60_000); // older than any age rule: a live holder's lease is never taken
  fs.utimesSync(file, old, old);
  const mod = path.join(path.dirname(CLI), "hosts.js");
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", `const h = await import(${JSON.stringify(mod)}); try { await h.acquireActive(${JSON.stringify(origin)}, AbortSignal.timeout(1000)); console.log("took it"); } catch { console.log("waited"); } process.exit(0);`], { env: process.env, encoding: "utf8" });
  assert.equal(out.stdout.trim(), "waited", out.stderr);
  // Someone else's lease now sits at the name: our release leaves it alone.
  fs.writeFileSync(file, JSON.stringify({ v: 1, pid: process.pid, time: Date.now(), token: "someone-else" }));
  release();
  assert.ok(fs.existsSync(file), "not ours: not removed");
  fs.rmSync(file);
});

test("round 7 #2: the shutdown cleanup removes a lease only through its owner check, never by its name alone", () => {
  const mod = path.join(path.dirname(CLI), "lifetime.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-lease-"));
  const f = path.join(dir, "taken.active");
  // The lease at the name now belongs to someone else: its owner check says "not ours" (does nothing).
  const script = `import fs from "node:fs"; const l = await import(${JSON.stringify(mod)}); fs.writeFileSync(${JSON.stringify(f)}, "{}"); l.holdLease(${JSON.stringify(f)}, () => {}); l.work(new Promise(() => {})); setInterval(() => {}, 1000); l.shutdown(143);`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 143, r.stderr);
  assert.ok(fs.existsSync(f), "someone else's lease is left alone");
});

// ---- Codex round 8 (the coordinator's decisions) ----

test("round 8 #2: past the drain bound with no signal, the CLI's last step cancels the leftover work and returns (the command's own exit code)", () => {
  const lmod = path.join(path.dirname(CLI), "lifetime.js");
  const bmod = path.join(path.dirname(CLI), "background.js");
  const script = `const l = await import(${JSON.stringify(lmod)}); const b = await import(${JSON.stringify(bmod)}); l.work(new Promise(() => {})); await b.drainForExit(300); process.exit(7);`;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 7, `exit ${r.status} ${r.signal} ${r.stderr}`);
  assert.ok(Date.now() - t0 < 15_000);
});

test("round 8 #3: a wait for a live process's lease gives up with a message that names the residual and the file to delete", async () => {
  quickHome();
  const hosts = await import("../hosts.js");
  const origin = "https://lease-busy.example";
  const release = await hosts.acquireActive(origin, new AbortController().signal);
  const f = fs.readdirSync(path.join(home(), "hosts")).find((n) => n.endsWith(".active"))!;
  const file = path.join(home(), "hosts", f);
  const mod = path.join(path.dirname(CLI), "hosts.js");
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", `const h = await import(${JSON.stringify(mod)}); try { await h.acquireActive(${JSON.stringify(origin)}, AbortSignal.timeout(20000)); console.log("took it"); } catch (e) { console.log(e.message); } process.exit(0);`], { env: { ...process.env, TIRESIAS_LEASE_WAIT_MS: "400" }, encoding: "utf8" });
  assert.match(out.stdout, new RegExp(`process ${process.pid}\\)`));
  assert.match(out.stdout, /another program has reused the number: the site stays blocked until that program ends or the daily cleanup clears the lease file/);
  assert.ok(out.stdout.includes(JSON.stringify(file)), out.stdout);
  release();
});

// ---- Codex round 9 ----

test("round 9 #1: spacing counts from when the answer was read, so a slow request never eats the next one's spacing", async () => {
  politeHome();
  const times: Record<string, number> = {};
  const s = await start((req, res) => {
    times[req.url ?? ""] = Date.now();
    if (req.url === "/robots.txt") return text(res, "", 404);
    if (req.url === "/slow") return void setTimeout(() => ((times.slowDone = Date.now()), html(res, "<html><body><p>slow</p></body></html>")), 1200);
    html(res, "<html><body><p>next</p></body></html>");
  });
  const fetcher = await import("../fetcher.js");
  const { withSignal } = await import("../safety.js");
  await withSignal(AbortSignal.timeout(30_000), async () => {
    await fetcher.politeFetch(s.url + "/slow");
    await fetcher.politeFetch(s.url + "/next");
  });
  assert.ok(times["/next"] - times.slowDone >= 950, `the next request came ${times["/next"] - times.slowDone} ms after the slow answer`);
});

test("round 9 #3: lease recovery takes an owned guard that is never broken; a held guard stops recovery", async () => {
  quickHome();
  const hosts = await import("../hosts.js");
  const origin = "https://lease-guard.example";
  // A stale lease (its process is gone) and a recovery guard held by a live process (this one).
  const release = await hosts.acquireActive(origin, new AbortController().signal);
  const f = fs.readdirSync(path.join(home(), "hosts")).find((n) => n.endsWith(".active"))!;
  const file = path.join(home(), "hosts", f);
  release();
  const dead = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
  fs.writeFileSync(file, JSON.stringify({ v: 1, pid: Number(dead.stdout.trim()), time: Date.now(), token: "gone" }));
  fs.writeFileSync(file + ".lock", JSON.stringify({ pid: process.pid, token: "recovering" }));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file + ".lock", old, old); // older than lockfile.ts's 5-second rule
  const mod = path.join(path.dirname(CLI), "hosts.js");
  const run = () => spawnSync(process.execPath, ["--input-type=module", "-e", `const h = await import(${JSON.stringify(mod)}); try { const r = await h.acquireActive(${JSON.stringify(origin)}, AbortSignal.timeout(20000)); r(); console.log("took it"); } catch (e) { console.log("gave up: " + e.message); } process.exit(0);`], { env: { ...process.env, TIRESIAS_LEASE_WAIT_MS: "400" }, encoding: "utf8" }).stdout;
  const out = run();
  assert.match(out, /^gave up/, out);
  assert.ok(out.includes(JSON.stringify(file + ".lock")), "the message names the guard file too");
  assert.ok(fs.existsSync(file + ".lock"), "a live process's guard is never broken");
  fs.rmSync(file + ".lock");
  assert.equal(run().trim(), "took it", "with no guard held, the stale lease is recovered");
});

test("round 9 #4 and round 10 #2: the daily sweep keeps live leases, never removes a recovery guard, and removes stale leases", async () => {
  quickHome();
  const hosts = await import("../hosts.js");
  const dir = path.join(home(), "hosts");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dead = Number(spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout.trim());
  const files: Record<string, unknown> = {
    "live.active": { v: 1, pid: process.pid, token: "a" },
    "live2.active": { v: 1, pid: process.pid, token: "a2" }, // no guard beside it
    "dead.active": { v: 1, pid: dead, token: "b" },
    "live.active.lock": { pid: process.pid, token: "c" },
    "dead.active.lock": { pid: dead, token: "d" },
    "dead2.active": { v: 1, pid: dead, token: "e" }, // stale, no guard beside it
    "spacing-file": { v: 1, last: 0, next: 0 },
  };
  const old = new Date(Date.now() - 2 * 86_400_000);
  for (const [n, v] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, n), JSON.stringify(v));
    fs.utimesSync(path.join(dir, n), old, old);
  }
  hosts.sweepHosts();
  // Round 10: a guard is never swept (its lease stays until a person deletes the guard); a stale lease with no guard goes.
  assert.deepEqual(fs.readdirSync(dir).sort(), ["dead.active", "dead.active.lock", "live.active", "live.active.lock", "live2.active"]);
});

test("round 9 #1: the completion time moves this process's clock (private calls too) and the shared file (other processes)", async () => {
  politeHome();
  const times: Record<string, number> = {};
  const s = await start((req, res) => {
    times[req.url ?? ""] = Date.now();
    if (req.url === "/robots.txt") return text(res, "", 404);
    if (req.url?.startsWith("/slow")) return void setTimeout(() => ((times[req.url + ":done"] = Date.now()), html(res, "<html><body><p>slow</p></body></html>")), 1200);
    html(res, "<html><body><p>next</p></body></html>");
  });
  const fetcher = await import("../fetcher.js");
  const { withSignal } = await import("../safety.js");
  const { runPrivate } = await import("../store.js");
  // Private: no shared file is written, so only this process's own clock can hold the spacing.
  await runPrivate(() => withSignal(AbortSignal.timeout(30_000), async () => {
    await fetcher.politeFetch(s.url + "/slow1");
    await fetcher.politeFetch(s.url + "/next1");
  }));
  assert.ok(times["/next1"] - times["/slow1:done"] >= 950, `private: ${times["/next1"] - times["/slow1:done"]} ms`);
  // Another process: only the shared file can tell it.
  await withSignal(AbortSignal.timeout(30_000), () => fetcher.politeFetch(s.url + "/slow2"));
  const mod = path.join(path.dirname(CLI), "fetcher.js");
  const smod = path.join(path.dirname(CLI), "safety.js");
  // The other process asks for its turn on the same site; when it is let through is what counts.
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `const f = await import(${JSON.stringify(mod)}); await f.throttle(${JSON.stringify(s.url)}, 1, new AbortController().signal, ${JSON.stringify(s.url + "/next2")}); console.log(Date.now()); process.exit(0);`], { env: { ...process.env, TIRESIAS_HOST_SPACING_MS: "" }, encoding: "utf8" });
  void smod;
  const at = Number(child.stdout.trim());
  assert.ok(at - times["/slow2:done"] >= 950, `other process: let through ${at - times["/slow2:done"]} ms after the slow answer (${child.stderr.slice(0, 300)})`);
});

// ---- Codex round 10 ----

test("round 10 #1: a late completion moves this process's clock by the full delay, a Crawl-delay learned meanwhile included", async () => {
  quickHome();
  const fetcher = await import("../fetcher.js");
  const queue = await import("../queue.js");
  const { runPrivate } = await import("../store.js");
  const sig = new AbortController().signal;
  await runPrivate(async () => {
    const rel = await fetcher.throttle("https://late-a.example", 3, sig, "https://late-a.example/x", true);
    await sleep(1200);
    rel();
    const t0 = Date.now();
    await fetcher.throttle("https://late-a.example", 1, sig, "https://late-a.example/y");
    assert.ok(Date.now() - t0 >= 2900, `a 3 s delay counted from completion: waited ${Date.now() - t0} ms`);
    const rel2 = await fetcher.throttle("https://late-b.example", 1, sig, "https://late-b.example/robots.txt", true);
    queue.noteDelay("https://late-b.example", 3);
    await sleep(300);
    rel2();
    const t1 = Date.now();
    await fetcher.throttle("https://late-b.example", 1, sig, "https://late-b.example/z");
    assert.ok(Date.now() - t1 >= 2900, `a Crawl-delay learned while held counts from completion: waited ${Date.now() - t1} ms`);
  });
});

test("round 10 #3: lease metadata is read with bounds: no FIFO, no link, nothing large", async () => {
  quickHome();
  const hosts = await import("../hosts.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-meta-"));
  const ok = path.join(dir, "ok.active");
  fs.writeFileSync(ok, JSON.stringify({ pid: 4242, token: "t" }));
  assert.deepEqual(hosts.readLeaseMeta(ok), { pid: 4242, token: "t" });
  const big = path.join(dir, "big.active");
  fs.writeFileSync(big, JSON.stringify({ pid: 1, token: "x".repeat(1_000_000) }));
  assert.equal(hosts.readLeaseMeta(big), undefined);
  const link = path.join(dir, "link.active");
  fs.symlinkSync(ok, link);
  assert.equal(hosts.readLeaseMeta(link), undefined);
  const fifo = path.join(dir, "fifo.active");
  spawnSync("mkfifo", [fifo]);
  const t0 = Date.now();
  assert.equal(hosts.readLeaseMeta(fifo), undefined);
  assert.ok(Date.now() - t0 < 500, "a FIFO never blocks");
});

// ---- Codex round 11 (the coordinator's decisions) ----

test("round 11 #3/#4: a call keeps the settings it started with; a change applies to calls that start after it", async () => {
  quickHome();
  // A page read whose request waits its turn (Crawl-delay 2) while the owner sets never_visit.
  const { s, times } = await doorSite({}, "User-agent: *\nCrawl-delay: 2\n");
  writeConfig({ doors: "wait" });
  const pending = engine.read(s.url + "/p", {}, ctx);
  while (!times.length) await sleep(20);
  writeConfig({ doors: "wait", sites: { "127.0.0.1": { never_visit: true } } });
  const r = await pending;
  assert.equal(r.status, "ok", r.message);
  assert.equal(r.site_settings, undefined, "the running call finished under the settings it started with");
  assert.equal(s.count("/p"), 1);
  const next = await engine.read(s.url + "/p", { fresh: true }, ctx);
  assert.equal(next.status, "refused");
  assert.deepEqual(next.site_settings, ["never_visit"]);
  // A cached copy: hand_off set during the call is not applied to it; the next call is handed off.
  let robotsDelay = 0;
  const c = await start((req, res) => {
    if (req.url === "/robots.txt") return void setTimeout(() => text(res, "", 404, { "cache-control": "no-store" }), robotsDelay);
    html(res, "<html><body><p>cached page</p></body></html>", { "cache-control": "max-age=600" });
  });
  writeConfig({ doors: "wait" });
  assert.equal((await engine.read(c.url + "/p", {}, ctx)).status, "ok");
  robotsDelay = 800;
  const p2 = engine.read(c.url + "/p", {}, { agent: "another" });
  await sleep(300);
  writeConfig({ doors: "wait", sites: { "127.0.0.1": { hand_off: true } } });
  assert.equal((await p2).cache, "fresh", "served under the starting settings");
  const after = await engine.read(c.url + "/p", {}, { agent: "another" });
  assert.equal(after.handoff?.reason, "owner_hand_off");
  // Ports: the snapshot decides, not the file as it is now.
  const saved = process.env.TIRESIAS_ALLOW_PRIVATE;
  delete process.env.TIRESIAS_ALLOW_PRIVATE;
  try {
    const { assertPort } = await import("../safety.js");
    writeConfig({});
    const snap = sites.parseSites({ "example.com": { ports: "9443" } });
    callContext.run({ sites: snap }, () => assert.doesNotThrow(() => assertPort(new URL("https://example.com:9443/"))));
    assert.throws(() => assertPort(new URL("https://example.com:9443/")), /port_blocked/);
  } finally {
    process.env.TIRESIAS_ALLOW_PRIVATE = saved;
  }
});

test("round 11 #3/#4: settings set and reset say a change applies to new requests", () => {
  quickHome();
  let r = cli(["settings", "set", "doors", "wait"]);
  assert.match(r.json.message, /Applies to new requests; requests already running finish under the settings they started with\./);
  r = cli(["settings", "set", "never_visit", "x.example", "on"]);
  assert.match(r.json.message, /Applies to new requests/);
  r = cli(["settings", "reset", "doors"]);
  assert.match(r.json.message, /Applies to new requests/);
});

test("round 11 #1: a completion is recorded whole, so another process needing a larger spacing measures from it", async () => {
  politeHome();
  const times: Record<string, number> = {};
  const s = await start((req, res) => {
    times[req.url ?? ""] = Date.now();
    if (req.url === "/robots.txt") return text(res, "", 404);
    setTimeout(() => ((times.done = Date.now()), html(res, "<html><body><p>slow</p></body></html>")), 1500);
  });
  const fetcher = await import("../fetcher.js");
  const { withSignal } = await import("../safety.js");
  await withSignal(AbortSignal.timeout(30_000), () => fetcher.politeFetch(s.url + "/slow"));
  const mod = path.join(path.dirname(CLI), "fetcher.js");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `const f = await import(${JSON.stringify(mod)}); await f.throttle(${JSON.stringify(s.url)}, 3, new AbortController().signal, ${JSON.stringify(s.url + "/next")}); console.log(Date.now()); process.exit(0);`], { env: { ...process.env, TIRESIAS_HOST_SPACING_MS: "" }, encoding: "utf8" });
  const at = Number(child.stdout.trim());
  assert.ok(at - times.done >= 2900, `a 3 s spacing in another process counted from the completion: ${at - times.done} ms (${child.stderr.slice(0, 200)})`);
});

test("round 11 #2: the per-site delay map is pruned with the clocks", async () => {
  quickHome();
  const fetcher = await import("../fetcher.js");
  const realNow = Date.now;
  Date.now = () => realNow() - 5 * 60_000; // these sites were last called five minutes ago
  try {
    for (let i = 0; i < 1100; i++) await fetcher.throttle(`https://prune-${i}.example`, 0, new AbortController().signal, "x");
  } finally {
    Date.now = realNow;
  }
  await fetcher.throttle("https://prune-now.example", 0, new AbortController().signal, "x");
  assert.ok(fetcher.mapSizes().delayOf < 1000, `delayOf: ${fetcher.mapSizes().delayOf}`);
});

test("sweep: settings lists the inspect cap's default and environment override", () => {
  quickHome();
  for (const cap of [undefined, "12345"]) {
    const r = cli(["settings"], { TIRESIAS_MAX_INSPECT_BYTES: cap });
    assert.equal(r.code, 0, r.err);
    const row = r.json.environment.find((x: { name: string }) => x.name === "TIRESIAS_MAX_INSPECT_BYTES");
    assert.ok(row);
    assert.equal(row.default, String(20 * 1024 * 1024));
    assert.equal(row.value, cap ?? row.default);
    assert.equal(row.is_set, cap !== undefined);
    assert.equal(row.stored, "environment variable");
    assert.match(row.description, /inspect|look inside/i);
  }
  const t = cli(["settings", "--text"], { TIRESIAS_MAX_INSPECT_BYTES: "12345" });
  assert.match(t.out, /TIRESIAS_MAX_INSPECT_BYTES = 12345/);
});
