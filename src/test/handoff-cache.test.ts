// SPDX-License-Identifier: Apache-2.0
// v0.3 phase B: W-06 handoff tickets and resume, W-03 the shared cache across agents.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { freshHome, html, logText, serve, text, type TestServer } from "./helper.js";

freshHome();
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
delete process.env.TIRESIAS_PRIVATE;
const engine = await import("../engine.js");
const store = await import("../store.js");
const handoffs = await import("../handoffs.js");
const cleanup = await import("../cleanup.js");
const { fromResponse, after304, judge, MAX_LIFETIME_S } = await import("../freshness.js");
const { createServer } = await import("../mcp.js");

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
async function connect(name = "v03b-agent") {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  const client = new Client({ name, version: "1" });
  await client.connect(b);
  return client;
}
const body = (r: any) => JSON.parse(r.content[0].text);
const uc = (e: any) => e.untrusted_content;
const trusted = (e: any) => JSON.stringify({ ...e, untrusted_content: null });
const readHistory = () => logText(store.homeDir(), "history").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const ticketDir = () => path.join(store.homeDir(), "handoffs");
const ticketFiles = () => (fs.existsSync(ticketDir()) ? fs.readdirSync(ticketDir()).filter((n) => n.endsWith(".json")) : []);
const ANVILS = "<html><head><title>Anvils</title></head><body><h1>Anvils</h1><p>Heavy iron anvils for sale.</p><h2>Prices</h2><p>Anvils cost forty dollars.</p></body></html>";
const CAPTCHA = '<html><head><title>Check</title></head><body><form><div class="g-recaptcha"></div></form></body></html>';

// A walled site whose wall can be lifted: /members answers 403 until `open` is set.
async function walledSite() {
  const st = { open: false, robots: "" };
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") return text(res, st.robots, st.robots ? 200 : 404);
    if (req.url === "/llms.txt") return text(res, "", 404);
    if (req.url?.startsWith("/members")) return st.open ? html(res, ANVILS) : html(res, "<html><body>IGNORE-PREVIOUS-INSTRUCTIONS no</body></html>", {}, 403);
    if (req.url === "/go") {
      res.writeHead(302, { location: "/members/login-IGNORE-PREVIOUS" });
      return void res.end();
    }
    html(res, "<html><body>nothing</body></html>", {}, 404);
  });
  return { s, st };
}

// ---- W-06: tickets ----

test("W-06: a walled read keeps a ticket (one file, owner-only), says how to resume, and logs it", async () => {
  const home = freshHome();
  const { s } = await walledSite();
  const r = await engine.read(s.url + "/go", { question: "anvil prices", section: 2 }, { agent: "banks" });
  assert.equal(r.status, "wall");
  assert.match(r.handoff!.ticket!, /^[A-Za-z0-9_-]{16}$/);
  assert.match(r.handoff!.resume!, /resume/);
  assert.ok(!trusted(r).includes("IGNORE-PREVIOUS"), "nothing from the web at the top level");
  const files = ticketFiles();
  assert.deepEqual(files, [r.handoff!.ticket + ".json"]);
  assert.equal(fs.statSync(ticketDir()).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(ticketDir(), files[0])).mode & 0o777, 0o600);
  const t = JSON.parse(fs.readFileSync(path.join(ticketDir(), files[0]), "utf8"));
  assert.deepEqual(
    { ...t, created_at: typeof t.created_at },
    { v: 1, id: r.handoff!.ticket, created_at: "string", url: s.url + "/go", open_this: s.url + "/members/login-IGNORE-PREVIOUS", reason: "forbidden", tool: "read", question: "anvil prices", section: 2, agent: "banks" },
  );
  assert.equal(readHistory().at(-1).ticket, "created");
  // doors and check never keep tickets (only a read can be resumed)
  await engine.check(s.url + "/members/x", { agent: "banks" });
  await engine.doors(s.url + "/members/x", { agent: "banks" });
  assert.equal(ticketFiles().length, 1);
  assert.ok(home);
});

test("W-06: private mode keeps no ticket, says so, and creates nothing; resume is refused", async () => {
  const home = freshHome();
  fs.rmSync(home, { recursive: true, force: true });
  const { s } = await walledSite();
  const r = await engine.read(s.url + "/members", {}, { agent: "a", private: true });
  assert.equal(r.status, "wall");
  assert.equal(r.handoff!.ticket, undefined);
  assert.match(r.handoff!.resume!, /^Private mode: no handoff ticket/);
  assert.equal(r.private, true);
  assert.equal(fs.existsSync(home), false, "a private wall creates nothing");
  const p = await engine.resume("AAAAAAAAAAAAAAAA", undefined, { agent: "a", private: true });
  assert.equal(p.status, "refused");
  assert.equal(fs.existsSync(home), false);
});

test("W-06: retry runs the same read honestly; a wall still there keeps the SAME ticket; success removes it", async () => {
  freshHome();
  const { s, st } = await walledSite();
  const first = await engine.read(s.url + "/members", { question: "prices" }, { agent: "a" });
  const id = first.handoff!.ticket!;
  // still walled: the same ticket comes back, and no second ticket is made
  const again = await engine.resume(id, undefined, { agent: "b" });
  assert.equal(again.status, "wall");
  assert.equal(again.handoff!.ticket, id);
  assert.deepEqual(again.ticket, { id, open: true });
  assert.equal(ticketFiles().length, 1);
  // robots now forbids it: refused, the ticket stays open (robots was asked again)
  st.robots = "User-agent: *\nDisallow: /members\n";
  (await import("../rules.js")).resetRulesCache();
  const no = await engine.resume(id, undefined, { agent: "b" });
  assert.equal(no.status, "refused");
  assert.deepEqual(no.ticket, { id, open: true });
  st.robots = "";
  (await import("../rules.js")).resetRulesCache();
  // the person got through: the retry reads it with the original question, and the ticket goes
  st.open = true;
  const ok = await engine.resume(id, undefined, { agent: "b" });
  assert.equal(ok.status, "ok");
  assert.deepEqual(ok.ticket, { id, open: false });
  assert.match(uc(ok).passages[0].text, /forty dollars/, "the original question was asked again");
  assert.equal(ok.source, undefined, "a retry is a normal fetch");
  assert.deepEqual(ticketFiles(), []);
  const h = readHistory().filter((e) => e.tool === "resume");
  assert.deepEqual(h.map((e) => e.status), ["wall", "refused", "ok"]);
  assert.equal(h[2].purpose, "prices");
  // used up: a second resume finds nothing, with fixed text
  const gone = await engine.resume(id, undefined, { agent: "b" });
  assert.equal(gone.status, "error");
  assert.match(gone.message!, /no open handoff ticket/);
});

