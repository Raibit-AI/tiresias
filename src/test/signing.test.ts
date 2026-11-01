// SPDX-License-Identifier: Apache-2.0
// N-07: Web Bot Auth signing. No live network: local servers, and the library's own verify().
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { verify } from "web-bot-auth";
import { verifierFromJWK } from "web-bot-auth/crypto";
import { freshHome, html, serve, text, type Hit, type TestServer, timing } from "./helper.js";

freshHome();
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
delete process.env.TIRESIAS_PRIVATE;
const engine = await import("../engine.js");
const keys = await import("../keys.js");
const config = await import("../config.js");
const store = await import("../store.js");

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

const AGENT = "https://raibit.example";
const setup = async (opts: { agent?: string | null; style?: string; key?: boolean } = {}) => {
  const dir = freshHome();
  const info = opts.key === false ? null : await keys.initKey();
  if (opts.agent !== null) fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ signature_agent: opts.agent ?? AGENT, ...(opts.style ? { signature_agent_style: opts.style } : {}) }));
  return { dir, info };
};
const page = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) =>
  req.url === "/robots.txt" ? text(res, "", 404) : req.url === "/llms.txt" ? text(res, "", 404) : html(res, "<html><head><title>T</title></head><body><h1>Hi</h1><p>anvils</p></body></html>");

// Verify one recorded request against our public key, for the URL it was really sent to.
async function check(base: string, hit: Hit, info: { public_jwk: JsonWebKey; keyid: string }, now = new Date()) {
  const h = new Headers();
  for (const n of ["signature", "signature-input", "signature-agent"]) if (typeof hit.headers[n] === "string") h.set(n, hit.headers[n] as string);
  const verifier = await verifierFromJWK(info.public_jwk);
  const nonces: string[] = [];
  const v = await verify(new Request(base + hit.path, { headers: h }), {
    resolver: (c) => {
      if (c.keyid !== verifier.keyid) throw new Error("unknown key");
      return verifier;
    },
    now,
    validate: ({ nonce }) => void (nonce && nonces.push(nonce)),
  });
  return { v, nonces };
}

test("every request signs and verifies: page, robots.txt and discovery probes; tag, expiry, keyid", async () => {
  const { info } = await setup();
  const s = await start(page);
  const r = await engine.read(s.url + "/", {}, { agent: "a" });
  assert.equal(r.status, "ok");
  assert.equal(r.signed, true);
  const paths = new Set(s.hits.map((h) => h.path));
  for (const want of ["/", "/robots.txt", "/llms.txt", "/openapi.json"]) assert.ok(paths.has(want), `${want} was requested`);
  const nonces = new Set<string>();
  for (const hit of s.hits) {
    assert.ok(hit.headers["signature"] && hit.headers["signature-input"] && hit.headers["signature-agent"], `${hit.path} is signed`);
    assert.equal(hit.headers["signature-agent"], `"${AGENT}"`);
    assert.match(String(hit.headers["signature-input"]), /\("@authority" "signature-agent"\)/);
    const { v, nonces: n } = await check(s.url, hit, info!);
    assert.equal(v.tag, "web-bot-auth");
    assert.equal(v.keyid, info!.keyid);
    assert.equal(v.expires.getTime() - v.created.getTime(), 60_000);
    assert.ok(Math.abs(v.created.getTime() - Date.now()) < 30_000);
    for (const x of n) nonces.add(x);
  }
  assert.equal(nonces.size, s.hits.length, "every request has its own nonce");
  assert.ok(s.hits.length >= 4);
});

test("a redirect hop is re-signed for its own authority", async () => {
  const { info } = await setup();
  const b = await start(page);
  const a = await start((req, res) => (req.url === "/robots.txt" ? text(res, "", 404) : req.url === "/go" ? (res.writeHead(302, { location: b.url + "/dest" }), res.end()) : page(req, res)));
  const r = await engine.check(a.url + "/go", { agent: "a" });
  assert.equal(r.signed, true);
  const hit = b.hits.find((h) => h.path === "/dest")!;
  assert.ok(hit, "the redirect was followed");
  await check(b.url, hit, info!); // valid for B's own authority
  await assert.rejects(() => check(a.url, hit, info!), "the same signature does not verify for A's authority");
  const first = a.hits.find((h) => h.path === "/go")!;
  assert.notEqual(first.headers["signature"], hit.headers["signature"]);
  await check(a.url, first, info!);
});

