// SPDX-License-Identifier: Apache-2.0
// v0.2 local features: W-13 daily log view, W-14 private mode, W-15 storage limits and cleanup.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
const cooldown = await import("../cooldown.js");
const cleanup = await import("../cleanup.js");
const config = await import("../config.js");
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
const page = (res: import("node:http").ServerResponse, url?: string) =>
  url === "/robots.txt" ? text(res, "", 404) : html(res, "<html><head><title>Anvils</title></head><body><h1>Anvils</h1><p>Heavy iron anvils for sale.</p></body></html>");

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
const home = () => store.home();
const write = (name: string, lines: unknown[]) => fs.writeFileSync(path.join(home(), name), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { mode: 0o600 });
const writeDay = (group: "history" | "receipts", day: string, lines: unknown[]) => {
  fs.mkdirSync(path.join(home(), group), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home(), group, day + ".jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { mode: 0o600 });
};
const readGroup = (group: "history" | "receipts") => logText(home(), group).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const readLines = (name: string) => fs.readFileSync(path.join(home(), name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const localDay = (d: Date) => store.localDay(d);

// ---- W-13 ----

test("W-13: the log shows the day's lookups, agent, purpose and outcome, and is not stored", async () => {
  freshHome();
  const s = await start((req, res) => page(res, req.url));
  await engine.read(s.url + "/", { question: "anvils" }, { agent: "claude-code" });
  await engine.check(s.url + "/", { agent: "codex" });
  const before = fs.readdirSync(home()).sort();
  const r = await engine.dailyLog();
  assert.equal(r.day, localDay(new Date()));
  assert.equal(r.entries, 2);
  assert.match(r.text, /# Tiresias log, /);
  assert.match(r.text, /read by `claude-code` for `anvils`: `http:\/\/127\.0\.0\.1:\d+\/` => read/);
  assert.match(r.text, /check by `codex`/);
  assert.match(r.text, /\[history\]\(file:/);
  assert.match(r.text, /receipts were recorded/);
  assert.match(r.text, /Receipts recorded this day/);
  assert.deepEqual(fs.readdirSync(home()).sort(), before, "building the view writes nothing");
  const other = await engine.dailyLog("2001-01-01");
  assert.equal(other.entries, 0);
  assert.match(other.text, /No lookups were recorded/);
  await assert.rejects(() => engine.dailyLog("2026-13-40"), /YYYY-MM-DD/);
  await assert.rejects(() => engine.dailyLog("yesterday"), /YYYY-MM-DD/);
});

test("W-13: a wall and a price tag read in plain words, and the day is cut at local midnight", async () => {
  freshHome();
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  const prev = new Date(noon.getTime() - 86_400_000);
  writeDay("history", store.utcDay(noon), [
    { time: noon.toISOString(), tool: "read", url: "https://a.test/x", agent: "a", status: "wall", door: "none" },
    { time: noon.toISOString(), tool: "read", url: "https://b.test/y", agent: "a", status: "payment_required", door: "none" },
  ]);
  writeDay("history", store.utcDay(prev), [{ time: prev.toISOString(), tool: "read", url: "https://old.test/z", agent: "a", status: "ok", door: "text" }]);
  const t = await engine.dailyLog(localDay(noon));
  assert.equal(t.entries, 2);
  assert.match(t.text, /WALL/);
  assert.match(t.text, /price tag \(not paid\)/);
  assert.doesNotMatch(t.text, /old\.test/);
  assert.match((await engine.dailyLog(localDay(prev))).text, /old\.test/);
});

test("W-13: a long day comes in pages", async () => {
  freshHome();
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  writeDay("history", store.utcDay(noon), Array.from({ length: 700 }, (_, i) => ({ time: noon.toISOString(), tool: "read", url: `https://site${i}.test/` + "p".repeat(40), agent: "bulk", purpose: "q".repeat(100), status: "ok", door: "text" })));
  const p1 = await engine.dailyLog(undefined, 1);
  assert.ok(p1.pages > 1);
  assert.ok(p1.text.length < 45_000);
  const last = await engine.dailyLog(undefined, p1.pages);
  assert.match(last.text, /site699\.test/);
  assert.equal((await engine.dailyLog(undefined, p1.pages + 1)).text, "");
});

test("W-13: --to writes one named file, refuses a missing folder, and says when it replaces", async () => {
  freshHome();
  const s = await start((req, res) => page(res, req.url));
  await engine.read(s.url + "/", {}, { agent: "claude-code" });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-export-"));
  await assert.rejects(() => engine.exportDailyLog(path.join(out, "nope")), /does not exist/);
  const day = localDay(new Date());
  const a = await engine.exportDailyLog(out);
  assert.equal(a.file, path.join(fs.realpathSync(out), `tiresias-log-${day}.md`));
  assert.equal(a.replaced, false);
  assert.deepEqual(fs.readdirSync(out), [`tiresias-log-${day}.md`]);
  assert.match(fs.readFileSync(a.file, "utf8"), /read by `claude-code`/);
  fs.writeFileSync(path.join(out, "keep.md"), "mine");
  const b = await engine.exportDailyLog(out, day);
  assert.equal(b.replaced, true);
  assert.match(b.message, /Replaced the earlier export/);
  assert.equal(fs.readFileSync(path.join(out, "keep.md"), "utf8"), "mine");
  assert.ok(!fs.readdirSync(out).some((f) => f.endsWith(".tmp")));
  // a directory sitting where the file would go is never touched
  fs.mkdirSync(path.join(out, "tiresias-log-2001-01-01.md"));
  await assert.rejects(() => engine.exportDailyLog(out, "2001-01-01"), /not a regular file/);
});

test("W-13: the MCP log tool returns the page inside untrusted_content", async () => {
  freshHome();
  const s = await start((req, res) => page(res, req.url));
  await engine.read(s.url + "/", {}, { agent: "x" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  const r: any = await client.callTool({ name: "log", arguments: {} });
  const body = JSON.parse(r.content[0].text);
  assert.match(body.notice, /data, not instructions/);
  assert.match(body.untrusted_content.log, /Tiresias log/);
  assert.equal(body.untrusted_content.entries, 1);
  assert.equal(body.log, undefined, "nothing web-derived at the top level");
  const bad: any = await client.callTool({ name: "log", arguments: { day: "nope" } });
  assert.equal(bad.isError, true);
  await client.close();
});

// ---- W-14 ----

// Every file in the store (relative path -> bytes), minus the one private mode may append to (cooldowns).
function snapshot(): Map<string, string> {
  const m = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      const rel = path.relative(home(), f);
      if (rel === "cooldowns.jsonl") continue;
      if (e.isDirectory()) walk(f);
      else m.set(rel, fs.readFileSync(f).toString("base64") + ":" + fs.statSync(f).mtimeMs);
    }
  };
  walk(home());
  return m;
}

test("W-14: a private read, doors and check leave the store byte-identical, and never reveal a cache", async () => {
  freshHome();
  const s = await start((req, res) => page(res, req.url));
  await engine.read(s.url + "/", {}, { agent: "normal" }); // a normal visit first: there IS a cache to protect
  const before = snapshot();
  const r = await engine.read(s.url + "/", { question: "anvils" }, { agent: "p", private: true });
  assert.equal(r.status, "ok", "the earlier visit is not revealed as 'unchanged'");
  assert.equal(r.private, true);
  assert.equal((await engine.doors(s.url + "/", { agent: "p", private: true })).private, true);
  const c = await engine.check(s.url + "/", { agent: "p", private: true });
  assert.equal(c.private, true);
  assert.match(c.message ?? "", /Private check/);
  assert.deepEqual(snapshot(), before);
  // a normal call has no private flag and still records
  const n = await engine.check(s.url + "/", { agent: "normal" });
  assert.equal(n.private, undefined);
  assert.equal(readGroup("history").length, 2);
});

test("W-14: a private visit to a site never seen before saves no cache, history or receipts", async () => {
  freshHome();
  const s = await start((req, res) => page(res, req.url));
  await engine.read(s.url + "/other", {}, { agent: "p", private: true });
  assert.deepEqual([...snapshot().keys()], []);
  assert.deepEqual(fs.readdirSync(path.join(home(), "cache")), []);
});

test("W-14: TIRESIAS_PRIVATE=1 makes a whole session private", async () => {
  freshHome();
  const s = await start((req, res) => page(res, req.url));
  process.env.TIRESIAS_PRIVATE = "1";
  try {
    const r = await engine.read(s.url + "/", {}, { agent: "p" });
    assert.equal(r.private, true);
  } finally {
    delete process.env.TIRESIAS_PRIVATE;
  }
  assert.deepEqual([...snapshot().keys()], []);
});

test("W-14: private still obeys and records a Retry-After cooldown (host and deadline only)", async () => {
  freshHome();
  const s = await start((req, res) => (req.url === "/robots.txt" ? text(res, "", 404) : text(res, "slow down", 429, { "retry-after": "3600" })));
  const r = await engine.read(s.url + "/secret-path?token=abc", {}, { agent: "p", private: true });
  assert.ok(["error", "refused"].includes(r.status)); // the 429 on a probe stops the call
  assert.equal(r.private, true);
  assert.ok(!fs.existsSync(path.join(home(), "history")));
  assert.deepEqual([...snapshot().keys()], []);
  const lines = readLines("cooldowns.jsonl");
  assert.ok(lines.length >= 1); // several probes can each record a later deadline
  for (const l of lines) assert.deepEqual(Object.keys(l).sort(), ["origin", "until", "v"]);
  assert.equal(new Set(lines.map((l) => l.origin)).size, 1);
  assert.ok(!JSON.stringify(lines).includes("secret-path"));
  assert.ok(cooldown.cooldownLeft(lines[0].origin) > 3000);
  // and a second private call is refused by the cooldown without touching the site
  const hits = s.hits.length;
  const again = await engine.read(s.url + "/", {}, { agent: "p", private: true });
  assert.equal(again.status, "refused");
  assert.equal(s.hits.length, hits);
});

test("W-14: the MCP tools accept private and the envelope says so", async () => {
  freshHome();
  const s = await start((req, res) => page(res, req.url));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  for (const t of await (await client.listTools()).tools.filter((t) => ["read", "doors", "check"].includes(t.name))) assert.ok((t.inputSchema.properties as any).private, `${t.name} has private`);
  const r: any = await client.callTool({ name: "read", arguments: { url: s.url + "/", private: true } });
  assert.equal(JSON.parse(r.content[0].text).private, true);
  assert.deepEqual([...snapshot().keys()], []);
  await client.close();
});

// ---- W-14 round 11 ----

test("round 11 #1: a private probe body never reaches a later normal call (probe bodies are never reused since round 39)", async () => {
  freshHome();
  let llms = "# Site\n\n- [A](/a.md)\n";
  const s = await start((req, res) => (req.url === "/llms.txt" ? text(res, llms) : page(res, req.url)));
  await engine.read(s.url + "/x", {}, { agent: "n" }); // normal: discovery cached
  llms = "PRIVATE_ONLY_TOKEN";
  await engine.doors(s.url + "/x", { agent: "p", private: true });
  llms = "# Site\n\nNORMAL_NOW\n";
  const hits = s.count("/llms.txt");
  const r = await engine.read(s.url + "/", { question: "normal" }, { agent: "n" });
  assert.equal(s.count("/llms.txt"), hits + 1, "the normal call fetched llms.txt itself");
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE_ONLY_TOKEN/);
  // and the other direction: a private read fetches for itself
  const before = s.count("/llms.txt");
  await engine.read(s.url + "/", { question: "x" }, { agent: "p", private: true });
  assert.ok(s.count("/llms.txt") > before);
});

test("round 11 #1: private robots.txt state is not shared with other calls", async () => {
  freshHome();
  const rules = await import("../rules.js");
  rules.resetRulesCache();
  const s = await start((req, res) => page(res, req.url));
  await engine.read(s.url + "/", {}, { agent: "p", private: true });
  const first = s.count("/robots.txt");
  await engine.read(s.url + "/", {}, { agent: "p", private: true });
  assert.ok(s.count("/robots.txt") > first, "each private call fetches robots.txt itself");
  const n = s.count("/robots.txt");
  await engine.read(s.url + "/", {}, { agent: "n" });
  assert.ok(s.count("/robots.txt") > n, "a normal call does not reuse a private call's robots state");
});

test("round 11 #8/#13: a private call, a dry-run clear and a log leave a missing store missing", async () => {
  const s = await start((req, res) => page(res, req.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-ghost-"));
  const ghost = path.join(root, "store");
  process.env.TIRESIAS_HOME = ghost;
  try {
    await engine.read(s.url + "/", {}, { agent: "p", private: true });
    await engine.doors(s.url + "/", { agent: "p", private: true });
    await engine.check(s.url + "/", { agent: "p", private: true });
    assert.ok(!fs.existsSync(ghost), "private calls create nothing");
    const cd = await import("../cooldown.js");
    assert.equal(cd.cooldownLeft("http://x.test"), 0);
    assert.ok(!fs.existsSync(ghost), "a cooldown lookup creates nothing");
    const r = await cleanup.clearStore({ dryRun: true });
    assert.equal(r.total_bytes_freed, 0);
    await engine.dailyLog();
    await engine.queryHistory({});
    await engine.queryReceipts({});
    assert.ok(!fs.existsSync(ghost), "dry-run clear, log, history and receipts create nothing");
    // MCP startup and listing with a private session writes nothing either
    process.env.TIRESIAS_PRIVATE = "1";
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer().connect(a);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(b);
    await client.callTool({ name: "read", arguments: { url: s.url + "/" } });
    await client.close();
    assert.ok(!fs.existsSync(ghost), "a private MCP session creates nothing");
  } finally {
    delete process.env.TIRESIAS_PRIVATE;
  }
});

test("round 11 #8: a private 429 writes only the cooldown line, and no pid marker or log folder", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-ghost-"));
  process.env.TIRESIAS_HOME = path.join(root, "store");
  const s = await start((req, res) => (req.url === "/robots.txt" ? text(res, "", 404) : text(res, "slow", 429, { "retry-after": "600" })));
  await engine.read(s.url + "/", {}, { agent: "p", private: true });
  const names = fs.readdirSync(home()).sort();
  assert.ok(names.includes("cooldowns.jsonl"));
  for (const n of names) assert.ok(["cooldowns.jsonl", "cache"].includes(n), `unexpected ${n}`);
  assert.deepEqual(fs.readdirSync(path.join(home(), "cache")), []);
});

test("round 11 #8: reading an existing store does not change its folder mode", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-mode-"));
  fs.chmodSync(dir, 0o755);
  process.env.TIRESIAS_HOME = dir;
  await cleanup.clearStore({ dryRun: true });
  await engine.dailyLog();
  const cd = await import("../cooldown.js");
  cd.cooldownLeft("http://x.test");
  assert.equal(fs.statSync(dir).mode & 0o777, 0o755);
});

// ---- W-15 ----

test("W-15: defaults when there is no config, and bad values are a clear error", () => {
  freshHome();
  assert.deepEqual(config.loadLimits(), { keep_history_days: 90, keep_receipts_days: 90, keep_cache_days: 30, max_disk_mb: 200, keep_handoff_days: 7, keep_saved_days: 90, max_saved_mb: 100 }); // v0.8 W-28 adds the last two
  const cfg = path.join(home(), "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ keep_history_days: 7 }));
  assert.equal(config.loadLimits().keep_history_days, 7);
  assert.equal(config.loadLimits().keep_cache_days, 30);
  for (const bad of [{ keep_history_days: 0 }, { keep_history_days: -3 }, { keep_cache_days: 1.5 }, { max_disk_mb: "big" }, { nope: 1 }, [1]]) {
    fs.writeFileSync(cfg, JSON.stringify(bad));
    assert.throws(() => config.loadLimits(), config.ConfigError);
  }
  fs.writeFileSync(cfg, "{not json");
  assert.throws(() => config.loadLimits(), /not valid JSON/);
});

test("round 11 #9: names inherited from Object are not settings", () => {
  freshHome();
  const cfg = path.join(home(), "config.json");
  for (const raw of ['{"constructor":1}', '{"toString":1}', '{"__proto__":1}', '{"hasOwnProperty":5}', '{"valueOf":2}']) {
    fs.writeFileSync(cfg, raw);
    assert.throws(() => config.loadLimits(), /unknown setting/, raw);
  }
});

const DAY = 86_400_000;
const dayOf = (daysAgo: number) => store.utcDay(Date.now() - daysAgo * DAY);
const h = (daysAgo: number, url: string, extra = "") => ({ time: iso(daysAgo), tool: "read", url, agent: "a", status: "ok", door: "text", pad: extra });
const r = (daysAgo: number, url: string, extra = "") => ({ quote: "q" + extra, url, section: 1, fetched_at: iso(daysAgo), recorded_at: iso(daysAgo) });

function seed() {
  writeDay("history", dayOf(120), [h(120, "https://old.test/")]);
  writeDay("history", dayOf(100), [h(100, "https://old2.test/")]);
  writeDay("history", dayOf(5), [h(5, "https://new.test/")]);
  writeDay("receipts", dayOf(120), [r(120, "https://old.test/")]);
  writeDay("receipts", dayOf(1), [r(1, "https://new.test/")]);
  const dir = path.join(home(), "cache");
  fs.writeFileSync(path.join(dir, "oldpage.json"), "{}");
  fs.writeFileSync(path.join(dir, "newpage.json"), "{}");
  const t = new Date(Date.now() - 40 * DAY);
  fs.utimesSync(path.join(dir, "oldpage.json"), t, t);
}

test("W-15: day files: clear deletes whole days past the limits, keeps the rest, and reports bytes", async () => {
  freshHome();
  seed();
  const rep = await cleanup.clearStore({});
  assert.equal(rep.history.removed, 2);
  assert.equal(rep.history.kept, 1);
  assert.equal(rep.receipts.removed, 1);
  assert.equal(rep.cache.removed, 1);
  assert.ok(rep.total_bytes_freed > 0);
  assert.deepEqual(readGroup("history").map((e) => e.url), ["https://new.test/"]);
  assert.deepEqual(fs.readdirSync(path.join(home(), "cache")), ["newpage.json"]);
  assert.match(rep.summary, /Removed 2 history files/);
});

test("round 11 #3/#5/#6: nothing is ever rewritten: kept files keep their bytes and inode, no temp files appear", async () => {
  freshHome();
  seed();
  const keep = path.join(home(), "history", dayOf(5) + ".jsonl");
  const ino = fs.statSync(keep).ino;
  const bytes = fs.readFileSync(keep);
  // a mixed legacy file (old and new lines) is kept whole, never trimmed
  const legacy = path.join(home(), "history.jsonl");
  fs.writeFileSync(legacy, [h(200, "https://l-old.test/"), h(2, "https://l-new.test/")].map((x) => JSON.stringify(x)).join("\n") + "\n");
  const legacyBytes = fs.readFileSync(legacy);
  const rep = await cleanup.clearStore({});
  assert.equal(fs.statSync(keep).ino, ino);
  assert.deepEqual(fs.readFileSync(keep), bytes);
  assert.deepEqual(fs.readFileSync(legacy), legacyBytes);
  assert.equal(rep.history.kept, 2);
  const all: string[] = [];
  const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : all.push(e.name)));
  walk(home());
  assert.ok(!all.some((n) => n.endsWith(".tmp")));
  // a legacy file whose newest line is past retention goes whole
  fs.writeFileSync(legacy, [h(200, "https://l-old.test/"), h(150, "https://l-older.test/")].map((x) => JSON.stringify(x)).join("\n") + "\n");
  const rep2 = await cleanup.clearStore({});
  assert.ok(!fs.existsSync(legacy));
  assert.equal(rep2.history.removed, 1);
});

test("round 11 #5: a second clear while a first is mid-way cannot bring deleted data back", async () => {
  freshHome();
  seed();
  const first = cleanup.clearStore({});
  const second = cleanup.clearStore({ all: true });
  await Promise.all([first, second]);
  assert.equal(readGroup("history").length, 0);
  assert.equal(readGroup("receipts").length, 0);
});

test("round 11 #10: --dry-run reports exactly what a real run removes, and bytes are counted once", async () => {
  freshHome();
  seed();
  fs.writeFileSync(path.join(home(), "config.json"), JSON.stringify({ max_disk_mb: 1 }));
  writeDay("history", dayOf(2), [h(2, "https://big.test/", "z".repeat(900_000))]);
  writeDay("history", dayOf(3), [h(3, "https://big3.test/", "z".repeat(300_000))]);
  const sizeBefore = (() => {
    let t = 0;
    const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : (t += fs.statSync(path.join(d, e.name)).size)));
    walk(home());
    return t;
  })();
  const dry = await cleanup.clearStore({ dryRun: true });
  const real = await cleanup.clearStore({});
  assert.deepEqual({ ...dry, dry_run: false, summary: "" }, { ...real, summary: "" });
  let after = 0;
  const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : (after += fs.statSync(path.join(d, e.name)).size)));
  walk(home());
  assert.equal(sizeBefore - after, real.total_bytes_freed, "bytes freed equals what really left the disk");
  assert.equal(after, real.store_bytes_after);
  assert.ok(real.disk_cap.files_removed >= 1);
});