test("W-06: a retry always asks the site, even when a cached copy is still fresh", async () => {
  freshHome();
  let walled = false;
  const s = await start((req, res) => {
    if (req.url === "/robots.txt" || req.url === "/llms.txt") return text(res, "", 404);
    if (walled) return html(res, "<html><body>no</body></html>", {}, 403);
    html(res, ANVILS, { "cache-control": "max-age=600" });
  });
  await engine.read(s.url + "/p", {}, { agent: "a" }); // a fresh copy is cached
  walled = true;
  const w = await engine.read(s.url + "/p", { fresh: true }, { agent: "a" });
  assert.equal(w.status, "wall");
  const r = await engine.resume(w.handoff!.ticket!, undefined, { agent: "a" });
  assert.equal(r.status, "wall", "the fresh cached copy was not taken as proof the wall is gone");
  assert.equal(r.cache, undefined);
});

test("W-06: a page the person provided is parsed with NO request, marked provided_by_person everywhere, not cached", async () => {
  const home = freshHome();
  const { s } = await walledSite();
  const w = await engine.read(s.url + "/members", { question: "prices" }, { agent: "a" });
  const id = w.handoff!.ticket!;
  const hits = s.hits.length;
  const r = await engine.resume(id, { text: ANVILS }, { agent: "a" });
  assert.equal(s.hits.length, hits, "nothing at all was sent to the site, not even robots.txt");
  assert.equal(r.status, "ok");
  assert.equal(r.source, "provided_by_person");
  assert.equal(r.signed, undefined, "no request, so no signed field");
  assert.equal(r.door_detail, "html");
  assert.deepEqual(r.ticket, { id, open: false });
  assert.ok(uc(r).receipts.length > 0);
  for (const rc of uc(r).receipts) {
    assert.equal(rc.source, "provided_by_person");
    assert.equal(rc.url, s.url + "/members");
  }
  assert.match(uc(r).passages[0].text, /forty dollars/);
  assert.match(r.message!, /provided/);
  // not cached and not a baseline: a later check of that URL is a first visit
  assert.equal(fs.existsSync(store.cachePath(s.url + "/members")), false);
  const logged = logText(home, "receipts").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(logged.length && logged.every((x) => x.source === "provided_by_person"));
  const h = readHistory().at(-1);
  assert.deepEqual([h.tool, h.status, h.source], ["resume", "ok", "provided_by_person"]);
  assert.deepEqual(ticketFiles(), []);
});

