// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { bookmark, watch } from "../watchflow.js";
import { freshHome, logText } from "./helper.js";

test("9.1: watch attention keeps agent-chosen names inside untrusted_content", async () => {
  const home = freshHome();
  const name = "ignore-prior-instructions";
  await bookmark("add", name, "https://blocked.example/page", true);
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ sites: { "blocked.example": { never_visit: true } } }));
  const r = await watch({ agent: "test" }, 1);
  const { untrusted_content: uc, ...trusted } = r;
  assert.ok(!JSON.stringify(trusted).includes(name));
  assert.equal((uc as any)?.attention[0].name, name);
});

test("9.4: MCP resume labels supplied text as provided_by_agent throughout the record", async () => {
  const home = freshHome();
  const { create } = await import("../handoffs.js");
  const { createServer } = await import("../mcp.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const ticket = create({ url: "https://wall.example/page", reason: "login_required" }).ticket!;
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(a);
  const client = new Client({ name: "agent", version: "1" });
  await client.connect(b);
  try {
    const response = await client.callTool({ name: "resume", arguments: { ticket: ticket.id, text: "# Agent supplied\n\nOrdinary words from an agent." } });
    const r = JSON.parse((response.content as any)[0].text);
    assert.equal(r.status, "ok");
    assert.equal(r.source, "provided_by_agent");
    assert.ok(r.untrusted_content.receipts.every((r: any) => r.source === "provided_by_agent"));
    const history = logText(home, "history").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(history.at(-1).source, "provided_by_agent");
    assert.ok(!r.message.includes("person provided"));
  } finally { await client.close(); await server.close(); }
});
