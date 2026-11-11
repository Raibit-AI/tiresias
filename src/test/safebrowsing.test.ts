// SPDX-License-Identifier: Apache-2.0
// v0.3 W-19: the Safe Browsing check. No real network: the list and Web Risk are local test servers.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { freshHome, neverAsk, html, logText, serve, text, type TestServer, timing } from "./helper.js";

// The owner's real key file is under the real home folder. Point HOME somewhere empty so no test
// can ever read it (the default key file is ~/.config/tiresias/secrets.env).
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-sb-home-"));
process.env.HOME = FAKE_HOME;
freshHome();
process.env.TIRESIAS_SAFE_BROWSING = "1";
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
delete process.env.TIRESIAS_PRIVATE;
delete process.env.TIRESIAS_WEB_RISK_KEY;
delete process.env.TIRESIAS_WEB_RISK_ENDPOINT;
// Test names: IP literals and localhost are never sent to Web Risk (W-19), so Web Risk tests use names
// under sb.example, answered here (127.0.0.1 unless FAKE_DNS says otherwise) without any real DNS query.
const dnsp = (await import("node:dns/promises")).default as any;
const realLookup = dnsp.lookup;
const FAKE_DNS: Record<string, string> = {};
const LOOKUPS: string[] = [];
dnsp.lookup = (name: string, opts: unknown) => {
  LOOKUPS.push(name);
  if (name.startsWith("stall.")) return new Promise(() => {}); // a resolver that never answers
  return FAKE_DNS[name] !== undefined || name.endsWith(".sb.example") ? Promise.resolve([{ address: FAKE_DNS[name] ?? "127.0.0.1", family: 4 }]) : realLookup(name, opts);
};
// Every fetch() in this process (Web Risk is the only user) is watched: anything not to this machine is
// recorded and answered locally, so no test (or a mutation run) can reach the network.
const realFetch = globalThis.fetch;
const OFFBOX: string[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
  const u = new URL(String(input));
  if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) {
    OFFBOX.push(u.href);
    return new Response("", { status: 503 });
  }
  return realFetch(input, init);
}) as typeof fetch;
const named = (s: TestServer, host = "shop.sb.example") => s.url.replace("127.0.0.1", host);
const engine = await import("../engine.js");
const store = await import("../store.js");
const sb = await import("../safebrowsing.js");
const { normalizeList, indexList, lookup, candidates } = await import("../safelist.js");
const { Flagged, SafeBrowsingError } = await import("../errors.js");
const { createServer } = await import("../mcp.js");
const { withSignal } = await import("../safety.js");

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const KEY = "TESTKEY-abcdefghij_SECRET123";
const servers: TestServer[] = [];
const start = async (h: Parameters<typeof serve>[0]) => {
  const s = await serve(h);
  servers.push(s);
  return s;
};
after(async () => {
  for (const s of servers) await s.close();
  (await import("../sandbox.js")).stopWorker();
});
const trusted = (e: any) => JSON.stringify({ ...e, untrusted_content: null });
const PAGE = "<html><head><title>Anvils</title></head><body><h1>Anvils</h1><p>Heavy iron anvils for sale.</p></body></html>";

// The list host. `body` is served with an ETag that changes with it; a matching If-None-Match gets 304.
const list = { body: "evil.example\n", status: 200, etag: "", hangMs: 0 };
const listServer = await start((req, res) => {
  if (req.url === "/robots.txt") return text(res, "", 404);
  if (req.url !== "/list.txt") return text(res, "", 404);
  if (list.status !== 200) return text(res, "down", list.status);
  const etag = `"${Buffer.from(list.body).length}-${list.etag}"`;
  const answer = () => {
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { etag });
      return void res.end();
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", etag });
    res.end(list.body);
  };
  if (list.hangMs) setTimeout(answer, list.hangMs).unref(); // a slow list host
  else answer();
});
process.env.TIRESIAS_SAFETY_LIST_URL = listServer.url + "/list.txt";
const listHits = () => listServer.count("/list.txt");

// A fake Web Risk endpoint: any uri containing "malware" is a hit; "/down" answers 500.
const wr = { mode: "normal" as "normal" | "down" | "hang", expireMs: 600_000, queries: [] as URLSearchParams[] };
const wrServer = await start((req, res) => {
  const q = new URL(req.url ?? "/", "http://x").searchParams;
  wr.queries.push(q);
  if (wr.mode === "down") return text(res, "no", 500);
  if (wr.mode === "hang") return; // never answers
  res.writeHead(200, { "content-type": "application/json" });
  const uri = q.get("uri") ?? "";
  res.end(uri.includes("malware") ? JSON.stringify({ threat: { threatTypes: ["MALWARE", "BOGUS_TYPE"], expireTime: new Date(Date.now() + wr.expireMs).toISOString() } }) : "{}");
});
const WR_ENDPOINT = wrServer.url + "/v1/uris:search";

// A site. Its hits show whether anything at all was sent to it (robots.txt included).
async function site(extra: Record<string, string> = {}) {
  return start((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    if (req.url === "/llms.txt") return text(res, "", 404);
    if (req.url?.startsWith("/go")) {
      res.writeHead(302, { location: extra.location ?? "/" });
      return void res.end();
    }
    if (req.url?.startsWith("/fresh")) return html(res, PAGE, { "cache-control": "max-age=600" });
    html(res, PAGE);
  });
}

