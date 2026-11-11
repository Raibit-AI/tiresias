// SPDX-License-Identifier: Apache-2.0
// v0.3 memory features: W-12 needs report, W-02 diffs, W-16 bookmarks and watchlist.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { freshHome, html, logText, serve, text, type TestServer } from "./helper.js";

freshHome();
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
delete process.env.TIRESIAS_PRIVATE;
const engine = await import("../engine.js");
const store = await import("../store.js");
const history = await import("../history.js");
const needs = await import("../needs.js");
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
const home = () => store.home();
const readHistory = () => logText(home(), "history").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const writeDay = (day: string, lines: unknown[]) => {
  fs.mkdirSync(path.join(home(), "history"), { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(home(), "history", day + ".jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { mode: 0o600 });
};
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
// One synthetic history record, written into the right UTC day file.
const rec = (o: Record<string, unknown>) => {
  const time = (o.time as string) ?? ago(1);
  writeDay(store.utcDay(Date.parse(time)), [{ time, tool: "read", agent: "a", status: "ok", door: "text", ...o }]);
};
async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  const client = new Client({ name: "v03-agent", version: "1" });
  await client.connect(b);
  return client;
}
const body = (r: any) => JSON.parse(r.content[0].text);

const ANVILS = "<html><head><title>Anvils</title></head><body><h1>Anvils</h1><p>Heavy iron anvils for sale.</p></body></html>";

// ---- W-12: new history fields ----

test("W-12: history records the wall reason, passages matched, best door and llms.txt", async () => {
  freshHome();
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    if (req.url === "/llms.txt") return text(res, "", 404);
    if (req.url === "/.well-known/mcp.json") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ name: "x", endpoint: "https://x.test/mcp" }));
    }
    if (req.url === "/walled") return html(res, "<html><body>no</body></html>", {}, 403);
    html(res, ANVILS);
  });
  await engine.read(s.url + "/", { question: "anvils" }, { agent: "t" });
  await engine.read(s.url + "/", { question: "zebras" }, { agent: "t" });
  await engine.read(s.url + "/walled", {}, { agent: "t" });
  const h = readHistory();
  assert.equal(h[0].matched, 1);
  assert.equal(h[1].matched, 0, "a question that found nothing records 0");
  assert.equal(h[2].status, "wall");
  assert.equal(h[2].reason, "forbidden");
  assert.equal(h[0].reason, undefined);
  for (const e of h) assert.equal(typeof e.best_door, "string", "every read looked at the doors, the walled one too");
  assert.equal(h[0].best_door, "mcp");
  assert.equal(h[0].door, "text");
  // check never probes, so it records no best door; a read without a question records no matched
  await engine.check(s.url + "/", { agent: "t" });
  await engine.read(s.url + "/", {}, { agent: "t" });
  const h2 = readHistory();
  assert.equal(h2[3].best_door, undefined);
  assert.equal(h2[4].matched, undefined);
  // private records nothing at all
  await engine.read(s.url + "/", { question: "anvils" }, { agent: "t", private: true });
  assert.equal(readHistory().length, 5);
});

test("W-12: llms.txt is recorded, and the new fields are bounded on write and on read", async () => {
  freshHome();
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    if (req.url === "/llms.txt") return text(res, "# Site\n\nThe llms body about anvils.\n");
    html(res, ANVILS);
  });
  await engine.read(s.url + "/", {}, { agent: "t" });
  assert.equal(readHistory()[0].llms_txt, true);
  // write: unknown codes and odd numbers are left out, and the record says cut
  history.record({ time: new Date().toISOString(), tool: "read", url: "https://a.test/", agent: "x", status: "wall", door: "none", reason: "x".repeat(50_000), matched: -1, best_door: "teleport", llms_txt: "yes" as any });
  const w = readHistory().at(-1);
  assert.equal(w.reason, undefined);
  assert.equal(w.matched, undefined);
  assert.equal(w.best_door, undefined);
  assert.equal(w.llms_txt, undefined);
  assert.equal(w.cut, true);
  assert.ok(JSON.stringify(w).length < 1000);
  // read: a record written by something else is cut the same way when it is read back
  rec({ time: new Date().toISOString(), url: "https://b.test/", reason: "y".repeat(200_000), matched: 1e9, best_door: { a: 1 } });
  const q = await engine.queryHistory({ site: "b.test" });
  assert.equal(q.total, 1);
  assert.equal(q.items[0].reason, undefined);
  assert.equal(q.items[0].matched, undefined);
  assert.equal(q.items[0].best_door, undefined);
  assert.equal(q.items[0].cut, true);
  // good values survive untouched, with no cut mark
  rec({ time: new Date().toISOString(), url: "https://c.test/", status: "wall", door: "none", reason: "captcha", matched: 0, best_door: "feed", llms_txt: true });
  const ok = (await engine.queryHistory({ site: "c.test" })).items[0];
  assert.deepEqual([ok.reason, ok.matched, ok.best_door, ok.llms_txt, ok.cut], ["captcha", 0, "feed", true, undefined]);
});

// ---- W-12: the report ----

function seedPatterns() {
  // walls: 3 on walled.test (2 captcha, 1 login), 1 on other.test
  rec({ url: "https://walled.test/a", status: "wall", door: "none", reason: "captcha" });
  rec({ url: "https://walled.test/b", status: "wall", door: "none", reason: "captcha" });
  rec({ url: "https://walled.test/c", status: "wall", door: "none", reason: "login_required" });
  rec({ url: "https://other.test/", status: "wall", door: "none", reason: "forbidden" });
  // empty questions
  rec({ url: "https://docs.test/x", purpose: "where is the zebra", matched: 0, best_door: "text" });
  rec({ url: "https://docs.test/y", purpose: "where is the zebra", matched: 0, best_door: "text" });
  rec({ url: "https://docs.test/z", purpose: "found it", matched: 2, best_door: "text" });
  // better door: api.test advertises an API but the page was read
  rec({ url: "https://api.test/p", best_door: "api" });
  rec({ url: "https://api.test/p", best_door: "api", status: "unchanged" });
  rec({ url: "https://api.test/q", best_door: "api", door: "structured" });
  // feeds.test has a door, and it was read through the page text too (better door again)
  rec({ url: "https://feeds.test/", best_door: "feed" });
  // data.test offers structured data, which Tiresias reads: since v0.5.1 the only kind of better door counted
  rec({ url: "https://data.test/", best_door: "structured" });
  // llms.test: three visits, best door text, but an llms.txt: it HAS a door
  for (let i = 0; i < 3; i++) rec({ url: "https://llms.test/", best_door: "text", llms_txt: true });
  // plain.test: four visits, no door of any kind (one check, which does not judge doors)
  for (let i = 0; i < 3; i++) rec({ url: "https://plain.test/" + i, best_door: "text" });
  rec({ url: "https://plain.test/", tool: "check" });
  // checked.test: visited often but only by check, so its doors were never looked at: not judged
  for (let i = 0; i < 3; i++) rec({ url: "https://checked.test/", tool: "check" });
  // too old for the default window
  rec({ time: ago(45), url: "https://ancient.test/", status: "wall", door: "none", reason: "captcha" });
}

