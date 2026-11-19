// SPDX-License-Identifier: Apache-2.0
// v1.2: three rough edges found while using Tiresias for ordinary web work (the field list, 2026-11-14).
// All requests stay local.
//   1. A reply repeats its text as receipts: read's `receipts: "log"` leaves the list in the local log.
//   2. A 429 on robots.txt read as a refusal for good: the reply now says it is a wait.
//   3. A long line of structured data (an article's body, copied) outranked the article's own paragraphs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { freshHome, html, neverAsk, serve, text } from "./helper.js";
import { STRUCTURED_COPY, STRUCTURED_HEADING, parseHtml, topPassages } from "../reader.js";

const home = freshHome();
neverAsk(home);
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
const engine = await import("../engine.js");
const receipts = await import("../receipts.js");
const ctx = { agent: "v12-field" };
const uc = (e: { untrusted_content: unknown }) => e.untrusted_content as Record<string, any>;
after(async () => (await import("../sandbox.js")).stopWorker());

const PAGE = `<html><head><title>Kiln Notes</title></head><body><h1>Kiln Notes</h1>
<p>A wood kiln takes two days to reach its top heat and three more to cool.</p>
<h2>Glazes</h2><p>Ash glaze runs green where the flame carries it across the shoulder of a pot.</p>
<h2>Firing</h2><p>Stoke every ten minutes through the night, and watch the cones through the spy hole.</p></body></html>`;

const logged = async (url: string) => (await receipts.query({ url })).total;
// The records for one URL exactly as they sit in the day files, oldest first.
const logLines = (url: string): any[] =>
  fs.readdirSync(path.join(home, "receipts")).sort().flatMap((f) => fs.readFileSync(path.join(home, "receipts", f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))).filter((r) => r.url === url);
const facts = (r: any) => ({ quote: r.quote, url: r.url, section: r.section });

test("v1.2 receipts: log leaves the list out of the reply, and every receipt is in the log", async () => {
  const s = await serve((req, res) => (req.url === "/robots.txt" ? text(res, "", 404) : html(res, PAGE)));
  try {
    for (const [name, opts] of [["outline", {}], ["section", { section: 2 }], ["question", { question: "ash glaze green" }]] as const) {
      const url = `${s.url}/${name}`;
      const full = await engine.read(url, { ...opts }, ctx);
      assert.equal(full.status, "ok", name);
      assert.ok(uc(full).receipts.length > 0, `${name}: the default reply carries its receipts`);
      assert.equal(full.receipts_in_log, undefined, name);
      assert.equal(full.counts!.receipts, uc(full).receipts.length, name);
      const before = await logged(uc(full).final_url);
      assert.equal(before, full.counts!.receipts, `${name}: the default read logged its receipts`);

      const lean = await engine.read(url, { ...opts, page: 1, receipts: "log" }, ctx);
      assert.ok(lean.status === "ok" || lean.status === "unchanged", `${name}: ${lean.status}`);
      assert.equal(uc(lean).receipts, undefined, `${name}: no receipts list in the reply`);
      assert.equal(lean.receipts_in_log, true, name);
      assert.equal(lean.counts!.receipts, full.counts!.receipts, `${name}: counts.receipts still says how many`);
      assert.equal(await logged(uc(lean).final_url), before + lean.counts!.receipts, `${name}: every receipt of the lean read is in the log`);
      // Nothing else is left out or changed: every other part of the content is the full reply's, value for value.
      const { receipts: wanted, ...rest } = uc(full);
      assert.deepEqual(uc(lean), rest, name);
      // What the lean read logged is what the full reply listed: the same quotes, in the same order, cut nowhere.
      const mine = logLines(uc(lean).final_url).slice(-lean.counts!.receipts);
      assert.deepEqual(mine.map(facts), wanted.map(facts), `${name}: the logged receipts are the ones a full reply lists`);
      for (const r of mine) assert.ok(r.kind === "quote" && r.cut === undefined && !Number.isNaN(Date.parse(r.fetched_at)), name);
      assert.ok(JSON.stringify(lean).length < JSON.stringify(full).length * 0.75, `${name}: the reply is clearly smaller`);
    }
    // "reply" is the default, spelled out.
    const spelled = await engine.read(`${s.url}/spelled`, { receipts: "reply" }, ctx);
    assert.ok(uc(spelled).receipts.length > 0);
    assert.equal(spelled.receipts_in_log, undefined);
  } finally {
    await s.close();
  }
});