test("the dictionary style writes the current draft's header and verifies", async () => {
  const { info } = await setup({ style: "dictionary" });
  const s = await start(page);
  await engine.read(s.url + "/", {}, { agent: "a" });
  const hit = s.hits[0];
  assert.equal(hit.headers["signature-agent"], `sig1="${AGENT}";type=directory`);
  assert.match(String(hit.headers["signature-input"]), /"signature-agent";key="sig1"/);
  for (const h of s.hits) await check(s.url, h, info!);
});

test("off when not configured: no key, no signature_agent, or neither; same honest user agent; signed is false", async () => {
  for (const o of [{ key: false }, { agent: null }, { key: false, agent: null }]) {
    await setup(o);
    const s = await start(page);
    const r = await engine.read(s.url + "/", {}, { agent: "a" });
    assert.equal(r.status, "ok");
    assert.equal(r.signed, false);
    for (const h of s.hits) {
      assert.equal(h.headers["signature"], undefined);
      assert.equal(h.headers["signature-agent"], undefined);
      assert.match(String(h.headers["user-agent"]), /^Tiresias\//);
    }
  }
});

test("private mode still signs", async () => {
  const { info } = await setup();
  const s = await start(page);
  const r = await engine.read(s.url + "/", {}, { agent: "a", private: true });
  assert.equal(r.private, true);
  assert.equal(r.signed, true);
  for (const h of s.hits) await check(s.url, h, info!);
});

test("9.18: plain HTTP never signs or loads a damaged key; HTTPS still requires a valid key", async (t) => {
  const { dir } = await setup();
  const s = await start(page);
  fs.writeFileSync(path.join(dir, "keys", keys.KEY_FILE), "DAMAGED_PRIVATE_KEY", { mode: 0o600 });
  // Use a non-loopback hostname mapped only to our local server, avoiding the test-only signing exception.
  const dns = (await import("node:dns/promises")).default;
  t.mock.method(dns, "lookup", async () => [{ address: "127.0.0.1", family: 4 }]);
  const url = s.url.replace("127.0.0.1", "plain.test");
  const r = await engine.read(url + "/", {}, { agent: "a" });
  assert.equal(r.status, "ok", r.message);
  assert.equal(r.signed, false);
  assert.ok(s.hits.length > 0);
  for (const hit of s.hits) {
    assert.equal(hit.headers.signature, undefined);
    assert.equal(hit.headers["signature-input"], undefined);
    assert.equal(hit.headers["signature-agent"], undefined);
  }
  const count = s.hits.length;
  const https = await engine.read(url.replace("http:", "https:") + "/", {}, { agent: "a" });
  assert.equal(https.status, "error");
  assert.match(https.message ?? "", /signing key file is damaged/);
  assert.equal(s.hits.length, count, "the key is checked before an HTTPS request leaves");
  assert.doesNotMatch(JSON.stringify([r, https]), /DAMAGED_PRIVATE_KEY/);
});

test("a corrupt key or bad config fails the call clearly and sends nothing unsigned", async () => {
  const { dir } = await setup();
  const keyFile = path.join(dir, "keys", keys.KEY_FILE);
  const s = await start(page);
  fs.writeFileSync(keyFile, "SECRET_D_VALUE not json", { mode: 0o600 });
  let r = await engine.read(s.url + "/", {}, { agent: "a" });
  assert.equal(r.status, "error");
  assert.match(r.message ?? "", /signing key file is damaged/);
  assert.doesNotMatch(JSON.stringify(r), /SECRET_D_VALUE/);
  assert.equal(s.hits.length, 0, "nothing was sent");
  assert.equal(r.signed, undefined);
  // wrong kind of key
  fs.writeFileSync(keyFile, JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "AAAA", d: "SECRET_D_VALUE" }), { mode: 0o600 });
  r = await engine.read(s.url + "/", {}, { agent: "a" });
  assert.equal(r.status, "error");
  assert.doesNotMatch(JSON.stringify(r), /SECRET_D_VALUE/);
  assert.equal(s.hits.length, 0);
  // readable by others
  await keys.initKey(true);
  fs.chmodSync(keyFile, 0o644);
  r = await engine.read(s.url + "/", {}, { agent: "a" });
  assert.match(r.message ?? "", /can be read by other users/);
  fs.chmodSync(keyFile, 0o600);
  // a bad signature_agent, with a key present
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ signature_agent: "http://insecure.example" }));
  r = await engine.read(s.url + "/", {}, { agent: "a" });
  assert.match(r.message ?? "", /https/);
  assert.equal(s.hits.length, 0);
  // the failure is recorded in history without any key text
  const hist = fs.readdirSync(path.join(dir, "history")).map((f) => fs.readFileSync(path.join(dir, "history", f), "utf8")).join("");
  assert.doesNotMatch(hist, /SECRET_D_VALUE/);
});

