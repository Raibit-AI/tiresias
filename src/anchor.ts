// SPDX-License-Identifier: Apache-2.0
// W-08 (v0.8): tamper-proof receipts. The owner can timestamp FINGERPRINTS (never content, never URLs) of this
// profile's receipts and saved snapshots on a public chain, so anyone can later check that a receipt existed at that
// time and was not edited since. Free: OpenTimestamps (Bitcoin-backed public calendars, no wallet, no account).
//
//   tiresias anchor              upgrade pending batches, then build a new batch and submit its root
//   tiresias anchor status       the setting, the calendars, the batches
//   tiresias anchor upgrade      ask the calendars whether pending batches reached a Bitcoin block
//   tiresias receipts prove <id> a proof bundle for one receipt or snapshot: the record, its salt, its Merkle path, a .ots
//   tiresias receipts verify <f> check a bundle offline; say which step needs a Bitcoin block header
//
// A batch is a Merkle tree over salted leaves in a random order; only its root leaves the machine. Owner only: the
// `anchoring` setting (off by default) and these commands; nothing over MCP. Never in private mode; each profile its
// own anchors/ folder. Full design: docs/v0.8/anchor.md.
import { createHash, randomBytes, randomInt, type Hash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadAnchoringMode, loadCalendars } from "./config.js";
import { cooldownLeft, setCooldown } from "./cooldown.js";
import { FetchError, Refused } from "./errors.js";
import * as ots from "./ots.js";
import * as saved from "./saved.js";
import { safeFetch } from "./safety.js";
import { NOFOLLOW, NONBLOCK, checkSub, isPrivate, listLogs, ownFile, pageLog, profileName, readHome, readJson, readOwnedFile, subDir, writeJson } from "./store.js";
import { NOTICE } from "./types.js";

export const BATCH_VERSION = 1;
export const MAX_LEAVES = 20_000; // per batch; more waits for the next run
const MAX_BATCHES = 5_000; // batch files checked for upgrades in one run (all remain searchable)
const MAX_BATCH_FILE = 8 * 1024 * 1024;
const MAX_OTS = 64 * 1024; // a stored proof from the root (calendar answers are at most 10 KB each)
const MAX_ANSWER = 10_000; // what the official client reads from a calendar
const MAX_UPGRADE_REQUESTS = 200; // per run
const MAX_BUNDLE = 16 * 1024 * 1024;
const MAX_SCAN = 2_000_000; // receipts lines looked at in one run
const HEX64 = /^[0-9a-f]{64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const BATCH_FILE = /^[0-9a-f]{64}\.json$/;
const OTS_ACCEPT = "application/vnd.opentimestamps.v1";
// Calendars a pending proof may be upgraded from besides the owner's own list: the ones the default pools hand out,
// as the official client allows (one label, then these names; https on the default port only).
const PUBLIC_CALENDAR = /^(?:[a-z0-9-]{1,63}\.){1,3}calendar\.(opentimestamps\.org|eternitywall\.com|catallaxy\.com)$/;

export class AnchorError extends Error {}

export type LeafKind = "receipt" | "snapshot";
export interface Leaf {
  fp: string; // hex SHA-256: the fingerprint
  kind: LeafKind;
  salt: string; // hex, 32 bytes
  day?: string | null; // a receipt: its day file (null: the legacy single file)
  snapshot?: string; // a snapshot: its id
}
export type CalendarResult = { url: string; result: "pending" | "failed"; reason?: string };
export interface Batch {
  v: number;
  id: string; // the root, hex
  profile: string;
  created_at: string;
  leaves: Leaf[]; // in tree order
  ots: string; // base64: the OpenTimestamps proof starting at the root
  calendars: CalendarResult[];
  status: "pending" | "complete";
  bitcoin: number[]; // block heights, once complete
  upgraded_at: string | null;
}

// ---- the tree ----

const leafHash = (salt: Buffer, fp: Buffer): Buffer => ots.sha(Buffer.concat([Buffer.from([0x00]), salt, fp]));
const nodeHash = (l: Buffer, r: Buffer): Buffer => ots.sha(Buffer.concat([Buffer.from([0x01]), l, r]));
export type Step = { sibling: "left" | "right"; hash: string };

function levelsOf(leaves: Buffer[]): Buffer[][] {
  const levels = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next: Buffer[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? nodeHash(cur[i], cur[i + 1]) : cur[i]); // an odd last node moves up unchanged
    levels.push(next);
  }
  return levels;
}
const leafBuffers = (leaves: Leaf[]): Buffer[] => leaves.map((l) => leafHash(Buffer.from(l.salt, "hex"), Buffer.from(l.fp, "hex")));
function pathOf(levels: Buffer[][], i: number): Step[] {
  const out: Step[] = [];
  for (let l = 0; l < levels.length - 1; l++) {
    const sib = i ^ 1;
    if (sib < levels[l].length) out.push({ sibling: i % 2 ? "left" : "right", hash: levels[l][sib].toString("hex") });
    i >>= 1;
  }
  return out;
}
export function fold(fp: Buffer, salt: Buffer, steps: Step[]): Buffer {
  let h = leafHash(salt, fp);
  for (const s of steps) h = s.sibling === "right" ? nodeHash(h, Buffer.from(s.hash, "hex")) : nodeHash(Buffer.from(s.hash, "hex"), h);
  return h;
}
// The same path as OpenTimestamps operations, so the official tool follows it from the fingerprint to the root.
function pathOps(salt: Buffer, steps: Step[]): ots.Op[] {
  const ops: ots.Op[] = [{ tag: ots.PREPEND, arg: Buffer.concat([Buffer.from([0x00]), salt]) }, { tag: ots.SHA256 }];
  for (const s of steps) {
    const h = Buffer.from(s.hash, "hex");
    ops.push(s.sibling === "right" ? { tag: ots.APPEND, arg: h } : { tag: ots.PREPEND, arg: h }, { tag: ots.PREPEND, arg: Buffer.from([0x01]) }, { tag: ots.SHA256 });
  }
  return ops;
}

