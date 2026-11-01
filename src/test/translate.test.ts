// SPDX-License-Identifier: Apache-2.0
// W-26 (v0.7): the owner's translation hook, built like the scanner hook (W-21).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { freshHome, neverAsk, html, logText, serve, text } from "./helper.js";

const home = freshHome();
// W-32 (v0.9): this file writes risky settings by hand; confirmations are tested in confirm.test.ts.
neverAsk(home);
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
const engine = await import("../engine.js");
const tr = await import("../translate.js");
const settings = await import("../settings.js");
const { createServer } = await import("../mcp.js");
const ctx = { agent: "translate-test" };

// A tiny local translator: writes what it was given (arguments and input) next to its output file, then acts
// by mode: "ok" upper-cases the text, "sleep" never answers, "huge" writes 200 KB, "exit2" fails, "empty" says nothing.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-v07-translator-"));
const HOOK = path.join(DIR, "translator.mjs");
fs.writeFileSync(
  HOOK,
  `import fs from "node:fs";
const [out, mode, from, to] = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  fs.writeFileSync(out, JSON.stringify({ args: process.argv.slice(4), input }));
  if (mode === "ok") process.stdout.write("[" + from + "->" + to + "] " + input.toUpperCase());
  else if (mode === "sleep") setInterval(() => {}, 1000);
  else if (mode === "huge") process.stdout.write("x".repeat(200 * 1024));
  else if (mode === "exit2") (process.stdout.write("partial"), process.exit(2));
  else if (mode === "empty") process.stdout.write("   ");
});
`,
);
const outFile = () => path.join(fs.mkdtempSync(path.join(DIR, "o-")), "seen.json");
const useHook = (mode: string, timeout?: string) => {
  const out = outFile();
  tr.setTranslator([process.execPath, HOOK, out, mode], { timeout });
  return out;
};

const PAGE = `<html lang="es"><head><title>Noticias</title></head><body><main><h1>El presupuesto</h1>
<p>El ayuntamiento aprobó el nuevo presupuesto el martes, y el alcalde dijo que ayudará a las escuelas de toda la región.</p>
</main></body></html>`;
const s = await serve((req, res) => {
  if (req.url === "/robots.txt") return text(res, "", 404);
  if (req.url === "/es") return html(res, PAGE);
  if (req.url === "/en") return html(res, "<html><body><main><h1>Budget</h1><p>The city council approved the new budget on Tuesday, and the mayor said that it would help schools.</p></main></body></html>");
  text(res, "", 404);
});
after(() => s.close());

