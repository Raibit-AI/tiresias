// SPDX-License-Identifier: Apache-2.0
// v1.1 workstream 4: `keys rotate` for the signing key (overlap window) and `keys rotate --slips` for the slip key.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import nodeCrypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { verifierFromJWK } from "web-bot-auth/crypto";
import { freshHome } from "./helper.js";

freshHome();
delete process.env.TIRESIAS_PRIVATE;
const keys = await import("../keys.js");
const slips = await import("../slips.js");
const saved = await import("../saved.js");
const history = await import("../history.js");

const DAY = 86_400_000;
const CLI = path.resolve("dist/cli.js");
const cli = (dir: string, ...a: string[]) => spawnSync(process.execPath, [CLI, ...a], { encoding: "utf8", env: { ...process.env, TIRESIAS_HOME: dir } });
const keyFile = (dir: string, name: string) => path.join(dir, "keys", name);
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8")) as { x: string; d: string; until?: string };
const keyidOf = async (x: string) => (await verifierFromJWK({ kty: "OKP", crv: "Ed25519", x })).keyid;

// Every private value present in the keys folder (signing, previous and slip keys), for the "never printed" checks.
const secrets = (dir: string): string[] =>
  fs.readdirSync(path.join(dir, "keys")).filter((n) => n.endsWith(".jwk")).map((n) => readJson(path.join(dir, "keys", n)).d);
const noSecrets = (dir: string, text: string, also: string[] = []) => {
  for (const d of [...secrets(dir), ...also]) assert.ok(!text.includes(d), "no private key bytes in the output");
};

function verifyDirectorySig(headers: Record<string, string>, label: string, host: string, x: string, nowSec: number): boolean {
  const input = new RegExp(`(?:^|, )${label}=(\\("@authority";req\\)[^,]*)`).exec(headers["Signature-Input"])?.[1];
  const sig = new RegExp(`(?:^|, )${label}=:([^:]+):`).exec(headers["Signature"])?.[1];
  if (!input || !sig) return false;
  const expires = Number(/expires=(\d+)/.exec(input)![1]);
  if (nowSec >= expires) return false;
  const base = `"@authority";req: ${host}\n"@signature-params": ${input}`;
  const pub = nodeCrypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
  return nodeCrypto.verify(null, Buffer.from(base), pub, Buffer.from(sig, "base64"));
}

test("rotate: both keys published during the overlap, new key signs requests, one directory signature per key", async () => {
  const dir = freshHome();
  const first = await keys.initKey();
  const oldX = readJson(keyFile(dir, keys.KEY_FILE)).x;
  const oldD = readJson(keyFile(dir, keys.KEY_FILE)).d;
  const t0 = Date.now();
  const r = await keys.rotateKey({ now: t0 });
  assert.equal(r.previous_keyid, first.keyid);
  assert.notEqual(r.keyid, first.keyid);
  assert.equal(r.overlap_days, 7);
  assert.equal(r.overlap_until, new Date(t0 + 7 * DAY).toISOString());
  const newX = readJson(keyFile(dir, keys.KEY_FILE)).x;
  assert.notEqual(newX, oldX);
  // the signer reads only the current key file: new requests use the new key
  assert.equal(keys.readPrivateJwk()!.x, newX);
  // the previous file keeps the old key (for the directory signature only) with its window
  const prev = readJson(keyFile(dir, keys.PREVIOUS_KEY_FILE));
  assert.equal(prev.x, oldX);
  assert.equal(prev.until, r.overlap_until);
  // show / directory publish both, new first
  const pub = await keys.publishedKeys(t0 + 1000);
  assert.deepEqual(pub.info.directory.keys.map((k) => k.x), [newX, oldX]);
  assert.equal(pub.previous?.keyid, first.keyid);
  // sign-directory: one signature per key, both verify, capped at the window's end
  const sd = await keys.signDirectory({ host: "raibit.example", days: 30, now: t0 + 1000 });
  assert.deepEqual(JSON.parse(sd.body).keys.map((k: { x: string }) => k.x), [newX, oldX]);
  const sec = Math.floor((t0 + 2000) / 1000);
  assert.ok(verifyDirectorySig(sd.headers, "sig1", "raibit.example", newX, sec), "the new key's signature verifies");
  assert.ok(verifyDirectorySig(sd.headers, "sig2", "raibit.example", oldX, sec), "the old key's signature verifies");
  assert.ok(!verifyDirectorySig(sd.headers, "sig2", "raibit.example", newX, sec), "each signature is by its own key");
  assert.match(sd.headers["Signature-Input"], new RegExp(`sig1=.*keyid="${r.keyid}".*, sig2=.*keyid="${first.keyid}"`));
  assert.equal(sd.expires_at, new Date(Math.floor(Date.parse(r.overlap_until!) / 1000) * 1000).toISOString());
  assert.equal(sd.capped_by_rotation, r.overlap_until);
  noSecrets(dir, JSON.stringify(sd) + JSON.stringify(r) + JSON.stringify(pub.info), [oldD]);
  // the CLI shows both and says so
  const show = cli(dir, "keys", "show");
  assert.equal(show.status, 0, show.stderr);
  const shown = JSON.parse(show.stdout);
  assert.equal(shown.directory.keys.length, 2);
  assert.equal(shown.rotation.previous_keyid, first.keyid);
  const d2 = cli(dir, "keys", "directory");
  assert.deepEqual(JSON.parse(d2.stdout).keys.map((k: { x: string }) => k.x), [newX, oldX]);
  const sdCli = cli(dir, "keys", "sign-directory", "--host", "raibit.example");
  assert.equal(sdCli.status, 0, sdCli.stderr);
  assert.match(JSON.parse(sdCli.stdout).reminder, /previous key leaves the directory/);
  noSecrets(dir, show.stdout + show.stderr + d2.stdout + sdCli.stdout + sdCli.stderr, [oldD]);
});