test("W-12: the report finds each pattern, with exact counts, suggestions and IDs", async () => {
  freshHome();
  seedPatterns();
  const r = await engine.needsReport();
  assert.equal(r.status, "ok");
  assert.equal(r.counts.records, 22, "the 45-day-old record is outside the default 30 days");
  const rows = r.untrusted_content.rows;
  const of = (p: string) => rows.filter((x) => x.pattern === p);
  assert.deepEqual(of("walls").map((x) => [x.host, x.reason, x.count]), [["walled.test", "captcha", 2], ["other.test", "forbidden", 1], ["walled.test", "login_required", 1]]);
  assert.equal(r.counts.walls.records, 4);
  assert.equal(r.counts.walls.groups, 3);
  assert.deepEqual(of("empty").map((x) => [x.host, x.question, x.count]), [["docs.test", "where is the zebra", 2]]);
  // v0.5.1: API and feed doors are found, not read, so they are not counted as a better door
  assert.deepEqual(of("better_door").map((x) => [x.host, x.used, x.best, x.count]), [["data.test", "text", "structured", 1]]);
  assert.equal(r.counts.better_door.records, 1);
  assert.equal(r.counts.better_door_compared, 14);
  // rereads: only pages read twice or more (llms.test/ 3 times, api.test/p twice)
  assert.deepEqual(of("rereads").map((x) => [x.url, x.count]), [["https://llms.test/", 3], ["https://api.test/p", 2]]);
  assert.deepEqual(of("no_door").map((x) => [x.host, x.count]), [["plain.test", 4], ["docs.test", 3]], "llms.test has a door; checked.test was never judged");
  const ids = r.suggestions.map((s) => [s.pattern, s.related.join(",")]);
  assert.deepEqual(ids, [["walls", "W-06"], ["empty", "W-10"], ["better_door", "N-01"], ["rereads", "W-03,W-16"], ["no_door", ""]]);
  assert.match(r.suggestions[0].text, /^4 visits stopped at a wall/);
  // nothing from a record sits at the top level
  const top = JSON.stringify({ ...r, untrusted_content: null });
  for (const bad of ["walled.test", "zebra", "llms.test", "plain.test", "https://"]) assert.ok(!top.includes(bad), bad);
  // a wider window brings in the old wall
  assert.equal((await engine.needsReport("60d")).counts.walls.records, 5);
  assert.equal((await engine.needsReport(new Date(Date.now() - 50 * 86_400_000).toISOString().slice(0, 10))).counts.walls.records, 5);
  await assert.rejects(() => engine.needsReport("last week"), /Cannot read that date/);
});

test("W-12: the report writes nothing, an empty store reports nothing, and old records still count", async () => {
  freshHome();
  const before = fs.readdirSync(store.homeDir());
  const empty = await engine.needsReport();
  assert.equal(empty.counts.records, 0);
  assert.equal(empty.suggestions.length, 0);
  assert.match(empty.message, /No history in this window/);
  assert.deepEqual(fs.readdirSync(store.homeDir()), before, "building the report writes nothing");
  // a v0.2 record (no new fields) is counted and can still be a reread or a wall with an unknown reason
  rec({ url: "https://v02.test/", status: "wall", door: "none" });
  rec({ url: "https://v02.test/r" });
  rec({ url: "https://v02.test/r" });
  const r = await engine.needsReport();
  assert.equal(r.counts.records, 3);
  assert.deepEqual(r.untrusted_content.rows.filter((x) => x.pattern === "walls").map((x) => x.reason), ["unknown"]);
  assert.equal(r.counts.rereads.groups, 1);
  assert.equal(r.counts.no_door.groups, 0, "no record looked at the doors, so the site is not judged");
});

test("W-12: top lists are bounded, groups past the cap are counted, and rows come in pages", async () => {
  freshHome();
  const lines = [];
  const t = ago(1);
  for (let i = 0; i < 400; i++) for (let j = 0; j < 2; j++) lines.push({ time: t, tool: "read", agent: "a", status: "ok", door: "text", url: `https://s${i}.test/` + "p".repeat(3000) });
  writeDay(store.utcDay(Date.parse(t)), lines);
  const r = await engine.needsReport();
  assert.equal(r.counts.rereads.groups, 400, "exact count of pages read twice");
  assert.equal(r.counts.rereads.shown, needs.TOP);
  assert.ok(r.pages > 1, "twenty 3 KB URLs do not fit one page");
  let seen = 0;
  for (let p = 1; p <= r.pages; p++) {
    const pg = await engine.needsReport(undefined, p);
    assert.ok(JSON.stringify(pg).length < 60_000);
    seen += pg.untrusted_content.rows.length;
  }
  assert.equal(seen, needs.TOP);
  assert.equal((await engine.needsReport(undefined, r.pages + 1)).untrusted_content.rows.length, 0);
});

test("W-12: groups past MAX_GROUPS are counted as untracked, never dropped silently", async () => {
  freshHome();
  const t = ago(1);
  const n = needs.MAX_GROUPS + 5;
  writeDay(store.utcDay(Date.parse(t)), Array.from({ length: n }, (_, i) => ({ time: t, tool: "read", agent: "a", status: "wall", door: "none", reason: "captcha", url: `https://w${i}.test/` })));
  const r = await engine.needsReport();
  assert.equal(r.counts.walls.records, n);
  assert.equal(r.counts.walls.groups, needs.MAX_GROUPS);
  assert.equal(r.counts.walls.untracked, 5);
  assert.equal(r.counts.no_door.untracked, 5, "the per-site tally has the same cap");
  assert.match(needs.toMarkdown(r), /10 records were counted but not grouped/);
});