const tinyPdf = (line: string) => {
  const content = `BT /F1 12 Tf 20 150 Td (${line}) Tj ET\n`;
  const objs = [
    "",
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[4 0 R]/Count 1>>",
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 5 0 R/Resources<</Font<</F1 3 0 R>>>>>>",
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  for (let i = 1; i < objs.length; i++) out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  return Buffer.from(out + `trailer\n<</Root 1 0 R/Size ${objs.length}>>\n%%EOF\n`, "latin1");
};

test("W-06: --from-file reads saved HTML, markdown and PDF pages; odd files and oversize ones are refused", async () => {
  const home = freshHome();
  const { s } = await walledSite();
  const dir = fs.mkdtempSync(path.join(path.dirname(home), "tiresias-saved-"));
  const ticket = async () => (await engine.read(s.url + "/members", {}, { agent: "a" })).handoff!.ticket!;
  const hits = () => s.hits.filter((h) => h.path !== "/robots.txt" && h.path !== "/llms.txt" && !h.path.startsWith("/.well-known") && !h.path.includes("openapi")).length;

  fs.writeFileSync(path.join(dir, "page.html"), ANVILS);
  let id = await ticket();
  let before = s.hits.length;
  let r = await engine.resume(id, { file: path.join(dir, "page.html") }, { agent: "a" });
  assert.equal(s.hits.length, before);
  assert.deepEqual([r.status, r.door_detail, r.source], ["ok", "html", "provided_by_person"]);

  fs.writeFileSync(path.join(dir, "page.md"), "# Anvils\n\nMarkdown anvils, saved by a person.\n");
  id = await ticket();
  r = await engine.resume(id, { file: path.join(dir, "page.md") }, { agent: "a" });
  assert.deepEqual([r.status, r.door_detail], ["ok", "text"]);
  assert.ok(uc(r).outline.some((o: any) => o.heading === "Anvils"));

  if (process.platform !== "win32") {
    // Windows cannot read PDFs (no memory watching, SPEC section 9)
    fs.writeFileSync(path.join(dir, "saved.pdf"), tinyPdf("Saved PDF anvils"));
    id = await ticket();
    before = s.hits.length;
    r = await engine.resume(id, { file: path.join(dir, "saved.pdf") }, { agent: "a" });
    assert.equal(s.hits.length, before);
    assert.deepEqual([r.status, r.door_detail, r.source], ["ok", "pdf", "provided_by_person"]);
    assert.ok(uc(r).receipts.some((x: any) => /Saved PDF anvils/.test(x.quote) && x.source === "provided_by_person"));
  }

  // refused with fixed text, the ticket stays open, and still nothing is sent
  id = await ticket();
  before = hits();
  const fifo = path.join(dir, "pipe");
  const { execFileSync } = await import("node:child_process");
  execFileSync("mkfifo", [fifo]);
  for (const [file, re] of [[fifo, /not a plain file/], [dir, /not a plain file/], [path.join(dir, "missing.html"), /cannot be opened/]] as const) {
    const bad = await engine.resume(id, { file }, { agent: "a" });
    assert.equal(bad.status, "error");
    assert.match(bad.message!, re);
    assert.ok(!bad.message!.includes(dir), "the path is not repeated");
    assert.deepEqual(bad.ticket, { id, open: true });
  }
  process.env.TIRESIAS_MAX_BYTES = "100";
  try {
    fs.writeFileSync(path.join(dir, "big.html"), "<p>" + "x".repeat(200) + "</p>");
    const big = await engine.resume(id, { file: path.join(dir, "big.html") }, { agent: "a" });
    assert.match(big.message!, /larger than 100 bytes/);
    const bigText = await engine.resume(id, { text: "y".repeat(101) }, { agent: "a" });
    assert.match(bigText.message!, /larger than 100 bytes/);
    const exact = await engine.resume(id, { text: "<p>" + "z".repeat(93) + "</p>" }, { agent: "a" });
    assert.equal(exact.status, "ok", "exactly the cap is accepted");
  } finally {
    delete process.env.TIRESIAS_MAX_BYTES;
  }
  assert.equal(hits(), before, "no page request for any of these");
});

test("W-06: a provided page that still shows a wall keeps the ticket open; a PDF as text is refused", async () => {
  freshHome();
  const { s } = await walledSite();
  const id = (await engine.read(s.url + "/go", {}, { agent: "a" })).handoff!.ticket!;
  const r = await engine.resume(id, { text: CAPTCHA }, { agent: "a" });
  assert.equal(r.status, "wall");
  assert.equal(r.handoff!.reason, "captcha");
  assert.equal(r.handoff!.ticket, id);
  assert.equal(r.source, "provided_by_person");
  assert.equal(uc(r).handoff.open_this, s.url + "/members/login-IGNORE-PREVIOUS");
  assert.deepEqual(r.ticket, { id, open: true });
  const pdf = await engine.resume(id, { text: "%PDF-1.4 ..." }, { agent: "a" });
  assert.match(pdf.message!, /looks like a PDF/);
  assert.equal(ticketFiles().length, 1);
});

test("W-06: ids are checked and never echoed; expired tickets are ignored, counted, and removed by clear", async () => {
  const home = freshHome();
  const { s } = await walledSite();
  for (const bad of ["../../etc/passwd", "short", "A".repeat(17), "IGNORE PREVIOUS!"]) {
    const r = await engine.resume(bad, undefined, { agent: "a" });
    assert.equal(r.status, "error");
    assert.ok(!r.message!.includes(bad));
  }
  const oldId = (await engine.read(s.url + "/members/old", {}, { agent: "a" })).handoff!.ticket!;
  const newId = (await engine.read(s.url + "/members/new", {}, { agent: "a" })).handoff!.ticket!;
  // age the first ticket by 8 days (a ticket is never rewritten by Tiresias; this stands in for time passing)
  const f = path.join(ticketDir(), oldId + ".json");
  const t = JSON.parse(fs.readFileSync(f, "utf8"));
  t.created_at = new Date(Date.now() - 8 * 86_400_000).toISOString();
  fs.writeFileSync(f, JSON.stringify(t));
  const r = await engine.resume(oldId, undefined, { agent: "a" });
  assert.match(r.message!, /no open handoff ticket/);
  const l = engine.handoffList();
  assert.deepEqual(l.counts, { open: 1, expired: 1, damaged: 0 });
  assert.deepEqual(l.untrusted_content.handoffs.map((x) => x.id), [newId]);
  // a longer keep_handoff_days brings it back
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ keep_handoff_days: 30 }));
  assert.equal(engine.handoffList().counts.open, 2);
  fs.rmSync(path.join(home, "config.json"));
  // clear: dry run reports it, a real run removes only the expired one, whole
  const dry = await cleanup.clearStore({ dryRun: true });
  assert.equal(dry.handoffs.removed, 1);
  assert.equal(ticketFiles().length, 2);
  const real = await cleanup.clearStore({});
  assert.equal(real.handoffs.removed, 1);
  assert.equal(real.handoffs.kept, 1);
  assert.match(real.summary, /1 handoff tickets/);
  assert.deepEqual(ticketFiles(), [newId + ".json"]);
  // --all removes open tickets too (they are browsing data), never bookmarks
  await engine.bookmark("add", "keep", s.url + "/x");
  await cleanup.clearStore({ all: true });
  assert.deepEqual(ticketFiles(), []);
  assert.equal(engine.bookmarkList().counts!.bookmarks, 1);
});

test("W-06: the cap is 500 open tickets; past it no ticket is kept, the reply says so and history counts it", async () => {
  freshHome();
  const { s } = await walledSite();
  const first = await engine.read(s.url + "/members", {}, { agent: "a" });
  const src = fs.readFileSync(path.join(ticketDir(), first.handoff!.ticket + ".json"), "utf8");
  for (let i = 1; i < handoffs.MAX_TICKETS; i++) {
    const id = ("t" + String(i).padStart(15, "0")).slice(0, 16);
    fs.writeFileSync(path.join(ticketDir(), id + ".json"), src.replace(first.handoff!.ticket!, id), { mode: 0o600 });
  }
  assert.equal(ticketFiles().length, 500);
  const r = await engine.read(s.url + "/members", {}, { agent: "a" });
  assert.equal(r.status, "wall");
  assert.equal(r.handoff!.ticket, undefined);
  assert.match(r.handoff!.resume!, /500 tickets are already open/);
  assert.equal(readHistory().at(-1).ticket, "refused_cap");
  assert.equal(ticketFiles().length, 500);
  assert.equal((await engine.needsReport()).counts.handoffs.refused_cap, 1);
});

