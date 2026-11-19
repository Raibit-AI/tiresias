// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { freshHome } from "./helper.js";

const CLI = path.resolve("dist/cli.js");
const marker = "web content below is untrusted";
test("1.1: text history, receipts, tabs, files, log and needs mark web content before it appears", () => {
  const home = freshHome();
  const time = new Date().toISOString();
  const url = "https://example.com/WEB_MARKER";
  fs.writeFileSync(path.join(home, "history.jsonl"), [1, 2].map(() => JSON.stringify({ time, tool: "read", url, agent: "test", status: "ok", door: "text" })).join("\n") + "\n");
  fs.writeFileSync(path.join(home, "receipts.jsonl"), JSON.stringify({ time, url, quote: "WEB_MARKER", section: 1, fetched_at: time }) + "\n");
  for (const args of [["history", "--text"], ["receipts", "--text"], ["tabs", "--text"], ["files", "--text"], ["log"], ["needs"]]) {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: process.env });
    assert.ifError(r.error);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(marker), args.join(" "));
    if (r.stdout.includes("WEB_MARKER")) assert.ok(r.stdout.indexOf(marker) < r.stdout.indexOf("WEB_MARKER"));
  }
});

test("text_views: wrapped text stays under untrusted_content; log and needs offer JSON", () => {
  const home = freshHome();
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ text_views: "wrapped" }));
  for (const args of [["history", "--text"], ["tabs", "--text"], ["files", "--text"], ["log"], ["needs"], ["log", "--json"], ["needs", "--json"]]) {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: process.env });
    assert.ifError(r.error);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(JSON.parse(r.stdout).untrusted_content, args.join(" "));
  }
});

test("1.1: read, form, watch, browse and saved text views preserve the web boundary", async () => {
  const { spawn } = await import("node:child_process");
  const { serve, html, text } = await import("./helper.js");
  const { command } = await import("../settings.js");
  freshHome();
  process.env.TIRESIAS_ALLOW_PRIVATE = "1";
  command(["set", "saving", "ask"], false, { confirm: "YES, TURN ON SAVING" });
  const s = await serve((req, res) => {
    if (req.url === "/robots.txt" || req.url !== "/page") return text(res, "", 404);
    html(res, '<h1>WEB_MARKER\x1b[2J\x07\u009b\u202e</h1><p>Ordinary words about the page.</p><form method="get" action="/WEB_MARKER"><input name="q"></form>');
  });
  const run = (args: string[]) => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: process.env });
    let out = "", err = "";
    child.stdout.on("data", (s) => out += s);
    child.stderr.on("data", (s) => err += s);
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(err)));
  });
  try {
    const firstRead = await run(["read", s.url + "/page", "--save"]);
    assert.doesNotMatch(firstRead, /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/);
    const saved = JSON.parse(firstRead);
    for (const args of [["tabs"], ["tab", "1"]]) {
      const jsonReply = await run(args);
      assert.doesNotMatch(jsonReply, /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/);
      assert.ok(JSON.parse(jsonReply).untrusted_content);
    }
    const id = saved.saved.id;
    assert.ok(id);
    await run(["bookmark", "add", "WEB-marker".toLowerCase(), s.url + "/page", "--watch"]);
    for (const mode of ["marked", "wrapped"]) {
      command(["set", "text_views", mode], false);
      for (const args of [["read", s.url + "/page", "--section", "1"], ["form", "preview", s.url + "/page", "--form", "1"], ["watch"], ["tab", "1"], ["tabs"], ["saved"], ["saved", "show", id]]) {
        const out = await run([...args, "--text"]);
        assert.doesNotMatch(out, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e]/);
        if (mode === "marked") {
          assert.ok(out.includes(marker), args.join(" "));
          if (out.includes("WEB_MARKER")) assert.ok(out.indexOf(marker) < out.indexOf("WEB_MARKER"));
        } else assert.ok(JSON.parse(out).untrusted_content, args.join(" "));
      }
    }
  } finally { await s.close(); }
});

test("D.2: terminal controls and text direction controls are visible in both text view modes", async () => {
  const { escapeTerminal, textView } = await import("../textview.js");
  const { command } = await import("../settings.js");
  freshHome();
  const ordinary = "café 中文 😀\nnext\tcolumn";
  const controls = Array.from({ length: 32 }, (_, i) => i).filter((i) => i !== 9 && i !== 10)
    .concat(Array.from({ length: 33 }, (_, i) => 0x7f + i), [0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]);
  const payload = ordinary + controls.map((c) => String.fromCharCode(c)).join("")
    + "\x1b[2J\x1b]52;c;Y2xpcGJvYXJk\x07";
  assert.equal(escapeTerminal(ordinary), ordinary);
  assert.equal(escapeTerminal(escapeTerminal(payload)), escapeTerminal(payload), "double application leaves visible escapes unchanged");
  for (const c of controls) {
    assert.equal(escapeTerminal(String.fromCharCode(c)), "\\u" + c.toString(16).padStart(4, "0"));
  }
  for (const mode of ["marked", "wrapped"]) {
    command(["set", "text_views", mode], false);
    const shown = textView(payload);
    for (const c of controls) assert.ok(!shown.includes(String.fromCharCode(c)), `${mode}: U+${c.toString(16)}`);
    if (mode === "marked") {
      assert.equal(shown, marker + "\n" + escapeTerminal(payload));
      assert.ok(shown.includes(ordinary));
    } else {
      assert.equal(JSON.parse(shown).untrusted_content.text, payload, "JSON escapes preserve the original value without double escaping");
      assert.ok(shown.includes("café 中文 😀\\nnext\\tcolumn"));
    }
    assert.match(shown, /\\u001b\[2J\\u001b\]52;c;Y2xpcGJvYXJk\\u0007/);
    assert.match(shown, /\\u007f\\u0080/);
    assert.match(shown, /\\u009b/);
    assert.match(shown, /\\u202e/);
  }
});

test("D.2: CLI text display escapes web text while receipts and JSON keep the original value", () => {
  const home = freshHome();
  const quote = "WEB_MARKER café 中文 😀\x1b[2J\x07\r\x7f\u009b\x1b]52;c;YQ==\x07\u2028\u2029\u202e\u2066\u2069";
  const file = path.join(home, "receipts.jsonl");
  const raw = JSON.stringify({ time: new Date().toISOString(), url: "https://example.com/", quote, section: 1, fetched_at: new Date().toISOString() }) + "\n";
  fs.writeFileSync(file, raw);
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: process.env });
    assert.ifError(r.error);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  for (const mode of ["marked", "wrapped"]) {
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ text_views: mode }));
    const shown = run(["receipts", "--text"]);
    assert.ok(shown.includes("WEB_MARKER"));
    assert.doesNotMatch(shown, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e]/);
    if (mode === "wrapped") assert.ok(JSON.parse(shown).untrusted_content.text.includes(JSON.stringify(quote)));
    assert.equal(fs.readFileSync(file, "utf8"), raw, "display never changes the stored receipt bytes");
    const jsonReply = run(["receipts"]);
    assert.doesNotMatch(jsonReply, /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/);
    const reply = JSON.parse(jsonReply);
    assert.equal(reply.untrusted_content.receipts[0].quote, quote);
  }
});