async function setList(lines: string[]) {
  list.body = lines.join("\n") + "\n";
  list.status = 200;
  list.etag = String(Math.random());
  const r = await engine.safetyUpdate();
  assert.equal(r.status, "ok", r.message);
}
// A store with its own list (and no Web Risk unless asked).
async function fresh(lines: string[] = ["evil.example"]) {
  const home = freshHome();
  sb.clearWebRiskCache();
  delete process.env.TIRESIAS_WEB_RISK_ENDPOINT;
  wr.mode = "normal";
  wr.queries = [];
  await setList(lines);
  return home;
}
const listFile = () => path.join(store.homeDir(), "safety", "phishing-domains.txt");
// Pretend the list was last confirmed `hours` ago (rewrites only the header line).
function ageList(hours: number) {
  const f = listFile();
  const buf = fs.readFileSync(f);
  const nl = buf.indexOf(10);
  const h = JSON.parse(buf.subarray(0, nl).toString());
  h.verified_at = new Date(Date.now() - hours * 3_600_000).toISOString();
  fs.writeFileSync(f, Buffer.concat([Buffer.from(JSON.stringify(h)), buf.subarray(nl)]));
}
function useKey(mode = 0o600, key = KEY) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-key-")), "secrets.env");
  fs.writeFileSync(f, `# owner secrets\nOTHER=1\nWEB_RISK_API_KEY=${key}\n`, { mode });
  fs.chmodSync(f, mode);
  fs.writeFileSync(path.join(store.homeDir(), "config.json"), JSON.stringify({ web_risk_key_file: f }));
  process.env.TIRESIAS_WEB_RISK_ENDPOINT = WR_ENDPOINT;
  return f;
}
// The CLI as its own process. Asynchronous, because the test servers live in this process.
function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { env });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}
const readHistory = () => logText(store.homeDir(), "history").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// ---- the list itself ----

test("W-19: the list is normalized (case, IDN to punycode, sorted, unique) and junk lines are counted, not guessed", () => {
  const n = normalizeList("# comment\nEvil.Example\nevil.example.\nbücher-phish.example\n\n%20mandrillapp.com\nuser@host.example\na.b/c\ncom\n  spaced.example  \r\n");
  assert.equal(n.text, "evil.example\nspaced.example\nxn--bcher-phish-thb.example\n");
  assert.equal(n.entries, 3);
  assert.equal(n.rejected, 4); // %20..., user@..., a.b/c, and the single label "com"
});

test("W-19: lookup matches the host and each parent domain, never a bare top-level domain or a lookalike", () => {
  const ix = indexList(Buffer.from(normalizeList("example.com\nphish.co.uk\n1.2.3.4\n").text))!;
  assert.ok(lookup(ix, "example.com"));
  assert.ok(lookup(ix, "a.b.example.com"));
  assert.ok(lookup(ix, "login.phish.co.uk"));
  assert.ok(lookup(ix, "1.2.3.4"));
  assert.ok(!lookup(ix, "notexample.com"));
  assert.ok(!lookup(ix, "example.com.evil.net"));
  assert.ok(!lookup(ix, "com"));
  assert.ok(!lookup(ix, "11.2.3.4"));
  assert.deepEqual(candidates("a.b.example.com."), ["a.b.example.com", "b.example.com", "example.com"]);
});

test("W-19: a stored list that is unsorted, has a bad character or an empty line is refused (damaged), not trusted", () => {
  assert.ok(indexList(Buffer.from("a.com\nb.com\n")));
  assert.equal(indexList(Buffer.from("b.com\na.com\n")), null);
  assert.equal(indexList(Buffer.from("a.com\na.com\n")), null);
  assert.equal(indexList(Buffer.from("a.com\n\nb.com\n")), null);
  assert.equal(indexList(Buffer.from("A.com\n")), null);
  assert.equal(indexList(Buffer.from("a.com")), null);
});

// ---- the check in a call ----

test("W-19: a listed site is flagged BEFORE any request (not even robots.txt), with fixed text, codes and the URL inside untrusted_content", async () => {
  await fresh(["127.0.0.1"]);
  const s = await site();
  const r = await engine.read(s.url + "/page", {}, { agent: "banks" });
  assert.equal(r.status, "flagged");
  assert.deepEqual(r.flag, ["phishing_list"]);
  assert.equal(r.safety, "checked");
  assert.match(r.message!, /Phishing\.Database/);
  assert.match(r.message!, /allow_flagged/);
  assert.equal(s.hits.length, 0, "nothing was sent to the site");
  assert.equal((r.untrusted_content as any).flagged_url, s.url + "/page");
  assert.equal(r.signed, undefined, "no request was sent");
  const h = readHistory().at(-1);
  assert.equal(h.status, "flagged");
  assert.equal(h.flag, "phishing_list");
  // safety/ is a validated owner-only folder; the list is one file.
  assert.equal(fs.statSync(path.dirname(listFile())).mode & 0o777, 0o700);
  assert.equal(fs.statSync(listFile()).mode & 0o777, 0o600);
});