test("rotate: the old key drops out by itself after the window, and its private file is deleted", async () => {
  const dir = freshHome();
  await keys.initKey();
  const t0 = Date.now();
  const r = await keys.rotateKey({ now: t0, overlapDays: 2 });
  const newX = keys.readPrivateJwk()!.x;
  assert.equal((await keys.publishedKeys(t0 + 2 * DAY - 1000)).info.directory.keys.length, 2, "still inside the window");
  const after = await keys.publishedKeys(t0 + 2 * DAY);
  assert.deepEqual(after.info.directory.keys.map((k) => k.x), [newX]);
  assert.equal(after.previous, null);
  assert.ok(!fs.existsSync(keyFile(dir, keys.PREVIOUS_KEY_FILE)), "the old private key is gone");
  const sd = await keys.signDirectory({ host: "a.example", days: 5, now: t0 + 2 * DAY + 1000 });
  assert.equal(JSON.parse(sd.body).keys.length, 1);
  assert.doesNotMatch(sd.headers.Signature, /sig2/);
  assert.equal(sd.capped_by_rotation, undefined);
  assert.equal(r.overlap_days, 2);
  // a second rotation is fine once the window is over
  await keys.rotateKey({ now: t0 + 3 * DAY });
});

test("rotate --finish drops the old key now; --overlap 0 keeps nothing; bounds", async () => {
  const dir = freshHome();
  await keys.initKey();
  const r = await keys.rotateKey();
  const f = await keys.finishRotation();
  assert.deepEqual(f, { finished: true, previous_keyid: r.previous_keyid });
  assert.ok(!fs.existsSync(keyFile(dir, keys.PREVIOUS_KEY_FILE)));
  assert.equal((await keys.publishedKeys()).info.directory.keys.length, 1);
  assert.deepEqual(await keys.finishRotation(), { finished: false });
  // --overlap 0: the old key is gone at once
  const z = await keys.rotateKey({ overlapDays: 0 });
  assert.equal(z.overlap_until, null);
  assert.ok(!fs.existsSync(keyFile(dir, keys.PREVIOUS_KEY_FILE)));
  assert.equal(z.directory.keys.length, 1);
  // bounds, through the parser and the function
  assert.equal(keys.parseOverlap(undefined), 7);
  assert.equal(keys.parseOverlap("0"), 0);
  assert.equal(keys.parseOverlap("30"), 30);
  for (const bad of ["31", "-1", "1.5", "x", "", "7d"]) assert.throws(() => keys.parseOverlap(bad), /0 to 30/);
  for (const bad of [31, -1, 1.5, NaN]) await assert.rejects(() => keys.rotateKey({ overlapDays: bad }), /0 to 30/);
  // the CLI: --finish, a bad --overlap, and history records
  await keys.rotateKey();
  const fin = cli(dir, "keys", "rotate", "--finish");
  assert.equal(fin.status, 0, fin.stderr);
  assert.equal(JSON.parse(fin.stdout).finished, true);
  const bad = cli(dir, "keys", "rotate", "--overlap", "45");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /0 to 30/);
  const rot = cli(dir, "keys", "rotate", "--overlap", "3");
  assert.equal(rot.status, 0, rot.stderr);
  const out = JSON.parse(rot.stdout);
  assert.equal(out.overlap_days, 3);
  assert.match(out.next, /not printed/);
  noSecrets(dir, fin.stdout + fin.stderr + rot.stdout + rot.stderr);
  const events = (await history.query({})).items.map((e) => e.event).filter(Boolean);
  assert.ok(events.includes("signing_key_rotated") && events.includes("signing_key_rotation_finished"), JSON.stringify(events));
});