test("W-06: ticket fields are bounded: an over-long question keeps no ticket, an over-long page to open is left out", async () => {
  freshHome();
  const long = "/members/" + "x".repeat(5000);
  const s = await start((req, res) => {
    if (req.url === "/robots.txt" || req.url === "/llms.txt") return text(res, "", 404);
    if (req.url === "/go") {
      res.writeHead(302, { location: long });
      return void res.end();
    }
    html(res, "<html><body>no</body></html>", {}, 403);
  });
  const q = await engine.read(s.url + "/members", { question: "q".repeat(1001) }, { agent: "a" });
  assert.equal(q.handoff!.ticket, undefined);
  assert.match(q.handoff!.resume!, /too long to keep whole/);
  const r = await engine.read(s.url + "/go", {}, { agent: "a".repeat(5000) });
  const t = JSON.parse(fs.readFileSync(path.join(ticketDir(), r.handoff!.ticket + ".json"), "utf8"));
  assert.equal(t.open_this, undefined, "a URL is never cut: left out");
  assert.equal(t.agent.length, 200);
  assert.equal(t.cut, true);
  assert.ok(JSON.stringify(t).length < 6000);
});

test("W-06: MCP resume and handoffs; tickets are inside untrusted_content; needs counts resolutions", async () => {
  freshHome();
  const { s, st } = await walledSite();
  const client = await connect();
  const w = body(await client.callTool({ name: "read", arguments: { url: s.url + "/go" } }));
  const id = w.handoff.ticket;
  const second = body(await client.callTool({ name: "read", arguments: { url: s.url + "/members/two" } })).handoff.ticket;
  const list = body(await client.callTool({ name: "handoffs", arguments: {} }));
  assert.deepEqual(list.counts, { open: 2, expired: 0, damaged: 0 });
  assert.ok(!trusted(list).includes("IGNORE-PREVIOUS"));
  assert.equal(list.untrusted_content.handoffs[0].open_this, s.url + "/members/login-IGNORE-PREVIOUS");
  const res = await client.callTool({ name: "resume", arguments: { ticket: id, text: "# Saved\n\nThe person pasted this page about anvils.\n" } });
  const r = body(res);
  assert.equal(res.isError, undefined);
  assert.deepEqual([r.status, r.source, r.ticket.open], ["ok", "provided_by_person", false]);
  st.open = true;
  const r2 = body(await client.callTool({ name: "resume", arguments: { ticket: second } }));
  assert.deepEqual([r2.status, r2.source, r2.ticket.open], ["ok", undefined, false]);
  // An oversized input against a LIVE ticket: refused by the size check, the ticket stays open (Codex round 38).
  st.open = false;
  const live = body(await client.callTool({ name: "read", arguments: { url: s.url + "/members/three" } })).handoff.ticket;
  const big = await client.callTool({ name: "resume", arguments: { ticket: live, text: "x".repeat(6 * 1024 * 1024) } });
  const bigEnv = body(big);
  assert.equal(big.isError, true);
  assert.match(bigEnv.message, /larger than \d+ bytes/);
  assert.deepEqual(bigEnv.ticket, { id: live, open: true });
  assert.ok(Buffer.byteLength((big.content as any)[0].text) < 60_000, "a huge input never makes a huge reply");
  const n = await engine.needsReport();
  assert.deepEqual(n.counts.handoffs, { tickets: 3, refused_cap: 0, resolved_retry: 1, resolved_person: 1 });
  const { toMarkdown } = await import("../needs.js");
  assert.match(toMarkdown(n), /resolved by a retry: 1; by a page a person provided: 1\. Expired tickets are not counted/);
});

// ---- W-03: the shared cache ----

