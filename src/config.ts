// SPDX-License-Identifier: Apache-2.0
// W-15: storage limits. An optional file `config.json` in the store folder.
// Absent means these defaults. A bad value is a clear error, never a guess.
import fs from "node:fs";
import path from "node:path";
import { releaseLock, stillOwned, takeLock } from "./ownedlock.js";
import { NOFOLLOW, NONBLOCK, home, ownFile, randomTmp, readOwnedText } from "./store.js";
// W-32 (v0.9): readers of a risky setting use the value in force (an unconfirmed loosening is held back).
import { clamp, inForceConfig, loadRecord } from "./confirm.js";
import { callContext, type CallContext } from "./context.js";

export interface Limits {
  keep_history_days: number;
  keep_receipts_days: number;
  keep_cache_days: number;
  max_disk_mb: number; // this profile's folder (W-18: not other profiles, not the shared cooldown log or safety/)
  keep_handoff_days: number; // W-06: how long a handoff ticket stays open
  keep_saved_days?: number; // W-28 (v0.8): how long a saved snapshot is kept
  max_saved_mb?: number; // W-28 (v0.8): the saved snapshots' own cap (not counted by max_disk_mb)
}

export const DEFAULT_LIMITS: Required<Limits> = { keep_history_days: 90, keep_receipts_days: 90, keep_cache_days: 30, max_disk_mb: 200, keep_handoff_days: 7, keep_saved_days: 90, max_saved_mb: 100 };

export { ConfigError } from "./errors.js";
import { ConfigError } from "./errors.js";

// N-07: request signing. `signature_agent` is the https URL where the key directory is hosted.
// `signature_agent_style` picks how the Signature-Agent header is written:
//   "quoted"     "https://example.com"                  (what Cloudflare accepts today; the default)
//   "dictionary" sig1="https://example.com";type=directory   (the current IETF draft)
export type AgentStyle = "quoted" | "dictionary";
const SIGNING_KEYS = ["signature_agent", "signature_agent_style"];
// W-19: Safe Browsing. `safe_browsing` (true or false, default true) and `web_risk_key_file` (a full
// path to the file holding WEB_RISK_API_KEY=, default ~/.config/tiresias/secrets.env).
const SAFETY_KEYS = ["safe_browsing", "web_risk_key_file"];

// W-21: the owner's scanner hook. Set only by the owner (tiresias scanner set, or by editing this file);
// nothing reachable over MCP reads, sets, changes or skips it.
export interface ScannerConfig {
  command: string[]; // [absolute path, ...arguments], run directly (no shell, no PATH lookup)
  timeout_seconds: number; // 1 to 60, default 10
  send_file: boolean; // also hand over the file itself (a quarantine copy), default false
}
const SCANNER_KEYS = new Set(["command", "timeout_seconds", "send_file"]);
const BAD_SCANNER = 'config.json: "scanner" must be {"command": ["/full/path/to/program", "arg", ...], "timeout_seconds": 1 to 60, "send_file": true or false}. Set it with: tiresias scanner set -- /full/path/to/program [args...]';
export function parseScanner(v: unknown): ScannerConfig {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ConfigError(BAD_SCANNER);
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!SCANNER_KEYS.has(k)) throw new ConfigError(BAD_SCANNER);
  const c = o.command;
  // The program is a full path: run directly, so no PATH and no shell decide what runs.
  if (!Array.isArray(c) || c.length < 1 || c.length > 32 || !c.every((x) => typeof x === "string" && x.length > 0 && x.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(x)))
    throw new ConfigError(BAD_SCANNER);
  if (!path.isAbsolute(c[0]) || c[0].split(/[\\/]/).includes("..")) throw new ConfigError(BAD_SCANNER);
  const t = Object.hasOwn(o, "timeout_seconds") ? o.timeout_seconds : 10;
  if (typeof t !== "number" || !Number.isSafeInteger(t) || t < 1 || t > 60) throw new ConfigError(BAD_SCANNER);
  const f = Object.hasOwn(o, "send_file") ? o.send_file : false;
  if (typeof f !== "boolean") throw new ConfigError(BAD_SCANNER);
  return { command: [...(c as string[])], timeout_seconds: t, send_file: f };
}

