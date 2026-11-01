// SPDX-License-Identifier: Apache-2.0
// W-19: Safe Browsing. Every URL a call is about to request (the asked URL, each redirect hop,
// robots.txt and discovery probes on a new host) is checked BEFORE anything is sent to it.
//
// Two sources:
// 1. Phishing.Database (MIT, no key), the default for everyone. Its active phishing domains list is
//    downloaded at most once a day (conditional, signed, honest user agent, 32 MB cap), normalized in
//    the worker, and kept as one file, safety/phishing-domains.txt (a JSON header line, then one host
//    per line, sorted). The list is unreviewed and kept up in spare time, so a match WARNS: status
//    `flagged`, nothing fetched, and the caller may go past it with allow_flagged.
// 2. Google Web Risk Lookup (bring your own key), optional. A hit is a hard stop that allow_flagged
//    does not override, because Google's lists are reviewed. Asked about every distinct URL a call
//    requests; names Tiresias would refuse (internal addresses, IP literals, single labels, private-use
//    suffixes) are never sent. Verdicts are cached in memory only.
//    The key never appears in any output, error, log or file Tiresias writes.
//
// The list host being down never blocks browsing: the last good copy is used for up to 7 days
// (`safety: "list_stale"`), and after that the call goes on as `safety: "unchecked"`.
import { assertSiteAllowed } from "./sites.js";
import { work } from "./lifetime.js";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ConfigError, loadSafetyConfig } from "./config.js";
import { ENV_PHRASE, envMayLoosen } from "./confirm.js";
import { FetchError, Flagged, SafeBrowsingError } from "./errors.js";
import { politeFetch } from "./fetcher.js";
import { callContext } from "./context.js";
import { indexList, lookup, type Indexed, type Normalized } from "./safelist.js";
import { runUntrusted } from "./sandbox.js";
import { READ_SLACK, Wire, assertPublicUrl, boundedGet, currentSignal, outsideCall, throwIfCancelled, type Gate } from "./safety.js";
import { DEFAULT_PROFILE, NOFOLLOW, NONBLOCK, ensureRoot, isPrivate, ownFile, profileName, randomTmp, rootDir, subDir } from "./store.js";
import { USER_AGENT, WEB_RISK_THREATS, type FlagCode, type SafetyCode } from "./types.js";

export const LIST_URL = "https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/master/phishing-domains-ACTIVE.txt";
export const LIST_SOURCE = "Phishing.Database";
export const LIST_MAX_BYTES = 32 * 1024 * 1024;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const REFRESH_MS = DAY; // a copy confirmed within a day is current
export const STALE_MAX_MS = 7 * DAY; // an older copy is used, marked list_stale, for up to 7 days
export const RETRY_AFTER_FAIL_MS = HOUR; // after a failed download, wait this long before trying again
const LIST_FILE = "phishing-domains.txt";
const ATTEMPT_FILE = "attempt.json";
const HEADER_MAX = 4096;

export const WEB_RISK_ENDPOINT = "https://webrisk.googleapis.com/v1/uris:search";
export const WEB_RISK_TIMEOUT_MS = 5000;
export const WR_CACHE_MAX = 10_000;
export const WR_HIT_MAX_MS = HOUR; // a hit is cached until its expireTime, at most an hour
export const WR_CLEAN_MS = 30 * 60_000; // a clean answer has no expireTime; cached 30 minutes
const WR_BODY_MAX = 64 * 1024;
const KEY_FILE_MAX = 4096;
const KEY_RE = /^[A-Za-z0-9_-]{10,200}$/;

// ---- test-only address overrides ----

