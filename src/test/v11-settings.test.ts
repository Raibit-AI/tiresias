// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { freshHome, logText } from "./helper.js";
import { command, view, viewText } from "../settings.js";
import { inForceConfig, notice } from "../confirm.js";

const choices = [
  ["get_form_actions", "read", "slip", undefined],
  ["private_spacing", "shared", "none", "YES, TURN OFF PRIVATE SPACING"],
  ["hook_secrets", "hidden", "inherit", "YES, SHARE TIRESIAS SECRETS WITH HOOKS"],
  ["text_views", "marked", "wrapped", undefined],
] as const;
test("v1.1 settings: all four choices are listed, validated and set through the CLI", () => {
  freshHome();
  for (const [name, dflt, alternative, phrase] of choices) {
    const row = view().settings.find((r) => r.name === name);
    assert.equal(row?.value, dflt, name);
    assert.equal(row?.default, dflt);
    assert.ok(viewText(view()).includes(`${name} = ${dflt}`));
    assert.throws(() => command(["set", name, "bad"], false));
    if (phrase) assert.throws(() => command(["set", name, alternative], false), /exact confirmation/);
    const r = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "settings", "set", name, alternative, ...(phrase ? ["--confirm", phrase] : [])], { encoding: "utf8", env: process.env });
    assert.ifError(r.error);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(inForceConfig()?.[name], alternative);
    if (phrase) {
      assert.ok(notice()?.some((s) => s.includes(name === "hook_secrets" ? "secrets" : "spacing")));
      assert.ok(logText(process.env.TIRESIAS_HOME!, "history").includes(`"setting":"${name}"`));
    }
    command(["reset", name], false);
    assert.equal(view().settings.find((r) => r.name === name)?.value, dflt);
  }
});
test("v1.1 settings: unconfirmed hand edits are held back and tightening applies at once", () => {
  const home = freshHome();
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ private_spacing: "none", hook_secrets: "inherit", get_form_actions: "slip", text_views: "wrapped" }));
  const force = inForceConfig();
  assert.notEqual(force?.private_spacing, "none");
  assert.notEqual(force?.hook_secrets, "inherit");
  assert.equal(force?.get_form_actions, "slip");
  assert.equal(force?.text_views, "wrapped");
  for (const [name, , alt, phrase] of choices) if (phrase) {
    assert.equal(view().settings.find((r) => r.name === name)?.confirmed, false);
    command(["confirm", name], false, { confirm: phrase });
    assert.equal(inForceConfig()?.[name], alt);
  }
});

test("get_form_actions: slip gates reads, previews and redirects to an observed GET action", async () => {
  const { read, formPreview } = await import("../engine.js");
  const { grant, list } = await import("../slips.js");
  const { serve, html, text } = await import("./helper.js");
  process.env.TIRESIAS_ALLOW_PRIVATE = "1";
  freshHome();
  command(["set", "get_form_actions", "slip"], false);
  const s = await serve((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    if (req.url === "/jump") return text(res, "", 302, { location: "/vote?choice=yes" });
    if (req.url?.startsWith("/vote")) return html(res, '<p>Vote recorded.</p>');
    html(res, '<h1>Vote</h1><form method="get" action="/vote"><input name="choice"></form>');
  });
  try {
    assert.equal((await read(s.url + "/page")).status, "ok");
    for (const call of [() => read(s.url + "/vote?choice=yes"), () => formPreview(s.url + "/vote?choice=yes", 1), () => read(s.url + "/jump")]) {
      assert.equal((await call()).status, "refused");
      assert.equal(s.count("/vote?choice=yes"), 0);
    }
    const { spawn } = await import("node:child_process");
    const exit = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve("dist/cli.js"), "check", s.url + "/vote?choice=yes"], { env: process.env, stdio: "ignore" });
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(exit, 2, "another process also knows the observed action");
    assert.equal(s.count("/vote?choice=yes"), 0);
    grant({ action: "submit_form", site: s.url, path: "/vote", uses: "1" });
    assert.equal((await read(s.url + "/vote?choice=yes")).status, "ok");
    assert.equal(s.count("/vote?choice=yes"), 1);
    assert.equal(list().counts.used_up, 1);
    command(["set", "get_form_actions", "read"], false);
    assert.ok(["ok", "unchanged"].includes((await read(s.url + "/vote?choice=yes", { fresh: true })).status));
    assert.equal(s.count("/vote?choice=yes"), 2);
  } finally { await s.close(); }
});

test("private_spacing none writes no spacing state for private calls or previews", async () => {
  const { callContext } = await import("../context.js");
  const { reserve, acquireActive } = await import("../hosts.js");
  for (const context of [{ private: true }, { readOnly: true }]) {
    const home = freshHome();
    command(["set", "private_spacing", "none"], false, { confirm: choices[1][3] });
    await callContext.run(context, async () => {
      const release = await acquireActive("https://spacing.example", new AbortController().signal);
      const first = reserve("https://spacing.example", 30000, 0);
      assert.ok(reserve("https://spacing.example", 30000, 0) < first + 30000);
      release();
    });
    assert.ok(!fs.existsSync(path.join(home, "hosts")));
  }
});
test("hook_secrets inherit gives hooks the full environment after confirmation", async () => {
  freshHome();
  command(["set", "hook_secrets", "inherit"], false, { confirm: choices[2][3] });
  const { runHook } = await import("../hook.js");
  process.env.TIRESIAS_WEB_RISK_KEY = "SYNTHETIC_INHERITED_KEY";
  try {
    const r = await runHook([process.execPath, "-e", 'process.stdout.write(process.env.TIRESIAS_WEB_RISK_KEY ?? "missing")'], [], 5000, 4096, "");
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.out.toString(), "SYNTHETIC_INHERITED_KEY");
  } finally { delete process.env.TIRESIAS_WEB_RISK_KEY; }
});

test("get_form_actions: policy requests cannot reach a known GET action before the slip gate", async () => {
  freshHome();
  const { read, check } = await import("../engine.js");
  const { resetRulesCache } = await import("../rules.js");
  const { serve, html, text } = await import("./helper.js");
  process.env.TIRESIAS_ALLOW_PRIVATE = "1";
  const s = await serve((req, res) => req.url === "/robots.txt" ? text(res, "", 404) : html(res, '<form action="/robots.txt" method="get"><input name="q"></form>'));
  try {
    await read(s.url + "/page");
    command(["set", "get_form_actions", "slip"], false);
    resetRulesCache();
    const before = s.count("/robots.txt");
    assert.equal((await check(s.url + "/robots.txt")).status, "refused");
    assert.equal(s.count("/robots.txt"), before, "even the policy fetch is gated");
  } finally { await s.close(); }
});