test("rotate twice inside the window is refused (no silent loss); a cut-short leftover is cleaned up", async () => {
  const dir = freshHome();
  await keys.initKey();
  const r = await keys.rotateKey();
  const before = fs.readFileSync(keyFile(dir, keys.KEY_FILE), "utf8");
  const prevBefore = fs.readFileSync(keyFile(dir, keys.PREVIOUS_KEY_FILE), "utf8");
  await assert.rejects(() => keys.rotateKey(), (e: Error) => e.message.includes("overlap window") && e.message.includes(r.previous_keyid) && /--finish/.test(e.message));
  assert.equal(fs.readFileSync(keyFile(dir, keys.KEY_FILE), "utf8"), before, "current key untouched");
  assert.equal(fs.readFileSync(keyFile(dir, keys.PREVIOUS_KEY_FILE), "utf8"), prevBefore, "previous key untouched");
  const twice = cli(dir, "keys", "rotate");
  assert.notEqual(twice.status, 0);
  assert.match(twice.stderr, /Nothing was changed/);
  // a rotation cut short after the previous file was written but before the new key replaced the current one:
  // the previous file then holds the current key. It is not published twice, and rotating again works.
  await keys.finishRotation();
  const cur = readJson(keyFile(dir, keys.KEY_FILE));
  fs.writeFileSync(keyFile(dir, keys.PREVIOUS_KEY_FILE), JSON.stringify({ ...cur, kty: "OKP", crv: "Ed25519", rotated_at: new Date().toISOString(), until: new Date(Date.now() + DAY).toISOString() }), { mode: 0o600 });
  assert.equal((await keys.publishedKeys()).info.directory.keys.length, 1);
  assert.ok(!fs.existsSync(keyFile(dir, keys.PREVIOUS_KEY_FILE)), "the leftover was removed");
  await keys.rotateKey();
  // keys init --force is a fresh start: no previous key is left in the directory
  await keys.initKey(true);
  assert.ok(!fs.existsSync(keyFile(dir, keys.PREVIOUS_KEY_FILE)));
  assert.equal((await keys.publishedKeys()).info.directory.keys.length, 1);
});

test("rotate: file modes, atomic write (no temp files left), no key, private mode, damaged previous key", async () => {
  const dir = freshHome();
  await assert.rejects(() => keys.rotateKey(), /No signing key yet/);
  await keys.initKey();
  fs.chmodSync(path.join(dir, "keys"), 0o755); // a looser folder is tightened again
  await keys.rotateKey();
  assert.equal(fs.statSync(path.join(dir, "keys")).mode & 0o777, 0o700);
  for (const n of [keys.KEY_FILE, keys.PREVIOUS_KEY_FILE]) assert.equal(fs.statSync(keyFile(dir, n)).mode & 0o777, 0o600, n);
  assert.deepEqual(fs.readdirSync(path.join(dir, "keys")).filter((n) => n.endsWith(".tmp")), [], "no temp file left behind");
  // atomic: the key file is replaced by rename (a new inode), never rewritten in place
  await keys.finishRotation();
  const ino = fs.statSync(keyFile(dir, keys.KEY_FILE)).ino;
  await keys.rotateKey({ overlapDays: 0 });
  assert.notEqual(fs.statSync(keyFile(dir, keys.KEY_FILE)).ino, ino);
  // a damaged previous key is reported, and --finish is the fix
  await keys.rotateKey();
  fs.writeFileSync(keyFile(dir, keys.PREVIOUS_KEY_FILE), "{not json", { mode: 0o600 });
  await assert.rejects(() => keys.publishedKeys(), /previous signing key file is damaged.*--finish/);
  assert.equal((await keys.finishRotation()).finished, true);
  assert.equal((await keys.publishedKeys()).info.directory.keys.length, 1);
  // a previous key readable by others is refused like the signing key
  await keys.rotateKey();
  fs.chmodSync(keyFile(dir, keys.PREVIOUS_KEY_FILE), 0o644);
  await assert.rejects(() => keys.publishedKeys(), /can be read by other users/);
  await keys.finishRotation();
  // private mode changes nothing
  const r = cli(dir, "keys", "rotate", "--private");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Private mode/);
  process.env.TIRESIAS_PRIVATE = "1";
  try {
    await assert.rejects(() => keys.rotateKey(), /Private mode/);
    assert.throws(() => slips.rotateSlipKey(slips.ROTATE_SLIP_PHRASE), /Private mode/);
  } finally {
    delete process.env.TIRESIAS_PRIVATE;
  }
});