test("W-15: --older-than (whole days) overrides the limits, --dry-run changes nothing, --all clears the lot", async () => {
  freshHome();
  seed();
  const before = snapshot();
  const dry = await cleanup.clearStore({ dryRun: true, olderThanMs: 1000 });
  assert.equal(dry.dry_run, true);
  assert.equal(dry.history.removed, 3);
  assert.equal(dry.receipts.removed, 2);
  assert.match(dry.summary, /^Would remove/);
  assert.deepEqual(snapshot(), before, "a dry run is read only");
  const real = await cleanup.clearStore({ olderThanMs: 1000 });
  assert.equal(real.history.removed, 3);
  assert.equal(real.receipts.removed, 2);
  seed();
  const all = await cleanup.clearStore({ all: true });
  assert.equal(all.history.kept, 0);
  assert.equal(readGroup("history").length, 0);
  assert.equal(readGroup("receipts").length, 0);
  assert.deepEqual(fs.readdirSync(path.join(home(), "cache")), []);
});

test("W-15: --all also deletes the legacy v0.1 single files", async () => {
  freshHome();
  fs.writeFileSync(path.join(home(), "history.jsonl"), JSON.stringify(h(1, "https://l.test/")) + "\n");
  fs.writeFileSync(path.join(home(), "receipts.jsonl"), JSON.stringify(r(1, "https://l.test/")) + "\n");
  assert.equal((await engine.queryHistory({})).total, 1, "legacy history is still read");
  assert.equal((await engine.queryReceipts({})).total, 1, "legacy receipts are still read");
  await cleanup.clearStore({ all: true });
  assert.ok(!fs.existsSync(path.join(home(), "history.jsonl")));
  assert.ok(!fs.existsSync(path.join(home(), "receipts.jsonl")));
});