test("W-19: allow_flagged reads a listed site and keeps the flag; check and doors are flagged too", async () => {
  await fresh(["127.0.0.1"]);
  const s = await site();
  const r = await engine.read(s.url + "/page", {}, { agent: "banks", allow_flagged: true });
  assert.equal(r.status, "ok");
  assert.deepEqual(r.flag, ["phishing_list"]);
  assert.match(r.message!, /^Read with allow_flagged/);
  assert.ok(s.count("/page") === 1);
  assert.equal(readHistory().at(-1).flag, "phishing_list");
  assert.equal((await engine.check(s.url + "/page")).status, "flagged");
  assert.equal((await engine.doors(s.url + "/page")).status, "flagged");
  const report = await engine.needsReport("1d");
  assert.deepEqual(report.counts.flagged, { phishing_list: 2, web_risk: 0, read_anyway: 1 });
});

test("W-19: parent domains and IDN names are matched by the gate itself", async () => {
  await fresh(["evil-example.com", "bücher-phish.example"]);
  const gate = sb.makeGate({ allowFlagged: false, priv: false });
  await assert.rejects(gate.check(new URL("http://a.b.evil-example.com/x")), (e: any) => e instanceof Flagged && !e.hard);
  await assert.rejects(gate.check(new URL("http://login.BÜCHER-phish.example/")), (e: any) => e instanceof Flagged);
  await gate.check(new URL("http://good.example/"));
  await gate.check(new URL("http://evil-example.com.good.example/"));
  assert.equal(gate.code, "checked");
});

test("W-19: a redirect hop to a listed host is stopped before that request is sent", async () => {
  await fresh(["127.0.0.1"]);
  const target = await site();
  const first = await site({ location: target.url + "/landing" });
  const asked = first.url.replace("127.0.0.1", "localhost") + "/go";
  const r = await engine.read(asked);
  assert.equal(r.status, "flagged");
  assert.ok(first.count("/go") === 1, "the asked host was visited");
  assert.equal(target.hits.length, 0, "the flagged hop got nothing, not even robots.txt");
  assert.equal((r.untrusted_content as any).flagged_url, target.url + "/landing");
  assert.ok(!trusted(r).includes(target.url), "the hop URL is only inside untrusted_content");
  // doors reads the page too (for its link tags): the same hop is stopped there.
  const d = await engine.doors(asked);
  assert.equal(d.status, "flagged");
  assert.equal(target.hits.length, 0);
});

test("W-19: a copy still fresh in the shared cache is not served once its site is listed", async () => {
  await fresh(["evil.example"]);
  const s = await site();
  assert.equal((await engine.read(s.url + "/fresh", {}, { agent: "a" })).status, "ok");
  const before = s.hits.length;
  assert.equal((await engine.read(s.url + "/fresh", {}, { agent: "b" })).cache, "fresh");
  await setList(["127.0.0.1"]);
  const r = await engine.read(s.url + "/fresh", {}, { agent: "b" });
  assert.equal(r.status, "flagged");
  assert.equal(s.hits.length, before);
});

// ---- downloading the list ----

test("9.29: an uncreatable store root skips every download, reports unchecked once, and can recover", async () => {
  const parent = freshHome();
  const root = path.join(parent, "missing-store");
  process.env.TIRESIAS_HOME = root;
  delete process.env.TIRESIAS_WEB_RISK_KEY;
  const before = listHits();
  const errors: string[] = [];
  const mkdir = fs.mkdirSync;
  const error = console.error;
  // A deterministic permission failure, including when the tests run as root.
  fs.mkdirSync = ((dir: fs.PathLike, ...args: any[]) => {
    if (String(dir) === root) throw Object.assign(new Error("not writable"), { code: "EACCES" });
    return (mkdir as any)(dir, ...args);
  }) as typeof fs.mkdirSync;
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  try {
    for (let i = 0; i < 3; i++) {
      assert.equal((await sb.ensureList(i === 2)).outcome, "skipped", "automatic and forced updates skip the download");
      const gate = sb.makeGate({ priv: false, allowFlagged: false });
      await gate.check(new URL("http://127.0.0.1/example"));
      assert.equal(gate.code, "unchecked");
    }
    assert.equal(listHits(), before, "no list request was sent");
    assert.equal(fs.existsSync(root), false);
    assert.equal(errors.length, 1, errors.join("\n"));
    assert.match(errors[0], /^safety: unchecked /);
    assert.equal(errors[0].split("\n").length, 1);
  } finally {
    fs.mkdirSync = mkdir;
    console.error = error;
  }
  assert.equal((await sb.ensureList(true)).outcome, "updated", "a writable store can recover in the same process");
  assert.equal(listHits(), before + 1);
});

