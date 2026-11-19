// SPDX-License-Identifier: Apache-2.0
// W-39 round 2: exercise attribution through localRead, including the frozen pre-fix replies.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { freshHome, html, logText, serve, text } from "./helper.js";
import { R2_CASES } from "./v12-label-r2-cases.js";
import { BY_SITE, BY_VISITOR } from "../envelope.js";
import { stopWorker } from "../sandbox.js";
import { jsonBytes } from "../types.js";
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
delete process.env.TIRESIAS_PRIVATE;
delete process.env.TIRESIAS_RENDERING;
const { localRead, CUT_FOR_BUDGET } = await import("../local.js");
after(stopWorker);
// v1.2: the old fitting dropped the second paragraph; it now belongs to numbered page 2.
function paginated(reply: any, id: string) {
  const expected = structuredClone(reply);
  if (id === "history-fit" && expected.untrusted_content.section) {
    expected.untrusted_content.section.text = expected.untrusted_content.section.text.replace("\n\n" + CUT_FOR_BUDGET, "");
    expected.untrusted_content.title = expected.untrusted_content.section.heading;
    expected.untrusted_content.section.pages = 2;
    expected.counts.receipts = 3;
  }
  if (id === "huge-inherited" && expected.untrusted_content.section) {
    expected.untrusted_content.section.text = Array(215).fill("Visitor crumb evidence.").join("\n\n");
    expected.untrusted_content.section.pages = 14;
    expected.counts.receipts = 215;
  }
  return expected;
}
const fixturePath = new URL("../../src/test/fixtures/v12-label-r2-before.json", import.meta.url);

async function replies(off = false) {
  const home = freshHome();
  fs.writeFileSync(home + "/config.json", JSON.stringify({ rendering: "off", ...(off ? { written_by: "off" } : {}) }));
  const site = await serve((req, res) => {
    if (req.url === '/robots.txt') return text(res, 'User-agent: *\nAllow: /\n');
    const c = R2_CASES.find(c => '/' + c.id === req.url);
    if (c) return html(res, c.html);
    text(res, 'missing', 404);
  });
  try {
    const out = [];
    for (const c of R2_CASES) {
      const calls = [];
      for (const q of [{ question: c.question }, { section: c.section }]) {
        const reply = await localRead(site.url + '/' + c.id, q, { agent: 'r2' }, c.budget ?? 6_000);
        const history = logText(home, 'history').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).at(-1);
        assert.ok(history, JSON.stringify(reply));
        const normalized = JSON.parse(JSON.stringify(reply).replaceAll(site.url, 'http://SITE').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<time>'));
        calls.push({ reply: normalized, written_by: history.written_by });
      }
      out.push({ id: c.id, html_sha256: createHash('sha256').update(c.html).digest('hex'), calls });
    }
    assert.equal(fs.readFileSync(home + "/config.json", "utf8"), JSON.stringify({ rendering: "off", ...(off ? { written_by: "off" } : {}) }), "reads do not change owner settings");
    return out;
  } finally { await site.close(); }
}

