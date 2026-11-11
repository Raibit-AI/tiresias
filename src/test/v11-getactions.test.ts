// SPDX-License-Identifier: Apache-2.0
import { actionPairs, cappedTarget, differentActionPairs } from "./getaction-cases.js";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { test } from "node:test";
import { callContext } from "../context.js";
import { getActionTarget, getActionTargetsMatch, guardGetAction, noteGetActions } from "../getactions.js";
import { read } from "../engine.js";
import { rulesCache } from "../rules.js";
import { freshHome, neverAsk, serve, html, text } from "./helper.js";

function setup() {
  const home = freshHome();
  neverAsk(home);
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ get_form_actions: "slip" }));
  return home;
}
const form = (action: string) => [{ method: "GET", action }];
const variants = [
  "https://vote.example/%76ote?choice=yes",
  "https://VOTE.example./vote?choice=yes",
  "https://vote.example:443/%76%6F%74%65?choice=yes",
  "https://vote.example/%76%6f%74%65?choice=yes",
  "https://vote.example/a/../vote?choice=yes",
  "https://vote.example/a/%2e%2E/%76ote?choice=yes",
  "https://vote.example//vote/",
  "https://vote.example/VOTE",
  "https://vote.example/a%2f..%2Fvote",
  "https://vote.example/%2576ote",
  "https://vote.example/vote;session=123",
];

test("GET-action denial uses the same target for encoded paths and host aliases in reads", async (t) => {
  setup();
  const sent: string[] = [];
  t.mock.method(dns, "lookup", async () => [{ address: "8.8.8.8", family: 4 }]);
  t.mock.method(https, "request", (opts: https.RequestOptions) => { sent.push(opts.path ?? ""); throw new Error("mocked outbound request"); });
  noteGetActions(form("https://vote.example/vote"), true);
  for (const target of variants) {
    // Permit policy locally so the assertion concerns the target request, never a failed robots read.
    rulesCache.set(new URL(target).origin, { mode: "missing", rules: [], crawlDelay: 0, sitemaps: [], expires: Date.now() + 60_000 });
    const r = await read(target);
    assert.equal(r.status, "refused", `${target}: ${r.message}`);
    assert.match(r.message ?? "", /needs a current submit_form permission slip/, target);
    assert.ok(!sent.includes(new URL(target).pathname + new URL(target).search), target);
  }
});

test("GET-action observations compare canonical spellings in either direction", () => {
  for (const action of variants) {
    setup();
    noteGetActions(form(action));
    assert.throws(() => guardGetAction(new URL("https://vote.example/vote")), /permission slip/, action);
  }
});

test("private GET-action observations are local to one call", () => {
  const home = setup();
  const target = new URL("https://private.example/vote");
  callContext.run({ private: true }, () => {
    noteGetActions(form(target.href), true);
    assert.throws(() => guardGetAction(target), /permission slip/);
  });
  assert.doesNotThrow(() => guardGetAction(target), "a later ordinary call learns nothing");
  callContext.run({ private: true }, () => assert.doesNotThrow(() => guardGetAction(target), "a later private call learns nothing"));
  assert.ok(!fs.existsSync(path.join(home, "cache")) || fs.readdirSync(path.join(home, "cache")).length === 0, "no private observation on disk");
});

test("the private GET-action full latch is local to one call", () => {
  const home = setup();
  callContext.run({ private: true }, () => {
    noteGetActions(Array.from({ length: 4097 }, (_, i) => ({ method: "GET", action: `https://private.example/${i}` })), true);
    assert.throws(() => guardGetAction(new URL("https://unseen.example/path")), /permission slip/, "this call fails closed at capacity");
  });
  assert.doesNotThrow(() => guardGetAction(new URL("https://unseen.example/path")), "private capacity did not fill shared memory");
  callContext.run({ private: true }, () => assert.doesNotThrow(() => guardGetAction(new URL("https://unseen.example/path"))));
  assert.ok(!fs.existsSync(path.join(home, "cache")) || fs.readdirSync(path.join(home, "cache")).length === 0, "no private observation on disk");
});

test("pipeline private observations do not gate a later read", async () => {
  setup();
  process.env.TIRESIAS_ALLOW_PRIVATE = "1";
  const s = await serve((req, res) => req.url === "/robots.txt" ? text(res, "", 404) : html(res,
    req.url === "/page" ? '<form method=get action=/vote><input name=choice></form>' : '<p>A plain result.</p>'));
  try {
    assert.equal((await read(s.url + "/page", {}, { agent: "private-test", private: true })).status, "ok");
    assert.equal((await read(s.url + "/vote?choice=yes")).status, "ok");
    assert.equal(s.count("/vote?choice=yes"), 1);
    assert.equal((await read(s.url + "/vote?choice=yes", {}, { agent: "private-test", private: true })).status, "ok");
    assert.equal(s.count("/vote?choice=yes"), 2);
  } finally { await s.close(); }
});