test("W-26 hook: success; the translation is untrusted, labelled, and never a receipt; the tool gets source and target", async () => {
  const seen = useHook("ok");
  const r = await engine.read(s.url + "/es", { translate: "en" }, ctx);
  assert.equal(r.status, "ok");
  assert.deepEqual(r.translation, { status: "ok", by: "node", from: "es", to: "en" });
  const uc = r.untrusted_content as any;
  assert.match(uc.translation.text, /^\[es->en\] NOTICIAS/);
  assert.match(uc.translation.note, /not the page's own words/);
  const got = JSON.parse(fs.readFileSync(seen, "utf8"));
  assert.deepEqual(got.args, ["es", "en"], "source and target are the last two arguments");
  assert.match(got.input, /El ayuntamiento aprobó/, "the original text on standard input");
  // Receipts quote the original only, in the reply and in the receipts log.
  for (const rc of uc.receipts) assert.ok(!/NOTICIAS|EL AYUNTAMIENTO|->/.test(rc.quote), rc.quote);
  assert.ok(!/\[es->en\]/.test(logText(home, "receipts")));
  assert.ok(!/\[es->en\]/.test(logText(home, "history")));
  // Never cached.
  for (const f of fs.readdirSync(path.join(home, "cache"))) assert.ok(!fs.readFileSync(path.join(home, "cache", f), "utf8").includes("[es->en]"));
  // A section and a question are translated too; the repeat read still answers (translate asks for content).
  const sec = await engine.read(s.url + "/es", { section: 1, translate: "en" }, ctx);
  assert.equal(sec.translation?.status, "ok");
  assert.match((sec.untrusted_content as any).translation.text, /AYUNTAMIENTO/);
  // Same language: skipped without running the tool.
  const same = await engine.read(s.url + "/es", { translate: "es-MX" }, ctx);
  assert.equal(same.translation?.status, "skipped");
  assert.equal(same.translation?.reason, "same_language");
  // Not asked: no translation, no field.
  assert.equal((await engine.read(s.url + "/es", { section: 1 }, ctx)).translation, undefined);
  // A bad language tag never reaches the tool.
  const bad = await engine.read(s.url + "/es", { translate: "--help" }, ctx);
  assert.equal(bad.translation?.reason, "bad_language");
  assert.equal(tr.parseTarget("-x"), null);
  assert.equal(tr.parseTarget("pt_BR"), "pt-br");
});

test("W-26 hook: timeout, huge output, non-zero exit, empty output, missing command, not set, bad setting", async () => {
  useHook("sleep", "1");
  const t0 = Date.now();
  const slow = await engine.read(s.url + "/es", { translate: "en" }, ctx);
  assert.ok(["ok", "unchanged"].includes(slow.status), "the page is still returned");
  assert.equal(slow.translation?.status, "failed");
  assert.equal(slow.translation?.reason, "timeout");
  assert.ok(Date.now() - t0 < 5000, "the cap held");
  assert.equal((slow.untrusted_content as any).translation, undefined);

  useHook("huge");
  const huge = await engine.read(s.url + "/es", { translate: "en" }, ctx);
  assert.equal(huge.translation?.reason, "too_large");
  assert.equal((huge.untrusted_content as any).translation, undefined);

  useHook("exit2");
  assert.equal((await engine.read(s.url + "/es", { translate: "en" }, ctx)).translation?.reason, "exit_code");
  useHook("empty");
  assert.equal((await engine.read(s.url + "/es", { translate: "en" }, ctx)).translation?.reason, "empty");

  // The program removed after it was set.
  const gone = path.join(DIR, "gone.sh");
  fs.writeFileSync(gone, "#!/bin/sh\ncat\n", { mode: 0o755 });
  tr.setTranslator([gone], {});
  fs.rmSync(gone);
  const missing = await engine.read(s.url + "/es", { translate: "en" }, ctx);
  assert.equal(missing.translation?.status, "failed");
  assert.equal(missing.translation?.reason, "missing_command");
  // Setting a program that does not exist is refused.
  assert.throws(() => tr.setTranslator([path.join(DIR, "nope")], {}), /does not exist/);
  assert.throws(() => tr.setTranslator(["relative/prog"], {}), /translator/);

  assert.equal(tr.clearTranslator(), true);
  const unset = await engine.read(s.url + "/es", { translate: "en" }, ctx);
  assert.deepEqual(unset.translation, { status: "unavailable", reason: "not_set", from: "es", to: "en" });
  // A broken setting never stops the read.
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ translator: { command: ["/bin/sh", "-c"], shell: true } }));
  const broken = await engine.read(s.url + "/es", { translate: "en" }, ctx);
  assert.ok(["ok", "unchanged"].includes(broken.status));
  assert.equal(broken.translation?.reason, "bad_setting");
  fs.rmSync(path.join(home, "config.json"));
});