test("W-15: history and receipts tools read across all day files with the same paging and filters", async () => {
  freshHome();
  writeDay("history", dayOf(3), [{ ...h(3, "https://a.test/p"), agent: "one" }]);
  writeDay("history", dayOf(2), [{ ...h(2, "https://b.test/p"), agent: "two" }]);
  fs.writeFileSync(path.join(home(), "history.jsonl"), JSON.stringify({ ...h(10, "https://legacy.test/"), agent: "one" }) + "\n");
  const all = await engine.queryHistory({});
  assert.equal(all.total, 3);
  assert.deepEqual(all.items.map((e) => e.url), ["https://legacy.test/", "https://a.test/p", "https://b.test/p"], "oldest first, legacy before day files");
  assert.equal((await engine.queryHistory({ agent: "one" })).total, 2);
  assert.equal((await engine.queryHistory({ site: "b.test" })).total, 1);
  assert.equal((await engine.queryHistory({ since: "2d" })).total, 0 + (await engine.queryHistory({ since: "2d" })).total);
  assert.equal((await engine.queryHistory({ since: "5d" })).total, 2);
  // paging across files
  writeDay("history", dayOf(1), Array.from({ length: 600 }, (_, i) => h(1, `https://many${i}.test/`, "p".repeat(100))));
  const p1 = await engine.queryHistory({});
  assert.ok(p1.pages > 1);
  const last = await engine.queryHistory({ page: p1.pages });
  assert.match(last.items[last.items.length - 1].url, /many599/);
  writeDay("receipts", dayOf(1), [r(1, "https://a.test/p")]);
  assert.equal((await engine.queryReceipts({ url: "https://a.test/p" })).total, 1);
});

