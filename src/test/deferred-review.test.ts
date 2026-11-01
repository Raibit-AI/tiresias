// SPDX-License-Identifier: Apache-2.0
// Deferred pre-v1.0 review findings: all fixtures and requests stay local.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { freshHome, neverAsk, html, logText, serve, text } from "./helper.js";
import { makeZip } from "./zipmaker.js";
import type { Receipt } from "../types.js";

freshHome();
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
process.env.TIRESIAS_RENDER_MS = "20000";
delete process.env.TIRESIAS_RENDERING;
const engine = await import("../engine.js");
const handoffs = await import("../handoffs.js");
const render = await import("../render.js");
const saved = await import("../saved.js");
const { cachePath } = await import("../store.js");
const { PARSER_VERSION } = await import("../types.js");
const ctx = { agent: "deferred-review" };
const uc = (e: { untrusted_content: unknown }) => e.untrusted_content as Record<string, any>;
const config = (home: string, o: Record<string, unknown>) => fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(o));
const needChrome = process.env.TIRESIAS_TEST_NO_CHROME === "1" ? "Chrome tests disabled by TIRESIAS_TEST_NO_CHROME" : !render.findChrome() ? "Chrome is not installed: render-only test skipped" : false;
after(async () => (await import("../sandbox.js")).stopWorker());

