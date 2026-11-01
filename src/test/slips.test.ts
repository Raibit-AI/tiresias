// SPDX-License-Identifier: Apache-2.0
// v0.4 phase B: W-05 permission slips. Scoped, signed, expiring permissions the owner grants from the
// command line; agents can only list them. claimSlip and checkSlip are the API for phase C (forms).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { freshHome, runAsPerson } from "./helper.js";
import type * as Slips from "../slips.js";

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-slips-home-"));
process.env.HOME = FAKE_HOME;
freshHome();
delete process.env.TIRESIAS_PRIVATE;
delete process.env.TIRESIAS_PROFILE;
const slips = await import("../slips.js");
const store = await import("../store.js");
const keys = await import("../keys.js");
const profiles = await import("../profiles.js");
const engine = await import("../engine.js");
const { clearStore } = await import("../cleanup.js");
const { createServer } = await import("../mcp.js");

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(DIST, "cli.js");
after(async () => (await import("../sandbox.js")).stopWorker());

const SITE = "https://shop.example";
const FORM = SITE + "/contact";
const H = 3_600_000;
const D = 24 * H;

function newHome(): string {
  const d = path.join(freshHome(), "store");
  process.env.TIRESIAS_HOME = d;
  return d;
}
const slipDir = () => path.join(store.homeDir(), "slips");
const slipFile = (id: string) => path.join(slipDir(), id + ".json");
function tree(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      out.push(path.relative(dir, f));
      if (e.isDirectory()) walk(f);
    }
  };
  walk(dir);
  return out.sort();
}
function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}
async function as<T>(name: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const old = process.env.TIRESIAS_PROFILE;
  if (name === undefined) delete process.env.TIRESIAS_PROFILE;
  else process.env.TIRESIAS_PROFILE = name;
  try {
    return await fn();
  } finally {
    if (old === undefined) delete process.env.TIRESIAS_PROFILE;
    else process.env.TIRESIAS_PROFILE = old;
  }
}
const grant = (o: Partial<Slips.GrantInput> = {}, now?: number) => slips.grant({ action: "submit_form", site: SITE, ...o }, false, now);
const ok = (r: unknown) => {
  assert.ok(r && typeof r === "object" && "slip_id" in r, JSON.stringify(r));
  return r as { slip_id: string; use: number };
};