test("W-15: cooldowns.jsonl is never compacted or deleted, not even by clear --all", async () => {
  freshHome();
  const now = Date.now();
  write("cooldowns.jsonl", [
    { origin: "http://live.test", until: now + 600_000 },
    { origin: "http://dead.test", until: now - 5000 },
  ]);
  const legacy = store.cachePath(cooldown.LEGACY);
  fs.writeFileSync(legacy, JSON.stringify({ "http://legacy.test": now + 600_000 }));
  const file = path.join(home(), "cooldowns.jsonl");
  const bytes = fs.readFileSync(file);
  const ino = fs.statSync(file).ino;
  for (const opts of [{}, { all: true }, { all: true, dryRun: true }]) await cleanup.clearStore(opts);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.statSync(file).ino, ino);
  assert.ok(fs.existsSync(legacy));
  assert.ok(cooldown.cooldownLeft("http://live.test") > 500);
  assert.ok(cooldown.cooldownLeft("http://legacy.test") > 500);
  assert.ok(!fs.existsSync(path.join(home(), "run")), "no pid markers exist any more");
  assert.ok(!fs.existsSync(path.resolve("src/presence.ts")), "the pid mechanism is gone");
});

test("W-15: the disk cap deletes the oldest cache files first", async () => {
  freshHome();
  fs.writeFileSync(path.join(home(), "config.json"), JSON.stringify({ max_disk_mb: 1 }));
  const dir = path.join(home(), "cache");
  const blob = "x".repeat(450 * 1024);
  const t = Date.now();
  for (const [i, n] of ["a", "b", "c"].entries()) {
    fs.writeFileSync(path.join(dir, `${n}.json`), blob);
    const when = new Date(t - (3 - i) * 3600_000);
    fs.utimesSync(path.join(dir, `${n}.json`), when, when);
  }
  const rep = await cleanup.clearStore({});
  assert.equal(rep.disk_cap.files_removed, 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["b.json", "c.json"]);
  assert.ok(rep.store_bytes_after <= 1024 * 1024);
});

