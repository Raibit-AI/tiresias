// SPDX-License-Identifier: Apache-2.0
// Deferred pre-v1 findings: atomic writes, bounded nesting/results and literal Markdown code.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { freshHome } from "./helper.js";
import { parseHtml, parseMarkdown } from "../reader.js";
import { MAX_DOM_DEPTH, parseDocument } from "../dom.js";
import { runUntrusted, stopWorker } from "../sandbox.js";
import type { ParsedPage } from "../types.js";
import { writeJson } from "../store.js";

freshHome();
after(stopWorker);

test("9.8: writeJson completes short byte writes, including multibyte JSON", (t) => {
  const home = freshHome(), target = path.join(home, "short.json");
  const data = { text: "船😀 café" };
  const write = fs.writeSync;
  t.mock.method(fs, "writeSync", (fd: number, data: string | Buffer, off = 0, len?: number) => {
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    return write(fd, buf, off, Math.min(3, len ?? buf.length));
  });
  writeJson(target, data);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), data);
  assert.ok(!fs.readdirSync(home).some((f) => f.endsWith(".tmp")));
});

test("9.8: zero progress or a failed write leaves the old target and removes the temp file", (t) => {
  const home = freshHome(), target = path.join(home, "failed.json");
  fs.writeFileSync(target, '{"old":true}');
  const write = fs.writeSync;
  for (const mode of ["zero", "throw"]) {
    let calls = 0;
    const mock = t.mock.method(fs, "writeSync", (fd: number, data: string | Buffer, off = 0, len?: number) => {
      const buf = typeof data === "string" ? Buffer.from(data) : data;
      if (++calls === 1) return write(fd, buf, off, Math.min(2, len ?? buf.length));
      if (mode === "zero") return 0;
      throw new Error("disk full");
    });
    assert.throws(() => writeJson(target, { replacement: "longer" }), /no progress|disk full/);
    mock.mock.restore();
    assert.equal(fs.readFileSync(target, "utf8"), '{"old":true}');
    assert.ok(!fs.readdirSync(home).some((f) => f.endsWith(".tmp")));
  }
});

test("9.10: deeply nested lists keep every item with at most eight indentation levels", async () => {
  const n = 6000;
  const body = "<ul><li>ITEM ".repeat(n) + "</li></ul>".repeat(n);
  const { parsed } = await runUntrusted<{ parsed: ParsedPage }>({ op: "parse", kind: "html", body, url: "https://x.test/" }, body.length);
  const blocks = parsed.sections.flatMap((s) => s.blocks);
  assert.equal(blocks.reduce((n, b) => n + (b.text.match(/ITEM/g)?.length ?? 0), 0), n);
  for (const b of blocks) assert.ok(/^ */.exec(b.text)![0].length <= 16);
  assert.ok(parsed.text_chars < n * 30);
});

test("9.10: an oversized result is refused in the worker before it can be cloned or cached", async () => {
  // Under the fetch cap, but JSON escaping would expand the answer past the 16 MiB result cap.
  const body = "\0".repeat(3 * 1024 * 1024);
  await assert.rejects(runUntrusted({ op: "parse", kind: "text", body, url: "https://x.test/" }, body.length), /page_too_complex/);
});

test("9.11: deep table and SVG seeds read within the five-second worker budget and keep their text", async () => {
  for (const shape of ["table", "svg"] as const) {
    const n = shape === "table" ? 15000 : 45000;
    const body = shape === "table"
      ? "<table><tr><td>".repeat(n) + "DEEPWORD" + "</td></tr></table>".repeat(n)
      : "<svg>".repeat(n) + "</svg>".repeat(n) + "<p>DEEPWORD</p><form method=post><input name=q></form>";
    const t0 = Date.now();
    const { parsed } = await runUntrusted<{ parsed: ParsedPage }>({ op: "parse", kind: "html", body, url: "https://x.test/" }, body.length);
    assert.ok(Date.now() - t0 < 5000, `${shape} exceeded the parse budget`);
    assert.ok(parsed.sections.some((s) => s.blocks.some((b) => b.text.includes("DEEPWORD"))));
    if (shape === "svg") assert.equal(parsed.forms?.[0].not_allowed, "too_large");
  }
});

test("9.11: the DOM tracks at most 256 elements and flattening never makes forms submittable", () => {
  const body = "<div>".repeat(1000) + "<form method=post><input name=q></form>TAIL" + "</div>".repeat(1000);
  const { doc, flattened } = parseDocument(body);
  assert.equal(flattened, true);
  const stack = [{ n: doc, depth: 0 }];
  while (stack.length) {
    const { n, depth } = stack.pop()!;
    assert.ok(depth <= MAX_DOM_DEPTH + 1); // text may be a child of the deepest element
    if ("children" in n) for (const c of n.children) stack.push({ n: c as typeof doc, depth: depth + 1 });
  }
  const parsed = parseHtml(body, "https://x.test/");
  assert.equal(parsed.forms?.[0].not_allowed, "too_large");
  assert.ok(parsed.sections.some((s) => s.blocks.some((b) => b.text.includes("TAIL"))));
});