test("rotate refuses a synced folder and changes nothing there", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tir-rot-sync-"));
  try {
    const store = path.join(root, "OneDrive", "store");
    fs.mkdirSync(store, { recursive: true });
    process.env.TIRESIAS_HOME = store;
    // a key that got there some other way (made before the folder was synced)
    fs.mkdirSync(path.join(store, "keys"), { mode: 0o700 });
    const { privateKey } = nodeCrypto.generateKeyPairSync("ed25519");
    const j = privateKey.export({ format: "jwk" });
    fs.writeFileSync(path.join(store, "keys", keys.KEY_FILE), JSON.stringify({ kty: "OKP", crv: "Ed25519", x: j.x, d: j.d }), { mode: 0o600 });
    const before = fs.readFileSync(path.join(store, "keys", keys.KEY_FILE), "utf8");
    await assert.rejects(() => keys.rotateKey(), /synced folder/);
    assert.equal(fs.readFileSync(path.join(store, "keys", keys.KEY_FILE), "utf8"), before);
    assert.deepEqual(fs.readdirSync(path.join(store, "keys")), [keys.KEY_FILE]);
    fs.writeFileSync(path.join(store, "keys", keys.SLIP_KEY_FILE), JSON.stringify({ kty: "OKP", crv: "Ed25519", x: j.x, d: j.d }), { mode: 0o600 });
    assert.throws(() => keys.replaceSlipKey(), /synced folder/);
    assert.deepEqual(fs.readdirSync(path.join(store, "keys")).sort(), [keys.KEY_FILE, keys.SLIP_KEY_FILE].sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    freshHome();
  }
});