test("r2: ordinary memory-only observations gate both ordinary and private reads", async () => {
  setup();
  process.env.TIRESIAS_ALLOW_PRIVATE = "1";
  const { cachePath } = await import("../store.js");
  const s = await serve((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    res.setHeader("Cache-Control", "no-store");
    html(res, req.url === "/page" ? '<form method=get action=/vote><input name=choice></form>' : '<p>vote recorded</p>');
  });
  try {
    assert.equal((await read(s.url + "/page")).status, "ok");
    assert.ok(!fs.existsSync(cachePath(`get-form:${getActionTarget(new URL(s.url + "/vote"))}`)), "observation was not persisted");
    for (const privateCall of [false, true]) {
      const result = await read(s.url + "/vote", {}, { agent: "r2", private: privateCall });
      assert.equal(result.status, "refused");
      assert.match(result.message ?? "", /permission slip/);
    }
    assert.equal(s.count("/vote"), 0);
  } finally { await s.close(); }
});

test("all routing variant pairs gate real reads in both directions", async (t) => {
  const sent: string[] = [];
  t.mock.method(dns, "lookup", async () => [{ address: "8.8.8.8", family: 4 }]);
  t.mock.method(https, "request", (opts: https.RequestOptions) => { sent.push(opts.path ?? ""); throw new Error("mocked outbound request"); });
  const http = (await import("node:http")).default;
  t.mock.method(http, "request", (opts: https.RequestOptions) => { sent.push(opts.path ?? ""); throw new Error("mocked outbound request"); });
  for (const [action, target] of [...actionPairs, ["https://vote.example/other", cappedTarget]].flatMap(([a, b]) => [[a, b], [b, a]])) {
    setup();
    noteGetActions(form(action), true);
    rulesCache.set(new URL(target).origin, { mode: "missing", rules: [], crawlDelay: 0, sitemaps: [], expires: Date.now() + 60_000 });
    sent.length = 0;
    const result = await read(target);
    assert.equal(result.status, "refused", `${action} -> ${target}: ${result.message}`);
    assert.match(result.message ?? "", /permission slip/);
    assert.ok(!sent.includes(new URL(target).pathname + new URL(target).search), target);
  }
  setup();
  noteGetActions(form("https://vote.example:8443/vote"));
  assert.doesNotThrow(() => guardGetAction(new URL("https://vote.example:9443/vote")), "distinct nondefault ports stay distinct");
});

test("R.12: denial keys keep only letters and digits per segment and stay idempotent", () => {
  for (const [action, target] of actionPairs) {
    const a = getActionTarget(new URL(action));
    const b = getActionTarget(new URL(target));
    assert.equal(a, b, `${action} -> ${target}`);
    assert.ok(getActionTargetsMatch(a, b));
    assert.ok(getActionTargetsMatch(b, a));
    assert.equal(getActionTarget(new URL(a)), a, action);
    assert.equal(getActionTarget(new URL(b)), b, target);
    assert.match(a.slice(new URL(a).origin.length), /^\/(?:[\p{L}\p{N}]+(?:\/[\p{L}\p{N}]+)*)?$/u);
  }
  assert.equal(getActionTarget(new URL("https://vote.example/---/!")), "https://vote.example/");
  assert.equal(getActionTarget(new URL("https://vote.example/vo-te")), "https://vote.example/vote");
  assert.equal(getActionTarget(new URL("https://vote.example/ᄀ-ᅡ")), "https://vote.example/가");
});

test("R.12: different letters, digits and segment boundaries remain distinct in both directions", () => {
  for (const [a, b] of differentActionPairs.flatMap(([a, b]) => [[a, b], [b, a]])) {
    setup();
    const action = getActionTarget(new URL(a));
    const target = getActionTarget(new URL(b));
    assert.equal(getActionTarget(new URL(action)), action, a);
    assert.equal(getActionTarget(new URL(target)), target, b);
    assert.notEqual(action, target, `${a} -> ${b}`);
    assert.ok(!getActionTargetsMatch(action, target), `${a} -> ${b}`);
    noteGetActions(form(a));
    assert.doesNotThrow(() => guardGetAction(new URL(b)), `${a} -> ${b}`);
  }
});

test("r2: target folding is idempotent for 6000 generated spellings", () => {
  const pieces = ["vote", "%76ote", "%2576ote", "%EF%BC%8576ote", "ｖｏｔｅ", "a%2f..%2fvote", "a%5c..%5cvote", "cafe%CC%81", "vote;sid=1", "%3b", "%3f", "%23", "%00", "%ff%76", "%2525252e", ".. ", "a%2F..;x%2Fvote"];
  for (let i = 0; i < 6000; i++) {
    const source = `https://VOTE.example.:443/${pieces[i % pieces.length]}/${pieces[Math.floor(i / pieces.length) % pieces.length]}${["", "/", "/..", "%252f"][i % 4]}`;
    const folded = getActionTarget(new URL(source));
    assert.equal(getActionTarget(new URL(folded)), folded, source);
  }
  const capped = getActionTarget(new URL(cappedTarget));
  assert.equal(capped, "https://vote.example/*");
  assert.equal(getActionTarget(new URL(capped)), capped);
  assert.ok(getActionTargetsMatch(capped, "https://vote.example/other"));
  assert.ok(getActionTargetsMatch("https://vote.example/other", capped));
  assert.ok(!getActionTargetsMatch(capped, "https://other.example/other"));
  assert.ok(!getActionTargetsMatch(capped, "https://vote.example:8443/other"));
});

