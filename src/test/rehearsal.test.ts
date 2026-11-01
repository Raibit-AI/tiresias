// SPDX-License-Identifier: Apache-2.0
// v0.9 track 3: what the private launch rehearsal found a newcomer tripping over (docs/v0.9/rehearsal.md).
// Every site here is a LOCAL test server.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { freshHome, html, serve, text, type TestServer } from "./helper.js";

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-rehearsal-home-"));
process.env.HOME = FAKE_HOME;
freshHome();
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
delete process.env.TIRESIAS_PRIVATE;
delete process.env.TIRESIAS_PROFILE;

const engine = await import("../engine.js");
const { errorEnv, STORE_NOT_WRITABLE } = await import("../envelope.js");
const { oldNode } = await import("../nodecheck.js");
const { childPermissions } = await import("../pdfproc.js");

const servers: TestServer[] = [];
after(async () => {
  for (const s of servers) await s.close();
  (await import("../sandbox.js")).stopWorker();
});
const ctx = { agent: "rehearsal-tester" };
const CLI = new URL("../cli.js", import.meta.url).pathname;
const cli = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, encoding: "utf8" });

test("9.20: failed snapshot and receipt verification use the normal CLI error stream and status", () => {
  const home = freshHome();
  const id = "a".repeat(64);
  const dir = path.join(home, "saved", id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "manifest.json"), "damaged", { mode: 0o600 });
  const bundle = path.join(home, "bad-bundle.json");
  fs.writeFileSync(bundle, "{}", { mode: 0o600 });
  for (const args of [["saved", "verify", id], ["saved", "verify", "--all"], ["receipts", "verify", bundle]]) {
    for (const text of [false, true]) {
      const r = cli([...args, ...(text ? ["--text"] : [])]);
      assert.equal(r.status, 1, r.stderr);
      assert.equal(r.stdout, "", "verification failures never print success output");
      if (text) assert.match(r.stderr, /damaged|verified|proof bundle/);
      else {
        assert.equal(r.stderr.trim().split("\n").length, 1, "the normal error printer uses one JSON line");
        const e = JSON.parse(r.stderr);
        assert.equal(e.status, "error");
        assert.equal(e.reason, "verification_failed");
        assert.ok(e.message);
        if (args[0] === "saved") assert.equal(args.includes("--all") ? e.results[0].ok : e.ok, false);
        else assert.equal(e.offline_ok, false);
      }
    }
  }
});

test("9.28: history and receipts text listings start with counts and pagination", async () => {
  freshHome();
  const history = await import("../history.js");
  const receipts = await import("../receipts.js");
  for (const name of ["history", "receipts"]) {
    const empty = cli([name, "--text"]);
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(empty.stdout.split("\n")[0], `${name === "history" ? "History" : "Receipts"}: 0 records, page 1 of 1`);
    assert.doesNotMatch(empty.stdout, /door: none/);
  }
  for (let i = 0; i < 12; i++) {
    history.record({ time: new Date().toISOString(), tool: "read", url: `https://listing.example/${i}`, agent: "listing-test", purpose: "x".repeat(1000), status: "ok", door: "text" });
    receipts.record([{ url: `https://listing.example/${i}`, section: 1, quote: `quote ${i} ` + "x".repeat(7900), fetched_at: new Date().toISOString() }]);
  }
  for (const name of ["history", "receipts"]) {
    const json = cli([name]);
    assert.equal(json.status, 0, json.stderr);
    const e = JSON.parse(json.stdout);
    const page = name === "receipts" ? 2 : 1;
    const r = cli([name, "--text", "--page", String(page)]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.split("\n")[0], `${name === "history" ? "History" : "Receipts"}: 12 records, page ${page} of ${e.pages}`);
    assert.match(r.stdout, /listing\.example/);
    assert.doesNotMatch(r.stdout, /door: none/);
  }
});