test('W-39 R2: visitor attributes, structured data, headings, flattening and final history through localRead', async (t) => {
  const current = await replies();
  const before = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  assert.equal(before.commit, '485bb04');
  assert.deepEqual(current.map(c => c.id), before.cases.map((c: { id: string }) => c.id));
  for (const c of current) await t.test(c.id, () => {
    assert.equal(c.html_sha256, before.cases.find((b: { id: string }) => b.id === c.id).html_sha256, 'the frozen inputs are unchanged');
    for (const { reply, written_by } of c.calls) {
      assert.ok(['ok', 'unchanged'].includes(reply.status), c.id + ': ' + reply.message);
      assert.ok(!('written_by' in reply) && !('section_visitor' in reply) && !('heading_visitor' in reply));
      assert.ok(jsonBytes(reply.untrusted_content) <= (R2_CASES.find(x => x.id === c.id)!.budget ?? 6_000));
      const parts = [...(reply.untrusted_content.passages ?? []), ...(reply.untrusted_content.section ? [reply.untrusted_content.section] : [])];
      for (const p of parts) {
        const visitor = /Visitor/.test(p.text + ' ' + p.heading) || (c.id.startsWith('heading-data') && p.heading === '(structured data)') || (c.id === 'guarded' && /Withheld/.test(p.text));
        assert.equal(p.written_by, c.id === 'inert-control' ? undefined : visitor ? BY_VISITOR : BY_SITE, `${c.id}: ${JSON.stringify(p)}`);
      }
      if (c.id === 'inert-control') {
        assert.equal(written_by, undefined);
        continue;
      }
      assert.equal(written_by.length, parts.length, c.id + ': history describes the parts shown');
      assert.deepEqual(written_by.map((n: number) => n ? BY_VISITOR : BY_SITE), parts.map(p => p.written_by), c.id + ': history follows final fitting');
    }
    if (['inert-control', 'wrapper', 'guarded', 'history-fit', 'history-passages'].includes(c.id)) {
      assert.deepEqual(c.calls.map(x => x.reply), before.cases.find((b: { id: string }) => b.id === c.id).calls.map((x: { reply: unknown }) => paginated(x.reply, c.id)), 'only the reviewed pagination changes reply bytes');
    }
  });
});

test('W-39 R2: written_by off preserves frozen reply bytes except reviewed pagination and still audits the final text', async () => {
  const before = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  for (const c of await replies(true)) {
    const old = before.off.find((b: { id: string }) => b.id === c.id);
    for (const [i, call] of c.calls.entries()) {
      const expected = paginated(old.calls[i].reply, c.id);
      assert.deepEqual(call.reply, expected, c.id);
      assert.ok(!JSON.stringify(call.reply).includes('written_by'), c.id);
      if (c.id === 'history-fit' && i === 1) assert.deepEqual(call.written_by, [0]);
    }
  }
});

async function legacyReply() {
  const home = freshHome();
  fs.writeFileSync(home + '/config.json', JSON.stringify({ rendering: 'off' }));
  const c = R2_CASES[0];
  const site = await serve((req, res) => {
    if (req.url === '/robots.txt') return text(res, 'User-agent: *\nAllow: /\n');
    if (req.url === '/' + c.id) return html(res, c.html, { 'cache-control': 'max-age=600', etag: '"bread"' });
    text(res, 'missing', 404);
  });
  try {
    const { cachePath } = await import('../store.js');
    const url = site.url + '/' + c.id;
    await localRead(url, { question: c.question }, { agent: 'r2' }, 6_000);
    const file = cachePath(url);
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    // A trusted old cache has the old attribution and no indication that source heading scopes were parsed.
    delete entry.visitor_scopes;
    for (const s of entry.parsed.sections) { delete s.visitor; for (const b of s.blocks) delete b.visitor; }
    fs.writeFileSync(file, JSON.stringify(entry));
    const reply = await localRead(url, { section: 1 }, { agent: 'r2' }, 6_000);
    const hits = site.count('/' + c.id);
    await localRead(url, { section: 1 }, { agent: 'r2' }, 6_000);
    assert.equal(site.count('/' + c.id), hits, 'the repaired fresh copy can be reused');
    return { hits, reply: JSON.parse(JSON.stringify(reply).replaceAll(site.url, 'http://SITE').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<time>')) };
  } finally { await site.close(); }
}

test('W-39 R2: a fresh legacy cache is rebuilt before local attribution is served', async () => {
  const current = await legacyReply();
  const before = JSON.parse(fs.readFileSync(fixturePath, 'utf8')).legacy_cache;
  assert.equal(before.hits, 1, 'the old reader reused the stale attribution');
  assert.equal(before.reply.untrusted_content.section.written_by, undefined);
  assert.equal(current.hits, 2, 'the source was fetched again');
  assert.equal(current.reply.untrusted_content.section.written_by, BY_VISITOR);
});