const PAGE = '<html lang="en"><body><h1>Budget report</h1><p>The city council approved the new budget on Tuesday, and the mayor said it would help schools across the region.</p></body></html>';
const SHELL = '<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>';
const OFFICE_TEXT = "The city council approved the new budget on Tuesday, and the mayor said it would help schools across the region.";
const OFFICE = makeZip([
  { name: "[Content_Types].xml", data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
  { name: "_rels/.rels", data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
  { name: "word/document.xml", data: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${OFFICE_TEXT}</w:t></w:r></w:p></w:body></w:document>` },
]);
function hook(home: string, mode = "ok") {
  const file = path.join(home, "translator.mjs");
  const seen = path.join(home, "seen.json");
  fs.writeFileSync(file, `import fs from 'node:fs';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ input, args: process.argv.slice(2) }));
  ${mode === "sleep" ? "setInterval(() => {}, 1000);" : "process.stdout.write('TRANSLATED: ' + input.toUpperCase());"}
});`);
  return { seen, translator: { command: [process.execPath, file], timeout_seconds: 20 } };
}
async function untilSeen(file: string) {
  const end = Date.now() + 10_000;
  while (!fs.existsSync(file) && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  assert.ok(fs.existsSync(file), "the translation hook reached its input");
}

test("7.18: Office first look, section, question and outline translate only the final shown text, with original receipts", async () => {
  const home = freshHome();
  neverAsk(home);
  const h = hook(home);
  config(home, { translator: h.translator });
  const srv = await serve((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    if (req.url !== "/office") return text(res, "", 404);
    res.writeHead(200, { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    res.end(OFFICE);
  });
  try {
    for (const opts of [{}, { section: 1 }, { question: "budget" }, { page: 1 }]) {
      const out = await engine.read(srv.url + "/office", { ...opts, translate: "fr" }, ctx);
      assert.equal(out.status, "file_warning");
      assert.equal(out.translation?.status, "ok", JSON.stringify(out));
      const shown = (await import("../translate.js")).shownText({ inside: uc(out).inside });
      const got = JSON.parse(fs.readFileSync(h.seen, "utf8"));
      assert.equal(got.input, shown);
      assert.match(got.input, /The city council approved/);
      assert.match(uc(out).translation.text, /^TRANSLATED:/);
      assert.ok(uc(out).receipts.length);
      assert.ok(uc(out).receipts.every((r: Receipt) => !r.quote.includes("TRANSLATED:")));
    }
    assert.ok(!logText(home, "receipts").includes("TRANSLATED:"));
    const notAsked = await engine.read(srv.url + "/office", {}, ctx);
    assert.equal(notAsked.translation, undefined);
    const checked = await engine.check(srv.url + "/office", ctx);
    assert.equal(checked.translation, undefined);
    config(home, {});
    const unavailable = await engine.read(srv.url + "/office", { translate: "fr" }, ctx);
    assert.equal(unavailable.translation?.reason, "not_set");
  } finally {
    await srv.close();
  }
});

test("7.20: resume restores translation on both paths and consults the current translator setting", async () => {
  const home = freshHome();
  neverAsk(home);
  const h = hook(home);
  config(home, { translator: h.translator });
  let open = false;
  const srv = await serve((req, res) => {
    if (req.url === "/robots.txt" || req.url !== "/report") return text(res, "", 404);
    html(res, open ? PAGE : "<html><body>Forbidden</body></html>", {}, open ? 200 : 403);
  });
  try {
    for (const person of [false, true]) {
      open = false;
      const first = await engine.read(srv.url + "/report", { question: "budget", translate: "fr" }, ctx);
      const id = first.handoff!.ticket!;
      assert.equal(handoffs.get(id, 7)?.translate, "fr");
      open = true;
      const out = await engine.resume(id, person ? { text: PAGE } : undefined, ctx);
      assert.equal(out.translation?.status, "ok");
      assert.match(out.message!, /translation by the owner's own tool/);
      assert.equal(uc(out).question, "budget");
      assert.equal(out.ticket?.open, false);
    }
    open = false;
    const first = await engine.read(srv.url + "/report", { translate: "fr" }, ctx);
    config(home, {}); // the owner removed the translator after the wall
    const out = await engine.resume(first.handoff!.ticket!, { text: PAGE }, ctx);
    assert.equal(out.translation?.reason, "not_set");
  } finally {
    await srv.close();
  }
});

test("7.20: restored rendering consults current settings even without Chrome", async () => {
  const home = freshHome();
  neverAsk(home);
  config(home, { rendering: "ask" });
  let open = false;
  const srv = await serve((req, res) => {
    if (req.url === "/robots.txt" || req.url !== "/report") return text(res, "", 404);
    html(res, open ? SHELL : "<html><body>Forbidden</body></html>", {}, open ? 200 : 403);
  });
  try {
    const first = await engine.read(srv.url + "/report", { render: true, translate: "fr" }, ctx);
    const id = first.handoff!.ticket!;
    assert.equal(handoffs.get(id, 7)?.render, true);
    assert.equal(handoffs.get(id, 7)?.translate, "fr");
    open = true;
    config(home, { rendering: "bad-setting" });
    const bad = await engine.resume(id, undefined, ctx);
    assert.equal(bad.status, "error");
    assert.equal(bad.ticket?.open, true);
    config(home, { rendering: "off" });
    const disabled = await engine.resume(id, undefined, ctx);
    assert.equal(disabled.render?.status, "not_allowed");
    assert.equal(disabled.translation?.reason, "not_set");
    assert.equal(srv.count("/app.js"), 0);
  } finally {
    await srv.close();
  }
});

test("7.20: a rendered wall stays walled on resume; the owner's current rendering setting wins", { skip: needChrome }, async () => {
  const home = freshHome();
  neverAsk(home);
  config(home, { rendering: "ask" });
  let walled = true;
  const srv = await serve((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    if (req.url === "/report") return html(res, SHELL);
    if (req.url === "/app.js") return text(res, `document.getElementById('root').innerHTML = ${JSON.stringify(walled ? '<form><input type="password"><button>Sign in</button></form>' : '<h1>Report</h1><p>The city council approved the budget.</p>')};`, 200, { "content-type": "application/javascript" });
    text(res, "", 404);
  });
  try {
    const first = await engine.read(srv.url + "/report", { render: true }, ctx);
    assert.equal(first.status, "wall", JSON.stringify(first));
    const id = first.handoff!.ticket!;
    assert.equal(handoffs.get(id, 7)?.render, true);
    const again = await engine.resume(id, undefined, ctx);
    assert.equal(again.status, "wall", JSON.stringify(again));
    assert.equal(again.render?.status, "rendered");
    assert.equal(again.ticket?.open, true);
    // A changed owner setting is read again; no script is run when rendering is now off.
    config(home, { rendering: "off" });
    const hits = srv.count("/app.js");
    const disabled = await engine.resume(id, undefined, ctx);
    assert.equal(disabled.render?.status, "not_allowed");
    assert.equal(srv.count("/app.js"), hits);
    config(home, { rendering: "ask" });
    walled = false;
    const next = handoffs.create({ url: srv.url + "/report", reason: "login_required", render: true }).ticket!;
    const ok = await engine.resume(next.id, undefined, ctx);
    assert.equal(ok.render?.status, "rendered");
    assert.equal(ok.ticket?.open, false);
    assert.match(JSON.stringify(uc(ok)), /council approved/);
  } finally {
    await srv.close();
  }
});

test("7.21: cancellation and the call deadline during translation leave cache, receipts and snapshots untouched", async (t) => {
  for (const deadline of [false, true]) {
    const home = freshHome();
    neverAsk(home);
    config(home, { saving: "ask" });
    let body = PAGE;
    const srv = await serve((req, res) => {
      if (req.url === "/robots.txt" || req.url !== "/report") return text(res, "", 404);
      html(res, body);
    });
    const ac = new AbortController();
    let pending: Promise<Awaited<ReturnType<typeof engine.read>>> | undefined;
    try {
      await engine.read(srv.url + "/report", {}, ctx);
      const cache = fs.readFileSync(cachePath(srv.url + "/report"), "utf8");
      const receipts = logText(home, "receipts");
      const h = hook(home, "sleep");
      config(home, { saving: "ask", translator: h.translator });
      body = PAGE.replace("Tuesday", "Friday");
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      if (deadline) t.mock.method(AbortSignal, "timeout", (ms: number) => ms === 60_000 ? ac.signal : timeout(ms));
      pending = engine.read(srv.url + "/report", { translate: "fr", save: true }, deadline ? ctx : { ...ctx, signal: ac.signal });
      await untilSeen(h.seen);
      // Also check during the hook: effects must not merely be cleaned up after cancellation.
      assert.equal(fs.readFileSync(cachePath(srv.url + "/report"), "utf8"), cache);
      assert.equal(logText(home, "receipts"), receipts);
      assert.equal(saved.list().count, 0);
      ac.abort(deadline ? new DOMException("Call deadline", "TimeoutError") : undefined);
      const out = await pending;
      assert.equal(out.status, "error");
      assert.match(out.message!, /cancelled/);
      assert.equal(fs.readFileSync(cachePath(srv.url + "/report"), "utf8"), cache);
      assert.equal(logText(home, "receipts"), receipts);
      assert.equal(saved.list().count, 0);
    } finally {
      ac.abort();
      await pending;
      t.mock.restoreAll();
      await srv.close();
    }
  }
});

test("9.26: an unrendered JavaScript shell gets a fixed rendering hint, including fresh and revalidated cache reads", async () => {
  const home = freshHome();
  neverAsk(home);
  config(home, { rendering: "off" });
  const srv = await serve((req, res) => {
    if (req.url === "/robots.txt" || req.url !== "/app") return text(res, "", 404);
    if (req.headers["if-none-match"]) { res.writeHead(304, { "cache-control": "max-age=600" }); return res.end(); }
    html(res, SHELL, { etag: '"shell"', "cache-control": "max-age=600", age: "600" });
  });
  try {
    for (const cache of [undefined, "revalidated", "fresh"]) {
      const out = await engine.read(srv.url + "/app", { page: 1 }, ctx);
      assert.equal(out.cache, cache);
      assert.deepEqual(uc(out).outline, []);
      assert.match(out.message!, /This page looks like a JavaScript-only shell\. Ask for rendering to read its content\./);
    }
  } finally {
    await srv.close();
  }
});

test("9.27: an unchanged saving read says it fetched again to save it", async () => {
  const home = freshHome();
  neverAsk(home);
  config(home, { saving: "ask" });
  const srv = await serve((req, res) => {
    if (req.url === "/robots.txt" || req.url !== "/report") return text(res, "", 404);
    html(res, PAGE, { "cache-control": "max-age=600" });
  });
  try {
    await engine.read(srv.url + "/report", {}, ctx);
    const before = srv.count("/report");
    const out = await engine.read(srv.url + "/report", { save: true }, ctx);
    assert.equal(srv.count("/report"), before + 1);
    assert.equal(out.cache, "refetched");
    assert.equal(out.saved?.status, "saved");
    assert.match(out.message!, /^Unchanged since [\dT:.Z-]+; fetched again to save it\./);
    assert.ok(!out.message!.includes("Answered from the local cache"));
  } finally {
    await srv.close();
  }
});

test("9.30: unsolicited 304s refetch in full; stale parses and absent or redirected validators are never served", async () => {
  for (const mode of ["stale", "no-validator", "redirect", "persistent-304", "valid"] as const) {
    freshHome();
    let active = false;
    let calls = 0;
    const seen: (string | string[] | undefined)[] = [];
    const srv = await serve((req, res) => {
      if (req.url === "/robots.txt") return text(res, "", 404);
      if (req.url === "/report" && active && mode === "redirect") {
        res.writeHead(302, { location: "/other" }); return res.end();
      }
      if (req.url !== "/report" && req.url !== "/other") return text(res, "", 404);
      if (active) {
        calls++;
        seen.push(req.headers["if-none-match"]);
        if (calls === 1 || mode === "persistent-304") { res.writeHead(304); return res.end(); }
      }
      html(res, active ? PAGE.replace("Tuesday", "Friday") : PAGE, mode === "no-validator" ? {} : { etag: '"report"' });
    });
    const url = srv.url + "/report";
    try {
      await engine.read(url, {}, ctx);
      const cached = JSON.parse(fs.readFileSync(cachePath(url), "utf8"));
      if (mode === "stale" || mode === "persistent-304") cached.parser = PARSER_VERSION - 1;
      if (mode === "stale" || mode === "persistent-304" || mode === "redirect") cached.parsed.sections[0].heading = "OLD PARSE MUST NOT BE SERVED";
      fs.writeFileSync(cachePath(url), JSON.stringify(cached));
      active = true;
      const out = await engine.read(url, { page: 1 }, ctx);
      assert.ok(!JSON.stringify(uc(out)).includes("OLD PARSE MUST NOT BE SERVED"));
      if (mode === "valid") {
        assert.equal(out.cache, "revalidated");
        assert.deepEqual(seen, ['"report"']);
      } else {
        assert.equal(calls, 2, "one bounded retry for a full body");
        assert.deepEqual(seen, [undefined, undefined]);
        if (mode === "persistent-304") {
          assert.equal(out.status, "error");
          assert.match(out.message!, /unexpected 304/);
        } else {
          assert.equal(out.cache, "refetched");
          assert.equal(JSON.parse(fs.readFileSync(cachePath(url), "utf8")).parser, PARSER_VERSION);
        }
      }
    } finally {
      await srv.close();
    }
  }
});

test("9.31: JSON generated headings never get receipts in outlines, sections, questions or saved snapshots", async () => {
  const home = freshHome();
  neverAsk(home);
  config(home, { saving: "ask" });
  const srv = await serve((req, res) => {
    if (req.url === "/robots.txt" || req.url !== "/data") return text(res, "", 404);
    text(res, '{"budget":"The council approved the budget."}', 200, { "content-type": "application/json" });
  });
  try {
    for (const opts of [{}, { section: 1 }, { question: "budget" }]) {
      const out = await engine.read(srv.url + "/data", { ...opts, save: true }, ctx);
      assert.equal(out.saved?.status, "saved");
      assert.ok(uc(out).receipts.length);
      assert.ok(uc(out).receipts.every((r: Receipt) => r.quote !== "(JSON)"));
      const verified = await saved.verify(out.saved!.id!);
      assert.equal(verified.ok, true, JSON.stringify(verified));
      const manifest = saved.show(out.saved!.id!).untrusted_content!.manifest;
      assert.ok(manifest.receipts.every((r) => r.quote !== "(JSON)"));
    }
  } finally {
    await srv.close();
  }
});

test("9.31: saved verify rejects legacy JSON, top-of-page and structured-data label receipts but verifies source words", async () => {
  freshHome();
  const url = "https://saved.example/report";
  for (const [read_as, body, label, quote] of [
    ["json", '{"budget":"Approved"}', "(JSON)", '"budget": "Approved"'],
    ["html", "<html><body><p>The budget was approved.</p></body></html>", "(top of page)", "The budget was approved."],
    ["html", '<html><body><script type="application/ld+json">{"@type":"Report","name":"Budget"}</script></body></html>', "(structured data)", '"name": "Budget"'],
  ] as const) {
    const top = saved.saveSnapshot({ url, source_url: url, final_url: url, status: 200, content_type: read_as === "json" ? "application/json" : "text/html", read_as, file_flags: [], language_header: null, received: Buffer.from(body) }, [label, quote].map((quote) => ({ url, quote, section: 1, fetched_at: new Date().toISOString() })));
    assert.equal(top.status, "saved");
    const out = await saved.verify(top.id!);
    assert.equal(out.signature, "ok");
    assert.equal(out.ok, false);
    assert.deepEqual(out.receipts?.map((r) => r.quote), ["not_found", "found"], label);
  }
});
