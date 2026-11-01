// SPDX-License-Identifier: Apache-2.0
// W-28 (v0.8): save page. Signed snapshots of the bytes a read received, checked by `saved verify`.
import assert from "node:assert/strict";
import { createHash, sign as edSign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { freshHome, neverAsk, logText, serve, text } from "./helper.js";
import { makeZip } from "./zipmaker.js";
import type { SaveInput } from "../saved.js";

const home = freshHome();
// W-32 (v0.9): this file writes risky settings by hand; confirmations are tested in confirm.test.ts.
neverAsk(home);
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
process.env.TIRESIAS_RENDER_MS = "20000"; // v0.9 rehearsal: its one render starts Chrome cold, so it keeps the real limit (see render.test.ts)
delete process.env.TIRESIAS_RENDERING;
const engine = await import("../engine.js");
const saved = await import("../saved.js");
const settings = await import("../settings.js");
const render = await import("../render.js");
const { clearStore } = await import("../cleanup.js");
const { ensureSlipKey } = await import("../keys.js");
const { createServer } = await import("../mcp.js");
const ctx = { agent: "saved-test" };
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const uc = (e: { untrusted_content: unknown }) => e.untrusted_content as Record<string, any>;
const config = (o: Record<string, unknown>) => fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(o));
const savedDir = () => path.join(home, "saved");
const snapshots = () => (fs.existsSync(savedDir()) ? fs.readdirSync(savedDir()).filter((n) => /^[0-9a-f]{64}$/.test(n)) : []);
const CHROME = process.env.TIRESIAS_TEST_NO_CHROME === "1" ? null : render.findChrome();
const needChrome = CHROME ? false : "Google Chrome is not installed: render-only test skipped";