// ---- the store ----

const anchorsDir = (create: boolean): string | null => subDir("anchors", create);

function shapeOk(b: unknown): b is Batch {
  const o = b as Batch;
  if (!o || typeof o !== "object" || o.v !== BATCH_VERSION || typeof o.id !== "string" || !HEX64.test(o.id)) return false;
  if (typeof o.profile !== "string" || typeof o.created_at !== "string" || !Number.isFinite(Date.parse(o.created_at))) return false;
  if (typeof o.ots !== "string" || o.ots.length > MAX_OTS * 2 || (o.status !== "pending" && o.status !== "complete")) return false;
  if (!Array.isArray(o.bitcoin) || o.bitcoin.length > 64 || !o.bitcoin.every((h) => Number.isSafeInteger(h) && h >= 0)) return false;
  if (!Array.isArray(o.calendars) || o.calendars.length > 8) return false;
  if (!Array.isArray(o.leaves) || o.leaves.length < 1 || o.leaves.length > MAX_LEAVES) return false;
  for (const l of o.leaves) {
    if (!l || typeof l !== "object" || typeof l.fp !== "string" || !HEX64.test(l.fp) || typeof l.salt !== "string" || !HEX64.test(l.salt)) return false;
    if (l.kind === "receipt") {
      if (l.day !== null && (typeof l.day !== "string" || !DAY_RE.test(l.day))) return false;
    } else if (l.kind !== "snapshot" || typeof l.snapshot !== "string" || !HEX64.test(l.snapshot)) return false;
  }
  return true;
}

function readBatch(file: string): Batch | null {
  let text: string | null;
  try {
    text = readOwnedFile(file, MAX_BATCH_FILE);
  } catch {
    return null;
  }
  if (text === null) return null;
  try {
    const b = JSON.parse(text);
    return shapeOk(b) && path.basename(file) === `${b.id}.json` ? b : null;
  } catch {
    return null;
  }
}

// Stream EVERY kept batch name. Lookup and the already-anchored set must never truncate this list.
function* batchFiles(): Generator<string> {
  const d = anchorsDir(false);
  if (!d) return;
  const dir = fs.opendirSync(d);
  try {
    for (let e = dir.readSync(); e !== null; e = dir.readSync())
      if (BATCH_FILE.test(e.name)) yield path.join(d, e.name);
  } finally {
    dir.closeSync();
  }
}

function* batches(): Generator<Batch> {
  for (const f of batchFiles()) {
    const b = readBatch(f);
    if (b) yield b;
  }
}

function saveBatch(b: Batch): void {
  const d = anchorsDir(true)!;
  checkSub(d);
  writeJson(path.join(d, `${b.id}.json`), b); // exclusive temp file, then rename; mode 0600; refused in private mode
}

// ---- what is waiting to be anchored ----

interface Candidate {
  fp: string;
  kind: LeafKind;
  day?: string | null;
  snapshot?: string;
}

// Every kept batch counts: retention can change, while batch evidence is never removed.
function anchoredFingerprints(): Set<string> {
  const seen = new Set<string>();
  for (const b of batches()) for (const l of b.leaves) seen.add(l.fp);
  return seen;
}

interface ReceiptCursor {
  file: string;
  offset: number;
  dev: number;
  ino: number;
  // v1.0 (CI on Linux, 2026-11-01; Codex launch round 1): SHA-256 (hex) of the file's bytes before `offset`. Linux
  // reuses an inode number at once, so a file deleted and written again, or rewritten in place, can keep dev, ino
  // and a size past the offset; resuming is allowed only when everything before the offset is byte for byte what
  // was scanned. A cursor without it restarts at zero (safe: records already anchored are skipped by fingerprint).
  prefix?: string;
}
interface Continuation {
  receipts?: ReceiptCursor | null;
  upgrade?: { file: string; att: number } | null;
}
// Internal limits let tests exercise continuation without millions of records or hundreds of requests.
interface ScanLimits {
  receipts?: number;
  upgradeRequests?: number;
  upgradeBatches?: number;
}
function continuation(): Continuation {
  const d = anchorsDir(false);
  const c = d ? readJson<Continuation>(path.join(d, "continuation")) : null;
  if (!c || typeof c !== "object") return {};
  const r = c.receipts;
  const u = c.upgrade;
  return {
    receipts: r && typeof r.file === "string" && /^(?:receipts\.jsonl|receipts\/\d{4}-\d{2}-\d{2}\.jsonl)$/.test(r.file) && [r.offset, r.dev, r.ino].every((n) => Number.isSafeInteger(n) && n >= 0) && (r.prefix === undefined || (typeof r.prefix === "string" && /^[0-9a-f]{64}$/.test(r.prefix))) ? r : null,
    upgrade: u && typeof u.file === "string" && BATCH_FILE.test(u.file) && Number.isSafeInteger(u.att) && u.att >= 0 ? u : null,
  };
}
function saveContinuation(part: Continuation): void {
  const d = anchorsDir(true)!;
  checkSub(d);
  writeJson(path.join(d, "continuation"), { ...continuation(), ...part });
}