test("W-26 hook: listed in tiresias settings, CLI translator set/show/off, and private mode changes nothing", () => {
  const v = settings.view();
  const row = v.settings.find((r) => r.name === "translator");
  assert.ok(row, "listed");
  assert.equal(row!.value, null);
  assert.throws(() => settings.set("translator", ["/bin/cat"], false), /tiresias translator set/);
  assert.throws(() => tr.setTranslator(["/bin/cat"], {}, true), /Private mode/);
  const cli = (args: string[]) => spawnSync(process.execPath, [new URL("../cli.js", import.meta.url).pathname, ...args], { env: { ...process.env, TIRESIAS_HOME: home }, encoding: "utf8" });
  let r = cli(["translator", "set", "--timeout", "5", "--", "/bin/cat"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).translator, { command: ["/bin/cat"], timeout_seconds: 5 });
  r = cli(["translator", "show", "--text"]);
  assert.match(r.stdout, /\/bin\/cat/);
  assert.equal(settings.view().settings.find((x) => x.name === "translator")!.is_set, true);
  r = cli(["read", s.url + "/es", "--translate", "--x"]);
  assert.notEqual(r.status, 0, "a bad tag is refused by the CLI");
  r = cli(["translator", "off"]);
  assert.equal(r.status, 0);
  assert.equal("translator" in JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")), false);
});

test("W-26 MCP: no tool reads or sets the hook; read can only ask for a language, checked by its schema", async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  const client = new Client({ name: "mcp-agent", version: "1.0.0" });
  await client.connect(b);
  const tools = (await client.listTools()).tools;
  for (const t of tools) {
    assert.ok(!/translat/i.test(t.name), `no tool named for the translator: ${t.name}`);
    const props = Object.keys((t.inputSchema.properties ?? {}) as object);
    if (t.name === "read") assert.ok(props.includes("translate"));
    else assert.ok(!props.some((p) => /translat|command/i.test(p)), `${t.name} takes no translator parameter`);
  }
  // A command smuggled as the language is refused by the schema; nothing is written to config.json.
  const bad = await client.callTool({ name: "read", arguments: { url: s.url + "/es", translate: "en; /bin/sh" } });
  assert.equal(bad.isError, true);
  const extra = await client.callTool({ name: "read", arguments: { url: s.url + "/en", translate: "es", translator: { command: ["/bin/sh"] } } as any });
  const body = JSON.parse((extra.content as any)[0].text);
  assert.equal(body.translation?.reason, "not_set", "an extra argument does not set the hook");
  assert.equal(fs.existsSync(path.join(home, "config.json")) && "translator" in JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")), false);
  // With the owner's hook set, an MCP read can ask for a translation.
  useHook("ok");
  const ok = JSON.parse(((await client.callTool({ name: "read", arguments: { url: s.url + "/en", translate: "fr" } })).content as any)[0].text);
  assert.equal(ok.translation.status, "ok");
  assert.equal(ok.translation.from, "en");
  assert.match(ok.untrusted_content.translation.text, /^\[en->fr\]/);
  tr.clearTranslator();
  await client.close();
});

test("7.23: identical 200s and supplied 304 Content-Language refresh the cached declaration and translator source", async () => {
  const seen = useHook("ok");
  let language: string | undefined = "en";
  let conditional = false;
  const body = `<html><body><h1>Zorbax</h1><p>${"Zorbax flinter quolp drimble veskarn. ".repeat(300)}</p></body></html>`;
  const srv = await serve((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    const headers = { etag: '"same"', ...(language === undefined ? {} : { "content-language": language }) };
    if (conditional && req.headers["if-none-match"]) { res.writeHead(304, headers); return res.end(); }
    html(res, req.url === "/lang" ? body.replace("<html>", '<html lang="de">') : body, headers);
  });
  const { cachePath } = await import("../store.js");
  const url = srv.url + "/page";
  try {
    const first = await engine.read(url, { translate: "en" }, ctx);
    assert.equal(first.language?.code, "en");
    assert.equal(first.translation?.reason, "same_language");
    for (const [next, fresh, revalidate] of [["es", true, false], ["de", false, false], ["fr", true, true]] as const) {
      language = next;
      conditional = revalidate;
      const out = await engine.read(url, { translate: "en", fresh }, ctx);
      assert.equal(out.language?.code, next, JSON.stringify(out));
      assert.equal((out.untrusted_content as any).declared_language, next);
      assert.equal(out.translation?.from, next);
      assert.deepEqual(JSON.parse(fs.readFileSync(seen, "utf8")).args, [next, "en"]);
      assert.equal(JSON.parse(fs.readFileSync(cachePath(url), "utf8")).parsed.language.declared_text, next);
    }
    language = undefined; // omitted 304 headers preserve the representation's metadata
    const unchanged = await engine.read(url, { translate: "en" }, ctx);
    assert.equal(unchanged.language?.code, "fr");
    assert.equal((unchanged.untrusted_content as any).declared_language, "fr");
    conditional = false; // a full 200 without the header clears the old declaration
    const cleared = await engine.read(url, { page: 1, fresh: true }, ctx);
    assert.equal((cleared.untrusted_content as any).declared_language, undefined);
    language = "es";
    const ownLang = await engine.read(srv.url + "/lang", { translate: "en" }, ctx);
    assert.equal(ownLang.language?.code, "de", "the page's html lang still takes precedence over the header");
    assert.equal((ownLang.untrusted_content as any).declared_language, "de");
  } finally {
    await srv.close();
  }
});