// A Latin-1 page sent gzip-compressed: the snapshot keeps the decompressed bytes, before charset decoding.
const LATIN = Buffer.from("<html><head><title>Caf\xe9 news</title></head><body><main><h1>The caf\xe9 reopens</h1><p>The old caf\xe9 on the square reopens on Monday with a new menu and longer hours.</p></main></body></html>", "latin1");
const ELF = Buffer.concat([Buffer.from("\x7fELF\x02\x01\x01", "latin1"), Buffer.alloc(400, 0x41)]);
const BIG = `<html><body><main><h1>Big</h1><p>${"word ".repeat(120_000)}</p></main></body></html>`;
const LONG_TYPE = `text/html; padding=${"x".repeat(1100)}; charset=iso-8859-1`;
const NUL_TEXT = "Ordinary opening words.\n".repeat(2000) + "The authentic quote contains a \u0000 right here and continues afterwards.";
const OFFICE = makeZip([
  { name: "[Content_Types].xml", data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
  { name: "_rels/.rels", data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
  { name: "word/document.xml", data: '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Office report says that sales rose by twelve percent this year.</w:t></w:r></w:p></w:body></w:document>' },
]);
let n = 0;
const s = await serve((req, res) => {
  const u = req.url ?? "";
  if (u === "/robots.txt") return text(res, "", 404);
  if (u === "/late-charset") {
    res.writeHead(200, { "content-type": LONG_TYPE });
    return void res.end(LATIN);
  }
  if (u === "/nul") return text(res, NUL_TEXT);
  if (u.startsWith("/long?")) return text(res, "An ordinary page served at a very long URL.");
  if (u === "/office" || u === "/office-nostore") {
    res.writeHead(200, { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ...(u.endsWith("nostore") ? { "cache-control": "no-store" } : {}) });
    return void res.end(OFFICE);
  }
  if (u === "/tool-nostore") {
    res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" });
    return void res.end(ELF);
  }
  if (u === "/surrogate") {
    res.writeHead(200, { "content-type": "text/html" });
    return void res.end('<html><body><h1>Surrogate report</h1><p id="r"></p><script>document.getElementById("r").textContent = "The report contains " + String.fromCharCode(0xd800) + " between these words.";</script></body></html>');
  }
  if (u === "/inspection") {
    res.writeHead(200, { "content-type": "text/html" });
    return void res.end('<html><body><h1>Inspection report</h1><p>Public figures are available in the annual report.</p><p aria-hidden="true">Visible override figures rose by twelve percent.</p></body></html>');
  }
  if (u.startsWith("/cafe")) {
    res.writeHead(200, { "content-type": "text/html; charset=iso-8859-1", "content-encoding": "gzip", "cache-control": "max-age=600" });
    return void res.end(zlib.gzipSync(LATIN));
  }
  if (u === "/nostore") {
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    return void res.end("<html><body><h1>Private</h1><p>Do not keep this page anywhere at all please.</p></body></html>");
  }
  if (u === "/tool") {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    return void res.end(ELF);
  }
  if (u.startsWith("/big")) {
    res.writeHead(200, { "content-type": "text/html" });
    return void res.end(BIG);
  }
  if (u === "/app") {
    res.writeHead(200, { "content-type": "text/html" });
    return void res.end(`<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>`);
  }
  if (u === "/app.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    return void res.end(`document.getElementById("root").innerHTML = "<h1>Rendered report</h1><p>Sales rose by twelve percent in the third quarter this year.</p>";`);
  }
  if (u === "/wall") {
    res.writeHead(403, { "content-type": "text/html" });
    return void res.end("<html><body>no</body></html>");
  }
  n++;
  text(res, "", 404);
});
after(() => s.close());

test("W-28 setting: saving is off by default; a read that asks saves nothing and says not_allowed; only the CLI settings change it", async () => {
  const row = settings.view().settings.find((r: any) => r.name === "saving");
  assert.equal(row?.value, "off");
  const r = await engine.read(s.url + "/cafe", { save: true }, ctx);
  assert.equal(r.status, "ok");
  assert.equal(r.saved?.status, "not_allowed");
  assert.match(r.message ?? "", /owner has not allowed saving/);
  assert.equal(snapshots().length, 0);
  assert.ok(uc(r).receipts.every((x: any) => x.snapshot === undefined));
  // A bad value fails by name; set and reset through the settings command.
  assert.throws(() => settings.command(["set", "saving", "always"], false), /saving/);
  assert.equal(settings.command(["set", "saving", "ask"], false).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).saving, "ask");
  settings.command(["reset", "saving"], false);
});

test("W-28: save and verify: the received bytes (decompressed, before charset), signed manifest, receipts name the snapshot", async () => {
  config({ saving: "ask" });
  await engine.read(s.url + "/cafe", {}, ctx); // a fresh cached copy (max-age): a save still fetches
  const before = s.count("/cafe");
  const r = await engine.read(s.url + "/cafe", { save: true }, ctx);
  assert.equal(r.status, "unchanged", r.message); // the same bytes as the cached copy: the content comes back with receipts
  assert.equal(s.count("/cafe"), before + 1, "a save always fetches");
  assert.equal(r.saved?.status, "saved", JSON.stringify(r.saved));
  const id = r.saved!.id!;
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.deepEqual(snapshots(), [id]);
  const dir = path.join(savedDir(), id);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["manifest.json", "received"]);
  assert.ok(fs.readFileSync(path.join(dir, "received")).equals(LATIN), "the decompressed bytes, before charset decoding");
  for (const f of ["manifest.json", "received"]) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const rcs = uc(r).receipts as any[];
  assert.ok(rcs.length > 0 && rcs.every((x) => x.snapshot === id), "every receipt of the read names the snapshot");
  const logged = logText(home, "receipts").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.snapshot === id);
  assert.equal(logged.length, rcs.length, "the receipts log records the snapshot too");
  assert.match(logText(home, "history"), /"saved":true/);
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  assert.equal(m.id, id);
  assert.equal(m.files[0].sha256, sha(LATIN));
  assert.equal(m.read_as, "html");
  assert.equal(saved.snapshotId(m), id);
  assert.match(saved.snapshotFingerprint(m), /^sha256:[0-9a-f]{64}$/);
  assert.match(saved.receiptFingerprint(m.receipts[0]), /^sha256:[0-9a-f]{64}$/);
  const v = await saved.verify(id.slice(0, 12));
  assert.equal(v.ok, true, v.message);
  assert.equal(v.signature, "ok");
  assert.ok(v.receipts!.length > 0 && v.receipts!.every((x) => x.quote === "found" && x.snapshot_matches));
  assert.ok(v.receipts!.length >= 2);
  // list and show
  const l = saved.list();
  assert.equal(l.count, 1);
  assert.equal(l.saved[0].id, id);
  assert.equal(l.untrusted_content.urls[0].final_url, s.url + "/cafe");
  assert.equal(saved.show(id).untrusted_content?.manifest.id, id);
});