test("slip key rotation: needs the phrase, revokes every slip, keeps saved pages checkable, is logged", async () => {
  const dir = freshHome();
  assert.throws(() => slips.rotateSlipKey(slips.ROTATE_SLIP_PHRASE), /no slip key yet/);
  const site = "https://forms.example";
  const a = slips.grant({ action: "submit_form", site });
  slips.grant({ action: "submit_form", site, uses: "3" });
  const url = "https://saved.example/page";
  const snap = saved.saveSnapshot({ url, source_url: url, final_url: url, status: 200, content_type: "text/html", read_as: "html", file_flags: [], language_header: null, received: Buffer.from("<html><body><p>Kept words.</p></body></html>") }, [{ url, quote: "Kept words.", section: 1, fetched_at: new Date().toISOString() }]);
  assert.equal(snap.status, "saved");
  assert.equal((await saved.verify(snap.id!)).signature, "ok");
  const oldSlipKey = readJson(keyFile(dir, keys.SLIP_KEY_FILE));
  assert.ok("slip_id" in slips.checkSlip("submit_form", site + "/contact"));
  // without the exact phrase nothing changes
  for (const bad of [undefined, "yes, rotate the slip key", "YES ROTATE THE SLIP KEY"]) assert.throws(() => slips.rotateSlipKey(bad), /exact confirmation "YES, ROTATE THE SLIP KEY"/);
  assert.equal(readJson(keyFile(dir, keys.SLIP_KEY_FILE)).d, oldSlipKey.d);
  assert.equal(slips.list().counts.active, 2);
  // the CLI refuses without the phrase, and with it but no person at a terminal
  const noPhrase = cli(dir, "keys", "rotate", "--slips");
  assert.notEqual(noPhrase.status, 0);
  assert.match(noPhrase.stderr, /YES, ROTATE THE SLIP KEY/);
  const noPerson = cli(dir, "keys", "rotate", "--slips", "--confirm", slips.ROTATE_SLIP_PHRASE);
  assert.notEqual(noPerson.status, 0);
  assert.match(noPerson.stderr, /needs a person at a terminal/);
  assert.equal(readJson(keyFile(dir, keys.SLIP_KEY_FILE)).d, oldSlipKey.d, "still the old key");
  // with the phrase: every slip revoked, a new key, the old public half retired
  const r = slips.rotateSlipKey(slips.ROTATE_SLIP_PHRASE);
  assert.equal(r.revoked, 2);
  assert.equal(r.retired, true);
  const newSlipKey = readJson(keyFile(dir, keys.SLIP_KEY_FILE));
  assert.notEqual(newSlipKey.d, oldSlipKey.d);
  assert.equal(fs.statSync(keyFile(dir, keys.SLIP_KEY_FILE)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(keyFile(dir, keys.SLIP_RETIRED_FILE)).mode & 0o777, 0o600);
  const retired = fs.readFileSync(keyFile(dir, keys.SLIP_RETIRED_FILE), "utf8");
  assert.ok(retired.includes(oldSlipKey.x) && !retired.includes(oldSlipKey.d), "only the public half is kept");
  assert.equal(slips.list().counts.active, 0);
  const refused = slips.checkSlip("submit_form", site + "/contact");
  assert.ok(!("slip_id" in refused), "no old slip can be used");
  assert.throws(() => slips.revoke(a.id), /no slip with that id/, "already revoked");
  // a new slip works with the new key
  slips.grant({ action: "submit_form", site });
  assert.ok("slip_id" in slips.checkSlip("submit_form", site + "/contact"));
  // the old snapshot still verifies, and says it was signed by the retired key
  const v = await saved.verify(snap.id!);
  assert.equal(v.ok, true, v.message);
  assert.equal(v.signature, "retired_key");
  assert.ok(v.retired_key_at && v.message.includes(v.retired_key_at));
  // a new snapshot is signed with the new key
  const snap2 = saved.saveSnapshot({ url, source_url: url, final_url: url, status: 200, content_type: "text/html", read_as: "html", file_flags: [], language_header: null, received: Buffer.from("<html><body><p>New words.</p></body></html>") }, []);
  assert.equal((await saved.verify(snap2.id!)).signature, "ok");
  // logged
  const rec = (await history.query({})).items.find((e) => e.event === "slip_key_rotated");
  assert.equal(rec?.tool, "keys");
  assert.equal(rec?.revoked, 2);
  // a second rotation keeps both retired halves, so the first snapshot still verifies
  slips.rotateSlipKey(slips.ROTATE_SLIP_PHRASE);
  assert.equal(JSON.parse(fs.readFileSync(keyFile(dir, keys.SLIP_RETIRED_FILE), "utf8")).keys.length, 2);
  assert.equal((await saved.verify(snap.id!)).signature, "retired_key");
  assert.equal((await saved.verify(snap2.id!)).signature, "retired_key");
  assert.deepEqual(fs.readdirSync(path.join(dir, "keys")).filter((n) => n.endsWith(".tmp")), []);
  noSecrets(dir, JSON.stringify(r) + JSON.stringify(v) + noPhrase.stdout + noPhrase.stderr + noPerson.stdout + noPerson.stderr, [oldSlipKey.d]);
});

test("slip key rotation replaces an unreadable key (the fix for a damaged or exposed one)", () => {
  const dir = freshHome();
  slips.grant({ action: "submit_form", site: "https://forms.example" });
  fs.chmodSync(keyFile(dir, keys.SLIP_KEY_FILE), 0o644); // exposed: readable by others
  assert.throws(() => slips.list(), /can be read by other users/);
  const r = slips.rotateSlipKey(slips.ROTATE_SLIP_PHRASE);
  assert.equal(r.revoked, 1);
  assert.equal(r.retired, false, "an unreadable key is not kept, not even its public half");
  assert.equal(fs.statSync(keyFile(dir, keys.SLIP_KEY_FILE)).mode & 0o777, 0o600);
  assert.equal(slips.list().counts.active, 0);
});

test("keys help lists rotate; daily log names a rotation", async () => {
  const dir = freshHome();
  const h = cli(dir, "keys", "--help");
  assert.match(h.stdout, /keys rotate \[--overlap 7\]/);
  assert.match(h.stdout, /keys rotate --finish/);
  assert.match(h.stdout, /YES, ROTATE THE SLIP KEY/);
  assert.match(h.stdout, /--overlap, --finish, --slips, --confirm/);
  assert.doesNotMatch(h.stdout, /\u2014/, "no em-dashes");
  await keys.initKey();
  const rot = cli(dir, "keys", "rotate");
  assert.equal(rot.status, 0, rot.stderr);
  const log = cli(dir, "log");
  assert.match(log.stdout, /signing key rotated/);
});

// ---- compute-day sweep 2026-11-06: Codex K.1 to K.6 ----
const savedlock = await import("../savedlock.js");
const signing = await import("../signing.js");

test("K.6: an actual signed request uses the new key after rotation (no cached old signer)", async () => {
  const dir = freshHome();
  const first = await keys.initKey();
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ signature_agent: "https://agent.example" }));
  const before = await signing.signingHeaders(new URL("https://site.example/"));
  assert.match(before!["signature-input"], new RegExp(`keyid="${first.keyid}"`), "signs with the first key (and caches its signer)");
  const r = await keys.rotateKey();
  const after = await signing.signingHeaders(new URL("https://site.example/"));
  assert.match(after!["signature-input"], new RegExp(`keyid="${r.keyid}"`), "signs with the new key");
  assert.doesNotMatch(after!["signature-input"], new RegExp(`keyid="${first.keyid}"`), "never with the old one");
});