test("W-19: the list is downloaded at most once a day, then asked conditionally (a 304 just confirms it)", async () => {
  await fresh(["evil.example"]);
  const s = await site();
  const n = listHits();
  await engine.read(s.url + "/a");
  await engine.read(s.url + "/b");
  assert.equal(listHits(), n, "a list confirmed within a day is not asked again");
  ageList(25);
  const r = await engine.read(s.url + "/c");
  assert.equal(r.safety, "checked");
  assert.equal(listHits(), n + 1);
  const last = listServer.hits.filter((h) => h.path === "/list.txt").at(-1)!;
  assert.ok(last.headers["if-none-match"], "conditional");
  assert.match(String(last.headers["user-agent"]), /^Tiresias\//);
  const st = engine.safetyStatus();
  assert.equal(st.list.state, "current");
  assert.ok(st.list.age_hours! < 1, "the 304 confirmed it now");
});

test("W-19: list host down: the last good copy is used (list_stale) and still flags; not retried within the hour", async () => {
  await fresh(["127.0.0.1"]);
  const s = await site();
  ageList(72);
  list.status = 500;
  const n = listHits();
  const r = await engine.read(s.url + "/x");
  assert.equal(r.status, "flagged");
  assert.equal(r.safety, "list_stale");
  assert.equal(listHits(), n + 1);
  await engine.read(s.url + "/y");
  assert.equal(listHits(), n + 1, "a failed download is not retried within the hour");
  assert.equal(engine.safetyStatus().list.last_attempt?.ok, false);
});

test("W-19: a list over 7 days old, or none, is not used: unchecked, and browsing goes on", async () => {
  await fresh(["127.0.0.1"]);
  const s = await site();
  ageList(8 * 24);
  list.status = 500;
  const r = await engine.read(s.url + "/x");
  assert.equal(r.status, "ok");
  assert.equal(r.safety, "unchecked");
  freshHome();
  const r2 = await engine.read(s.url + "/x");
  assert.equal(r2.status, "ok");
  assert.equal(r2.safety, "unchecked");
  assert.equal(engine.safetyStatus().list.state, "none");
  list.status = 200;
});

test("W-19: a list over 32 MB fails loudly and the last good copy stays", async () => {
  await fresh(["evil.example"]);
  list.body = "a.example\n".repeat(3_400_000); // 34 MB
  list.etag = "big";
  const r = await engine.safetyUpdate();
  assert.equal(r.status, "error");
  assert.match(r.message, /larger than 32 MB/);
  assert.equal(r.list.entries, 1, "the last good copy is kept");
  list.body = "evil.example\n";
});

test("W-19: safe_browsing false (or TIRESIAS_SAFE_BROWSING=0) turns the check off and says so", async () => {
  const home = await fresh(["127.0.0.1"]);
  const s = await site();
  neverAsk(home); // W-32 (v0.9): safe_browsing false written by hand
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ safe_browsing: false }));
  const r = await engine.read(s.url + "/x");
  assert.equal(r.status, "ok");
  assert.equal(r.safety, "off");
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ safe_browsing: "no" }));
  const bad = await engine.read(s.url + "/x");
  assert.equal(bad.status, "error");
  assert.match(bad.message!, /safe_browsing/);
  fs.rmSync(path.join(home, "config.json"));
  process.env.TIRESIAS_SAFE_BROWSING = "0";
  try {
    assert.equal((await engine.read(s.url + "/x")).safety, "off");
  } finally {
    process.env.TIRESIAS_SAFE_BROWSING = "1";
  }
});

test("W-19: private mode creates nothing (no list download, no files) and still uses a list already on disk", async () => {
  await fresh(["evil.example"]);
  const s = await site();
  // A store that does not exist yet stays absent.
  const empty = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-priv-")), "store");
  process.env.TIRESIAS_HOME = empty;
  const n = listHits();
  const r = await engine.read(s.url + "/x", {}, { agent: "a", private: true });
  assert.equal(r.status, "ok");
  assert.equal(r.safety, "unchecked");
  assert.deepEqual(fs.readdirSync(empty), ["hosts"], "only spacing created");
  assert.equal(listHits(), n, "no download in private mode");
  // With a list on disk: it is read and used, and nothing in safety/ changes.
  await fresh(["127.0.0.1"]);
  ageList(30);
  const snap = () => fs.readdirSync(path.dirname(listFile())).map((f) => `${f}:${fs.statSync(path.join(path.dirname(listFile()), f)).mtimeMs}`).join();
  const before = snap();
  const p = await engine.read(s.url + "/x", {}, { agent: "a", private: true });
  assert.equal(p.status, "flagged");
  assert.equal(p.safety, "list_stale");
  assert.equal(snap(), before);
  const u = await engine.safetyUpdate();
  assert.equal(u.status, "ok"); // not private: allowed
});

test("W-19: clear --all and the disk cap leave safety/ alone", async () => {
  await fresh(["evil.example"]);
  const { clearStore } = await import("../cleanup.js");
  await clearStore({ all: true });
  assert.ok(fs.existsSync(listFile()));
});

// ---- Google Web Risk ----