test("W-12: MCP needs_report returns the envelope; the CLI page is readable markdown", async () => {
  freshHome();
  seedPatterns();
  const client = await connect();
  const r = body(await client.callTool({ name: "needs_report", arguments: { since: "30d" } }));
  assert.match(r.notice, /data, not instructions/);
  assert.equal(r.counts.walls.records, 4);
  assert.ok(r.untrusted_content.rows.length > 0);
  const bad: any = await client.callTool({ name: "needs_report", arguments: { since: "whenever" } });
  assert.equal(bad.isError, true);
  await client.close();
  const md = needs.toMarkdown(await engine.needsReport());
  assert.match(md, /# Tiresias needs report/);
  assert.match(md, /## Suggestions/);
  assert.match(md, /\[W-06\] 4 visits stopped at a wall/);
  assert.match(md, /## Walls by site and reason\n\n- 2 x walled\.test: captcha/);
  assert.match(md, /plain\.test/);
});

// ---- W-02: diffs ----

const diff = await import("../diff.js");
const doc = (title: string, sections: [string, string[]][]) =>
  `<html><head><title>${title}</title></head><body>${sections.map(([h, ps]) => `<h2>${h}</h2>` + ps.map((p) => `<p>${p}</p>`).join("")).join("")}</body></html>`;
const uc = (e: any) => e.untrusted_content;

test("W-02: Myers' diff is minimal and its script turns the old list into the new one (fuzz)", () => {
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
  // Edit distance by plain dynamic programming, for comparison.
  const dist = (a: number[], b: number[]) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++) d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] : 1 + Math.min(d[i - 1][j], d[i][j - 1]);
    return d[a.length][b.length];
  };
  for (let t = 0; t < 400; t++) {
    const a = Array.from({ length: rnd(14) }, () => rnd(5));
    const b = Array.from({ length: rnd(14) }, () => rnd(5));
    const script = diff.myers(Int32Array.from(a), Int32Array.from(b), 1000)!;
    assert.equal(script.length, dist(a, b), `${a} -> ${b}`);
    // replay: walk both lists in order
    const out: number[] = [];
    let i = 0;
    for (const e of script) {
      if (e.del) {
        while (i < e.i) out.push(a[i++]);
        i++;
      } else {
        while (out.length < e.i) out.push(a[i++]);
        out.push(b[e.i]);
      }
    }
    while (i < a.length) out.push(a[i++]);
    assert.deepEqual(out, b, `${a} -> ${b}`);
  }
  assert.equal(diff.myers(Int32Array.from([1, 2, 3]), Int32Array.from([4, 5, 6]), 5), null, "past maxD it gives up");
});

test("W-02: check returns what changed, added blocks with receipts, removed without, exact counts", async () => {
  freshHome();
  let page = doc("Garden", [["Pests", ["Carrot flies are a menace.", "Slugs eat lettuce."]], ["Tools", ["A spade.", "A hoe."]]]);
  const s = await start((req, res) => (req.url === "/robots.txt" ? text(res, "", 404) : html(res, page)));
  const first = await engine.check(s.url + "/g");
  assert.match(first.message ?? "", /First visit/);
  assert.equal(uc(first).changes, undefined);
  page = doc("Garden", [["Pests", ["Aphids are a menace.", "Slugs eat lettuce."]], ["Tools", ["A spade.", "A hoe.", "A rake."]], ["Seeds", ["Beans."]]]);
  const c = await engine.check(s.url + "/g");
  assert.equal(c.status, "ok");
  assert.match(c.message ?? "", /^Changed since .*: 4 blocks added, 1 removed\. The new version is cached\.$/);
  assert.equal(c.counts?.added, 4);
  assert.equal(c.counts?.removed, 1);
  const ch = uc(c).changes;
  assert.deepEqual(ch.map((x: any) => [x.kind, x.text]), [["removed", "Carrot flies are a menace."], ["added", "Aphids are a menace."], ["added", "A rake."], ["added", "Seeds"], ["added", "Beans."]]);
  assert.equal(ch[0].heading, "Pests");
  // every added block has a receipt quoting it exactly, at its section on the new page; removed ones have none
  const rs = uc(c).receipts;
  assert.equal(rs.length, 4);
  for (const x of ch.filter((x: any) => x.kind === "added")) assert.ok(rs.some((r: any) => r.quote === x.text && r.section === x.section && r.url === s.url + "/g"));
  assert.ok(!rs.some((r: any) => r.quote === "Carrot flies are a menace."));
  assert.equal(c.counts?.receipts, 4);
  // the receipts are logged too
  assert.match(logText(home(), "receipts"), /A rake\./);
  // nothing web-derived at the top level
  assert.ok(!JSON.stringify({ ...c, untrusted_content: null }).includes("Aphids"));
  // the new copy is now the baseline
  const again = await engine.check(s.url + "/g");
  assert.equal(again.status, "unchanged");
  assert.equal(uc(again).changes, undefined, "page 1 of an unchanged page is just 'unchanged'");
  // ...but asking for a page of the list returns the kept list
  const kept = await engine.check(s.url + "/g", undefined, { page: 1 });
  assert.equal(kept.status, "unchanged");
  assert.equal(uc(kept).changes.length, 5);
  assert.match(kept.message ?? "", /These are the changes found when it last changed/);
});

test("W-02: read with changes returns them alongside the outline; without it, no diff work and no kept list", async () => {
  freshHome();
  let page = doc("News", [["Today", ["Rain is coming."]]]);
  const s = await start((req, res) => (req.url === "/robots.txt" ? text(res, "", 404) : html(res, page)));
  const first = await engine.read(s.url + "/n", { changes: true });
  assert.equal(first.message, "There was nothing to compare against: no earlier copy of this page is kept (first visit, a cleared or expired cache, or private mode).");
  assert.equal(uc(first).changes, undefined);
  assert.ok(uc(first).outline.length > 0);
  page = doc("News", [["Today", ["Sun is coming."]]]);
  const r = await engine.read(s.url + "/n", { changes: true });
  assert.equal(r.status, "ok");
  assert.ok(uc(r).outline.length > 0, "the normal result is still there");
  assert.deepEqual(uc(r).changes.map((x: any) => [x.kind, x.text]), [["removed", "Rain is coming."], ["added", "Sun is coming."]]);
  assert.ok(uc(r).receipts.some((x: any) => x.quote === "Sun is coming."));
  page = doc("News", [["Today", ["Snow is coming."]]]);
  const plain = await engine.read(s.url + "/n");
  assert.equal(uc(plain).changes, undefined);
  assert.equal(store.readJson<any>(store.cachePath(s.url + "/n")).changes, undefined, "a plain read keeps no list of changes");
});

