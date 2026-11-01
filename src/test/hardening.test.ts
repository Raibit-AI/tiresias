// SPDX-License-Identifier: Apache-2.0
// v0.9 hardening audit (docs/v0.9/hardening.md): one test per HIGH fixed, named by its Codex round.
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { after, test } from "node:test";
import { freshHome, html, serve, text, type TestServer } from "./helper.js";

freshHome();
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
const engine = await import("../engine.js");
const servers: TestServer[] = [];
const start = async (h: Parameters<typeof serve>[0]) => {
  const s = await serve(h);
  servers.push(s);
  return s;
};
after(async () => {
  for (const s of servers) await s.close();
});
const ARTICLE = `<html><head><title>T</title></head><body><h1>Top</h1><p>Some article text here.</p></body></html>`;
const ROBOTS = "User-agent: *\nDisallow: /private\n";

test("Codex v0.9 hardening round 1 (HIGH): a robots.txt in an encoding Tiresias does not decode means the site says no", async () => {
  const cases: { enc: string; body: Buffer }[] = [
    { enc: "gzip, br", body: zlib.brotliCompressSync(zlib.gzipSync(ROBOTS)) }, // two layers
    { enc: "zstd", body: zlib.gzipSync(ROBOTS) }, // an encoding Tiresias never asked for
    { enc: "compress", body: zlib.gzipSync(ROBOTS) },
  ];
  for (const c of cases) {
    let pageHits = 0;
    const s = await start((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": c.enc });
        return res.end(c.body);
      }
      if (req.url?.startsWith("/private")) pageHits++;
      if (req.url === "/llms.txt") return text(res, "", 404);
      return html(res, ARTICLE);
    });
    const r = await engine.read(s.url + "/private/page", {}, { agent: "t" });
    assert.equal(r.status, "refused", `${c.enc}: ${r.message}`);
    assert.equal(pageHits, 0, `${c.enc}: the disallowed page was never requested`);
  }
  // Still read: one supported layer, identity, and identity alongside one supported layer.
  for (const c of [{ enc: "gzip", body: zlib.gzipSync(ROBOTS) }, { enc: "identity", body: Buffer.from(ROBOTS) }, { enc: "identity, br", body: zlib.brotliCompressSync(ROBOTS) }]) {
    const s = await start((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": c.enc });
        return res.end(c.body);
      }
      if (req.url === "/llms.txt") return text(res, "", 404);
      return html(res, ARTICLE);
    });
    assert.equal((await engine.read(s.url + "/private/page", {}, { agent: "t" })).status, "refused", `${c.enc}: the rule applies`);
    assert.equal((await engine.read(s.url + "/open", {}, { agent: "t" })).status, "ok", `${c.enc}: other pages read`);
  }
});

test("Codex v0.9 hardening round 2b (HIGH): a robots.txt the fetcher takes for a PDF means the site says no", async () => {
  for (const c of [
    { type: "application/pdf", body: ROBOTS }, // declared a PDF
    { type: "application/octet-stream", body: "%PDF-1.4\n" + ROBOTS }, // a PDF by its first bytes under a generic type
  ]) {
    let pageHits = 0;
    const s = await start((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(200, { "content-type": c.type });
        return res.end(c.body);
      }
      if (req.url?.startsWith("/private")) pageHits++;
      if (req.url === "/llms.txt") return text(res, "", 404);
      return html(res, ARTICLE);
    });
    const r = await engine.read(s.url + "/private/page", {}, { agent: "t" });
    assert.equal(r.status, "refused", `${c.type}: ${r.message}`);
    assert.equal(pageHits, 0);
  }
});