// W-26 (v0.7): the owner's translation hook. Built like the scanner: set only by the owner (tiresias translator
// set, or by editing this file); nothing reachable over MCP reads, sets or changes it. An agent may only ask, per
// read, for a translation into one language when the owner has set it.
export interface TranslatorConfig {
  command: string[]; // [absolute path, ...arguments], run directly (no shell, no PATH lookup); the source and target languages are added after them
  timeout_seconds: number; // 1 to 60, default 20
}
const TRANSLATOR_KEYS = new Set(["command", "timeout_seconds"]);
const BAD_TRANSLATOR = 'config.json: "translator" must be {"command": ["/full/path/to/program", "arg", ...], "timeout_seconds": 1 to 60}. Set it with: tiresias translator set -- /full/path/to/program [args...]';
export function parseTranslator(v: unknown): TranslatorConfig {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ConfigError(BAD_TRANSLATOR);
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!TRANSLATOR_KEYS.has(k)) throw new ConfigError(BAD_TRANSLATOR);
  const c = o.command;
  if (!Array.isArray(c) || c.length < 1 || c.length > 32 || !c.every((x) => typeof x === "string" && x.length > 0 && x.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(x)))
    throw new ConfigError(BAD_TRANSLATOR);
  if (!path.isAbsolute(c[0]) || c[0].split(/[\\/]/).includes("..")) throw new ConfigError(BAD_TRANSLATOR);
  const t = Object.hasOwn(o, "timeout_seconds") ? o.timeout_seconds : 20;
  if (typeof t !== "number" || !Number.isSafeInteger(t) || t < 1 || t > 60) throw new ConfigError(BAD_TRANSLATOR);
  return { command: [...(c as string[])], timeout_seconds: t };
}
// The translation hook of this profile, or null when none is set. A bad setting is a ConfigError.
export function loadTranslator(): TranslatorConfig | null {
  const o = inForceConfig();
  if (!o || !Object.hasOwn(o, "translator")) return null;
  return parseTranslator(o.translator);
}

// The whole config.json as an object (null when there is none). A bad file is a ConfigError.
function readConfigFile(): Record<string, unknown> | null {
  const raw = readOwnedText("config.json");
  if (raw === null) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new ConfigError("config.json in the Tiresias folder is not valid JSON.");
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) throw new ConfigError("config.json must be a JSON object.");
  return obj as Record<string, unknown>;
}

export function readConfigObject(): Record<string, unknown> | null {
  const snapshot = callContext.getStore()?.config;
  return snapshot ? snapshot.raw : readConfigFile();
}

export function snapshotConfig(): NonNullable<CallContext["config"]> {
  const raw = readConfigFile();
  const record = callContext.exit(() => loadRecord());
  return { raw, effective: clamp(raw, record.rec).obj, record };
}

// W-21: the scanner hook of this profile, or null when none is set. A bad setting is a ConfigError.
export function loadScanner(): ScannerConfig | null {
  const o = inForceConfig();
  if (!o || !Object.hasOwn(o, "scanner")) return null;
  return parseScanner(o.scanner);
}

export function parseSafeBrowsing(v: unknown): boolean {
  if (typeof v !== "boolean") throw new ConfigError('config.json: "safe_browsing" must be true or false.');
  return v;
}

// A plain full path: absolute, no ".." step, no control characters, at most 1,024 characters.
export function parseKeyFile(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 1024 || /[\u0000-\u001f\u007f]/.test(v) || !path.isAbsolute(v) || v.split(/[\\/]/).includes(".."))
    throw new ConfigError('config.json: "web_risk_key_file" must be a full path (absolute, without "..") to the file that holds WEB_RISK_API_KEY=.');
  return v;
}