test("W-02: no baseline in private mode, after a parser upgrade, from another source, or for no-store", async () => {
  freshHome();
  let page = doc("P", [["A", ["One."]]]);
  let headers: Record<string, string> = {};
  const s = await start((req, res) => (req.url === "/robots.txt" ? text(res, "", 404) : html(res, page, headers)));
  await engine.check(s.url + "/p");
  page = doc("P", [["A", ["Two."]]]);
  // private: never reads the cache, so nothing to compare and the cached copy is untouched
  const p = await engine.check(s.url + "/p", { agent: "t", private: true });
  assert.equal(uc(p).changes, undefined);
  assert.equal(p.private, true);
  assert.match(p.message ?? "", /Private check/);
  const r = await engine.read(s.url + "/p", { changes: true }, { agent: "t", private: true });
  assert.equal(uc(r).changes, undefined);
  assert.match(r.message ?? "", /nothing to compare against/);
  // an older reader made the kept copy
  const file = store.cachePath(s.url + "/p");
  const entry = store.readJson<any>(file);
  entry.parser = 1;
  store.writeJson(file, entry);
  const old = await engine.check(s.url + "/p");
  assert.equal(uc(old).changes, undefined);
  assert.match(old.message ?? "", /older version of the reader/);
  // no-store: nothing to compare against and nothing kept
  page = doc("P", [["A", ["Three."]]]);
  headers = { "cache-control": "no-store" };
  const ns = await engine.check(s.url + "/p");
  assert.equal(uc(ns).changes, undefined);
  assert.match(ns.message ?? "", /no-store/);
  assert.doesNotMatch(ns.message ?? "", /cached/);
  assert.equal(store.readJson(file), null);
});

test("W-02: a page now read from another source (llms.txt appeared) has nothing to compare against", async () => {
  freshHome();
  let llms = false;
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    if (req.url === "/llms.txt") return llms ? text(res, "# Site\n\nNow with llms.\n") : text(res, "", 404);
    html(res, doc("Root", [["A", ["Root page."]]]));
  });
  assert.equal((await engine.read(s.url + "/")).door_detail, "html");
  llms = true;
  store.rmRegular(store.cachePath("doors:" + new URL(s.url).origin)); // forget the discovery result
  const r = await engine.read(s.url + "/", { changes: true });
  assert.equal(r.door_detail, "llms.txt");
  assert.equal(uc(r).changes, undefined);
  assert.match(r.message ?? "", /different source/);
});

test("W-02: a 304 means unchanged and no diff is worked out", async () => {
  freshHome();
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    if (req.headers["if-none-match"] === '"v1"') {
      res.writeHead(304, { etag: '"v1"' });
      return void res.end();
    }
    html(res, doc("E", [["A", ["Body."]]]), { etag: '"v1"' });
  });
  await engine.check(s.url + "/e");
  const c = await engine.check(s.url + "/e");
  assert.equal(c.status, "unchanged");
  assert.equal(uc(c).changes, undefined);
  assert.equal(c.counts?.added, undefined);
});

test("W-02: a long list of changes comes in pages; later pages are read from the kept list", async () => {
  freshHome();
  const para = (tag: string, i: number) => `${tag} paragraph number ${i} ` + "x".repeat(300);
  let page = doc("L", [["All", Array.from({ length: 200 }, (_, i) => para("old", i))]]);
  const s = await start((req, res) => (req.url === "/robots.txt" ? text(res, "", 404) : html(res, page)));
  await engine.check(s.url + "/l");
  page = doc("L", [["All", Array.from({ length: 200 }, (_, i) => para("new", i))]]);
  const c = await engine.check(s.url + "/l");
  assert.equal(c.counts?.added, 200);
  assert.equal(c.counts?.removed, 200);
  const pages = uc(c).changes_pages;
  assert.ok(pages > 2);
  // the page budget counts what is really sent: the changes AND their receipts
  assert.ok(JSON.stringify(uc(c).changes).length + JSON.stringify(uc(c).receipts ?? []).length <= 21_000);
  let added = uc(c).changes.filter((x: any) => x.kind === "added").length;
  let removed = uc(c).changes.length - added;
  for (let p = 2; p <= pages; p++) {
    const next = await engine.check(s.url + "/l", undefined, { page: p });
    assert.equal(next.status, "unchanged");
    assert.equal(uc(next).changes_page, p);
    assert.ok(JSON.stringify(uc(next).changes).length + JSON.stringify(uc(next).receipts ?? []).length <= 21_000, `page ${p} fits the budget`);
    const a = uc(next).changes.filter((x: any) => x.kind === "added");
    assert.equal((uc(next).receipts ?? []).length, a.length, "one receipt per added block, none for removed");
    added += a.length;
    removed += uc(next).changes.length - a.length;
  }
  assert.deepEqual([added, removed], [200, 200], "every change is on exactly one page");
});

test("W-02: past the caps the list is omitted with a fixed message, never guessed", async () => {
  freshHome();
  let page = doc("Big", [["All", Array.from({ length: 10 }, (_, i) => `p${i}`)]]);
  const s = await start((req, res) => (req.url === "/robots.txt" ? text(res, "", 404) : html(res, page)));
  await engine.check(s.url + "/b");
  // more than MAX_EDITS changed blocks
  page = doc("Big", [["All", Array.from({ length: diff.MAX_EDITS + 10 }, (_, i) => `q${i}`)]]);
  const c = await engine.check(s.url + "/b");
  assert.equal(c.status, "ok");
  assert.equal(c.changes_omitted, true);
  assert.match(c.message ?? "", /Too much changed to list/);
  assert.equal(uc(c).changes, undefined);
  // more than MAX_DIFF_BLOCKS blocks on a side
  page = doc("Big", [["All", Array.from({ length: diff.MAX_DIFF_BLOCKS + 1 }, (_, i) => `r${i}`)]]);
  assert.equal((await engine.check(s.url + "/b")).changes_omitted, true);
  assert.deepEqual(diff.diffSections([], [{ n: 1, level: 1, heading: "h", blocks: Array.from({ length: diff.MAX_DIFF_BLOCKS + 1 }, (_, i) => ({ text: "b" + i, marks: [] })) }]), { omitted: true, reason: "too_many_blocks" });
});

