// SPDX-License-Identifier: Apache-2.0
// v0.4 phase A: W-18 profiles. Separate keys, history, cache and rules per profile; the Retry-After log
// and the Safe Browsing list are shared at the store root.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { freshHome, html, serve, text, type TestServer } from "./helper.js";

// A fake home: nothing here may read the owner's real ~/.config/tiresias/secrets.env.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-v04-home-"));
process.env.HOME = FAKE_HOME;
freshHome();
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
delete process.env.TIRESIAS_PRIVATE;
delete process.env.TIRESIAS_PROFILE;
delete process.env.TIRESIAS_WEB_RISK_KEY;
delete process.env.TIRESIAS_WEB_RISK_ENDPOINT;
// Web Risk tests use names under pf.example, answered here without any real DNS query.
const dnsp = (await import("node:dns/promises")).default as any;
const realLookup = dnsp.lookup;
dnsp.lookup = (name: string, opts: unknown) => (name.endsWith(".pf.example") ? Promise.resolve([{ address: "127.0.0.1", family: 4 }]) : realLookup(name, opts));
const engine = await import("../engine.js");
const store = await import("../store.js");
const keys = await import("../keys.js");
const profiles = await import("../profiles.js");
const sb = await import("../safebrowsing.js");
const { createServer } = await import("../mcp.js");

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const servers: TestServer[] = [];
const start = async (h: Parameters<typeof serve>[0]) => {
  const s = await serve(h);
  servers.push(s);
  return s;
};
after(async () => {
  for (const s of servers) await s.close();
  (await import("../sandbox.js")).stopWorker();
});
const PAGE = "<html><head><title>Anvils</title></head><body><h1>Anvils</h1><p>Heavy iron anvils for sale.</p><h2>Prices</h2><p>Anvils cost forty dollars.</p></body></html>";
const CAPTCHA = '<html><head><title>Check</title></head><body><form><div class="g-recaptcha"></div></form></body></html>';
const site = () =>
  start((req, res) => {
    if (req.url === "/robots.txt" || req.url === "/llms.txt") return text(res, "", 404);
    if (req.url === "/wall") return html(res, CAPTCHA, {}, 403);
    if (req.url === "/busy") return text(res, "slow down", 429, { "retry-after": "120" });
    html(res, PAGE);
  });
// The Phishing.Database stand-in (the safety/ writer).
const listServer = await start((req, res) => (req.url === "/list.txt" ? text(res, "evil.example\n") : text(res, "", 404)));
process.env.TIRESIAS_SAFETY_LIST_URL = listServer.url + "/list.txt";

// Run `fn` with TIRESIAS_PROFILE set (undefined = default), then put it back.
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
// Every path under `dir`, relative, sorted (links are listed, never followed).
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
async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  const client = new Client({ name: "v04-agent", version: "1" });
  await client.connect(b);
  return client;
}
const body = (r: any) => JSON.parse(r.content[0].text);
// A store folder that does not exist yet (freshHome makes the temp folder itself).
function newHome(): string {
  const d = path.join(freshHome(), "store");
  process.env.TIRESIAS_HOME = d;
  return d;
}

test("W-18: profile names are [a-z0-9-]{1,32}; a bad name is refused with fixed text that never repeats it", async () => {
  newHome();
  for (const bad of ["", "UPPER", "a/b", "../evil-name", "x".repeat(33), "dot.name", "spa ce", "émoji"]) {
    assert.throws(() => store.checkProfileName(bad), (e: Error) => e.message === store.BAD_PROFILE);
    assert.throws(() => profiles.create(bad), (e: Error) => e.message === store.BAD_PROFILE);
  }
  assert.equal(store.checkProfileName("client-a-2"), "client-a-2");
  assert.equal(store.checkProfileName("x".repeat(32)), "x".repeat(32));
  // From the CLI and the environment too, and nothing is created.
  const home = newHome();
  const r = await run(["history", "--profile", "../evil-name"]);
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stderr.trim()).message, store.BAD_PROFILE); // v0.5.1: one JSON line on stderr
  assert.doesNotMatch(r.stderr + r.stdout, /evil/);
  const e = await run(["history"], { TIRESIAS_PROFILE: "Evil/Name" });
  assert.equal(e.code, 1);
  assert.doesNotMatch(e.stderr, /Evil/);
  assert.equal(fs.existsSync(home), false);
});