test("W-05: grant checks the scope: one action, pay refused with fixed text, exact origin, whole-segment path, expiry and uses bounded", () => {
  newHome();
  assert.throws(() => grant({ action: "pay" }), (e: Error) => e.message === slips.PAY_REFUSED);
  assert.throws(() => grant({ action: "delete_account" }), /must be one of: submit_form/);
  for (const site of ["https://shop.example/contact", "https://shop.example/?q=1", "https://shop.example/#x", "https://u:p@shop.example", "http://shop.example", "ftp://shop.example", "shop.example", "https://shop.example?", "https://shop.example\\x"])
    assert.throws(() => grant({ site }), /exact origin/, site);
  for (const p of ["contact", "/a?b", "/a#b", "/a/../b", "/a/./b", "/a b", "//evil.example/x", "/a\\b", "/" + "x".repeat(600)]) assert.throws(() => grant({ path: p }), /--path/, p);
  assert.throws(() => grant({ uses: "0" }), /--uses/);
  assert.throws(() => grant({ uses: "101" }), /--uses/);
  assert.throws(() => grant({ note: "x".repeat(201) }), /--note/);
  assert.throws(() => grant({ note: "two\nlines" }), /--note/);
  assert.throws(() => grant({ for: "31d" }), /at most 30 days/);
  assert.throws(() => grant({ for: "0h" }), /--for/);
  assert.throws(() => grant({ until: "2001-01-01" }), /already passed/);
  assert.throws(() => grant({ until: "2026-02-30" }), /not a real date/);
  assert.throws(() => grant({ until: "2026-10-24", for: "1d" }), /not both/);
  assert.equal(fs.existsSync(store.homeDir()), false, "a refused grant creates nothing");
  const now = Date.now();
  const v = grant({ site: "https://SHOP.example:443/", path: "/contact/" }, now);
  assert.equal(v.site, SITE);
  assert.equal(v.path, "/contact");
  assert.equal(v.uses, 1);
  assert.equal(Date.parse(v.expires_at) - Date.parse(v.created_at), D, "default 24 hours");
  assert.match(v.id, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(grant({ path: "/" }).path, null, '"/" is the whole site');
  assert.equal(grant({ for: "30d", uses: "100" }).uses, 100);
  assert.equal(grant({ site: "http://127.0.0.1:8080" }).site, "http://127.0.0.1:8080", "http only on this machine");
  // --until a date means through the end of that local day.
  const day = new Date(now + 3 * D);
  const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  assert.equal(Date.parse(grant({ until: iso }, now).expires_at), new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime());
});

test("W-05: the slip key is separate from the signing key, made on the first grant, 0600 in 0700, and never printed", async () => {
  const home = newHome();
  const r = await runAsPerson(CLI, ["slip", "grant", "--action", "submit_form", "--site", SITE, "--note", "contact form"], SITE);
  assert.equal(r.code, 0, r.out);
  const kf = path.join(home, "keys", keys.SLIP_KEY_FILE);
  assert.equal(fs.statSync(kf).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(kf)).mode & 0o777, 0o700);
  const jwk = JSON.parse(fs.readFileSync(kf, "utf8"));
  assert.doesNotMatch(r.out, new RegExp(jwk.d));
  // It is not a Web Bot Auth key: no signing key exists, and signing stays off.
  assert.equal(keys.readPrivateJwk(), null);
  assert.equal(fs.existsSync(path.join(home, "keys", keys.KEY_FILE)), false);
  // A second grant uses the same key; a key readable by others is refused loudly.
  const before = fs.readFileSync(kf, "utf8");
  grant();
  assert.equal(fs.readFileSync(kf, "utf8"), before);
  fs.chmodSync(kf, 0o644);
  assert.throws(() => grant(), /slip key file .* can be read by other users/);
  assert.throws(() => slips.list(), /can be read by other users/);
  fs.chmodSync(kf, 0o600);
  const l = await run(["slip", "list"]);
  assert.equal(JSON.parse(l.stdout).counts.active, 2);
  assert.doesNotMatch(l.stdout, new RegExp(jwk.d));
});

test("W-05: matching: exact origin, path on whole segments, the URL the request goes to", () => {
  newHome();
  grant({ path: "/contact", uses: "50" });
  for (const url of [FORM, FORM + "/", FORM + "/send?x=1", FORM + "/a/b", "https://SHOP.example:443/contact"])
    assert.ok("slip_id" in slips.checkSlip("submit_form", url), url);
  // Codex round 53: a dot segment, even one the parser would resolve to a covered path, is never matched.
  assert.equal((slips.checkSlip("submit_form", SITE + "/x/../contact") as Slips.Refused).refused, "unusual_path");
  for (const url of [SITE + "/contactus", SITE + "/", SITE + "/Contact", SITE + "/contact%2Fx", "http://shop.example/contact", "https://shop.example:8443/contact", "https://www.shop.example/contact", "https://shop.example.evil/contact", "https://u:p@shop.example/contact"])
    assert.equal((slips.checkSlip("submit_form", url) as Slips.Refused).refused, url.includes("u:p@") || url.startsWith("http:") ? "bad_url" : url.includes("%2F") ? "unusual_path" : "no_slip", url); // %2F: Codex round 51
  assert.equal((slips.checkSlip("pay", FORM) as Slips.Refused).refused, "pay_never");
  assert.equal((slips.checkSlip("other", FORM) as Slips.Refused).refused, "unknown_action");
  assert.equal((slips.checkSlip("submit_form", "not a url") as Slips.Refused).refused, "bad_url");
});