// Byte offsets make resumption independent of how many already-anchored records came before it.
// Files are append-only; a replaced/truncated file restarts at zero (it resumes only with the same file name,
// device and inode, a size at least the offset, and the same SHA-256 of every byte before the offset). A missing
// cursor file resumes at the next day. Each yielded position is AFTER its line, including CRLF and UTF-8 bytes exactly.
// Re-hashing the prefix on resume reads it once more; that is the cost of never skipping a rewritten record.
function prefixHash(fd: number, cursor: ReceiptCursor): Hash | null {
  if (!cursor.prefix) return null;
  const hash = createHash("sha256");
  const buf = Buffer.alloc(64 * 1024);
  for (let at = 0; at < cursor.offset; ) {
    const n = fs.readSync(fd, buf, 0, Math.min(buf.length, cursor.offset - at), at);
    if (!n) return null;
    hash.update(buf.subarray(0, n));
    at += n;
  }
  return hash.copy().digest("hex") === cursor.prefix ? hash : null;
}
function* receiptLines(cursor?: ReceiptCursor | null): Generator<{ line: string; cursor: ReceiptCursor }> {
  const h = readHome();
  if (!h) return;
  for (const f of listLogs("receipts")) {
    if (cursor && f.rel < cursor.file) continue;
    const file = path.join(h, f.rel);
    let fd: number;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK); } catch { continue; }
    try {
      ownFile(fd, file);
      const st = fs.fstatSync(fd);
      const resumed = cursor && f.rel === cursor.file && st.dev === cursor.dev && st.ino === cursor.ino && st.size >= cursor.offset ? prefixHash(fd, cursor) : null;
      let offset = resumed ? cursor!.offset : 0;
      const hash = resumed ?? createHash("sha256"); // always the bytes before `offset`
      const position = (): ReceiptCursor => ({ file: f.rel, offset, dev: st.dev, ino: st.ino, prefix: hash.copy().digest("hex") });
      let parts: Buffer[] = [];
      let length = 0;
      // Snapshot the size so a writer appending throughout a scan cannot keep it alive forever.
      while (offset < st.size) {
        const buf = Buffer.alloc(Math.min(64 * 1024, st.size - offset));
        const n = fs.readSync(fd, buf, 0, buf.length, offset);
        if (!n) break;
        let start = 0;
        for (let i = 0; i < n; i++) {
          if (buf[i] !== 10) continue;
          parts.push(buf.subarray(start, i));
          hash.update(buf.subarray(start, i + 1));
          offset += i + 1 - start;
          length += i - start;
          yield { line: Buffer.concat(parts).toString("utf8"), cursor: position() };
          parts = [];
          length = 0;
          start = i + 1;
        }
        length += n - start;
        parts.push(buf.subarray(start, n));
        hash.update(buf.subarray(start, n));
        offset += n - start;
      }
      if (length) yield { line: Buffer.concat(parts).toString("utf8"), cursor: position() };
    } finally {
      fs.closeSync(fd);
    }
  }
}

async function gather(limit = MAX_SCAN): Promise<{ todo: Candidate[]; total: number; incomplete: boolean; cursor: ReceiptCursor | null }> {
  const seen = anchoredFingerprints();
  const todo: Candidate[] = [];
  const mine = new Set<string>();
  let total = 0;
  const add = (c: Candidate) => {
    if (seen.has(c.fp) || mine.has(c.fp)) return;
    mine.add(c.fp);
    total++;
    if (todo.length < MAX_LEAVES) todo.push(c);
  };
  let scanned = 0;
  let cursor: ReceiptCursor | null = null;
  let incomplete = false;
  for (const entry of receiptLines(continuation().receipts)) {
    if (scanned >= limit || todo.length >= MAX_LEAVES) {
      incomplete = true;
      break;
    }
    cursor = entry.cursor;
    // Count damaged and blank lines too, so even a damaged log scan is bounded.
    scanned++;
    try {
      const r = JSON.parse(entry.line);
      if (r && typeof r === "object" && !Array.isArray(r)) add({ fp: saved.receiptFingerprint(r).slice(7), kind: "receipt", day: path.basename(entry.cursor.file) === "receipts.jsonl" ? null : path.basename(entry.cursor.file, ".jsonl") });
    } catch { /* damaged line */ }
  }
  // Do not consume a snapshot we cannot fit; it remains discoverable on the next run.
  for (const s of saved.anchorable()) add({ fp: s.fingerprint.slice(7), kind: "snapshot", snapshot: s.id });
  return { todo, total, incomplete, cursor: incomplete ? cursor : null };
}

// ---- calendars ----

function reasonOf(e: unknown): string {
  if (e instanceof ots.OtsError) return "bad_answer";
  if (e instanceof FetchError) return e.code === "timeout" || e.code === "too_large" ? e.code : "network";
  return "refused"; // the address, port or the owner's never_visit stopped it before anything was sent
}