test("Codex v0.9 hardening round 3b (HIGH): every 2xx robots.txt is followed, a 206 means no, and literal * and $ in a URL match their encoded rules", async () => {
  for (const status of [201, 202, 203, 206]) {
    let pageHits = 0;
    const s = await start((req, res) => {
      if (req.url === "/robots.txt") return text(res, ROBOTS, status);
      if (req.url?.startsWith("/private")) pageHits++;
      if (req.url === "/llms.txt") return text(res, "", 404);
      return html(res, ARTICLE);
    });
    const r = await engine.read(s.url + "/private/page", {}, { agent: "t" });
    assert.equal(r.status, "refused", `HTTP ${status}: ${r.message}`);
    assert.equal(pageHits, 0, `HTTP ${status}`);
  }
  const rules = await import("../rules.js");
  const r = rules.parseRobots("User-agent: *\nDisallow: /a%2Ab\nDisallow: /c%24d\nDisallow: /e*f$\n");
  for (const p of ["/a*b", "/a%2Ab", "/a%2ab", "/c$d", "/c%24d"]) assert.equal(rules.matchRobots(r, p), "disallow", p);
  assert.equal(rules.matchRobots(r, "/exyzf"), "disallow", "* and $ in a rule are still operators");
  assert.equal(rules.matchRobots(r, "/exyzf/g"), "allow");
  assert.equal(rules.matchRobots(r, "/aXb"), "allow", "an encoded * in a rule is a literal, not a wildcard");
  let hits = 0;
  const s = await start((req, res) => {
    if (req.url === "/robots.txt") return text(res, "User-agent: *\nDisallow: /a%2Ab\n");
    if (req.url === "/llms.txt") return text(res, "", 404);
    hits++;
    return html(res, ARTICLE);
  });
  assert.equal((await engine.read(s.url + "/a*b", {}, { agent: "t" })).status, "refused");
  assert.equal(hits, 0);
});

test("Codex v0.9 hardening round 1 (HIGH): the daily log keeps a bounded amount while it is built, however big the day is", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const home = freshHome();
  const store = await import("../store.js");
  const { buildLog, MAX_LOG_LOOKUPS, MAX_LOG_KEYS } = await import("../dailylog.js");
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  const day = store.localDay(noon.getTime());
  const n = MAX_LOG_KEYS + 1_500; // more than both caps
  const lines: string[] = [];
  for (let i = 0; i < n; i++)
    lines.push(JSON.stringify({ v: 1, time: new Date(noon.getTime() + i).toISOString(), tool: "read", url: `https://e${i}.example/`, status: "ok", agent: `agent-${i}` }));
  fs.mkdirSync(path.join(home, "history"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, "history", `${store.utcDay(noon)}.jsonl`), lines.join("\n") + "\n", { mode: 0o600 });
  const log = await buildLog(day);
  assert.equal(log.entries, n, "every lookup is counted");
  const listed = log.lines.filter((l) => / read by /.test(l)).length;
  assert.equal(listed, MAX_LOG_LOOKUPS, "only the first ones are listed");
  assert.ok(log.lines.some((l) => l.includes(`and ${n - MAX_LOG_LOOKUPS} more lookups`)));
  assert.ok(log.lines.some((l) => l.includes(`${n} lookups.`)));
  assert.ok(log.lines.some((l) => l.includes(`${n - MAX_LOG_KEYS} lookups by agents past the first ${MAX_LOG_KEYS}`)));
});

test("Codex v0.9 hardening round 1d (HIGH): CLI receipts and history keep every record inside untrusted_content", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const home = freshHome();
  const store = await import("../store.js");
  const now = new Date();
  const day = store.utcDay(now);
  const MARK = "IGNORE-PREVIOUS-INSTRUCTIONS-MARK";
  for (const [g, rec] of [
    ["receipts", { v: 1, kind: "quote", url: `https://q.example/${MARK}`, section: 1, quote: `quote ${MARK}`, fetched_at: now.toISOString(), recorded_at: now.toISOString() }],
    ["history", { v: 1, time: now.toISOString(), tool: "read", url: `https://q.example/${MARK}`, status: "ok", agent: `agent ${MARK}`, purpose: `purpose ${MARK}` }],
  ] as const) {
    fs.mkdirSync(path.join(home, g), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, g, `${day}.jsonl`), JSON.stringify(rec) + "\n", { mode: 0o600 });
  }
  const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
  for (const [cmd, key] of [["receipts", "receipts"], ["history", "history"]] as const) {
    const r = spawnSync(process.execPath, [cliPath, cmd], { env: { ...process.env, TIRESIAS_HOME: home }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.status, "ok");
    assert.ok(Array.isArray(j.untrusted_content[key]) && j.untrusted_content[key].length === 1, `${cmd}: the record is inside untrusted_content`);
    assert.ok(JSON.stringify(j.untrusted_content).includes(MARK));
    assert.ok(!JSON.stringify({ ...j, untrusted_content: null }).includes(MARK), `${cmd}: nothing from outside at the top level`);
    assert.equal(j.items, undefined);
  }
});