// TIRESIAS_SAFETY_LIST_URL and TIRESIAS_WEB_RISK_ENDPOINT exist for the test suite only, so it can use a
// local server. Only this machine is accepted (host exactly 127.0.0.1, ::1 or localhost, http or https):
// anything else is refused loudly and nothing is sent, so a stray setting can never send the owner's
// key or checked URLs elsewhere, or swap the list's source (Codex round 41).
function overridable(envName: string, fallback: string): string {
  const raw = process.env[envName];
  if (raw === undefined || raw === "") return fallback;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SafeBrowsingError(`${envName} is not a valid URL.`);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (!loopback || (u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || u.hash)
    throw new SafeBrowsingError(`${envName} may only point at this machine (127.0.0.1, ::1 or localhost). It exists only for the test suite; unset it.`);
  return u.href;
}
export const listUrl = () => overridable("TIRESIAS_SAFETY_LIST_URL", LIST_URL);
export const webRiskEndpoint = () => {
  const e = overridable("TIRESIAS_WEB_RISK_ENDPOINT", WEB_RISK_ENDPOINT);
  if (new URL(e).search) throw new SafeBrowsingError("TIRESIAS_WEB_RISK_ENDPOINT must not have a query. It exists only for the test suite.");
  return e;
};

// ---- the stored list ----

interface Header {
  format: "tiresias-safety-list";
  v: 1;
  source: "phishing_database";
  url: string; // where it was downloaded from
  etag?: string;
  last_modified?: string;
  downloaded_at: string; // when this content was downloaded
  verified_at: string; // when the list host last confirmed it (a 200 or a 304)
  entries: number;
  rejected: number; // lines that were not a host name, left out
  suffix_entries?: number; // entries that are a public suffix (co.uk, github.io, ...): they flag only their own exact host (Codex rounds 41, 43)
}
interface Loaded {
  stamp: string;
  header: Header;
  ix: Indexed;
}
type ListRead = { state: "none" } | { state: "damaged" } | { state: "ok"; loaded: Loaded };
let memo: Loaded | null = null;

// The safety/ folder, validated like every store sub-folder. With create = false nothing is created.
function folder(create: boolean): string | null {
  try {
    return subDir("safety", create); // W-18: shared by every profile, at the store root
  } catch {
    throw new SafeBrowsingError("The safety/ folder in the Tiresias store cannot be used (it is a link, a file, someone else's, or cannot be created). Refusing to use it.");
  }
}

const validHeader = (h: unknown): h is Header => {
  const o = h as Header;
  return !!o && typeof o === "object" && o.format === "tiresias-safety-list" && o.v === 1 && typeof o.url === "string" &&
    typeof o.downloaded_at === "string" && typeof o.verified_at === "string" && !Number.isNaN(Date.parse(o.verified_at)) &&
    Number.isSafeInteger(o.entries) && o.entries >= 0 && (o.etag === undefined || typeof o.etag === "string") &&
    (o.last_modified === undefined || typeof o.last_modified === "string");
};

// Reads the stored list (kept in memory while the file is unchanged). Missing = none; anything
// wrong with its contents = damaged (used as no list, and replaced by the next download).
function readList(): ListRead {
  const d = folder(false);
  if (!d) return { state: "none" };
  const file = path.join(d, LIST_FILE);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { state: "none" } : { state: "damaged" };
  }
  try {
    ownFile(fd, file);
    const st = fs.fstatSync(fd);
    const stamp = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
    if (memo && memo.stamp === stamp) return { state: "ok", loaded: memo };
    if (st.size > LIST_MAX_BYTES + HEADER_MAX) return { state: "damaged" };
    const buf = Buffer.alloc(st.size);
    let n = 0;
    for (let r = -1; r !== 0 && n < buf.length; n += r) r = fs.readSync(fd, buf, n, buf.length - n, null);
    const nl = buf.subarray(0, Math.min(n, HEADER_MAX)).indexOf(10);
    if (nl < 0) return { state: "damaged" };
    let header: unknown;
    try {
      header = JSON.parse(buf.subarray(0, nl).toString("utf8"));
    } catch {
      return { state: "damaged" };
    }
    if (!validHeader(header)) return { state: "damaged" };
    const ix = indexList(buf.subarray(nl + 1, n));
    if (!ix || ix.entries !== header.entries) return { state: "damaged" };
    memo = { stamp, header, ix };
    return { state: "ok", loaded: memo };
  } catch {
    return { state: "damaged" }; // not a regular file, or someone else's
  } finally {
    fs.closeSync(fd);
  }
}

type Freshness = "current" | "stale" | "too_old";
function freshness(h: Header, now = Date.now()): Freshness {
  const age = now - Date.parse(h.verified_at);
  if (age >= 0 && age <= REFRESH_MS) return "current";
  if (age <= STALE_MAX_MS) return "stale"; // includes a clock that went back (age below 0): refresh, keep using it
  return "too_old";
}