test("W-03 freshness (round 38, conservative): only max-age, capped at an hour, age from the request start, blocks are sticky", () => {
  const t0 = Date.parse("2026-10-17T12:00:00Z");
  const H = (h: Record<string, string>) => new Headers(h);
  const f = (h: Record<string, string>) => fromResponse(H(h), t0);
  assert.deepEqual(f({ "cache-control": "max-age=60" }), { fresh_until: t0 + 60_000 });
  assert.deepEqual(f({ "cache-control": "public, max-age=60, must-revalidate" }), { fresh_until: t0 + 60_000 });
  assert.deepEqual(f({ "cache-control": "private, max-age=60" }), { fresh_until: t0 + 60_000 }, "one owner's agents are one user");
  assert.deepEqual(f({ "cache-control": "max-age=86400" }), { fresh_until: t0 + MAX_LIFETIME_S * 1000 }, "capped at one hour");
  assert.deepEqual(f({ "cache-control": "max-age=60", age: "45" }), { fresh_until: t0 + 15_000 });
  // Expires and Date are never used (Codex round 38: impossible and odd dates)
  assert.deepEqual(f({ expires: "Sun, 31 Feb 2027 12:00:00 GMT" }), {});
  assert.deepEqual(f({ expires: new Date(t0 + 300_000).toUTCString() }), {});
  assert.deepEqual(f({ "cache-control": "max-age=60", date: new Date(t0 + 86_400_000).toUTCString() }), { fresh_until: t0 + 60_000 }, "a server clock ahead changes nothing");
  assert.deepEqual(f({ "cache-control": "s-maxage=60" }), {}, "s-maxage is for shared caches");
  assert.deepEqual(f({}), {}, "no lifetime, no heuristic");
  // blocked, each one
  for (const h of [
    { "cache-control": "no-store, max-age=60" }, { "cache-control": "no-cache, max-age=60" }, { "cache-control": 'no-cache="set-cookie", max-age=60' },
    { "cache-control": "max-age=0" }, { "cache-control": "max-age=00" }, { "cache-control": "max-age=abc" }, { "cache-control": "max-age=60, max-age=60" },
    { "cache-control": "max-age=1234567890" }, { "cache-control": "max-age=60, a b" },
    { "cache-control": "max-age=60", pragma: "x" }, { "cache-control": "max-age=60", pragma: "" },
    { "cache-control": "max-age=60", vary: "Cookie" }, { "cache-control": "max-age=60", vary: "*" }, { "cache-control": "max-age=60", vary: "accept, " + "x".repeat(600) },
    { "cache-control": "max-age=60, x=" + "y".repeat(1000) }, { "cache-control": 'max-age=60, x="' + "\u00e9".repeat(600) + '"' }, // a valid quoted value: 610 characters but over 1,200 UTF-8 bytes
    { "cache-control": "max-age=60", age: "60, 60" }, { "cache-control": "max-age=60", age: "1234567890123" }, { "cache-control": "max-age=60", age: "-1" }, { "cache-control": "max-age=60", age: "1.5" },
  ] as Record<string, string>[]) assert.deepEqual(f(h), { reuse_blocked: true }, JSON.stringify(h));
  assert.deepEqual(f({ "cache-control": "max-age=60", vary: "Accept-Encoding, user-agent" }), { fresh_until: t0 + 60_000 });
  assert.equal(judge(H({ "cache-control": "max-age=60", vary: "" })).block, false);
  assert.equal(judge(H({ "cache-control": 'max-age=60, x="' + "\u00e9".repeat(400) + '"' })).block, false, "a quoted value parses; only the byte size blocks the longer one");
  // a 304: never clears a block, may add one, refreshes only a copy that was reusable
  const t1 = t0 + 100_000;
  assert.deepEqual(after304({ reuse_blocked: true }, H({ "cache-control": "max-age=60" }), t1), { reuse_blocked: true });
  assert.deepEqual(after304({}, H({ "cache-control": "max-age=60" }), t1), {}, "a copy with no lifetime is not made reusable by a 304");
  assert.deepEqual(after304({ fresh_until: t0 + 10 }, H({ "cache-control": "max-age=60" }), t1), { fresh_until: t1 + 60_000 });
  assert.deepEqual(after304({ fresh_until: t0 + 10 }, H({}), t1), { fresh_until: t1 }, "no max-age of its own: no freshness (a deadline already past)");
  assert.deepEqual(after304({ fresh_until: t1 + 3_600_000 }, H({ age: "3600" }), t1), { fresh_until: t1 }, "a 304 never keeps an old deadline (Codex round 39)");
  assert.deepEqual(after304({ fresh_until: t1 + 60_000 }, H({ "cache-control": "max-age=60", age: "3600" }), t1), { fresh_until: t1 + 60_000 - 3_600_000 }, "its own Age counts");
  assert.deepEqual(after304({ fresh_until: t0 + 10 }, H({ "cache-control": "max-age=60", vary: "Cookie" }), t1), { reuse_blocked: true });
  assert.deepEqual(after304({ fresh_until: t0 + 10 }, H({ pragma: "no-cache" }), t1), { reuse_blocked: true });
  // a body reused from an earlier request has no start time: never reusable
  assert.deepEqual(fromResponse(H({ "cache-control": "max-age=60" }), undefined), {});
});

test("W-03: a second agent gets a still-fresh copy with no request to the site, with who fetched it and when", async () => {
  freshHome();
  const s = await start((req, res) => {
    if (req.url === "/robots.txt" || req.url === "/llms.txt") return text(res, "", 404);
    html(res, ANVILS, { "cache-control": "max-age=600", etag: '"v1"' });
  });
  const a = await engine.read(s.url + "/p", {}, { agent: "claude-code" });
  assert.equal(a.status, "ok");
  assert.equal(a.cache, undefined, "first visit: no cached copy took part");
  const pageHits = () => s.count("/p");
  assert.equal(pageHits(), 1);
  const hitsBefore = s.hits.length;
  // another agent: served fresh, no request at all (robots and doors are cached), and it gets the content
  const b = await engine.read(s.url + "/p", {}, { agent: "codex" });
  assert.equal(s.hits.length, hitsBefore, "the site was not asked for anything");
  assert.equal(b.status, "unchanged");
  assert.equal(b.cache, "fresh");
  assert.equal(b.signed, undefined, "no request was sent");
  assert.equal(uc(b).cached_by, "claude-code");
  assert.equal(uc(b).cached_at, a.fetched_at);
  assert.ok(uc(b).outline.length > 0, "an agent that never read this copy gets its content, not a one-line unchanged");
  assert.match(b.message!, /stays fresh until/);
  assert.ok(!trusted(b).includes("claude-code"), "the agent name is caller-supplied, so it stays inside untrusted_content");
  // the agent that fetched it gets the one-line answer
  const again = await engine.read(s.url + "/p", {}, { agent: "claude-code" });
  assert.equal(again.cache, "fresh");
  assert.equal(uc(again).outline, undefined);
  assert.match(again.message!, /Nothing was re-read/);
  // check is free too
  const c = await engine.check(s.url + "/p", { agent: "nova" });
  assert.deepEqual([c.status, c.cache, uc(c).cached_by], ["unchanged", "fresh", "claude-code"]);
  assert.equal(pageHits(), 1);
  // fresh: true always asks the site (here it revalidates with the ETag and gets a 200 back)
  const forced = await engine.read(s.url + "/p", { fresh: true }, { agent: "codex" });
  assert.equal(pageHits(), 2);
  assert.equal(forced.cache, "refetched");
  const cf = await engine.check(s.url + "/p", { agent: "codex" }, { fresh: true });
  assert.equal(pageHits(), 3);
  assert.equal(cf.cache, "refetched");
  // history says how the cache took part
  assert.deepEqual(readHistory().map((e) => e.cache), [undefined, "fresh", "fresh", "fresh", "refetched", "refetched"]);
  // private never reads the cache
  const p = await engine.read(s.url + "/p", {}, { agent: "codex", private: true });
  assert.equal(p.cache, undefined);
  assert.equal(pageHits(), 4);
});

