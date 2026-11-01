// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHtml } from "../reader.js";
import { buildContent } from "../pipeline.js";
import type { CacheEntry } from "../pagecache.js";

test("HTML links use the first base href while receipts keep the fetched URL", async () => {
  const url = "https://site.example/entry";
  for (const [bases, expected] of [
    ['<base href="https://docs.example/manual/"><base href="https://wrong.example/">', "https://docs.example/manual/intro"],
    ['<base target="_blank"><base href="/manual/">', "https://site.example/manual/intro"],
    ['<base href="http://["><base href="https://wrong.example/">', "https://site.example/intro"],
  ]) {
    const parsed = parseHtml(`<html><head>${bases}</head><body><h1>Manual</h1><p><a href="intro">Introduction</a></p></body></html>`, url);
    assert.equal(parsed.links[0].url, expected);
    const content = await buildContent({ parsed, final_url: url, fetched_at: new Date().toISOString() } as CacheEntry, { section: 1 });
    assert.ok(content.receipts.length);
    assert.ok(content.receipts.every((r) => r.url === url));
  }
});

test("reader block boundaries preserve Unicode surrogate pairs", async () => {
  const { parseMarkdown, parsePlain, lineBlocks, parseJsonText } = await import("../reader.js");
  const raw = "a".repeat(3999) + "😀tail";
  const url = "https://site.example/unicode";
  const pages = [
    parseHtml(`<p>${raw}</p>`, url),
    parseHtml(`<pre>${raw}</pre>`, url),
    parseMarkdown(raw, url),
    parseMarkdown("```\n" + raw + "\n```", url),
    parsePlain(raw, url, "script"),
    parseJsonText(raw, url),
  ];
  const groups = [...pages.map((p) => p.sections.flatMap((s) => s.blocks)), lineBlocks(raw)];
  for (const blocks of groups) {
    for (const block of blocks) assert.doesNotMatch(block.text, /[\ud800-\udfff]/u);
    assert.equal(blocks.map((b) => b.text).join("").split("😀").length - 1, 1);
  }
  const content = await buildContent({ parsed: pages[0], final_url: url, fetched_at: new Date().toISOString() } as CacheEntry, { section: 1 });
  assert.match(JSON.stringify(content.uc), /😀tail/);
});

test("plain-format reads report text omitted at the expansion cap", async () => {
  const { MAX_EXPANDED, parsePlain } = await import("../reader.js");
  const url = "https://site.example/large.csv";
  const raw = "a".repeat(MAX_EXPANDED - 1) + "😀tail";
  for (const mode of ["script", "csv", "calendar", "contact"] as const) {
    const parsed = parsePlain(raw, url, mode);
    assert.equal(parsed.text_omitted, 6, mode);
    assert.equal(parsed.sections[0].blocks.reduce((n, b) => n + b.text.length, 0), MAX_EXPANDED - 1);
    const content = await buildContent({ parsed, final_url: url, fetched_at: new Date().toISOString() } as CacheEntry, {});
    assert.equal(content.uc.text_omitted, 6);
  }
});