// Only the Safe Browsing settings, read on their own like the signing ones. A bad value is an error
// (the caller fails the call loudly); a missing file or key means the defaults.
export function loadSafetyConfig(): { safe_browsing: boolean; web_risk_key_file?: string } {
  const o = inForceConfig();
  if (o === null) return { safe_browsing: true };
  return {
    safe_browsing: Object.hasOwn(o, "safe_browsing") ? parseSafeBrowsing(o.safe_browsing) : true,
    ...(Object.hasOwn(o, "web_risk_key_file") ? { web_risk_key_file: parseKeyFile(o.web_risk_key_file) } : {}),
  };
}

// https, no credentials, no fragment, no control characters or quotes (it goes inside a header).
export function parseSignatureAgent(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 2048) throw new ConfigError('config.json: "signature_agent" must be the https URL where your key directory is hosted, like "https://example.com".');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ConfigError('config.json: "signature_agent" is not a valid URL.');
  }
  if (u.protocol !== "https:") throw new ConfigError('config.json: "signature_agent" must start with https://.');
  if (u.username || u.password) throw new ConfigError('config.json: "signature_agent" must not contain a user name or password.');
  if (u.hash || v.includes("#")) throw new ConfigError('config.json: "signature_agent" must not contain a # fragment.');
  // Directory discovery names a site (an origin), not a page: a verifier ignores anything else.
  if (u.search || v.includes("?") || (u.pathname !== "/" && u.pathname !== "")) throw new ConfigError('config.json: "signature_agent" must be just the site, like "https://example.com" (no path or query). The directory is always found at /.well-known/http-message-signatures-directory on that site.');
  if (/[\u0000-\u001f\u007f"\\\s]/.test(v)) throw new ConfigError('config.json: "signature_agent" must not contain spaces, quotes or control characters.');
  return u.origin;
}

export function parseAgentStyle(v: unknown): AgentStyle {
  if (v === "quoted" || v === "dictionary") return v;
  throw new ConfigError('config.json: "signature_agent_style" must be "quoted" or "dictionary".');
}

// Only the signing settings, read on their own so that a bad storage-limit value never
// stops a read. Returns null when signing is not configured. A config file that exists
// but cannot be read at all is an error (the caller decides whether that matters).
export function loadSigningConfig(): { signature_agent: string; style: AgentStyle } | null {
  const o = readConfigObject();
  if (o === null) return null;
  if (!Object.hasOwn(o, "signature_agent")) return null;
  return { signature_agent: parseSignatureAgent(o.signature_agent), style: Object.hasOwn(o, "signature_agent_style") ? parseAgentStyle(o.signature_agent_style) : "quoted" };
}

export function loadLimits(): Limits {
  const obj = readConfigObject();
  if (obj === null) return { ...DEFAULT_LIMITS };
  const out: Limits = { ...DEFAULT_LIMITS };
  // Own properties only: "constructor", "toString" and "__proto__" are not settings.
  // (JSON.parse makes "__proto__" an ordinary own key, so entries() lists it and it is rejected.)
  for (const [k, v] of Object.entries(obj)) {
    if (SAFETY_KEYS.includes(k)) {
      if (k === "safe_browsing") parseSafeBrowsing(v);
      else parseKeyFile(v);
      continue;
    }
    if (SIGNING_KEYS.includes(k)) {
      if (k === "signature_agent") parseSignatureAgent(v);
      else parseAgentStyle(v);
      continue;
    }
    // W-21: the scanner is checked only where it is used (loadScanner), so a bad scanner setting never
    // stops a resume, the daily trim or clear (Codex round 58).
    // v0.6: "doors" and "sites" likewise (W-30, W-25): checked where they are used, never by clear or the trim.
    if (k === "scanner" || OWN_CHECK_KEYS.includes(k)) continue;
    if (!Object.hasOwn(DEFAULT_LIMITS, k)) throw new ConfigError(`config.json has an unknown setting "${k.slice(0, 60)}". Known settings: ${KNOWN_KEYS.join(", ")}.`);
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw new ConfigError(`config.json: "${k}" must be a whole number of 1 or more.`);
    out[k as keyof Limits] = v as number;
  }
  return out;
}

// ---- v0.6 (track 3: settings) ----

// Keys checked only where they are used (like "scanner"): a bad one fails the calls that use it, by name,
// and never stops clear or the daily trim.
const OWN_CHECK_KEYS = ["doors", "sites", "translator", "rendering", "saving", "anchoring", "anchor_calendars"]; // translator: v0.7 W-26; rendering: v0.7 W-10; saving: v0.8 W-28; anchoring, anchor_calendars: v0.8 W-08
export const KNOWN_KEYS = [...Object.keys(DEFAULT_LIMITS), ...SIGNING_KEYS, ...SAFETY_KEYS, "scanner", ...OWN_CHECK_KEYS];

// W-30: how a first read of a site treats the six door checks. "background" (the default): the page first,
// the checks afterwards, cached for the next read. "wait": every first read waits for them (v0.5.1).
export type DoorsMode = "background" | "wait";
export const DEFAULT_DOORS: DoorsMode = "background";
export function parseDoors(v: unknown): DoorsMode {
  if (v === "background" || v === "wait") return v;
  throw new ConfigError('config.json: "doors" must be "background" or "wait". Change it with: tiresias settings set doors background|wait');
}
// The default when config.json says nothing. TIRESIAS_DOORS_DEFAULT changes it only under Node's test runner
// (the v0.5.1 suite checks door answers on a first read; the v0.6 tests of background checks unset it).
export function defaultDoors(): DoorsMode {
  const v = process.env.TIRESIAS_DOORS_DEFAULT;
  return process.env.NODE_TEST_CONTEXT && (v === "wait" || v === "background") ? v : DEFAULT_DOORS;
}
export function loadDoorsMode(): DoorsMode {
  const o = readConfigObject();
  return o && Object.hasOwn(o, "doors") ? parseDoors(o.doors) : defaultDoors();
}

// W-28 (v0.8): whether a read may keep a snapshot. "off" (the default): never; "ask": when a read asks (`save`).
// Owner only: config.json or `tiresias settings set saving`. No environment variable overrides it, and nothing
// reachable over MCP reads or changes it.
export type SavingMode = "off" | "ask";
export const DEFAULT_SAVING: SavingMode = "off";
export function parseSaving(v: unknown): SavingMode {
  if (typeof v === "string" && (v.toLowerCase() === "off" || v.toLowerCase() === "ask")) return v.toLowerCase() as SavingMode;
  throw new ConfigError('"saving" must be "off" or "ask". Change it with: tiresias settings set saving off|ask');
}
export function loadSavingMode(): SavingMode {
  const o = inForceConfig();
  return o && Object.hasOwn(o, "saving") ? parseSaving(o.saving) : DEFAULT_SAVING;
}

// W-08 (v0.8): whether `tiresias anchor` may timestamp this profile's fingerprints on a public chain (OpenTimestamps).
// "off" (the default) or "on". Like `saving`: owner only (config.json or `tiresias settings set anchoring`), no
// environment variable overrides it, and nothing reachable over MCP reads or changes it.
export type AnchoringMode = "off" | "on";
export const DEFAULT_ANCHORING: AnchoringMode = "off";
export function parseAnchoring(v: unknown): AnchoringMode {
  if (typeof v === "string" && (v.toLowerCase() === "off" || v.toLowerCase() === "on")) return v.toLowerCase() as AnchoringMode;
  throw new ConfigError('"anchoring" must be "off" or "on". Change it with: tiresias settings set anchoring off|on');
}
export function loadAnchoringMode(): AnchoringMode {
  const o = inForceConfig();
  return o && Object.hasOwn(o, "anchoring") ? parseAnchoring(o.anchoring) : DEFAULT_ANCHORING;
}
// The calendars a batch root is submitted to: the four public ones the official OpenTimestamps client uses.
export const DEFAULT_CALENDARS = ["https://a.pool.opentimestamps.org", "https://b.pool.opentimestamps.org", "https://a.pool.eternitywall.com", "https://ots.btc.catallaxy.com"];
const CAL_LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
// 1 to 8 addresses, https only (plain http only for a loopback address under Node's test runner, for the fake
// calendars of the tests), no user name, query or fragment. Stored without a trailing "/".
export function parseCalendars(v: unknown): string[] {
  const bad = () => new ConfigError('"anchor_calendars" takes 1 to 8 https:// addresses, like https://a.pool.opentimestamps.org (comma-separated on the command line).');
  if (!Array.isArray(v) || v.length < 1 || v.length > 8) throw bad();
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string" || x.length > 200) throw bad();
    let u: URL;
    try {
      u = new URL(x);
    } catch {
      throw bad();
    }
    const testHttp = u.protocol === "http:" && !!process.env.NODE_TEST_CONTEXT && process.env.TIRESIAS_ALLOW_PRIVATE === "1" && CAL_LOOPBACK.has(u.hostname);
    if ((u.protocol !== "https:" && !testHttp) || u.username || u.password || u.search || u.hash || x.includes("?") || x.includes("#")) throw bad();
    const s = (u.origin + u.pathname).replace(/\/+$/, "");
    if (!out.includes(s)) out.push(s);
  }
  return out;
}
export function loadCalendars(): string[] {
  const o = inForceConfig();
  return o && Object.hasOwn(o, "anchor_calendars") ? parseCalendars(o.anchor_calendars) : DEFAULT_CALENDARS;
}