test("W-05: claims take the lowest free use, a used-up slip is never used, the soonest to expire goes first, and each claim is in history", async () => {
  const home = newHome();
  const now = Date.now();
  const later = grant({ for: "5d", uses: "1" }, now);
  const sooner = grant({ for: "2d", uses: "2" }, now);
  assert.equal((slips.checkSlip("submit_form", FORM) as { slip_id: string }).slip_id, sooner.id, "check picks the soonest too");
  assert.deepEqual(ok(slips.claimSlip("submit_form", FORM, "form:contact", { agent: "codex" })), { slip_id: sooner.id, use: 1 });
  assert.deepEqual(ok(slips.claimSlip("submit_form", FORM, "form:contact")), { slip_id: sooner.id, use: 2 });
  assert.deepEqual(ok(slips.claimSlip("submit_form", FORM, "form:contact")), { slip_id: later.id, use: 1 });
  assert.equal((slips.claimSlip("submit_form", FORM, "form:contact") as Slips.Refused).refused, "no_slip");
  const use = JSON.parse(fs.readFileSync(path.join(home, "slips", sooner.id + ".use-1"), "utf8"));
  assert.equal(use.label, "form:contact");
  assert.ok(Date.parse(use.time) > 0);
  const l = slips.list();
  assert.deepEqual(l.counts, { active: 0, expired: 0, used_up: 2, damaged: 0 });
  const h = await engine.queryHistory({});
  assert.equal(h.total, 3);
  assert.equal(h.items[0].tool, "slip");
  assert.equal(h.items[0].slip, sooner.id);
  assert.equal(h.items[0].purpose, "form:contact");
  assert.equal(h.items[0].agent, "codex");
  assert.equal(h.items[0].url, FORM);
  // A label is short and plain, and a refused claim writes nothing.
  grant();
  for (const bad of ["", "Has Space", "x".repeat(65), "<script>"]) assert.equal((slips.claimSlip("submit_form", FORM, bad) as Slips.Refused).refused, "bad_label");
  assert.equal((await engine.queryHistory({})).total, 3);
  // An expired slip is never matched or claimed.
  assert.equal((slips.claimSlip("submit_form", FORM, "x", { now: now + 2 * D }) as Slips.Refused).refused, "no_slip");
  assert.equal((slips.checkSlip("submit_form", FORM, { now: now + 2 * D }) as Slips.Refused).refused, "no_slip");
});

test("W-05: processes claiming at the same moment never share a use: 100 uses, 8 claimers, exactly 100 claims", async () => {
  newHome();
  const s = grant({ uses: "100" });
  const startAt = Date.now() + 1500; // every claimer starts at the same moment, then claims until refused
  const script = `const s = await import(${JSON.stringify(path.join(DIST, "slips.js"))});
    while (Date.now() < ${startAt});
    const got = [];
    for (;;) { const r = s.claimSlip("submit_form", ${JSON.stringify(FORM)}, "race"); if (!r.slip_id) break; got.push(r.use); }
    process.stdout.write(JSON.stringify(got));`;
  const one = () =>
    new Promise<number[]>((resolve) => {
      const c = spawn(process.execPath, ["--input-type=module", "-e", script], { env: process.env });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.on("close", () => resolve(JSON.parse(out || "[]")));
    });
  const all = (await Promise.all(Array.from({ length: 8 }, one))).flat().sort((x, y) => x - y);
  assert.deepEqual(all, Array.from({ length: 100 }, (_, i) => i + 1), "each use claimed exactly once");
  assert.deepEqual(slips.list().counts, { active: 0, expired: 0, used_up: 1, damaged: 0 });
  void s;
});