test("W-02: the diff runs in the worker under the parse budget for big pages", async () => {
  const sandbox = await import("../sandbox.js");
  const sec = (tag: string) => [{ n: 1, level: 1, heading: "h", blocks: Array.from({ length: 3000 }, (_, i) => ({ text: `${tag}${i} ` + "y".repeat(10), marks: [] as [number, number][] })) }];
  const big = sec("a");
  const size = JSON.stringify(big).length;
  assert.ok(size > sandbox.INLINE_MAX);
  const r = await sandbox.runUntrusted<any>({ op: "diff", old: big, new: sec("a").map((s) => ({ ...s, blocks: s.blocks.slice(1) })) }, size * 2);
  assert.deepEqual([r.added, r.removed], [0, 1]);
  // under a tiny budget, a heavy diff is stopped like any other page work
  process.env.TIRESIAS_PARSE_BUDGET_MS = "1";
  try {
    await assert.rejects(() => sandbox.runUntrusted({ op: "diff", old: sec("a"), new: sec("b") }, size * 2), sandbox.PageTooComplex);
  } finally {
    delete process.env.TIRESIAS_PARSE_BUDGET_MS;
    sandbox.stopWorker();
  }
});

// ---- W-16: bookmarks and the watchlist ----

const bm = await import("../bookmarks.js");
const cleanup = await import("../cleanup.js");
const bdir = () => path.join(store.homeDir(), "bookmarks");

test("W-16: add, list, watch on and off, remove; one file each, owner-only", async () => {
  freshHome();
  const a = await engine.bookmark("add", "anvil-shop", "https://example.com/anvils#top", true);
  assert.equal(a.status, "ok");
  assert.deepEqual({ ...a.untrusted_content!.bookmark, added_at: "" }, { name: "anvil-shop", url: "https://example.com/anvils", watch: true, added_at: "" });
  await engine.bookmark("add", "docs", "https://example.com/docs");
  assert.deepEqual(fs.readdirSync(bdir()).sort(), ["anvil-shop.json", "docs.json"]);
  assert.equal(fs.statSync(bdir()).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(bdir(), "docs.json")).mode & 0o777, 0o600);
  const l = engine.bookmarkList();
  assert.deepEqual(l.untrusted_content!.bookmarks!.map((b) => [b.name, b.watch]), [["anvil-shop", true], ["docs", false]]);
  assert.equal(l.counts!.bookmarks, 2);
  assert.ok(!JSON.stringify({ ...l, untrusted_content: null }).includes("example.com"), "URLs only inside untrusted_content");
  assert.equal((await engine.bookmark("watch", "docs", undefined, true)).status, "ok");
  assert.equal((await engine.bookmark("watch", "anvil-shop", undefined, false)).status, "ok");
  assert.deepEqual(engine.bookmarkList().untrusted_content!.bookmarks!.map((b) => [b.name, b.watch]), [["anvil-shop", false], ["docs", true]]);
  assert.deepEqual(fs.readdirSync(bdir()).sort(), ["anvil-shop.json", "docs.json"], "no temp file left behind");
  assert.equal((await engine.bookmark("remove", "docs", undefined, undefined)).status, "ok");
  assert.deepEqual(fs.readdirSync(bdir()), ["anvil-shop.json"]);
  const gone = await engine.bookmark("remove", "docs", undefined, undefined);
  assert.equal(gone.status, "error");
  assert.match(gone.message, /no bookmark with that name/);
  assert.match((await engine.bookmark("watch", "nope", undefined, true)).message, /no bookmark with that name/);
});

test("W-16: bad names, duplicates and bad URLs are refused with a clear message", async () => {
  freshHome();
  for (const bad of ["Anvils", "../x", "a b", "", "a".repeat(65), "x.json", "café"]) {
    const r = await engine.bookmark("add", bad, "https://example.com/");
    assert.equal(r.status, "error", bad);
    assert.match(r.message, /1 to 64 characters of a-z, 0-9 and "-"/);
    assert.ok(!r.message.includes(bad) || bad === "", "the refused name is not echoed");
  }
  assert.equal((await engine.bookmark("add", "a".repeat(64), "https://example.com/")).status, "ok");
  await engine.bookmark("add", "dup", "https://example.com/1");
  const dup = await engine.bookmark("add", "dup", "https://example.com/2");
  assert.equal(dup.status, "error");
  assert.match(dup.message, /already exists/);
  assert.equal(engine.bookmarkList().untrusted_content!.bookmarks!.find((b) => b.name === "dup")!.url, "https://example.com/1", "the first one is untouched");
  assert.match((await engine.bookmark("add", "f", "file:///etc/passwd")).message, /Only http and https/);
  assert.match((await engine.bookmark("add", "u", "https://me:pw@example.com/")).message, /username or password/);
  assert.match((await engine.bookmark("add", "long", "https://example.com/" + "x".repeat(3000))).message, /over 2048 characters/);
  assert.match((await engine.bookmark("add", "nourl", undefined)).message, /Give the URL/);
});

test("W-16: the cap is 1,000 bookmarks", async () => {
  freshHome();
  await engine.bookmark("add", "first", "https://example.com/");
  for (let i = 1; i < bm.MAX_BOOKMARKS; i++)
    fs.writeFileSync(path.join(bdir(), `b${i}.json`), JSON.stringify({ name: `b${i}`, url: "https://example.com/", watch: false, added_at: "x" }), { mode: 0o600 });
  const r = await engine.bookmark("add", "one-more", "https://example.com/");
  assert.equal(r.status, "error");
  assert.match(r.message, /already 1000 bookmarks/);
  assert.equal(engine.bookmarkList().counts!.bookmarks, 1000);
  assert.ok(engine.bookmarkList().pages! > 1, "a long list comes in pages");
});