function writeFileAtomic(d: string, name: string, parts: (string | Buffer)[]): void {
  const file = path.join(d, name);
  const tmp = randomTmp(file);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    try {
      for (const p of parts) {
        const b = typeof p === "string" ? Buffer.from(p) : p;
        for (let off = 0; off < b.length; ) off += fs.writeSync(fd, b, off, b.length - off);
      }
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    // A failed write or rename must not leave a temp file behind, outside the disk cap (Codex round 45).
    try {
      fs.unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw e;
  }
}

interface Attempt {
  at: string;
  ok: boolean;
}
function readAttempt(): Attempt | null {
  const d = folder(false);
  if (!d) return null;
  const file = path.join(d, ATTEMPT_FILE);
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    ownFile(fd, file);
    if (fs.fstatSync(fd).size > 1024) return null;
    const a = JSON.parse(fs.readFileSync(fd, "utf8")) as Attempt;
    return a && typeof a.at === "string" && typeof a.ok === "boolean" ? a : null;
  } catch {
    return null; // missing or damaged: as if there was no attempt
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
const writeAttempt = (ok: boolean) => {
  try {
    writeFileAtomic(folder(true)!, ATTEMPT_FILE, [JSON.stringify({ at: new Date().toISOString(), ok })]);
  } catch (e) {
    console.error(`Safe Browsing: could not record the list download attempt: ${e instanceof SafeBrowsingError ? e.message : "store error"}`);
  }
};

// Is a download due? Not when the stored copy was confirmed within a day, and not within an hour
// of a failed attempt (so a list host that is down is not asked on every call).
function due(now = Date.now()): boolean {
  const r = readList();
  if (r.state === "ok" && freshness(r.loaded.header, now) === "current") return false;
  const a = readAttempt();
  if (a && !a.ok) {
    const since = now - Date.parse(a.at);
    if (since >= 0 && since < RETRY_AFTER_FAIL_MS) return false;
  }
  return true;
}

export type RefreshOutcome = "updated" | "unchanged" | "failed" | "skipped";
export interface RefreshResult {
  outcome: RefreshOutcome;
  reason?: string; // fixed text
}
const DOWNLOAD_FAILED = "The list could not be downloaded (network error, refusal or bad answer from the list host). The last good copy, if any, is still used.";
const TOO_LARGE = `The list is larger than ${LIST_MAX_BYTES / 1024 / 1024} MB, the most Tiresias downloads. It was not used; the last good copy, if any, is still used.`;
const PARSE_FAILED = "The downloaded list could not be read in time or was not a list. The last good copy, if any, is still used.";
const EMPTY = "The downloaded list had no domains in it, so it was not used. The last good copy, if any, is still used.";
const STORE_FAILED = "The list was downloaded but could not be saved in the store.";
const PRIVATE_NO_DOWNLOAD = "Private mode: the list is not downloaded or saved (a private session creates nothing). A copy already on disk is still used.";
const NO_STORE = "safety: unchecked (the store root cannot be created; the phishing list was not downloaded).";
let warnedRoot: string | undefined;

let inflight: Promise<RefreshResult> | null = null;

// Download the list if it is due (or always, with force). One download at a time per process; calls
// that arrive meanwhile wait for it. Never throws for a list problem: browsing goes on without it.
// The download runs outside every call and always runs to completion under its own fixed timeouts
// (30 s download, the normal worker budget for parsing); it is never aborted. Each caller waits for it
// only until its own cancellation or deadline (Codex round 42). Accepted cost (Codex round 44): a CLI
// process whose call gave up during a stalled download may take up to that timeout to exit.
export async function ensureList(force = false): Promise<RefreshResult> {
  if (isPrivate()) return { outcome: "skipped", reason: PRIVATE_NO_DOWNLOAD };
  if (!force && !due()) return { outcome: "skipped" };
  if (!inflight) {
    const p = work(outsideCall(() => download(force))); // v0.6: process work, so an exit waits for (or cancels) it
    inflight = p;
    // Both outcomes handled here: a discarded .finally() chain would re-reject unhandled and end the
    // process even when the caller catches (Codex round 41).
    const clear = () => {
      if (inflight === p) inflight = null;
    };
    p.then(clear, clear);
  }
  const sig = currentSignal();
  if (!sig) return inflight;
  try {
    return await raceSignal(inflight, sig);
  } catch (e) {
    if (sig.aborted) throw new FetchError("The request was cancelled.", "cancelled");
    throw e;
  }
}

async function download(force: boolean): Promise<RefreshResult> {
  try {
    ensureRoot(); // Do not fetch a list we cannot keep. Unsafe existing stores still fail loudly.
  } catch (e) {
    if (!["EACCES", "EPERM", "EROFS", "ENOSPC"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
    if (warnedRoot !== rootDir()) {
      warnedRoot = rootDir();
      console.error(NO_STORE);
    }
    return { outcome: "skipped", reason: NO_STORE };
  }
  const r = readList();
  const url = listUrl();
  const old = r.state === "ok" && r.loaded.header.url === url ? r.loaded : null;
  const headers: Record<string, string> = {};
  if (old?.header.etag) headers["if-none-match"] = old.header.etag;
  if (old?.header.last_modified) headers["if-modified-since"] = old.header.last_modified;
  const failed = (reason: string): RefreshResult => {
    writeAttempt(false);
    console.error(`Safe Browsing: ${reason}`);
    return { outcome: "failed", reason };
  };
  let res;
  try {
    res = await politeFetch(url, {
      maxBytes: LIST_MAX_BYTES,
      timeoutMs: force ? 120_000 : 30_000,
      ...(Object.keys(headers).length ? { conditional: { url, headers } } : {}),
    });
  } catch (e) {
    return failed(e instanceof FetchError && e.code === "too_large" ? TOO_LARGE : DOWNLOAD_FAILED);
  }
  const now = new Date().toISOString();
  try {
    if (res.status === 304 && old && res.url === url) {
      const header: Header = { ...old.header, verified_at: now, etag: res.headers.get("etag") ?? old.header.etag };
      writeFileAtomic(folder(true)!, LIST_FILE, [JSON.stringify(header) + "\n", old.ix.buf]);
      writeAttempt(true);
      return { outcome: "unchanged" };
    }
  } catch {
    return failed(STORE_FAILED);
  }
  if (res.status !== 200) return failed(DOWNLOAD_FAILED);
  let n: Normalized;
  try {
    n = await runUntrusted<Normalized>({ op: "blocklist", body: res.body }, res.body.length);
  } catch {
    return failed(PARSE_FAILED);
  }
  if (!n || typeof n.text !== "string" || !Number.isSafeInteger(n.entries)) return failed(PARSE_FAILED);
  if (n.entries === 0) return failed(EMPTY);
  const header: Header = {
    format: "tiresias-safety-list", v: 1, source: "phishing_database", url,
    ...(res.headers.get("etag") ? { etag: res.headers.get("etag")!.slice(0, 200) } : {}),
    ...(res.headers.get("last-modified") ? { last_modified: res.headers.get("last-modified")!.slice(0, 100) } : {}),
    downloaded_at: now, verified_at: now, entries: n.entries, rejected: n.rejected, suffix_entries: n.suffix_entries,
  };
  try {
    writeFileAtomic(folder(true)!, LIST_FILE, [JSON.stringify(header) + "\n", Buffer.from(n.text, "latin1")]);
  } catch {
    return failed(STORE_FAILED);
  }
  writeAttempt(true);
  return { outcome: "updated" };
}

// ---- Google Web Risk ----

export interface WebRiskKey {
  key: string;
  from: "env" | "key_file";
}
const me = () => (typeof process.getuid === "function" ? process.getuid() : -1);
export const defaultKeyFile = () => path.join(os.homedir(), ".config", "tiresias", "secrets.env");

// The owner's Web Risk key: TIRESIAS_WEB_RISK_KEY, else WEB_RISK_API_KEY= in the key file. The file is
// read like other sensitive files: not a link, a regular file owned by this user, not readable or
// writable by group or others, opened non-blocking, at most 4 KB. Anything else is refused loudly.
// Error texts are fixed: they never hold the key or the file's contents.
export function webRiskKey(keyFile?: string): WebRiskKey | null {
  const env = process.env.TIRESIAS_WEB_RISK_KEY;
  if (env !== undefined && env !== "") {
    if (!KEY_RE.test(env.trim())) throw new SafeBrowsingError("TIRESIAS_WEB_RISK_KEY is set but does not look like an API key (10 to 200 letters, digits, - and _).");
    return { key: env.trim(), from: "env" };
  }
  // W-18: the default key file belongs to the `default` profile. Any other profile uses Web Risk only
  // when its own config.json names a key file (or TIRESIAS_WEB_RISK_KEY is set for the process).
  if (keyFile === undefined && profileName() !== DEFAULT_PROFILE) return null;
  const file = keyFile ?? defaultKeyFile();
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && keyFile === undefined) return null; // no default key file: Web Risk is off
    if (code === "ENOENT") throw new SafeBrowsingError(`The Web Risk key file named in config.json (web_risk_key_file) does not exist: ${file}`);
    if (code === "ELOOP") throw new SafeBrowsingError(`The Web Risk key file ${file} is a link. Refusing to read it; point to the real file.`);
    throw new SafeBrowsingError(`The Web Risk key file ${file} cannot be opened (${code ?? "error"}).`);
  }
  let text: string;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new SafeBrowsingError(`The Web Risk key file ${file} is not a regular file. Refusing to read it.`);
    if (me() !== -1 && st.uid !== me()) throw new SafeBrowsingError(`The Web Risk key file ${file} is owned by another user. Refusing to read it.`);
    if (st.mode & 0o077) throw new SafeBrowsingError(`The Web Risk key file ${file} can be read or changed by other users. Run: chmod 600 "${file}"`);
    if (st.size > KEY_FILE_MAX) throw new SafeBrowsingError(`The Web Risk key file ${file} is too large (over ${KEY_FILE_MAX} bytes) to be a key file.`);
    const buf = Buffer.alloc(KEY_FILE_MAX + 1);
    let n = 0;
    for (let r = -1; r !== 0 && n < buf.length; n += r) r = fs.readSync(fd, buf, n, buf.length - n, null);
    if (n > KEY_FILE_MAX) throw new SafeBrowsingError(`The Web Risk key file ${file} is too large (over ${KEY_FILE_MAX} bytes) to be a key file.`);
    text = buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    const m = /^WEB_RISK_API_KEY\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = m[1].trim().replace(/^(["'])(.*)\1$/, "$2");
    if (!KEY_RE.test(v)) throw new SafeBrowsingError(`WEB_RISK_API_KEY in ${file} does not look like an API key (10 to 200 letters, digits, - and _).`);
    return { key: v, from: "key_file" };
  }
  return null; // the file holds other secrets but no Web Risk key
}

type WebRiskAnswer = { state: "ok"; codes: FlagCode[] } | { state: "unavailable" };
const wrCache = new Map<string, { codes: FlagCode[]; until: number }>();
// W-18: verdicts are kept per profile (a profile can have its own key or none). One process serves one
// profile, so this only matters when a test or a library caller switches profiles in one process.
const wrKey = (url: string) => `${profileName()}\n${url}`;
export const clearWebRiskCache = () => wrCache.clear(); // for tests
export const webRiskCacheSize = () => wrCache.size; // for tests
export const webRiskForTest = (url: string, key: string, priv: boolean, signal: AbortSignal) => webRisk(url, key, priv, signal); // for tests
const THREATS = new Set<string>(WEB_RISK_THREATS);

function cancelled(): boolean {
  return !!currentSignal()?.aborted;
}

// Settles with `p`, or rejects as soon as `signal` aborts. `p` keeps a handler either way, so a late
// rejection of a stalled step (a DNS lookup that never returns) is never left unhandled.
function raceSignal<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) {
      p.then(() => {}, () => {});
      return stop();
    }
    signal.addEventListener("abort", stop, { once: true });
    p.then(
      (v) => (signal.removeEventListener("abort", stop), resolve(v)),
      (e) => (signal.removeEventListener("abort", stop), reject(e)),
    );
  });
}

