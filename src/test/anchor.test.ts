// SPDX-License-Identifier: Apache-2.0
// W-08 (v0.8): tamper-proof receipts. Fingerprints batched under a salted Merkle root, timestamped through
// OpenTimestamps calendars (local fakes here), proven and verified offline.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Stamp } from "../ots.js";
import type { Batch, Bundle } from "../anchor.js";
import { freshHome, neverAsk, serve, text } from "./helper.js";

const home = freshHome();
// W-32 (v0.9): this file writes risky settings by hand; confirmations are tested in confirm.test.ts.
neverAsk(home);
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
delete process.env.TIRESIAS_PROFILE;
const engine = await import("../engine.js");
const anchor = await import("../anchor.js");
const ots = await import("../ots.js");
const saved = await import("../saved.js");
const settings = await import("../settings.js");
const profiles = await import("../profiles.js");
const { createServer } = await import("../mcp.js");
const ctx = { agent: "anchor-test" };
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const configFile = (dir = home) => path.join(dir, "config.json");
const config = (o: Record<string, unknown>, dir = home) => (neverAsk(dir), fs.writeFileSync(configFile(dir), JSON.stringify(o)));
const anchorFiles = (dir = home) => (fs.existsSync(path.join(dir, "anchors")) ? fs.readdirSync(path.join(dir, "anchors")).filter((n) => /^[0-9a-f]{64}\.json$/.test(n)) : []);
const tmpOut = () => fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-proof-"));

function cli(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

// A web page to read (receipts) and a snapshot to save.
const site = await serve((req, res) => {
  const u = req.url ?? "";
  if (u === "/robots.txt") return text(res, "", 404);
  if (u.startsWith("/news")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return void res.end(`<html><head><title>Town news</title></head><body><main><h1>The bridge reopens</h1><p>The old bridge over the river reopens on Monday after two years of repairs. ${u}</p></main></body></html>`);
  }
  text(res, "", 404);
});

// A fake OpenTimestamps calendar: POST /digest answers a pending timestamp naming itself; GET /timestamp/<hex>
// answers 404 until `mined`, then a path to a Bitcoin attestation at HEIGHT.
const HEIGHT = 900_123;
interface Cal {
  url: string;
  digests: Buffer[];
  gets: string[];
  mined: boolean;
  mode: "ok" | "down" | "garbage" | "foreign";
  blockRoot: Map<string, Buffer>; // pending message -> the "Merkle root" its Bitcoin attestation commits to
  close(): Promise<void>;
}
async function calendar(): Promise<Cal> {
  const cal = { digests: [] as Buffer[], gets: [] as string[], mined: false, mode: "ok", blockRoot: new Map<string, Buffer>() } as unknown as Cal;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (cal.mode === "down") return void (res.writeHead(503, { "retry-after": "0" }), res.end("down"));
      if (req.method === "POST" && req.url === "/digest") {
        cal.digests.push(body);
        if (cal.mode === "garbage") return void (res.writeHead(200, { "content-type": "application/octet-stream" }), res.end(Buffer.from([0x02, 0x00])));
        const s = ots.newStamp(body);
        const end = ots.chain(s, [{ tag: ots.APPEND, arg: Buffer.from("00112233445566778899aabbccddeeff", "hex") }, { tag: ots.SHA256 }]);
        end.atts.push(ots.pendingAtt(cal.mode === "foreign" ? "https://evil.example.com" : cal.url));
        res.writeHead(200, { "content-type": "application/vnd.opentimestamps.v1" });
        return void res.end(ots.serialize(s));
      }
      const m = /^\/timestamp\/([0-9a-f]+)$/.exec(req.url ?? "");
      if (req.method === "GET" && m) {
        cal.gets.push(m[1]);
        if (!cal.mined) return void (res.writeHead(404), res.end("Pending confirmation in Bitcoin blockchain"));
        const s = ots.newStamp(Buffer.from(m[1], "hex"));
        const end = ots.chain(s, [{ tag: ots.PREPEND, arg: Buffer.from("01020304", "hex") }, { tag: ots.SHA256 }, { tag: ots.APPEND, arg: Buffer.alloc(32, 7) }, { tag: ots.SHA256 }, { tag: ots.SHA256 }]);
        end.atts.push(ots.bitcoinAtt(HEIGHT));
        cal.blockRoot.set(m[1], end.msg);
        res.writeHead(200, { "content-type": "application/vnd.opentimestamps.v1" });
        return void res.end(ots.serialize(s));
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cal.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cal.close = () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r())));
  return cal;
}
const calA = await calendar();
const calB = await calendar();
after(async () => {
  await site.close();
  await calA.close();
  await calB.close();
});

test("W-08 format: a .ots file is byte-for-byte the OpenTimestamps format; unsupported operations and trailing bytes are refused", () => {
  assert.equal(ots.MAGIC.toString("hex"), "004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294");
  const d = Buffer.alloc(32, 0x11);
  const s = ots.newStamp(d);
  const end = ots.chain(s, [{ tag: ots.PREPEND, arg: Buffer.concat([Buffer.from([0]), Buffer.alloc(32, 0x22)]) }, { tag: ots.SHA256 }]);
  end.atts.push(ots.pendingAtt("https://x.example"));
  // Built by hand: header, version 1, sha256 file hash, digest, prepend(len 33), sha256, attestation (0x00, tag, payload).
  const expected = Buffer.concat([
    Buffer.from("004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294", "hex"), Buffer.from([0x01, 0x08]), d,
    Buffer.from([0xf1, 0x21, 0x00]), Buffer.alloc(32, 0x22), Buffer.from([0x08]),
    Buffer.from("0083dfe30d2ef90c8e", "hex"), Buffer.from([0x12, 0x11]), Buffer.from("https://x.example"),
  ]);
  const file = ots.fileBytes(d, s);
  assert.equal(file.toString("hex"), expected.toString("hex"));
  const back = ots.parseFile(file);
  assert.ok(back.digest.equals(d));
  const atts = ots.attestations(back.stamp);
  assert.deepEqual(atts.map((a) => a.att), [{ kind: "pending", uri: "https://x.example" }]);
  assert.ok(atts[0].msg.equals(createHash("sha256").update(Buffer.concat([Buffer.from([0]), Buffer.alloc(32, 0x22), d])).digest()));
  // Two items in one node: 0xff before all but the last; Bitcoin heights as varuint.
  const two = ots.newStamp(d);
  two.atts.push(ots.bitcoinAtt(300));
  ots.chain(two, [{ tag: ots.SHA256 }]).atts.push(ots.pendingAtt("https://y.example"));
  const b2 = ots.serialize(two);
  assert.equal(b2.subarray(0, 2).toString("hex"), "ff00");
  assert.deepEqual(ots.attestations(ots.parse(d, b2)).map((a) => a.att).sort((a, b) => a.kind.localeCompare(b.kind)), [{ kind: "bitcoin", height: 300 }, { kind: "pending", uri: "https://y.example" }]);
  assert.throws(() => ots.parse(d, Buffer.from([0x02, 0x00])), /unsupported operation/); // sha1 is not computed here
  assert.throws(() => ots.parse(d, Buffer.concat([b2, Buffer.from([0])])), /unexpected bytes/);
  assert.throws(() => ots.parse(d, Buffer.from([0x00, ...ots.PENDING, 0x03, 0x02, 0x22, 0x20])), /bad calendar address/);
});