test("W-16: the folder and files are validated: links, odd files and damage are refused or counted", async () => {
  freshHome();
  await engine.bookmark("add", "ok", "https://example.com/");
  fs.writeFileSync(path.join(bdir(), "broken.json"), "{not json", { mode: 0o600 });
  fs.writeFileSync(path.join(bdir(), "wrong-name.json"), JSON.stringify({ name: "other", url: "https://e.com/", watch: false, added_at: "x" }), { mode: 0o600 });
  fs.mkdirSync(path.join(bdir(), "folder.json"));
  fs.symlinkSync(path.join(bdir(), "ok.json"), path.join(bdir(), "link.json"));
  const l = engine.bookmarkList();
  assert.deepEqual(l.untrusted_content!.bookmarks!.map((b) => b.name), ["ok"]);
  assert.equal(l.counts!.damaged, 4);
  const rmLink = await engine.bookmark("remove", "link", undefined, undefined);
  assert.equal(rmLink.status, "error");
  assert.ok(fs.existsSync(path.join(bdir(), "ok.json")), "removing a link never touches its target");
  assert.match((await engine.bookmark("watch", "link", undefined, true)).message, /cannot be read/);
  // a bookmarks folder that is a link is refused, and nothing is written through it
  const elsewhere = fs.mkdtempSync(path.join(path.dirname(store.homeDir()), "tiresias-elsewhere-"));
  fs.rmSync(bdir(), { recursive: true });
  fs.symlinkSync(elsewhere, bdir());
  assert.throws(() => engine.bookmarkList(), /not a plain folder/);
  await assert.rejects(() => engine.bookmark("add", "x", "https://example.com/"), /not a plain folder/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test("W-16: private mode refuses bookmark changes and creates nothing; listing creates nothing", async () => {
  freshHome();
  const fresh = path.join(store.homeDir(), "not-yet");
  process.env.TIRESIAS_HOME = fresh;
  try {
    const r = await engine.bookmark("add", "p", "https://example.com/", false, { agent: "t", private: true });
    assert.equal(r.status, "refused");
    assert.match(r.message, /^Private mode: bookmarks are not added or changed/);
    process.env.TIRESIAS_PRIVATE = "1";
    assert.equal((await engine.bookmark("remove", "p", undefined, undefined)).status, "refused");
    delete process.env.TIRESIAS_PRIVATE;
    assert.equal(engine.bookmarkList().counts!.bookmarks, 0);
    const w = await engine.watch({ agent: "t", private: true }, 1);
    assert.equal(w.private, true);
    assert.equal(w.counts.watched, 0);
    assert.equal(fs.existsSync(fresh), false, "nothing was created");
  } finally {
    delete process.env.TIRESIAS_PRIVATE;
    freshHome();
  }
});

test("W-16: clear and clear --all keep bookmarks, and the disk cap does not count them", async () => {
  freshHome();
  await engine.bookmark("add", "keep-me", "https://example.com/");
  rec({ url: "https://h.test/" });
  // 2 MB of junk in the bookmarks folder (damaged, but it shows what the cap counts)
  fs.writeFileSync(path.join(bdir(), "zz.json"), "x".repeat(2 * 1024 * 1024), { mode: 0o600 });
  const capped = await cleanup.clearStore({ limits: { keep_history_days: 90, keep_receipts_days: 90, keep_cache_days: 30, max_disk_mb: 1, keep_handoff_days: 7 } });
  assert.equal(capped.history.removed, 0, "bookmarks never push history out under the cap");
  assert.ok(capped.store_bytes_after < 1024 * 1024);
  const all = await cleanup.clearStore({ all: true });
  assert.equal(all.history.removed, 1);
  assert.ok(fs.existsSync(path.join(bdir(), "keep-me.json")));
  assert.equal(engine.bookmarkList().counts!.bookmarks, 1);
});

test("W-16: watch checks watched bookmarks only, reports only the changed, and counts the rest", async () => {
  freshHome();
  let news = doc("News", [["Today", ["Rain."]]]);
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") return text(res, "User-agent: *\nDisallow: /private\n");
    if (req.url === "/news") return html(res, news);
    if (req.url === "/still") return html(res, doc("Still", [["A", ["Same."]]]));
    if (req.url === "/walled") return html(res, "<html><body>no</body></html>", {}, 403);
    if (req.url === "/unwatched") return html(res, doc("U", [["A", [String(Date.now())]]]));
    html(res, "<html><body>gone</body></html>", {}, 404);
  });
  const slow = await start((req, res) => (req.url === "/robots.txt" ? text(res, "", 404) : text(res, "slow down", 429, { "retry-after": "3600" })));
  await engine.bookmark("add", "news", s.url + "/news", true);
  await engine.bookmark("add", "still", s.url + "/still", true);
  await engine.bookmark("add", "walled", s.url + "/walled", true);
  await engine.bookmark("add", "robots-no", s.url + "/private/x", true);
  await engine.bookmark("add", "slow", slow.url + "/", true);
  await engine.bookmark("add", "unwatched", s.url + "/unwatched", false);
  const first = await engine.watch({ agent: "cron" });
  assert.deepEqual(first.counts, { watched: 5, checked: 5, changed: 0, unchanged: 0, no_baseline: 2, walled: 1, failed: 2, skipped_cooldown: 0, not_run: 0, receipts: 0, changes_trimmed: 0, file_warnings: 0, attention_omitted: 0, attention_urls_omitted: 0 });
  assert.equal(first.untrusted_content!.changed, undefined);
  // the ones a person may need to act on are named, with fixed codes; URLs stay inside untrusted_content
  assert.deepEqual(first.untrusted_content!.attention!, [
    { name: "robots-no", outcome: "failed", status: "refused" },
    { name: "slow", outcome: "failed", status: "error", retry_after_seconds: 3600 },
    { name: "walled", outcome: "walled", status: "wall", reason: "forbidden" },
  ]);
  assert.deepEqual(first.untrusted_content!.attention_urls!.map((a) => [a.name, a.url, a.open_this]), [
    ["robots-no", s.url + "/private/x", undefined], ["slow", slow.url + "/", undefined], ["walled", s.url + "/walled", s.url + "/walled"],
  ]);
  assert.equal(s.count("/unwatched"), 0, "an unwatched bookmark is never fetched");
  news = doc("News", [["Today", ["Sun."]]]);
  const second = await engine.watch({ agent: "cron" });
  assert.deepEqual(second.counts, { watched: 5, checked: 5, changed: 1, unchanged: 1, no_baseline: 0, walled: 1, failed: 1, skipped_cooldown: 1, not_run: 0, receipts: 1, changes_trimmed: 0, file_warnings: 0, attention_omitted: 0, attention_urls_omitted: 0 });
  const waiting = second.untrusted_content!.attention!.find((a) => a.name === "slow")!;
  assert.equal(waiting.outcome, "waiting");
  assert.equal(waiting.status, "refused");
  assert.ok(waiting.retry_after_seconds! > 3500 && waiting.retry_after_seconds! <= 3600);
  assert.deepEqual(second.untrusted_content!.attention!.map((a) => a.name), ["robots-no", "slow", "walled"], "unchanged and changed ones are not named here");
  const item = second.untrusted_content!.changed![0];
  assert.equal(item.name, "news");
  assert.deepEqual([item.added, item.removed], [1, 1]);
  assert.deepEqual(item.changes!.map((c) => [c.kind, c.text]), [["removed", "Rain."], ["added", "Sun."]]);
  assert.equal(second.untrusted_content!.receipts![0].quote, "Sun.");
  assert.equal(slow.count("/"), 1, "the cooldown was obeyed: the slow site was called once, on the first run");
  // each check is a history line with tool "watch" and the bookmark name as the purpose
  const h = readHistory().filter((e) => e.tool === "watch");
  assert.equal(h.length, 10);
  assert.ok(h.some((e) => e.purpose === "news" && e.agent === "cron"));
  // top level holds no URL or page text
  assert.ok(!JSON.stringify({ ...second, untrusted_content: null }).includes("127.0.0.1"));
});

test("W-16: watch pages over the watchlist, 10 at a time; a private watch keeps nothing", async () => {
  freshHome();
  let v = "one";
  const s = await start((req, res) => (req.url === "/robots.txt" ? text(res, "", 404) : html(res, doc("P", [["A", [`${req.url} base`, ...(v === "one" ? [] : [`${v} ` + "z".repeat(3800)])]]]))));
  for (let i = 0; i < 12; i++) await engine.bookmark("add", `p${String(i).padStart(2, "0")}`, `${s.url}/p${i}`, true);
  const p1 = await engine.watch(undefined, 1);
  assert.deepEqual([p1.counts.watched, p1.counts.checked, p1.page, p1.pages], [12, 10, 1, 2]);
  const p2 = await engine.watch(undefined, 2);
  assert.equal(p2.counts.checked, 2);
  assert.equal((await engine.watch(undefined, 3)).counts.checked, 0);
  v = "two";
  // ten changed pages, each adding a 3.8 KB block plus its receipt: over budget, so lists are trimmed
  const big = await engine.watch(undefined, 1);
  assert.equal(big.counts.changed, 10);
  assert.ok(JSON.stringify(big).length <= 60_000);
  assert.ok(big.counts.changes_trimmed > 0);
  const trimmed = big.untrusted_content!.changed!.filter((c) => c.changes_trimmed);
  assert.equal(trimmed.length, big.counts.changes_trimmed);
  for (const c of trimmed) assert.deepEqual([c.changes, c.added, c.removed], [undefined, 1, 0], "counts stay exact when the list is left out");
  assert.equal(big.counts.receipts, big.untrusted_content!.receipts!.length);
  // the CLI form (no page) checks all twelve
  v = "three";
  const all = await engine.watch();
  assert.equal(all.counts.checked, 12);
  assert.equal(all.counts.changed, 12);
  // private: fresh checks, nothing compared, no history written
  const before = readHistory().length;
  v = "four";
  const priv = await engine.watch({ agent: "t", private: true }, 1);
  assert.equal(priv.private, true);
  assert.equal(priv.counts.no_baseline, 10);
  assert.equal(priv.counts.changed, 0);
  assert.equal(readHistory().length, before);
});

test("W-16: the attention list is bounded at 100 names and counts the rest", async () => {
  freshHome();
  const s = await start((req, res) => (req.url === "/robots.txt" ? text(res, "", 404) : html(res, "<html><body>no</body></html>", {}, 403)));
  for (let i = 0; i < engine.WATCH_ATTENTION + 3; i++)
    fs.writeFileSync(path.join((await engine.bookmark("add", "seed", s.url + "/seed")).status && bdir(), `w${String(i).padStart(3, "0")}.json`), JSON.stringify({ name: `w${String(i).padStart(3, "0")}`, url: `${s.url}/w${i}`, watch: true, added_at: "x" }), { mode: 0o600 });
  await engine.bookmark("remove", "seed");
  const r = await engine.watch();
  assert.equal(r.counts.walled, engine.WATCH_ATTENTION + 3);
  assert.equal(r.untrusted_content!.attention!.length, engine.WATCH_ATTENTION);
  assert.equal(r.untrusted_content!.attention_urls!.length, engine.WATCH_ATTENTION);
  assert.equal(r.counts.attention_omitted, 3);
});

test("W-16: MCP bookmarks, bookmark and watch", async () => {
  freshHome();
  const s = await start((req, res) => (req.url === "/robots.txt" ? text(res, "", 404) : html(res, ANVILS)));
  const client = await connect();
  const added = body(await client.callTool({ name: "bookmark", arguments: { action: "add", name: "anvils", url: s.url + "/", watch: true } }));
  assert.equal(added.status, "ok");
  const bad: any = await client.callTool({ name: "bookmark", arguments: { action: "add", name: "Bad Name", url: s.url + "/" } });
  assert.equal(bad.isError, true);
  const priv = body(await client.callTool({ name: "bookmark", arguments: { action: "remove", name: "anvils", private: true } }));
  assert.equal(priv.status, "refused");
  const list = body(await client.callTool({ name: "bookmarks", arguments: {} }));
  assert.equal(list.untrusted_content.bookmarks[0].name, "anvils");
  const w = body(await client.callTool({ name: "watch", arguments: {} }));
  assert.equal(w.counts.checked, 1);
  assert.equal(w.page, 1);
  assert.equal(readHistory().at(-1).agent, "v03-agent");
  await client.close();
});

// ---- Codex round 36 ----

test("round 36 #1: watch shows the start of check's page 1, with check's own page count, so continuing with check skips nothing", async () => {
  freshHome();
  let v = "old";
  const s = await start((req, res) => (req.url === "/robots.txt" ? text(res, "", 404) : html(res, doc("L", [["All", Array.from({ length: 60 }, (_, i) => `${v} block ${i} ` + "w".repeat(300))]]))));
  await engine.bookmark("add", "long", s.url + "/l", true);
  await engine.watch(undefined, 1);
  v = "new";
  const w = await engine.watch(undefined, 1);
  const item = w.untrusted_content!.changed![0];
  assert.equal(item.changes_more, true);
  // follow the advice: check from page 1
  const first = await engine.check(s.url + "/l", undefined, { page: 1 });
  assert.equal(item.changes_pages, uc(first).changes_pages, "watch advertises check's page numbers");
  assert.deepEqual(item.changes, uc(first).changes.slice(0, item.changes!.length), "watch shows the start of check's page 1");
  const all: any[] = [];
  for (let p = 1; p <= item.changes_pages!; p++) all.push(...uc(await engine.check(s.url + "/l", undefined, { page: p })).changes);
  assert.equal(all.length, item.added! + item.removed!, "every change is reached");
  assert.equal(new Set(all.map((c) => c.kind + c.text)).size, all.length, "none twice");
  // receipts in the watch reply are exactly the shown added blocks
  assert.deepEqual(w.untrusted_content!.receipts?.map((r) => r.quote) ?? [], item.changes!.filter((c) => c.kind === "added").map((c) => c.text));
});

test("round 36 #2: long URLs and long wall targets never push a watch reply past the budget", async () => {
  freshHome();
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    if (req.url!.startsWith("/b")) {
      res.writeHead(302, { location: "/w/" + "y".repeat(8100) });
      return void res.end();
    }
    html(res, "<html><body>no</body></html>", {}, 403);
  });
  for (let i = 0; i < 10; i++) {
    const base = `${s.url}/b${i}/`;
    await engine.bookmark("add", `w${i}`, base + "x".repeat(2048 - base.length), true);
  }
  const r = await engine.watch(undefined, 1);
  assert.equal(r.counts.walled, 10);
  assert.ok(JSON.stringify(r).length <= 60_000, `reply is ${JSON.stringify(r).length} characters`);
  assert.equal(r.untrusted_content!.attention!.length, 10, "every walled bookmark is still named");
  assert.ok(r.counts.attention_urls_omitted > 0);
  assert.equal(r.untrusted_content!.attention_urls!.length + r.counts.attention_urls_omitted, 10, "omitted URLs are counted");
  // the MCP reply is the report itself, not an oversize error
  const client = await connect();
  const m: any = await client.callTool({ name: "watch", arguments: {} });
  assert.notEqual(m.isError, true);
  assert.equal(body(m).untrusted_content.attention.length, 10);
  await client.close();
});