test("W-19: a Web Risk hit is refused, cannot be overridden, and only allow-listed threat names reach the top level", async () => {
  await fresh(["evil.example"]);
  useKey();
  const s = await site();
  const r = await engine.read(named(s) + "/malware.html", {}, { agent: "a", allow_flagged: true });
  assert.equal(r.status, "refused");
  assert.deepEqual(r.flag, ["web_risk:MALWARE", "web_risk:OTHER"]);
  assert.match(r.message!, /does not override/);
  assert.equal(s.hits.length, 0);
  const q = wr.queries.at(-1)!;
  assert.equal(q.get("uri"), named(s) + "/malware.html");
  assert.deepEqual(q.getAll("threatTypes"), ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE"]);
  assert.equal(q.get("key"), KEY);
  assert.equal(readHistory().at(-1).flag, "web_risk");
  const ok = await engine.read(named(s) + "/fine");
  assert.equal(ok.status, "ok");
  assert.equal(ok.safety, "checked");
});

test("W-19: Web Risk gets every distinct URL that is requested (robots.txt and probes too), once; repeats come from the cache", async () => {
  await fresh(["evil.example"]);
  useKey();
  const s = await site();
  const before = wr.queries.length;
  await engine.read(named(s) + "/page");
  const paths = new Set(s.hits.map((h) => h.path));
  assert.ok(paths.size >= 3, "robots, probes and the page were fetched");
  assert.equal(wr.queries.length - before, paths.size, "one lookup per distinct URL");
  assert.deepEqual(new Set(wr.queries.slice(before).map((q) => new URL(q.get("uri")!).pathname)), paths);
  await engine.read(named(s) + "/page", { fresh: true }, { agent: "other" });
  assert.equal(wr.queries.length - before, paths.size, "a later call is answered from the in-memory cache");
});

test("W-19: a redirect to a flagged path on an already-checked host is stopped before that request", async () => {
  await fresh(["evil.example"]);
  useKey();
  const s = await site({ location: "/malware-landing" });
  const r = await engine.read(named(s) + "/go");
  assert.equal(r.status, "refused");
  assert.deepEqual(r.flag, ["web_risk:MALWARE", "web_risk:OTHER"]);
  assert.equal(s.count("/go"), 1);
  assert.equal(s.count("/malware-landing"), 0, "the flagged hop was never requested");
  assert.equal((r.untrusted_content as any).flagged_url, named(s) + "/malware-landing");
});

test("W-19: a name Tiresias would refuse never reaches Web Risk: internal DNS answers are refused first; IP literals, single labels and private-use suffixes are never sent", async () => {
  await fresh(["evil.example"]);
  useKey();
  const before = wr.queries.length;
  FAKE_DNS["intranet.sb.example"] = "10.0.0.5";
  delete process.env.TIRESIAS_ALLOW_PRIVATE;
  try {
    const r = await engine.read("http://intranet.sb.example/wiki");
    assert.equal(r.status, "refused");
    assert.match(r.message!, /private or internal/);
  } finally {
    process.env.TIRESIAS_ALLOW_PRIVATE = "1";
    delete FAKE_DNS["intranet.sb.example"];
  }
  // These would resolve to a public address here, so only the name rules keep them away from Google.
  const names = ["printer.local", "db.corp.internal", "nas.lan", "router.home.arpa", "app.localhost", "intranet"];
  for (const n of names) FAKE_DNS[n] = "93.184.215.14";
  try {
    const gate = sb.makeGate({ allowFlagged: false, priv: false });
    for (const n of names) await gate.check(new URL(`http://${n}/malware`));
    await gate.check(new URL("http://8.8.8.8/malware"));
    await gate.check(new URL("http://[2606:4700::1111]/malware"));
  } finally {
    for (const n of names) delete FAKE_DNS[n];
  }
  assert.equal(wr.queries.length, before, "nothing was sent to Web Risk");
  assert.ok(sb.webRiskEligible("shop.sb.example"));
});

test("W-19: Web Risk down or slow: web_risk_unavailable, and the local list's verdict is used", async () => {
  await fresh(["sb.example"]);
  useKey();
  const s = await site();
  wr.mode = "down";
  const r = await engine.read(named(s) + "/x");
  assert.equal(r.status, "flagged", "the list still flags");
  assert.equal(r.safety, "web_risk_unavailable");
  await setList(["evil.example"]);
  wr.mode = "hang";
  const t0 = Date.now();
  const r2 = await engine.read(named(s) + "/y");
  assert.equal(r2.status, "ok");
  assert.equal(r2.safety, "web_risk_unavailable");
  timing(Date.now() - t0 < 9000, "one 5 s timeout for the whole call, not one per hop");
  wr.mode = "normal";
  process.env.TIRESIAS_WEB_RISK_ENDPOINT = "http://127.0.0.1:1/v1/uris:search"; // nothing listens there
  assert.equal((await engine.read(named(s) + "/z")).safety, "web_risk_unavailable");
});

test("W-19: Web Risk verdicts are cached in memory until expireTime (at most an hour); private calls bypass the cache", async () => {
  await fresh(["evil.example"]);
  useKey();
  const s = await site();
  const asked = (p: string) => wr.queries.filter((q) => q.get("uri") === named(s) + p).length;
  wr.expireMs = 1200;
  assert.equal((await engine.read(named(s) + "/malware")).status, "refused");
  assert.equal((await engine.read(named(s) + "/malware")).status, "refused");
  assert.equal(asked("/malware"), 1, "the second answer came from the cache");
  await new Promise((r) => setTimeout(r, 1400));
  assert.equal((await engine.read(named(s) + "/malware")).status, "refused");
  assert.equal(asked("/malware"), 2, "expired, asked again");
  wr.expireMs = 600_000;
  sb.clearWebRiskCache();
  await engine.read(named(s) + "/clean-page", {}, { agent: "a", private: true });
  await engine.read(named(s) + "/clean-page", {}, { agent: "a", private: true });
  assert.equal(asked("/clean-page"), 2, "private calls never read the cache");
  assert.equal(sb.webRiskCacheSize(), 0, "and never write it");
  await engine.read(named(s) + "/clean-page");
  await engine.read(named(s) + "/clean-page");
  assert.equal(asked("/clean-page"), 3, "a clean answer is cached too");
  await engine.read(named(s) + "/clean-page", {}, { agent: "a", private: true });
  assert.equal(asked("/clean-page"), 4, "a private call asks even when a cached answer exists");
});

test("W-19: an unsafe key file is refused loudly before anything is sent: readable by others, a link, a folder, a missing configured file", async () => {
  await fresh(["evil.example"]);
  const s = await site();
  const f = useKey(0o644);
  const r = await engine.read(s.url + "/x");
  assert.equal(r.status, "error");
  assert.match(r.message!, /chmod 600/);
  assert.equal(s.hits.length, 0);
  fs.chmodSync(f, 0o600);
  const link = f + ".link";
  fs.symlinkSync(f, link);
  fs.writeFileSync(path.join(store.homeDir(), "config.json"), JSON.stringify({ web_risk_key_file: link }));
  assert.match((await engine.read(s.url + "/x")).message!, /is a link/);
  fs.writeFileSync(path.join(store.homeDir(), "config.json"), JSON.stringify({ web_risk_key_file: path.dirname(f) }));
  assert.match((await engine.read(s.url + "/x")).message!, /not a regular file/);
  fs.writeFileSync(path.join(store.homeDir(), "config.json"), JSON.stringify({ web_risk_key_file: f + ".missing" }));
  assert.match((await engine.read(s.url + "/x")).message!, /does not exist/);
  fs.writeFileSync(path.join(store.homeDir(), "config.json"), JSON.stringify({ web_risk_key_file: "relative/secrets.env" }));
  assert.match((await engine.read(s.url + "/x")).message!, /full path/);
  assert.equal(s.hits.length, 0);
  // The default file (~/.config/tiresias/secrets.env, here under the fake HOME) missing means Web Risk is off.
  fs.rmSync(path.join(store.homeDir(), "config.json"));
  assert.equal(engine.safetyStatus().web_risk.configured, false);
  // A test endpoint that is not https (and not this machine) is refused.
  useKey();
  process.env.TIRESIAS_WEB_RISK_ENDPOINT = "http://webrisk.example/v1/uris:search";
  assert.match((await engine.read(s.url + "/x")).message!, /TIRESIAS_WEB_RISK_ENDPOINT/);
});

test("W-19: the Web Risk key never appears in any output, error, log, history, receipt or file", async () => {
  const home = await fresh(["127.0.0.1"]);
  const keyFile = useKey();
  const s = await site();
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errs.push(a.map(String).join(" "));
  const outs: unknown[] = [];
  try {
    outs.push(await engine.read(named(s) + "/malware", {}, { agent: "a" }));
    outs.push(await engine.read(s.url + "/fine", {}, { agent: "a", allow_flagged: true }));
    wr.mode = "down";
    outs.push(await engine.read(named(s) + "/other", {}, { agent: "a", allow_flagged: true }));
    wr.mode = "hang";
    outs.push(await engine.check(named(s) + "/again"));
    wr.mode = "normal";
    list.status = 500;
    outs.push(await engine.safetyUpdate());
    list.status = 200;
    outs.push(engine.safetyStatus());
    outs.push(await engine.needsReport("1d"));
    outs.push(await engine.dailyLog());
    outs.push(await engine.queryHistory({}));
    outs.push(await engine.queryReceipts({}));
    // A key that is not a key: the error says so without repeating it.
    fs.writeFileSync(keyFile, `WEB_RISK_API_KEY=${KEY}!!\n`, { mode: 0o600 });
    outs.push(await engine.read(s.url + "/x"));
    fs.writeFileSync(keyFile, `WEB_RISK_API_KEY=${KEY}\n`, { mode: 0o600 });
  } finally {
    console.error = orig;
  }
  // The CLI, as a separate process, with the key in the environment instead of a file.
  const env = { ...process.env, TIRESIAS_HOME: home, TIRESIAS_WEB_RISK_KEY: KEY };
  for (const args of [["read", s.url + "/malware"], ["read", s.url + "/fine", "--allow-flagged", "--text"], ["safety", "status"], ["safety", "update"], ["history"]]) {
    const p = await run(args, env);
    outs.push(p.stdout, p.stderr);
  }
  const p = await run(["safety", "status"], { ...env, TIRESIAS_WEB_RISK_KEY: KEY + "!!" });
  outs.push(p.stdout, p.stderr);
  assert.match(p.stdout, /TIRESIAS_WEB_RISK_KEY is set but/);
  const all = JSON.stringify(outs) + errs.join("\n");
  assert.ok(all.length > 1000);
  assert.ok(!all.includes(KEY), "not in any output or stderr");
  assert.ok(!all.includes("SECRET123"), "not even part of it");
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = walk(home).filter((f) => f !== path.join(home, "config.json"));
  assert.ok(files.length > 3);
  for (const f of files) assert.ok(!fs.readFileSync(f).includes(KEY), `not in ${path.relative(home, f)}`);
});

test("W-19: MCP read takes allow_flagged; a flagged reply is not an MCP error", async () => {
  await fresh(["127.0.0.1"]);
  const s = await site();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  const client = new Client({ name: "sb-agent", version: "1" });
  await client.connect(b);
  const r1: any = await client.callTool({ name: "read", arguments: { url: s.url + "/p" } });
  assert.equal(JSON.parse(r1.content[0].text).status, "flagged");
  assert.ok(!r1.isError);
  const r2: any = await client.callTool({ name: "read", arguments: { url: s.url + "/p", allow_flagged: true } });
  const e2 = JSON.parse(r2.content[0].text);
  assert.equal(e2.status, "ok");
  assert.deepEqual(e2.flag, ["phishing_list"]);
  await client.close();
});

test("W-19: the gate runs inside the call scope for every hop; a SafeBrowsingError is never a silent pass", async () => {
  await fresh(["evil.example"]);
  process.env.TIRESIAS_SAFETY_LIST_URL = "ftp://list.example/x";
  try {
    await assert.rejects(Promise.resolve().then(() => sb.listUrl()), (e: any) => e instanceof SafeBrowsingError);
  } finally {
    process.env.TIRESIAS_SAFETY_LIST_URL = listServer.url + "/list.txt";
  }
  // withSignal carries the gate into fetches made in the call.
  const seen: string[] = [];
  const s = await site();
  const { safeFetch } = await import("../safety.js");
  await withSignal(AbortSignal.timeout(5000), () => safeFetch(s.url + "/q"), undefined, async (u) => void seen.push(u.href));
  assert.deepEqual(seen, [s.url + "/q"]);
});

// ---- Codex round 41 ----

test("W-19 (Codex round 41): test overrides must point at this machine; an https endpoint elsewhere is refused and nothing (key included) leaves", async () => {
  await fresh(["evil.example"]);
  useKey();
  const s = await site();
  process.env.TIRESIAS_WEB_RISK_ENDPOINT = "https://collector.example/lookup";
  const off = OFFBOX.length;
  const r = await engine.read(named(s) + "/page");
  assert.equal(r.status, "error");
  assert.match(r.message!, /only point at this machine/);
  assert.equal(OFFBOX.length, off, "nothing was sent off this machine");
  assert.equal(s.hits.length, 0);
  assert.ok(!JSON.stringify(r).includes(KEY));
  process.env.TIRESIAS_WEB_RISK_ENDPOINT = WR_ENDPOINT;
  // The list source too: a download is refused before any lookup or request.
  process.env.TIRESIAS_SAFETY_LIST_URL = `https://list.sb.example:${new URL(listServer.url).port}/list.txt`;
  const n = LOOKUPS.length;
  try {
    const u = await engine.safetyUpdate();
    assert.equal(u.status, "error");
    assert.match(u.message, /TIRESIAS_SAFETY_LIST_URL may only point at this machine/);
    assert.ok(!LOOKUPS.slice(n).includes("list.sb.example"), "the name was never even looked up");
    process.env.TIRESIAS_SAFETY_LIST_URL = "https://localhost:1/list.txt";
    assert.equal(sb.listUrl(), "https://localhost:1/list.txt", "https to this machine is fine");
  } finally {
    process.env.TIRESIAS_SAFETY_LIST_URL = listServer.url + "/list.txt";
  }
});

test("W-19 (Codex round 41): a refresh that fails on a bad setting never leaves an unhandled rejection (the process keeps running)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-unh-"));
  const mod = path.join(path.dirname(CLI), "safebrowsing.js");
  const script = `
    const sb = await import(${JSON.stringify(mod)});
    try { await sb.ensureList(); console.log("not rejected"); } catch (e) { console.log("caught " + e.constructor.name); }
    await new Promise((r) => setTimeout(r, 300));
    console.log("alive");`;
  const p = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, TIRESIAS_HOME: path.join(dir, "store"), TIRESIAS_SAFETY_LIST_URL: "ftp://list.example/x" },
    });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ code, out }));
  });
  assert.equal(p.code, 0, p.out);
  assert.match(p.out, /caught SafeBrowsingError/);
  assert.match(p.out, /alive/);
  assert.doesNotMatch(p.out, /unhandled/i);
});