test("W-03: a blocked copy stays blocked across 304s; a reusable one is refreshed by a 304; no lifetime means always ask", async () => {
  freshHome();
  const hdr: Record<string, Record<string, string>> = {
    "/nocache": { "cache-control": "no-cache" },
    "/vary": { "cache-control": "max-age=1", vary: "x".repeat(600) },
    "/pragma": { "cache-control": "max-age=1", pragma: "no-cache" },
    "/short": { "cache-control": "max-age=1" },
  };
  const s = await start((req, res) => {
    if (req.url === "/robots.txt" || req.url === "/llms.txt") return text(res, "", 404);
    if (req.headers["if-none-match"] === '"v1"') {
      // every 304 offers a long lifetime and repeats none of the blocking headers
      res.writeHead(304, { etag: '"v1"', "cache-control": "max-age=600" });
      return void res.end();
    }
    html(res, ANVILS, { ...hdr[req.url ?? ""], etag: '"v1"' });
  });
  for (const p of ["/nocache", "/vary", "/pragma"]) {
    await engine.read(s.url + p, {}, { agent: "a" }); // 200: blocked
    await new Promise((r) => setTimeout(r, 1100));
    const b = await engine.read(s.url + p, {}, { agent: "b" }); // 304 with max-age=600
    assert.equal(b.cache, "revalidated");
    assert.equal(uc(b).cached_by, "a");
    const c = await engine.read(s.url + p, {}, { agent: "c" });
    assert.equal(c.cache, "revalidated", `${p}: the 304 did not clear the block`);
    assert.equal(s.count(p), 3);
  }
  // a reusable copy that went stale is refreshed by a 304's max-age
  await engine.read(s.url + "/short", {}, { agent: "a" });
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal((await engine.read(s.url + "/short", {}, { agent: "b" })).cache, "revalidated");
  assert.equal((await engine.read(s.url + "/short", {}, { agent: "c" })).cache, "fresh");
  assert.equal(s.count("/short"), 2);
  // no caching headers at all: never fresh (no heuristic)
  const plain = await start((req, res) => (req.url === "/robots.txt" || req.url === "/llms.txt" ? text(res, "", 404) : html(res, ANVILS, { "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT", expires: "Thu, 01 Jan 2099 00:00:00 GMT" })));
  await engine.read(plain.url + "/q", {}, { agent: "a" });
  const q = await engine.read(plain.url + "/q", {}, { agent: "b" });
  assert.equal(plain.count("/q"), 2, "Expires alone never makes a copy fresh");
  assert.equal(q.cache, "refetched");
});

test("W-03 round 38: a copy's age counts from the request start, so a slow answer is not fresh for longer", async () => {
  freshHome();
  const s = await start((req, res) => {
    if (req.url === "/robots.txt" || req.url === "/llms.txt") return text(res, "", 404);
    setTimeout(() => html(res, ANVILS, { "cache-control": "max-age=1" }), 1300);
  });
  await engine.read(s.url + "/slow", {}, { agent: "a" });
  const b = await engine.read(s.url + "/slow", {}, { agent: "b" });
  assert.equal(s.count("/slow"), 2, "max-age=1 had run out before the 1.3 s answer finished");
  assert.equal(b.cache, "refetched");
});

test("W-03 round 38: a page reached through a redirect is never served fresh, so the destination's rules always apply", async () => {
  freshHome();
  let robots = "";
  const dest = await start((req, res) => {
    if (req.url === "/robots.txt") return text(res, robots, robots ? 200 : 404);
    if (req.url === "/llms.txt") return text(res, "", 404);
    html(res, ANVILS, { "cache-control": "max-age=600" });
  });
  const entry = await start((req, res) => {
    if (req.url === "/robots.txt" || req.url === "/llms.txt") return text(res, "", 404);
    res.writeHead(302, { location: dest.url + "/page", "cache-control": "max-age=600" });
    res.end();
  });
  const a = await engine.read(entry.url + "/entry", {}, { agent: "a" });
  assert.equal(a.status, "ok");
  robots = "User-agent: *\nDisallow: /page\n";
  (await import("../rules.js")).resetRulesCache();
  const b = await engine.read(entry.url + "/entry", {}, { agent: "b" });
  assert.notEqual(b.cache, "fresh");
  assert.equal(b.status, "refused", "the destination's robots.txt now says no, and it was asked");
  assert.equal(entry.count("/entry"), 2);
  // the same page read directly (no redirect) is served fresh
  robots = "";
  (await import("../rules.js")).resetRulesCache();
  await engine.read(dest.url + "/page", {}, { agent: "a" });
  assert.equal((await engine.read(dest.url + "/page", {}, { agent: "b" })).cache, "fresh");
});

test("Round 39: a probe body is never reused, so a changed llms.txt is read anew and a redirect target's cooldown applies", async () => {
  freshHome();
  let llms = "# Anvils\n\nVERSION_ONE of the llms body.\n";
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    if (req.url === "/llms.txt") return text(res, llms);
    html(res, ANVILS);
  });
  await engine.doors(s.url + "/", { agent: "a" }); // probes llms.txt
  llms = "# Anvils\n\nVERSION_TWO of the llms body.\n";
  const r = await engine.read(s.url + "/", { question: "version" }, { agent: "a" });
  assert.match(JSON.stringify(uc(r).passages), /VERSION_TWO/, "no body from an earlier call rolls the content back");
  // probe A's llms.txt redirects to B; B then asks for a wait: reading A's root must obey B
  const b = await start((req, res) => (req.url === "/robots.txt" ? text(res, "", 404) : text(res, "# B\n\nB_BODY from site B.\n")));
  const a = await start((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    if (req.url === "/llms.txt") {
      res.writeHead(302, { location: b.url + "/llms.txt" });
      return void res.end();
    }
    html(res, ANVILS);
  });
  await engine.doors(a.url + "/", { agent: "a" });
  (await import("../cooldown.js")).setCooldown(b.url, 429, "3600");
  const back = await engine.read(a.url + "/", {}, { agent: "a" });
  assert.equal(back.status, "refused", "B's wait was obeyed");
  assert.doesNotMatch(JSON.stringify(back), /B_BODY/);
});