test("v1.2 receipts: log changes nothing when the log would not hold them (private mode, a log that cannot be written)", async () => {
  const s = await serve((req, res) => (req.url === "/robots.txt" ? text(res, "", 404) : html(res, PAGE)));
  try {
    const priv = await engine.read(`${s.url}/private`, { receipts: "log" }, { ...ctx, private: true });
    assert.equal(priv.status, "ok");
    assert.ok(uc(priv).receipts.length > 0, "a private read records nothing, so its receipts come in the reply");
    assert.equal(priv.receipts_in_log, undefined);
    assert.equal(await logged(uc(priv).final_url), 0);

    // The pipeline's own rule, on the function that applies it: it only ever removes a list that is there.
    const { leaveReceiptsInLog, recordReceipts } = await import("../pipeline.js");
    const none = { status: "ok", untrusted_content: { final_url: "https://e.example/" } } as any;
    leaveReceiptsInLog(none);
    assert.equal(none.receipts_in_log, undefined);

    // A log that cannot be written: recordReceipts says so, and the read keeps its receipts in the reply.
    const dir = path.join(home, "receipts");
    const kept = path.join(home, "receipts-kept");
    fs.renameSync(dir, kept);
    fs.writeFileSync(dir, "not a folder");
    try {
      const err = console.error;
      console.error = () => {};
      try {
        assert.equal(recordReceipts([{ quote: "q", url: "https://e.example/", section: 1, fetched_at: new Date().toISOString() }]), false);
        const e = await engine.read(`${s.url}/unwritable`, { section: 2, receipts: "log" }, ctx);
        // The read still answers, and with its whole receipts list: never a reply that says they are in a log that
        // does not hold them, and never a read lost to the log.
        assert.equal(e.status, "ok", e.message);
        assert.equal(e.receipts_in_log, undefined);
        assert.match(uc(e).section.text, /Ash glaze runs green/);
        assert.deepEqual(uc(e).receipts.map((r: any) => r.quote), ["Kiln Notes", "Glazes", "Ash glaze runs green where the flame carries it across the shoulder of a pot."]);
        assert.equal(e.counts!.receipts, 3);
      } finally {
        console.error = err;
      }
    } finally {
      fs.rmSync(dir, { force: true });
      fs.renameSync(kept, dir);
    }
  } finally {
    await s.close();
  }
});

test("v1.2 receipts: a receipt too long for the log stays in the reply (Codex review, 2026-11-14)", async () => {
  // The logged copy of a URL is cut at 4,096 characters and of a quote at 8,000. A cut copy is not the receipt.
  const { recordReceipts } = await import("../pipeline.js");
  const at = new Date().toISOString();
  assert.equal(recordReceipts([{ quote: "q".repeat(8000), url: "https://e.example/whole", section: 1, fetched_at: at }]), true);
  assert.equal(recordReceipts([{ quote: "q".repeat(8001), url: "https://e.example/cut-quote", section: 1, fetched_at: at }]), false);
  assert.equal(recordReceipts([{ quote: "q", url: `https://e.example/${"u".repeat(4096)}`, section: 1, fetched_at: at }]), false);
  assert.equal(recordReceipts([]), true);
  const s = await serve((req, res) => (req.url === "/robots.txt" ? text(res, "", 404) : html(res, PAGE)));
  try {
    const long = `${s.url}/long?x=${"a".repeat(5000)}`;
    const e = await engine.read(long, { section: 2, receipts: "log" }, ctx);
    assert.equal(e.status, "ok", e.message);
    assert.ok(uc(e).final_url.length > 4096);
    assert.equal(e.receipts_in_log, undefined, "the log's copy of these receipts is cut, so the reply keeps them");
    assert.equal(uc(e).receipts.length, e.counts!.receipts);
    assert.ok(uc(e).receipts.every((r: any) => r.url === uc(e).final_url));
    // The same page at a short address: left out, as asked.
    const short = await engine.read(`${s.url}/short`, { section: 2, receipts: "log" }, ctx);
    assert.equal(short.receipts_in_log, true);
    assert.equal(uc(short).receipts, undefined);
  } finally {
    await s.close();
  }
});