test("K.1: a keys show holding a stale current key never deletes the kept previous key; a busy lock deletes nothing", async () => {
  const dir = freshHome();
  await keys.initKey();
  const oldX = keys.readPrivateJwk()!.x;
  await keys.rotateKey();
  // the race: show read the current key (old) just before the rotation, then looks at the previous file
  const p = await keys.previousKey(Date.now(), { x: oldX });
  assert.equal(p?.jwk.x, oldX, "still published as the previous key");
  assert.ok(fs.existsSync(keyFile(dir, keys.PREVIOUS_KEY_FILE)), "and kept on disk");
  await assert.rejects(() => keys.rotateKey(), /overlap window/, "a second rotation is still refused");
  // a genuine leftover (previous == current) while a rotation holds the lock: not published, not deleted
  await keys.finishRotation();
  const cur = readJson(keyFile(dir, keys.KEY_FILE));
  fs.writeFileSync(keyFile(dir, keys.PREVIOUS_KEY_FILE), JSON.stringify({ ...cur, kty: "OKP", crv: "Ed25519", rotated_at: new Date().toISOString(), until: new Date(Date.now() + DAY).toISOString() }), { mode: 0o600 });
  const lock = path.join(dir, "keys", keys.ROTATE_LOCK);
  const token = savedlock.takeLock(lock)!;
  assert.ok(token);
  try {
    assert.equal((await keys.publishedKeys()).info.directory.keys.length, 1);
    assert.ok(fs.existsSync(keyFile(dir, keys.PREVIOUS_KEY_FILE)), "nothing deleted while a rotation is running");
    await assert.rejects(() => keys.rotateKey(), /under way/);
    await assert.rejects(() => keys.finishRotation(), /under way/);
  } finally {
    savedlock.releaseLock(lock, token);
  }
  assert.equal((await keys.publishedKeys()).info.directory.keys.length, 1);
  assert.ok(!fs.existsSync(keyFile(dir, keys.PREVIOUS_KEY_FILE)), "cleaned up once the lock is free");
});

test("K.2: a previous-key temp copy left by a killed rotation is swept by --finish, rotate and window expiry", async () => {
  const dir = freshHome();
  await keys.initKey();
  const leftover = () => {
    const f = keyFile(dir, `${keys.PREVIOUS_KEY_FILE}.${nodeCrypto.randomBytes(8).toString("hex")}.tmp`);
    fs.writeFileSync(f, fs.readFileSync(keyFile(dir, keys.KEY_FILE)), { mode: 0o600 });
    return f;
  };
  const tmps = () => fs.readdirSync(path.join(dir, "keys")).filter((n) => n.endsWith(".tmp"));
  // --finish
  await keys.rotateKey();
  leftover();
  await keys.finishRotation();
  assert.deepEqual(tmps(), []);
  // --finish with no previous key at all
  leftover();
  assert.deepEqual(await keys.finishRotation(), { finished: false });
  assert.deepEqual(tmps(), []);
  // rotate
  leftover();
  const t0 = Date.now();
  await keys.rotateKey({ now: t0, overlapDays: 1 });
  assert.deepEqual(tmps(), []);
  // window expiry
  leftover();
  assert.equal((await keys.publishedKeys(t0 + 2 * DAY)).previous, null);
  assert.ok(!fs.existsSync(keyFile(dir, keys.PREVIOUS_KEY_FILE)));
  assert.deepEqual(tmps(), []);
});