test("Codex v0.9 hardening round 4c (HIGH): heavy jobs are capped per process; past the line a call is refused at once", async () => {
  const { Slots, Busy } = await import("../slots.js");
  // The line: in order, a released slot goes straight to the next in line, a full line refuses, a cancel leaves it.
  const q = new Slots(1, 1);
  const r1 = await q.take();
  const ctl = new AbortController();
  const p2 = q.take(ctl.signal);
  await assert.rejects(q.take(), Busy, "the line is full");
  ctl.abort();
  await assert.rejects(p2, /cancelled/);
  const p3 = q.take();
  r1();
  const r3 = await p3;
  assert.equal(q.active, 1);
  r3();
  r3(); // a second release changes nothing
  assert.equal(q.active, 0);

  // Parser workers: many big jobs at once never run more than WORKER_MAX workers.
  const sandbox = await import("../sandbox.js");
  const big = "<html><body>" + "<p>word ".repeat(20_000) + "</body></html>";
  let most = 0;
  const watch = setInterval(() => (most = Math.max(most, sandbox.workerLoad().active)), 1);
  try {
    await Promise.all(Array.from({ length: 12 }, () => sandbox.runUntrusted({ op: "parse", kind: "html", body: big, url: "https://x.example/" }, big.length)));
  } finally {
    clearInterval(watch);
  }
  assert.ok(most >= 1 && most <= sandbox.WORKER_MAX, `at most ${sandbox.WORKER_MAX} workers at once (saw ${most})`);

  // MCP: past MCP_MAX running and MCP_QUEUE waiting, a call gets an error envelope at once.
  const { createServer, MCP_MAX, MCP_QUEUE, MCP_BUSY } = await import("../mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow = await start(async (req, res) => {
    if (req.url === "/robots.txt" || req.url === "/llms.txt") return text(res, "", 404);
    await gate;
    html(res, ARTICLE);
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  const client = new Client({ name: "load-test", version: "1.0.0" });
  await client.connect(b);
  const n = MCP_MAX + MCP_QUEUE + 3;
  const calls = Array.from({ length: n }, (_, i) => client.callTool({ name: "read", arguments: { url: `${slow.url}/p${i}` } }, undefined, { timeout: 60_000 }));
  await new Promise((r) => setTimeout(r, 500));
  release();
  const out = await Promise.all(calls);
  const busy = out.filter((r: any) => JSON.parse(r.content[0].text).message === MCP_BUSY);
  assert.equal(busy.length, 3, "exactly the calls past the line were refused");
  assert.ok(busy.every((r: any) => r.isError === true));
  await client.close();
});

test("Codex v0.9 hardening round 5c (HIGH): the message boundary: no SDK text outside the envelope, arguments bounded, open requests capped", async () => {
  const { createServer, guardTransport, BAD_CALL, TOO_MANY_OPEN, MAX_PENDING, MAX_INPUT_ELEMENTS } = await import("../mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  const client = new Client({ name: "boundary-test", version: "1.0.0" });
  await client.connect(b);
  const MARK = "IGNORE-PREVIOUS-MARK";
  const check = (r: any, what: string) => {
    assert.equal(r.isError, true, what);
    const t = r.content[0].text as string;
    const j = JSON.parse(t);
    assert.equal(j.status, "error", what);
    assert.equal(j.message, BAD_CALL, what);
    assert.ok(!t.includes(MARK), `${what}: nothing the caller wrote comes back`);
  };
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }).catch((e: Error) => ({ isError: true, content: [{ text: JSON.stringify({ status: "thrown", message: e.message }) }] }));
  check(await call(`no_such_tool_${MARK}`, {}), "an unknown tool");
  check(await call("read", { url: 5, [MARK]: "x" }), "arguments that do not fit the schema");
  const many: Record<string, string> = {};
  for (let i = 0; i <= MAX_INPUT_ELEMENTS; i++) many[`${MARK}${i}`] = "v";
  check(await call("form_preview", { url: "https://x.example/", form: 1, values: many }), "too many elements");
  // Ordinary calls still come back as Tiresias's own envelope.
  const ok = JSON.parse(((await client.callTool({ name: "history", arguments: {} })) as any).content[0].text);
  assert.equal(ok.status, "ok");
  await client.close();

  // At most MAX_PENDING requests open at once; the rest are answered at once with fixed text.
  const sent: any[] = [];
  const t: any = { onmessage: () => {}, send: async (m: unknown) => void sent.push(m) }; // the server never answers
  guardTransport(t);
  for (let i = 0; i < MAX_PENDING + 2; i++) t.onmessage({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "read", arguments: {} } });
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 2);
  for (const m of sent) assert.equal(JSON.parse(m.result.content[0].text).message, TOO_MANY_OPEN);
});