test("W-08 setting: anchoring is off by default and refused; only the owner's settings turn it on; MCP has no way to anchor or change it", async () => {
  const row = settings.view().settings.find((r: any) => r.name === "anchoring");
  assert.equal(row?.value, "off");
  await assert.rejects(anchor.run(), /Anchoring is off/);
  await assert.rejects(anchor.upgrade(), /Anchoring is off/);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  const client = new Client({ name: "agent", version: "1.0.0" });
  await client.connect(b);
  const tools = (await client.listTools()).tools;
  assert.ok(!tools.some((t) => /anchor|prove|setting/.test(t.name)), "no anchor, proof or settings tool");
  for (const t of tools) for (const k of Object.keys((t.inputSchema.properties ?? {}) as object)) assert.ok(!/anchor/.test(k), `${t.name} has no anchoring parameter`);
  await client.callTool({ name: "read", arguments: { url: site.url + "/news?mcp", anchoring: "on", anchor: true } as never }).catch(() => null);
  assert.equal(fs.existsSync(configFile()), false, "nothing wrote config.json");
  await client.close();
  // The CLI setting, with the same checks as config.json.
  const set = await cli(["settings", "set", "anchoring", "on"]);
  assert.equal(set.code, 0, set.stderr);
  assert.equal(JSON.parse(fs.readFileSync(configFile(), "utf8")).anchoring, "on");
  const badCal = await cli(["settings", "set", "anchor_calendars", "http://calendar.example.com"]);
  assert.notEqual(badCal.code, 0);
  assert.match(badCal.stderr, /https/);
  config({ anchoring: "maybe" });
  await assert.rejects(anchor.run(), /"anchoring" must be "off" or "on"/);
  fs.rmSync(configFile());
});

let receiptFp = "";
let snapId = "";
test("W-08: anchor submits only a salted Merkle root of the receipts and snapshots; a second run finds nothing new", async () => {
  config({ anchoring: "on", saving: "ask", anchor_calendars: [calA.url, calB.url] });
  const r1 = await engine.read(site.url + "/news?1", {}, ctx);
  assert.equal(r1.status, "ok");
  const r2 = await engine.read(site.url + "/news?2", { save: true }, ctx);
  assert.equal(r2.saved?.status, "saved");
  snapId = r2.saved!.id!;
  const listed = await engine.queryReceipts({});
  const fps = listed.items.map((x: any) => x.record_fingerprint as string);
  assert.ok(fps.length >= 2 && fps.every((f) => /^sha256:[0-9a-f]{64}$/.test(f)));
  receiptFp = fps[0];
  const quotes = (listed.items as any[]).map((x) => x.quote as string);
  const run = await anchor.run();
  assert.equal(run.status, "ok", run.message);
  assert.equal(run.profile_batch!.receipts, fps.length);
  assert.equal(run.profile_batch!.snapshots, 1);
  assert.deepEqual(run.profile_batch!.calendars.map((c) => c.result), ["pending", "pending"]);
  // Each calendar learned exactly one 32-byte hash: the root. No fingerprint, quote or URL.
  for (const c of [calA, calB]) {
    assert.equal(c.digests.length, 1);
    assert.equal(c.digests[0].length, 32);
    assert.equal(c.digests[0].toString("hex"), run.profile_batch!.id);
    for (const f of fps) assert.notEqual(c.digests[0].toString("hex"), f.slice(7));
  }
  const batchText = fs.readFileSync(path.join(home, "anchors", anchorFiles()[0]), "utf8");
  for (const q of quotes) assert.ok(!batchText.includes(q.slice(0, 40)), "no content in the batch file");
  assert.ok(!batchText.includes(site.url), "no URL in the batch file");
  const b = JSON.parse(batchText);
  assert.equal(new Set(b.leaves.map((l: any) => l.salt)).size, b.leaves.length, "a fresh salt per leaf");
  const again = await anchor.run();
  assert.equal(again.status, "ok");
  assert.match(again.message, /Nothing new to anchor/);
  assert.equal(calA.digests.length, 1);
  assert.equal(anchorFiles().length, 1);
});

test("W-08: prove a pending receipt, verify it offline; upgrade reaches Bitcoin; the exported .ots and record files are standard", async () => {
  const pending = await anchor.prove(receiptFp.slice(7, 19)); // a prefix works
  assert.equal(pending.batch.status, "pending");
  assert.equal(pending.fingerprint, receiptFp);
  const dir = tmpOut();
  const f1 = anchor.writeBundle(pending, dir);
  const v1 = anchor.verifyBundle(f1[0]);
  assert.equal(v1.offline_ok, true, v1.message);
  assert.equal(v1.proven, false);
  assert.match(v1.message, /^NOT proven/);
  assert.equal(v1.needs, "upgrade");
  assert.deepEqual(v1.steps, { record: "ok", merkle: "ok", ots: "ok" });
  // Not mined yet: the calendar says 404, the batch stays pending.
  const u0 = await anchor.upgrade();
  assert.equal(u0.upgrade.still_pending, 1);
  calA.mined = true;
  const u1 = await anchor.upgrade();
  assert.equal(u1.upgrade.completed, 1);
  const st = await anchor.status();
  assert.equal(st.batches[0].status, "complete");
  assert.deepEqual(st.batches[0].bitcoin, [HEIGHT]);
  // The CLI export: three files; the record file's SHA-256 is the fingerprint, and the .ots starts from it.
  const out = tmpOut();
  const p = await cli(["receipts", "prove", receiptFp, "--out", out]);
  assert.equal(p.code, 0, p.stderr);
  const files = JSON.parse(p.stdout).files as string[];
  assert.equal(files.length, 3);
  const rec = fs.readFileSync(files[1]);
  assert.equal(`sha256:${sha(rec)}`, receiptFp);
  const parsed = ots.parseFile(fs.readFileSync(files[2]));
  assert.equal(parsed.digest.toString("hex"), receiptFp.slice(7));
  const btc = ots.attestations(parsed.stamp).find((a) => a.att.kind === "bitcoin")!;
  assert.ok(btc && [...calA.blockRoot.values()].some((m) => m.equals(btc.msg)), "the Bitcoin attestation commits to the calendar's block root");
  const vc = await cli(["receipts", "verify", files[0]]);
  assert.equal(vc.code, 2, "offline checks alone never exit 0");
  const v2 = JSON.parse(vc.stdout);
  assert.equal(v2.offline_ok, true, v2.message);
  assert.equal(v2.proven, false);
  assert.equal(v2.needs, "bitcoin_block_header");
  const a = v2.untrusted_content.attestations.find((x: any) => x.kind === "bitcoin");
  assert.equal(a.height, HEIGHT);
  assert.equal(a.merkle_root, btc.msg.toString("hex"));
  assert.equal(a.merkle_root_as_shown, Buffer.from(btc.msg).reverse().toString("hex"));
  assert.match(v2.message, /needs the outside world/);
  // Never overwrites.
  const again = await cli(["receipts", "prove", receiptFp, "--out", out]);
  assert.notEqual(again.code, 0);
  // A snapshot is proven by its id; its record file is exactly the signed bytes.
  const sp = await anchor.prove(snapId);
  assert.equal(sp.kind, "snapshot");
  const sf = anchor.writeBundle(sp, tmpOut());
  assert.equal(`sha256:${sha(fs.readFileSync(sf[1]))}`, sp.fingerprint);
  assert.equal(anchor.verifyBundle(sf[0]).offline_ok, true);
  assert.equal((await saved.verify(snapId)).ok, true);
});