test("K.4: a refused slip rotation (synced folder, another rotation running) revokes nothing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tir-rot-k4-"));
  try {
    const plainStore = path.join(root, "plain", "store");
    fs.mkdirSync(plainStore, { recursive: true });
    process.env.TIRESIAS_HOME = plainStore;
    const site = "https://forms.example";
    slips.grant({ action: "submit_form", site });
    slips.grant({ action: "submit_form", site });
    const slipFiles = () => fs.readdirSync(path.join(process.env.TIRESIAS_HOME!, "slips")).filter((n) => n.endsWith(".json")).sort();
    const had = slipFiles();
    assert.equal(had.length, 2);
    // another slip rotation holds the lock
    const lock = path.join(plainStore, "keys", keys.SLIP_ROTATE_LOCK);
    const token = savedlock.takeLock(lock)!;
    try {
      assert.throws(() => slips.rotateSlipKey(slips.ROTATE_SLIP_PHRASE), /under way/);
    } finally {
      savedlock.releaseLock(lock, token);
    }
    assert.deepEqual(slipFiles(), had, "slips kept");
    assert.equal(slips.list().counts.active, 2);
    // the store moved into OneDrive
    fs.renameSync(path.join(root, "plain"), path.join(root, "OneDrive"));
    process.env.TIRESIAS_HOME = path.join(root, "OneDrive", "store");
    const keyBefore = fs.readFileSync(path.join(process.env.TIRESIAS_HOME, "keys", keys.SLIP_KEY_FILE), "utf8");
    assert.throws(() => slips.rotateSlipKey(slips.ROTATE_SLIP_PHRASE), /synced folder/);
    assert.deepEqual(slipFiles(), had, "slips kept");
    assert.equal(fs.readFileSync(path.join(process.env.TIRESIAS_HOME, "keys", keys.SLIP_KEY_FILE), "utf8"), keyBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    freshHome();
  }
});

test("K.3: slip rotation rechecks that the key it retires is still the current one", () => {
  const dir = freshHome();
  slips.grant({ action: "submit_form", site: "https://forms.example" });
  const before = fs.readFileSync(keyFile(dir, keys.SLIP_KEY_FILE), "utf8");
  // something replaces the slip key between the first look and the swap
  const other = fs.readFileSync(keyFile(dir, keys.SLIP_KEY_FILE), "utf8");
  const { privateKey } = nodeCrypto.generateKeyPairSync("ed25519");
  const j = privateKey.export({ format: "jwk" });
  const swapped = JSON.stringify({ kty: "OKP", crv: "Ed25519", x: j.x, d: j.d }) + "\n";
  assert.throws(() => keys.replaceSlipKey(Date.now(), () => fs.writeFileSync(keyFile(dir, keys.SLIP_KEY_FILE), swapped, { mode: 0o600 })), /changed while rotating/);
  assert.equal(fs.readFileSync(keyFile(dir, keys.SLIP_KEY_FILE), "utf8"), swapped, "the newer key is not replaced");
  assert.ok(!fs.existsSync(keyFile(dir, keys.SLIP_RETIRED_FILE)), "and nothing retired");
  assert.equal(other, before);
});

test("K.5: every retired slip key is kept past 1,000; a full list refuses the rotation and revokes nothing", () => {
  const dir = freshHome();
  slips.grant({ action: "submit_form", site: "https://forms.example" });
  const fake = (n: number) => Array.from({ length: n }, () => ({ x: nodeCrypto.randomBytes(32).toString("base64url"), retired_at: new Date().toISOString() }));
  fs.writeFileSync(keyFile(dir, keys.SLIP_RETIRED_FILE), JSON.stringify({ v: 1, keys: fake(1000) }), { mode: 0o600 });
  slips.rotateSlipKey(slips.ROTATE_SLIP_PHRASE);
  assert.equal(JSON.parse(fs.readFileSync(keyFile(dir, keys.SLIP_RETIRED_FILE), "utf8")).keys.length, 1001, "the oldest is not dropped");
  slips.grant({ action: "submit_form", site: "https://forms.example" });
  fs.writeFileSync(keyFile(dir, keys.SLIP_RETIRED_FILE), JSON.stringify({ v: 1, keys: fake(100_000) }), { mode: 0o600 });
  const keyBefore = fs.readFileSync(keyFile(dir, keys.SLIP_KEY_FILE), "utf8");
  assert.throws(() => slips.rotateSlipKey(slips.ROTATE_SLIP_PHRASE), /list of retired slip keys is full.*Nothing was changed/);
  assert.equal(fs.readFileSync(keyFile(dir, keys.SLIP_KEY_FILE), "utf8"), keyBefore);
  assert.equal(slips.list().counts.active, 1, "the slip was not revoked");
});

test("K.6: a slip signed by a retired key is refused while the slip still exists", () => {
  const dir = freshHome();
  const site = "https://forms.example";
  slips.grant({ action: "submit_form", site });
  assert.ok("slip_id" in slips.checkSlip("submit_form", site + "/contact"));
  keys.replaceSlipKey(); // the key only: the slip file stays, signed by what is now a retired key
  assert.ok(fs.existsSync(keyFile(dir, keys.SLIP_RETIRED_FILE)));
  assert.equal(fs.readdirSync(path.join(dir, "slips")).filter((n) => n.endsWith(".json")).length, 1, "the slip is still there");
  assert.ok(!("slip_id" in slips.checkSlip("submit_form", site + "/contact")), "a retired key never checks a slip");
});