test("signature_agent must be an https origin: no credentials, fragment, path or query", () => {
  for (const bad of ["http://a.example", "https://u:p@a.example", "https://a.example/#x", "https://a.example/#", "ftp://a.example", "not a url", "", 5, 'https://a.example/"x']) assert.throws(() => config.parseSignatureAgent(bad), config.ConfigError, String(bad));
  assert.equal(config.parseSignatureAgent("https://raibit.ai"), "https://raibit.ai");
  assert.equal(config.parseSignatureAgent("https://raibit.ai/"), "https://raibit.ai");
  assert.equal(config.parseSignatureAgent("https://raibit.ai:8443"), "https://raibit.ai:8443");
  for (const bad of ["https://raibit.ai/agent", "https://raibit.ai/keys/", "https://raibit.ai?x=1", "https://raibit.ai/?x=1", "https://raibit.ai/a?b"]) assert.throws(() => config.parseSignatureAgent(bad), /no path or query/, bad);
  assert.throws(() => config.parseAgentStyle("weird"), config.ConfigError);
});

test("keys init: 0600 file in a 0700 folder, never overwritten without --force, then replaced safely", async () => {
  const dir = freshHome();
  const a = await keys.initKey();
  const kd = path.join(dir, "keys");
  const kf = path.join(kd, keys.KEY_FILE);
  assert.equal(fs.statSync(kd).mode & 0o777, 0o700);
  assert.equal(fs.statSync(kf).mode & 0o777, 0o600);
  assert.equal(a.replaced, false);
  const before = fs.readFileSync(kf);
  await assert.rejects(() => keys.initKey(), /already exists/);
  assert.deepEqual(fs.readFileSync(kf), before, "the key is untouched");
  const b = await keys.initKey(true);
  assert.equal(b.replaced, true);
  assert.notEqual(b.keyid, a.keyid);
  assert.equal(fs.statSync(kf).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(kd), [keys.KEY_FILE], "no temp file is left");
  // a symlinked keys folder or key file is refused
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-out-"));
  fs.rmSync(kd, { recursive: true });
  fs.symlinkSync(outside, kd);
  await assert.rejects(() => keys.initKey(), /plain folder/);
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.rmSync(kd);
  fs.mkdirSync(kd, { mode: 0o700 });
  fs.writeFileSync(path.join(outside, "x"), "victim");
  fs.symlinkSync(path.join(outside, "x"), kf);
  await assert.rejects(() => keys.initKey(true), /not a plain file/);
  assert.equal(fs.readFileSync(path.join(outside, "x"), "utf8"), "victim");
});

test("keys init refuses a synced folder (OneDrive, Library/CloudStorage) and creates nothing there", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-sync-"));
  for (const sub of ["OneDrive/store", "onedrive - corp/store", "Library/CloudStorage/Dropbox/store", "Library/CloudStorage/x/store", "Library/Mobile Documents/com~apple~CloudDocs/store", "Dropbox/s", "Google Drive/s", "UBF8T346G9.OneDriveSyncClientSuite/OneDrive.noindex/s"]) {
    process.env.TIRESIAS_HOME = path.join(root, sub);
    await assert.rejects(() => keys.initKey(), /synced folder/);
    assert.ok(!fs.existsSync(path.join(root, sub)), `${sub} was not created`);
  }
  // an alias into a synced folder is caught too
  fs.mkdirSync(path.join(root, "OneDrive", "real"), { recursive: true });
  fs.symlinkSync(path.join(root, "OneDrive", "real"), path.join(root, "alias"));
  process.env.TIRESIAS_HOME = path.join(root, "alias", "store");
  await assert.rejects(() => keys.initKey(), /synced folder/);
  freshHome();
});