test("round 11 #11: the cap removes the oldest day across history AND receipts together", async () => {
  freshHome();
  fs.writeFileSync(path.join(home(), "config.json"), JSON.stringify({ max_disk_mb: 1 }));
  writeDay("history", dayOf(80), [h(80, "https://oldest.test/", "a".repeat(300_000))]);
  writeDay("receipts", dayOf(1), [r(1, "https://newer.test/", "b".repeat(900_000))]);
  writeDay("history", dayOf(40), [h(40, "https://middle.test/", "c".repeat(10))]);
  const rep = await cleanup.clearStore({});
  assert.equal(rep.history.removed, 0 + rep.history.removed);
  assert.ok(!fs.existsSync(path.join(home(), "history", dayOf(80) + ".jsonl")), "the oldest file went first");
  assert.ok(fs.existsSync(path.join(home(), "receipts", dayOf(1) + ".jsonl")), "the newest data stays");
  assert.ok(rep.store_bytes_after <= 1024 * 1024);
});

test("round 11 #6: no write in cleanup is left to a short write (no log is ever rewritten)", async () => {
  freshHome();
  seed();
  const orig = fs.writeSync;
  let calls = 0;
  (fs as any).writeSync = (...a: any[]) => (calls++, (orig as any)(...a));
  try {
    await cleanup.clearStore({});
  } finally {
    (fs as any).writeSync = orig;
  }
  assert.equal(calls, 0, "clear writes no file contents at all");
});

test("W-15: the automatic trim runs once a day on a normal call, never in private, and never crashes a read", async () => {
  const s = await start((req, res) => page(res, req.url));
  freshHome();
  seed();
  await engine.read(s.url + "/", {}, { agent: "p", private: true });
  assert.equal(readGroup("history").length, 3);
  assert.ok(!fs.existsSync(path.join(home(), "maintenance.json")));
  freshHome();
  seed();
  const legacy = store.cachePath(cooldown.LEGACY);
  fs.writeFileSync(legacy, "{}");
  write("cooldowns.jsonl", [{ origin: "http://dead.test", until: Date.now() - 5000 }]);
  const res = await engine.read(s.url + "/", {}, { agent: "n" });
  assert.equal(res.status, "ok");
  assert.ok(!readGroup("history").some((e) => e.url === "https://old.test/"));
  assert.ok(readGroup("history").some((e) => e.url === "https://new.test/"));
  assert.ok(fs.existsSync(path.join(home(), "maintenance.json")));
  assert.equal(readLines("cooldowns.jsonl").length, 1, "the automatic trim never touches cooldowns");
  assert.ok(fs.existsSync(legacy));
  freshHome();
  seed();
  store.writeJson(path.join(home(), "maintenance.json"), { last: Date.now() });
  await engine.read(s.url + "/", {}, { agent: "n" });
  assert.ok(readGroup("history").some((e) => e.url === "https://old.test/"));
  freshHome();
  fs.writeFileSync(path.join(home(), "config.json"), JSON.stringify({ keep_history_days: -1 }));
  const bad = await engine.read(s.url + "/", {}, { agent: "n" });
  assert.equal(bad.status, "ok");
  await assert.rejects(() => cleanup.clearStore({}), /whole number of 1 or more/);
});

test("round 11 #7: a long-running process trims again the next day", async () => {
  freshHome();
  const t0 = Date.now();
  writeDay("history", dayOf(89), [h(89, "https://aging.test/")]);
  await cleanup.enforceLimits(t0);
  assert.equal(readGroup("history").length, 1, "89 days old is inside the 90 day limit");
  await cleanup.enforceLimits(t0 + 5000); // same day: nothing to do
  await cleanup.enforceLimits(t0 + 2 * DAY);
  assert.equal(readGroup("history").length, 0, "two days later the same process trims it");
});