// One request through Tiresias's own fetcher: address and port checks, never_visit, byte counting, a timeout, and no
// redirect followed. Returns the body bytes exactly as received.
async function ask(url: string, body?: Buffer): Promise<{ status: number; raw: Buffer }> {
  const r = await safeFetch(url, {
    beforeRequest: async (u) => {
      const left = cooldownLeft(u.origin);
      if (left > 0) throw new Refused("The calendar asked Tiresias to wait (Retry-After).", undefined, left, u.href);
    },
    onHeaders: (hop) => {
      if (hop.status === 429 || hop.status === 503) setCooldown(hop.url.origin, hop.status, hop.headers.get("retry-after"));
    },
    method: body ? "POST" : "GET", ...(body ? { body } : {}),
    headers: { accept: OTS_ACCEPT, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    maxBytes: MAX_ANSWER, wireBytes: 64 * 1024, timeoutMs: 15_000, submit: true, keepRaw: true,
  });
  return { status: r.status, raw: r.raw ?? r.bytes ?? Buffer.alloc(0) };
}

// A pending attestation names the calendar to ask later. It was written by a calendar, so it is asked only when it is
// on the list: the owner's calendars, or the public ones the default pools hand out.
export function upgradeAllowed(uri: string, mine: string[]): boolean {
  const norm = uri.replace(/\/+$/, "");
  if (mine.includes(norm)) return true;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  return u.protocol === "https:" && !u.port && !u.username && !u.password && !u.search && !u.hash && (u.pathname === "/" || u.pathname === "") && PUBLIC_CALENDAR.test(u.hostname);
}

const hasBitcoin = (s: ots.Stamp): number[] => [...new Set(ots.attestations(s).flatMap((a) => (a.att.kind === "bitcoin" ? [a.att.height] : [])))].sort((a, b) => a - b);

// Every exported leaf prefixes two operations plus three per Merkle level. The longest path
// bounds both depth and added node count; reject an addition before it can damage an earlier proof.
function proofBytes(stamp: ots.Stamp, leaves: number): Buffer {
  const proof = ots.serialize(stamp, 2 + 3 * Math.ceil(Math.log2(leaves)));
  if (proof.length > MAX_OTS) throw new ots.OtsError("proof too large");
  return proof;
}

export interface UpgradeReport {
  batches: number; // pending batches looked at
  completed: number; // reached a Bitcoin block in this run
  still_pending: number;
  not_listed: number; // pending attestations naming a calendar not on the list (never asked)
  failed: number; // requests that failed or answered something unusable
  batches_not_checked: number; // batch files left beyond this run's scan/request budget
  requests_not_asked: number; // pending attestations left in a partially checked batch
  scan_incomplete: boolean;
}

async function upgradeAll(limits: ScanLimits = {}): Promise<UpgradeReport> {
  const rep: UpgradeReport = { batches: 0, completed: 0, still_pending: 0, not_listed: 0, failed: 0, batches_not_checked: 0, requests_not_asked: 0, scan_incomplete: false };
  const mine = loadCalendars();
  let budget = limits.upgradeRequests ?? MAX_UPGRADE_REQUESTS;
  const files = [...batchFiles()].sort();
  const cursor = continuation().upgrade;
  // A stable filename order, wrapping between runs; also resume WITHIN a batch with many attestations.
  const start = cursor ? files.findIndex((f) => path.basename(f) >= cursor.file) : 0;
  const at = start < 0 ? 0 : start;
  const ordered = [...files.slice(at), ...files.slice(0, at)];
  let next: Continuation["upgrade"] = null;
  let checked = 0;
  for (const file of ordered) {
    if (checked >= (limits.upgradeBatches ?? MAX_BATCHES) || budget <= 0) {
      next = { file: path.basename(file), att: cursor && path.basename(file) === cursor.file ? cursor.att : 0 };
      break;
    }
    checked++;
    const b = readBatch(file);
    if (!b || b.status !== "pending") continue;
    rep.batches++;
    const root = Buffer.from(b.id, "hex");
    let stamp: ots.Stamp;
    try {
      stamp = ots.parse(root, Buffer.from(b.ots, "base64"));
    } catch {
      rep.failed++;
      continue;
    }
    let changed = false;
    const pending = ots.attestations(stamp).filter((p) => p.att.kind === "pending");
    const first = cursor && path.basename(file) === cursor.file ? cursor.att : 0;
    for (let i = first; i < pending.length; i++) {
      const p = pending[i];
      if (p.att.kind !== "pending") continue;
      if (!upgradeAllowed(p.att.uri, mine)) {
        rep.not_listed++;
        continue;
      }
      if (budget <= 0) {
        next = { file: path.basename(file), att: i };
        rep.requests_not_asked = pending.length - i;
        break;
      }
      budget--;
      try {
        const r = await ask(`${p.att.uri.replace(/\/+$/, "")}/timestamp/${p.msg.toString("hex")}`);
        if (r.status === 404) continue;
        if (r.status !== 200) {
          rep.failed++;
          continue;
        }
        const up = ots.parse(p.msg, r.raw);
        const trial = ots.parse(root, ots.serialize(stamp));
        ots.merge([...ots.nodes(trial)].find((n) => n.msg.equals(p.msg))!, up);
        proofBytes(trial, b.leaves.length);
        stamp = trial;
        changed = true;
      } catch {
        rep.failed++;
      }
    }
    const heights = hasBitcoin(stamp);
    if (heights.length) rep.completed++;
    else rep.still_pending++;
    if (changed) {
      b.ots = ots.serialize(stamp).toString("base64");
      b.bitcoin = heights;
      b.status = heights.length ? "complete" : "pending";
      b.upgraded_at = new Date().toISOString();
      saveBatch(b);
    }
    if (next) break;
  }
  rep.batches_not_checked = files.length - checked;
  rep.scan_incomplete = next !== null;
  if (files.length) saveContinuation({ upgrade: next });
  return rep;
}

// ---- commands ----

function mayAnchor(): void {
  if (isPrivate()) throw new AnchorError("Private mode: nothing is anchored, and nothing is sent to a calendar.");
  if (loadAnchoringMode() !== "on") throw new AnchorError("Anchoring is off (the default). The owner can turn it on with: tiresias settings set anchoring on --confirm \"YES, TURN ON ANCHORING\"");
}

export interface AnchorReply {
  status: "ok" | "error";
  message: string;
  profile_batch?: { id: string; leaves: number; receipts: number; snapshots: number; calendars: CalendarResult[] };
  waiting?: number; // fingerprints left for the next run (over the batch cap)
  calendars?: CalendarResult[]; // when no calendar accepted
  upgrade: UpgradeReport;
  scan_incomplete?: boolean;
}

export async function upgrade(limits: ScanLimits = {}): Promise<{ status: "ok"; message: string; upgrade: UpgradeReport }> {
  mayAnchor();
  const u = await upgradeAll(limits);
  return { status: "ok", message: upgradeText(u), upgrade: u };
}
const upgradeText = (u: UpgradeReport): string =>
  (u.batches
    ? `${u.batches} pending batch(es) checked: ${u.completed} now in a Bitcoin block, ${u.still_pending} still pending${u.failed ? `, ${u.failed} calendar request(s) failed` : ""}${u.not_listed ? `, ${u.not_listed} naming a calendar not on the list (not asked)` : ""}.`
    : "No pending batches checked.") + (u.scan_incomplete ? ` Upgrade scan incomplete: ${u.batches_not_checked} batch file(s) not checked, ${u.requests_not_asked} pending request(s) not asked in the current batch; the next run resumes here.` : "");
// After a new batch: only earlier batches are worth a word (v0.9 rehearsal: "No pending batches." right after
// "It is pending" read as a contradiction).
const earlierText = (u: UpgradeReport): string => (u.batches || u.scan_incomplete ? ` Earlier batches: ${upgradeText(u)}` : "");

export async function run(limits: ScanLimits = {}): Promise<AnchorReply> {
  mayAnchor();
  const u = await upgradeAll(limits);
  const now = Date.now();
  const { todo, total, incomplete, cursor } = await gather(limits.receipts);
  const scanText = incomplete ? " Receipt scan incomplete; counts cover only this part of the log. Run anchor again to continue." : "";
  if (!todo.length) {
    saveContinuation({ receipts: cursor });
    return { status: "ok", message: `${incomplete ? "No new fingerprints in this part of the log." : "Nothing new to anchor."}${scanText} ${upgradeText(u)}`, scan_incomplete: incomplete, upgrade: u };
  }
  // A random order, so a proof's left and right steps say nothing about when its neighbours were recorded.
  for (let i = todo.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [todo[i], todo[j]] = [todo[j], todo[i]];
  }
  const leaves: Leaf[] = todo.map((c) => ({ fp: c.fp, kind: c.kind, salt: randomBytes(32).toString("hex"), ...(c.kind === "receipt" ? { day: c.day ?? null } : { snapshot: c.snapshot }) }));
  const levels = levelsOf(leafBuffers(leaves));
  const root = levels[levels.length - 1][0];
  const calendars = loadCalendars();
  const answers = await Promise.all(
    calendars.map(async (url): Promise<{ r: CalendarResult; stamp?: ots.Stamp }> => {
      try {
        const a = await ask(`${url}/digest`, root);
        if (a.status !== 200) return { r: { url, result: "failed", reason: `http_${a.status}` } };
        const stamp = ots.parse(root, a.raw);
        if (!ots.attestations(stamp).length) throw new ots.OtsError("no attestation");
        return { r: { url, result: "pending" }, stamp };
      } catch (e) {
        return { r: { url, result: "failed", reason: reasonOf(e) } };
      }
    }),
  );
  let combined = ots.newStamp(root);
  for (const a of answers) if (a.stamp) {
    try {
      const trial = combined.atts.length || combined.ops.length ? ots.parse(root, ots.serialize(combined)) : ots.newStamp(root);
      ots.merge(trial, a.stamp);
      proofBytes(trial, leaves.length);
      combined = trial;
    } catch {
      a.r = { url: a.r.url, result: "failed", reason: "bad_answer" };
    }
  }
  const results = answers.map((a) => a.r);
  const accepted = results.filter((r) => r.result === "pending").length;
  if (!accepted) return { status: "error", message: `No calendar accepted the batch, so nothing was anchored or written; the same ${todo.length} fingerprint(s) go in the next run.${scanText}${earlierText(u)}`, calendars: results, scan_incomplete: incomplete, upgrade: u };
  const proof = ots.serialize(combined);
  const b: Batch = {
    v: BATCH_VERSION, id: root.toString("hex"), profile: profileName(), created_at: new Date(now).toISOString(), leaves, ots: proof.toString("base64"),
    calendars: results, status: "pending", bitcoin: [], upgraded_at: null,
  };
  saveBatch(b);
  saveContinuation({ receipts: cursor });
  const receipts = leaves.filter((l) => l.kind === "receipt").length;
  const waiting = total - todo.length;
  return {
    status: "ok",
    message: `Anchored ${leaves.length} fingerprint(s) (${receipts} receipt record(s), ${leaves.length - receipts} snapshot(s)) in one batch; ${accepted} of ${calendars.length} calendar(s) accepted its root. It is pending until a calendar puts it in a Bitcoin block (usually a few hours): run tiresias anchor upgrade (or tiresias anchor) later.${waiting ? ` ${waiting} more wait for the next run.` : ""}${scanText}${earlierText(u)}`,
    scan_incomplete: incomplete,
    profile_batch: { id: b.id, leaves: leaves.length, receipts, snapshots: leaves.length - receipts, calendars: results },
    ...(waiting ? { waiting } : {}),
    upgrade: u,
  };
}

export interface BatchItem {
  id: string;
  created_at: string;
  leaves: number;
  status: "pending" | "complete";
  bitcoin: number[];
  calendars: CalendarResult[];
}
export async function status(page = 1, limits: ScanLimits = {}): Promise<{ status: "ok"; message: string; anchoring: string; calendars: string[]; not_yet_anchored: number; batches: BatchItem[]; total_batches: number; page: number; pages: number; scan_incomplete: boolean }> {
  const mode = loadAnchoringMode();
  const calendars = loadCalendars();
  const all: BatchItem[] = [];
  for (const b of batches()) all.push({ id: b.id, created_at: b.created_at, leaves: b.leaves.length, status: b.status, bitcoin: b.bitcoin, calendars: b.calendars });
  all.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || (a.id < b.id ? -1 : 1));
  const per = 20;
  const pages = Math.max(1, Math.ceil(all.length / per));
  const { total, incomplete } = await gather(limits.receipts);
  const pending = all.filter((b) => b.status === "pending").length;
  return {
    status: "ok",
    message: `Anchoring is ${mode}. ${all.length} batch(es): ${all.length - pending} in a Bitcoin block, ${pending} pending. ${total} fingerprint(s) not yet anchored${incomplete ? " in this part of the log (receipt scan incomplete; run anchor to continue)" : ""}.`,
    scan_incomplete: incomplete,
    anchoring: mode, calendars, not_yet_anchored: total, batches: all.slice((page - 1) * per, page * per), total_batches: all.length, page, pages,
  };
}