test("the private key never appears in any output, history, receipts, error, store file or log", async () => {
  const { dir, info } = await setup();
  const d = (JSON.parse(fs.readFileSync(path.join(dir, "keys", keys.KEY_FILE), "utf8")) as { d: string }).d;
  assert.ok(d.length > 20);
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.join(" "));
  const outputs: string[] = [];
  try {
    const s = await start(page);
    outputs.push(JSON.stringify(await engine.read(s.url + "/", { question: "anvils" }, { agent: "a" })));
    outputs.push(JSON.stringify(await engine.doors(s.url + "/", { agent: "a" })));
    outputs.push(JSON.stringify(await engine.check(s.url + "/", { agent: "a" })));
    outputs.push(JSON.stringify(await engine.queryHistory({})), JSON.stringify(await engine.queryReceipts({})), (await engine.dailyLog()).text);
    for (const h of s.hits) outputs.push(JSON.stringify(h.headers));
  } finally {
    console.error = orig;
  }
  outputs.push(...logged);
  for (const o of outputs) assert.ok(!o.includes(d), "the private key is in an output");
  // every other file in the store
  const walk = (p: string) =>
    fs.readdirSync(p, { withFileTypes: true }).forEach((e) => {
      const f = path.join(p, e.name);
      if (e.isDirectory()) return walk(f);
      if (f === path.join(dir, "keys", keys.KEY_FILE)) return;
      assert.ok(!fs.readFileSync(f, "utf8").includes(d), `${f} contains the private key`);
    });
  walk(dir);
  // the CLI: init, show, directory
  const run = (...a: string[]) => spawnSync(process.execPath, [path.resolve("dist/cli.js"), ...a], { env: { ...process.env, TIRESIAS_HOME: dir } });
  for (const args of [["keys", "show"], ["keys", "directory"], ["keys", "init"], ["keys", "bogus"]]) {
    const r = run(...args);
    const all = r.stdout.toString() + r.stderr.toString();
    assert.ok(!all.includes(d), `${args.join(" ")} printed the private key`);
  }
  const shown = JSON.parse(run("keys", "show").stdout.toString());
  assert.equal(shown.keyid, info!.keyid);
  assert.equal(shown.signing, "on");
  assert.deepEqual(shown.directory, { keys: [info!.public_jwk] });
  assert.equal(shown.public_jwk.d, undefined);
  assert.deepEqual(JSON.parse(run("keys", "directory").stdout.toString()), { keys: [info!.public_jwk] });
  // a fresh store has no key to show
  const empty = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "keys", "show"], { env: { ...process.env, TIRESIAS_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-nokey-")) } });
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr.toString(), /No signing key yet/);
  assert.ok(store.homeDir());
});

// ---- round 16 ----

const readKey = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "keys", keys.KEY_FILE), "utf8")) as { kty: string; crv: string; x: string; d: string };
const cli = (dir: string, ...a: string[]) => spawnSync(process.execPath, [path.resolve("dist/cli.js"), ...a], { env: { ...process.env, TIRESIAS_HOME: dir } });

test("round 16 #1: the stored x is never trusted: x = d is refused and nothing secret is printed", async () => {
  const { dir } = await setup();
  const real = readKey(dir);
  const kf = path.join(dir, "keys", keys.KEY_FILE);
  fs.writeFileSync(kf, JSON.stringify({ ...real, x: real.d }), { mode: 0o600 });
  for (const args of [["keys", "show"], ["keys", "directory"], ["keys", "sign-directory", "--host", "a.example"]]) {
    const r = cli(dir, ...args);
    assert.notEqual(r.status, 0, args.join(" "));
    assert.ok(!(r.stdout.toString() + r.stderr.toString()).includes(real.d), `${args.join(" ")} leaked the seed`);
    assert.match(r.stderr.toString(), /does not match/);
  }
  const s = await start(page);
  const res = await engine.read(s.url + "/", {}, { agent: "a" });
  assert.equal(res.status, "error");
  assert.equal(s.hits.length, 0);
  assert.ok(!JSON.stringify(res).includes(real.d));
  // a different but valid-looking x is refused too
  const other = await keys.initKey(true);
  fs.writeFileSync(kf, JSON.stringify({ ...real, x: other.public_jwk.x }), { mode: 0o600 });
  assert.notEqual(cli(dir, "keys", "show").status, 0);
  // and the shown public key is the derived one
  fs.writeFileSync(kf, JSON.stringify(real), { mode: 0o600 });
  assert.deepEqual(JSON.parse(cli(dir, "keys", "directory").stdout.toString()), { keys: [{ kty: "OKP", crv: "Ed25519", x: real.x }] });
});

test("round 16 #2: only a truly absent key means off; an unreadable key or folder fails the call", async () => {
  if (process.getuid?.() === 0) return;
  const { dir } = await setup();
  const s = await start(page);
  const kd = path.join(dir, "keys");
  fs.chmodSync(kd, 0o000); // cannot be searched: EACCES, not "absent"
  try {
    for (const priv of [false, true]) {
      const r = await engine.read(s.url + "/", {}, { agent: "a", private: priv });
      assert.equal(r.status, "error");
      assert.match(r.message ?? "", /signing key/);
      assert.equal(r.signed, undefined);
    }
    assert.equal(s.hits.length, 0, "nothing was sent unsigned");
  } finally {
    fs.chmodSync(kd, 0o700);
  }
  // keys is a plain file: ENOTDIR-like trouble is an error too
  fs.rmSync(kd, { recursive: true });
  fs.writeFileSync(kd, "x");
  const r2 = await engine.read(s.url + "/", {}, { agent: "a" });
  assert.equal(r2.status, "error");
  assert.equal(s.hits.length, 0);
  // truly absent: off, and the call works unsigned
  fs.rmSync(kd);
  const r3 = await engine.read(s.url + "/", {}, { agent: "a" });
  assert.equal(r3.status, "ok");
  assert.equal(r3.signed, false);
});