test("K.8: keys init --force takes the rotation lock: refused while a rotation runs, nothing changed", async () => {
  const dir = freshHome();
  await keys.initKey();
  await keys.rotateKey();
  const before = fs.readFileSync(keyFile(dir, keys.KEY_FILE), "utf8");
  const lock = path.join(dir, "keys", keys.ROTATE_LOCK);
  const token = savedlock.takeLock(lock)!;
  assert.ok(token);
  try {
    await assert.rejects(() => keys.initKey(true), /under way/);
    assert.equal(fs.readFileSync(keyFile(dir, keys.KEY_FILE), "utf8"), before, "the key was not replaced");
    assert.ok(fs.existsSync(keyFile(dir, keys.PREVIOUS_KEY_FILE)), "the rotation's kept key was not deleted");
  } finally {
    savedlock.releaseLock(lock, token);
  }
  const r = await keys.initKey(true);
  assert.equal(r.replaced, true);
  assert.ok(!fs.existsSync(keyFile(dir, keys.PREVIOUS_KEY_FILE)), "a fresh start, once free, drops the previous key");
});

test("K.9: a lock whose pid now belongs to another process is recovered; a live owner never is, whatever the clock", () => {
  const mine = savedlock._startStamp(process.pid);
  if (!mine) {
    // No stamp available (ps or /proc denied): recovery stays conservative, a live pid is never judged dead.
    assert.equal(savedlock.dead(process.pid, "anything|x"), false);
    return;
  }
  const scope = mine.slice(0, mine.lastIndexOf("|"));
  assert.equal(savedlock.dead(process.pid, "another-host-or-container|x"), false, "a lock from another scope is never judged");
  assert.equal(savedlock.dead(process.pid, scope + "|other"), true, "same scope, same pid, different start: dead");
  assert.equal(savedlock._startStamp(process.pid), mine, "stable for the life of a process");
  assert.equal(savedlock.dead(process.pid, mine), false, "the genuine live owner is never judged dead");
  assert.equal(savedlock.dead(process.pid), false, "no stamp recorded (an older lock): alive");
  // end to end: a lock held by a live owner (stamp matches) is never taken; one whose stamp differs is recovered
  const dir = freshHome();
  fs.mkdirSync(path.join(dir, "keys"), { recursive: true, mode: 0o700 });
  const lock = path.join(dir, "keys", "x");
  const owner = `${process.pid}-${"a".repeat(24)}`;
  fs.mkdirSync(lock + ".lock", { mode: 0o700 });
  fs.writeFileSync(path.join(lock + ".lock", owner), mine + "\n");
  assert.equal(savedlock.takeLock(lock, 200), null, "a live owner's lock holds");
  fs.writeFileSync(path.join(lock + ".lock", owner), scope + "|some other process\n");
  const t = savedlock.takeLock(lock, 500);
  assert.ok(t, "the reused-pid lock was recovered");
  assert.equal(fs.readFileSync(path.join(lock + ".lock", t!), "utf8").trim(), mine, "a new lock records its owner's stamp");
  savedlock.releaseLock(lock, t!);
});

test("directory retries when a rotation changes the current key after its first read", async (t) => {
  const dir = freshHome();
  await keys.initKey();
  const old = readJson(keyFile(dir, keys.KEY_FILE));
  const next = nodeCrypto.generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const open = fs.openSync;
  let rotated = false;
  t.mock.method(fs, "openSync", ((file: fs.PathLike, ...args: any[]) => {
    if (!rotated && file === keyFile(dir, keys.PREVIOUS_KEY_FILE)) {
      rotated = true;
      // Another process completed its locked rotation between the two file reads.
      fs.writeFileSync(keyFile(dir, keys.PREVIOUS_KEY_FILE), JSON.stringify({ ...old, rotated_at: new Date().toISOString(), until: new Date(Date.now() + DAY).toISOString() }), { mode: 0o600 });
      fs.writeFileSync(keyFile(dir, keys.KEY_FILE), JSON.stringify(next), { mode: 0o600 });
    }
    return (open as any)(file, ...args);
  }) as typeof fs.openSync);
  const sd = await keys.signDirectory({ host: "rotation.example", days: 7 });
  assert.ok(rotated, "the race was exercised");
  assert.deepEqual(JSON.parse(sd.body).keys.map((k: { x: string }) => k.x), [next.x, old.x]);
  const sec = Math.floor(Date.now() / 1000);
  assert.ok(verifyDirectorySig(sd.headers, "sig1", "rotation.example", next.x!, sec));
  assert.ok(verifyDirectorySig(sd.headers, "sig2", "rotation.example", old.x, sec));
});