test("W-05: a slip whose fields, signature, file name or profile do not verify is damaged: counted, never used", () => {
  newHome();
  const edit = (f: (o: any) => void) => {
    const v = grant({ path: "/contact" });
    const o = JSON.parse(fs.readFileSync(slipFile(v.id), "utf8"));
    f(o);
    fs.writeFileSync(slipFile(v.id), JSON.stringify(o));
    return v.id;
  };
  edit((o) => (o.uses = 100)); // more uses than granted
  edit((o) => (o.path = null)); // a wider path
  edit((o) => (o.site = "https://other.example"));
  edit((o) => (o.expires_at = new Date(Date.parse(o.expires_at) + D).toISOString())); // extended
  edit((o) => (o.sig = o.sig.slice(0, -2) + (o.sig.endsWith("AA") ? "BA" : "AA")));
  edit((o) => (o.extra = 1));
  edit((o) => (o.profile = "other"));
  const moved = edit(() => {});
  fs.renameSync(slipFile(moved), slipFile("Z".repeat(24)));
  fs.writeFileSync(slipFile("Y".repeat(24)), "{not json");
  const l = slips.list();
  assert.deepEqual(l.counts, { active: 0, expired: 0, used_up: 0, damaged: 9 });
  assert.equal((slips.claimSlip("submit_form", FORM, "x") as Slips.Refused).refused, "no_slip");
  assert.equal(fs.readdirSync(slipDir()).filter((n) => n.includes(".use-")).length, 0, "nothing was claimed");
  // No slip key at all: every slip is damaged.
  const ok1 = grant();
  assert.ok("slip_id" in slips.checkSlip("submit_form", FORM));
  fs.rmSync(path.join(store.homeDir(), "keys", keys.SLIP_KEY_FILE));
  assert.equal(slips.list().counts.damaged, 10);
  assert.equal((slips.checkSlip("submit_form", FORM) as Slips.Refused).refused, "no_slip");
  slips.revoke(ok1.id); // a damaged slip can still be revoked
});

test("W-05: slips are per profile: a slip copied from another profile never verifies, and the root gains nothing", async () => {
  const home = newHome();
  profiles.create("client-a");
  profiles.create("client-b");
  const rootTop = () => fs.readdirSync(home).sort();
  const a = await as("client-a", () => grant());
  await as("client-a", () => assert.ok("slip_id" in slips.checkSlip("submit_form", FORM)));
  await as("client-b", () => {
    assert.equal((slips.checkSlip("submit_form", FORM) as Slips.Refused).refused, "no_slip");
    grant({ site: "https://other.example" }); // client-b gets its own key
    fs.copyFileSync(path.join(store.profileDir("client-a"), "slips", a.id + ".json"), slipFile(a.id));
    assert.equal(slips.list().counts.damaged, 1, "another profile's slip is damaged here");
    assert.equal((slips.claimSlip("submit_form", FORM, "x") as Slips.Refused).refused, "no_slip");
  });
  assert.deepEqual(rootTop(), ["profiles"], "profile grants write nothing at the root");
  // Even with the same key, the profile name inside the signed bytes stops it.
  await as(undefined, () => {
    grant({ site: "https://third.example" });
    fs.copyFileSync(path.join(store.profileDir("client-a"), "keys", keys.SLIP_KEY_FILE), path.join(home, "keys", keys.SLIP_KEY_FILE));
    fs.copyFileSync(path.join(store.profileDir("client-a"), "slips", a.id + ".json"), path.join(home, "slips", a.id + ".json"));
    assert.equal((slips.checkSlip("submit_form", FORM) as Slips.Refused).refused, "no_slip");
    assert.equal(slips.list().counts.damaged, 2);
  });
});

test("W-05: revoke renames the slip away first, so a revoke cut short can never leave a usable slip", async () => {
  newHome();
  const v = grant({ uses: "3" });
  ok(slips.claimSlip("submit_form", FORM, "x"));
  // A revoke cut short right after its rename: the use files are still there.
  fs.renameSync(slipFile(v.id), path.join(slipDir(), ".revoked-" + v.id));
  assert.equal((slips.claimSlip("submit_form", FORM, "x") as Slips.Refused).refused, "no_slip");
  assert.deepEqual(slips.list().counts, { active: 0, expired: 0, used_up: 0, damaged: 0 });
  // clear removes what was left (the use file and the renamed slip); nothing else.
  const kept = grant();
  const r = await clearStore({});
  assert.equal(r.slips.removed, 2);
  assert.deepEqual(fs.readdirSync(slipDir()).sort(), [kept.id + ".json"]);
  // revoke <id>, then revoke --all (damaged ones included).
  slips.revoke(kept.id);
  assert.throws(() => slips.revoke(kept.id), /no slip with that id/);
  assert.throws(() => slips.revoke("../../etc/passwd"), /slip id is 24 characters/);
  grant();
  grant();
  fs.writeFileSync(slipFile("Q".repeat(24)), "damaged");
  assert.equal(slips.revokeAll(), 3);
  assert.deepEqual(fs.readdirSync(slipDir()), [slips.REVOKED_LIST]);
  // From the CLI, by a person at a terminal (v0.5.1).
  const c = await runAsPerson(CLI, ["slip", "grant", "--action", "submit_form", "--site", SITE], SITE);
  const id = c.json.slip.id;
  assert.equal((await runAsPerson(CLI, ["slip", "revoke", id], SITE)).code, 0);
  assert.equal(slips.list().counts.active, 0);
});