test("round 16 #3: the cached signer is re-validated on every use (chmod, swapped folder)", async () => {
  const { dir } = await setup();
  const s = await start(page);
  const kf = path.join(dir, "keys", keys.KEY_FILE);
  assert.equal((await engine.read(s.url + "/", {}, { agent: "a" })).signed, true);
  const sent = s.hits.length;
  fs.chmodSync(kf, 0o644);
  let r = await engine.check(s.url + "/", { agent: "a" });
  assert.equal(r.status, "error");
  assert.match(r.message ?? "", /read by other users/);
  assert.equal(s.hits.length, sent, "nothing was sent after the chmod");
  fs.chmodSync(kf, 0o600);
  assert.equal((await engine.check(s.url + "/", { agent: "a" })).signed, true, "fixed, and signing resumes");
  // the keys folder swapped for a link to a copy of itself
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-copy-"));
  fs.copyFileSync(kf, path.join(copy, keys.KEY_FILE));
  fs.chmodSync(path.join(copy, keys.KEY_FILE), 0o600);
  fs.rmSync(path.join(dir, "keys"), { recursive: true });
  fs.symlinkSync(copy, path.join(dir, "keys"));
  const before = s.hits.length;
  r = await engine.check(s.url + "/", { agent: "a" });
  assert.equal(r.status, "error");
  assert.match(r.message ?? "", /plain folder/);
  assert.equal(s.hits.length, before);
});

test("round 16 #4: dictionary style needs an origin too; the header names the origin only", async () => {
  const { dir } = await setup({ agent: null });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ signature_agent: "https://agent.example/keys", signature_agent_style: "dictionary" }));
  const s = await start(page);
  const r = await engine.read(s.url + "/", {}, { agent: "a" });
  assert.equal(r.status, "error");
  assert.match(r.message ?? "", /no path or query/);
  assert.equal(s.hits.length, 0);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ signature_agent: "https://agent.example/", signature_agent_style: "dictionary" }));
  await engine.read(s.url + "/", {}, { agent: "a" });
  assert.equal(s.hits[0].headers["signature-agent"], 'sig1="https://agent.example";type=directory');
});

test("round 16 #5: keys init tightens an existing keys/ folder to 0700", async () => {
  const dir = freshHome();
  fs.mkdirSync(path.join(dir, "keys"), { mode: 0o777 });
  fs.chmodSync(path.join(dir, "keys"), 0o777);
  await keys.initKey();
  assert.equal(fs.statSync(path.join(dir, "keys")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, "keys", keys.KEY_FILE)).mode & 0o777, 0o600);
});

test("round 16 #6: signed is only counted for requests actually transmitted", async (t) => {
  await setup();
  const dns = (await import("node:dns/promises")).default;
  t.mock.method(dns, "lookup", async () => { throw new Error("test DNS failure"); });
  const r = await engine.read("http://does-not-resolve.invalid/", {}, { agent: "a" });
  assert.notEqual(r.signed, true);
  assert.equal(r.signed, undefined, "nothing was sent, so there is no signed field");
  const s = await start(page);
  assert.equal((await engine.read(s.url + "/", {}, { agent: "a" })).signed, true);
});