test("W-28: a tampered snapshot is detected (a changed byte, a missing file, an extra file)", async () => {
  const r = await engine.read(s.url + "/cafe?t", { save: true }, ctx);
  const id = r.saved!.id!;
  const file = path.join(savedDir(), id, "received");
  const orig = fs.readFileSync(file);
  const changed = Buffer.from(orig);
  changed[changed.indexOf("Monday")] = "S".charCodeAt(0);
  fs.writeFileSync(file, changed);
  let v = await saved.verify(id);
  assert.equal(v.ok, false);
  assert.deepEqual(v.files, [{ name: "received", ok: false, problem: "hash" }]);
  assert.ok(v.receipts!.every((x) => x.quote === "not_checked"), "quotes are never checked against bytes that do not match");
  fs.writeFileSync(file, orig);
  assert.equal((await saved.verify(id)).ok, true);
  fs.writeFileSync(path.join(savedDir(), id, "extra"), "x");
  v = await saved.verify(id);
  assert.equal(v.ok, false);
  assert.equal(v.extra_files, 1);
  fs.rmSync(path.join(savedDir(), id, "extra"));
  fs.rmSync(file);
  v = await saved.verify(id);
  assert.equal(v.ok, false);
  assert.equal(v.files![0].problem, "missing");
});

test("W-28: a tampered manifest is detected (URL, quote, file hash, signature); a correctly signed receipt with a quote not in the bytes fails the quote check", async () => {
  const r = await engine.read(s.url + "/cafe?m", { save: true }, ctx);
  const id = r.saved!.id!;
  const mf = path.join(savedDir(), id, "manifest.json");
  const orig = JSON.parse(fs.readFileSync(mf, "utf8"));
  const write = (m: unknown) => fs.writeFileSync(mf, JSON.stringify(m));
  write({ ...orig, final_url: "https://evil.example/" });
  let v = await saved.verify(id);
  assert.equal(v.ok, false);
  assert.equal(v.signature, "bad");
  assert.equal(v.id_matches, false);
  write({ ...orig, receipts: orig.receipts.map((x: any, i: number) => (i === 0 ? { ...x, quote: "Something it never said" } : x)) });
  v = await saved.verify(id);
  assert.equal(v.signature, "bad");
  assert.equal(v.receipts![0].quote, "not_checked", "a manifest that does not verify never chooses work for the reader");
  assert.equal(v.quotes_unchecked_reason, "not_authentic");
  write({ ...orig, sig: "A".repeat(86) });
  assert.equal((await saved.verify(id)).signature, "bad");
  write({ ...orig, extra: 1 });
  assert.equal((await saved.verify(id)).manifest, "damaged");
  fs.writeFileSync(mf, "{not json");
  assert.equal((await saved.verify(id)).manifest, "damaged");
  // Signed by the right key but quoting text that is not in the bytes: the signature passes, the quote check does not.
  const { sig: _s, ...rest } = { ...orig, receipts: [...orig.receipts, { ...orig.receipts[0], quote: "The square is closed forever." }] };
  const sig = edSign(null, Buffer.from(`["tiresias-saved-page",${saved.canonical(rest)}]`), ensureSlipKey().priv).toString("base64url");
  write({ ...rest, sig });
  v = await saved.verify(id);
  assert.equal(v.signature, "ok");
  assert.equal(v.ok, false);
  assert.equal(v.receipts!.at(-1)!.quote, "not_found");
  assert.match(v.message, /quote was not found/);
  write(orig);
  assert.equal((await saved.verify(id)).ok, true);
});

test("W-28: private mode never saves (per call and per session)", async () => {
  const count = snapshots().length;
  const r = await engine.read(s.url + "/cafe?p", { save: true }, { ...ctx, private: true });
  assert.equal(r.saved?.status, "private");
  assert.ok(uc(r).receipts.every((x: any) => x.snapshot === undefined));
  process.env.TIRESIAS_PRIVATE = "1";
  try {
    const r2 = await engine.read(s.url + "/cafe?p2", { save: true }, ctx);
    assert.equal(r2.saved?.status, "private");
    assert.throws(() => saved.remove("all"), /Private mode/);
  } finally {
    delete process.env.TIRESIAS_PRIVATE;
  }
  assert.equal(snapshots().length, count);
});

