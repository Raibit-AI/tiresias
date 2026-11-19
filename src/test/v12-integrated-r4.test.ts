// SPDX-License-Identifier: Apache-2.0
// v1.2: round 4 regressions through localRead and guard check, compared with 6b13916.
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";
import { stopWorker } from "../sandbox.js";
import { CUT_FOR_BUDGET, WARNING, WITHHELD } from "../local.js";
import { BY_VISITOR } from "../envelope.js";
import { MAX_INPUT_CHARS } from "../guardclient.js";
import { CHECK_CASES, FENCE_CASES, capture } from "./v12-integrated-r4-replies.js";

// Frozen from 6b13916 before production changes. Tests never regenerate it.
const before = JSON.parse(fs.readFileSync(new URL("../../src/test/fixtures/v12-integrated-r4-before.json", import.meta.url), "utf8"));
after(stopWorker);

function codeBodies(text: string, fence: string): string[] {
  const bodies: string[] = [];
  let body: string[] | undefined;
  for (const line of text.split("\n")) {
    if (/^[ \t]*(?:(?:[-*+]|\d+[.)]) )?`{3,}$/.test(line)) {
      assert.ok(line.endsWith(fence), "the reader's original fence length is kept");
      assert.equal(line.match(/`+$/)![0], fence);
      if (body) { bodies.push(body.join("\n")); body = undefined; }
      else body = [];
    } else if (body) body.push(line);
    else assert.ok(!/console\.log|\/\/ Step/.test(line), "code always has fence context");
  }
  assert.equal(body, undefined, "every page has balanced fences");
  return bodies;
}

for (const c of FENCE_CASES) test(`integrated R4: balanced budgeted code fragments: ${c.id}`, async () => {
  assert.equal(before.commit, "6b13916");
  const old = before.fences.find((x: any) => x.id === c.id);
  const now = await capture(c.html, c.budget);
  assert.equal(now.html_sha256, old.html_sha256, "same frozen input");
  assert.throws(() => { for (const r of old.replies) codeBodies(r.untrusted_content.section.text, c.fence); }, "6b13916 loses fence context");
  const bodies: string[] = [];
  for (const [i, r] of now.replies.entries()) {
    const section = r.untrusted_content.section;
    assert.equal(section.page, i + 1);
    assert.equal(section.pages, now.replies.length);
    assert.ok(Buffer.byteLength(JSON.stringify(r.untrusted_content)) <= c.budget, "fences count against the page budget");
    bodies.push(...codeBodies(section.text, c.fence));
    // Each displayed fragment still records the complete original block, never a synthetic fragment.
    for (const row of now.receipts[i]) assert.ok(old.receipts.flat().some((x: any) => x.quote === row.quote), row.quote);
    if (section.text.includes("console.log") || c.id === "oversized" && i === 0) {
      const source = old.receipts.flat().find((x: any) => x.quote.includes("\n") && x.quote.endsWith(c.fence));
      assert.ok(now.receipts[i].some((x: any) => x.quote === source.quote));
    }
  }
  const displayed = now.replies.map(r => r.untrusted_content.section.text).join("\n\n");
  if (old.receipts.flat().some((r: any) => r.quote === "Explanation after the code.")) assert.ok(displayed.includes("Explanation after the code."));
  assert.ok(!bodies.some(b => b.includes("Explanation after the code.")), "ordinary prose stays outside code");
  if (c.id === "oversized") {
    assert.ok(displayed.includes(CUT_FOR_BUDGET));
    assert.ok(bodies[0].startsWith("ordinary 😀 details "));
    assert.ok(!/[\uD800-\uDBFF]$/.test(bodies[0]), "prefix does not split a Unicode code point");
  } else {
    assert.ok(!displayed.includes(CUT_FOR_BUDGET));
    for (const para of c.code.split("\n\n").filter(p => p && !p.includes("[INST]"))) {
      const expected = c.id === "visitor-list" ? para.split("\n").map(l => "  " + l).join("\n") : para;
      assert.ok(bodies.some(b => b.includes(expected)), "every retained source paragraph is reachable");
    }
  }
  if (c.id === "visitor-list") assert.ok(now.replies.some(r => r.untrusted_content.section.written_by === BY_VISITOR));
  if (c.id === "guarded") {
    assert.ok(displayed.includes(WARNING));
    assert.ok(displayed.includes(WITHHELD));
    assert.equal(now.replies.reduce((n, r) => n + (r.warned ?? 0), 0), old.replies.reduce((n: number, r: any) => n + (r.warned ?? 0), 0));
    assert.equal(now.replies.reduce((n, r) => n + (r.withheld ?? 0), 0), old.replies.reduce((n: number, r: any) => n + (r.withheld ?? 0), 0));
  }
});

for (const c of CHECK_CASES) test(`integrated R4: guard CLI checks the same complete text as localRead: ${c.id}`, async () => {
  const old = before.checks.find((x: any) => x.id === c.id);
  const now = await capture(`<h1>H</h1><p>${c.body}</p>`, 20000, c.prefix, true) as any;
  assert.equal(now.html_sha256, old.html_sha256, "same frozen input");
  assert.equal(now.cli.code, 0, now.cli.stderr);
  assert.deepEqual(now.checkInputs, now.localInputs, "both entry points send identical complete chunks");
  assert.ok(now.checkInputs.every((t: string) => t.length <= MAX_INPUT_CHARS && t.startsWith(c.prefix)));
  if (c.id === "control") {
    const { id, ...expected } = old;
    assert.deepEqual(now, expected, "ordinary short input is unchanged");
  } else {
    assert.equal(old.cli.stdout.marked, false);
    assert.ok(old.checkInputs.every((t: string) => !t.includes("PAYLOAD")), "6b13916 checked only a prefix");
    assert.match(old.cli.stdout.message, /In local mode this text would get 0 signs/);
    assert.equal(now.cli.stdout.marked, true);
    assert.match(now.cli.stdout.message, /In local mode this text would get 1 sign\./);
    assert.equal(now.replies[0].warned, 1);
    assert.deepEqual(now.replies, old.replies, "local mode's existing coverage and warning stay unchanged");
    assert.ok(now.checkInputs.some((t: string) => t.includes("PAYLOAD")));
    if (c.id === "chunked") assert.equal(now.checkInputs.length, 2);
  }
});