test("round 16 #7: only real sync roots are refused; a name that merely contains OneDrive is fine", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-sync2-"));
  const lookalike = path.join(root, "-Users-x-Library-Group-Containers-UBF8T346G9-OneDriveSyncClientSuite-OneDrive-noindex-OneDrive-Desktop-Claude", "scratchpad");
  assert.equal(keys.syncedFolderReason(lookalike), null, "the scratchpad-style path is fine");
  assert.equal(keys.syncedFolderReason(path.join(root, "my-OneDrive-notes", "s")), null);
  assert.equal(keys.syncedFolderReason(path.join(root, "DropboxBackup", "s")), null);
  // true positives, including through a link
  fs.mkdirSync(path.join(root, "UBF8T346G9.OneDriveSyncClientSuite", "OneDrive.noindex", "OneDrive"), { recursive: true });
  fs.symlinkSync(path.join(root, "UBF8T346G9.OneDriveSyncClientSuite", "OneDrive.noindex", "OneDrive"), path.join(root, "vault"));
  assert.match(keys.syncedFolderReason(path.join(root, "vault", "store")) ?? "", /synced folder/);
  fs.mkdirSync(path.join(root, "Library", "CloudStorage", "Box"), { recursive: true });
  fs.symlinkSync(path.join(root, "Library", "CloudStorage", "Box"), path.join(root, "box"));
  assert.match(keys.syncedFolderReason(path.join(root, "box", "s")) ?? "", /synced folder/);
  fs.mkdirSync(path.join(root, "Library", "Mobile Documents"), { recursive: true });
  assert.match(keys.syncedFolderReason(path.join(root, "Library", "Mobile Documents", "s")) ?? "", /synced folder/);
  // the Windows-style variables
  const od = path.join(root, "winhome", "Cloud");
  fs.mkdirSync(od, { recursive: true });
  process.env.OneDriveCommercial = od;
  try {
    assert.match(keys.syncedFolderReason(path.join(od, "s")) ?? "", /synced folder/);
    assert.equal(keys.syncedFolderReason(path.join(root, "winhome", "Other")), null);
  } finally {
    delete process.env.OneDriveCommercial;
  }
  // and init really works in a lookalike folder
  process.env.TIRESIAS_HOME = lookalike;
  const info = await keys.initKey();
  assert.ok(info.keyid);
  freshHome();
});

// A native, independent check of a directory response signature (no library): rebuild the base from the headers.
function nativeVerify(headers: Record<string, string>, host: string, jwk: { x: string }, nowSec: number): boolean {
  const input = headers["Signature-Input"].replace(/^sig1=/, "");
  const created = Number(/created=(\d+)/.exec(input)![1]);
  const expires = Number(/expires=(\d+)/.exec(input)![1]);
  if (nowSec < created || nowSec >= expires) return false;
  if (!/tag="http-message-signatures-directory"/.test(input) || !input.startsWith('("@authority";req)')) return false;
  const base = `"@authority";req: ${host}\n"@signature-params": ${input}`;
  const sig = Buffer.from(/^sig1=:(.+):$/.exec(headers["Signature"])![1], "base64");
  const pub = nodeCrypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
  return nodeCrypto.verify(null, Buffer.from(base), pub, sig);
}
import nodeCrypto from "node:crypto";

test("round 16 #8: sign-directory produces a response signature that verifies for its host only, and expires", async () => {
  const { dir, info } = await setup();
  const t0 = Date.now();
  const r = await keys.signDirectory({ host: "raibit.example", days: 30, now: t0 });
  assert.equal(r.headers["Content-Type"], "application/http-message-signatures-directory+json");
  assert.deepEqual(JSON.parse(r.body), { keys: [info!.public_jwk] });
  assert.match(r.headers["Signature-Input"], new RegExp(`keyid="${info!.keyid}";alg="ed25519";expires=\\d+;nonce="[^"]+";tag="http-message-signatures-directory"$`));
  assert.equal(r.expires_at, new Date(Math.floor(t0 / 1000) * 1000 + 30 * 86_400_000).toISOString());
  const sec = Math.floor(t0 / 1000);
  assert.ok(nativeVerify(r.headers, "raibit.example", info!.public_jwk, sec + 5), "verifies for its host");
  assert.ok(!nativeVerify(r.headers, "evil.example", info!.public_jwk, sec + 5), "fails for another host");
  assert.ok(!nativeVerify(r.headers, "raibit.example", info!.public_jwk, sec + 30 * 86_400 + 1), "fails after expiry");
  const tampered = { ...r.headers, "Signature-Input": r.headers["Signature-Input"].replace("expires=", "expires=9") };
  assert.ok(!nativeVerify(tampered, "raibit.example", info!.public_jwk, sec + 5), "fails if the parameters are changed");
  // the library agrees (response signature with the request's authority)
  const lib = await import("http-message-sig");
  const verifier = await verifierFromJWK(info!.public_jwk);
  const v = await lib.verifySignature(
    { kind: "response", status: 200, fields: Object.entries(r.headers).map(([name, value]) => ({ name: name.toLowerCase(), value })), request: new Request("https://raibit.example" + r.path) },
    { policy: { algorithms: ["ed25519"], requiredComponents: [lib.component("@authority", { req: true })], requiredParameters: ["created", "expires", "keyid", "tag"], now: sec + 5 }, resolveVerifier: () => verifier },
  );
  assert.equal(v.parameters.tag, "http-message-signatures-directory");
  await assert.rejects(() =>
    lib.verifySignature(
      { kind: "response", status: 200, fields: Object.entries(r.headers).map(([name, value]) => ({ name: name.toLowerCase(), value })), request: new Request("https://evil.example" + r.path) },
      { policy: { algorithms: ["ed25519"], requiredComponents: [lib.component("@authority", { req: true })], requiredParameters: ["created"], now: sec + 5 }, resolveVerifier: () => verifier },
    ),
  );
  // validation
  for (const days of [0, 91, 1.5, NaN]) await assert.rejects(() => keys.signDirectory({ host: "a.example", days }), /1 to 90/);
  for (const host of ["https://a.example", "a.example/path", "", "a b"]) await assert.rejects(() => keys.signDirectory({ host, days: 1 }), /not a host name/);
  // the CLI: files, host from signature_agent, expiry printed, no private key
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-dirout-"));
  const run = cli(dir, "keys", "sign-directory", "--out", out);
  assert.equal(run.status, 0, run.stderr.toString());
  const printed = JSON.parse(run.stdout.toString());
  assert.equal(printed.host, "raibit.example");
  assert.match(printed.reminder, /stop working on 20\d\d-/);
  assert.ok(!(run.stdout.toString() + run.stderr.toString()).includes(readKey(dir).d));
  assert.deepEqual(fs.readdirSync(out).sort(), ["http-message-signatures-directory.headers.txt", "http-message-signatures-directory.json"]);
  const hdrs = fs.readFileSync(path.join(out, "http-message-signatures-directory.headers.txt"), "utf8");
  assert.match(hdrs, /^Content-Type: application\/http-message-signatures-directory\+json$/m);
  assert.ok(!hdrs.includes(readKey(dir).d) && !fs.readFileSync(path.join(out, "http-message-signatures-directory.json"), "utf8").includes(readKey(dir).d));
  const bad = cli(dir, "keys", "sign-directory", "--days", "100");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr.toString(), /1 to 90/);
  const stdout = JSON.parse(cli(dir, "keys", "sign-directory", "--host", "other.example", "--days", "2").stdout.toString());
  assert.equal(stdout.host, "other.example");
  assert.ok(stdout.headers.Signature);
});