// W-29: write config.json with a change, keeping every other setting. Owner-only (the CLI). THE one writer of
// config.json: `scanner set` and `scanner off` use it too (Codex round 1), so no two writers ever race. Under the
// config lock (so two `settings set` runs never lose one another's change), checked as a whole by `check`
// BEFORE anything is written, then atomic: an exclusive temp file in the same folder, then a rename;
// mode 0600, never through a link. Returns what was written.
// `change` returning false means nothing changed: nothing is written (and no file is created).
// W-32 (v0.9): `after` runs under the same lock once the file is final (written, or left as it was), with what
// config.json now holds: the confirmation record (confirm.ts) is written there, so the two never race.
export function writeConfig(change: (o: Record<string, unknown>) => void | boolean, check: (o: Record<string, unknown>) => void = () => {}, after?: (now: Record<string, unknown>) => void): Record<string, unknown> {
  const file = path.join(home(), "config.json");
  const token = takeLock(file); // an owned lock (ownedlock.ts): never broken automatically
  if (!token) throw new ConfigError(busy(file));
  try {
    const before = readConfigObject() ?? {};
    const obj = structuredClone(before);
    if (change(obj) === false) {
      after?.(before);
      return before;
    }
    check(obj);
    const tmp = randomTmp(file);
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW | NONBLOCK, 0o600);
    try {
      ownFile(fd, tmp);
      const data = Buffer.from(JSON.stringify(obj, null, 2) + "\n");
      for (let off = 0; off < data.length; ) off += fs.writeSync(fd, data, off, data.length - off);
      fs.fsyncSync(fd);
    } catch (e) {
      fs.closeSync(fd);
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    fs.closeSync(fd);
    try {
      // Nobody broke the lock meanwhile (this process was not suspended past its stale age).
      if (!stillOwned(file, token)) throw new ConfigError(busy(file));
      fs.renameSync(tmp, file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    after?.(obj);
    return obj;
  } finally {
    releaseLock(file, token);
  }
}
// The lock is never cleared automatically (ownedlock.ts), so the message names the file and how to delete it.
const busy = (file: string) =>
  `config.json is being changed by another Tiresias command (it holds ${file}.lock). Try again in a moment. If no other Tiresias command is running, a command that crashed left the lock behind: delete it with  rm ${JSON.stringify(file + ".lock")}  and try again.`;