test("v1.2 receipts: the MCP read tool takes receipts reply or log and nothing else", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createServer } = await import("../mcp.js");
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  const c = new Client({ name: "v12-field", version: "1" });
  await c.connect(b);
  const s = await serve((req, res) => (req.url === "/robots.txt" ? text(res, "", 404) : html(res, PAGE)));
  try {
    const call = async (args: Record<string, unknown>) => {
      const r = await c.callTool({ name: "read", arguments: args });
      return { r, e: JSON.parse((r.content as any)[0].text) };
    };
    const lean = await call({ url: `${s.url}/mcp`, section: 2, receipts: "log" });
    assert.equal(lean.e.status, "ok");
    assert.equal(lean.e.receipts_in_log, true);
    assert.equal(lean.e.untrusted_content.receipts, undefined);
    assert.match(lean.e.untrusted_content.section.text, /Ash glaze runs green/);
    assert.ok(lean.e.counts.receipts >= 2);
    // The receipts tool reads them back.
    const got = JSON.parse(((await c.callTool({ name: "receipts", arguments: { url: lean.e.untrusted_content.final_url } })).content as any)[0].text);
    assert.ok(got.untrusted_content.receipts.some((r: any) => /Ash glaze runs green/.test(r.quote)));
    const bad = await c.callTool({ name: "read", arguments: { url: `${s.url}/mcp`, receipts: "nowhere" } }).catch((e: Error) => ({ isError: true, content: [{ text: e.message }] }));
    assert.equal((bad as any).isError, true);
    // The local mode server has one read tool with no such parameter.
    const [la, lb] = InMemoryTransport.createLinkedPair();
    await createServer({ local: { budget: 6000 } }).connect(la);
    const lc = new Client({ name: "v12-field-local", version: "1" });
    await lc.connect(lb);
    const tool = (await lc.listTools()).tools.find((t) => t.name === "read")!;
    assert.ok(!("receipts" in (tool.inputSchema.properties ?? {})));
    await lc.close();
  } finally {
    await c.close();
    await s.close();
  }
});

test("v1.2 robots: a 429 or 503 on robots.txt is reported as a wait with its seconds; another server error still reads as no", async () => {
  for (const [status, headers, want] of [
    [429, {}, 60],
    [429, { "retry-after": "17" }, 17],
    [503, { "retry-after": "5" }, 5],
  ] as const) {
    const s = await serve((req, res) => (req.url === "/robots.txt" ? text(res, "slow down", status, headers) : html(res, PAGE)));
    try {
      const e = await engine.read(`${s.url}/page`, {}, ctx);
      assert.equal(e.status, "refused", String(status));
      assert.equal(e.retry_after_seconds, want, String(status));
      assert.match(e.message!, new RegExp(`robots\\.txt returned HTTP ${status}: the site asked Tiresias to wait`), e.message);
      assert.match(e.message!, new RegExp(`This is a wait, not a no\\. Ask again in ${want} seconds\\.`), e.message);
      assert.doesNotMatch(e.message!, /assumes the site says no/);
      assert.equal(s.count("/page"), 0, "the page itself is never asked for");
    } finally {
      await s.close();
    }
  }
  const s = await serve((req, res) => (req.url === "/robots.txt" ? text(res, "broken", 500) : html(res, PAGE)));
  try {
    const e = await engine.read(`${s.url}/page`, {}, ctx);
    assert.equal(e.status, "refused");
    assert.equal(e.retry_after_seconds, undefined);
    assert.match(e.message!, /robots\.txt returned HTTP 500, so Tiresias assumes the site says no\./);
    assert.equal(s.count("/page"), 0);
  } finally {
    await s.close();
  }
});