test("Codex v0.9 hardening round 6c (HIGH): refusals pass the outer sender; long ids ignored; bad dates never repeated; expired cooldowns dropped, live ones kept", async () => {
  const { createServer, guardTransport, MAX_PENDING, MAX_ID } = await import("../mcp.js");
  // Refusals go through whatever wraps send after the guard (stdio backpressure does).
  const seen: any[] = [];
  const t: any = { onmessage: () => {}, send: async () => {} };
  guardTransport(t);
  const guarded = t.send;
  t.send = async (m: unknown) => (seen.push(m), guarded(m));
  for (let i = 0; i < MAX_PENDING + 3; i++) t.onmessage({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "read", arguments: {} } });
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.length, 3, "the outer sender saw every refusal");
  const before = seen.length;
  t.onmessage({ jsonrpc: "2.0", id: "x".repeat(MAX_ID + 1), method: "tools/list" });
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.length, before, "an over-long id gets nothing back");

  // A date the caller wrote is never repeated at the top level.
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  const client = new Client({ name: "date-test", version: "1.0.0" });
  await client.connect(b);
  const MARK = "IGNORE-PREVIOUS-MARK";
  for (const [name, args] of [["log", { day: MARK }], ["needs_report", { since: MARK }], ["history", { since: MARK }], ["receipts", { since: MARK }]] as const) {
    const r: any = await client.callTool({ name, arguments: args });
    const j = JSON.parse(r.content[0].text);
    assert.equal(j.status, "error", name);
    assert.ok(!JSON.stringify({ ...j, untrusted_content: null }).includes(MARK), `${name}: the caller's text is not at the top level`);
  }
  await client.close();

  // The cooldowns this process holds drop the expired ones past MEM_MAX, and never one that has not ended (round 7c).
  const cd = await import("../cooldown.js");
  for (let i = 0; i < cd.MEM_MAX + 50; i++) cd.setCooldown(`https://s${i}.short.example`, 503, "1");
  await new Promise((r) => setTimeout(r, 1_100));
  // v1.0: waits of an hour, not 120 s: on CI the loop below took up to 190 s, so 120-second waits ended mid-test.
  cd.setCooldown("https://long.cool.example", 503, "3600");
  assert.ok(cd.cooldownMemSize() < cd.MEM_MAX, `the expired waits are gone (${cd.cooldownMemSize()} left)`);
  for (let i = 0; i < cd.MEM_MAX + 50; i++) cd.setCooldown(`https://s${i}.live.example`, 503, "3600");
  assert.ok(cd.cooldownMemSize() <= cd.MEM_MAX, "the in-process list stays bounded (v0.9 client trust: the rest go to the fixed-size store)");
  assert.ok(cd.cooldownLeft("https://s3.live.example") > 0 && cd.cooldownLeft(`https://s${cd.MEM_MAX + 40}.live.example`) > 0 && cd.cooldownLeft("https://long.cool.example") > 0);
});