test("round 36 #3: when the list is omitted, added and removed are absent (unknown), never zero", async () => {
  freshHome();
  let page = doc("Big", [["All", ["p0"]]]);
  const s = await start((req, res) => (req.url === "/robots.txt" ? text(res, "", 404) : html(res, page)));
  await engine.bookmark("add", "big", s.url + "/b", true);
  await engine.watch(undefined, 1);
  page = doc("Big", [["All", Array.from({ length: diff.MAX_EDITS + 5 }, (_, i) => `q${i}`)]]);
  const w = await engine.watch(undefined, 1);
  const item = w.untrusted_content!.changed![0];
  assert.equal(item.changes_omitted, true);
  assert.ok(!("added" in item) && !("removed" in item), "watch item has no totals");
  const kept = store.readJson<any>(store.cachePath(s.url + "/b")).changes;
  assert.ok(kept.omitted && !("added" in kept) && !("removed" in kept), "the kept list has no totals");
  const c = await engine.check(s.url + "/b", undefined, { page: 1 });
  assert.equal(c.changes_omitted, true);
  assert.ok(!("added" in c.counts!) && !("removed" in c.counts!), "check has no totals");
  page = doc("Big", [["All", Array.from({ length: diff.MAX_EDITS + 5 }, (_, i) => `r${i}`)]]);
  const fresh = await engine.check(s.url + "/b");
  assert.equal(fresh.changes_omitted, true);
  assert.ok(!("added" in fresh.counts!) && !("removed" in fresh.counts!));
});