// ---- proofs ----

export interface Bundle {
  format: "tiresias-proof";
  v: 1;
  kind: LeafKind;
  fingerprint: string; // sha256:<hex>
  salt: string;
  path: Step[];
  root: string;
  batch: { id: string; created_at: string; profile: string; status: "pending" | "complete"; bitcoin: number[] };
  record: Record<string, unknown> | null; // the receipt line as recorded, or the snapshot's manifest; null when no longer kept
  ots: string; // base64: a detached .ots file whose file digest is the fingerprint
}

async function findReceipt(day: string | null, fp: string): Promise<Record<string, unknown> | null> {
  let found: Record<string, unknown> | null = null;
  const files = listLogs("receipts").filter((f) => f.day === day);
  for (const f of files) {
    await pageLog<Record<string, unknown>>(f.rel, (r) => {
      if (!found && r && typeof r === "object" && !Array.isArray(r) && saved.receiptFingerprint(r).slice(7) === fp) found = r;
      return false;
    });
    if (found) break;
  }
  return found;
}

export const recordBytes = (kind: LeafKind, record: Record<string, unknown>): Buffer =>
  kind === "receipt" ? Buffer.from(saved.canonical(record), "utf8") : saved.snapshotSignedBytes(record as never);

export async function prove(idArg: string): Promise<Bundle> {
  const id = idArg.trim().toLowerCase().replace(/^sha256:/, "");
  if (!/^[0-9a-f]{8,64}$/.test(id)) throw new AnchorError("A proof id is a receipt's fingerprint (from tiresias receipts) or a snapshot id: 8 to 64 hex characters, with or without sha256:.");
  const hits = new Map<string, { b: Batch; i: number }[]>();
  for (const b of batches())
    b.leaves.forEach((l, i) => {
      if (l.fp.startsWith(id) || (l.snapshot && l.snapshot.startsWith(id))) hits.set(l.fp, [...(hits.get(l.fp) ?? []), { b, i }]);
    });
  if (!hits.size) throw new AnchorError("That id is not in any batch of this profile. Run tiresias anchor first (with anchoring on), or check the id with tiresias receipts.");
  if (hits.size > 1) throw new AnchorError("That prefix matches more than one record. Give more characters.");
  const [fp, places] = [...hits][0];
  // A batch already in a Bitcoin block first, then the newest.
  places.sort((x, y) => (x.b.status === y.b.status ? Date.parse(y.b.created_at) - Date.parse(x.b.created_at) : x.b.status === "complete" ? -1 : 1));
  const { b, i } = places[0];
  const levels = levelsOf(leafBuffers(b.leaves));
  const root = levels[levels.length - 1][0];
  if (root.toString("hex") !== b.id) throw new AnchorError("This batch file is damaged (its leaves do not give its root). No proof was made.");
  const leaf = b.leaves[i];
  const steps = pathOf(levels, i);
  const fpBuf = Buffer.from(fp, "hex");
  const head = ots.newStamp(fpBuf);
  const end = ots.chain(head, pathOps(Buffer.from(leaf.salt, "hex"), steps));
  if (!end.msg.equals(root)) throw new AnchorError("This batch file is damaged. No proof was made.");
  let fromRoot: ots.Stamp;
  try {
    fromRoot = ots.parse(root, Buffer.from(b.ots, "base64"));
  } catch {
    throw new AnchorError("This batch's stored proof is damaged. No proof was made.");
  }
  end.atts = fromRoot.atts;
  end.ops = fromRoot.ops;
  let record: Record<string, unknown> | null = null;
  if (leaf.kind === "receipt") record = await findReceipt(leaf.day ?? null, fp);
  else {
    try {
      const m = saved.show(leaf.snapshot!).untrusted_content?.manifest;
      if (m && saved.snapshotFingerprint(m).slice(7) === fp) record = m as unknown as Record<string, unknown>;
    } catch {
      // the snapshot was deleted: the proof covers its fingerprint only
    }
  }
  return {
    format: "tiresias-proof", v: 1, kind: leaf.kind, fingerprint: `sha256:${fp}`, salt: leaf.salt, path: steps, root: b.id,
    batch: { id: b.id, created_at: b.created_at, profile: b.profile, status: b.status, bitcoin: b.bitcoin },
    record, ots: ots.fileBytes(fpBuf, head).toString("base64"),
  };
}