test("v1.2 question reads: the page's own paragraphs come before a long line of structured data that copies them", () => {
  const paras = [
    "The harbour ferry leaves at seven each morning and crosses to the island in forty minutes.",
    "A return ticket for the ferry costs twelve dollars, and children under five travel free.",
    "In winter the last ferry back from the island leaves the harbour at four in the afternoon.",
  ];
  // The article's whole body again, as escaped HTML in one JSON-LD value, with one word the page text lacks.
  const copy = paras.map((p) => `<p class=\\"body\\">${p}</p>`).join("") + "<p>Zeppelin moorings are closed.</p>" + "<p>The ferry, the harbour, the island, the ticket and the morning crossing.</p>".repeat(8);
  assert.ok(copy.length > STRUCTURED_COPY);
  const ld = `{"@context":"https://schema.org","@type":"NewsArticle","headline":"Ferry times","price":"12.00","articleBody":"${copy}"}`;
  const p = parseHtml(`<html><head><title>Ferry times</title><script type="application/ld+json">${ld}</script></head><body><h1>Ferry times</h1>${paras.map((x) => `<p>${x}</p>`).join("")}</body></html>`, "https://site.example/ferry");
  const structured = p.sections.find((s) => s.heading === STRUCTURED_HEADING)!;
  assert.ok(structured.generated && structured.blocks.some((b) => b.text.length > STRUCTURED_COPY), "the page has a long line of structured data");

  // The long line holds every word of the question; each paragraph of the page holds only some.
  const top = topPassages(p, "ferry harbour island ticket morning crossing");
  assert.ok(top.length >= 4);
  const firstCopy = top.findIndex((x) => x.section === structured.n && x.text.length > STRUCTURED_COPY);
  const lastOwn = top.map((x) => x.section !== structured.n).lastIndexOf(true);
  assert.ok(top[0].section !== structured.n, "the first passage is the page's own text");
  assert.ok(firstCopy === -1 || firstCopy > lastOwn, "every paragraph of the page ranks before the long structured line");
  // By word overlap alone the long line would have come first: that is the fault this fixes.
  assert.ok(firstCopy !== -1, "the long line is still among the passages");
  const byScore = [...top].sort((a, b) => b.score - a.score);
  assert.ok(byScore[0].section === structured.n && byScore[0].text.length > STRUCTURED_COPY);

  // It is still returned when it is the only place the words are.
  const only = topPassages(p, "zeppelin moorings");
  assert.ok(only.length > 0 && only.every((x) => x.section === structured.n));
  // A short line of structured data is a fact, and it competes as before: here it holds more of the question's
  // words than any paragraph of the page, so it comes first, ahead of the page's own text.
  const price = topPassages(p, "ferry price 12.00");
  assert.ok(price[0].section === structured.n && /"price": "12\.00"/.test(price[0].text) && price[0].text.length <= STRUCTURED_COPY, JSON.stringify(price.map((x) => [x.section, x.score])));
  assert.ok(price.slice(1).some((x) => x.section !== structured.n), "paragraphs of the page follow it");

  // The line is drawn after 500 characters: a line of exactly 500 is ranked by its words, one of 501 goes last.
  const lineOf = (n: number) => {
    const doc = parseHtml(`<html><head><script type="application/ld+json">{"@type":"Thing","note":"${"otter weir ".repeat(60).slice(0, n)}"}</script></head><body><h1>Rivers</h1><p>An otter was seen near the mill.</p><p>The weir is closed in spring.</p></body></html>`, "https://site.example/r");
    const sec = doc.sections.find((x) => x.heading === STRUCTURED_HEADING)!;
    return { doc, sec, len: Math.max(...sec.blocks.map((b) => b.text.length)) };
  };
  const extra = lineOf(300).len - 300; // the key, quotes and indentation around the value
  for (const [total, first] of [[STRUCTURED_COPY, true], [STRUCTURED_COPY + 1, false]] as const) {
    const { doc, sec, len } = lineOf(total - extra);
    assert.equal(len, total);
    const got = topPassages(doc, "otter weir");
    assert.equal(got.length, 3);
    assert.equal(got[0].section === sec.n, first, `a structured line of ${total} characters`);
    assert.equal(got[2].section === sec.n, !first, `a structured line of ${total} characters`);
  }
  // A page author's own heading with the same words is not the generated section.
  const fake = parseHtml(`<html><body><h1>(structured data)</h1><p>${"ferry harbour island ".repeat(40)}</p><h2>Other</h2><p>The ferry leaves the harbour.</p></body></html>`, "https://site.example/x");
  assert.match(topPassages(fake, "ferry harbour island")[0].text, /^ferry harbour island ferry/);
});
