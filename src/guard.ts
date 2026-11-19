// SPDX-License-Identifier: Apache-2.0
// W-38 (v1.2): the meaning check. Local mode's pattern list (aimedSignals in local.ts) sees only the shapes it
// knows. This check asks the owner's OWN embedding model how close a passage is in meaning to known planted
// instructions, against how close it is to ordinary page text:
//
//   score for a collection = (highest cosine to that collection) minus (highest cosine to any ordinary passage)
//
// Each collection (the starter, and each set the owner imports) has its own alarm line, and a passage above any
// one of them is marked, so adding a collection can only add marks (see calibration, below).
//
// Measured with EmbeddingGemma 2 (SPEC W-38): an attack library alone, with no ordinary library, caught 1 of 29
// planted tricks at 1 false alarm in 100, because the topic dominates the vector; the difference of the two
// libraries caught 28 of 29 with page style examples of the same tricks, and 19 of 29 when the library held other
// tricks only. Whole passages scored as well as sentence by sentence, so whole passages are scored.
//
// Off until the owner sets it up (tiresias guard setup), from the command line only. Tiresias bundles no model, the
// same stance as the scanner (W-21). Nothing reachable over MCP reads, sets, changes or triggers it, and nothing from
// the libraries (texts, scores, collection names) ever reaches a reply: a passage above a collection's line gets ONE more
// sign in local mode's own count, so it is warned (or withheld with a pattern sign) by the rules already there.
//
// The library lives in the profile's guard/ folder, under the store's usual checks: vectors as Float32 (unit
// length) in attacks.f32 and ordinary.f32, one metadata line per vector (collection, kind, a hash; no text) in
// attacks.jsonl and ordinary.jsonl, the owner's imported attack texts in imported.jsonl (so a rebuild for another
// model can embed them again), and meta.json, written last, with each collection's line, which rows belong to which
// collection, and the sizes and SHA-256 of both vector files. A
// reader that finds anything that does not add up treats the check as not run; it never fails a read.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate as yieldScoring } from "node:timers/promises";
import { ConfigError, GUARD_TIMEOUT, loadGuard, parseGuardUrl, readConfigObject, type GuardConfig } from "./config.js";
import { GUARD_PHRASE, asking, confirmedWrite, refusal, sq } from "./confirm.js";
import { LruMap } from "./lru.js";
import { isOwnerAddress } from "./guardnetwork.js";
import { NOFOLLOW, NONBLOCK, checkSub, home, ownFile, readBounded, readOwnedText, sessionPrivate, subDir, writeJson } from "./store.js";
import { EmbedError, MAX_BATCH, MAX_DIM, MAX_INPUT_CHARS, MIN_DIM, classify, embed, embedAll } from "./guardclient.js";
import { releaseLock, stillOwned, takeLock } from "./ownedlock.js";

export const GUARD_DIR = "guard";
const F = { meta: "meta.json", attacks: "attacks.f32", attackRows: "attacks.jsonl", imported: "imported.jsonl", ordinary: "ordinary.f32", ordinaryRows: "ordinary.jsonl" } as const;

// Bounds on what setup and import accept.
export const MIN_ORDINARY = 300; // ordinary passages, at least, to calibrate on
export const MIN_ORDINARY_PAGES = 20; // pages they come from, at least (the split is by page)
export const MIN_ABOVE_LINE = 2; // the pooled calibration passages must put at least this many at or above each line
export const MIN_ATTACKS = 100;
export const MAX_ORDINARY = 6_000;
export const MAX_PER_PAGE = 40;
export const MAX_ATTACKS = 30_000;
export const MAX_IMPORT = 10_000; // texts in one import
export const MAX_IMPORT_BYTES = 32 * 1024 * 1024;
export const MIN_TEXT = 10;
export const MAX_TEXT = 4_000;
export const MIN_PASSAGE = 40; // characters: shorter page text is never sent (headings, labels, scraps)
export const MAX_PASSAGE = 2_000; // an ordinary passage is cut here when gathered
export const SECTIONS_PER_PAGE = 4; // setup reads the first few sections of each ordinary page
export const MAX_URLS = 1_000;
export const DEFAULT_FALSE_ALARMS = 1;
export const SELF_TEST_FLOOR = 1 / 3; // below this share of unseen starter tricks caught, setup warns
export const IMPORT_FLOOR = 0.1; // an import that marks under this share of starter texts on its own adds little for page text
const SETUP_TIMEOUT_MS = 120_000; // one batch during setup, import or check (a model may be loading)
// The prefix the 2026-11-14 measurements used for EmbeddingGemma: it is a default only, and --prefix always wins.
export const GEMMA_PREFIX = "task: classification | query: ";
export const defaultPrefix = (model: string): string => (/embeddinggemma/i.test(model) ? GEMMA_PREFIX : "");

// ---- the package's own data ----

const dataFile = (name: string) => fileURLToPath(new URL(`../data/${name}`, import.meta.url));
export const STARTER_KINDS = ["override", "fake_system", "fake_user", "fake_tool", "fake_assistant", "chat_marks", "send_out", "reply_shape", "favour", "task_changed", "fake_rule", "urgency", "persona", "secrecy", "conditional"] as const;
export interface StarterText {
  text: string;
  kind: string;
}
// The starter set shipped in data/guard-starter.jsonl: test strings for this detector, written for Tiresias.
export function starter(): StarterText[] {
  const out: StarterText[] = [];
  for (const line of fs.readFileSync(dataFile("guard-starter.jsonl"), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const o = JSON.parse(line) as StarterText;
    if (typeof o.text !== "string" || !(STARTER_KINDS as readonly string[]).includes(o.kind)) throw new Error("data/guard-starter.jsonl has a bad line.");
    out.push({ text: o.text, kind: o.kind });
  }
  return out;
}
export const bundledUrlList = () => dataFile("guard-ordinary-urls.txt");

// ---- hashing and the vectors ----

// One text's identity: whitespace folded, so the same text copied twice counts once.
export const textHash = (t: string) => createHash("sha256").update(t.trim().replace(/\s+/g, " ")).digest("hex").slice(0, 32);
const fileHash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const toBuffer = (vs: Float32Array[], dim: number): Buffer => {
  const b = Buffer.alloc(vs.length * dim * 4);
  vs.forEach((v, i) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).copy(b, i * dim * 4));
  return b;
};
const toMatrix = (b: Buffer): Float32Array => {
  const copy = new ArrayBuffer(b.length);
  new Uint8Array(copy).set(b);
  return new Float32Array(copy);
};

// The highest dot product of v with any row of m (rows of length dim), skipping rows `skip` says to.
// `start` and `count` limit it to a run of rows.
function maxDot(v: Float32Array, m: Float32Array, dim: number, skip?: (row: number) => boolean, start = 0, count = m.length / dim - start): number {
  let best = -Infinity;
  for (let r = start; r < start + count; r++) {
    if (skip?.(r)) continue;
    let s = 0;
    const o = r * dim;
    for (let i = 0; i < dim; i++) s += v[i] * m[o + i];
    if (s > best) best = s;
  }
  return best;
}

// ---- the library on disk ----

export interface SelfTest {
  unseen_caught: number; // starter texts the starter marks when their whole kind is left out
  starter: number;
  floor: number; // the share below which setup warns about the model
  weak: boolean;
  collections: Record<string, { starter_marked: number; adds_little: boolean }>; // each import, on its own
  import_floor: number; // the share of starter texts below which an import is said to add little
}
export interface Line {
  threshold: number;
  marked: number; // calibration passages above it
}
export interface Meta {
  v: 2;
  generation: string;
  built_at: string; // when setup built it
  updated_at: string; // when it was last changed (setup or import)
  model: string;
  prefix: string;
  dim: number;
  false_alarms: number; // the target, in percent of ordinary passages, for each collection's line
  lines: Record<string, Line>; // one alarm line per collection: "starter" and each import name
  segments: [string, number, number][]; // [collection, first row, rows]: which attack rows belong to which collection
  calibration: { passages: number; pages: number; per_page: number; any_marked: number };
  attacks: { count: number; sha256: string; starter: number; collections: Record<string, number> };
  ordinary: { count: number; sha256: string; pages: number; source: "urls" | "file"; pages_tried?: number; pages_failed?: number };
  self_test: SelfTest;
}
export interface Library {
  meta: Meta;
  attacks: Float32Array;
  ordinary: Float32Array;
  groups: Map<string, [number, number][]>;
}
interface AttackRow {
  c: string; // collection: "starter" or the owner's import name
  k: string | null; // kind (starter only)
  h: string;
}
interface OrdinaryRow {
  p: string; // the page it came from, as a hash
  h: string;
}
interface ImportedRow {
  c: string;
  h: string;
  t: string;
}