export function proveText(bd: Bundle): string {
  const what = bd.kind === "receipt" ? "receipt record" : "saved snapshot";
  const when = bd.batch.status === "complete" ? `Its batch is in Bitcoin block(s) ${bd.batch.bitcoin.join(", ")}.` : "Its batch is still pending (not in a Bitcoin block yet): run tiresias anchor upgrade later, then prove it again for a proof that needs no calendar.";
  return `A proof for this ${what} (batch of ${bd.batch.created_at}). ${when}${bd.record ? "" : ` The ${what} itself is no longer kept here; the proof covers its fingerprint, so whoever holds it can still check it.`}`;
}

// Write the bundle, the exact record bytes (whose SHA-256 is the fingerprint) and the .ots into a folder that exists.
// Never overwrites a file. Never in private mode (integration Codex round 1): the files hold a receipt, its URL or a
// snapshot's manifest, and private mode writes nothing anywhere.
export function writeBundle(bd: Bundle, folder: string, priv = false): string[] {
  if (priv || isPrivate()) throw new AnchorError("Private mode: nothing is written, so no proof files are made. Run it without --out to print the bundle.");
  const st = fs.statSync(folder);
  if (!st.isDirectory()) throw new AnchorError("--out takes a folder that already exists.");
  const name = `${bd.kind}-${bd.fingerprint.slice(7, 23)}`;
  const files: [string, Buffer][] = [[`${name}.proof.json`, Buffer.from(JSON.stringify(bd, null, 2) + "\n")]];
  if (bd.record) files.push([`${name}.json`, recordBytes(bd.kind, bd.record)]);
  files.push([`${name}.json.ots`, Buffer.from(bd.ots, "base64")]);
  folder = fs.realpathSync(folder);
  const written: string[] = [];
  const staged: { temp: string; final: string }[] = [];
  try {
    for (const [n, data] of files) {
      const temp = path.join(folder, `.${n}.${randomBytes(16).toString("hex")}.tmp`);
      const fd = fs.openSync(temp, "wx", 0o600);
      staged.push({ temp, final: path.join(folder, n) });
      try { fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); }
    }
    for (const f of staged) {
      fs.linkSync(f.temp, f.final); // exclusive publication: never replaces a file, directory or symlink
      written.push(f.final);
    }
  } catch (e) {
    for (const f of written) try { fs.unlinkSync(f); } catch { /* keep the first error */ }
    throw e;
  } finally {
    for (const f of staged) try { fs.unlinkSync(f.temp); } catch { /* already gone */ }
  }
  return written;
}