// One Lookup API call. Not signed and not through the site fetcher: it is an API call to Google,
// not a visit. The request URL holds the key, so it is never logged or put in an error, and no
// error text from the network is ever kept. Redirects are refused (they would carry the key).
// Private calls neither read nor write the in-memory cache (memory shared between calls).
async function webRisk(url: string, key: string, priv: boolean, signal: AbortSignal): Promise<WebRiskAnswer> {
  const now = Date.now();
  if (!priv) {
    const c = wrCache.get(wrKey(url));
    if (c && c.until > now) return { state: "ok", codes: c.codes };
    if (c) wrCache.delete(wrKey(url));
  }
  const q = new URLSearchParams();
  q.append("uri", url);
  for (const t of ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE"]) q.append("threatTypes", t);
  q.append("key", key);
  // W-25 (v0.6; coordinator's decision after Codex round 8): Web Risk is an API call, not a site visit. A site's
  // spacing does not apply to it (cost: an owner cannot slow Web Risk calls with spacing_seconds); only
  // never_visit and hand_off do, checked here at send time, with nothing awaited between the check and the
  // request. Either one refuses the call (the owner said no: not "unavailable").
  assertSiteAllowed(new URL(webRiskEndpoint()));
  // W-10 (v0.7, Banks after Codex round 4): a lookup made for a render is charged to its byte budget, like robots.txt:
  // its whole read cap (the answer, at most WR_BODY_MAX, and its headers) is taken before anything is sent, never
  // waited for; when the budget cannot cover it, the request that needed it is refused as over budget (not "Web Risk
  // unavailable"). A cached verdict (above) costs nothing. What was not received is given back.
  const budget = callContext.getStore()?.renderBudget;
  // v0.7 (Codex round 5): capped and counted by the bytes its connection receives (safety.ts Wire), no redirects, no
  // decompression; the answer itself at most WR_BODY_MAX.
  const WIRE = WR_BODY_MAX + 64 * 1024;
  const COST = WIRE + READ_SLACK;
  if (budget && !budget.take(COST)) throw new FetchError("The render's byte budget is spent.", "budget");
  const wire = new Wire(WIRE);
  let parsed: unknown;
  try {
    const res = await boundedGet(`${webRiskEndpoint()}?${q}`, { "user-agent": USER_AGENT, accept: "application/json" }, WR_BODY_MAX, wire, signal);
    if (res.status !== 200 || !res.body) return { state: "unavailable" };
    parsed = JSON.parse(res.body.toString("utf8"));
  } catch (e) {
    if (e instanceof SafeBrowsingError) throw e; // a bad test endpoint setting: loud
    if (cancelled()) throw new FetchError("The request was cancelled.", "cancelled");
    return { state: "unavailable" }; // never keep the error (its text could hold the request URL); a timeout lands here too
  } finally {
    if (budget) budget.release(COST, wire.over ? COST : wire.total);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { state: "unavailable" };
  const threat = (parsed as { threat?: unknown }).threat;
  let codes: FlagCode[] = [];
  let until = now + WR_CLEAN_MS;
  if (threat !== undefined) {
    const t = threat as { threatTypes?: unknown; expireTime?: unknown };
    const types = Array.isArray(t?.threatTypes) ? t.threatTypes : [];
    // Google's threat type names are API constants, but only known ones reach the top level.
    const set = new Set<FlagCode>(types.map((x) => (typeof x === "string" && THREATS.has(x) ? (`web_risk:${x}` as FlagCode) : "web_risk:OTHER")));
    codes = set.size ? [...set] : ["web_risk:OTHER"]; // a threat with no readable type is still a threat
    const exp = typeof t?.expireTime === "string" ? Date.parse(t.expireTime) : NaN;
    until = Math.min(Number.isNaN(exp) ? now + 5 * 60_000 : exp, now + WR_HIT_MAX_MS);
  }
  if (!priv && until > now) {
    if (wrCache.size >= WR_CACHE_MAX) {
      for (const [k, v] of wrCache) if (v.until <= now) wrCache.delete(k);
      if (wrCache.size >= WR_CACHE_MAX) wrCache.delete(wrCache.keys().next().value!);
    }
    wrCache.set(wrKey(url), { codes, until });
  }
  return { state: "ok", codes };
}

// ---- settings and the per-call gate ----

export interface Settings {
  on: boolean;
  key: WebRiskKey | null;
}

// Safe Browsing settings for one call. A bad setting or an unsafe key file fails the call loudly
// (SafeBrowsingError); it never silently turns the check off.
export function settings(): Settings {
  const env = process.env.TIRESIAS_SAFE_BROWSING;
  let envOn: boolean | undefined;
  if (env !== undefined && env !== "") {
    if (/^(0|false|off|no)$/i.test(env.trim())) envOn = false;
    else if (/^(1|true|on|yes)$/i.test(env.trim())) envOn = true;
    else throw new SafeBrowsingError("TIRESIAS_SAFE_BROWSING must be 0 (off) or 1 (on).");
  }
  let cfg: ReturnType<typeof loadSafetyConfig>;
  try {
    cfg = loadSafetyConfig();
  } catch (e) {
    if (e instanceof ConfigError) throw new SafeBrowsingError(`Safe Browsing settings: ${e.message}`);
    throw new SafeBrowsingError("Safe Browsing settings: config.json cannot be read.");
  }
  // W-32 (v0.9): the variable turns the check off only with its phrase in TIRESIAS_CONFIRM (or confirmations off).
  if (envOn === false && cfg.safe_browsing && !envMayLoosen(ENV_PHRASE.safe_browsing)) envOn = undefined;
  if (envOn === false || !cfg.safe_browsing) return { on: false, key: null };
  const key = webRiskKey(cfg.web_risk_key_file);
  if (key) webRiskEndpoint(); // a bad test endpoint setting fails now, before anything is sent
  return { on: true, key };
}

const RANK: Record<Exclude<SafetyCode, "off">, number> = { checked: 0, list_stale: 1, web_risk_unavailable: 2, unchecked: 3 };

export interface CallSafety {
  code?: SafetyCode; // the weakest check of the call
  flags: Set<FlagCode>; // flags this call went past with allow_flagged
  check: Gate;
}

// Names that are never sent to Web Risk: IP literals, single-label names, and the private-use
// suffixes. They are still checked against the list and still get every address check when requested.
const PRIVATE_SUFFIXES = [".local", ".internal", ".lan", ".home.arpa", ".localhost"];
export function webRiskEligible(hostname: string): boolean {
  let h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (!h || net.isIP(h) || !h.includes(".")) return false;
  return !PRIVATE_SUFFIXES.some((x) => h.endsWith(x));
}

// The gate for one call. The list is checked once per host (it lists domains); Web Risk once per
// distinct URL (each redirect hop, robots.txt and probe included), with the in-memory cache keeping
// repeats free. Before any URL goes to Web Risk it must be eligible (above) and pass the same address
// checks the request would get (IP literal, DNS answer all public), so a name Tiresias would refuse
// is refused here and never reaches Google. Concurrent checks of one host or URL share one promise.
// `readOnly` (W-04 form_preview, Codex round 51): like private mode for the list: a copy already on disk
// is used, nothing is downloaded and no list or attempt file is written. Web Risk verdicts stay in memory.
export function makeGate(o: { allowFlagged: boolean; priv: boolean; readOnly?: boolean }): CallSafety {
  const s = settings();
  const hosts = new Map<string, Promise<{ usable: Loaded | null; hit: boolean }>>();
  const urls = new Map<string, Promise<void>>();
  let wrDown = false; // once Web Risk fails in a call, it is not asked again in that call (one timeout, not one per hop)
  const call: CallSafety = { flags: new Set(), check: async () => {} };
  const note = (c: SafetyCode) => {
    if (c === "off") call.code = "off";
    else if (call.code === undefined || call.code === "off" || RANK[c] > RANK[call.code]) call.code = c;
  };
  const listFor = async (u: URL) => {
    if (!o.readOnly) await ensureList();
    throwIfCancelled();
    const r = readList();
    const usable = r.state === "ok" && freshness(r.loaded.header) !== "too_old" ? r.loaded : null;
    return { usable, hit: usable ? lookup(usable.ix, u.hostname) : false };
  };
  const checkUrl = async (u: URL, key: string): Promise<void> => {
    let host = u.hostname.toLowerCase();
    if (host.endsWith(".")) host = host.slice(0, -1);
    let hp = hosts.get(host);
    if (!hp) {
      hp = listFor(u);
      hosts.set(host, hp);
    }
    const { usable, hit: listHit } = await hp;
    let wr: "none" | "ok" | "unavailable" = "none";
    let wrCodes: FlagCode[] = [];
    if (s.key && webRiskEligible(u.hostname)) {
      // One bounded timeout covers the whole Web Risk step, DNS check and request together, and the
      // call's own cancellation and deadline end it at once (Codex round 41).
      const outer = currentSignal();
      const signal = AbortSignal.any([AbortSignal.timeout(WEB_RISK_TIMEOUT_MS), ...(outer ? [outer] : [])]);
      let a: WebRiskAnswer = { state: "unavailable" };
      if (!wrDown) {
        try {
          // Refused here (SafetyError) or unresolvable (FetchError): nothing is sent to Google.
          await raceSignal(assertPublicUrl(u), signal);
        } catch (e) {
          if (!signal.aborted) throw e;
        }
        if (outer?.aborted) throw new FetchError("The request was cancelled.", "cancelled");
        if (!signal.aborted) a = await webRisk(key, s.key.key, o.priv, signal); // a stalled DNS answer leaves it unavailable
      }
      wr = a.state;
      if (a.state === "ok") wrCodes = a.codes;
      else wrDown = true;
    }
    throwIfCancelled();
    note(wr === "ok" ? "checked" : wr === "unavailable" ? (usable ? "web_risk_unavailable" : "unchecked") : !usable ? "unchecked" : freshness(usable.header) === "current" ? "checked" : "list_stale");
    if (wrCodes.length) throw new Flagged([...(listHit ? ["phishing_list"] : []), ...wrCodes], true, u.href);
    if (listHit) {
      if (!o.allowFlagged) throw new Flagged(["phishing_list"], false, u.href);
      call.flags.add("phishing_list");
    }
  };
  call.check = (u: URL) => {
    if (!s.on) {
      note("off");
      return Promise.resolve();
    }
    const key = u.href.split("#")[0];
    let p = urls.get(key);
    if (!p) {
      p = checkUrl(u, key);
      urls.set(key, p);
    }
    return p;
  };
  return call;
}

// ---- tiresias safety status | update ----

export interface SafetyStatus {
  status: "ok";
  message: string;
  safe_browsing: "on" | "off";
  problem?: string; // fixed text: a setting or key file Tiresias refuses
  list: {
    source: string;
    state: "current" | "stale" | "too_old" | "none" | "damaged";
    entries?: number;
    suffix_entries?: number; // list entries that are a public suffix: they flag only their own exact host
    downloaded_at?: string;
    verified_at?: string;
    age_hours?: number;
    last_attempt?: { at: string; ok: boolean };
  };
  web_risk: { configured: boolean; from?: "env" | "key_file"; note: string };
}

const WEB_RISK_NOTE =
  "When Web Risk is set up, every URL Tiresias checks is sent to Google (Lookup API). A Web Risk hit is a hard stop that allow_flagged does not override.";

export function status(): SafetyStatus {
  let on = true;
  let key: WebRiskKey | null = null;
  let problem: string | undefined;
  try {
    const s = settings();
    on = s.on;
    key = s.key;
  } catch (e) {
    problem = (e as Error).message;
  }
  const r = readList();
  const a = readAttempt();
  const list: SafetyStatus["list"] = { source: LIST_SOURCE, state: r.state === "ok" ? freshness(r.loaded.header) : r.state };
  if (r.state === "ok") {
    const h = r.loaded.header;
    Object.assign(list, { entries: h.entries, suffix_entries: h.suffix_entries ?? 0, downloaded_at: h.downloaded_at, verified_at: h.verified_at, age_hours: Math.round((Date.now() - Date.parse(h.verified_at)) / 360_000) / 10 });
  }
  if (a) list.last_attempt = a;
  return {
    status: "ok",
    message: problem
      ? "Safe Browsing is set up but cannot be used as set up; calls will fail until it is fixed (see problem)."
      : on
        ? `Safe Browsing is on. ${list.state === "current" ? "The list is current." : list.state === "stale" ? "The list could not be refreshed; the last good copy is used (list_stale)." : "No usable list yet: calls are marked unchecked until one is downloaded (tiresias safety update)."}`
        : "Safe Browsing is off (config.json safe_browsing: false, or TIRESIAS_SAFE_BROWSING=0).",
    safe_browsing: on ? "on" : "off",
    ...(problem ? { problem } : {}),
    list,
    web_risk: { configured: !!key, ...(key ? { from: key.from } : {}), note: WEB_RISK_NOTE },
  };
}

export async function update(): Promise<{ status: "ok" | "error"; message: string; outcome: RefreshOutcome; list: SafetyStatus["list"] }> {
  if (isPrivate() || /^(1|true)$/i.test(process.env.TIRESIAS_PRIVATE ?? ""))
    return { status: "error", message: PRIVATE_NO_DOWNLOAD, outcome: "skipped", list: status().list };
  let r: RefreshResult;
  try {
    r = await ensureList(true);
  } catch (e) {
    if (e instanceof SafeBrowsingError) return { status: "error", message: e.message, outcome: "failed", list: status().list };
    throw e;
  }
  const list = status().list;
  const message =
    r.outcome === "updated" ? `Downloaded ${LIST_SOURCE}: ${list.entries} domains.`
    : r.outcome === "unchanged" ? `${LIST_SOURCE} has not changed since ${list.downloaded_at} (${list.entries} domains). Marked as confirmed now.`
    : r.reason ?? DOWNLOAD_FAILED;
  return { status: r.outcome === "failed" ? "error" : "ok", message, outcome: r.outcome, list };
}