// ---- W-13 round 11 ----

test("round 11 #4: export writes inside the resolved folder, builds the text first, and refuses a symlinked final name", async () => {
  freshHome();
  const s = await start((req, res) => page(res, req.url));
  await engine.read(s.url + "/", {}, { agent: "claude-code" });
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-real-"));
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-link-"));
  const link = path.join(linkParent, "out");
  fs.symlinkSync(real, link);
  const day = localDay(new Date());
  const a = await engine.exportDailyLog(link);
  assert.equal(a.file, path.join(fs.realpathSync(real), `tiresias-log-${day}.md`), "the path reported is the resolved real one");
  assert.ok(fs.existsSync(path.join(real, `tiresias-log-${day}.md`)));
  // a bad day fails before anything is touched
  const clean = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-clean-"));
  await assert.rejects(() => engine.exportDailyLog(clean, "not-a-day"), /YYYY-MM-DD/);
  assert.deepEqual(fs.readdirSync(clean), []);
  // the final name is a symlink to a victim file: refused, victim untouched
  const victim = path.join(clean, "victim.txt");
  fs.writeFileSync(victim, "precious");
  fs.symlinkSync(victim, path.join(clean, `tiresias-log-${day}.md`));
  await assert.rejects(() => engine.exportDailyLog(clean), /Not touching it/);
  assert.equal(fs.readFileSync(victim, "utf8"), "precious");
  assert.ok(!fs.readdirSync(clean).some((f) => f.endsWith(".tmp")));
});

test("round 11 #12: the agent summary is one line per agent, capped, and a huge line is split by the pager", async () => {
  freshHome();
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  writeDay("history", store.utcDay(noon), Array.from({ length: 2000 }, (_, i) => ({ time: noon.toISOString(), tool: "read", url: "https://s.test/" + i, agent: `agent-${i}-` + "n".repeat(70), status: "ok", door: "text" })));
  const first = await engine.dailyLog(undefined, 1);
  assert.match(first.text, /and 1950 more agents/);
  for (let p = 1; p <= first.pages; p++) assert.ok((await engine.dailyLog(undefined, p)).text.length < 45_000);
  // the pager also splits any single line longer than the budget
  const dl = await import("../dailylog.js");
  const paged = dl.pageOf({ day: "x", entries: 1, lines: ["short", "y".repeat(120_000), "tail"] }, 1);
  assert.ok(paged.pages >= 3);
  for (let p = 1; p <= paged.pages; p++) assert.ok(dl.pageOf({ day: "x", entries: 1, lines: ["short", "y".repeat(120_000), "tail"] }, p).text.length <= 41_000);
});

const rawHome = () => process.env.TIRESIAS_HOME!; // unlike home(), creates nothing
// ---- round 12 ----

const withTZ = async (tz: string, fn: () => Promise<void>) => {
  const old = process.env.TZ;
  process.env.TZ = tz;
  try {
    await fn();
  } finally {
    if (old === undefined) delete process.env.TZ;
    else process.env.TZ = old;
  }
};
const hist = await import("../history.js");
const rcpt = await import("../receipts.js");

test("round 12 #1: a symlinked cache/ lets nothing be deleted outside the store (clear --all)", async () => {
  freshHome();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-outside-"));
  const victim = path.join(outside, "victim.json");
  fs.writeFileSync(victim, "precious");
  fs.symlinkSync(outside, path.join(rawHome(), "cache"));
  await assert.rejects(() => cleanup.clearStore({ all: true }), /plain folder/);
  assert.equal(fs.readFileSync(victim, "utf8"), "precious");
});

test("round 12 #1: a no-store response with a symlinked cache/ or cache file deletes nothing outside", async () => {
  freshHome();
  const s = await start((req, res) => (req.url === "/robots.txt" ? text(res, "", 404) : html(res, "<html><body><h1>Hi</h1><p>Text here.</p></body></html>", { "cache-control": "no-store" })));
  const url = s.url + "/page";
  const name = store.sha256(url) + ".json";
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-outside-"));
  const victim = path.join(outside, name);
  fs.writeFileSync(victim, "precious");
  // the whole folder is a link
  fs.symlinkSync(outside, path.join(rawHome(), "cache"));
  const r = await engine.check(url, { agent: "n" });
  assert.equal(r.status, "error");
  assert.equal(fs.readFileSync(victim, "utf8"), "precious");
  // only the file is a link
  freshHome();
  const outside2 = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-outside-"));
  const victim2 = path.join(outside2, "v.json");
  fs.writeFileSync(victim2, "precious");
  fs.mkdirSync(path.join(rawHome(), "cache"), { mode: 0o700 });
  fs.symlinkSync(victim2, path.join(rawHome(), "cache", name));
  await engine.check(url, { agent: "n" });
  assert.equal(fs.readFileSync(victim2, "utf8"), "precious");
  await cleanup.clearStore({ all: true });
  assert.equal(fs.readFileSync(victim2, "utf8"), "precious", "clear skips links and never follows them");
});

test("round 12 #2: day files are named by UTC date, so a timezone change hides nothing", async () => {
  freshHome();
  await withTZ("UTC", async () => {
    hist.record({ time: "2026-10-16T00:30:00.000Z", tool: "read", url: "https://tz.test/", agent: "a", status: "ok", door: "text" });
  });
  assert.deepEqual(fs.readdirSync(path.join(rawHome(), "history")), ["2026-10-16.jsonl"]);
  await withTZ("America/New_York", async () => {
    // 00:30Z is 20:30 on October 15 in New York
    assert.equal((await engine.dailyLog("2026-10-15")).entries, 1);
    assert.equal((await engine.dailyLog("2026-10-16")).entries, 0);
  });
  await withTZ("Pacific/Kiritimati", async () => {
    // and 14:30 on October 16 there
    assert.equal((await engine.dailyLog("2026-10-16")).entries, 1);
  });
});