test("W-18: a profile that does not exist is a clear error and nothing is created, private mode included", async () => {
  const home = newHome();
  const s = await site();
  for (const priv of [false, true]) {
    const out = await as("ghost", () => engine.read(s.url + "/", {}, { agent: "t", private: priv }));
    assert.equal(out.status, "error");
    assert.match(out.message ?? "", /profile "ghost" does not exist/);
  }
  assert.equal(s.count("/"), 0, "nothing was sent");
  assert.equal(fs.existsSync(home), false, "not even the store root");
  // The CLI and the MCP server refuse to start on it.
  for (const args of [["read", s.url + "/", "--profile", "ghost"], ["mcp", "--profile", "ghost"], ["read", s.url + "/", "--profile", "ghost", "--private"]]) {
    const r = await run(args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(JSON.parse(r.stderr.trim()).message, /profile "ghost" does not exist.*Nothing was created/);
  }
  assert.equal(fs.existsSync(home), false);
  // With a store but no such profile: still nothing created (no profiles/ folder).
  fs.mkdirSync(home, { mode: 0o700 });
  await as("ghost", () => engine.read(s.url + "/", {}, { agent: "t" }));
  assert.deepEqual(tree(home), []);
  // With other profiles there (profiles/ exists), the missing one is still an error, not "empty".
  profiles.create("other");
  const before = tree(home);
  const out = await as("ghost", () => engine.read(s.url + "/", {}, { agent: "t" }));
  assert.equal(out.status, "error");
  assert.match(out.message ?? "", /profile "ghost" does not exist/);
  await as("ghost", () => assert.rejects(engine.queryHistory({}), /profile "ghost" does not exist/));
  assert.equal(s.count("/"), 0);
  assert.deepEqual(tree(home), before);
});

test("W-18: every store writer under a non-default profile writes into its folder; the root gets only cooldowns and safety/", async () => {
  const home = newHome();
  process.env.TIRESIAS_SAFE_BROWSING = "1";
  try {
    profiles.create("client-a");
    const before = tree(home);
    const s = await site();
    const dir = store.profileDir("client-a");
    await as("client-a", async () => {
      assert.equal(store.homeDir(), dir);
      assert.equal((await engine.safetyUpdate()).status, "ok"); // safety/ (shared)
      await keys.initKey(); // keys/
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ signature_agent: "https://client-a.example", keep_cache_days: 30 }));
      const r = await engine.read(s.url + "/", { question: "price" }, { agent: "t" }); // cache, doors cache, history, receipts, maintenance.json
      assert.equal(r.status, "ok");
      assert.equal(r.signed, true);
      assert.equal(r.profile, "client-a");
      assert.equal((await engine.check(s.url + "/", { agent: "t" })).status, "unchanged");
      const w = await engine.read(s.url + "/wall", {}, { agent: "t" }); // handoffs/
      assert.equal(w.status, "wall");
      assert.ok(w.handoff?.ticket);
      assert.equal((await engine.bookmark("add", "anvils", s.url + "/", true, { agent: "t" })).status, "ok"); // bookmarks/
      const w2 = await engine.watch({ agent: "t" });
      assert.equal(w2.counts.unchanged, 1, JSON.stringify(w2));
      const busy = await engine.read(s.url + "/busy", {}, { agent: "t" }); // last: the wait covers the whole site. cooldowns.jsonl (shared)
      assert.equal(busy.retry_after_seconds, 120, JSON.stringify(busy));
      await (await import("../cleanup.js")).clearStore({}); // reads and deletes only here
      assert.equal(engine.handoffList().status, "ok");
    });
    // Everything new at the root is shared; everything personal is in the profile.
    const added = tree(home).filter((p) => !before.includes(p) && !p.startsWith(path.join("profiles", "client-a")));
    assert.deepEqual([...new Set(added.map((p) => p.split(path.sep)[0]))].sort(), ["cooldowns.jsonl", "hosts", "safety"]);
    const own = fs.readdirSync(dir).sort();
    for (const sub of ["bookmarks", "cache", "config.json", "handoffs", "history", "keys", "maintenance.json", "profile.json", "receipts"]) assert.ok(own.includes(sub), sub);
    assert.equal(own.includes("cooldowns.jsonl") || own.includes("safety"), false);
    // The default profile saw none of it, and still obeys the shared Retry-After.
    await as(undefined, async () => {
      assert.equal((await engine.queryHistory({})).total, 0);
      assert.equal(engine.bookmarkList().counts?.bookmarks, 0);
      const d = await engine.read(s.url + "/busy", {}, { agent: "t" });
      assert.equal(d.status, "refused");
      assert.ok((d.retry_after_seconds ?? 0) > 0, "the site's wait applies whatever the profile");
      assert.equal(d.profile, undefined);
    });
  } finally {
    process.env.TIRESIAS_SAFE_BROWSING = "0";
  }
});

