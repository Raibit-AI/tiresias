// SPDX-License-Identifier: Apache-2.0
// v1.2: round 3 coverage and pagination regressions through localRead, compared with 460377a.
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";
import { stopWorker } from "../sandbox.js";
import { aimedSignals, CUT_FOR_BUDGET, WITHHOLD_AT } from "../local.js";
import { embed, MAX_INPUT_CHARS } from "../guardclient.js";
import { BY_VISITOR } from "../envelope.js";
import { EMBEDDING_CASES, PAGINATION_CASES, embeddingReply, limitTexts, replies } from "./v12-integrated-r3-replies.js";

// Frozen from 460377a before any production changes; tests never regenerate it.
const before = JSON.parse(fs.readFileSync(new URL("../../src/test/fixtures/v12-integrated-r3-before.json", import.meta.url), "utf8"));
after(stopWorker);

for (const c of EMBEDDING_CASES) test(`integrated R3: complete embedding coverage: ${c.id}`, async () => {
  assert.equal(before.commit, "460377a");
  const old = before.embedding.find((x: any) => x.id === c.id);
  const now = await embeddingReply(c);
  assert.equal(now.html_sha256, old.html_sha256, "same frozen input");
  assert.ok(now.inputs.every(t => t.length <= MAX_INPUT_CHARS && t.startsWith(c.prefix)));
  if (["control", "exact-limit"].includes(c.id)) {
    const { id, ...expected } = old;
    assert.deepEqual(now, expected, "short and exactly fitting inputs stay unchanged");
  }
  else {
    assert.ok(old.inputs.every((t: string) => !t.includes("PAYLOAD")), "460377a silently dropped the payload");
    const first = now.replies[0];
    assert.equal(first.meaning_check, undefined);
    assert.equal(first.warned, 1, "a mark in any chunk marks the original paragraph once");
    assert.ok(first.untrusted_content.section.text.includes("PAYLOAD"));
    assert.ok(now.inputs.some(t => t.includes("PAYLOAD")), "the endpoint sees the formerly unchecked suffix");
    assert.equal(old.replies[0].warned, undefined);
    assert.equal(old.replies[0].meaning_check, undefined);
    // All of the original displayed paragraph is covered in order, with overlapping boundaries.
    const paragraphs = old.replies.flatMap((r: any) => r.untrusted_content.section.text.split("\n\n"));
    for (const para of paragraphs) {
      if (para.length < 40) continue;
      let at = 0;
      const chunks = now.inputs.map(t => t.slice(c.prefix.length)).filter(t => para.includes(t));
      for (const chunk of chunks) {
        const start = para.indexOf(chunk);
        assert.ok(start <= at, "no gap before a chunk");
        if (start) assert.ok(start < at, "chunks overlap");
        at = Math.max(at, start + chunk.length);
      }
      assert.equal(at, para.length, "the complete paragraph is checked");
    }
  }
});

for (const c of PAGINATION_CASES) for (const mode of ["mixed", "none", "all"] as const)
  test(`integrated R3: every retained source paragraph is reachable: ${c.id}/${mode}`, async () => {
    const old = before.pagination.find((x: any) => x.id === c.id && x.mode === mode);
    const now = await replies(c.html, c.budget, "", mode);
    assert.equal(now.html_sha256, old.html_sha256, "same frozen input");
    const shown = now.replies.map(r => r.untrusted_content.section.text).join("\n\n");
    for (const para of new Set<string>(c.paras)) {
      const marked = mode === "all" || mode === "mixed" && para.includes("SEMANTIC");
      if (aimedSignals(para) + +marked >= WITHHOLD_AT) continue;
      const expected = c.paras.filter(p => p === para).length;
      assert.ok(shown.split(para).length - 1 >= expected, para);
    }
    for (const [i, r] of now.replies.entries()) {
      assert.equal(r.untrusted_content.section.page, i + 1);
      assert.equal(r.untrusted_content.section.pages, now.replies.length);
      assert.ok(Buffer.byteLength(JSON.stringify(r.untrusted_content)) <= c.budget);
      assert.ok(!r.untrusted_content.section.text.includes(CUT_FOR_BUDGET), "pagination retains whole fitting paragraphs");
      assert.equal(r.meaning_check, undefined);
    }
    if (c.id === "reported" && mode === "mixed") {
      assert.equal(old.replies.length, 1);
      assert.ok(!old.replies[0].untrusted_content.section.text.includes("TAIL TARGET"));
      assert.ok(old.replies[0].untrusted_content.section.text.includes(CUT_FOR_BUDGET));
      assert.ok(now.replies.length > 1);
    }
    if (c.id === "visitor-pre") assert.equal(now.replies[0].untrusted_content.section.written_by, BY_VISITOR);
  });

test("integrated R3: chunks share the 128-input cap, including memoized inputs", async () => {
  for (const count of [126, 127]) {
    const texts = limitTexts(count);
    const result = await replies("<h1>H</h1>", 20000, "", "mixed", texts);
    const old = before.limits.find((x: any) => x.count === count);
    assert.equal(old.check.signs.length, 0, "460377a silently used a truncated vector");
    assert.deepEqual(result.again, result.check);
    assert.equal(result.repeated_inputs, 0, "memoization preserves coverage and does not bypass the cap");
    if (count === 126) {
      assert.equal(result.inputs.length, 128);
      assert.ok(result.check && "signs" in result.check);
      assert.deepEqual(result.check.signs, [[texts[0], 1]]);
    } else {
      assert.deepEqual(result.check, { not_run: true });
      assert.equal(result.inputs.length, 0, "cap is checked before any requests");
    }
  }
});

test("integrated R3: the embedding client rejects oversized inputs before network access", async () => {
  await assert.rejects(embed({ url: "http://127.0.0.1:1/v1", model: "fake" }, ["x".repeat(MAX_INPUT_CHARS + 1)], { timeoutMs: 100 }),
    { name: "RangeError", message: "text too long for one embedding input" });
});
