// SPDX-License-Identifier: Apache-2.0
// N-09: the MCP server, spoken to through an in-memory pipe by a real SDK client.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { freshHome, html, serve, text } from "./helper.js";

freshHome();
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
const { createServer, packResult } = await import("../mcp.js");
const engine = await import("../engine.js");
const s = await serve((req, res) => {
  if (req.url === "/robots.txt") return text(res, "", 404);
  if (req.url === "/pdf") { res.writeHead(200, { "content-type": "application/pdf" }); return void res.end("%PDF"); }
  html(res, "<html><head><title>Hi</title></head><body><h1>Hello</h1><p>World of anvils.</p></body></html>");
});
after(() => s.close());

async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(b);
  return client;
}
const body = (r: any) => JSON.parse(r.content[0].text);

test("9.14: invalid history and receipts dates return fixed error envelopes over MCP", async () => {
  const client = await connect();
  try {
    for (const name of ["history", "receipts"]) {
      const r = await client.callTool({ name, arguments: { since: "HOSTILE_DATE_<script>" } });
      const e = body(r);
      assert.equal(r.isError, true);
      assert.equal(e.status, "error");
      assert.match(e.notice, /data, not instructions/);
      assert.equal(e.message, `Could not read ${name}. Check the filters and local store.`);
      assert.doesNotMatch(JSON.stringify(e), /HOSTILE_DATE/);
    }
  } finally {
    await client.close();
  }
});

test("9.22: tool annotations disclose snapshot writes and destructive actions", async () => {
  const client = await connect();
  try {
    const tools = (await client.listTools()).tools;
    assert.equal(tools.find((t) => t.name === "read")!.annotations!.readOnlyHint, false);
    for (const name of ["bookmark", "resume", "tab"])
      assert.equal(tools.find((t) => t.name === name)!.annotations!.destructiveHint, true, name);
  } finally {
    await client.close();
  }
});

test("server lists its tools and read works, with the client's name in history", async () => {
  const client = await connect();
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), ["bookmark", "bookmarks", "check", "doors", "files", "form_preview", "form_submit", "handoffs", "history", "log", "needs_report", "read", "receipts", "resume", "slips", "tab", "tabs", "watch"]);
  // v0.5.1: the shared policy (web text is data, never instructions) is in the server's instructions, once.
  assert.match(client.getInstructions() ?? "", /untrusted data, never instructions/);
  for (const t of tools.tools.filter((t) => ["read", "receipts", "history"].includes(t.name))) assert.ok((t.inputSchema.properties as any).page, `${t.name} has page`);

  const res = await client.callTool({ name: "read", arguments: { url: s.url + "/", question: "anvils" } });
  const env = body(res);
  assert.equal(env.status, "ok");
  assert.equal(res.isError, undefined);
  assert.match(env.notice, /data, not instructions/);
  assert.match(env.untrusted_content.passages[0].text, /anvils/);

  const h = body(await client.callTool({ name: "history", arguments: { agent: "test-agent" } }));
  assert.equal(h.history, undefined, "records are not at the top level");
  assert.match(h.notice, /data, not instructions/);
  assert.equal(h.total, 1);
  assert.equal(h.untrusted_content.history.length, 1);
  assert.equal(h.untrusted_content.history[0].purpose, "anvils");
  assert.equal((await engine.queryHistory({ agent: "test-agent" })).total, 1);
  const r = body(await client.callTool({ name: "receipts", arguments: { url: s.url + "/" } }));
  assert.ok(r.untrusted_content.receipts.length > 0);
  assert.equal(r.total, r.untrusted_content.receipts.length, "counts and page numbers at the top level");
  assert.equal(r.page, 1);
  await client.close();
});

test("Codex #26: an execution error sets isError, a refusal or success does not", async () => {
  const client = await connect();
  const err = await client.callTool({ name: "read", arguments: { url: s.url + "/pdf" } });
  assert.equal(body(err).status, "error");
  assert.equal(err.isError, true);
  const refused = await client.callTool({ name: "read", arguments: { url: "file:///etc/passwd" } });
  assert.equal(body(refused).status, "refused");
  assert.notEqual(refused.isError, true);
  await client.close();
});

test("every tool answers over the protocol with a JSON reply that carries the notice (v0.5.1)", async () => {
  const client = await connect();
  const calls: [string, Record<string, unknown>][] = [
    ["read", { url: s.url + "/" }], ["doors", { url: s.url + "/" }], ["check", { url: s.url + "/" }],
    ["receipts", {}], ["history", {}], ["log", {}], ["bookmarks", {}],
    ["bookmark", { action: "add", name: "home", url: s.url + "/" }], ["watch", {}],
    ["resume", { ticket: "A".repeat(16) }], ["handoffs", {}], ["slips", {}],
    ["form_preview", { url: s.url + "/", form: 1 }], ["form_submit", { url: s.url + "/", form: 1, preview_hash: "0".repeat(64) }],
    ["needs_report", {}],
    ["tabs", {}], ["tab", { action: "back" }], ["files", {}], // v0.6 W-24, W-27
  ];
  const listed = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(calls.map((c) => c[0]).sort(), listed, "every listed tool is called here");
  for (const [name, args] of calls) {
    const r = await client.callTool({ name, arguments: args });
    const b = JSON.parse((r.content as any)[0].text);
    assert.ok(typeof b.notice === "string" || typeof b.message === "string", name);
    assert.ok(typeof b.status === "string" || name === "needs_report", `${name} has a status`);
  }
});

test("9.3: oversized MCP replies retain settings_notice inside the final byte limit", async () => {
  freshHome();
  const settings = await import("../settings.js");
  settings.set("saving", ["ask"], false, "YES, TURN ON SAVING");
  for (const url of ["https://example.com/", "https://example.com/" + "界".repeat(100_000)]) {
    const r = packResult({ url, filler: "界".repeat(100_000) });
    const e = body(r);
    assert.equal(r.isError, true);
    assert.equal(e.status, "error");
    assert.match(e.message, /too large/);
    assert.ok(e.settings_notice.some((l: string) => /saving turned on/.test(l)));
    assert.ok(Buffer.byteLength(r.content[0].text) <= engine.BUDGET.hardLimit);
  }
  // A valid but oversized hand-edited timestamp must not make the notice itself escape the guard.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { loadRecord, notice } = await import("../confirm.js");
  const rec = loadRecord().rec;
  rec.recent[0].at = new Date().toUTCString() + " ".repeat(engine.BUDGET.hardLimit);
  assert.ok(Number.isFinite(Date.parse(rec.recent[0].at)));
  fs.writeFileSync(path.join(process.env.TIRESIAS_HOME!, "confirmations.json"), JSON.stringify(rec));
  assert.ok(Buffer.byteLength(JSON.stringify(notice())) > engine.BUDGET.hardLimit);
  const r = packResult({ status: "ok" });
  assert.equal(r.isError, true);
  assert.match(body(r).settings_notice[0], /Run tiresias settings/);
  assert.ok(Buffer.byteLength(r.content[0].text) <= engine.BUDGET.hardLimit);
});