export class LibraryError extends Error {}
const MAX_META = 1024 * 1024;
const MAX_VECTORS_BYTES = 512 * 1024 * 1024;
const MAX_ROWS_BYTES = 64 * 1024 * 1024;

// v1.2 (L.7): guard commands share one owned lock beside the folder, including off. Network work holds no lock:
// the setting, file stamps and revision are compared again before committing. The revision survives off, so even
// off on an empty store cancels a setup that was already gathering text.
const REVISION = "guard-state.json";
function withGuardLock<T>(fn: () => T): T {
  const file = path.join(home(), GUARD_DIR);
  const token = takeLock(file);
  if (!token) throw new ConfigError(`The guard is being changed by another Tiresias command (${file}.lock). Try again in a moment. If no other Tiresias command is running, delete the abandoned lock with rm ${sq(file + ".lock")} and try again.`);
  try {
    if (!stillOwned(file, token)) throw new ConfigError("The guard lock was removed. Nothing was written.");
    return fn();
  } finally {
    releaseLock(file, token);
  }
}
function guardState(): string {
  const dir = subDir(GUARD_DIR, false);
  let effective: GuardConfig | null | undefined;
  try {
    effective = loadGuard(isOwnerAddress);
  } catch {
    // Setup can repair a bad setting; its raw value below still participates in the comparison.
  }
  const stamps = Object.values(F).map((name) => {
    if (!dir) return null;
    try {
      const s = fs.lstatSync(path.join(dir, name));
      return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.mode];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  });
  return JSON.stringify([readConfigObject()?.guard, effective, readOwnedText(REVISION), stamps]);
}
function unchangedGuard(state: string): void {
  let same = false;
  try {
    same = guardState() === state;
  } catch {
    // A setting or folder that became unreadable is also a change, never permission to replace it.
  }
  if (!same) throw new ConfigError("The guard setting or library changed while this command was running. Nothing was written. Run the command again if you still want this change.");
}
const advanceGuard = () => writeJson(path.join(home(), REVISION), randomBytes(16).toString("hex"));

// v1.2 (L.8): never build a vector file the reader cannot load. Check the dimension before doing arithmetic.
function vectorBudget(dim: number, attacks: number, ordinary: number): void {
  if (!Number.isInteger(dim) || dim < MIN_DIM || dim > MAX_DIM) throw new ConfigError(`The embedding dimension must be from ${MIN_DIM} to ${MAX_DIM}. Nothing was changed.`);
  for (const [kind, count] of [["attack", attacks], ["ordinary", ordinary]] as const) {
    const bytes = count * dim * 4;
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(bytes) || bytes > MAX_VECTORS_BYTES)
      throw new ConfigError(`At dimension ${dim}, ${count} ${kind} vectors need ${bytes} bytes; the limit is ${MAX_VECTORS_BYTES} bytes (${Math.floor(MAX_VECTORS_BYTES / (dim * 4))} vectors). Nothing was changed.`);
  }
  if (attacks > MAX_ATTACKS) throw new ConfigError(`The attack library would have ${attacks} texts; the limit is ${MAX_ATTACKS}. Nothing was changed.`);
}

// Read one file of guard/: a plain file of ours, never through a link, bounded. Missing is null.
function readGuardFile(name: string, max: number): Buffer | null {
  const dir = subDir(GUARD_DIR, false);
  if (!dir) return null;
  const file = path.join(dir, name);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new LibraryError(`guard/${name} cannot be read.`);
  }
  try {
    ownFile(fd, file);
    const b = readBounded(fd, max);
    if (b === null) throw new LibraryError(`guard/${name} is larger than allowed.`);
    return b;
  } finally {
    fs.closeSync(fd);
  }
}

// Write one file of guard/ atomically: an exclusive temp file (never through a link), mode 0600, then a rename.
function writeGuardFile(name: string, data: Buffer): void {
  const dir = subDir(GUARD_DIR, true)!;
  const file = path.join(dir, name);
  const tmp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW | NONBLOCK, 0o600);
  try {
    ownFile(fd, tmp);
    for (let off = 0; off < data.length; ) off += fs.writeSync(fd, data, off, data.length - off);
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

const jsonl = (rows: unknown[]) => Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
function readRows<T>(name: string): T[] {
  const b = readGuardFile(name, MAX_ROWS_BYTES);
  if (!b) return [];
  const out: T[] = [];
  for (const line of b.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      throw new LibraryError(`guard/${name} is damaged.`);
    }
  }
  return out;
}

// meta.json's format. Version 1 (one shared threshold) is not loaded: an import could only weaken it, so a library
// built by that version reads as "not run" until guard setup builds it again.
export const META_VERSION = 2;
function parseMeta(b: Buffer): Meta {
  let m: Meta;
  try {
    m = JSON.parse(b.toString("utf8")) as Meta;
  } catch {
    throw new LibraryError("guard/meta.json is damaged.");
  }
  if (m && typeof m === "object" && (m as { v?: unknown }).v !== META_VERSION)
    throw new LibraryError("The guard library was built by an older version of Tiresias, with one alarm line for every collection. Run tiresias guard setup again to rebuild it.");
  const ok = m && typeof m.model === "string" && typeof m.prefix === "string" && Number.isInteger(m.dim) && m.dim >= MIN_DIM && m.dim <= MAX_DIM &&
    Number.isInteger(m.attacks?.count) && Number.isInteger(m.ordinary?.count) && m.attacks.count > 0 && m.ordinary.count > 0 &&
    typeof m.attacks.sha256 === "string" && typeof m.ordinary.sha256 === "string" && typeof m.generation === "string" &&
    m.lines && typeof m.lines === "object" && Array.isArray(m.segments);
  if (!ok) throw new LibraryError("guard/meta.json is damaged.");
  // The segments must cover every attack row once, in order, and every collection must have a finite line.
  let next = 0;
  for (const s of m.segments) {
    if (!Array.isArray(s) || typeof s[0] !== "string" || s[1] !== next || !Number.isInteger(s[2]) || s[2] < 1) throw new LibraryError("guard/meta.json is damaged.");
    const line = Object.hasOwn(m.lines, s[0]) ? m.lines[s[0]] : undefined;
    if (!line || typeof line.threshold !== "number" || !Number.isFinite(line.threshold)) throw new LibraryError("guard/meta.json is damaged.");
    next += s[2];
  }
  if (next !== m.attacks.count) throw new LibraryError("guard/meta.json is damaged.");
  return m;
}

// Runs of attack rows that belong to one collection, from the rows in order.
export function segmentsOf(rows: { c: string }[]): [string, number, number][] {
  const out: [string, number, number][] = [];
  rows.forEach((r, i) => {
    const last = out.at(-1);
    if (last && last[0] === r.c) last[2]++;
    else out.push([r.c, i, 1]);
  });
  return out;
}
const groupsOf = (segments: [string, number, number][]): Map<string, [number, number][]> => {
  const g = new Map<string, [number, number][]>();
  for (const [c, start, count] of segments) (g.get(c) ?? g.set(c, []).get(c)!).push([start, count]);
  return g;
};