test("r2: disk observations also gate private calls without shared-memory help", async () => {
  setup();
  const { cachePath, writeJson } = await import("../store.js");
  const url = new URL("https://disk-only.example/vote");
  writeJson(cachePath(`get-form:${getActionTarget(url)}`), { get_form_action: true });
  callContext.run({ private: true }, () => assert.throws(() => guardGetAction(url), /permission slip/));
  writeJson(cachePath("get-form:https://disk-capped.example/*"), { get_form_action: true });
  callContext.run({ private: true }, () => assert.throws(() => guardGetAction(new URL("https://disk-capped.example/other")), /permission slip/));
});

test("R.12: disk observations gate routing variants in both directions without memory observations", async () => {
  const { cachePath, writeJson } = await import("../store.js");
  for (const [action, target] of actionPairs.flatMap(([a, b]) => [[a, b], [b, a]])) {
    setup();
    writeJson(cachePath(`get-form:${getActionTarget(new URL(action))}`), { get_form_action: true });
    callContext.run({ private: true }, () => assert.throws(() => guardGetAction(new URL(target)), /permission slip/, `${action} -> ${target}`));
  }
});

// Fresh module instances isolate capacity tests without adding a production reset hook.
let capacityCase = 0;
async function capacityActions() {
  setup();
  return import(new URL(`../getactions.js?capacity=${capacityCase++}`, import.meta.url).href) as Promise<typeof import("../getactions.js")>;
}
const atCapacity = Array.from({ length: 4096 }, (_, i) => ({ method: "GET", action: `https://capacity.example/${i}` }));
const unrelated = new URL("https://unseen-capacity.example/plain");

test("T.1: repeating a key at capacity does not latch", async () => {
  const a = await capacityActions();
  a.noteGetActions(atCapacity);
  a.noteGetActions(form(atCapacity[0].action));
  assert.doesNotThrow(() => a.guardGetAction(unrelated));
  assert.throws(() => a.guardGetAction(new URL(atCapacity[0].action)), /permission slip/);
  callContext.run({ private: true }, () => {
    a.noteGetActions(atCapacity, true);
    a.noteGetActions(form(atCapacity[0].action), true);
    assert.doesNotThrow(() => a.guardGetAction(unrelated));
  });
});

test("T.1: saved overflow does not latch and stays gated after cache eviction", async () => {
  const a = await capacityActions();
  const { cachePath, readJson } = await import("../store.js");
  const { clearStore } = await import("../cleanup.js");
  a.noteGetActions(atCapacity);
  const target = new URL("https://saved-capacity.example/vote");
  a.noteGetActions(form(target.href), true);
  assert.doesNotThrow(() => a.guardGetAction(unrelated));
  assert.equal(readJson<{ get_form_action: boolean }>(cachePath(`get-form:${getActionTarget(target)}`))?.get_form_action, true);
  assert.throws(() => a.guardGetAction(target), /permission slip/);
  await clearStore({ all: true });
  assert.equal(readJson(cachePath(`get-form:${getActionTarget(target)}`)), null);
  assert.throws(() => a.guardGetAction(target), /permission slip/, "eviction cannot forget a saved overflow target");
  callContext.run({ private: true }, () => assert.throws(() => a.guardGetAction(target), /permission slip/));
  assert.doesNotThrow(() => a.guardGetAction(unrelated));
});

for (const readOnly of [false, true]) test(`T.1: ${readOnly ? "read-only" : "unkept"} overflow stays gated without a shared latch`, async () => {
  const a = await capacityActions();
  a.noteGetActions(atCapacity);
  callContext.run({ readOnly }, () => a.noteGetActions(form("https://unkept-capacity.example/vote"), readOnly));
  const target = new URL("https://unkept-capacity.example/vote");
  for (const privateCall of [false, true]) callContext.run({ private: privateCall }, () => {
    assert.throws(() => a.guardGetAction(target), /permission slip/);
    assert.doesNotThrow(() => a.guardGetAction(unrelated));
  });
});

test("r2: shared overflow gates its target in private and ordinary calls, not unrelated addresses", () => {
  setup();
  noteGetActions(Array.from({ length: 4097 }, (_, i) => ({ method: "GET", action: `https://public-full.example/${i}` })));
  const target = new URL("https://public-full.example/4096");
  for (const privateCall of [false, true]) callContext.run({ private: privateCall }, () => {
    assert.throws(() => guardGetAction(target), /permission slip/);
    assert.doesNotThrow(() => guardGetAction(unrelated));
  });
});