test("round 17: Dropbox account folders, '..name' children, and case are judged correctly", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tir-sync-"));
  try {
    for (const name of ["Dropbox (Personal)", "Dropbox (Raibit)"]) {
      fs.mkdirSync(path.join(base, name), { recursive: true });
      assert.ok(keys.syncedFolderReason(path.join(base, name, "store")), `${name} is a sync root`);
    }
    const cloud = path.join(base, "Cloud");
    fs.mkdirSync(path.join(cloud, "..vault"), { recursive: true });
    const saved = process.env.OneDriveCommercial;
    process.env.OneDriveCommercial = cloud;
    try {
      assert.ok(keys.syncedFolderReason(path.join(cloud, "..vault")), "a child named ..vault is inside the root");
      assert.equal(keys.syncedFolderReason(path.join(base, "Elsewhere")), null);
    } finally {
      if (saved === undefined) delete process.env.OneDriveCommercial;
      else process.env.OneDriveCommercial = saved;
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("round 17: sign-directory signs the authority a verifier sees (default port and leading zeros dropped)", async () => {
  freshHome();
  await keys.initKey();
  for (const given of ["agent.example:443", "agent.example:0443", "AGENT.example"]) {
    const r = await keys.signDirectory({ host: given, days: 1 });
    assert.equal(r.host, "agent.example", given);
  }
  assert.equal((await keys.signDirectory({ host: "agent.example:8443", days: 1 })).host, "agent.example:8443");
});

test("round 18/19: containment errs toward refusing: identity, case, links and missing roots", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tir-case-"));
  const saved = process.env.OneDriveCommercial;
  try {
    const root = path.join(base, "CaseCloud");
    fs.mkdirSync(root);
    const other = path.join(base, "casecloud");
    let distinct = true;
    try {
      fs.mkdirSync(other);
    } catch {
      distinct = false; // this volume ignores case: "casecloud" IS "CaseCloud"
    }
    process.env.OneDriveCommercial = root;
    assert.ok(keys.syncedFolderReason(path.join(root, "store")), "inside the root");
    // Either way it is refused: the same folder by another spelling is inside, and a different
    // folder that differs only in case is refused too (the check errs toward refusing).
    void distinct;
    assert.ok(keys.syncedFolderReason(path.join(other, "store")));
    const missing = path.join(base, "NotYet");
    process.env.OneDriveCommercial = missing;
    assert.ok(keys.syncedFolderReason(path.join(missing, "store")), "a root that does not exist yet still counts");
    process.env.OneDriveCommercial = root;
    fs.symlinkSync(root, path.join(base, "alias"));
    assert.ok(keys.syncedFolderReason(path.join(base, "alias", "store")), "a link into the root is inside");
  } finally {
    if (saved === undefined) delete process.env.OneDriveCommercial;
    else process.env.OneDriveCommercial = saved;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("round 20: Unicode spellings of a missing root are still refused", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tir-uni-"));
  const saved = process.env.OneDriveCommercial;
  try {
    process.env.OneDriveCommercial = path.join(base, "Café");
    assert.ok(keys.syncedFolderReason(path.join(base, "Café", "store")), "composed vs decomposed");
    process.env.OneDriveCommercial = path.join(base, "ΟΣ");
    assert.ok(keys.syncedFolderReason(path.join(base, "ος", "store")), "final sigma");
  } finally {
    if (saved === undefined) delete process.env.OneDriveCommercial;
    else process.env.OneDriveCommercial = saved;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("round 21: a folder name that folds to '..' is still a folder inside the root", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tir-dots-"));
  const saved = process.env.OneDriveCommercial;
  try {
    const root = path.join(base, "Vault"); // missing on purpose: only the name test can decide
    process.env.OneDriveCommercial = root;
    for (const seg of ["．．", "‥"]) assert.ok(keys.syncedFolderReason(path.join(root, seg, "store")), JSON.stringify(seg));
    assert.equal(keys.syncedFolderReason(path.join(base, "VaultOther", "store")), null, "a sibling whose name starts the same is outside");
  } finally {
    if (saved === undefined) delete process.env.OneDriveCommercial;
    else process.env.OneDriveCommercial = saved;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("round 22: '..' after a link is applied to where the link points", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tir-link-")));
  const saved = process.env.OneDriveCommercial;
  try {
    fs.mkdirSync(path.join(base, "cloud", "child"), { recursive: true });
    fs.mkdirSync(path.join(base, "safe"));
    fs.symlinkSync(path.join(base, "cloud", "child"), path.join(base, "safe", "link"));
    process.env.OneDriveCommercial = `${base}/safe/link/../Vault`; // means cloud/Vault, which is missing (not path.join: it would collapse the "..")
    assert.ok(keys.syncedFolderReason(path.join(base, "cloud", "Vault", "store")));
  } finally {
    if (saved === undefined) delete process.env.OneDriveCommercial;
    else process.env.OneDriveCommercial = saved;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("round 23: only plain full paths are judged; relative or '..' paths are refused", () => {
  const saved = process.env.OneDriveCommercial;
  try {
    delete process.env.OneDriveCommercial;
    assert.match(keys.syncedFolderReason("relative/store") ?? "", /not a plain full path/);
    assert.match(keys.syncedFolderReason(path.join(os.tmpdir(), "a") + "/../b/store") ?? "", /not a plain full path/);
    process.env.OneDriveCommercial = "link/../Vault";
    assert.match(keys.syncedFolderReason(path.join(os.tmpdir(), "plain-store")) ?? "", /cannot judge/);
    process.env.OneDriveCommercial = path.join(os.tmpdir(), "no-such-cloud-root");
    assert.equal(keys.syncedFolderReason(path.join(os.tmpdir(), "plain-store")), null, "plain paths outside a root still pass");
  } finally {
    if (saved === undefined) delete process.env.OneDriveCommercial;
    else process.env.OneDriveCommercial = saved;
  }
});

test("round 24: on macOS and Linux a backslash is part of a folder name, not a separator", { skip: process.platform === "win32" }, () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tir-bs-")));
  const saved = process.env.OneDriveCommercial;
  try {
    const cloud = path.join(base, "cloud");
    fs.mkdirSync(cloud);
    fs.symlinkSync(cloud, path.join(base, "safe\\alias")); // one folder named "safe\alias"
    process.env.OneDriveCommercial = cloud;
    assert.ok(keys.syncedFolderReason(path.join(base, "safe\\alias", "store")));
  } finally {
    if (saved === undefined) delete process.env.OneDriveCommercial;
    else process.env.OneDriveCommercial = saved;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("round 25: a pipe planted where the key file belongs fails at once instead of hanging", { skip: process.platform === "win32", timeout: 5000 }, async () => {
  freshHome();
  await keys.initKey();
  const file = path.join(process.env.TIRESIAS_HOME!, "keys", "ed25519.private.jwk");
  fs.rmSync(file);
  const made = spawnSync("mkfifo", ["-m", "600", file]);
  assert.equal(made.status, 0, "mkfifo");
  const t0 = Date.now();
  assert.throws(() => keys.readPrivateJwk(), /signing key file/i);
  timing(Date.now() - t0 < 1000);
});