test("W-05: a revoke that dies at its first deletion has already made the slip unusable", () => {
  newHome();
  const v = grant({ uses: "3" });
  ok(slips.claimSlip("submit_form", FORM, "x"));
  const real = fs.rmSync;
  (fs as any).rmSync = () => {
    throw new Error("crash");
  };
  try {
    assert.throws(() => slips.revoke(v.id), /crash/);
  } finally {
    (fs as any).rmSync = real;
  }
  assert.equal((slips.claimSlip("submit_form", FORM, "x") as Slips.Refused).refused, "no_slip");
  assert.equal(slips.list().counts.active, 0);
});

test("W-05: the claim decides after taking the use: a slip revoked between the match and the claim is not used", () => {
  newHome();
  const v = grant({ uses: "2" });
  const real = fs.openSync;
  (fs as any).openSync = (file: fs.PathLike, ...rest: any[]) => {
    if (String(file).includes(".use-")) {
      (fs as any).openSync = real;
      fs.renameSync(slipFile(v.id), path.join(slipDir(), ".revoked-" + v.id)); // a revoke starts now
    }
    return (real as any)(file, ...rest);
  };
  try {
    assert.equal((slips.claimSlip("submit_form", FORM, "x") as Slips.Refused).refused, "no_slip");
  } finally {
    (fs as any).openSync = real;
  }
  assert.equal(fs.existsSync(path.join(slipDir(), v.id + ".use-1")), false, "the use taken was given back");
});

test("W-05: private mode: grant, revoke and claim are refused and create nothing; check and list still read", async () => {
  const home = newHome();
  const v = grant();
  const before = tree(home);
  assert.throws(() => slips.grant({ action: "submit_form", site: SITE }, true), /Private mode/);
  assert.throws(() => slips.revoke(v.id, true), /Private mode/);
  assert.throws(() => slips.revokeAll(true), /Private mode/);
  assert.equal((slips.claimSlip("submit_form", FORM, "x", { private: true }) as Slips.Refused).refused, "private_mode");
  assert.equal((store.runPrivate(() => slips.claimSlip("submit_form", FORM, "x")) as Slips.Refused).refused, "private_mode");
  process.env.TIRESIAS_PRIVATE = "1";
  try {
    assert.equal((slips.claimSlip("submit_form", FORM, "x") as Slips.Refused).refused, "private_mode");
    assert.ok("slip_id" in slips.checkSlip("submit_form", FORM));
    assert.equal(slips.list().counts.active, 1);
  } finally {
    delete process.env.TIRESIAS_PRIVATE;
  }
  for (const args of [["slip", "grant", "--action", "submit_form", "--site", SITE], ["slip", "revoke", v.id], ["slip", "revoke", "--all"]]) {
    const r = await run(args, { TIRESIAS_PRIVATE: "1" });
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.stderr, /Private mode/);
    assert.equal((await run([...args, "--private"])).code, 1);
  }
  assert.deepEqual(tree(home), before);
  assert.equal((await run(["slip", "list"], { TIRESIAS_PRIVATE: "1" })).code, 0);
  // A private session with no store creates nothing either.
  const empty = newHome();
  assert.throws(() => slips.grant({ action: "submit_form", site: SITE }, true), /Private mode/);
  assert.equal((await run(["slip", "grant", "--action", "submit_form", "--site", SITE], { TIRESIAS_PRIVATE: "1" })).code, 1);
  assert.equal(fs.existsSync(empty), false);
});