test("W-19 (Codex round 41): a stalled DNS lookup in the Web Risk step ends at cancellation, at the call deadline, and at the shared 5 s bound", { timeout: 20_000 }, async () => {
  await fresh(["evil.example"]);
  useKey();
  const before = wr.queries.length;
  // Cancellation: the caller gives up after 300 ms.
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 300);
  let t0 = Date.now();
  const r = await engine.read("http://stall.sb.example/x", {}, { agent: "a", signal: ctl.signal });
  timing(Date.now() - t0 < 2000, `ended in ${Date.now() - t0} ms`);
  assert.equal(r.status, "error");
  assert.match(r.message!, /cancelled/);
  // The call's deadline (here 300 ms) ends the gate too.
  t0 = Date.now();
  const gate = sb.makeGate({ allowFlagged: false, priv: false });
  await assert.rejects(withSignal(AbortSignal.timeout(300), () => gate.check(new URL("http://stall.sb.example/y"))), (e: any) => /cancelled/.test(e.message));
  timing(Date.now() - t0 < 2000);
  // With no deadline of its own, the Web Risk step (DNS and request together) gives up at 5 s.
  t0 = Date.now();
  const g2 = sb.makeGate({ allowFlagged: false, priv: false });
  await g2.check(new URL("http://stall.sb.example/z"));
  timing(Date.now() - t0 < 7000);
  assert.equal(g2.code, "web_risk_unavailable");
  assert.equal(wr.queries.length, before, "a name that did not resolve was never sent");
});