// ---- offline verification ----

type Check = "ok" | "mismatch" | "absent" | "unreadable";
// Codex v0.8 anchor round 1: an offline check never PROVES a time. Everything in a bundle comes from the bundle, so
// anyone can make one whose offline steps all pass, with an invented attestation. `offline_ok` says only that the
// bundle is consistent; `proven` is always false here: the time is proven only when the Bitcoin block header step
// (outside Tiresias) passes.
export interface VerifyReply {
  status: "ok";
  offline_ok: boolean;
  proven: false;
  message: string;
  notice: string;
  kind: LeafKind | null;
  fingerprint: string | null;
  steps: { record: Check; merkle: Check; ots: Check };
  needs: "bitcoin_block_header" | "upgrade" | null;
  untrusted_content: { attestations: ({ kind: "bitcoin"; height: number; merkle_root: string; merkle_root_as_shown: string } | { kind: "pending"; calendar: string } | { kind: "other"; tag: string })[] };
}

function bundleShape(x: unknown): x is Bundle {
  const b = x as Bundle;
  if (!b || typeof b !== "object" || b.format !== "tiresias-proof" || b.v !== 1 || (b.kind !== "receipt" && b.kind !== "snapshot")) return false;
  if (typeof b.fingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/.test(b.fingerprint) || typeof b.salt !== "string" || !HEX64.test(b.salt) || typeof b.root !== "string" || !HEX64.test(b.root)) return false;
  if (!Array.isArray(b.path) || b.path.length > 64 || !b.path.every((s) => s && (s.sibling === "left" || s.sibling === "right") && typeof s.hash === "string" && HEX64.test(s.hash))) return false;
  if (typeof b.ots !== "string" || b.ots.length > MAX_OTS * 2) return false;
  return b.record === null || (typeof b.record === "object" && !Array.isArray(b.record));
}