test("Round 39: fresh reuse needs a fetch with no redirect at all, recorded by the fetch (an A to B to A chain does not count)", async () => {
  freshHome();
  let hitsA = 0;
  const s = await start((req, res) => {
    if (req.url === "/robots.txt" || req.url === "/llms.txt") return text(res, "", 404);
    if (req.url === "/a") {
      if (hitsA++ === 0) {
        res.writeHead(302, { location: "/b" });
        return void res.end();
      }
      return html(res, ANVILS, { "cache-control": "max-age=600" });
    }
    if (req.url === "/b") {
      res.writeHead(302, { location: "/a" });
      return void res.end();
    }
    html(res, ANVILS, { "cache-control": "max-age=600" });
  });
  const first = await engine.read(s.url + "/a", {}, { agent: "a" });
  assert.equal(uc(first).final_url, s.url + "/a", "the chain ended where it started");
  const second = await engine.read(s.url + "/a", {}, { agent: "b" });
  assert.notEqual(second.cache, "fresh");
  assert.equal(s.count("/a"), 3);
  // that second fetch had no redirect, so now it may be reused
  assert.equal((await engine.read(s.url + "/a", {}, { agent: "c" })).cache, "fresh");
  // a cached page without the field (made before round 39) is never reused fresh
  await engine.read(s.url + "/plain", {}, { agent: "a" });
  const file = store.cachePath(s.url + "/plain");
  const e = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(e.redirected, false);
  delete e.redirected;
  fs.writeFileSync(file, JSON.stringify(e));
  assert.notEqual((await engine.read(s.url + "/plain", {}, { agent: "b" })).cache, "fresh");
});

test("Round 39: a 304 never keeps an old deadline; without its own max-age the copy is not fresh", async () => {
  freshHome();
  const s = await start((req, res) => {
    if (req.url === "/robots.txt" || req.url === "/llms.txt") return text(res, "", 404);
    if (req.headers["if-none-match"] === '"v1"') {
      res.writeHead(304, { etag: '"v1"', age: "3600" });
      return void res.end();
    }
    html(res, ANVILS, { "cache-control": "max-age=60", etag: '"v1"' });
  });
  await engine.read(s.url + "/p", {}, { agent: "a" });
  assert.equal((await engine.read(s.url + "/p", {}, { agent: "b" })).cache, "fresh");
  const forced = await engine.read(s.url + "/p", { fresh: true }, { agent: "b" });
  assert.equal(forced.cache, "revalidated");
  const after = await engine.read(s.url + "/p", {}, { agent: "c" });
  assert.notEqual(after.cache, "fresh", "the 304 (Age 3600, no max-age) ended the old deadline");
  assert.equal(s.count("/p"), 3);
});

test("Round 39: the oversized-reply fallback never copies a long caller URL, and caller input in errors is bounded", async () => {
  freshHome();
  const { packResult } = await import("../mcp.js");
  const long = "https://a.test/" + "x".repeat(110_000);
  const p = packResult({ url: long, filler: "y".repeat(120_000) });
  const env = JSON.parse(p.content[0].text);
  assert.equal(p.isError, true);
  assert.equal(env.url_omitted, true);
  assert.equal(env.url, "");
  assert.ok(Buffer.byteLength(p.content[0].text) < 2000);
  const short = JSON.parse(packResult({ url: "https://a.test/ok", filler: "y".repeat(120_000) }).content[0].text);
  assert.deepEqual([short.url, short.url_omitted], ["https://a.test/ok", undefined]);
  // end to end over MCP: a read of a 110,000-character URL, and an absurd history date
  const s = await start((req, res) => (req.url === "/robots.txt" ? text(res, "", 404) : html(res, ANVILS)));
  const client = await connect();
  const r = await client.callTool({ name: "read", arguments: { url: s.url + "/" + "z".repeat(110_000) } });
  assert.ok(Buffer.byteLength((r.content as any)[0].text) < 100_000, `read fallback is ${Buffer.byteLength((r.content as any)[0].text)} bytes`);
  const h = await client.callTool({ name: "history", arguments: { since: "q".repeat(200_000) } });
  assert.ok(Buffer.byteLength((h.content as any)[0].text) < 2000);
});

test("W-03 round 38: fresh: true and a resume retry never reuse a body from an earlier call (recentBodies)", async () => {
  freshHome();
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    if (req.url === "/llms.txt") return text(res, "# Anvils\n\nThe llms body about anvils.\n");
    html(res, ANVILS);
  });
  await engine.doors(s.url + "/", { agent: "a" }); // probes llms.txt and keeps its body for 30 s
  const n = s.count("/llms.txt");
  const r = await engine.read(s.url + "/", { fresh: true }, { agent: "a" });
  assert.equal(r.door_detail, "llms.txt");
  assert.equal(s.count("/llms.txt"), n + 1, "fresh: true asked the site itself");
  // a resume retry is forced fresh too
  await engine.doors(s.url + "/", { agent: "a" });
  const id = handoffs.create({ url: s.url + "/", reason: "forbidden", agent: "a" }).ticket!.id;
  const m = s.count("/llms.txt");
  const back = await engine.resume(id, undefined, { agent: "a" });
  assert.deepEqual(back.ticket, { id, open: false });
  assert.equal(s.count("/llms.txt"), m + 1, "the retry asked the site itself");
});