test("W-19 (Codex rounds 41, 43): a list entry that is a public suffix never flags what is under it, and is counted; exact hosts below it still match", async () => {
  const n = normalizeList("co.uk\ngithub.io\nevil.github.io\nphish.example\n");
  assert.equal(n.entries, 4, "suffix entries are kept (they still flag their own exact host)");
  assert.equal(n.suffix_entries, 2);
  const ix = indexList(Buffer.from(n.text))!;
  assert.ok(!lookup(ix, "shop.co.uk"));
  assert.ok(!lookup(ix, "someone.github.io"));
  assert.ok(lookup(ix, "evil.github.io"));
  assert.ok(lookup(ix, "x.evil.github.io"));
  // An index that still holds a suffix (an older stored list) cannot flag what is under it either.
  const old = indexList(Buffer.from("co.uk\nphish.co.uk\n"))!;
  assert.ok(!lookup(old, "bank.co.uk"));
  assert.ok(lookup(old, "login.phish.co.uk"));
  await fresh(["co.uk", "evil.example"]);
  const st = engine.safetyStatus();
  assert.equal(st.list.entries, 2);
  assert.equal(st.list.suffix_entries, 1);
});

test("W-19 (Codex round 41): the README says exactly what leaves the machine", () => {
  const readme = fs.readFileSync(path.join(path.dirname(CLI), "..", "README.md"), "utf8");
  assert.ok(!readme.includes("Nothing is sent anywhere"));
  assert.match(readme, /What leaves your machine is the requests to the sites you read/);
  assert.match(readme, /each URL Tiresias checks, sent to Google/);
});