test("W-28: the owner's setting is enforced against MCP: no tool or parameter changes it; save works only when allowed", async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  const client = new Client({ name: "agent", version: "1.0.0" });
  await client.connect(b);
  const tools = (await client.listTools()).tools;
  assert.ok(!tools.some((t) => /sav|setting/.test(t.name)), "no saved or settings tool");
  for (const t of tools) assert.ok(!Object.keys((t.inputSchema.properties ?? {}) as object).includes("saving"), `${t.name} has no saving parameter`);
  config({ saving: "off" });
  const count = snapshots().length;
  const off = JSON.parse(((await client.callTool({ name: "read", arguments: { url: s.url + "/cafe?mcp", save: true } })) as any).content[0].text);
  assert.equal(off.saved.status, "not_allowed");
  assert.equal(snapshots().length, count);
  config({ saving: "ask" });
  const on = JSON.parse(((await client.callTool({ name: "read", arguments: { url: s.url + "/cafe?mcp2", save: true } })) as any).content[0].text);
  assert.equal(on.saved.status, "saved");
  assert.equal(snapshots().length, count + 1);
  await client.close();
});

test("W-28: a file warning saves only its fingerprint, never the file; no-store and walls save nothing", async () => {
  // v0.9.1 (a full-suite flake on 2026-11-01 that would not reproduce): this test sets the setting it needs instead of
  // inheriting it from the MCP test before it, and every check carries the reply, so a failure says why.
  config({ saving: "ask" });
  const r = await engine.read(s.url + "/tool", { save: true }, ctx);
  const why = JSON.stringify(r);
  assert.equal(r.status, "file_warning", why);
  assert.equal(r.saved?.status, "saved", why);
  assert.equal(r.saved?.fingerprint_only, true, why);
  const dir = path.join(savedDir(), r.saved!.id!);
  assert.deepEqual(fs.readdirSync(dir), ["manifest.json"], why);
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  assert.deepEqual(m.files, [], JSON.stringify(m));
  assert.equal(m.file.sha256, sha(ELF), JSON.stringify(m));
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "manifest.json"), "latin1"), /AAAAAAAA|ELF/);
  const v = await saved.verify(r.saved!.id!);
  assert.equal(v.ok, true, JSON.stringify(v));
  const ns = await engine.read(s.url + "/nostore", { save: true }, ctx);
  assert.equal(ns.status, "ok", JSON.stringify(ns));
  assert.deepEqual(ns.saved, { status: "not_saved", reason: "no_store" }, JSON.stringify(ns));
  const w = await engine.read(s.url + "/wall", { save: true }, ctx);
  assert.deepEqual(w.saved, { status: "not_saved", reason: "no_page" }, JSON.stringify(w));
});

test("W-28 caps: a save over max_saved_mb is refused (never evicts); clear removes expired snapshots only by keep_saved_days, never by --all", async () => {
  saved.remove("all");
  config({ saving: "ask", max_saved_mb: 1 });
  const a = await engine.read(s.url + "/big1", { save: true }, ctx);
  assert.equal(a.saved?.status, "saved", JSON.stringify(a.saved));
  const b = await engine.read(s.url + "/big2", { save: true }, ctx);
  assert.equal(b.saved?.status, "over_cap");
  assert.equal(snapshots().length, 1);
  // a temp folder (a save left behind) counts toward the cap too (Codex v0.8 round 3)
  saved.remove("all");
  const tmp = path.join(savedDir(), ".tmp-0123456789abcdef");
  fs.mkdirSync(tmp, { mode: 0o700 });
  fs.writeFileSync(path.join(tmp, "received"), Buffer.alloc(900 * 1024));
  assert.equal((await engine.read(s.url + "/big3", { save: true }, ctx)).saved?.status, "over_cap");
  fs.rmSync(tmp, { recursive: true });
  assert.equal((await engine.read(s.url + "/big4", { save: true }, ctx)).saved?.status, "saved");
  config({ saving: "ask" });
  const all = await clearStore({ all: true });
  assert.equal(all.saved.removed, 0);
  assert.equal(snapshots().length, 1);
  const later = await clearStore({ now: Date.now() + 91 * 86_400_000 });
  assert.equal(later.saved.removed, 1);
  assert.equal(snapshots().length, 0);
});