test("W-05: clear removes expired and used-up slips, keeps active ones even with --all, and the disk cap does not count them", async () => {
  newHome();
  const now = Date.now();
  const active = grant({ for: "10d" }, now);
  const soon = grant({ for: "1d" }, now);
  const used = grant({ site: "https://used.example", for: "3d" }, now);
  ok(slips.claimSlip("submit_form", "https://used.example/form", "x"));
  // Before anything expires, only the used-up slip goes.
  const dry0 = await clearStore({ dryRun: true, now });
  assert.equal(dry0.slips.removed, 1);
  assert.equal(dry0.slips.kept, 2);
  const later = now + 2 * D; // `soon` has expired too, `active` has not
  const dry = await clearStore({ dryRun: true, now: later });
  assert.equal(dry.slips.removed, 2);
  assert.equal(dry.slips.kept, 1);
  assert.equal(fs.readdirSync(slipDir()).length, 4, "a dry run changes nothing (3 slips and a use file)");
  const all = await clearStore({ all: true, now: later });
  assert.equal(all.slips.removed, 2);
  assert.equal(all.slips.bytes_freed, dry.slips.bytes_freed);
  assert.ok(all.slips.bytes_freed > 0);
  assert.match(all.summary, /2 expired or used-up slips/);
  assert.deepEqual(fs.readdirSync(slipDir()).sort(), [active.id + ".json", slips.REVOKED_LIST].sort(), "--all keeps an active slip");
  assert.equal(fs.existsSync(slipFile(soon.id)) || fs.existsSync(slipFile(used.id)), false);
  // The disk cap does not count slips/ (a 1 MB cap with a 2 MB file in slips/ removes nothing).
  fs.writeFileSync(path.join(slipDir(), "big.bin"), Buffer.alloc(2 * 1024 * 1024));
  const cap = await clearStore({ limits: { keep_history_days: 90, keep_receipts_days: 90, keep_cache_days: 30, max_disk_mb: 1, keep_handoff_days: 7 } });
  assert.equal(cap.disk_cap.over_by_bytes, 0);
  assert.ok(fs.existsSync(slipFile(active.id)));
});

test("W-05: at most 200 slips per profile", () => {
  newHome();
  for (let i = 0; i < slips.MAX_SLIPS; i++) grant();
  assert.throws(() => grant(), /already 200 slips/);
});