// ---- Codex round 42 ----

test("W-19 (Codex round 42): a reader waiting on another call's list refresh stops at its own cancellation; the refresh goes on for the others", { timeout: 20_000 }, async () => {
  await fresh(["evil.example"]);
  const s = await site();
  ageList(25); // a refresh is due
  list.hangMs = 3000;
  try {
    // B starts the shared refresh and gives up at 300 ms; A arrives meanwhile with no deadline of its own.
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 300);
    const t0 = Date.now();
    const pb = engine.read(s.url + "/b", {}, { agent: "b", signal: ctl.signal });
    await new Promise((r) => setTimeout(r, 50));
    const pa = engine.read(s.url + "/a", {}, { agent: "a" });
    // C waits on the same refresh and gives up at 300 ms too.
    const ctl2 = new AbortController();
    setTimeout(() => ctl2.abort(), 300);
    const pc = engine.read(s.url + "/c", {}, { agent: "c", signal: ctl2.signal });
    const [b, c] = await Promise.all([pb, pc]);
    timing(Date.now() - t0 < 1500, `cancelled readers ended in ${Date.now() - t0} ms`);
    assert.match(b.message!, /cancelled/);
    assert.match(c.message!, /cancelled/);
    const a = await pa;
    assert.equal(a.status, "ok");
    assert.equal(a.safety, "checked", "the refresh B started was not cut short by B's cancellation");
    assert.equal(engine.safetyStatus().list.state, "current");
  } finally {
    list.hangMs = 0;
  }
});

test("W-19 (Codex round 42): a two-label entry with a generic first label (com.es, gob.mx) is a public suffix", () => {
  const n = normalizeList("com.es\ngob.mx\nevil.com.es\n");
  assert.equal(n.entries, 3);
  assert.equal(n.suffix_entries, 2);
  const ix = indexList(Buffer.from(n.text))!;
  assert.ok(!lookup(ix, "shop.com.es"));
  assert.ok(lookup(ix, "x.evil.com.es"));
  const old = indexList(Buffer.from("com.es\ngob.mx\n"))!;
  assert.ok(!lookup(old, "shop.com.es"));
  assert.ok(!lookup(old, "tramites.gob.mx"));
});

// ---- Codex round 43 ----

test("W-19 (Codex round 43): the generic rule needs a country code (gov.com is an ordinary domain), and a suffix entry still flags its own exact host", async () => {
  const n = normalizeList("gov.com\ncom.es\n");
  assert.equal(n.entries, 2, "both entries are kept");
  assert.equal(n.suffix_entries, 1, "com.es is a suffix, gov.com is not");
  await fresh(["gov.com", "com.es"]);
  const a = await engine.read("https://gov.com/login");
  assert.equal(a.status, "flagged");
  assert.deepEqual(a.flag, ["phishing_list"]);
  const b = await engine.read("https://com.es/");
  assert.equal(b.status, "flagged", "the exact host of a suffix entry is flagged");
  const gate = sb.makeGate({ allowFlagged: false, priv: false });
  await assert.rejects(gate.check(new URL("https://www.gov.com/x")), (e: any) => e instanceof Flagged);
  await gate.check(new URL("https://shop.com.es/")); // never flagged by the com.es entry
  assert.equal(gate.code, "checked");
});

// Codex round 44 removed round 43's stop-when-nobody-waits mechanism: the shared refresh always runs to
// completion, so a call that joins it after an earlier caller gave up gets the refreshed list.
test("W-19 (Codex round 44): a late joiner during a slow refresh gets the refreshed list, after the caller that started it gave up", { timeout: 20_000 }, async () => {
  await fresh(["evil.example"]);
  const s = await site();
  ageList(8 * 24); // too old to use: without the refresh, the site would be unchecked, not flagged
  list.body = "127.0.0.1\nevil.example\n";
  list.etag = "late-joiner";
  list.hangMs = 1500;
  try {
    // B starts the shared refresh and gives up at 300 ms.
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 300);
    await assert.rejects(withSignal(ctl.signal, () => sb.ensureList()), /cancelled/);
    // C joins at once, while the refresh B started is still running and nobody else is waiting on it.
    const gate = sb.makeGate({ allowFlagged: false, priv: false });
    await assert.rejects(gate.check(new URL(s.url + "/c")), (e: any) => e instanceof Flagged);
    assert.equal(gate.code, "checked");
    assert.equal(s.hits.length, 0);
    // The same through engine.read, for a reader arriving after B left.
    const c = await engine.read(s.url + "/d", {}, { agent: "d" });
    assert.equal(c.status, "flagged");
  } finally {
    list.hangMs = 0;
  }
});