test("W-18: no source file builds a store path on its own (the store root, profiles/ and the profile choice live in store.ts)", () => {
  const files = fs.readdirSync(SRC).filter((n) => n.endsWith(".ts"));
  assert.ok(files.length > 20);
  for (const n of files) {
    if (n === "store.ts") continue;
    const src = fs.readFileSync(path.join(SRC, n), "utf8");
    assert.doesNotMatch(src, /process\.env\.TIRESIAS_(HOME|PROFILE)/, `${n} reads the store location itself`);
    assert.doesNotMatch(src, /["'`]\.tiresias["'`]/, `${n} names the store folder itself`);
    assert.doesNotMatch(src, /["'`]profiles["'`]/, `${n} builds a profiles/ path itself`);
    // profiles.ts inspects other profiles' keys/ for `profile list`; every other file uses subDir().
    if (n !== "profiles.ts") assert.doesNotMatch(src, /path\.join\([^)]*["'`](cache|history|receipts|bookmarks|handoffs|keys|safety|slips)["'`]/, `${n} joins a store sub-folder itself instead of subDir()`);
  }
});

test("W-18: private mode under a profile creates nothing, not even a sub-folder of the profile", async () => {
  const home = newHome();
  profiles.create("quiet");
  const s = await site();
  const before = tree(home);
  await as("quiet", async () => {
    const r = await engine.read(s.url + "/", {}, { agent: "t", private: true });
    assert.equal(r.status, "ok");
    assert.equal(r.private, true);
    assert.equal(r.profile, "quiet");
    assert.equal((await engine.bookmark("add", "x", s.url + "/", false, { agent: "t", private: true })).status, "refused");
  });
  assert.deepEqual(tree(home).filter((f) => f !== "hosts" && !f.startsWith("hosts/")), before);
  assert.throws(() => profiles.create("other", true), /Private mode/);
  assert.equal((await run(["profile", "create", "other"], { TIRESIAS_PRIVATE: "1" })).code, 1);
  assert.deepEqual(tree(home).filter((f) => f !== "hosts" && !f.startsWith("hosts/")), before);
});

test("W-18: clear --all on default never touches other profiles or the shared entries, and the default disk cap does not count them", async () => {
  const home = newHome();
  const s = await site();
  profiles.create("big");
  await as("big", () => engine.read(s.url + "/", {}, { agent: "t" }));
  await as(undefined, () => engine.read(s.url + "/", {}, { agent: "t" }));
  await as(undefined, () => engine.read(s.url + "/busy", {}, { agent: "t" }));
  // 3 MB in the other profile and in safety/: the default cap is 1 MB.
  fs.writeFileSync(path.join(store.profileDir("big"), "cache", "junk.json"), Buffer.alloc(3 * 1024 * 1024));
  fs.mkdirSync(path.join(home, "safety"), { mode: 0o700 });
  fs.writeFileSync(path.join(home, "safety", "phishing-domains.txt"), Buffer.alloc(3 * 1024 * 1024));
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ max_disk_mb: 1 }));
  const big = tree(store.profileDir("big"));
  const cleanup = await import("../cleanup.js");
  const dry = await as(undefined, () => cleanup.clearStore({}));
  assert.ok(dry.store_bytes_after < 1024 * 1024, `default counted ${dry.store_bytes_after} bytes`);
  assert.equal(dry.disk_cap.files_removed, 0);
  const all = await as(undefined, () => cleanup.clearStore({ all: true }));
  assert.ok(all.history.removed >= 1 && all.cache.removed >= 1);
  assert.deepEqual(tree(store.profileDir("big")), big);
  assert.ok(fs.existsSync(path.join(home, "cooldowns.jsonl")));
  assert.ok(fs.existsSync(path.join(home, "safety", "phishing-domains.txt")));
  // The profile has its own cap, over its own folder.
  fs.writeFileSync(path.join(store.profileDir("big"), "config.json"), JSON.stringify({ max_disk_mb: 1 }));
  const own = await as("big", () => cleanup.clearStore({}));
  assert.ok(own.disk_cap.files_removed >= 1);
  assert.equal(fs.existsSync(path.join(store.profileDir("big"), "cache", "junk.json")), false);
  assert.ok(fs.existsSync(path.join(home, "safety", "phishing-domains.txt")));
});

test("W-18: two profiles sign with their own keys as different signature_agent origins; default stays unsigned", async () => {
  const home = newHome();
  const s = await site();
  const info: Record<string, { keyid: string }> = {};
  for (const [name, origin] of [["agent-one", "https://one.example"], ["agent-two", "https://two.example"]]) {
    profiles.create(name);
    await as(name, async () => {
      info[name] = await keys.initKey();
      fs.writeFileSync(path.join(store.homeDir(), "config.json"), JSON.stringify({ signature_agent: origin }));
      s.hits.length = 0;
      const r = await engine.read(s.url + "/", {}, { agent: "t" });
      assert.equal(r.signed, true);
      const hit = s.hits.find((h) => h.path === "/")!;
      assert.equal(hit.headers["signature-agent"], `"${origin}"`);
      assert.match(String(hit.headers["signature-input"]), new RegExp(`keyid="${info[name].keyid}"`));
    });
  }
  assert.notEqual(info["agent-one"].keyid, info["agent-two"].keyid);
  assert.equal(fs.existsSync(path.join(home, "keys")), false);
  const d = await as(undefined, () => engine.read(s.url + "/", { fresh: true }, { agent: "t" }));
  assert.equal(d.signed, false);
  // keys show per profile, from the CLI.
  const r = await run(["keys", "show", "--profile", "agent-two"]);
  assert.equal(r.code, 0, r.stderr);
  const shown = JSON.parse(r.stdout);
  assert.equal(shown.keyid, info["agent-two"].keyid);
  assert.equal(shown.signature_agent, "https://two.example");
  assert.equal(shown.profile, "agent-two");
  assert.doesNotMatch(r.stdout, /"d"\s*:/);
});

test("W-18: the synced-folder refusal judges the profile's own folder", async () => {
  freshHome();
  profiles.create("synced");
  process.env.OneDriveCommercial = store.profileDir("synced");
  try {
    await as("synced", () => assert.rejects(keys.initKey(), /synced folder/));
    assert.equal(fs.existsSync(path.join(store.profileDir("synced"), "keys")), false);
    await as(undefined, () => keys.initKey()); // the root is not under that folder
  } finally {
    delete process.env.OneDriveCommercial;
  }
});

test("W-18: profile list shows each profile, whether it has a key and a signature_agent, and never key material", async () => {
  const home = newHome();
  assert.deepEqual(profiles.list().map((p) => p.name), ["default"]);
  assert.equal(fs.existsSync(home), false, "listing creates nothing");
  profiles.create("b-two");
  profiles.create("a-one");
  await as("a-one", () => keys.initKey());
  fs.writeFileSync(path.join(store.profileDir("a-one"), "config.json"), JSON.stringify({ signature_agent: "https://a.example/" }));
  assert.throws(() => profiles.create("a-one"), /already exists/);
  assert.throws(() => profiles.create("default"), /store root itself/);
  const r = await run(["profile", "list"]);
  assert.equal(r.code, 0, r.stderr);
  const all = JSON.parse(r.stdout).profiles;
  assert.deepEqual(all.map((p: any) => p.name), ["default", "a-one", "b-two"]);
  const a = all[1];
  assert.equal(a.signing_key, true);
  assert.equal(a.signature_agent, "https://a.example");
  assert.ok(!Number.isNaN(Date.parse(a.created_at)));
  assert.equal(all[2].signing_key, false);
  assert.equal(all[2].signature_agent, null);
  const jwk = JSON.parse(fs.readFileSync(path.join(store.profileDir("a-one"), "keys", keys.KEY_FILE), "utf8"));
  assert.equal(r.stdout.includes(jwk.d), false);
  assert.equal((await run(["profile", "list", "--profile", "a-one"])).code, 1, "--profile does not apply to profile commands");
});

test("W-18: profile remove needs --yes, refuses default, needs --delete-key for a key, and deletes only that folder", async () => {
  const home = newHome();
  const s = await site();
  profiles.create("gone");
  profiles.create("kept");
  await as("gone", () => engine.read(s.url + "/", {}, { agent: "t" }));
  await as("kept", () => engine.read(s.url + "/", {}, { agent: "t" }));
  await as(undefined, () => engine.read(s.url + "/busy", {}, { agent: "t" }));
  const kept = tree(store.profileDir("kept"));
  assert.match((await run(["profile", "remove", "gone"])).stderr, /--yes to confirm. Nothing was removed/);
  assert.match((await run(["profile", "remove", "default", "--yes"])).stderr, /cannot be created or removed/);
  assert.match((await run(["profile", "remove", "nope", "--yes"])).stderr, /does not exist/);
  // A link inside: refused before anything is deleted, and the link's target is untouched.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-outside-"));
  fs.writeFileSync(path.join(outside, "precious.txt"), "keep me");
  fs.symlinkSync(outside, path.join(store.profileDir("gone"), "cache", "link"));
  const r1 = await run(["profile", "remove", "gone", "--yes"]);
  assert.equal(r1.code, 1);
  assert.match(r1.stderr, /holds a link.*Nothing was removed/);
  assert.ok(fs.existsSync(path.join(store.profileDir("gone"), "history")));
  fs.unlinkSync(path.join(store.profileDir("gone"), "cache", "link"));
  // A signing key needs --delete-key.
  await as("gone", () => keys.initKey());
  const r2 = await run(["profile", "remove", "gone", "--yes"]);
  assert.match(r2.stderr, /has a signing key.*cannot be recovered.*--yes --delete-key.*Nothing was removed/);
  assert.ok(fs.existsSync(path.join(store.profileDir("gone"), "keys", keys.KEY_FILE)));
  const r3 = await run(["profile", "remove", "gone", "--yes", "--delete-key"]);
  assert.equal(r3.code, 0, r3.stderr);
  const rep = JSON.parse(r3.stdout);
  assert.equal(rep.key_deleted, true);
  assert.ok(rep.removed.files >= 4);
  assert.match(rep.message, /cannot be recovered/);
  assert.equal(fs.existsSync(store.profileDir("gone")), false);
  assert.deepEqual(tree(store.profileDir("kept")), kept);
  assert.ok(fs.existsSync(path.join(home, "cooldowns.jsonl")));
  assert.equal(fs.readFileSync(path.join(outside, "precious.txt"), "utf8"), "keep me");
  // Without a key, --yes is enough.
  assert.equal(profiles.remove("kept", { yes: true }).key_deleted, false);
  assert.equal(fs.existsSync(store.profileDir("kept")), false);
});

test("W-18: the MCP server serves one profile: every reply says which, and no tool takes a profile", async () => {
  freshHome();
  const s = await site();
  profiles.create("mcp-one");
  await as("mcp-one", async () => {
    const c = await connect();
    const tools = (await c.listTools()).tools;
    assert.ok(tools.length >= 12);
    for (const t of tools) assert.equal(Object.hasOwn((t.inputSchema as any).properties ?? {}, "profile"), false, t.name);
    const r = body(await c.callTool({ name: "read", arguments: { url: s.url + "/" } }));
    assert.equal(r.profile, "mcp-one");
    assert.equal(r.status, "ok");
    // A profile argument is not a way in: it is ignored, the reply still comes from mcp-one.
    const h = body(await c.callTool({ name: "history", arguments: { profile: "default" } as any }));
    assert.equal(h.profile, "mcp-one");
    assert.equal(h.total, 1);
    for (const name of ["bookmarks", "handoffs", "receipts", "needs_report", "log"]) assert.equal(body(await c.callTool({ name, arguments: {} })).profile, "mcp-one", name);
    await c.close();
  });
  // default: no profile field at all.
  const c = await connect();
  const r = body(await c.callTool({ name: "read", arguments: { url: s.url + "/" } }));
  assert.equal(Object.hasOwn(r, "profile"), false);
  await c.close();
});

test("W-18: selectProfile fixes the profile for the process; TIRESIAS_PROFILE changes after it are ignored", async () => {
  freshHome();
  profiles.create("fixed");
  try {
    await as("fixed", () => store.selectProfile());
    process.env.TIRESIAS_PROFILE = "default";
    assert.equal(store.profileName(), "fixed");
    assert.equal(store.homeDir(), store.profileDir("fixed"));
    assert.throws(() => store.selectProfile("Bad!"), (e: Error) => e.message === store.BAD_PROFILE);
  } finally {
    delete process.env.TIRESIAS_PROFILE;
    store.resetProfile();
  }
  assert.equal(store.profileName(), "default");
});

test("W-18: the Web Risk key is per profile: the default key file belongs to default, and verdicts are not shared", async () => {
  freshHome();
  process.env.TIRESIAS_SAFE_BROWSING = "1";
  sb.clearWebRiskCache();
  // The owner's default key file, in the (fake) home.
  const cfg = path.join(FAKE_HOME, ".config", "tiresias");
  fs.mkdirSync(cfg, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(cfg, "secrets.env"), "WEB_RISK_API_KEY=OWNERKEY-abcdefghij\n", { mode: 0o600 });
  const wrHits: string[] = [];
  const wr = await start((req, res) => {
    wrHits.push(new URL(req.url ?? "/", "http://x").searchParams.get("key") ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  process.env.TIRESIAS_WEB_RISK_ENDPOINT = wr.url + "/v1/uris:search";
  try {
    const s = await site();
    const url = s.url.replace("127.0.0.1", "shop.pf.example") + "/";
    profiles.create("client-key");
    profiles.create("client-none");
    const own = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-ck-")), "secrets.env");
    fs.writeFileSync(own, "WEB_RISK_API_KEY=CLIENTKEY-abcdefghij\n", { mode: 0o600 });
    fs.writeFileSync(path.join(store.profileDir("client-key"), "config.json"), JSON.stringify({ web_risk_key_file: own }));
    assert.equal(engine.safetyStatus().web_risk.configured, true);
    assert.equal(await as("client-none", () => engine.safetyStatus().web_risk.configured), false, "no owner key for a client profile");
    await as(undefined, () => engine.read(url, {}, { agent: "t" }));
    await as("client-none", () => engine.read(url, {}, { agent: "t" }));
    await as("client-key", () => engine.read(url, {}, { agent: "t" }));
    const owner = wrHits.filter((k) => k === "OWNERKEY-abcdefghij").length;
    assert.ok(owner >= 1);
    const client = wrHits.length - owner;
    assert.ok(client >= 1, "the client profile asked Google itself: no cached verdict crossed profiles");
    assert.deepEqual(wrHits, [...Array(owner).fill("OWNERKEY-abcdefghij"), ...Array(client).fill("CLIENTKEY-abcdefghij")], "each profile asks with its own key; client-none asks nothing");
  } finally {
    process.env.TIRESIAS_SAFE_BROWSING = "0";
    delete process.env.TIRESIAS_WEB_RISK_ENDPOINT;
    fs.rmSync(path.join(FAKE_HOME, ".config"), { recursive: true, force: true });
  }
});

// ---- Codex round 46 ----

test("W-18 round 46: removal renames the profile away first and never follows a folder swapped for a link mid-delete", async () => {
  newHome();
  const s = await site();
  profiles.create("gone");
  profiles.create("kept");
  for (const n of ["gone", "kept"]) await as(n, () => engine.read(s.url + "/", {}, { agent: "t" })); // same URL: same cache file names
  const keptCache = path.join(store.profileDir("kept"), "cache");
  const keptFiles = fs.readdirSync(keptCache).sort();
  assert.ok(keptFiles.length >= 1);
  // The first file deleted outside cache/ swaps the profile's cache/ for a link to kept's cache/.
  const aside = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-aside-"));
  const realUnlink = fs.unlinkSync;
  let swapped = false;
  let goneDuringDelete = false;
  (fs as any).unlinkSync = (f: string) => {
    const parts = String(f).split(path.sep);
    const i = parts.lastIndexOf("profiles");
    if (!swapped && i >= 0 && parts[i + 2] !== "cache") {
      swapped = true;
      goneDuringDelete = !fs.existsSync(store.profileDir("gone"));
      const root = parts.slice(0, i + 2).join(path.sep);
      fs.renameSync(path.join(root, "cache"), path.join(aside, "cache"));
      fs.symlinkSync(keptCache, path.join(root, "cache"));
    }
    return realUnlink(f);
  };
  try {
    const r = profiles.remove("gone", { yes: true });
    assert.ok(swapped, "the swap happened during the removal");
    assert.ok(goneDuringDelete, "the profile was renamed away before anything was deleted");
    assert.equal(r.removed.files >= 1, true);
  } finally {
    (fs as any).unlinkSync = realUnlink;
  }
  assert.deepEqual(fs.readdirSync(keptCache).sort(), keptFiles, "kept's cached pages were not touched");
  assert.equal(fs.existsSync(store.profileDir("gone")), false);
  assert.deepEqual(profiles.leftovers(), []);
});

test("W-18 round 46: an interrupted removal leaves .removing-*: never a profile, reported by list, finished by the next remove", async () => {
  const home = newHome();
  profiles.create("one");
  profiles.create("two");
  const left = path.join(home, "profiles", ".removing-0123456789abcdef");
  fs.mkdirSync(path.join(left, "cache"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(left, "cache", "x.json"), "{}");
  assert.deepEqual(profiles.list().map((p) => p.name), ["default", "one", "two"]);
  const l = await run(["profile", "list"]);
  assert.equal(JSON.parse(l.stdout).removing_leftovers, 1);
  assert.equal(profiles.remove("one", { yes: true }).leftovers_finished, 1);
  assert.equal(fs.existsSync(left), false);
  assert.deepEqual(profiles.list().map((p) => p.name), ["default", "two"]);
});

test("W-18 round 46: a profile removed between the checks and a write is not recreated; the write fails", async () => {
  newHome();
  profiles.create("racy");
  const dir = store.profileDir("racy");
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-removed-")), "racy");
  const realLstat = fs.lstatSync;
  // Each case: the profile passes its checks, then is removed (renamed away, as profile remove does)
  // just before the writer looks at the sub-folder it is about to make.
  for (const [sub, write] of [
    ["cache", () => store.home()],
    ["history", () => store.subDir("history", true)],
  ] as const) {
    let fired = false;
    (fs as any).lstatSync = (p: string, o?: any) => {
      if (!fired && p === path.join(dir, sub)) {
        fired = true;
        fs.renameSync(dir, outside);
      }
      return realLstat(p, o);
    };
    try {
      await as("racy", () => assert.throws(write, /profile "racy" does not exist/));
    } finally {
      (fs as any).lstatSync = realLstat;
    }
    assert.ok(fired, sub);
    assert.equal(fs.existsSync(dir), false, `${sub}: the removed profile was brought back`);
    fs.renameSync(outside, dir); // put it back for the next case
    fs.rmSync(path.join(dir, sub), { recursive: true, force: true });
  }
});

test("W-18 round 46: the legacy cooldown store is not read through a root cache/ that is a link", async () => {
  const home = newHome();
  profiles.create("p");
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-linked-cache-"));
  fs.writeFileSync(path.join(target, store.sha256("cooldowns") + ".json"), JSON.stringify({ "https://legacy.example": Date.now() + 3_600_000 }));
  fs.symlinkSync(target, path.join(home, "cache"));
  const { cooldownLeft } = await import("../cooldown.js");
  assert.equal(await as("p", () => cooldownLeft("https://legacy.example")), 0);
  // A real root cache/ is still read (the legacy store is shared).
  fs.unlinkSync(path.join(home, "cache"));
  fs.mkdirSync(path.join(home, "cache"), { mode: 0o700 });
  fs.copyFileSync(path.join(target, store.sha256("cooldowns") + ".json"), path.join(home, "cache", store.sha256("cooldowns") + ".json"));
  assert.ok((await as("p", () => cooldownLeft("https://legacy.example"))) > 0);
});

// ---- Codex round 47 ----

// Runs `during` once, right before the first rename of the profile folder to .removing-*.
function onRename(during: (from: string, to: string) => void, afterRename?: (from: string, to: string) => void) {
  const real = fs.renameSync;
  let fired = false;
  (fs as any).renameSync = (from: string, to: string) => {
    if (fired || !path.basename(String(to)).startsWith(".removing-")) return real(from, to);
    fired = true;
    during(from, to);
    real(from, to);
    afterRename?.(from, to);
  };
  return () => ((fs as any).renameSync = real);
}
const plantKey = (dir: string) => {
  fs.mkdirSync(path.join(dir, "keys"), { mode: 0o700, recursive: true });
  fs.writeFileSync(path.join(dir, "keys", keys.KEY_FILE), '{"planted":true}\n', { mode: 0o600 });
};

test("W-18 round 47: a key that appears between the first check and the rename is never deleted without --delete-key", async () => {
  newHome();
  profiles.create("late-key");
  const dir = store.profileDir("late-key");
  const undo = onRename(() => plantKey(dir)); // another process runs keys init at the worst moment
  try {
    assert.throws(() => profiles.remove("late-key", { yes: true }), /has a signing key.*Nothing was removed/);
  } finally {
    undo();
  }
  assert.equal(fs.readFileSync(path.join(dir, "keys", keys.KEY_FILE), "utf8"), '{"planted":true}\n', "renamed back, key intact");
  assert.deepEqual(profiles.leftovers(), []);
  assert.equal(profiles.remove("late-key", { yes: true, deleteKey: true }).key_deleted, true);
});

test("W-18 round 47: a refused profile whose name was taken meanwhile is left whole, and later removals never delete it", async () => {
  const home = newHome();
  profiles.create("taken");
  profiles.create("other");
  const dir = store.profileDir("taken");
  // Another process recreates the name (with a key) between the check and the rename; ours gets the
  // recreated one, and by the time it would rename back, the name is taken again.
  const undo = onRename(() => plantKey(dir), () => fs.mkdirSync(dir, { mode: 0o700 }));
  let msg = "";
  try {
    profiles.remove("taken", { yes: true });
  } catch (e) {
    msg = (e as Error).message;
  } finally {
    undo();
  }
  assert.match(msg, /has a signing key.*Nothing was removed.*was taken.*\.removing-[0-9a-f]{16}.*mv /);
  const [left] = profiles.leftovers();
  assert.ok(left);
  assert.ok(msg.includes(path.join(home, "profiles", left)));
  assert.ok(fs.existsSync(path.join(home, "profiles", left, "keys", keys.KEY_FILE)));
  const r = profiles.remove("other", { yes: true });
  assert.equal(r.leftovers_finished, 0);
  assert.match(r.message, /still hold a signing key untouched/);
  assert.ok(fs.existsSync(path.join(home, "profiles", left, "keys", keys.KEY_FILE)), "the key survives later removals");
});

test("W-18 round 47: profile remove finishes leftovers first, even when the named profile does not exist", async () => {
  const home = newHome();
  profiles.create("last");
  const left = path.join(home, "profiles", ".removing-fedcba9876543210");
  fs.mkdirSync(path.join(left, "history"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(left, "history", "2026-10-17.jsonl"), "{}\n");
  fs.renameSync(store.profileDir("last"), path.join(home, "profiles", ".removing-0000000000000001")); // interrupted removal of the last profile
  assert.throws(() => profiles.remove("last", { yes: true }), /profile "last" does not exist.*Finished 2 earlier removal/);
  assert.deepEqual(profiles.leftovers(), []);
});