test("Round 38: reply budgets count UTF-8 bytes; CJK text never pushes an MCP reply past 60 KB", async () => {
  freshHome();
  const cjk = (n: number) => "\u4e2d\u6587".repeat(Math.ceil(n / 2)).slice(0, n);
  // the last guard itself: under 100,000 characters but over 100 KB of UTF-8 is replaced
  const { packResult } = await import("../mcp.js");
  const packed = packResult({ url: "x", note: cjk(40_000) });
  assert.equal(packed.isError, true);
  assert.ok(Buffer.byteLength(packed.content[0].text) < 1000);
  const sizes = (r: any) => Buffer.byteLength(r.content[0].text);
  // handoff tickets with CJK questions and agent names (the case Codex reproduced at 109 KB)
  const { s } = await walledSite();
  for (let i = 0; i < 12; i++) await engine.read(s.url + "/members/" + i, { question: cjk(1000) }, { agent: cjk(200) });
  const client = await connect(cjk(150));
  const h = await client.callTool({ name: "handoffs", arguments: {} });
  assert.ok(sizes(h) < 60_000, `handoffs page is ${sizes(h)} bytes`);
  assert.ok(body(h).pages > 1);
  // history, receipts, log and needs over CJK records
  const page = `<html><head><title>${cjk(150)}</title></head><body>` + Array.from({ length: 60 }, (_, i) => `<h2>${cjk(250)}${i}</h2><p>${cjk(3900)}</p>`).join("") + "</body></html>";
  const big = await start((req, res) => (req.url === "/robots.txt" || req.url === "/llms.txt" ? text(res, "", 404) : html(res, page)));
  for (let i = 0; i < 4; i++) await client.callTool({ name: "read", arguments: { url: big.url + "/p" + i, question: cjk(900) } });
  for (const [name, args] of [["read", { url: big.url + "/p0" }], ["read", { url: big.url + "/p0", section: 2 }], ["read", { url: big.url + "/p0", question: cjk(300) }],
    ["history", {}], ["receipts", {}], ["log", {}], ["needs_report", {}]] as const) {
    const r = await client.callTool({ name, arguments: args as any });
    assert.ok(!r.isError, `${name} is not an error`);
    assert.ok(sizes(r) < 60_000, `${name} ${JSON.stringify(args).slice(0, 60)} is ${sizes(r)} bytes`);
  }
});

test("Round 38: history, receipts, log and needs pages count UTF-8 bytes over many CJK records", async () => {
  freshHome();
  const cjk = (n: number) => "\u4e2d\u6587".repeat(Math.ceil(n / 2)).slice(0, n);
  const history = await import("../history.js");
  const receipts = await import("../receipts.js");
  const now = new Date().toISOString();
  for (let i = 0; i < 120; i++)
    history.record({ time: now, tool: "read", url: `https://h${i}.test/p`, agent: cjk(190), purpose: cjk(1000), status: "ok", door: "text", matched: 0 });
  receipts.record(Array.from({ length: 30 }, (_, i) => ({ quote: cjk(4000) + i, url: "https://r.test/p", section: 1, fetched_at: now })));
  const client = await connect();
  const sizes = (r: any) => Buffer.byteLength(r.content[0].text);
  for (const [name, args] of [["history", {}], ["receipts", {}], ["log", {}], ["needs_report", {}]] as const) {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, `${name} is not an error`);
    assert.ok(sizes(r) < 60_000, `${name} is ${sizes(r)} bytes`);
  }
});

test("Round 38: watch over CJK changes stays under 60 KB of UTF-8", async () => {
  freshHome();
  let v = 0;
  const cjk = (n: number) => "\u4e2d\u6587".repeat(Math.ceil(n / 2)).slice(0, n);
  const s = await start((req, res) => {
    if (req.url === "/robots.txt" || req.url === "/llms.txt") return text(res, "", 404);
    html(res, `<html><body>${Array.from({ length: 8 }, (_, i) => `<h2>${cjk(200)}${i}</h2><p>${cjk(3500)}${v}</p>`).join("")}</body></html>`);
  });
  for (let i = 0; i < 10; i++) await engine.bookmark("add", "w" + i, s.url + "/w" + i, true);
  const client = await connect();
  await client.callTool({ name: "watch", arguments: {} });
  v = 1;
  const r = await client.callTool({ name: "watch", arguments: {} });
  assert.equal(body(r).counts.changed, 10);
  assert.ok(Buffer.byteLength((r.content as any)[0].text) < 60_000, `watch is ${Buffer.byteLength((r.content as any)[0].text)} bytes`);
});

test("Round 38: clear counts the bytes of removed handoff tickets", async () => {
  freshHome();
  const { s } = await walledSite();
  await engine.read(s.url + "/members", {}, { agent: "a" });
  const r = await cleanup.clearStore({ all: true });
  assert.equal(r.handoffs.removed, 1);
  assert.ok(r.handoffs.bytes_freed > 0);
  assert.ok(r.total_bytes_freed >= r.handoffs.bytes_freed, "the total includes the tickets");
  const rest = r.history.bytes_freed + r.receipts.bytes_freed + r.cache.bytes_freed;
  assert.equal(r.total_bytes_freed, rest + r.handoffs.bytes_freed);
});

test("W-03: a fresh copy never skips robots.txt or a site's wait", async () => {
  freshHome();
  let robots = "";
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") return text(res, robots, robots ? 200 : 404);
    if (req.url === "/llms.txt") return text(res, "", 404);
    html(res, ANVILS, { "cache-control": "max-age=600" });
  });
  await engine.read(s.url + "/p", {}, { agent: "a" });
  robots = "User-agent: *\nDisallow: /p\n";
  (await import("../rules.js")).resetRulesCache();
  const r = await engine.read(s.url + "/p", {}, { agent: "b" });
  assert.equal(r.status, "refused", "the site's rules win over the cache");
});

test("W-03: two processes writing and reading one cache entry never see a torn or mixed file", async () => {
  const home = freshHome();
  store.home();
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "cacheproc.js");
  const runOne = (who: string) =>
    new Promise<{ who: string; bad: number; seen: number }>((resolve, reject) => {
      const p = spawn(process.execPath, [script, home, "https://shared.test/page", who, "150"], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("error", reject);
      p.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child exited ${code}`))));
    });
  const [a, b] = await Promise.all([runOne("a"), runOne("b")]);
  assert.ok(a.seen > 0 && b.seen > 0);
  assert.equal(a.bad + b.bad, 0, "every read found one whole entry from one writer");
  const final = store.readJson<{ who: string; pad: string }>(store.cachePath("https://shared.test/page"));
  assert.ok(final && (final.who === "a" || final.who === "b"));
  assert.deepEqual(fs.readdirSync(path.join(home, "cache")).filter((n) => n.endsWith(".tmp")), [], "no temp files left behind");
});