test("round 36 #4: a no-store answer (identical 200 or 304) never serves a kept list", async () => {
  freshHome();
  let v = "a";
  let mode: "plain" | "nostore200" | "nostore304" = "plain";
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    if (mode === "nostore304" && req.headers["if-none-match"] === `"${v}"`) {
      res.writeHead(304, { etag: `"${v}"`, "cache-control": "no-store" });
      return void res.end();
    }
    html(res, doc("N", [["A", [`version ${v}`]]]), { etag: `"${v}"`, ...(mode === "nostore200" ? { "cache-control": "no-store" } : {}) });
  });
  for (const m of ["nostore200", "nostore304"] as const) {
    mode = "plain";
    v = v + "1";
    await engine.check(s.url + "/n" + m); // baseline
    v = v + "2";
    assert.ok(uc(await engine.check(s.url + "/n" + m)).changes, "a list is kept");
    mode = m;
    const r = await engine.check(s.url + "/n" + m, undefined, { page: 1 });
    assert.equal(r.status, "unchanged");
    assert.equal(uc(r).changes, undefined, `${m}: no kept list served`);
    assert.equal(r.counts?.added, undefined);
    assert.equal(store.readJson(store.cachePath(s.url + "/n" + m)), null, "and the copy is gone");
  }
});

test("round 36 #5: watch --text names the changed bookmarks and the ones that need attention", async () => {
  freshHome();
  let news = doc("News", [["Today", ["Rain."]]]);
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    if (req.url === "/walled") return html(res, "<html><body>no</body></html>", {}, 403);
    html(res, news);
  });
  await engine.bookmark("add", "news", s.url + "/news", true);
  await engine.bookmark("add", "gate", s.url + "/walled", true);
  // An async child: the test's own web server runs in this process and must keep answering.
  const { execFile } = await import("node:child_process");
  const cli = (...args: string[]) =>
    new Promise<{ stdout: string; stderr: string }>((ok, fail) =>
      execFile(process.execPath, [path.join(import.meta.dirname, "..", "cli.js"), ...args], { env: { ...process.env } }, (e, stdout, stderr) => (e ? fail(e) : ok({ stdout, stderr }))),
    );
  await cli("watch");
  news = doc("News", [["Today", ["Sun."]]]);
  const out = await cli("watch", "--text");
  assert.match(out.stdout, /Changed:\n  news: 1 added, 1 removed  </);
  assert.match(out.stdout, /Needs attention:\n  gate: walled \(forbidden\)  </);
});