test("W-28: a rendered read saves the HTML the reader parsed; verify checks its quotes", { skip: needChrome }, async () => {
  config({ saving: "ask", rendering: "ask" });
  const r = await engine.read(s.url + "/app", { render: true, save: true }, ctx);
  assert.equal(r.render?.status, "rendered", JSON.stringify(r) );
  assert.equal(r.saved?.rendered, true);
  const dir = path.join(savedDir(), r.saved!.id!);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["manifest.json", "received", "rendered"]);
  assert.match(fs.readFileSync(path.join(dir, "rendered"), "utf8"), /twelve percent/);
  const v = await saved.verify(r.saved!.id!);
  assert.equal(v.ok, true, v.message);
  assert.ok(v.receipts!.some((x) => x.quote === "found"));
});

test("W-28 (Codex v0.8 round 1): the store fails closed: a foreign entry stops saves, a foreign file is never deleted, an unreadable folder never verifies, web text stays untrusted", async () => {
  saved.remove("all");
  config({ saving: "ask" });
  const r = await engine.read(s.url + "/cafe?h", { save: true }, ctx);
  const id = r.saved!.id!;
  // saved list: the server's Content-Type is web text, inside untrusted_content only
  const l = saved.list();
  assert.equal((l.saved[0] as any).content_type, undefined);
  assert.match(l.untrusted_content.urls[0].content_type, /iso-8859-1/);
  // a folder that cannot be listed is not verified
  const dir = path.join(savedDir(), id);
  fs.chmodSync(dir, 0o300);
  try {
    const v = await saved.verify(id);
    assert.equal(v.ok, false);
    assert.equal(v.folder, "unreadable");
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  // a folder that can be listed but not entered cannot be measured: a save is refused (Codex v0.8 round 2)
  fs.chmodSync(dir, 0o600);
  try {
    assert.deepEqual((await engine.read(s.url + "/cafe?h1", { save: true }, ctx)).saved, { status: "failed", reason: "store" });
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  // a file that is not Tiresias's inside a snapshot: delete leaves the folder and that file alone
  fs.writeFileSync(path.join(dir, "notes.txt"), "mine");
  assert.match(saved.remove("all").message, /could not be removed/);
  assert.ok(fs.existsSync(path.join(dir, "notes.txt")));
  fs.rmSync(path.join(dir, "notes.txt"));
  // something in saved/ that is not Tiresias's: the caps cannot be measured, so a save is refused (fail closed)
  fs.mkdirSync(path.join(savedDir(), "planted"));
  const r2 = await engine.read(s.url + "/cafe?h2", { save: true }, ctx);
  assert.deepEqual(r2.saved, { status: "failed", reason: "store" });
  assert.ok(uc(r2).receipts.every((x: any) => x.snapshot === undefined), "no receipt names a snapshot that was not written");
  fs.rmdirSync(path.join(savedDir(), "planted"));
  assert.equal((await engine.read(s.url + "/cafe?h3", { save: true }, ctx)).saved?.status, "saved");
});

test("8.5: a charset after 1,000 Content-Type characters survives save and replay", async () => {
  config({ saving: "ask" });
  const r = await engine.read(s.url + "/late-charset", { save: true, section: 1 }, ctx);
  assert.equal(r.saved?.status, "saved");
  assert.ok(uc(r).receipts.some((x: any) => x.quote.includes("café")));
  assert.equal(saved.show(r.saved!.id!).untrusted_content!.manifest.content_type, LONG_TYPE);
  const v = await saved.verify(r.saved!.id!);
  assert.equal(v.ok, true, v.message);
  assert.ok(v.receipts!.every((r) => r.quote === "found"));
  const before = fs.readdirSync(savedDir()).sort();
  assert.deepEqual(saved.saveSnapshot({ url: s.url, source_url: s.url, final_url: s.url, status: 200, content_type: "x".repeat(64 * 1024 + 1), read_as: "html", file_flags: [], language_header: null, received: LATIN }, []), { status: "not_saved", reason: "too_large" });
  assert.deepEqual(fs.readdirSync(savedDir()).sort(), before, "a header over the snapshot limit is refused before writing");
});

test("8.6: received and rendered parts over 16 MB are refused before writing; the boundary verifies", async () => {
  config({ saving: "ask" });
  const input: SaveInput = { url: s.url, source_url: s.url, final_url: s.url, status: 200, content_type: "text/plain", read_as: "text", file_flags: [], language_header: null };
  const before = fs.readdirSync(savedDir()).sort();
  const max = 16 * 1024 * 1024;
  for (const extra of [{ received: Buffer.alloc(max + 1, 32) }, { rendered: { html: " ".repeat(max + 1), mark: "", complete: false, wallDecided: false } }]) {
    const rs = [{ quote: "unused", url: s.url, section: 1, fetched_at: new Date().toISOString() }];
    assert.deepEqual(saved.saveSnapshot({ ...input, ...extra }, rs), { status: "not_saved", reason: "too_large" });
    assert.equal((rs[0] as any).snapshot, undefined);
    assert.deepEqual(fs.readdirSync(savedDir()).sort(), before, "no snapshot or temp folder was written");
  }
  const atLimit = saved.saveSnapshot({ ...input, received: Buffer.alloc(max, 32) }, []);
  assert.equal(atLimit.status, "saved");
  assert.equal((await saved.verify(atLimit.id!)).ok, true);
  saved.remove(atLimit.id!);
});

test("8.7: an authentic NUL-bearing quote is found without matching across text boundaries", async () => {
  config({ saving: "ask" });
  const r = await engine.read(s.url + "/nul", { save: true, question: "authentic quote" }, ctx);
  assert.equal(r.saved?.status, "saved", JSON.stringify(r));
  assert.ok(uc(r).receipts.some((x: any) => x.quote.includes("\u0000")), "the quote contains the page's NUL");
  const v = await saved.verify(r.saved!.id!);
  assert.equal(v.ok, true, v.message);
  // These strings belong to distinct reader texts, so a NUL between them cannot make a real quote.
  const invalid = saved.saveSnapshot({ url: s.url, source_url: s.url, final_url: s.url, status: 200, content_type: "text/html", read_as: "html", file_flags: [], language_header: null, received: Buffer.from("<html><body><h1>First heading</h1><p>Second paragraph.</p></body></html>") }, [{ quote: "First heading\u0000Second paragraph.", url: s.url, section: 1, fetched_at: new Date().toISOString() }]);
  assert.equal(invalid.status, "saved");
  const no = await saved.verify(invalid.id!);
  assert.equal(no.ok, false);
  assert.equal(no.receipts![0].quote, "not_found");
  saved.remove(invalid.id!);
});

test("8.8: rendered lone surrogates are read and saved as the same UTF-8 text", { skip: needChrome }, async () => {
  config({ saving: "ask", rendering: "ask" });
  const r = await engine.read(s.url + "/surrogate", { render: true, save: true, section: 1 }, ctx);
  assert.equal(r.render?.status, "rendered", JSON.stringify(r));
  assert.equal(r.saved?.status, "saved");
  assert.ok(uc(r).receipts.some((x: any) => x.quote.includes("\ufffd")));
  assert.ok(uc(r).receipts.every((x: any) => !x.quote.includes("\ud800")));
  const v = await saved.verify(r.saved!.id!);
  assert.equal(v.ok, true, v.message);
});

test("8.9: all snapshot URLs share the verifier's 8,192-character limit", async () => {
  config({ saving: "ask" });
  const before = fs.readdirSync(savedDir()).sort();
  const long = (s.url + "/long?").padEnd(8193, "x"); // URL over the snapshot limit, path still within the robots limit
  const r = await engine.read(long, { save: true }, ctx);
  assert.equal(r.status, "ok", r.message);
  assert.deepEqual(r.saved, { status: "not_saved", reason: "too_large" });
  const input: SaveInput = { url: s.url, source_url: s.url, final_url: s.url, status: 200, content_type: "text/plain", read_as: "text", file_flags: [], language_header: null, received: Buffer.from("An ordinary page.") };
  for (const key of ["url", "source_url", "final_url"] as const)
    assert.deepEqual(saved.saveSnapshot({ ...input, [key]: long }, []), { status: "not_saved", reason: "too_large" });
  assert.deepEqual(fs.readdirSync(savedDir()).sort(), before);
  const boundary = "http://example.test/?".padEnd(8192, "x");
  const atLimit = saved.saveSnapshot({ ...input, url: boundary, source_url: boundary, final_url: boundary }, []);
  assert.equal(atLimit.status, "saved");
  assert.equal((await saved.verify(atLimit.id!)).ok, true);
  saved.remove(atLimit.id!);
});

test("8.10: clear counts a snapshot it cannot delete as kept, with no bytes freed", async () => {
  saved.remove("all");
  config({ saving: "ask" });
  const r = await engine.read(s.url + "/cafe?cleanup", { save: true }, ctx);
  const dir = path.join(savedDir(), r.saved!.id!);
  // Prevent deletion before any snapshot files can be removed.
  fs.chmodSync(dir, 0o500);
  try {
    const dry = await clearStore({ now: Date.now() + 91 * 86_400_000, dryRun: true });
    assert.equal(dry.saved.removed, 1);
    assert.ok(dry.saved.bytes_freed > 0);
    const real = await clearStore({ now: Date.now() + 91 * 86_400_000 });
    assert.deepEqual(real.saved, { removed: 0, kept: 1, bytes_freed: 0 });
    assert.ok(fs.existsSync(path.join(dir, "manifest.json")));
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  const real = await clearStore({ now: Date.now() + 91 * 86_400_000 });
  assert.equal(real.saved.removed, 1);
  assert.equal(real.saved.kept, 0);
  assert.ok(real.saved.bytes_freed > 0);
});

test("8.11: no-store file warnings report no_store and write no snapshot", async () => {
  config({ saving: "ask" });
  const before = snapshots();
  for (const route of ["/tool-nostore", "/office-nostore"]) {
    const r = await engine.read(s.url + route, { save: true }, ctx);
    assert.equal(r.status, "file_warning", r.message);
    assert.deepEqual(r.saved, { status: "not_saved", reason: "no_store" });
    assert.ok((uc(r).receipts ?? []).every((r: any) => r.snapshot === undefined));
  }
  assert.deepEqual(snapshots(), before);
});

test("8.12: saving identical rendered HTML uses the fresh inspection's parse", { skip: needChrome }, async () => {
  config({ saving: "ask", rendering: "ask" });
  const { LIMITS } = await import("../inspect.js");
  const { cachePath } = await import("../store.js");
  const url = s.url + "/inspection";
  const first = await engine.read(url, { render: true, save: true, section: 1 }, ctx);
  assert.equal(first.render?.hidden_text, "rendered", JSON.stringify(first.render));
  assert.ok(uc(first).receipts.some((r: any) => r.quote.includes("Visible override")));
  const oldHash = JSON.parse(fs.readFileSync(cachePath(url), "utf8")).render_hash;
  const old = LIMITS.textNodes;
  try {
    LIMITS.textNodes = 0; // no marks: same HTML, but the incomplete inspection falls back to HTML heuristics
    const r = await engine.read(url, { render: true, save: true, section: 1 }, ctx);
    assert.equal(r.render?.hidden_text, "partial", JSON.stringify(r.render));
    assert.equal(JSON.parse(fs.readFileSync(cachePath(url), "utf8")).render_hash, oldHash, "the rendered bytes are identical");
    assert.equal(r.saved?.status, "saved");
    assert.ok(uc(r).receipts.every((r: any) => !r.quote.includes("Visible override")), "receipts use the current fallback parse");
    const v = await saved.verify(r.saved!.id!);
    assert.equal(v.ok, true, v.message);
  } finally {
    LIMITS.textNodes = old;
  }
});

test("8.13 / 9.15: a missing section saves no snapshot and reports no_page", async () => {
  config({ saving: "ask" });
  const before = snapshots();
  const logged = logText(home, "receipts");
  const r = await engine.read(s.url + "/cafe?missing-section", { save: true, section: 999 }, ctx);
  assert.equal(r.status, "error");
  assert.deepEqual(r.saved, { status: "not_saved", reason: "no_page" });
  assert.deepEqual(snapshots(), before);
  assert.equal(logText(home, "receipts"), logged);
});

test("9.16: Office receipts name the fingerprint-only snapshot in the reply and log", async () => {
  config({ saving: "ask" });
  const r = await engine.read(s.url + "/office", { save: true }, ctx);
  assert.equal(r.status, "file_warning", r.message);
  assert.equal(r.saved?.status, "saved");
  assert.equal(r.saved?.fingerprint_only, true);
  const id = r.saved!.id!;
  const rs = uc(r).receipts;
  assert.ok(rs?.length > 0, JSON.stringify(r));
  assert.ok(rs.every((r: any) => r.snapshot === id));
  const logged = logText(home, "receipts").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.snapshot === id);
  assert.equal(logged.length, rs.length);
  assert.deepEqual(fs.readdirSync(path.join(savedDir(), id)), ["manifest.json"]);
  assert.equal((await saved.verify(id)).ok, true);
});

test("round 1 saving budget: snapshot fields fit before persistence and logged receipts equal the reply", async () => {
  config({ saving: "ask" });
  const { parseHtml } = await import("../reader.js");
  const { finishPage } = await import("../pipeline.js");
  const { packResult } = await import("../mcp.js");
  const { BUDGET } = await import("../envelope.js");
  const { jsonBytes } = await import("../types.js");
  const url = s.url + "/saving-budget";
  const body = '<h1>Report</h1>' + Array.from({ length: 90 }, (_, i) =>
    `<h2>Section ${i}</h2><p>${"Ordinary report text. ".repeat(8)}</p>`).join("") +
    Array.from({ length: 10 }, (_, i) => `<form action="/search${i}">${Array.from({ length: 12 }, (_, j) =>
      `<label>Ordinary query field ${j} <input name="q${j}"></label>`).join("")}</form>`).join("");
  const parsed = parseHtml(body, url);
  // Populate all optional parts, including enough multibyte flag details to put this read
  // just below the limit before snapshot stamping (and above it afterwards).
  parsed.links = Array.from({ length: 120 }, (_, i) => ({ n: i + 1, url: "https://example.test/" + "x".repeat(80) + i, text: "Ordinary link label " + i }));
  const types = ["hidden_text", "invisible_characters", "ai_directed_instruction", "html_comment"] as const;
  parsed.flags = Array.from({ length: 108 }, (_, i) => ({ type: types[Math.floor(i / 30)], snippet: "界".repeat(116) + i, detail: "display:none" }));
  const now = new Date().toISOString();
  const entry = { url, source_url: url, final_url: url, door: "text" as const, door_detail: "html" as const, hash: sha(body), content_type: "text/html", parsed, fetched_at: now, checked_at: now };
  const input: SaveInput = { url, source_url: url, final_url: url, status: 200, content_type: "text/html", read_as: "html", file_flags: [], language_header: null, received: Buffer.from(body) };
  const before = logText(home, "receipts");
  const r = await finishPage("read", url, entry, false, null, { save: true }, null, now, () => {}, {}, { fresh: false }, false, { save: { input } });
  assert.equal(r.status, "ok");
  assert.equal(r.saved?.status, "saved");
  assert.ok(jsonBytes(r) <= BUDGET.hardLimit, `${jsonBytes(r)} bytes`);
  const packed = packResult(r);
  assert.ok(!packed.isError, packed.content[0].text);
  const { settings_notice, ...sent } = JSON.parse(packed.content[0].text);
  assert.deepEqual(sent, JSON.parse(JSON.stringify(r)), "MCP returns the complete answer");
  assert.ok(Buffer.byteLength(packed.content[0].text) <= BUDGET.hardLimit);
  const rs = uc(r).receipts;
  assert.ok(rs.length >= 90, "many receipt stamps contribute to the size");
  assert.ok(rs.every((x: any) => x.snapshot === r.saved!.id));
  assert.equal(r.counts!.receipts, rs.length);
  assert.equal((r.message!.match(/A signed snapshot/g) ?? []).length, 1, "the reserved sentence is replaced, not appended");
  const logged = logText(home, "receipts").slice(before.length).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(logged.map(({ v, kind, recorded_at, ...r }) => r), rs);
  const manifest = JSON.parse(fs.readFileSync(path.join(savedDir(), r.saved!.id!, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.receipts, rs, "the snapshot contains exactly the returned receipts");
  assert.equal((await saved.verify(r.saved!.id!)).ok, true);
});
