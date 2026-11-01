// SPDX-License-Identifier: Apache-2.0
// The bounded JSON pretty-printer: same bytes as JSON.stringify(x, null, 2), never more than the cap in memory.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { MAX_EXPANDED, MAX_PRETTY_DEPTH, boundedPretty, parseJsonText } from "../reader.js";

const same = (v: unknown) => {
  const r = boundedPretty(v);
  assert.equal(r.text, JSON.stringify(v, null, 2));
  assert.equal(r.omitted, 0);
  assert.equal(r.exact, true);
};

test("identical to JSON.stringify(x, null, 2) for ordinary documents", () => {
  const docs: unknown[] = [
    null, true, false, 0, -0, 1, -1.5, 1e21, 1e-7, 123456789012345680000, "", "plain", "quote \" backslash \\ slash / tab \t nl \n cr \r", "\u0000\u001f\u007f",
    "unicode: é 中文 😀   ", "lone \ud800 surrogate",
    [], {}, [[]], [{}], {}, { a: [] }, { a: {} }, [1, 2, 3], { a: 1, b: "two", c: [true, false, null] },
    { "key with \"quotes\"": 1, "é": 2, "": 3, "10": "a", "2": "b", "__proto__": 4, constructor: 5 },
    [[[]], [[], [[]]], { x: { y: { z: [1, { w: [] }] } } }],
    { users: [{ id: 1, name: "A", tags: ["x", "y"], addr: { city: "C", geo: [1.5, -2.5] } }, { id: 2, name: "B", tags: [], addr: {} }] },
  ];
  for (const d of docs) same(d);
  // parsed from text, as the reader does it (so "__proto__" is an own key)
  same(JSON.parse('{"__proto__":{"a":1},"b":[1,2,{"c":null}]}'));
  // a pseudo-random set of shapes
  let seed = 12345;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  const gen = (d: number): unknown => {
    const t = rnd(d > 4 ? 4 : 7);
    if (t === 0) return rnd(1000) / 7;
    if (t === 1) return "s" + rnd(100) + "\né\"";
    if (t === 2) return rnd(2) === 0;
    if (t === 3) return null;
    if (t <= 5) return Array.from({ length: rnd(5) }, () => gen(d + 1));
    return Object.fromEntries(Array.from({ length: rnd(5) }, (_, i) => ["k" + i + rnd(3), gen(d + 1)]));
  };
  for (let i = 0; i < 300; i++) same(gen(0));
});

test("at the cap it keeps exactly the first MAX_EXPANDED characters and counts the rest exactly", () => {
  const wide = { a: Array.from({ length: 150_000 }, (_, i) => ({ k: i, v: "x" })) };
  const full = JSON.stringify(wide, null, 2);
  assert.ok(full.length > MAX_EXPANDED);
  const r = boundedPretty(wide);
  assert.equal(r.text.length, MAX_EXPANDED);
  assert.equal(r.text, full.slice(0, MAX_EXPANDED));
  assert.equal(r.omitted, full.length - MAX_EXPANDED);
  assert.equal(r.exact, true);
  // a small cap works the same way, at every cut point
  const doc = { a: [1, { b: "x\ny" }, []], c: {} };
  const f = JSON.stringify(doc, null, 2);
  for (let max = 0; max <= f.length + 2; max++) {
    const q = boundedPretty(doc, max);
    assert.equal(q.text, f.slice(0, max));
    assert.equal(q.omitted, Math.max(0, f.length - max));
  }
});

test("round 8's 94,001-byte nested document stays small in memory (a 32 MB heap limit)", () => {
  const nested = "[".repeat(47_000) + "1" + "]".repeat(47_000);
  assert.equal(nested.length, 94_001);
  // the old code built a ~48 MB string; this runs in a process that is not allowed that much
  const script = `
    import { boundedPretty, parseJsonText, MAX_EXPANDED } from ${JSON.stringify("file://" + path.resolve("dist/reader.js"))};
    const nested = "[".repeat(47000) + "1" + "]".repeat(47000);
    const r = boundedPretty(JSON.parse(nested));
    const p = parseJsonText(nested, "http://x.test/");
    console.log(JSON.stringify({ len: r.text.length, omitted: r.omitted, exact: r.exact, heapMB: process.memoryUsage().heapUsed / 1e6, pomit: p.text_omitted, textChars: p.text_chars, max: MAX_EXPANDED }));
  `;
  const run = spawnSync(process.execPath, ["--max-old-space-size=32", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.len, out.max);
  assert.ok(out.omitted > 40_000_000, `omitted ${out.omitted}`); // ~48 MB of expansion, counted but never built
  assert.equal(out.exact, true);
  assert.equal(out.pomit, out.omitted);
  // the count is the real length of the full expansion, worked out by arithmetic:
  // N "[" characters; a newline and indent before every "[" except the first; the 1 on its own line; then N closing lines
  const N = 47_000;
  let full = N;
  for (let k = 1; k < N; k++) full += 1 + 2 * k;
  full += 1 + 2 * N + 1;
  for (let k = N - 1; k >= 0; k--) full += 1 + 2 * k + 1;
  assert.equal(out.omitted, full - out.max);
  assert.ok(out.heapMB < 32, `heap ${out.heapMB} MB`);
});

test("deep nesting does not overflow the stack; past the depth cap the count is a lower bound and says so", () => {
  const depth = 200_000;
  const doc = "[".repeat(depth) + "]".repeat(depth);
  const r = boundedPretty(JSON.parse(doc));
  assert.equal(r.text.length, MAX_EXPANDED);
  assert.equal(r.exact, false);
  assert.ok(r.omitted > 0);
  const p = parseJsonText(doc, "http://x.test/");
  assert.equal(p.text_omitted_at_least, true);
  assert.ok((p.text_omitted ?? 0) > 0);
  // just inside the cap is still exact
  const ok = boundedPretty(JSON.parse("[".repeat(MAX_PRETTY_DEPTH - 1) + "]".repeat(MAX_PRETTY_DEPTH - 1)));
  assert.equal(ok.exact, true);
  // objects nested deep too
  let o: unknown = 1;
  for (let i = 0; i < 150_000; i++) o = { a: o };
  assert.equal(boundedPretty(o).exact, false);
  // ordinary documents keep text_omitted undefined
  const small = parseJsonText('{"a":[1,2]}', "http://x.test/");
  assert.equal(small.text_omitted, undefined);
  assert.equal(small.text_omitted_at_least, undefined);
});

test("raw text that is not JSON is still cut at the cap and counted", () => {
  const raw = "not json ".repeat(Math.ceil((MAX_EXPANDED + 1000) / 9));
  const p = parseJsonText(raw, "http://x.test/");
  assert.equal(p.text_omitted, raw.length - MAX_EXPANDED);
  assert.equal(p.text_omitted_at_least, undefined);
});

test("parser version moved so caches made before the bounded printer are re-read", async () => {
  const { PARSER_VERSION } = await import("../types.js");
  assert.ok(PARSER_VERSION >= 5);
});