test("W-05: MCP has a read-only slips tool and nothing that grants, extends or edits a slip; replies stay within budget", async () => {
  newHome();
  profiles.create("agent-x");
  await as("agent-x", async () => {
    for (let i = 0; i < slips.MAX_SLIPS; i++) grant({ path: "/" + "p".repeat(500), note: "注".repeat(200) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer().connect(a);
    const c = new Client({ name: "slip-agent", version: "1" });
    await c.connect(b);
    const tools = (await c.listTools()).tools;
    const t = tools.find((x) => x.name === "slips")!;
    assert.deepEqual(Object.keys((t.inputSchema as any).properties ?? {}), ["page"]);
    assert.deepEqual(tools.filter((x) => /slip|grant|permission/i.test(x.name)).map((x) => x.name), ["slips"]);
    for (const x of tools) {
      for (const p of Object.keys((x.inputSchema as any).properties ?? {})) assert.doesNotMatch(p, /slip|grant|permission/i, `${x.name}.${p}`);
    }
    const r1 = await c.callTool({ name: "slips", arguments: {} });
    const text = (r1.content as any)[0].text as string;
    assert.ok(Buffer.byteLength(text) < 60_000, String(Buffer.byteLength(text)));
    const r = JSON.parse(text);
    assert.equal(r.profile, "agent-x");
    assert.equal(r.counts.active, 200);
    assert.ok(r.pages > 1);
    assert.equal(Object.hasOwn(r.slips[0], "note"), false, "notes are not at the top level");
    assert.equal(r.untrusted_content.notes[0].note, "注".repeat(200));
    const last = JSON.parse(((await c.callTool({ name: "slips", arguments: { page: r.pages } })).content as any)[0].text);
    assert.ok(last.slips.length > 0);
    // Calling a slip tool with grant-like arguments changes nothing.
    await c.callTool({ name: "slips", arguments: { action: "grant", site: "https://evil.example", uses: 100 } as any });
    assert.equal(slips.list().counts.active, 200);
    await c.close();
  });
});

test("Codex round 49: revoke --all never resets the uses of a slip granted and claimed after its listing", () => {
  newHome();
  const old = grant();
  let late = "";
  const real = fs.renameSync;
  (fs as any).renameSync = (a: fs.PathLike, b: fs.PathLike) => {
    (fs as any).renameSync = real;
    // Another process grants a one-use slip and uses it while revoke --all is running.
    late = grant({ site: "https://late.example" }).id;
    ok(slips.claimSlip("submit_form", "https://late.example/form", "x"));
    return real(a, b);
  };
  try {
    assert.equal(slips.revokeAll(), 1);
  } finally {
    (fs as any).renameSync = real;
  }
  assert.ok(fs.existsSync(path.join(slipDir(), late + ".use-1")), "the new slip's use is kept");
  assert.equal((slips.claimSlip("submit_form", "https://late.example/form", "x") as Slips.Refused).refused, "no_slip", "its one use stays used");
  assert.equal(fs.existsSync(slipFile(old.id)), false);
});

test("Codex round 49: --until with a full time checks every calendar and clock part (no Feb 30 roll-forward)", () => {
  newHome();
  // The next non-leap year after this one, so Feb 29 is never a real date (Codex round 50).
  let y = new Date().getFullYear() + 1;
  while ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) y++;
  const now = new Date(y, 1, 20).getTime(); // February 20 of that year
  for (const bad of [`${y}-02-30T12:00Z`, `${y}-02-29T12:00`, `${y}-13-01T00:00`, `${y}-02-21T24:00`, `${y}-02-21T12:60`, `${y}-02-21T12:00:61`, `${y}-02-21T12:00+24:00`])
    assert.throws(() => slips.expiryFrom({ until: bad }, now), /not a real time/, bad);
  assert.equal(slips.expiryFrom({ until: `${y}-02-25T12:00Z` }, now), Date.UTC(y, 1, 25, 12));
});

test("Codex round 49: --site must be exactly an origin as written, before any URL normalization", () => {
  newHome();
  for (const site of ["https://shop.example/contact/..", "https://shop.example/.", "https://shop.example//", "https://shop.example/%2e%2e", "https://shöp.example", " https://shop.example", "https://shop.example:"])
    assert.throws(() => grant({ site }), /exact origin/, site);
  assert.equal(grant({ site: "https://shop.example/" }).site, SITE);
  assert.equal(grant({ site: "https://[::1]:8443" }).site, "https://[::1]:8443");
});

test("Codex round 49: a bad slip key skips only the slip cleanup; history and the rest are still trimmed", async () => {
  const home = newHome();
  const now = Date.now();
  const expired = grant({ for: "1h" }, now - 2 * H);
  fs.mkdirSync(path.join(home, "history"), { mode: 0o700 });
  const oldDay = path.join(home, "history", "2001-01-01.jsonl");
  fs.writeFileSync(oldDay, '{"time":"2001-01-01T00:00:00Z"}\n', { mode: 0o600 });
  fs.chmodSync(path.join(home, "keys", keys.SLIP_KEY_FILE), 0o644);
  const r = await clearStore({});
  assert.equal(fs.existsSync(oldDay), false, "history was still trimmed");
  assert.equal(r.history.removed, 1);
  assert.match(r.slips_problem ?? "", /Slips were not cleaned up .*can be read by other users/);
  assert.match(r.summary, /Slips were not cleaned up/);
  assert.equal(r.slips.removed, 0);
  assert.ok(fs.existsSync(slipFile(expired.id)), "every slip is left as it is");
});