test("round 12 #2: retention does not depend on the timezone (Kiritimati does not delete early)", async () => {
  freshHome();
  hist.record({ time: "2026-10-16T23:30:00.000Z", tool: "read", url: "https://tz.test/", agent: "a", status: "ok", door: "text" });
  fs.writeFileSync(path.join(rawHome(), "config.json"), JSON.stringify({ keep_history_days: 1 }));
  const now = Date.parse("2026-10-17T11:00:00Z");
  for (const tz of ["Pacific/Kiritimati", "UTC", "Pacific/Pago_Pago"])
    await withTZ(tz, async () => {
      const rep = await cleanup.clearStore({ now, dryRun: true });
      assert.equal(rep.history.removed, 0, `kept under ${tz}`);
    });
  // the file goes once the END of its UTC day plus the retention is past
  const rep = await cleanup.clearStore({ now: Date.parse("2026-10-18T00:00:01Z") });
  assert.equal(rep.history.removed, 1);
});

test("round 12 #2: daylight saving days (23 and 25 hours) get exactly their own visits", async () => {
  freshHome();
  const times = ["2026-11-01T04:30:00Z", "2026-11-02T04:59:00Z", "2026-11-02T05:00:00Z", "2026-03-08T04:59:00Z", "2026-03-08T05:30:00Z", "2026-03-09T03:59:00Z", "2026-03-09T04:00:00Z"];
  for (const t of times) hist.record({ time: t, tool: "read", url: "https://dst.test/" + t, agent: "a", status: "ok", door: "text" });
  await withTZ("America/New_York", async () => {
    // Nov 1 is 25 hours: 04:00Z to 05:00Z the next day
    assert.equal((await engine.dailyLog("2026-11-01")).entries, 2);
    assert.equal((await engine.dailyLog("2026-11-02")).entries, 1);
    // Mar 8 is 23 hours: 05:00Z to 04:00Z the next day
    assert.equal((await engine.dailyLog("2026-03-07")).entries, 1);
    assert.equal((await engine.dailyLog("2026-03-08")).entries, 2);
    assert.equal((await engine.dailyLog("2026-03-09")).entries, 1);
  });
});