// The library, checked whole: every size must add up and both vector files must match the fingerprints meta.json
// recorded. Every backing file is checked on each use, and any change reloads the library (a long-lived MCP
// server sees a rebuild or an import without a restart).
let cached: { key: string; stamp: string; lib: Library } | null = null;
function stampOf(): { key: string; stamp: string } | null {
  const dir = subDir(GUARD_DIR, false);
  if (!dir) return null;
  const stamps: string[] = [];
  for (const name of Object.values(F)) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(path.join(dir, name));
    } catch {
      throw new LibraryError("The guard library is incomplete.");
    }
    if (!st.isFile() || (process.getuid && st.uid !== process.getuid())) throw new LibraryError(`guard/${name} is not a plain file owned by you.`);
    stamps.push(`${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.uid}:${st.gid}:${st.mode}`);
  }
  return { key: dir, stamp: stamps.join(";") };
}
export function loadLibrary(): Library | null {
  const s = stampOf();
  if (!s) return null;
  if (cached && cached.key === s.key && cached.stamp === s.stamp) return cached.lib;
  const mb = readGuardFile(F.meta, MAX_META);
  if (!mb) return null;
  const meta = parseMeta(mb);
  const a = readGuardFile(F.attacks, MAX_VECTORS_BYTES);
  const o = readGuardFile(F.ordinary, MAX_VECTORS_BYTES);
  if (!a || !o) throw new LibraryError("The guard library is incomplete.");
  if (a.length !== meta.attacks.count * meta.dim * 4 || o.length !== meta.ordinary.count * meta.dim * 4) throw new LibraryError("The guard library's sizes do not match.");
  if (fileHash(a) !== meta.attacks.sha256 || fileHash(o) !== meta.ordinary.sha256) throw new LibraryError("The guard library's files do not match its record.");
  const attackRows = readRows<AttackRow>(F.attackRows);
  const ordinaryRows = readRows<OrdinaryRow>(F.ordinaryRows);
  const imported = readRows<ImportedRow>(F.imported);
  const attackHashes = new Set(attackRows.map((r) => JSON.stringify([r.c, r.h])));
  if (attackRows.length !== meta.attacks.count || ordinaryRows.length !== meta.ordinary.count ||
      JSON.stringify(segmentsOf(attackRows)) !== JSON.stringify(meta.segments) ||
      imported.length !== meta.attacks.count - meta.attacks.starter ||
      imported.some((r) => typeof r.t !== "string" || textHash(r.t) !== r.h || !attackHashes.has(JSON.stringify([r.c, r.h]))))
    throw new LibraryError("The guard library's records do not match its vectors.");
  const lib = { meta, attacks: toMatrix(a), ordinary: toMatrix(o), groups: groupsOf(meta.segments) };
  for (const m of [lib.attacks, lib.ordinary]) for (let i = 0; i < m.length; i++) if (!Number.isFinite(m[i])) throw new LibraryError("The guard library holds a number that is not finite.");
  cached = { key: s.key, stamp: s.stamp, lib };
  return lib;
}
export const forgetLibrary = () => {
  cached = null;
};

// The highest cosine to one collection (all its runs of rows).
const maxIn = (v: Float32Array, attacks: Float32Array, dim: number, runs: [number, number][], skip?: (row: number) => boolean): number => {
  let best = -Infinity;
  for (const [start, count] of runs) best = Math.max(best, maxDot(v, attacks, dim, skip, start, count));
  return best;
};
// A text is marked when, for ANY collection, (highest cosine to that collection) minus (highest cosine to ordinary
// text) is above that collection's own line. So a collection only ever adds marks: an import can never move the
// starter's line or take a mark away from it.
export function marked(v: Float32Array, lib: Library): boolean {
  const b = maxDot(v, lib.ordinary, lib.meta.dim);
  for (const [c, runs] of lib.groups) if (maxIn(v, lib.attacks, lib.meta.dim, runs) - b > lib.meta.lines[c].threshold) return true;
  return false;
}

// ---- calibration ----

// Every collection gets its own alarm line, set on ordinary text so that about `rate` percent of ordinary passages
// score above it. Two things keep the line steady:
//  - Two folds, split by PAGE (two passages of one page are alike, so a passage scored against its own page's other
//    passages would look safer than it is): each half's passages are scored against the other half as the ordinary
//    library, and the scores of both halves are pooled, so every passage counts once.
//  - At most CAL_PER_PAGE passages of one page (the first ones gathered) count when the line is set, so one page
//    full of instructions (a tutorial, say) cannot set the line on its own. Resampling the pages moved the
//    starter's 1% line between 0.024 and 0.042 with 40 passages a page, and between 0.0195 and 0.0235 with 12.
// Every gathered passage is still in the ordinary library at read time, where a passage meets more ordinary text
// than it did here, so the lines are slightly conservative (a little under the target rate of false alarms).
export const CAL_PER_PAGE = 12;
export const half = (page: string) => createHash("sha256").update(page).digest()[0] & 1;
// The rows that count for the lines: the first CAL_PER_PAGE of each page, in the order gathered.
export function calibrationRows(pages: string[]): number[] {
  const seen = new Map<string, number>();
  const out: number[] = [];
  pages.forEach((p, i) => {
    const n = seen.get(p) ?? 0;
    if (n < CAL_PER_PAGE) out.push(i);
    seen.set(p, n + 1);
  });
  return out;
}
// Each calibration passage's score against every collection, with the other fold as the ordinary library.
export function calScores(attacks: Float32Array, groups: Map<string, [number, number][]>, ordinary: Float32Array, pages: string[], dim: number): { rows: number[]; scores: Map<string, Float64Array> } {
  let side = pages.map(half);
  // A tiny library could put every page on one side; then the pages alternate instead.
  if (side.every((s) => s === side[0])) {
    const order = [...new Set(pages)];
    side = pages.map((p) => order.indexOf(p) % 2);
  }
  const fold = [0, 1].map((h) => {
    const idx = pages.map((_, i) => i).filter((i) => side[i] === h);
    const m = new Float32Array(idx.length * dim);
    idx.forEach((r, k) => m.set(ordinary.subarray(r * dim, (r + 1) * dim), k * dim));
    return m;
  });
  const rows = calibrationRows(pages);
  const scores = new Map([...groups.keys()].map((c) => [c, new Float64Array(rows.length)]));
  rows.forEach((r, k) => {
    const v = ordinary.subarray(r * dim, (r + 1) * dim);
    const b = maxDot(v, fold[1 - side[r]], dim);
    for (const [c, runs] of groups) scores.get(c)![k] = maxIn(v, attacks, dim, runs) - b;
  });
  return { rows, scores };
}
// The line that marks `rate` percent of the pooled scores (the k-th highest, so k - 1 score above it).
export function lineFor(scores: ArrayLike<number>, rate: number): Line {
  const k = Math.floor((scores.length * rate) / 100);
  if (k < MIN_ABOVE_LINE) throw new ConfigError(tooFew(scores.length, rate));
  const sorted = Array.from(scores).sort((x, y) => y - x);
  const threshold = sorted[k - 1];
  return { threshold, marked: Array.from(scores).filter((s) => s > threshold).length };
}
const tooFew = (n: number, rate: number) =>
  `Too few ordinary passages to calibrate at ${rate}% false alarms: ${n} count for the lines (at most ${CAL_PER_PAGE} from each page), and it needs at least ${Math.ceil((MIN_ABOVE_LINE * 100) / rate)}. Gather more ordinary text (more pages with --ordinary-urls, or a larger --ordinary file), or allow a higher --false-alarms.`;