test("W-08: a tampered receipt, salt, path or proof is detected", async () => {
  const bd = await anchor.prove(receiptFp);
  const dir = tmpOut();
  const check = (b: unknown) => {
    const f = path.join(dir, `b-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify(b));
    return anchor.verifyBundle(f);
  };
  assert.equal(check(bd).offline_ok, true);
  const quote = structuredClone(bd);
  (quote.record as any).quote = (quote.record as any).quote + " (edited)";
  const q = check(quote);
  assert.equal(q.offline_ok, false);
  assert.equal(q.steps.record, "mismatch");
  assert.match(q.message, /does NOT check out/);
  const salt = structuredClone(bd);
  salt.salt = "0".repeat(64);
  assert.equal(check(salt).steps.merkle, "mismatch");
  if (bd.path.length) {
    const p = structuredClone(bd);
    p.path[0].hash = "f".repeat(64);
    assert.equal(check(p).steps.merkle, "mismatch");
  }
  const fp = structuredClone(bd);
  fp.fingerprint = "sha256:" + "a".repeat(64);
  const vf = check(fp);
  assert.equal(vf.offline_ok, false);
  // A byte of the .ots: in its file digest, and in the salt its first operation prepends.
  for (const at of [ots.MAGIC.length + 2 + 5, ots.MAGIC.length + 2 + 32 + 3 + 5]) {
    const o = structuredClone(bd);
    const raw = Buffer.from(o.ots, "base64");
    raw[at] ^= 0xff;
    o.ots = raw.toString("base64");
    const v = check(o);
    assert.equal(v.offline_ok, false);
    assert.notEqual(v.steps.ots, "ok");
  }
  assert.equal(anchor.verifyBundle(path.join(dir, "missing.json")).offline_ok, false);
  // Codex v0.8 anchor round 1: a genuine Bitcoin branch for the fingerprint does not vouch for a different, invented
  // salt, path and root on another branch with no attestation of its own.
  const forged = structuredClone(bd);
  const fake = { salt: "ab".repeat(32), path: [{ sibling: "right" as const, hash: "cd".repeat(32) }] };
  const fpBuf = Buffer.from(bd.fingerprint.slice(7), "hex");
  const fakeRoot = anchor.fold(fpBuf, Buffer.from(fake.salt, "hex"), fake.path);
  Object.assign(forged, fake, { root: fakeRoot.toString("hex") });
  // The invented branch ends in an attestation of its own: only what is below the claimed root is reported, never
  // the genuine branch's Bitcoin block.
  const parsed2 = ots.parseFile(Buffer.from(bd.ots, "base64"));
  const branch2 = ots.newStamp(fpBuf);
  const tip2 = ots.chain(branch2, [{ tag: ots.PREPEND, arg: Buffer.concat([Buffer.from([0]), Buffer.from(fake.salt, "hex")]) }, { tag: ots.SHA256 }, { tag: ots.APPEND, arg: Buffer.from(fake.path[0].hash, "hex") }, { tag: ots.PREPEND, arg: Buffer.from([1]) }, { tag: ots.SHA256 }]);
  tip2.atts.push(ots.pendingAtt("https://made.up.example"));
  ots.merge(parsed2.stamp, branch2);
  forged.ots = ots.fileBytes(fpBuf, parsed2.stamp).toString("base64");
  const v3 = check(forged);
  assert.equal(v3.offline_ok, true);
  assert.equal(v3.proven, false);
  assert.deepEqual(v3.untrusted_content.attestations, [{ kind: "pending", calendar: "https://made.up.example" }], "the genuine branch's Bitcoin block is not claimed for the invented root");
});

test("W-08: private mode is never anchored: private reads leave nothing to anchor, and anchor refuses in a private session", async () => {
  const before = (await anchor.status()).not_yet_anchored;
  const r = await engine.read(site.url + "/news?private", {}, { ...ctx, private: true });
  assert.equal(r.status, "ok");
  assert.equal((await anchor.status()).not_yet_anchored, before);
  process.env.TIRESIAS_PRIVATE = "1";
  try {
    await assert.rejects(anchor.run(), /Private mode/);
    await assert.rejects(anchor.upgrade(), /Private mode/);
  } finally {
    delete process.env.TIRESIAS_PRIVATE;
  }
  const c = await cli(["anchor", "--private"]);
  assert.notEqual(c.code, 0);
  assert.match(c.stderr, /Private mode/);
});

test("W-08: calendars that fail never fail a read; a batch nobody accepted writes nothing; a garbage answer is refused; an unlisted calendar is never asked", async () => {
  calA.mode = "down";
  calB.mode = "down";
  const r = await engine.read(site.url + "/news?down", {}, ctx);
  assert.equal(r.status, "ok");
  const files = anchorFiles().length;
  const run = await anchor.run();
  assert.equal(run.status, "error");
  assert.match(run.message, /No calendar accepted/);
  assert.deepEqual(run.calendars!.map((c) => c.reason), ["http_503", "http_503"]);
  assert.equal(anchorFiles().length, files);
  calA.mode = "garbage";
  calB.mode = "foreign"; // its pending attestation names a calendar that is not on the list
  const run2 = await anchor.run();
  assert.equal(run2.status, "ok", run2.message);
  assert.deepEqual(run2.profile_batch!.calendars.map((c) => c.reason ?? c.result), ["bad_answer", "pending"]);
  calB.mode = "ok";
  const gets = calB.gets.length + calA.gets.length;
  const u = await anchor.upgrade();
  assert.ok(u.upgrade.not_listed >= 1);
  assert.equal(calB.gets.length + calA.gets.length, gets, "the unlisted calendar was never asked (and no other was asked for it)");
  calA.mode = "ok";
  // The list: the owner's calendars, and the public calendars the default pools name (https, default port, no path).
  const mine = [calA.url];
  assert.equal(anchor.upgradeAllowed(calA.url + "/", mine), true);
  assert.equal(anchor.upgradeAllowed("https://alice.btc.calendar.opentimestamps.org", mine), true);
  assert.equal(anchor.upgradeAllowed("https://btc.calendar.catallaxy.com", mine), true);
  for (const bad of ["http://alice.btc.calendar.opentimestamps.org", "https://alice.btc.calendar.opentimestamps.org:8443", "https://calendar.opentimestamps.org.evil.com", "https://evil.example.com", "https://a.calendar.opentimestamps.org/x", "https://u:p@a.calendar.eternitywall.com"])
    assert.equal(anchor.upgradeAllowed(bad, mine), false, bad);
});

test("W-08: profiles anchor separately", async () => {
  profiles.create("anchor-b");
  const bHome = path.join(home, "profiles", "anchor-b");
  config({ anchoring: "on", anchor_calendars: [calA.url] }, bHome);
  const r = await cli(["read", site.url + "/news?profile-b", "--profile", "anchor-b"]);
  assert.equal(r.code, 0, r.stderr);
  const run = JSON.parse((await cli(["anchor", "--profile", "anchor-b"])).stdout);
  assert.equal(run.status, "ok", run.message);
  assert.equal(run.profile_batch.receipts, JSON.parse((await cli(["receipts", "--profile", "anchor-b"])).stdout).untrusted_content.receipts.length);
  assert.equal(anchorFiles(bHome).length, 1);
  const bBatch = JSON.parse(fs.readFileSync(path.join(bHome, "anchors", anchorFiles(bHome)[0]), "utf8"));
  assert.equal(bBatch.profile, "anchor-b");
  const mine = new Set<string>();
  for (const f of anchorFiles()) for (const l of JSON.parse(fs.readFileSync(path.join(home, "anchors", f), "utf8")).leaves) mine.add(l.fp);
  assert.ok(bBatch.leaves.every((l: any) => !mine.has(l.fp)), "no leaf of one profile in the other's batches");
  // The default profile cannot prove the other profile's receipt.
  await assert.rejects(anchor.prove(bBatch.leaves[0].fp), /not in any batch/);
});

test("W-08 integration: the receipts listing's record_fingerprint never replaces a file warning's own fingerprint", async () => {
  const receipts = await import("../receipts.js");
  const fileFp = "sha256:" + "b".repeat(64);
  receipts.recordFile({ url: site.url + "/setup.exe", final_url: site.url + "/setup.exe", file_kind: "program", risk: "high", size: 1234, fingerprint: fileFp, flags: [], declared_type: "application/octet-stream", agent: "anchor-test" });
  const listed = await engine.queryReceipts({ url: site.url + "/setup.exe" });
  assert.equal(listed.items.length, 1);
  const item = listed.items[0] as any;
  assert.equal(item.fingerprint, fileFp, "the file's own SHA-256 is unchanged");
  assert.match(item.record_fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(item.record_fingerprint, fileFp);
  // MCP and CLI replies carry the same two fields.
  const c = await cli(["receipts", "--url", site.url + "/setup.exe"]);
  const ci = JSON.parse(c.stdout).untrusted_content.receipts[0];
  assert.equal(ci.fingerprint, fileFp);
  assert.equal(ci.record_fingerprint, item.record_fingerprint);
});

test("W-08 integration: receipts prove --out writes nothing in private mode (--private or TIRESIAS_PRIVATE)", async () => {
  assert.ok(receiptFp, "an earlier test proved a receipt");
  for (const [args, env] of [[["--private"], {}], [[], { TIRESIAS_PRIVATE: "1" }]] as [string[], Record<string, string>][]) {
    const out = tmpOut();
    const r = await cli(["receipts", "prove", receiptFp, "--out", out, ...args], env);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr + r.stdout, /Private mode: nothing is written/);
    assert.deepEqual(fs.readdirSync(out), [], "no proof file was written");
  }
  // Printing the bundle (no --out) writes nothing and still works in private mode.
  const p = await cli(["receipts", "prove", receiptFp, "--private"]);
  assert.equal(p.code, 0, p.stderr);
});

test("v0.8 integration: in private mode clear, log --to, keys init and keys sign-directory --out change and write nothing", async () => {
  const snapDir = path.join(home, "saved");
  const before = fs.readdirSync(snapDir).sort();
  assert.ok(before.length >= 1, "an earlier test saved a snapshot");
  const keyFile = path.join(home, "keys", "ed25519.private.jwk");
  assert.ok(!fs.existsSync(keyFile));
  for (const [flag, env] of [[["--private"], {}], [[], { TIRESIAS_PRIVATE: "1" }]] as [string[], Record<string, string>][]) {
    // clear --all would remove every log and (by age) nothing else; in private mode it must not run at all.
    const c = await cli(["clear", "--all", ...flag], env);
    assert.notEqual(c.code, 0);
    assert.match(c.stderr + c.stdout, /Private mode: nothing in the store is changed/);
    assert.deepEqual(fs.readdirSync(snapDir).sort(), before);
    assert.ok(fs.readdirSync(path.join(home, "receipts")).length >= 1, "the receipts log is untouched");
    const dry = await cli(["clear", "--all", "--dry-run", ...flag], env);
    assert.equal(dry.code, 0, dry.stderr);
    const out = tmpOut();
    const l = await cli(["log", "--to", out, ...flag], env);
    assert.notEqual(l.code, 0);
    assert.match(l.stderr + l.stdout, /Private mode: nothing is written/);
    const k = await cli(["keys", "init", ...flag], env);
    assert.notEqual(k.code, 0);
    assert.match(k.stderr + k.stdout, /Private mode: nothing is written/);
    assert.ok(!fs.existsSync(keyFile), "no key was made");
    const d = await cli(["keys", "sign-directory", "--host", "example.com", "--out", out, ...flag], env);
    assert.notEqual(d.code, 0);
    assert.match(d.stderr + d.stdout, /Private mode: nothing is written/);
    assert.deepEqual(fs.readdirSync(out), [], "nothing exported");
  }
  // The store-level guards hold without the CLI's checks too.
  process.env.TIRESIAS_PRIVATE = "1";
  try {
    const cleanup = await import("../cleanup.js");
    const dailylog = await import("../dailylog.js");
    const keys = await import("../keys.js");
    await assert.rejects(cleanup.clearStore({ all: true }), /Private mode/);
    await assert.rejects(dailylog.exportLog(tmpOut()), /Private mode/);
    await assert.rejects(keys.initKey(), /Private mode/);
  } finally {
    delete process.env.TIRESIAS_PRIVATE;
  }
  assert.deepEqual(fs.readdirSync(snapDir).sort(), before);
});

test("v0.8 integration: `tiresias mcp --private` serves a private session (nothing recorded, nothing saved)", async () => {
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  config({ saving: "ask" });
  const count = (dir: string) => (fs.existsSync(path.join(home, dir)) ? fs.readdirSync(path.join(home, dir)).map((f) => fs.statSync(path.join(home, dir, f)).size).join(",") : "");
  const before = { history: count("history"), receipts: count("receipts"), saved: count("saved") };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "TIRESIAS_PRIVATE") env[k] = v;
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--private"], env });
  const client = new Client({ name: "t", version: "1" });
  await client.connect(transport);
  try {
    const r = await client.callTool({ name: "read", arguments: { url: site.url + "/news?mcp-private", save: true } });
    const e = JSON.parse((r.content as { text: string }[])[0].text);
    assert.equal(e.private, true);
    assert.notEqual(e.saved?.status, "saved");
  } finally {
    await client.close();
  }
  assert.deepEqual({ history: count("history"), receipts: count("receipts"), saved: count("saved") }, before);
  fs.rmSync(configFile());
});

// Sweep fixtures use isolated stores and local calendars, including hand-built hostile answers.
async function isolatedAnchor(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = freshHome();
  neverAsk(dir);
  try { await fn(dir); } finally { process.env.TIRESIAS_HOME = home; }
}
function receiptLog(records: Record<string, unknown>[], dir: string, day?: string): void {
  if (day) fs.mkdirSync(path.join(dir, "receipts"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, day ? `receipts/${day}.jsonl` : "receipts.jsonl"), records.map((r) => JSON.stringify(r)).join("\r\n") + "\r\n", { mode: 0o600 });
}
async function answeringCalendar(answer: (msg: Buffer, post: boolean) => Buffer | { status: number; raw?: Buffer; headers?: Record<string, string> }) {
  return serve((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const post = req.method === "POST";
      const msg = post ? Buffer.concat(chunks) : Buffer.from((req.url ?? "").split("/").pop()!, "hex");
      const a = answer(msg, post);
      if (Buffer.isBuffer(a)) { res.writeHead(200); res.end(a); }
      else { res.writeHead(a.status, a.headers); res.end(a.raw); }
    })();
  });
}
function pendingBytes(msg: Buffer, uri = "https://unlisted.example"): Buffer {
  const s = ots.newStamp(msg);
  s.atts.push(ots.pendingAtt(uri));
  return ots.serialize(s);
}
function putBatch(dir: string, record: Record<string, unknown>, proof?: (root: Buffer) => Buffer): Batch {
  const fp = saved.receiptFingerprint(record).slice(7);
  const salt = "00".repeat(32);
  const root = anchor.fold(Buffer.from(fp, "hex"), Buffer.from(salt, "hex"), []);
  const b: Batch = {
    v: 1, id: root.toString("hex"), profile: "default", created_at: new Date().toISOString(),
    leaves: [{ fp, salt, kind: "receipt", day: null }], ots: (proof ? proof(root) : pendingBytes(root)).toString("base64"),
    calendars: [], status: "pending", bitcoin: [], upgraded_at: null,
  };
  fs.mkdirSync(path.join(dir, "anchors"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "anchors", `${b.id}.json`), JSON.stringify(b), { mode: 0o600 });
  return b;
}
function assertExportable(bd: Bundle): void {
  const parsed = ots.parseFile(Buffer.from(bd.ots, "base64"));
  assert.equal(parsed.digest.toString("hex"), bd.fingerprint.slice(7));
  const stack = [{ s: parsed.stamp, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const { s, depth } = stack.pop()!;
    assert.ok(depth < 256, "the official reader requires depth strictly below 256");
    nodes++;
    for (const o of s.ops) stack.push({ s: o.next, depth: depth + 1 });
  }
  assert.ok(nodes <= 20_000);
  const files = anchor.writeBundle(bd, tmpOut());
  assert.equal(anchor.verifyBundle(files[0]).offline_ok, true);
}

test("8.1: reserve Merkle depth, drop a deep calendar answer, and retain a good proof on a deep upgrade", async () => {
  await isolatedAnchor(async (dir) => {
    let depth = 251; // two leaves prefix five operations: this would reach forbidden depth 256
    const bad = await answeringCalendar((msg) => Buffer.concat([Buffer.alloc(depth, ots.SHA256), Buffer.from([0, ...ots.BITCOIN, 1, 1])]));
    let goodUrl = "";
    const good = await answeringCalendar((msg, post) => post ? pendingBytes(msg, goodUrl) : { status: 404 });
    goodUrl = good.url;
    try {
      config({ anchoring: "on", anchor_calendars: [bad.url, good.url] }, dir);
      const records = [{ quote: "a" }, { quote: "b" }];
      receiptLog(records, dir);
      const r = await anchor.run();
      assert.equal(r.status, "ok", r.message);
      assert.deepEqual(r.profile_batch!.calendars.map((c) => c.reason ?? c.result), ["bad_answer", "pending"]);
      for (const record of records) assertExportable(await anchor.prove(saved.receiptFingerprint(record)));
      // A valid root answer at depth 250 reaches exactly 255 after export and must still work.
      const boundary = ots.parse(Buffer.alloc(32), Buffer.concat([Buffer.alloc(250, ots.SHA256), Buffer.from([0, ...ots.BITCOIN, 1, 1])]));
      assert.doesNotThrow(() => ots.serialize(boundary, 5));
      assert.throws(() => ots.serialize(boundary, 6), /too deep/);
      assert.throws(() => ots.parse(Buffer.alloc(32), Buffer.concat([Buffer.alloc(256, ots.SHA256), Buffer.from([0, ...ots.BITCOIN, 1, 1])])), /too deep/);
      // Now let the good calendar hand out the too-deep branch on upgrade.
      const bfile = path.join(dir, "anchors", r.profile_batch!.id + ".json");
      const before = JSON.parse(fs.readFileSync(bfile, "utf8"));
      const s = ots.newStamp(Buffer.from(before.id, "hex"));
      s.atts.push(ots.pendingAtt(bad.url));
      before.ots = ots.serialize(s).toString("base64");
      fs.writeFileSync(bfile, JSON.stringify(before));
      const u = await anchor.upgrade();
      assert.equal(u.upgrade.failed, 1);
      assert.equal(JSON.parse(fs.readFileSync(bfile, "utf8")).ots, before.ots);
      assertExportable(await anchor.prove(saved.receiptFingerprint(records[0])));
      depth = 250;
      assert.equal((await anchor.upgrade()).upgrade.completed, 1);
      assertExportable(await anchor.prove(saved.receiptFingerprint(records[0])));
    } finally { await bad.close(); await good.close(); }
  });
});

// Many nodes in fewer than 10 KB: six binary levels then long unary tails (all messages computed).
function denseStamp(msg: Buffer, branch: number, tail = 118): Stamp {
  const s = ots.newStamp(msg);
  const start = ots.chain(s, [{ tag: ots.APPEND, arg: Buffer.from([branch]) }, { tag: ots.SHA256 }]);
  const grow = (n: Stamp, level: number) => {
    if (level === 0) {
      ots.chain(n, Array.from({ length: tail }, () => ({ tag: ots.SHA256 }))).atts.push({ tag: Buffer.alloc(8, 0x11), payload: Buffer.alloc(0) });
    } else for (const tag of [ots.SHA256, ots.RIPEMD160]) grow(ots.chain(n, [{ tag }]), level - 1);
  };
  grow(start, 6);
  return s;
}

test("8.3: every submission merge enforces node limits and exports the earlier accepted branches", async () => {
  await isolatedAnchor(async (dir) => {
    const calendars = await Promise.all([1, 2, 3].map((i) => answeringCalendar((msg) => ots.serialize(denseStamp(msg, i)))));
    try {
      config({ anchoring: "on", anchor_calendars: calendars.map((c) => c.url) }, dir);
      const record = { quote: "node budget" };
      receiptLog([record], dir);
      const r = await anchor.run();
      assert.equal(r.status, "ok", r.message);
      assert.deepEqual(r.profile_batch!.calendars.map((c) => c.reason ?? c.result), ["pending", "pending", "bad_answer"]);
      const bd = await anchor.prove(saved.receiptFingerprint(record));
      const parsed = ots.parseFile(Buffer.from(bd.ots, "base64"));
      assert.equal(parsed.stamp.ops.length, 1);
      assertExportable(bd);
    } finally { for (const c of calendars) await c.close(); }
  });
});

test("8.3: upgrades keep the previous proof when merged nodes or the reserved path exceed the limit", async () => {
  await isolatedAnchor(async (dir) => {
    let tiny = false;
    const cal = await answeringCalendar((msg) => {
      if (!tiny) return ots.serialize(denseStamp(msg, 3));
      const s = ots.newStamp(msg);
      ots.chain(s, [{ tag: ots.SHA256 }]).atts.push(ots.bitcoinAtt(1));
      return ots.serialize(s);
    });
    try {
      config({ anchoring: "on", anchor_calendars: [cal.url] }, dir);
      const record = { quote: "upgrade nodes" };
      receiptLog([record], dir);
      const b = putBatch(dir, record, (root) => {
        const s = denseStamp(root, 1);
        ots.merge(s, denseStamp(root, 2));
        s.atts.push(ots.pendingAtt(cal.url));
        return ots.serialize(s);
      });
      const u = await anchor.upgrade();
      assert.equal(u.upgrade.failed, 1);
      const file = path.join(dir, "anchors", b.id + ".json");
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).ots, b.ots);
      assertExportable(await anchor.prove(b.leaves[0].fp));
      // Build a proof at the node boundary, including room for the two-node leaf prefix.
      const root = Buffer.from(b.id, "hex");
      const near = ots.newStamp(root);
      for (let i = 0; i < 3; i++) ots.merge(near, denseStamp(root, i + 1, 100));
      let count = [...ots.nodes(near)].length;
      while (count < 19_998) {
        const end = ots.chain(near, [{ tag: ots.APPEND, arg: Buffer.from(`extra-${count}`) }]);
        const length = Math.min(150, 19_998 - count - 1);
        ots.chain(end, Array.from({ length }, () => ({ tag: ots.SHA256 }))).atts.push(ots.bitcoinAtt(1));
        count += length + 1;
      }
      const tip = [...ots.nodes(near)].find((n) => n.atts.length)!;
      tip.atts.push(ots.pendingAtt(cal.url));
      assert.equal([...ots.nodes(near)].length, 19_998);
      b.ots = ots.serialize(near).toString("base64");
      fs.writeFileSync(file, JSON.stringify(b));
      assertExportable(await anchor.prove(b.leaves[0].fp));
      // One more node still fits the root parser, but exceeds 20,000 after the leaf prefix.
      const trial = ots.parse(root, ots.serialize(near));
      const trialTip = [...ots.nodes(trial)].find((n) => n.msg.equals(tip.msg))!;
      ots.chain(trialTip, [{ tag: ots.PREPEND, arg: Buffer.from([99]) }]).atts.push(ots.bitcoinAtt(1));
      assert.equal([...ots.nodes(trial)].length, 19_999);
      assert.doesNotThrow(() => ots.parse(root, ots.serialize(trial)));
      assert.throws(() => ots.serialize(trial, 2), /too many nodes/);
      tiny = true;
      const u2 = await anchor.upgrade();
      assert.equal(u2.upgrade.failed, 1);
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).ots, b.ots);
    } finally { await cal.close(); }
  });
});

test("8.2: Bitcoin heights are uint32 and malformed height payloads are refused", () => {
  const msg = Buffer.alloc(32);
  const s = ots.newStamp(msg);
  s.atts.push(ots.bitcoinAtt(0xffffffff));
  assert.equal(ots.attestations(ots.parse(msg, ots.serialize(s)))[0].att.kind, "bitcoin");
  for (const height of [0x1_0000_0000, Number.MAX_SAFE_INTEGER]) {
    s.atts = [ots.bitcoinAtt(height)];
    assert.throws(() => ots.parse(msg, ots.serialize(s)), /block height too large/);
  }
  for (const payload of [Buffer.alloc(0), Buffer.from([0x80]), Buffer.from([1, 0])]) {
    s.atts = [{ tag: ots.BITCOIN, payload }];
    assert.throws(() => ots.parse(msg, ots.serialize(s)));
  }
});

test("8.4: Litecoin and Ethereum payloads are parsed before opaque preservation", () => {
  const msg = Buffer.alloc(32);
  for (const hex of ["06869a0d73d71b45", "30fe8087b5c7ead7"]) {
    const tag = Buffer.from(hex, "hex");
    const s = ots.newStamp(msg);
    for (const payload of [Buffer.alloc(0), Buffer.from([0x80]), Buffer.from([1, 0])]) {
      s.atts = [{ tag, payload }];
      assert.throws(() => ots.parse(msg, ots.serialize(s)), hex);
    }
    s.atts = [{ tag, payload: ots.bitcoinAtt(0xffffffff).payload }];
    assert.deepEqual(ots.describe(ots.parse(msg, ots.serialize(s)).atts[0]), { kind: "other", tag: hex });
    s.atts = [{ tag, payload: ots.bitcoinAtt(0x1_0000_0000).payload }];
    if (hex.startsWith("06")) assert.throws(() => ots.parse(msg, ots.serialize(s)), /block height too large/);
    else assert.doesNotThrow(() => ots.parse(msg, ots.serialize(s))); // reference Ethereum has no uint32 bound
  }
});

test("8.14: all 5,001 kept batches remain provable and counted; upgrade scans resume in pages", async () => {
  await isolatedAnchor(async (dir) => {
    config({ anchoring: "on", anchor_calendars: [calA.url] }, dir);
    const records = new Map<string, Record<string, unknown>>();
    for (let i = 0; i < 5_001; i++) {
      const record = { quote: `kept ${i}` };
      const b = putBatch(dir, record);
      // Old evidence still counts if retention later changes or an old receipt is kept.
      b.created_at = "2000-01-01T00:00:00.000Z";
      fs.writeFileSync(path.join(dir, "anchors", b.id + ".json"), JSON.stringify(b));
      records.set(b.leaves[0].fp, record);
    }
    const d = fs.opendirSync(path.join(dir, "anchors"));
    const names: string[] = [];
    for (let e = d.readSync(); e; e = d.readSync()) if (/^[0-9a-f]{64}\.json$/.test(e.name)) names.push(e.name);
    d.closeSync();
    const last = JSON.parse(fs.readFileSync(path.join(dir, "anchors", names[5_000]), "utf8")) as Batch;
    const record = records.get(last.leaves[0].fp)!;
    receiptLog([record], dir);
    assertExportable(await anchor.prove(last.leaves[0].fp));
    const status = await anchor.status();
    assert.equal(status.total_batches, 5_001);
    assert.equal(status.not_yet_anchored, 0, "no kept evidence disappears from the anchored set");
    const first = await anchor.upgrade({ upgradeBatches: 2 });
    assert.equal(first.upgrade.batches, 2);
    assert.equal(first.upgrade.batches_not_checked, 4_999);
    assert.equal(first.upgrade.scan_incomplete, true);
    assert.match(first.message, /scan incomplete.*not checked/);
    const c1 = JSON.parse(fs.readFileSync(path.join(dir, "anchors", "continuation"), "utf8")).upgrade;
    const second = await anchor.upgrade({ upgradeBatches: 2 });
    const c2 = JSON.parse(fs.readFileSync(path.join(dir, "anchors", "continuation"), "utf8")).upgrade;
    assert.equal(second.upgrade.batches, 2);
    assert.notDeepEqual(c1, c2, "each page advances rather than checking the first files forever");
    const before = calA.digests.length;
    assert.match((await anchor.run()).message, /Nothing new to anchor/);
    assert.equal(calA.digests.length, before, "the old receipt is not submitted again");
  });
});

test("8.15: receipt scans resume past anchored lines across legacy and day logs; status stays read-only", async () => {
  await isolatedAnchor(async (dir) => {
    let url = "";
    const cal = await answeringCalendar((msg, post) => post ? pendingBytes(msg, url) : { status: 404 });
    url = cal.url;
    try {
      config({ anchoring: "on", anchor_calendars: [url] }, dir);
      const records = [{ quote: "old α" }, { quote: "old β" }, { quote: "new γ" }];
      receiptLog(records.slice(0, 2), dir); // CRLF, non-ASCII and a legacy-to-day boundary
      receiptLog(records.slice(2), dir, "2026-10-31");
      putBatch(dir, records[0]);
      putBatch(dir, records[1]);
      const cont = path.join(dir, "anchors", "continuation");
      const status = await anchor.status(1, { receipts: 2 });
      assert.equal(status.scan_incomplete, true);
      assert.match(status.message, /receipt scan incomplete/);
      assert.ok(!fs.existsSync(cont), "status does not advance a continuation or write one");
      const first = await anchor.run({ receipts: 2 });
      assert.equal(first.scan_incomplete, true);
      assert.match(first.message, /No new fingerprints in this part.*scan incomplete/);
      assert.doesNotMatch(first.message, /Nothing new to anchor/);
      assert.equal(cal.hits.filter((h) => h.path === "/digest").length, 0);
      const c = JSON.parse(fs.readFileSync(cont, "utf8")).receipts;
      assert.equal(c.offset, fs.statSync(path.join(dir, "receipts.jsonl")).size);
      const second = await anchor.run({ receipts: 2 });
      assert.equal(second.profile_batch!.receipts, 1);
      assert.equal(second.scan_incomplete, false);
      assertExportable(await anchor.prove(saved.receiptFingerprint(records[2])));
      assert.equal(JSON.parse(fs.readFileSync(cont, "utf8")).receipts, null, "a complete scan wraps for future appends");
      // An append to an earlier day is found after wrapping too.
      const appended = { quote: "appended δ" };
      fs.appendFileSync(path.join(dir, "receipts.jsonl"), JSON.stringify(appended) + "\n");
      assert.equal((await anchor.run()).profile_batch!.receipts, 1);
      assertExportable(await anchor.prove(saved.receiptFingerprint(appended)));
    } finally { await cal.close(); }
  });
});

test("8.15: failed submissions do not advance the receipt cursor; replacement and deletion resume safely", async () => {
  await isolatedAnchor(async (dir) => {
    let fail = true;
    let url = "";
    const cal = await answeringCalendar((msg, post) => fail || !post ? { status: 404 } : pendingBytes(msg, url));
    url = cal.url;
    try {
      config({ anchoring: "on", anchor_calendars: [url] }, dir);
      const records = [{ quote: "first" }, { quote: "second" }, { quote: "third" }];
      receiptLog(records, dir);
      assert.equal((await anchor.run({ receipts: 1 })).status, "error");
      assert.ok(!fs.existsSync(path.join(dir, "anchors", "continuation")), "a failed new batch cannot skip its records");
      fail = false;
      assert.equal((await anchor.run({ receipts: 1 })).profile_batch!.receipts, 1);
      assertExportable(await anchor.prove(saved.receiptFingerprint(records[0])));
      const replacement = { quote: "replacement" };
      fs.unlinkSync(path.join(dir, "receipts.jsonl"));
      receiptLog([replacement], dir);
      assert.equal((await anchor.run({ receipts: 1 })).profile_batch!.receipts, 1);
      assertExportable(await anchor.prove(saved.receiptFingerprint(replacement)));
      // Cursor on a removed file falls forward to the next day instead of hiding it forever.
      receiptLog(records, dir);
      await anchor.run({ receipts: 1 });
      fs.unlinkSync(path.join(dir, "receipts.jsonl"));
      const next = { quote: "next day" };
      receiptLog([next], dir, "2026-10-31");
      assert.equal((await anchor.run({ receipts: 1 })).profile_batch!.receipts, 1);
      assertExportable(await anchor.prove(saved.receiptFingerprint(next)));
    } finally { await cal.close(); }
  });
});

test("v1.0 (Linux CI): a receipts file rewritten in place under the same inode is scanned again from the start", async () => {
  await isolatedAnchor(async (dir) => {
    let url = "";
    const cal = await answeringCalendar((msg, post) => !post ? { status: 404 } : pendingBytes(msg, url));
    url = cal.url;
    try {
      config({ anchoring: "on", anchor_calendars: [url] }, dir);
      const file = path.join(dir, "receipts.jsonl");
      receiptLog([{ quote: "a" }, { quote: "b" }, { quote: "c" }], dir);
      const ino = fs.statSync(file).ino;
      assert.equal((await anchor.run({ receipts: 1 })).profile_batch!.receipts, 1);
      assert.ok(fs.existsSync(path.join(dir, "anchors", "continuation")), "an incomplete scan keeps its cursor");
      // Same name, same inode (what Linux gives a file deleted and written again), longer than the cursor's offset.
      const replacement = { quote: "a replacement record that is longer than the first one was" };
      receiptLog([replacement, { quote: "d" }], dir);
      assert.equal(fs.statSync(file).ino, ino, "the test rewrites the same inode");
      assert.equal((await anchor.run({ receipts: 1 })).profile_batch!.receipts, 1);
      assertExportable(await anchor.prove(saved.receiptFingerprint(replacement)));
      // A cursor written before v1.0 has no prefix digest: it restarts at zero, and already-anchored records are skipped.
      const cont = path.join(dir, "anchors", "continuation");
      const c = JSON.parse(fs.readFileSync(cont, "utf8"));
      assert.match(c.receipts.prefix, /^[0-9a-f]{64}$/);
      delete c.receipts.prefix;
      fs.writeFileSync(cont, JSON.stringify(c));
      assert.equal((await anchor.run({ receipts: 2 })).profile_batch!.receipts, 1, "only the one record not yet anchored");
    } finally { await cal.close(); }
  });
});

test("v1.0 (Codex launch round 1): a same-length rewrite that keeps every record's ending is still scanned again", async () => {
  await isolatedAnchor(async (dir) => {
    let url = "";
    const cal = await answeringCalendar((msg, post) => !post ? { status: 404 } : pendingBytes(msg, url));
    url = cal.url;
    try {
      config({ anchoring: "on", anchor_calendars: [url] }, dir);
      const file = path.join(dir, "receipts.jsonl");
      const rec = (quote: string, n: number) => ({ v: 1, kind: "quote", quote, url: "https://example.com/", section: n, fetched_at: "2026-11-01T06:00:00.000Z", recorded_at: `2026-11-01T06:00:0${n}.000Z` });
      receiptLog([rec("old", 1), rec("two", 2), rec("three", 3)], dir);
      const before = fs.readFileSync(file);
      assert.equal((await anchor.run({ receipts: 1 })).profile_batch!.receipts, 1);
      // Same length, same last 100 bytes of the first record, same inode: only the quote changed.
      const replaced = rec("new", 1);
      receiptLog([replaced, rec("two", 2), rec("three", 3)], dir);
      const after = fs.readFileSync(file);
      assert.equal(after.length, before.length);
      assert.ok(after.subarray(after.indexOf(10) - 100, after.indexOf(10) + 1).equals(before.subarray(before.indexOf(10) - 100, before.indexOf(10) + 1)));
      assert.equal((await anchor.run({ receipts: 1 })).profile_batch!.receipts, 1);
      assertExportable(await anchor.prove(saved.receiptFingerprint(replaced)));
    } finally { await cal.close(); }
  });
});

test("8.16: failing pending requests rotate within and across batches instead of starving later proofs", async () => {
  await isolatedAnchor(async (dir) => {
    const cal = await answeringCalendar(() => ({ status: 500 }));
    try {
      config({ anchoring: "on", anchor_calendars: [cal.url] }, dir);
      const b = putBatch(dir, { quote: "many pending" }, (root) => {
        const s = ots.newStamp(root);
        for (let i = 1; i <= 3; i++) ots.chain(s, [{ tag: ots.APPEND, arg: Buffer.from([i]) }]).atts.push(ots.pendingAtt(cal.url));
        return ots.serialize(s);
      });
      const later = putBatch(dir, { quote: "later batch" }, (root) => pendingBytes(root, cal.url));
      const expected = new Set([...ots.attestations(ots.parse(Buffer.from(b.id, "hex"), Buffer.from(b.ots, "base64"))).map((a) => a.msg.toString("hex")), later.id]);
      let reportedPartial = false;
      let reportedUnaskedBatch = false;
      for (let i = 0; i < 4; i++) {
        const u = await anchor.upgrade({ upgradeRequests: 1 });
        if (u.upgrade.requests_not_asked > 0) reportedPartial = true;
        if (u.upgrade.batches_not_checked > 0) reportedUnaskedBatch = true;
        if (i === 0) assert.match(u.message, /scan incomplete/);
      }
      assert.equal(reportedPartial, true);
      assert.equal(reportedUnaskedBatch, true);
      assert.deepEqual(new Set(cal.hits.map((h) => h.path.split("/").pop())), expected, "one attempt for every pending attestation despite persistent failures");
      await anchor.upgrade({ upgradeRequests: 1 });
      assert.equal(cal.hits.length, 5, "the continuation wraps for future attempts");
    } finally { await cal.close(); }
  });
});

test("9.9: bundle export rolls back its own files on a later collision and a retry succeeds", async () => {
  const bd = await anchor.prove(receiptFp);
  const name = `${bd.kind}-${bd.fingerprint.slice(7, 23)}`;
  for (const suffix of [".json", ".json.ots"]) {
    const dir = tmpOut();
    const collision = path.join(dir, name + suffix);
    fs.writeFileSync(collision, "keep me");
    assert.throws(() => anchor.writeBundle(bd, dir), /EEXIST/);
    assert.deepEqual(fs.readdirSync(dir), [name + suffix]);
    assert.equal(fs.readFileSync(collision, "utf8"), "keep me");
    fs.unlinkSync(collision);
    const files = anchor.writeBundle(bd, dir);
    assert.equal(files.length, 3);
    assert.equal(anchor.verifyBundle(files[0]).offline_ok, true);
    assert.equal(fs.readdirSync(dir).length, 3, "no staging files remain");
  }
  // A directory at a later final name also leaves no earlier files or temporary files behind.
  const dir = tmpOut();
  fs.mkdirSync(path.join(dir, name + ".json.ots"));
  assert.throws(() => anchor.writeBundle(bd, dir));
  assert.deepEqual(fs.readdirSync(dir), [name + ".json.ots"]);
});

test("9.17: calendars record 429/503 Retry-After at headers and honor cooldowns for submissions and upgrades", async () => {
  const { cooldownLeft } = await import("../cooldown.js");
  for (const status of [429, 503]) await isolatedAnchor(async (dir) => {
    let url = "";
    let busy = false;
    const cal = await answeringCalendar((msg, post) => busy ? { status, raw: Buffer.alloc(10_001), headers: { "retry-after": "3600" } } : post ? pendingBytes(msg, url) : { status: 404 });
    url = cal.url;
    try {
      config({ anchoring: "on", anchor_calendars: [url] }, dir);
      const record = { quote: `pending ${status}` };
      receiptLog([record], dir);
      assert.equal((await anchor.run()).status, "ok");
      busy = true;
      assert.equal((await anchor.upgrade()).upgrade.failed, 1, "even an oversized response records its headers");
      assert.ok(cooldownLeft(url) > 3500);
      const count = cal.hits.length;
      assert.equal((await anchor.upgrade()).upgrade.failed, 1);
      receiptLog([record, { quote: "new while waiting" }], dir);
      const r = await anchor.run();
      assert.equal(r.status, "error");
      assert.equal(r.calendars![0].reason, "refused");
      assert.equal(cal.hits.length, count, "neither GET nor POST bypasses the calendar cooldown");
      assert.ok(cal.hits.every((h) => h.path !== "/robots.txt"));
    } finally { await cal.close(); }
  });
});

test("8.15: byte cursors cross read chunks and the batch cap without skipping unsubmitted records", async () => {
  await isolatedAnchor(async (dir) => {
    let url = "";
    const cal = await answeringCalendar((msg, post) => post ? pendingBytes(msg, url) : { status: 404 });
    url = cal.url;
    try {
      config({ anchoring: "on", anchor_calendars: [url] }, dir);
      // Include a long legacy line to exercise UTF-8 and CRLF across several 64 KB read chunks.
      const records = Array.from({ length: anchor.MAX_LEAVES + 1 }, (_, i) => ({ quote: i === 0 ? "α".repeat(80_000) : `cap ${i}` }));
      receiptLog(records, dir);
      const first = await anchor.run();
      assert.equal(first.profile_batch!.receipts, anchor.MAX_LEAVES);
      assert.equal(first.scan_incomplete, true);
      const second = await anchor.run();
      assert.equal(second.profile_batch!.receipts, 1);
      assert.equal(second.scan_incomplete, false);
      assertExportable(await anchor.prove(saved.receiptFingerprint(records[0])));
      assertExportable(await anchor.prove(saved.receiptFingerprint(records.at(-1)!)));
      assert.equal((await anchor.status()).not_yet_anchored, 0);
    } finally { await cal.close(); }
  });
});