test("9.11: flattened elements and text retain rendered marks at the depth cap, including wrappers and raw text", () => {
  const mark = "data-t-0123456789abcdef";
  for (const tag of ["div", "thidden", "textarea", "xmp", "plaintext"]) {
    const body = "<div>".repeat(MAX_DOM_DEPTH - 1) + `<${tag} ${mark}="not_displayed">` +
      "<span>DEEPSECRET</span>TAILSECRET" + `</${tag}><p>SHOWNAFTER</p>` + "</div>".repeat(MAX_DOM_DEPTH - 1);
    for (const complete of [true, false]) {
      const parsed = parseHtml(body, "https://x.test/", undefined, { mark, complete });
      const shown = JSON.stringify(parsed.sections);
      for (const token of ["DEEPSECRET", "TAILSECRET"]) {
        assert.ok(!shown.includes(token), `${tag}: ${token} escaped its mark`);
        assert.ok(parsed.flags.some((f) => f.type === "hidden_text" && f.snippet.includes(token) && f.detail === "rendered: not displayed"), `${tag}: ${token} missing flag`);
      }
      // plaintext consumes the rest of the document, including apparent closing tags.
      if (tag !== "plaintext") assert.ok(shown.includes("SHOWNAFTER"), `${tag}: a later sibling stays readable`);
    }
  }
});

test("9.11: hiding survives repeated flattening and inner end tags, while a sibling outside its source scope is shown", () => {
  const mark = "data-t-0123456789abcdef";
  const cases = [
    { attr: `${mark}="covered"`, rendered: { mark, complete: true } },
    { attr: "hidden" },
    { attr: 'aria-hidden="true"' },
    { attr: 'style="display:none"' },
    { attr: 'class="secret"' },
    { attr: 'id="secret"' },
  ];
  for (const { attr, rendered } of cases) {
    const body = '<style>.secret,#secret{display:none}</style>' + "<div>".repeat(MAX_DOM_DEPTH - 1) +
      `<div ${attr}>` + "<div>".repeat(1000) + "DEEPESTSECRET" + "</div>".repeat(500) +
      "UNWINDSECRET<span style=display:block>CHILDSECRET</span>" + "</div>".repeat(500) +
      "</div><p>SHOWNOUTSIDE</p>" + "</div>".repeat(MAX_DOM_DEPTH - 1);
    const parsed = parseHtml(body, "https://x.test/", undefined, rendered);
    const shown = JSON.stringify(parsed.sections);
    for (const token of ["DEEPESTSECRET", "UNWINDSECRET", "CHILDSECRET"]) {
      assert.ok(!shown.includes(token), `${attr}: ${token} escaped its ancestor`);
      assert.ok(parsed.flags.some((f) => f.type === "hidden_text" && f.snippet.includes(token)), `${attr}: ${token} missing flag`);
    }
    assert.ok(shown.includes("SHOWNOUTSIDE"), `${attr}: source scope did not end`);
    assert.ok(!parsed.flags.some((f) => f.type === "hidden_text" && f.snippet.includes("SHOWNOUTSIDE")));
  }
});

test("9.11: flattened hiding attributes still defer to a complete rendered inspection", () => {
  const body = "<div>".repeat(MAX_DOM_DEPTH - 1) + '<div hidden style="display:none" class="sr-only"><span>RENDEREDSHOWN</span></div>' + "</div>".repeat(MAX_DOM_DEPTH - 1);
  const parsed = parseHtml(body, "https://x.test/", undefined, { mark: "data-t-0123456789abcdef", complete: true });
  assert.ok(JSON.stringify(parsed.sections).includes("RENDEREDSHOWN"));
  assert.ok(!parsed.flags.some((f) => f.type === "hidden_text"));
});

test("9.11: hiding inheritance judges a large ancestor style once under the worker budget", async () => {
  const body = "<div>".repeat(MAX_DOM_DEPTH - 1) + `<div style="display:none;${"x".repeat(500000)}">` +
    "<span>STYLESECRET</span>".repeat(10000) + "</div>".repeat(MAX_DOM_DEPTH);
  const { parsed } = await runUntrusted<{ parsed: ParsedPage }>({ op: "parse", kind: "html", body, url: "https://x.test/" }, body.length);
  assert.ok(!JSON.stringify(parsed.sections).includes("STYLESECRET"));
  assert.ok(parsed.flags.some((f) => f.type === "hidden_text" && f.snippet.includes("STYLESECRET")));
});

test("9.11: deeply nested SVG image text survives flattening under the worker budget", async () => {
  const body = "<svg>" + "<g>".repeat(45000) + "<text>DEEPSVG</text>" + "</g>".repeat(45000) + "</svg>";
  const { parsed } = await runUntrusted<{ parsed: ParsedPage }>({ op: "parse", kind: "svg", body, url: "https://x.test/a.svg" }, body.length);
  assert.ok(parsed.sections.some((s) => s.blocks.some((b) => b.text.includes("DEEPSVG"))));
});

test("9.19: fenced and indented Markdown code preserve whitespace and literal links, headings and comments", () => {
  const code = 'if (ready) {\n  [literal](/not-a-link)\n\n  <!-- literal comment -->\n  # not a heading\n}';
  for (const source of ["```ts\n" + code + "\n```", "~~~ts\n" + code + "\n~~~~", code.split("\n").map((l) => "    " + l).join("\n")]) {
    const p = parseMarkdown("# Code\n\n" + source + "\n\nAfter [real](/yes).", "https://x.test/");
    assert.equal(p.sections.length, 1);
    assert.equal(p.sections[0].blocks[0].text, "```\n" + code + "\n```");
    assert.deepEqual(p.links.map((l) => l.url), ["https://x.test/yes"]);
    assert.equal(p.sections[0].blocks[1].text, "After real.");
  }
});

test("9.19: a shorter fence inside code cannot close it; unclosed fences and tab-indented code keep line breaks", () => {
  const p = parseMarkdown("````\n  one\n```\n    two\n````\n\n\tthree\n\t  four\n\n~~~\n  five\n    six", "https://x.test/");
  assert.deepEqual(p.sections[0].blocks.map((b) => b.text), [
    "````\n  one\n```\n    two\n````", "```\nthree\n  four\n```", "```\n  five\n    six\n```",
  ]);
});