// The owner's own numbers for their model. The starter: of its texts, how many it still marks at its own line when
// their whole kind of trick is left out (a trick it has never seen). Each imported collection: how many starter
// texts it marks on its own at its own line, which says whether it knows tricks planted in pages at all.
export function selfTest(lib: { attacks: Float32Array; ordinary: Float32Array; dim: number; lines: Record<string, Line>; groups: Map<string, [number, number][]> }, rows: AttackRow[]): SelfTest {
  let caught = 0;
  let n = 0;
  const per: Record<string, { starter_marked: number; adds_little: boolean }> = {};
  const counts = new Map<string, number>();
  const starterRuns = lib.groups.get("starter") ?? [];
  for (let r = 0; r < rows.length; r++) {
    if (rows[r].c !== "starter") continue;
    n++;
    const kind = rows[r].k;
    const v = lib.attacks.subarray(r * lib.dim, (r + 1) * lib.dim);
    const b = maxDot(v, lib.ordinary, lib.dim);
    if (maxIn(v, lib.attacks, lib.dim, starterRuns, (x) => rows[x].k === kind) - b > lib.lines.starter.threshold) caught++;
    for (const [c, runs] of lib.groups) if (c !== "starter" && maxIn(v, lib.attacks, lib.dim, runs) - b > lib.lines[c].threshold) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  for (const c of lib.groups.keys()) if (c !== "starter") per[c] = { starter_marked: counts.get(c) ?? 0, adds_little: (counts.get(c) ?? 0) < n * IMPORT_FLOOR };
  return { unseen_caught: caught, starter: n, floor: SELF_TEST_FLOOR, weak: n > 0 && caught < n * SELF_TEST_FLOOR, collections: per, import_floor: IMPORT_FLOOR };
}
// The lines, what each marks among the calibration passages, the honest total, and the self-test, in words.
export function libraryText(m: Meta): string {
  const cal = m.calibration;
  const lines = Object.entries(m.lines).map(([c, l]) => `${c} ${l.threshold.toFixed(4)} (marks ${l.marked} of ${cal.passages})`).join(", ");
  const t = m.self_test;
  const imports = Object.entries(t.collections).map(([c, x]) =>
    x.adds_little
      ? ` The collection "${c}" adds little for text planted in pages: on its own it marks ${x.starter_marked} of ${t.starter} starter texts, and it still adds false alarms.`
      : ` On its own the collection "${c}" marks ${x.starter_marked} of ${t.starter} starter texts.`).join("");
  return `Alarm lines, one per collection, each set for ${m.false_alarms}% false alarms on ${cal.passages} ordinary calibration passages (at most ${cal.per_page} a page): ${lines}. Marked by any collection: ${cal.any_marked} of ${cal.passages}.` +
    ` Self-test: the starter marks ${t.unseen_caught} of ${t.starter} of its own texts when their kind of trick is left out (a trick it has never seen).` +
    (t.weak ? ` That is under ${Math.round(t.floor * 100)}% of them: this embedding model separates planted instructions from ordinary text poorly, so the check will add little.` : "") +
    imports;
}
// ---- gathering ordinary text ----

interface Passage {
  text: string;
  page: string; // a hash naming the page
}
const pageKey = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const say = (line: string) => process.stderr.write(`guard: ${line}\n`);

function readOwnerFile(file: string, max: number, what: string): string {
  let fd: number | undefined;
  try {
    let st: fs.Stats;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | NONBLOCK);
      st = fs.fstatSync(fd);
    } catch {
      throw new ConfigError(`${what}: ${file} does not exist.`);
    }
    if (!st.isFile()) throw new ConfigError(`${what}: ${file} is not a file.`);
    if (st.size > max) throw new ConfigError(`${what}: ${file} is larger than ${Math.round(max / 1024 / 1024)} MB.`);
    return fs.readFileSync(fd, "utf8");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The owner's own passages: one JSON object per line with "text", and "page" or "url" to group them by page.
// Without either, every 10 consecutive passages count as one page.
export function ordinaryFromFile(file: string): { passages: Passage[]; skipped: number } {
  const passages: Passage[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let n = 0;
  for (const [i, line] of readOwnerFile(file, MAX_IMPORT_BYTES, "--ordinary").split("\n").entries()) {
    if (!line.trim()) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      throw new ConfigError(`--ordinary: line ${i + 1} is not JSON. The file takes one {"text": "...", "page": "..."} object per line.`);
    }
    const r = o as { text?: unknown; page?: unknown; url?: unknown };
    if (!o || typeof o !== "object" || typeof r.text !== "string") throw new ConfigError(`--ordinary: line ${i + 1} has no "text". The file takes one {"text": "...", "page": "..."} object per line.`);
    const text = r.text.trim().slice(0, MAX_PASSAGE);
    const h = textHash(text);
    if (text.length < MIN_PASSAGE || seen.has(h) || passages.length >= MAX_ORDINARY) {
      skipped++;
      continue;
    }
    seen.add(h);
    const group = typeof r.page === "string" || typeof r.page === "number" ? String(r.page) : typeof r.url === "string" ? r.url : `block-${Math.floor(n / 10)}`;
    n++;
    passages.push({ text, page: pageKey(group) });
  }
  return { passages, skipped };
}

export function readUrlList(file: string): string[] {
  const urls: string[] = [];
  for (const line of readOwnerFile(file, 1024 * 1024, "--ordinary-urls").split("\n")) {
    const u = line.trim();
    if (!u || u.startsWith("#")) continue;
    if (!/^https?:\/\//i.test(u)) throw new ConfigError("--ordinary-urls: every line must be an http or https address (lines starting with # are comments).");
    if (urls.length >= MAX_URLS) break;
    if (!urls.includes(u)) urls.push(u);
  }
  return urls;
}

// v1.2 (F.1): only our fixed codes and words belong in setup's diagnostics, never a page's error body.
function ordinaryFailure(e: import("./types.js").Envelope): string {
  if (e.status === "ok" || e.status === "unchanged") return "no text";
  if (e.status === "wall") {
    const code = e.handoff?.reason;
    return `wall: ${code && ["bot_challenge", "captcha", "login_required", "forbidden", "owner_hand_off"].includes(code) ? code : "unreadable"}`;
  }
  if (e.status === "error") {
    if (/^No section [1-9][0-9]*\. This page has 0 sections\.$/.test(e.message ?? "")) return "no text";
    const http = /^The site answered HTTP ([1-5][0-9]{2})\.$/.exec(e.message ?? "");
    return http ? `error: HTTP ${http[1]}` : e.message === "The site took too long to answer." ? "error: timeout" : "error: unreadable";
  }
  if (e.status === "refused") return e.message?.includes("robots.txt") ? "refused: robots.txt" : "refused: not allowed";
  if (e.status === "payment_required") return "payment_required";
  if (e.status === "flagged") return "flagged";
  return "file_warning";
}
interface FailedPage { url: string; reason: string }

// Ordinary pages read through Tiresias's own engine, the normal honest way: robots.txt, waits, spacing, the cache
// and walls all apply, and the reads are in history like any other. The first few sections of each page give its
// passages. A page that fails is skipped and counted.
export async function ordinaryFromUrls(urls: string[], agent = "tiresias-guard-setup"): Promise<{ passages: Passage[]; tried: number; failed: number; failures: FailedPage[] }> {
  const engine = await import("./engine.js");
  const passages: Passage[] = [];
  const seen = new Set<string>();
  let failed = 0;
  const failures: FailedPage[] = [];
  for (const [i, url] of urls.entries()) {
    if (passages.length >= MAX_ORDINARY) break;
    const page = pageKey(url);
    let got = 0;
    let reason = "no text";
    for (let s = 1; s <= SECTIONS_PER_PAGE && got < MAX_PER_PAGE; s++) {
      let e;
      try {
        e = await engine.read(url, { section: s, page: 1 }, { agent });
      } catch {
        reason = "error: unreadable";
        break;
      }
      if (e.status !== "ok" && e.status !== "unchanged") {
        reason = ordinaryFailure(e);
        break;
      }
      const text = (e.untrusted_content as { section?: { text?: unknown } } | null)?.section?.text;
      if (typeof text !== "string") break;
      for (const para of text.split("\n\n")) {
        const t = para.trim().slice(0, MAX_PASSAGE);
        const h = textHash(t);
        if (t.length < MIN_PASSAGE || seen.has(h)) continue;
        seen.add(h);
        passages.push({ text: t, page });
        if (++got >= MAX_PER_PAGE || passages.length >= MAX_ORDINARY) break;
      }
    }
    if (!got) {
      failed++;
      failures.push({ url, reason });
    }
    say(`page ${i + 1} of ${urls.length}: ${url}: ${got ? `${got} passages` : `skipped (${reason})`}`);
  }
  return { passages, tried: urls.length, failed, failures };
}

// ---- the owner's commands (CLI only) ----

const PRIVATE = "Private mode: the meaning check is not changed, because a private session changes nothing.";
const NAME_RE = /^[a-z0-9-]{1,32}$/;

export interface SetupOptions {
  url?: string;
  model?: string;
  prefix?: string;
  falseAlarms?: string;
  timeout?: string;
  ordinary?: string;
  ordinaryUrls?: string;
  confirm?: string;
}
export function parseFalseAlarms(v: string | undefined): number {
  if (v === undefined) return DEFAULT_FALSE_ALARMS;
  const n = /^\d{1,2}(\.\d{1,2})?$/.test(v) ? Number(v) : NaN;
  if (!(n >= 0.1 && n <= 5)) throw new ConfigError("--false-alarms takes a percent from 0.1 to 5, like 1 or 0.5. The default is 1.");
  return n;
}
function parseTimeout(v: string | undefined): number {
  if (v === undefined) return GUARD_TIMEOUT;
  const n = /^\d{1,2}$/.test(v) ? Number(v) : NaN;
  if (!(n >= 1 && n <= 60)) throw new ConfigError("--timeout takes whole seconds from 1 to 60. The default is 4.");
  return n;
}
function embedFailed(e: unknown, when: string): never {
  if (e instanceof EmbedError) throw new ConfigError(`${when}: ${e.message} Check that the embedding model is loaded and that --url and --model are right.`);
  throw e;
}

// What setup needs before any page is read: the setting, and whether the address needs the typed confirmation.
async function plan(o: SetupOptions): Promise<{ cfg: GuardConfig; again: string }> {
  if (o.url === undefined || o.model === undefined) throw new ConfigError("Usage: tiresias guard setup --url http://localhost:1234/v1 --model <embedding model id> [--prefix \"...\"] [--false-alarms 1] [--ordinary <file.jsonl> | --ordinary-urls <file.txt>] [--timeout 4]");
  if (o.ordinary !== undefined && o.ordinaryUrls !== undefined) throw new ConfigError("Use --ordinary or --ordinary-urls, not both.");
  const url = parseGuardUrl(o.url, isOwnerAddress);
  const model = o.model.trim();
  if (!model || model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) throw new ConfigError("--model takes the embedding model's id, as your server lists it.");
  const prefix = o.prefix ?? defaultPrefix(model);
  if (prefix.length > 200 || /[\u0000-\u001f\u007f]/.test(prefix)) throw new ConfigError("--prefix takes at most 200 characters, with no control characters.");
  const timeout_seconds = parseTimeout(o.timeout);
  const again = `tiresias guard setup --url ${sq(url)} --model ${sq(model)}${o.prefix !== undefined ? ` --prefix ${sq(prefix)}` : ""}`;
  let where: "local" | "public";
  try {
    where = await classify(url);
  } catch (e) {
    return embedFailed(e, "The endpoint's address");
  }
  const cfg: GuardConfig = { url, model, prefix, timeout_seconds };
  if (where === "public") {
    if (new URL(url).protocol !== "https:") throw new ConfigError("Plain http to an address outside your network is refused: page text would cross the internet unencrypted. Use https, or an address on your own network.");
    // Checked here, before any page is read, so a missing phrase never costs a long gather; confirmedWrite checks it
    // again (against the confirmed state) when the setting is written.
    if (asking() && o.confirm !== GUARD_PHRASE && !alreadyPublic(url)) throw new ConfigError(`${refusal(GUARD_PHRASE, again)}  Why: ${url} is not on this machine or your network, so every passage a local read checks would be sent there.`);
    cfg.allow_public = true;
  }
  return { cfg, again };
}
function alreadyPublic(url: string): boolean {
  try {
    const g = loadGuard();
    return !!g && g.allow_public === true && g.url === url;
  } catch {
    return false;
  }
}

export interface SetupReport {
  status: "ok";
  message: string;
  guard: GuardConfig;
  library: ShowLibrary;
  seconds: number;
}

// guard setup: build (or rebuild) the libraries, calibrate, self-test, then write the setting.
export async function setup(o: SetupOptions, priv = sessionPrivate()): Promise<SetupReport> {
  if (priv) throw new ConfigError(PRIVATE);
  const failedPages: FailedPage[] = [];
  try {
    const started = Date.now();
    const rate = parseFalseAlarms(o.falseAlarms);
    const initial = withGuardLock(() => ({ state: guardState(), imported: safeImported() }));
    const { cfg, again } = await plan(o);
    // A first call tells us the model works and its dimension, before any page is read.
    let dim: number;
    try {
      dim = (await embed(cfg, [cfg.prefix + "A short test sentence about the weather."], { timeoutMs: SETUP_TIMEOUT_MS }))[0].length;
    } catch (e) {
      return embedFailed(e, "The first call to the endpoint");
    }
    // The attack library: the starter set, plus every collection the owner imported before (kept across rebuilds).
    const start = starter();
    const imported = initial.imported;
    vectorBudget(dim, start.length + imported.length, 0);
    // The ordinary library.
    let ordinary: Passage[];
    let source: Meta["ordinary"]["source"] = "urls";
    let tried: number | undefined;
    let failed: number | undefined;
    if (o.ordinary !== undefined) {
      source = "file";
      const r = ordinaryFromFile(o.ordinary);
      ordinary = r.passages;
      say(`${ordinary.length} ordinary passages from ${o.ordinary}${r.skipped ? ` (${r.skipped} skipped: short, repeated or over ${MAX_ORDINARY})` : ""}`);
    } else {
      const urls = readUrlList(o.ordinaryUrls ?? bundledUrlList());
      say(`reading ${urls.length} ordinary pages through Tiresias (robots.txt, waits and walls apply as usual)`);
      const r = await ordinaryFromUrls(urls);
      ordinary = r.passages;
      tried = r.tried;
      failed = r.failed;
      failedPages.push(...r.failures);
      say(`${ordinary.length} ordinary passages from ${r.tried - r.failed} pages; ${r.failed} pages skipped`);
    }
    const pages = new Set(ordinary.map((p) => p.page)).size;
    vectorBudget(dim, start.length + imported.length, ordinary.length);
    if (ordinary.length < MIN_ORDINARY || pages < MIN_ORDINARY_PAGES)
      throw new ConfigError(`Not enough ordinary text to calibrate: ${ordinary.length} passages from ${pages} pages, and setup needs at least ${MIN_ORDINARY} passages from at least ${MIN_ORDINARY_PAGES} pages. Nothing was changed.`);
    const counted = calibrationRows(ordinary.map((p) => p.page)).length;
    if (Math.floor((counted * rate) / 100) < MIN_ABOVE_LINE) throw new ConfigError(`${tooFew(counted, rate)} Nothing was changed.`);
    // Embed: attacks first, then ordinary text, in batches, with progress on standard error.
    const attackTexts = [...start.map((s) => s.text), ...imported.map((r) => r.t)];
    const rows: AttackRow[] = [...start.map((s) => ({ c: "starter", k: s.kind, h: textHash(s.text) })), ...imported.map((r) => ({ c: r.c, k: null, h: r.h }))];
    rowBudget(F.attackRows, rows);
    rowBudget(F.ordinaryRows, ordinary.map(p => ({ p: p.page, h: textHash(p.text) })));
    rowBudget(F.imported, imported);
    let av: Float32Array[];
    let ov: Float32Array[];
    try {
      say(`embedding ${attackTexts.length} attack texts`);
      av = await embedAll(cfg, attackTexts.map((t) => cfg.prefix + t), { timeoutMs: SETUP_TIMEOUT_MS, dim, progress: progress(attackTexts.length) });
      say(`embedding ${ordinary.length} ordinary passages`);
      ov = await embedAll(cfg, ordinary.map((p) => cfg.prefix + p.text), { timeoutMs: SETUP_TIMEOUT_MS, dim, progress: progress(ordinary.length) });
    } catch (e) {
      return embedFailed(e, "Embedding the libraries");
    }
    const attacks = toBuffer(av, dim);
    const ord = toBuffer(ov, dim);
    const now = new Date().toISOString();
    const meta = build(cfg, dim, rate, rows, toMatrix(attacks), toMatrix(ord), ordinary.map((p) => p.page), { built_at: now, source, pages, tried, failed });
    withGuardLock(() => {
      unchangedGuard(initial.state);
      // v1.2: confirmedWrite holds the config lock before any library file is replaced.
      confirmedWrite({ name: "guard" }, (x) => void (x.guard = cfg), () => {
        unchangedGuard(initial.state);
        advanceGuard();
        writeLibrary(meta, attacks, rows, ord, ordinary.map((p) => ({ p: p.page, h: textHash(p.text) })), imported);
      }, { confirm: o.confirm, again });
      forgetLibrary();
    });
    const lib = showLibrary(meta);
    return { status: "ok", message: `The meaning check is set up: ${meta.attacks.count} attack texts, ${meta.ordinary.count} ordinary passages from ${pages} pages. ${libraryText(meta)} It runs on local model mode's reads (tiresias mcp --local, tiresias read --local).`, guard: cfg, library: lib, seconds: Math.round((Date.now() - started) / 1000) };
  } finally {
    if (failedPages.length) say(`failed pages: ${failedPages.map((p) => `${p.url} (${p.reason})`).join(", ")}`);
  }
}
const progress = (total: number) => {
  let last = 0;
  return (done: number) => {
    if (done === total || done - last >= 256) {
      last = done;
      say(`  ${done} of ${total}`);
    }
  };
};

// Lines and self-test for these libraries, as meta.json records them. `keep` holds lines to leave as they are: an
// import sets the new collection's line, and leaves the others alone (the ordinary library is the same).
function build(cfg: GuardConfig, dim: number, rate: number, rows: AttackRow[], attacks: Float32Array, ordinary: Float32Array, pages: string[], g: { built_at: string; source: Meta["ordinary"]["source"]; pages: number; tried?: number; failed?: number }, keep: Record<string, Line> = {}): Meta {
  if (rows.filter((r) => r.c === "starter").length < MIN_ATTACKS) throw new ConfigError(`The starter library has fewer than ${MIN_ATTACKS} texts.`);
  const segments = segmentsOf(rows);
  const groups = groupsOf(segments);
  const cal = calScores(attacks, groups, ordinary, pages, dim);
  const lines: Record<string, Line> = {};
  for (const [c, sc] of cal.scores) {
    const kept = Object.hasOwn(keep, c) ? keep[c] : undefined;
    lines[c] = kept ? { threshold: kept.threshold, marked: Array.from(sc).filter((x) => x > kept.threshold).length } : lineFor(sc, rate);
  }
  let any = 0;
  for (let k = 0; k < cal.rows.length; k++) if ([...cal.scores].some(([c, sc]) => sc[k] > lines[c].threshold)) any++;
  const self = selfTest({ attacks, ordinary, dim, lines, groups }, rows);
  const collections: Record<string, number> = {};
  for (const r of rows) if (r.c !== "starter") collections[r.c] = (collections[r.c] ?? 0) + 1;
  return {
    v: META_VERSION,
    generation: randomBytes(8).toString("hex"),
    built_at: g.built_at,
    updated_at: new Date().toISOString(),
    model: cfg.model,
    prefix: cfg.prefix,
    dim,
    false_alarms: rate,
    lines,
    segments,
    calibration: { passages: cal.rows.length, pages: new Set(pages).size, per_page: CAL_PER_PAGE, any_marked: any },
    attacks: { count: rows.length, sha256: fileHash(Buffer.from(attacks.buffer, attacks.byteOffset, attacks.byteLength)), starter: rows.filter((r) => r.c === "starter").length, collections },
    ordinary: { count: pages.length, sha256: fileHash(Buffer.from(ordinary.buffer, ordinary.byteOffset, ordinary.byteLength)), pages: g.pages, source: g.source, ...(g.tried !== undefined ? { pages_tried: g.tried, pages_failed: g.failed } : {}) },
    self_test: self,
  };
}

function fileBudget(name: string, bytes: number, max: number): void {
  if (bytes > max) throw new ConfigError(`guard/${name} would need ${bytes} bytes; the limit is ${max} bytes. Nothing was changed.`);
}
// v1.2: count exactly the JSONL the reader will load, before embedding or replacing any library file.
function rowBudget(name: string, rows: unknown[]): void {
  let bytes = 0;
  for (const row of rows) bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
  fileBudget(name, bytes, MAX_ROWS_BYTES);
}
// Every file first, meta.json last: a reader in between treats a fingerprint mismatch as not run.
function writeLibrary(meta: Meta, attacks: Buffer, rows: AttackRow[], ordinary: Buffer | null, ordRows: OrdinaryRow[] | null, imported: ImportedRow[]): void {
  const files: [string, Buffer, number][] = [
    [F.attacks, attacks, MAX_VECTORS_BYTES], [F.attackRows, jsonl(rows), MAX_ROWS_BYTES],
    [F.imported, jsonl(imported), MAX_ROWS_BYTES],
    ...(ordinary ? [[F.ordinary, ordinary, MAX_VECTORS_BYTES] as [string, Buffer, number]] : []),
    ...(ordRows ? [[F.ordinaryRows, jsonl(ordRows), MAX_ROWS_BYTES] as [string, Buffer, number]] : []),
    [F.meta, Buffer.from(JSON.stringify(meta, null, 1) + "\n"), MAX_META],
  ];
  for (const [name, data, max] of files) fileBudget(name, data.length, max);
  for (const [name, data] of files) writeGuardFile(name, data);
}
function safeImported(): ImportedRow[] {
  try {
    const rows = readRows<ImportedRow>(F.imported);
    if (rows.some((r) => !r || typeof r.t !== "string" || typeof r.c !== "string" || typeof r.h !== "string"))
      throw new Error("invalid imported row");
    return rows;
  } catch {
    throw new ConfigError(`guard/${F.imported} cannot be read or has an invalid line. Nothing was changed.`);
  }
}

// The owner's own collection of known planted texts. A .jsonl (or .json) file takes one {"text": ...} object per
// line (other fields are ignored); any other file is plain text, one text per line. Texts shorter than 10 or longer
// than 4,000 characters are skipped, and so is any text the library already holds. Only the new texts are
// embedded, and the collection gets its own alarm line; the lines of the other collections stay as they were.
export interface ImportReport {
  status: "ok";
  message: string;
  collection: string;
  added: number;
  skipped: { duplicate: number; too_short: number; too_long: number; over_limit: number };
  library: ShowLibrary;
}
export async function importFile(file: string, name: string | undefined, priv = sessionPrivate()): Promise<ImportReport> {
  if (priv) throw new ConfigError(PRIVATE);
  const initial = withGuardLock(() => {
    const cfg = loadGuard(isOwnerAddress);
    if (!cfg) throw new ConfigError("The meaning check is not set up. Run tiresias guard setup first.");
    const imported = safeImported();
    return { cfg, lib: loadLibraryOrFail(), state: guardState(), rows: readRows<AttackRow>(F.attackRows), ordRows: readRows<OrdinaryRow>(F.ordinaryRows), imported };
  });
  const { cfg, lib, rows, ordRows } = initial;
  if (lib.meta.model !== cfg.model || lib.meta.prefix !== cfg.prefix) throw new ConfigError("The library was built for another model or prefix than the setting names. Run tiresias guard setup again first.");
  const base = path.basename(file).replace(/\.[^.]*$/, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  let collection = name ?? (base || "import");
  if (name === undefined) {
    for (let n = 2; collection === "starter" || Object.hasOwn(lib.meta.lines, collection); n++) {
      const suffix = `-${n}`;
      collection = (base || "import").slice(0, 32 - suffix.length) + suffix;
    }
  }
  if (!NAME_RE.test(collection) || collection === "starter") throw new ConfigError('--name takes 1 to 32 of a-z, 0-9 and "-" (not "starter").');
  if (Object.hasOwn(lib.meta.lines, collection)) throw new ConfigError("That collection name already exists. Pick another name with --name.");
  const raw = readOwnerFile(file, MAX_IMPORT_BYTES, "guard import");
  const asJson = /\.jsonl?$/i.test(file);
  const texts: string[] = [];
  for (const [i, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    if (!asJson) {
      texts.push(line.trim());
      continue;
    }
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      throw new ConfigError(`guard import: line ${i + 1} of the file is not JSON. A .jsonl file takes one {"text": "..."} object per line; any other file is read as plain text, one text per line. Nothing was imported.`);
    }
    if (!o || typeof o !== "object" || Array.isArray(o) || typeof (o as { text?: unknown }).text !== "string")
      throw new ConfigError(`guard import: line ${i + 1} of the file has no "text". Nothing was imported.`);
    texts.push((o as { text: string }).text.trim());
  }
  if (rows.length !== lib.meta.attacks.count) throw new LibraryError("The guard library's records do not match its vectors. Run tiresias guard setup again.");
  const have = new Set(rows.map((r) => r.h));
  const skipped = { duplicate: 0, too_short: 0, too_long: 0, over_limit: 0 };
  const fresh: { t: string; h: string }[] = [];
  for (const t of texts) {
    if (t.length < MIN_TEXT) skipped.too_short++;
    else if (t.length > MAX_TEXT) skipped.too_long++;
    else {
      const h = textHash(t);
      if (have.has(h)) skipped.duplicate++;
      else if (fresh.length >= MAX_IMPORT || rows.length + fresh.length >= MAX_ATTACKS) skipped.over_limit++;
      else {
        have.add(h);
        fresh.push({ t, h });
      }
    }
  }
  if (ordRows.length !== lib.meta.ordinary.count) throw new LibraryError("The guard library's records do not match its vectors. Run tiresias guard setup again.");
  vectorBudget(lib.meta.dim, rows.length + fresh.length, ordRows.length);
  const allRows = [...rows, ...fresh.map((f) => ({ c: collection, k: null, h: f.h }))];
  const imported = [...initial.imported, ...fresh.map((f) => ({ c: collection, h: f.h, t: f.t }))];
  rowBudget(F.attackRows, allRows);
  rowBudget(F.ordinaryRows, ordRows);
  rowBudget(F.imported, imported);
  let meta = lib.meta;
  if (fresh.length) {
    say(`embedding ${fresh.length} new texts`);
    let nv: Float32Array[];
    try {
      nv = await embedAll(cfg, fresh.map((f) => cfg.prefix + f.t), { timeoutMs: SETUP_TIMEOUT_MS, dim: lib.meta.dim, progress: progress(fresh.length) });
    } catch (e) {
      return embedFailed(e, "Embedding the new texts");
    }
    const attacks = Buffer.concat([Buffer.from(lib.attacks.buffer, lib.attacks.byteOffset, lib.attacks.byteLength), toBuffer(nv, lib.meta.dim)]);
    meta = build(cfg, lib.meta.dim, lib.meta.false_alarms, allRows, toMatrix(attacks), lib.ordinary, ordRows.map((r) => r.p), {
      built_at: lib.meta.built_at, source: lib.meta.ordinary.source, pages: lib.meta.ordinary.pages, tried: lib.meta.ordinary.pages_tried, failed: lib.meta.ordinary.pages_failed,
    }, lib.meta.lines);
    withGuardLock(() => {
      unchangedGuard(initial.state);
      advanceGuard();
      writeLibrary(meta, attacks, allRows, null, null, imported);
      forgetLibrary();
    });
  }
  const s = Object.values(skipped).reduce((a, b) => a + b, 0);
  return {
    status: "ok",
    message: `Imported ${fresh.length} texts into the collection "${collection}"${s ? `, skipped ${s} (${skipped.duplicate} already in the library, ${skipped.too_short} under ${MIN_TEXT} characters, ${skipped.too_long} over ${MAX_TEXT}, ${skipped.over_limit} over the limit)` : ""}.${fresh.length ? ` Its own alarm line is set; the other collections keep theirs. ${libraryText(meta)}` : ""}`,
    collection,
    added: fresh.length,
    skipped,
    library: showLibrary(meta),
  };
}

function loadLibraryOrFail(): Library {
  let lib: Library | null;
  try {
    lib = loadLibrary();
  } catch (e) {
    throw new ConfigError(`${(e as Error).message} Run tiresias guard setup again to rebuild it.`);
  }
  if (!lib) throw new ConfigError("The meaning check has no library. Run tiresias guard setup.");
  return lib;
}

// What show prints about the library: sizes, names the owner chose, numbers. Never a text from it.
export interface ShowLibrary {
  built_at: string;
  updated_at: string;
  model: string;
  prefix: string;
  dimension: number;
  false_alarms_percent: number;
  lines: Record<string, Line>; // each collection's alarm line and how many calibration passages it marks
  calibration: Meta["calibration"];
  attacks: { total: number; starter: number; collections: Record<string, number> };
  ordinary: { passages: number; pages: number; from: "urls" | "file"; pages_tried?: number; pages_failed?: number };
  self_test: SelfTest;
}
const showLibrary = (m: Meta): ShowLibrary => ({
  built_at: m.built_at,
  updated_at: m.updated_at,
  model: m.model,
  prefix: m.prefix,
  dimension: m.dim,
  false_alarms_percent: m.false_alarms,
  lines: m.lines,
  calibration: m.calibration,
  attacks: { total: m.attacks.count, starter: m.attacks.starter, collections: m.attacks.collections },
  ordinary: { passages: m.ordinary.count, pages: m.ordinary.pages, from: m.ordinary.source, ...(m.ordinary.pages_tried !== undefined ? { pages_tried: m.ordinary.pages_tried, pages_failed: m.ordinary.pages_failed } : {}) },
  self_test: m.self_test,
});

export function show(): { status: "ok"; message: string; guard: GuardConfig | null; library: ShowLibrary | null; problem?: string } {
  let cfg: GuardConfig | null = null;
  let problem: string | undefined;
  try {
    cfg = loadGuard(isOwnerAddress);
  } catch (e) {
    problem = (e as Error).message;
  }
  let lib: Library | null = null;
  try {
    lib = loadLibrary();
  } catch (e) {
    problem = `${(e as Error).message} Run tiresias guard setup again.`;
  }
  if (!problem && cfg && lib && (lib.meta.model !== cfg.model || lib.meta.prefix !== cfg.prefix)) problem = "The library was built for another model or prefix than the setting names, so the check does not run. Run tiresias guard setup again.";
  if (!problem && cfg && !lib) problem = "The setting is there but the library is not, so the check does not run. Run tiresias guard setup again.";
  const library = lib ? showLibrary(lib.meta) : null;
  const message = !cfg && !lib
    ? "The meaning check is not set up. Tiresias includes no model; set up your own with: tiresias guard setup --url http://localhost:1234/v1 --model <embedding model id>"
    : `${cfg ? `Meaning check: ${cfg.model} at ${cfg.url}${cfg.allow_public ? " (outside your network, confirmed)" : ""}, ${cfg.timeout_seconds} s per local read.` : "No guard setting (the library is still there)."}${library ? ` Library: ${library.attacks.total} attack texts (${library.attacks.starter} starter${Object.keys(library.attacks.collections).length ? `, ${Object.entries(library.attacks.collections).map(([k, n]) => `${n} ${k}`).join(", ")}` : ""}), ${library.ordinary.passages} ordinary passages from ${library.ordinary.pages} pages, built ${library.built_at}. ${libraryText(lib!.meta)}` : ""}${problem ? ` Problem: ${problem}` : ""}`;
  return { status: "ok", message, guard: cfg, library, ...(problem ? { problem } : {}) };
}

// guard check: score one text the owner gives. It prints whether it is marked, its score against each collection
// with that collection's line, and the collection and kind of the nearest library text, never that text.
export async function check(text: string): Promise<{ status: "ok"; message: string; marked: boolean; collections: { collection: string; score: number; line: number; marked: boolean }[]; nearest: { collection: string; kind: string | null }; pattern_signs: number }> {
  const cfg = loadGuard(isOwnerAddress);
  if (!cfg) throw new ConfigError("The meaning check is not set up. Run tiresias guard setup first.");
  const lib = loadLibraryOrFail();
  if (lib.meta.model !== cfg.model || lib.meta.prefix !== cfg.prefix) throw new ConfigError("The library was built for another model or prefix than the setting names. Run tiresias guard setup again.");
  const t = text.trim();
  if (!t) throw new ConfigError("Usage: tiresias guard check [--file <path> | <text>]");
  let vectors: Awaited<ReturnType<typeof textVectors>>;
  try {
    // v1.2: use local mode's whole-text chunks, limits and vectors, never a prefix prediction.
    vectors = await textVectors([t], cfg, lib, { private: true }, Date.now() + SETUP_TIMEOUT_MS);
  } catch (e) {
    return embedFailed(e, "The endpoint");
  }
  const rows = readRows<AttackRow>(F.attackRows);
  let best = -Infinity;
  let at = 0;
  const dim = lib.meta.dim;
  const per = [...lib.groups].map(([collection]) => ({ collection, score: -Infinity, line: lib.meta.lines[collection].threshold, marked: false }));
  for (const v of vectors.vec.values()) {
    for (let r = 0; r < lib.meta.attacks.count; r++) {
      let s = 0;
      for (let i = 0; i < dim; i++) s += v[i] * lib.attacks[r * dim + i];
      if (s > best) {
        best = s;
        at = r;
      }
    }
    const b = await timedMax(v, lib.ordinary, dim, vectors.time);
    for (const row of per) {
      row.score = Math.max(row.score, await timedCollectionScore(v, lib, lib.groups.get(row.collection)!, b, vectors.time));
      row.marked = row.score > row.line;
    }
  }
  const isMarked = per.some((x) => x.marked);
  const near = rows[at] ? { collection: rows[at].c, kind: rows[at].k } : { collection: "unknown", kind: null };
  const { aimedSignals } = await import("./local.js");
  const signs = aimedSignals(t);
  const n = signs + (isMarked ? 1 : 0);
  return {
    status: "ok",
    message: `${isMarked ? "Marked" : "Not marked"}: ${per.map((x) => `${x.collection} ${x.score.toFixed(4)} against its line ${x.line.toFixed(4)}${x.marked ? " (marked)" : ""}`).join(", ")}. Nearest library text: collection "${near.collection}"${near.kind ? `, kind ${near.kind}` : ""}. Pattern signs: ${signs}. In local mode this text would get ${n} sign${n === 1 ? "" : "s"}.`,
    marked: isMarked,
    collections: per,
    nearest: near,
    pattern_signs: signs,
  };
}

// guard off: the setting is removed, and the library with it (its vectors fit one model only, and imported.jsonl
// holds the owner's attack texts, which should not outlive the setting that uses them). Rebuild with guard setup.
export function off(priv = sessionPrivate()): { status: "ok"; message: string; removed_setting: boolean; removed_library: boolean } {
  if (priv) throw new ConfigError(PRIVATE);
  return withGuardLock(() => {
    // The folder is checked first: a link or someone else's folder throws here, before the setting or anything else
    // is touched.
    const dir = subDir(GUARD_DIR, false);
    advanceGuard();
    const o = readConfigObject();
    const had = !!o && Object.hasOwn(o, "guard");
    if (had) confirmedWrite({ name: "guard" }, (x) => void delete x.guard, () => {}, { again: "tiresias guard off" });
    let removed = false;
    if (dir && checkSub(dir)) {
      for (const name of fs.readdirSync(dir)) {
        const f = path.join(dir, name);
        if (fs.lstatSync(f).isFile()) fs.rmSync(f, { force: true });
      }
      fs.rmdirSync(dir);
      removed = true;
    }
    forgetLibrary();
    const message = had || removed
      ? `The meaning check is off.${had ? " The setting was removed." : ""}${removed ? " The library (vectors and your imported texts) was deleted; tiresias guard setup builds it again." : ""} Local reads use the pattern check alone.`
      : "The meaning check was not set up.";
    return { status: "ok", message, removed_setting: had, removed_library: removed };
  });
}

// ---- the check at read time ----

// A text above any collection's alarm line gets one more sign in local mode's count. Undefined: the check is not set
// up, and the reply is exactly what it would be without this feature. not_run: it is set up but could not run for
// this reply (the endpoint down or slow, a bad answer, a library that does not add up); the read goes on with the
// pattern check alone and the reply says so.
export type Meaning = { signs: ReadonlyMap<string, number> } | { not_run: true };
export const MAX_CHECKED = 128; // embedding inputs per reply, including chunks, in the order they are shown
// Vectors already computed, by hash of library generation, endpoint, model, prefix and text, in memory only
// (never on disk). A cached page read again does not call the endpoint again. Private reads neither use nor fill it.
const memo = new LruMap<string, Float32Array>(4_096);
const memoKey = (cfg: GuardConfig, generation: string, text: string) => createHash("sha256").update(JSON.stringify([generation, cfg.url, cfg.model, cfg.prefix, text])).digest("hex");

// v1.2: guard check and local reads share complete-text coverage, memoization and input bounds.
async function textVectors(texts: string[], cfg: GuardConfig, lib: Library, opts: { signal?: AbortSignal; private?: boolean }, deadline: number) {
  // v1.2: cover the whole displayed text, with 256 characters of overlap at chunk boundaries.
  // Count chunks against the same cap before any request, even when their vectors are memoized.
  const chunks = new Map<string, string[]>();
  const wanted = new Set<string>();
  const room = MAX_INPUT_CHARS - cfg.prefix.length;
  if (room <= 256) throw new ConfigError("The text exceeds the meaning check input limit; it was not checked.");
  for (const t of new Set(texts)) {
    const parts: string[] = [];
    for (let start = 0; start < t.length;) {
      let end = Math.min(start + room, t.length);
      if (end < t.length && /[\uD800-\uDBFF]/.test(t[end - 1]) && /[\uDC00-\uDFFF]/.test(t[end])) end--;
      const part = t.slice(start, end);
      parts.push(part);
      wanted.add(part);
      if (wanted.size > MAX_CHECKED) throw new ConfigError("The text exceeds the meaning check input limit; it was not checked.");
      if (end === t.length) break;
      start = end - 256;
      if (/[\uDC00-\uDFFF]/.test(t[start]) && /[\uD800-\uDBFF]/.test(t[start - 1])) start--;
    }
    chunks.set(t, parts);
  }
  const want = [...wanted];
  const vec = new Map<string, Float32Array>();
  const todo: string[] = [];
  for (const t of want) {
    const hit = opts.private ? undefined : memo.get(memoKey(cfg, lib.meta.generation, t));
    if (hit && hit.length === lib.meta.dim) vec.set(t, hit);
    else todo.push(t);
  }
  for (let i = 0; i < todo.length; i += MAX_BATCH / 2) {
    const left = deadline - Date.now();
    if (left <= 0) throw new ConfigError("The meaning check did not finish; this text was not checked.");
    const batch = todo.slice(i, i + MAX_BATCH / 2);
    const vs = await embed(cfg, batch.map((t) => cfg.prefix + t), { timeoutMs: left, signal: opts.signal, dim: lib.meta.dim });
    batch.forEach((t, k) => {
      vec.set(t, vs[k]);
      if (!opts.private) memo.set(memoKey(cfg, lib.meta.generation, t), vs[k]);
    });
  }
  const time: ScoringTime = { deadline, yieldAt: Date.now() + 8, signal: opts.signal };
  return { chunks, vec, time };
}

export async function meaningCheck(texts: string[], opts: { signal?: AbortSignal; private?: boolean } = {}): Promise<Meaning | undefined> {
  if (!texts.length) return undefined;
  let cfg: GuardConfig | null;
  try {
    cfg = loadGuard(isOwnerAddress);
  } catch {
    // config.json says something about the guard that does not parse: the owner meant it to run.
    try {
      const o = readConfigObject();
      return o && Object.hasOwn(o, "guard") ? { not_run: true } : undefined;
    } catch {
      return undefined; // a config.json that does not parse at all: the read itself reports it
    }
  }
  if (!cfg) return undefined;
  try {
    const lib = loadLibrary();
    if (!lib || lib.meta.model !== cfg.model || lib.meta.prefix !== cfg.prefix) return { not_run: true };
    const deadline = Date.now() + cfg.timeout_seconds * 1000;
    const { chunks, vec, time } = await textVectors(texts, cfg, lib, opts, deadline);
    const signs = new Map<string, number>();
    const marked = new Set<string>();
    for (const [t, v] of vec) if (await timedMarked(v, lib, time)) marked.add(t);
    for (const [t, parts] of chunks) if (parts.some(p => marked.has(p))) signs.set(t, 1);
    checkScoring(time);
    return { signs };
  } catch {
    return { not_run: true };
  }
}
export const clearMemo = () => memo.clear();

// v1.2 (L.9): keep each row's dot product in the same order, but bound the work between deadline checks.
// Yield after a short slice so cancellation and other reads can run even while a large library is scored.
interface ScoringTime {
  deadline: number;
  yieldAt: number;
  signal?: AbortSignal;
}
function checkScoring(time: ScoringTime): number {
  const now = Date.now();
  if (time.signal?.aborted || now >= time.deadline) throw new Error("Meaning check did not finish.");
  return now;
}
async function timedMax(v: Float32Array, matrix: Float32Array, dim: number, time: ScoringTime, start = 0, count = matrix.length / dim): Promise<number> {
  let best = -Infinity;
  const rows = Math.max(1, Math.floor(65_536 / dim));
  const end = start + count;
  for (let at = start; at < end; at += rows) {
    if (checkScoring(time) >= time.yieldAt) {
      await yieldScoring();
      time.yieldAt = checkScoring(time) + 8;
    }
    best = Math.max(best, maxDot(v, matrix, dim, undefined, at, Math.min(rows, end - at)));
  }
  checkScoring(time);
  return best;
}
async function timedMarked(v: Float32Array, lib: Library, time: ScoringTime): Promise<boolean> {
  const b = await timedMax(v, lib.ordinary, lib.meta.dim, time);
  for (const [c, runs] of lib.groups) {
    if (await timedCollectionScore(v, lib, runs, b, time) > lib.meta.lines[c].threshold) return true;
  }
  return false;
}

async function timedCollectionScore(v: Float32Array, lib: Library, runs: [number, number][], ordinary: number, time: ScoringTime): Promise<number> {
  let best = -Infinity;
  for (const [start, count] of runs) best = Math.max(best, await timedMax(v, lib.attacks, lib.meta.dim, time, start, count));
  return best - ordinary;
}