export function verifyBundle(file: string): VerifyReply {
  const reply: VerifyReply = {
    status: "ok", offline_ok: false, proven: false, message: "", notice: NOTICE, kind: null, fingerprint: null, steps: { record: "unreadable", merkle: "unreadable", ots: "unreadable" }, needs: null,
    untrusted_content: { attestations: [] },
  };
  let bd: unknown;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > MAX_BUNDLE) throw new Error("not a plain file of a sensible size");
      bd = JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    reply.message = "That file could not be read as a proof bundle (made by tiresias receipts prove).";
    return reply;
  }
  if (!bundleShape(bd)) {
    reply.message = "That file is not a Tiresias proof bundle (or it was changed into something that is not one). The bundle is the .proof.json file that tiresias receipts prove wrote.";
    return reply;
  }
  reply.kind = bd.kind;
  reply.fingerprint = bd.fingerprint;
  const fp = Buffer.from(bd.fingerprint.slice(7), "hex");
  // 1. the record gives the fingerprint
  if (bd.record === null) reply.steps.record = "absent";
  else {
    let got: string | null = null;
    try {
      got = bd.kind === "receipt" ? saved.receiptFingerprint(bd.record) : saved.snapshotFingerprint(bd.record as never);
    } catch {
      got = null;
    }
    reply.steps.record = got === bd.fingerprint ? "ok" : "mismatch";
  }
  // 2. salt and path give the root
  const root = Buffer.from(bd.root, "hex");
  reply.steps.merkle = fold(fp, Buffer.from(bd.salt, "hex"), bd.path).equals(root) ? "ok" : "mismatch";
  // 3. the .ots starts at the fingerprint and reaches the root. Only attestations BELOW the root count (Codex v0.8
  // anchor round 1): an attestation on another branch does not vouch for this root, salt and path.
  try {
    const f = ots.parseFile(Buffer.from(bd.ots, "base64"));
    const rootNodes = [...ots.nodes(f.stamp)].filter((n) => n.msg.equals(root));
    reply.steps.ots = f.digest.equals(fp) && rootNodes.length ? "ok" : "mismatch";
    const seen = new Set<string>();
    if (reply.steps.ots === "ok")
      for (const a of rootNodes.flatMap((n) => ots.attestations(n))) {
        const key = `${a.msg.toString("hex")}:${JSON.stringify(a.att)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (a.att.kind === "bitcoin") reply.untrusted_content.attestations.push({ kind: "bitcoin", height: a.att.height, merkle_root: a.msg.toString("hex"), merkle_root_as_shown: Buffer.from(a.msg).reverse().toString("hex") });
        else if (a.att.kind === "pending") reply.untrusted_content.attestations.push({ kind: "pending", calendar: a.att.uri });
        else reply.untrusted_content.attestations.push({ kind: "other", tag: a.att.tag });
      }
  } catch {
    reply.steps.ots = "unreadable";
  }
  const s = reply.steps;
  const btc = reply.untrusted_content.attestations.filter((a) => a.kind === "bitcoin") as { height: number; merkle_root_as_shown: string }[];
  reply.offline_ok = s.merkle === "ok" && s.ots === "ok" && s.record !== "mismatch" && reply.untrusted_content.attestations.length > 0;
  if (!reply.offline_ok) {
    if (s.merkle === "ok" && s.ots === "ok" && s.record !== "mismatch") {
      reply.message = "This proof does NOT check out: nothing below its root attests a time.";
      return reply;
    }
    const bad = (Object.keys(s) as (keyof typeof s)[]).filter((k) => s[k] === "mismatch" || s[k] === "unreadable");
    reply.message = `This proof does NOT check out: ${bad.map((k) => ({ record: "the record does not give the fingerprint (it was changed)", merkle: "the salt and Merkle path do not lead to the root", ots: "the timestamp proof does not start at the fingerprint or does not reach the root" })[k]).join("; ")}.`;
    return reply;
  }
  const rec = s.record === "absent" ? " The bundle holds no record, so this proves only the fingerprint; whoever holds the record can check it gives that fingerprint." : "";
  if (btc.length) {
    reply.needs = "bitcoin_block_header";
    const b0 = btc[0];
    reply.message = `NOT proven yet: the offline checks pass (the record gives the fingerprint, the salt and path lead to the root, and the timestamp proof leads from the root to a claimed Bitcoin block ${b0.height}), but anyone can make a bundle that passes these.${rec} The proof is only as good as the last step, which needs the outside world: block ${b0.height}'s header must have the Merkle root ${b0.merkle_root_as_shown} (as block explorers show it). The official tool does that check: ots verify <name>.json.ots (files from tiresias receipts prove --out), or look the block up on any block explorer. If it matches, the block's time is the proof's time.`;
  } else {
    reply.needs = "upgrade";
    reply.message = `NOT proven: the offline checks pass, but this proof is still pending (a calendar's promise, not yet in a Bitcoin block), and anyone can make a bundle that passes these checks.${rec} The owner can run tiresias anchor upgrade (usually a few hours after anchoring) and then tiresias receipts prove again for a proof that needs no calendar.`;
  }
  return reply;
}