test("rehearsal: a label Tiresias made ((top of page), (structured data)) is never quoted as if the page said it", async () => {
  const s = await serve((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    html(res, `<html><head><title>Plain</title><script type="application/ld+json">{"@type":"Thing","name":"Anvil"}</script></head><body><p>Text before any heading, long enough to be a block of its own.</p><h2>Later</h2><p>More.</p></body></html>`);
  });
  servers.push(s);
  const r = await engine.read(s.url + "/", {}, ctx);
  assert.equal(r.status, "ok");
  const uc = r.untrusted_content as any;
  assert.deepEqual(uc.outline.map((o: any) => o.heading), ["(top of page)", "Later", "(structured data)"]);
  const quotes = uc.receipts.map((x: any) => x.quote);
  assert.ok(!quotes.includes("(top of page)"), "no receipt quotes the (top of page) label");
  assert.ok(!quotes.includes("(structured data)"), "no receipt quotes the (structured data) label");
  assert.ok(quotes.includes("Later") && quotes.some((q: string) => q.startsWith("Text before any heading")), "real headings and text keep their receipts");
  const sec = await engine.read(s.url + "/", { section: 1 }, ctx);
  assert.ok(!(sec.untrusted_content as any).receipts.some((x: any) => x.quote === "(top of page)"));
  // A copy cached by the older reader (parser 12, labels not marked) is read again, not served with its label receipts.
  const dir = path.join(process.env.TIRESIAS_HOME!, "cache");
  let older = 0;
  for (const f of fs.readdirSync(dir)) {
    const e = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (!e.parsed?.sections) continue;
    e.parser = 12;
    for (const x of e.parsed.sections) delete x.generated;
    fs.writeFileSync(path.join(dir, f), JSON.stringify(e));
    older++;
  }
  assert.ok(older > 0, "a cached copy was made to look older");
  const again = await engine.read(s.url + "/", { page: 1 }, ctx);
  assert.ok(!(again.untrusted_content as any).receipts.some((x: any) => x.quote === "(top of page)"), "an older cached copy is parsed again");
  // The receipts log can be asked for with the address as typed: "http://host:port" was recorded as ".../".
  const listed = await engine.queryReceipts({ url: s.url });
  assert.ok(listed.items.length > 0, "receipts --url without the trailing slash finds the page's receipts");
});

test("rehearsal: an older Node gets a plain message; the PDF child can never load a native add-on", () => {
  assert.equal(oldNode("20.18.0"), true);
  assert.equal(oldNode("22.12.9"), true);
  assert.equal(oldNode("22.13.0"), false);
  assert.equal(oldNode("26.8.2"), false);
  // An npm install puts pdf.js's optional native canvas add-on on disk (npm does not honor the stub for a
  // dependency's optional dependency); the PDF child's permission model is what keeps it from ever loading.
  const r = spawnSync(process.execPath, [...childPermissions(), "-e", `try { process.dlopen({ exports: {} }, "/nonexistent.node"); console.log("allowed"); } catch (e) { console.log(e.code); }`], { encoding: "utf8" });
  assert.equal(r.stdout.trim(), "ERR_DLOPEN_DISABLED");
});

test("rehearsal: newcomer errors say what to do", () => {
  // A store folder that cannot be written is named as such, not "internal error".
  const e = Object.assign(new Error("EACCES: permission denied, mkdir '/x/.tiresias'"), { code: "EACCES", syscall: "mkdir", path: "/x/.tiresias" });
  assert.equal(errorEnv("https://example.com/", e).message, STORE_NOT_WRITABLE);
  const net = Object.assign(new Error("connect EACCES 1.2.3.4:443"), { code: "EACCES", syscall: "connect" });
  assert.equal(errorEnv("https://example.com/", net).message, "Tiresias hit an internal error.", "a network error is not called a store problem");
  // A mistyped option names the command's own help.
  const typo = cli(["read", "https://example.com", "--qestion", "x"]);
  assert.equal(typo.status, 1);
  assert.deepEqual(JSON.parse(typo.stderr), { status: "error", message: 'Unknown option "--qestion". Run tiresias read --help for the options it takes.' });
  // An address with no scheme says to start it with https://.
  const bare = cli(["read", "example.com", "--text"]);
  assert.equal(bare.status, 2);
  assert.match(bare.stdout, /starting with https:\/\//);
  // --text on an empty listing says so instead of printing nothing.
  const none = cli(["receipts", "--url", "https://nothing.example", "--text"]);
  assert.equal(none.status, 0);
  assert.match(none.stdout, /No receipts match\./);
  // The help starts with the first command to try and the MCP line.
  assert.match(cli(["--help"]).stdout, /First try:\s+tiresias read https:\/\/example\.com --text/);
});