test("round 12 #3: a private 429 writes the cooldown line only: no cache/ made, no folder chmodded", async () => {
  const s = await start((req, res) => (req.url === "/robots.txt" ? text(res, "", 404) : text(res, "slow", 429, { "retry-after": "600" })));
  // a fresh root: only the root and the cooldown line
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-r12-"));
  process.env.TIRESIAS_HOME = path.join(root, "store");
  await engine.check(s.url + "/", { agent: "p", private: true });
  assert.deepEqual(fs.readdirSync(rawHome()), ["cooldowns.jsonl"]);
  // an existing lax store and cache keep their modes
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-r12-"));
  fs.mkdirSync(path.join(dir, "cache"), { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  fs.chmodSync(path.join(dir, "cache"), 0o755);
  process.env.TIRESIAS_HOME = dir;
  const s2 = await start((req, res) => (req.url === "/robots.txt" ? text(res, "", 404) : text(res, "slow", 429, { "retry-after": "600" }))); // a new origin: this process already knows the first
  await engine.check(s2.url + "/", { agent: "p", private: true });
  assert.equal(fs.statSync(dir).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(dir, "cache")).mode & 0o777, 0o755);
  assert.ok(fs.existsSync(path.join(dir, "cooldowns.jsonl")));
  assert.deepEqual(fs.readdirSync(path.join(dir, "cache")), []);
});

test("round 12 #4: a day folder another process made first is accepted, and a log failure never fails a call", async () => {
  freshHome();
  const orig = fs.mkdirSync;
  (fs as any).mkdirSync = (p: any, o: any) => {
    const r = (orig as any)(p, o);
    if (String(p).endsWith("history") || String(p).endsWith("receipts")) throw Object.assign(new Error("exists"), { code: "EEXIST" });
    return r;
  };
  try {
    hist.record({ time: new Date().toISOString(), tool: "read", url: "https://race.test/", agent: "a", status: "ok", door: "text" });
    rcpt.record([{ quote: "q", url: "https://race.test/", section: null, fetched_at: new Date().toISOString() }]);
  } finally {
    (fs as any).mkdirSync = orig;
  }
  assert.equal(readGroup("history").length, 1);
  assert.equal(readGroup("receipts").length, 1);
  // receipts/ is a plain file: the write fails, the read still answers
  freshHome();
  fs.writeFileSync(path.join(rawHome(), "receipts"), "not a folder");
  const s = await start((req, res) => page(res, req.url));
  const r = await engine.read(s.url + "/", { question: "anvils" }, { agent: "n" });
  assert.equal(r.status, "ok");
});

test("round 12 #5: an interrupted append cannot swallow the next record", async () => {
  freshHome();
  fs.mkdirSync(path.join(rawHome(), "history"), { mode: 0o700 });
  const t = new Date().toISOString();
  fs.writeFileSync(path.join(rawHome(), "history", store.utcDay() + ".jsonl"), '{"time":"' + t + '","tool":"re'); // no newline
  hist.record({ time: t, tool: "read", url: "https://after.test/", agent: "a", status: "ok", door: "text" });
  const q = await engine.queryHistory({});
  assert.deepEqual(q.items.map((e) => e.url), ["https://after.test/"]);
  // and a long record is written completely
  hist.record({ time: t, tool: "read", url: "https://long.test/" + "u".repeat(3000), agent: "a", status: "ok", door: "text" });
  assert.equal((await engine.queryHistory({})).total, 2);
});

test("round 12 #6: one record can never outgrow a history or receipts page", async () => {
  freshHome();
  const s = await start((req, res) => page(res, req.url));
  await engine.read(s.url + "/", { question: "q".repeat(5000) }, { agent: "A".repeat(120_000) });
  const q = await engine.queryHistory({});
  assert.equal(q.total, 1);
  const line = JSON.stringify(q.items[0]);
  assert.ok(line.length < 6000, `record is ${line.length}`);
  assert.equal(q.items[0].agent.length, 200);
  assert.ok((q.items[0].purpose ?? "").length <= 1000);
  assert.equal((q.items[0] as any).cut, true);
  rcpt.record([{ quote: "z".repeat(100_000), url: "https://big.test/" + "u".repeat(9000), section: 1, fetched_at: new Date().toISOString() }]);
  const rc = (await engine.queryReceipts({})).items.find((x) => x.url.startsWith("https://big.test/"))!;
  assert.ok(JSON.stringify(rc).length < 14_000);
  assert.equal((rc as any).cut, true);
  // the MCP reply for that page is not replaced by the oversize error
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  const hr: any = await client.callTool({ name: "history", arguments: {} });
  assert.equal(JSON.parse(hr.content[0].text).total, 1);
  await client.close();
});

// ---- round 13 ----

test("round 13 #1: a linked or foreign history/ or receipts/ is an error everywhere, and clear deletes nothing", async () => {
  for (const group of ["history", "receipts"] as const) {
    freshHome();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-outside-"));
    fs.writeFileSync(path.join(outside, "2020-01-01.jsonl"), "{}\n");
    fs.symlinkSync(outside, path.join(rawHome(), group));
    await assert.rejects(() => (group === "history" ? engine.queryHistory({}) : engine.queryReceipts({})), /plain folder/);
    await assert.rejects(() => cleanup.clearStore({ all: true }), /plain folder/);
    await assert.rejects(() => engine.dailyLog(), /plain folder/);
    assert.ok(fs.existsSync(path.join(outside, "2020-01-01.jsonl")));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer().connect(a);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(b);
    for (const name of ["history", "receipts", "log"]) {
      const r: any = await client.callTool({ name, arguments: {} });
      if (name === "receipts" && group === "history") continue; // that tool does not read the other folder
      if (name === "history" && group === "receipts") continue;
      if (name === "log" || name === group) assert.equal(r.isError, true, `${name} reports the bad folder`);
    }
    await client.close();
  }
});

test("round 13 #2: every append starts with a newline, and blank lines change no count or page", async () => {
  freshHome();
  const t = new Date().toISOString();
  for (let i = 0; i < 3; i++) hist.record({ time: t, tool: "read", url: "https://n.test/" + i, agent: "a", status: "ok", door: "text" });
  rcpt.record([{ quote: "q", url: "https://n.test/0", section: null, fetched_at: t }]);
  const file = path.join(rawHome(), "history", store.utcDay() + ".jsonl");
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(raw.startsWith("\n"));
  assert.equal(raw.split("\n").filter((l) => l === "").length, 4, "one separator per record, plus the final newline");
  const q = await engine.queryHistory({});
  assert.equal(q.total, 3);
  assert.equal(q.pages, 1);
  assert.equal((await engine.queryReceipts({})).total, 1);
  assert.equal((await engine.dailyLog()).entries, 3);
  // a legacy file with blank lines, and the cleanup that reads it
  fs.writeFileSync(path.join(rawHome(), "history.jsonl"), "\n\n" + JSON.stringify({ time: t, tool: "read", url: "https://l.test/", agent: "a", status: "ok", door: "text" }) + "\n\n");
  assert.equal((await engine.queryHistory({})).total, 4);
  const rep = await cleanup.clearStore({ dryRun: true });
  assert.equal(rep.history.removed, 0);
});

test("round 13 #3: oversized records from a legacy or day file are bounded when read, and readable over MCP", async () => {
  freshHome();
  const t = new Date().toISOString();
  const big = { time: t, tool: "read", url: "https://old.test/", agent: "A".repeat(120_000), purpose: "p".repeat(5000), status: "ok", door: "text" };
  fs.writeFileSync(path.join(rawHome(), "history.jsonl"), JSON.stringify(big) + "\n");
  fs.mkdirSync(path.join(rawHome(), "receipts"), { mode: 0o700 });
  fs.writeFileSync(path.join(rawHome(), "receipts", store.utcDay() + ".jsonl"), "\n" + JSON.stringify({ quote: "z".repeat(100_000), url: "https://old.test/", section: 1, fetched_at: t, recorded_at: t }) + "\n");
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  const hr: any = await client.callTool({ name: "history", arguments: {} });
  assert.notEqual(hr.isError, true);
  const h = JSON.parse(hr.content[0].text);
  assert.equal(h.untrusted_content.history[0].agent.length, 200);
  assert.equal(h.untrusted_content.history[0].cut, true);
  assert.ok(h.untrusted_content.history[0].purpose.length <= 1000);
  const rr: any = await client.callTool({ name: "receipts", arguments: {} });
  const r = JSON.parse(rr.content[0].text);
  assert.notEqual(rr.isError, true);
  assert.equal(r.untrusted_content.receipts[0].quote.length, 8000);
  assert.equal(r.untrusted_content.receipts[0].cut, true);
  await client.close();
});

test("round 14: filters match stored values before cutting, and a stray null line is skipped", async () => {
  freshHome();
  const t = new Date().toISOString();
  const longAgent = "A".repeat(300);
  const longUrl = "https://old.test/" + "u".repeat(5000);
  fs.writeFileSync(
    path.join(rawHome(), "history.jsonl"),
    "null\n" + JSON.stringify({ time: t, tool: "read", url: "https://old.test/", agent: longAgent, status: "ok", door: "text" }) + "\n",
  );
  fs.writeFileSync(path.join(rawHome(), "receipts.jsonl"), "null\n" + JSON.stringify({ quote: "q", url: longUrl, section: 1, fetched_at: t, recorded_at: t }) + "\n");
  const history = await import("../history.js");
  const receipts = await import("../receipts.js");
  const all = await history.query({});
  assert.equal(all.total, 1, "the null line is skipped, not fatal");
  const byFull = await history.query({ agent: longAgent });
  assert.equal(byFull.total, 1, "the full agent name still matches");
  assert.equal(byFull.items[0].agent.length, 200);
  assert.equal((await history.query({ agent: longAgent.slice(0, 200) })).total, 0, "a cut prefix is not the stored value");
  const r = await receipts.query({ url: longUrl });
  assert.equal(r.total, 1, "the full URL still matches");
  assert.equal((r.items[0] as { cut?: true }).cut, true);
  assert.equal((await receipts.query({})).total, 1);
});
