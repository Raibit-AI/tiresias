// SPDX-License-Identifier: Apache-2.0
// W-32 (v0.9): risky settings need confirmation. Turning a risky setting ON or LOOSER takes an exact all-caps phrase
// naming it (`--confirm "YES, TURN ON SAVING"`); turning it off or stricter never does. Anyone may type the phrase,
// an agent included (Travis, 2026-10-31): it stops a setting being loosened by accident or in passing (page text
// telling an agent to run a command), and every change is recorded with who made it and shown in the next replies.
// It does not stop a fully fooled agent; the log makes that visible. Full design: docs/v0.9/confirm.md.
//
// The record of the last confirmed state is confirmations.json in the profile's folder. Every reader of a risky
// setting uses the value IN FORCE: config.json's value when it is not looser than the confirmed one, else the
// confirmed one (absent = the safe default). So a hand edit that loosens does nothing until it is confirmed, and
// replies say so. No record, or a record that cannot be read, means the defaults are confirmed (fail closed).
// Nothing reachable over MCP reads or changes a setting or a confirmation; MCP replies only carry the notice.
import fs from "node:fs";
import path from "node:path";
import { callContext } from "./context.js";
import { SECURITY_CHOICES, parseChoice, type SecurityChoice, DEFAULT_CALENDARS, parseAnchoring, parseCalendars, parseSafeBrowsing, parseSaving, parseScanner, parseTranslator, readConfigObject, writeConfig } from "./config.js";
import { parseRender } from "./render.js";
import { ConfigError } from "./errors.js";
import * as history from "./history.js";
import { candidates, DEFAULT_PORTS, MAX_CONFIRMED_SITES, MIN_SPACING_S, normalizeSite, parsePortList, parseSiteRule, parseSites } from "./sites.js";
import { NOFOLLOW, NONBLOCK, home, homeDir, ownFile, randomTmp, readOwnedText } from "./store.js";

export const RECORD = "confirmations.json";
export const NEVER_ASK = "YES, NEVER ASK AGAIN FOR RISKY SETTINGS";
export const ASK_AGAIN = "YES, ASK AGAIN FOR RISKY SETTINGS";
export const NOTICE_HOURS = 24;
const MAX_RECENT = 20;
const MAX_NOTICE = 5;
// Codex round 2 (v0.9): the record is written compact and read with room to spare: its confirmed part is never more
// than the risky part of a config.json the readers can read (1 MB), plus recent changes. The writer
// refuses anything over this, so Tiresias never writes a record it would then call damaged.
const RECORD_MAX = 4 * 1024 * 1024;
// Shell-safe quoting for the commands Tiresias suggests (a phrase, a site): single quotes, which a shell never expands.
export const sq = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`;

export type By = "terminal" | "not_terminal";
export type ChangeKind = "looser" | "stricter" | "never_ask" | "ask_again";
export type HowConfirmed = "phrase" | "never_ask" | "not_needed";
export interface Change {
  at: string;
  setting: string; // a risky setting's name, or "confirmations"
  site?: string;
  change: ChangeKind;
  by: By;
  confirmed: HowConfirmed;
}
export interface Rec {
  v: 1;
  ask: boolean;
  confirmed: Record<string, unknown>; // the last confirmed value of each risky key; absent = the default
  recent: Change[];
}
export type RecordState = "ok" | "missing" | "damaged";

// ---- the risky settings ----

const SITE_RISKY = ["ports", "spacing_seconds", "never_visit", "hand_off"] as const;
type SiteRisky = (typeof SITE_RISKY)[number];
const low = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : v);
const rank = (order: string[]) => (v: unknown) => Math.max(0, order.indexOf(String(low(v ?? order[0]))));
const sameCommand = (a: unknown, b: unknown) =>
  !!a && !!b && typeof a === "object" && typeof b === "object" && JSON.stringify((a as { command?: unknown }).command) === JSON.stringify((b as { command?: unknown }).command);
const sendsFile = (v: unknown) => !!v && typeof v === "object" && (v as { send_file?: unknown }).send_file === true;
const calendarSet = (v: unknown): string[] | null => {
  try {
    return v === undefined ? DEFAULT_CALENDARS : parseCalendars(v);
  } catch {
    return null; // a bad value: the reader that uses it fails by name
  }
};

interface Top {
  key: string;
  looser: (confirmed: unknown, next: unknown) => boolean; // undefined = absent from config.json (the default)
  phrase: (next: unknown) => string;
  what: (next: unknown) => string; // plain words for the notice and the log
}
const renderRank = rank(["off", "ask", "auto"]);
export const TOP: Top[] = [
  { key: "private_spacing", looser: (c, n) => c !== "none" && n === "none", phrase: () => "YES, TURN OFF PRIVATE SPACING", what: () => "private spacing across processes turned off" },
  { key: "hook_secrets", looser: (c, n) => c !== "inherit" && n === "inherit", phrase: () => "YES, SHARE TIRESIAS SECRETS WITH HOOKS", what: () => "Tiresias secrets shared with hooks" },
  { key: "saving", looser: (c, n) => rank(["off", "ask"])(n) > rank(["off", "ask"])(c), phrase: () => "YES, TURN ON SAVING", what: () => "saving turned on" },
  {
    key: "rendering",
    looser: (c, n) => renderRank(n) > renderRank(c),
    phrase: (n) => (renderRank(n) >= 2 ? "YES, TURN ON AUTOMATIC RENDERING" : "YES, TURN ON RENDERING"),
    what: (n) => (renderRank(n) >= 2 ? "rendering turned to auto" : "rendering turned on"),
  },
  { key: "translator", looser: (c, n) => n !== undefined && !sameCommand(c, n), phrase: () => "YES, TURN ON THE TRANSLATOR", what: () => "a translator program was set" },
  { key: "scanner", looser: (c, n) => sendsFile(n) && !(sendsFile(c) && sameCommand(c, n)), phrase: () => "YES, SEND FILES TO THE SCANNER", what: () => "the scanner was set to receive files" },
  { key: "anchoring", looser: (c, n) => rank(["off", "on"])(n) > rank(["off", "on"])(c), phrase: () => "YES, TURN ON ANCHORING", what: () => "anchoring turned on" },
  {
    key: "anchor_calendars",
    looser: (c, n) => {
      const cs = calendarSet(c) ?? DEFAULT_CALENDARS;
      const ns = calendarSet(n);
      return !!ns && ns.some((x) => !cs.includes(x));
    },
    phrase: () => "YES, CHANGE THE ANCHOR CALENDARS",
    what: () => "anchor calendars were added",
  },
  { key: "safe_browsing", looser: (c, n) => c !== false && n === false, phrase: () => "YES, TURN OFF SAFE BROWSING", what: () => "Safe Browsing turned off" },
];
const TOP_BY = new Map(TOP.map((t) => [t.key, t]));
export const RISKY_KEYS = TOP.map((t) => t.key);
export const isRisky = (name: string) => TOP_BY.has(name) || (SITE_RISKY as readonly string[]).includes(name);

// Ports: every port of `next` is inside the ranges of `confirmed` (undefined: no extra ports).
function portsLooser(c: unknown, n: unknown): boolean {
  if (n === undefined) return false;
  const nr = typeof n === "string" ? parsePortList(n) : null;
  if (!nr) return false; // a bad value: the reader fails by name
  const cr = [...DEFAULT_PORTS, ...((typeof c === "string" ? parsePortList(c) : null) ?? [])];
  return nr.some(([lo, hi]) => {
    for (let p = lo; p <= hi; ) {
      const r = cr.find(([a, b]) => p >= a && p <= b);
      if (!r) return true;
      p = r[1] + 1;
    }
    return false;
  });
}
// Codex round 1 (v0.9): site settings are compared by what is IN FORCE for a site key, the way the readers resolve
// it (sites.ts ruleFor: the entry itself, then the closest wildcard above it that sets the setting), never entry by
// entry. So removing an exact entry that a wider wildcard then replaces, a new exact entry under a wildcard, and an
// explicit false under a wildcard true are all judged by their effect.
function effLooser(name: SiteRisky, c: unknown, n: unknown): boolean {
  if (name === "ports") return portsLooser(c, n);
  if (name === "spacing_seconds") return (typeof n === "number" ? n : MIN_SPACING_S) < (typeof c === "number" ? c : MIN_SPACING_S);
  return c === true && n !== true;
}
// The keys whose entries apply to a site key, closest first: the key itself, then the wildcards above it.
function chain(site: string): string[] {
  const base = site.startsWith("*.") ? site.slice(2) : site;
  try {
    return [site, ...candidates(base).filter((k) => k !== site && !(site.startsWith("*.") && k === base))];
  } catch {
    return [site];
  }
}
type Sites = Record<string, Record<string, unknown>>;
function effective(sites: Sites, site: string, name: SiteRisky): unknown {
  for (const k of chain(site)) if (Object.hasOwn(sites, k) && Object.hasOwn(sites[k], name)) return sites[k][name];
  return undefined;
}
// Broadest first (fewer labels; a wildcard before the exact host it covers), so a key's wildcards are settled first.
const breadth = (k: string) => (k.startsWith("*.") ? k.slice(2) : k).split(".").length * 2 + (k.startsWith("*.") ? 0 : 1);
const SITE_PHRASE: Record<SiteRisky, (site: string) => string> = {
  ports: (s) => `YES, ALLOW MORE PORTS FOR ${s.toUpperCase()}`,
  spacing_seconds: (s) => `YES, LOWER THE SPACING FOR ${s.toUpperCase()}`,
  never_visit: (s) => `YES, TURN OFF NEVER_VISIT FOR ${s.toUpperCase()}`,
  hand_off: (s) => `YES, TURN OFF HAND_OFF FOR ${s.toUpperCase()}`,
};
const SITE_WHAT: Record<SiteRisky, string> = { ports: "more ports allowed", spacing_seconds: "spacing lowered", never_visit: "never_visit turned off", hand_off: "hand_off turned off" };

// The phrase for loosening one setting to `next` (site settings take the site).
export function phraseFor(name: string, next: unknown, site?: string): string {
  if (site !== undefined && (SITE_RISKY as readonly string[]).includes(name)) return SITE_PHRASE[name as SiteRisky](site);
  return TOP_BY.get(name)!.phrase(next);
}

// ---- the record ----

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const defaultRecord = (): Rec => ({ v: 1, ask: true, confirmed: {}, recent: [] });
const CHANGES = new Set(["looser", "stricter", "never_ask", "ask_again"]);
const BYS = new Set(["terminal", "not_terminal"]);
const HOWS = new Set(["phrase", "never_ask", "not_needed"]);

function parseRecord(raw: string): Rec | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(o) || o.v !== 1 || typeof o.ask !== "boolean" || !isObj(o.confirmed) || !Array.isArray(o.recent)) return null;
  for (const k of Object.keys(o.confirmed)) if (!RISKY_KEYS.includes(k) && k !== "sites") return null;
  // Codex round 3: every confirmed value must be one the readers accept, or the whole record counts as damaged.
  for (const k of Object.keys(o.confirmed)) if (k !== "sites" && !validTop(k, o.confirmed[k])) return null;
  if (Object.hasOwn(o.confirmed, "sites")) {
    const s = o.confirmed.sites;
    if (!isObj(s) || !recordSitesValid(s)) return null;
    for (const v of Object.values(s)) if (!isObj(v) || Object.keys(v).some((k) => !(SITE_RISKY as readonly string[]).includes(k))) return null;
  }
  const recent: Change[] = [];
  for (const c of o.recent) {
    if (!isObj(c) || typeof c.at !== "string" || Number.isNaN(Date.parse(c.at)) || typeof c.setting !== "string" || !(isRisky(c.setting) || c.setting === "confirmations")) return null;
    if (!CHANGES.has(String(c.change)) || !BYS.has(String(c.by)) || !HOWS.has(String(c.confirmed))) return null;
    if (c.site !== undefined && (typeof c.site !== "string" || c.site.length > 260 || /[^a-z0-9.*\-[\]:_]/.test(c.site))) return null;
    recent.push({ at: c.at, setting: c.setting, ...(c.site !== undefined ? { site: c.site } : {}), change: c.change as ChangeKind, by: c.by as By, confirmed: c.confirmed as HowConfirmed });
  }
  return { v: 1, ask: o.ask, confirmed: o.confirmed, recent };
}

// The record and how it was found. Missing or damaged: the defaults, asking on (fail closed).
export function loadRecord(): { rec: Rec; state: RecordState } {
  const snapshot = callContext.getStore()?.config?.record;
  if (snapshot) return snapshot;
  let raw: string | null;
  try {
    raw = readOwnedText(RECORD, RECORD_MAX);
  } catch {
    return { rec: defaultRecord(), state: "damaged" };
  }
  if (raw === null) return { rec: defaultRecord(), state: "missing" };
  const rec = parseRecord(raw);
  return rec ? { rec, state: "ok" } : { rec: defaultRecord(), state: "damaged" };
}

// Written only under the config lock (writeConfig's `after`), atomically, mode 0600, never through a link.
function writeRecord(rec: Rec): void {
  const file = path.join(home(), RECORD);
  const tmp = randomTmp(file);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW | NONBLOCK, 0o600);
  try {
    ownFile(fd, tmp);
    const data = Buffer.from(JSON.stringify(rec) + "\n");
    if (data.length > RECORD_MAX) throw new ConfigError(`${RECORD} would be larger than ${RECORD_MAX} bytes; it was not written. Remove some site settings and try again.`);
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

// ---- the values in force ----

export interface Waiting {
  setting: string;
  site?: string;
  phrase: string;
  command: string;
}

const sitesOf = (o: Record<string, unknown> | null | undefined): Record<string, Record<string, unknown>> =>
  o && isObj(o.sites) && Object.values(o.sites).every(isObj) ? (o.sites as Record<string, Record<string, unknown>>) : {};
// "sites" exactly as the readers accept it (names in their written form). Anything else: false, and the readers
// fail every request by name, so there is nothing to hold back (and no outside text reaches a notice).
// The record's own confirmed sites: each entry as the readers accept it, without the 500-site cap of config.json
// (the record can also hold confirmed entries config.json no longer has), at most 5,000.
const recordSitesValid = (v: unknown): boolean => {
  if (!isObj(v) || Object.keys(v).length > MAX_CONFIRMED_SITES) return false;
  try {
    for (const [k, r] of Object.entries(v)) {
      normalizeSite(k);
      parseSiteRule(k, r);
    }
    return true;
  } catch {
    return false;
  }
};
const sitesValid = (v: unknown): boolean => {
  try {
    parseSites(v);
    return true;
  } catch {
    return false;
  }
};
const siteName = (s: string): boolean => {
  try {
    normalizeSite(s);
    return true;
  } catch {
    return false;
  }
};
const cmdFor = (name: string, phrase: string, site?: string) => `tiresias settings confirm ${name}${site ? ` ${sq(site)}` : ""} --confirm ${sq(phrase)}`;

// config.json with every unconfirmed loosening replaced by its confirmed value, and the list of what was held back.
// With asking off, config.json as it is. No config.json while asking is on: an empty one, so confirmed site
// restrictions (never_visit, hand_off, spacing) stay in force (Codex round 1).
export function clamp(raw: Record<string, unknown> | null, rec: Rec): { obj: Record<string, unknown> | null; waiting: Waiting[] } {
  if (!rec.ask) return { obj: raw, waiting: [] };
  const base = raw ?? {};
  const obj: Record<string, unknown> = { ...base };
  const waiting: Waiting[] = [];
  for (const t of TOP) {
    const n = Object.hasOwn(base, t.key) ? base[t.key] : undefined;
    const c = Object.hasOwn(rec.confirmed, t.key) ? rec.confirmed[t.key] : undefined;
    if (!t.looser(c, n)) continue;
    if (c === undefined) delete obj[t.key];
    else obj[t.key] = c;
    const phrase = t.phrase(n);
    waiting.push({ setting: t.key, phrase, command: cmdFor(t.key, phrase) });
  }
  // Site settings: only when "sites" is absent or parses exactly as the readers parse it (Codex round 1: a bad one,
  // with odd names, fails every request by name anyway, and its names never reach a notice).
  const present = Object.hasOwn(base, "sites");
  if (!present || sitesValid(base.sites)) {
    const now: Sites = present ? (base.sites as Sites) : {};
    const conf = confirmedSites(rec);
    const out: Sites = Object.create(null);
    for (const [k, r] of Object.entries(now)) out[k] = { ...r };
    const keys = [...new Set([...Object.keys(now), ...Object.keys(conf)])].sort((a, b) => breadth(a) - breadth(b));
    for (const site of keys)
      for (const name of SITE_RISKY) {
        const c = effective(conf, site, name);
        const own = Object.hasOwn(conf, site) && Object.hasOwn(conf[site], name) ? conf[site][name] : undefined;
        // Restoring an ancestor must also restore its confirmed exceptions, unless the raw file itself
        // tightened them. Otherwise deleting config.json would turn an allowed host into a banned one.
        if (own !== undefined && !(Object.hasOwn(now, site) && Object.hasOwn(now[site], name)) &&
            effLooser(name, effective(out, site, name), c) && effLooser(name, effective(out, site, name), effective(now, site, name)) &&
            !effLooser(name, effective(now, site, name), own)) { // (Claude review) never looser than what the raw file asks for
          (out[site] ??= {})[name] = own;
        }
        if (!effLooser(name, c, effective(out, site, name))) continue;
        const rule = Object.hasOwn(out, site) ? out[site] : (out[site] = {});
        if (own !== undefined) rule[name] = own;
        else delete rule[name];
        if (effLooser(name, c, effective(out, site, name))) rule[name] = c; // never looser than confirmed, whatever the order
        const phrase = SITE_PHRASE[name](site);
        waiting.push({ setting: name, site, phrase, command: cmdFor(name, phrase, site) });
      }
    for (const k of Object.keys(out)) if (!Object.keys(out[k]).length) delete out[k];
    if (Object.keys(out).length) obj.sites = { ...out };
    else if (present) obj.sites = {};
    else delete obj.sites;
  }
  return { obj: raw === null && !Object.keys(obj).length ? null : obj, waiting };
}
// The record's confirmed site entries whose names are written as the readers write them.
function confirmedSites(rec: Rec): Sites {
  const out: Sites = Object.create(null);
  for (const [k, r] of Object.entries(sitesOf(rec.confirmed))) if (siteName(k)) out[k] = r;
  return out;
}

// The config.json object every reader of a setting uses (null when there is none). A bad file is a ConfigError.
export function inForceConfig(): Record<string, unknown> | null {
  const snapshot = callContext.getStore()?.config;
  return snapshot ? snapshot.effective : clamp(readConfigObject(), loadRecord().rec).obj;
}
export const asking = (): boolean => loadRecord().rec.ask;

// ---- environment variables ----

// TIRESIAS_CONFIRM holds phrases for environment variables, separated by ";" or new lines.
export const envConfirmed = (phrase: string): boolean => (process.env.TIRESIAS_CONFIRM ?? "").split(/[;\n]/).some((p) => p.trim() === phrase);
export const ENV_PHRASE = { ports: "YES, ALLOW MORE PORTS", safe_browsing: "YES, TURN OFF SAFE BROWSING" } as const;
// Whether an environment variable that loosens may apply: asking is off, or its phrase is in TIRESIAS_CONFIRM.
export const envMayLoosen = (phrase: string): boolean => envConfirmed(phrase) || !asking();

// ---- who, and recording ----

export const whoNow = (): By => (process.stdin.isTTY === true ? "terminal" : "not_terminal");
const BY_WORDS: Record<By, string> = { terminal: "from a terminal (likely a person)", not_terminal: "not from a terminal (an agent, a script or cron)" };
const HOW_WORDS: Record<HowConfirmed, string> = { phrase: "confirmed with the phrase", never_ask: "no phrase asked (confirmations are off)", not_needed: "no phrase needed" };
export function describe(c: Change): string {
  const what =
    c.change === "never_ask" ? "confirmations for risky settings turned off (never ask again)"
    : c.change === "ask_again" ? "confirmations for risky settings turned back on"
    : c.site !== undefined ? `${c.setting} for ${c.site}: ${c.change === "looser" ? SITE_WHAT[c.setting as SiteRisky] ?? "loosened" : "made stricter"}`
    : c.change === "looser" ? (TOP_BY.get(c.setting)?.what(undefined) ?? `${c.setting} loosened`) : `${c.setting} made stricter or turned off`;
  return `${what}, ${BY_WORDS[c.by]}, ${HOW_WORDS[c.confirmed]}`;
}

// Codex round 5: a change goes into the record (and so the notice) first, and the record is written BEFORE config.json;
// history is appended last. A failure part way therefore never leaves an old, looser confirmation in place after a
// tightening (the record already holds the new state), and a history failure is reported, not swallowed.
const noteChange = (c: Change, rec: Rec): void => {
  const all = [...rec.recent, c];
  const since = Date.now() - NOTICE_HOURS * 3_600_000;
  rec.recent = all.filter((e, i) => i >= all.length - MAX_RECENT || (e.change !== "stricter" && Date.parse(e.at) >= since));
};
function appendHistory(c: Change): void {
  try {
    historyLine(c);
  } catch (e) {
    throw new ConfigError(`The change was made and kept in ${RECORD} (and shows in replies), but history could not be written: ${(e as Error).message}`);
  }
}
function historyLine(c: Change): void {
  history.record({ time: c.at, tool: "settings", url: "", agent: "cli", status: "ok", door: "none", setting: c.setting, ...(c.site !== undefined ? { site_key: c.site } : {}), change: c.change, by: c.by, confirmed: c.confirmed });
}

// Codex round 1 (v0.9): after any settings command, the confirmed state becomes what is IN FORCE (config.json with
// every unconfirmed loosening held back): never looser than what was confirmed, and it takes in every tightening
// made by hand (a new never_visit, a lower calendar list). A replacement that is looser in any way (another
// translator program, other calendars or ports) is held back by the clamp, so it is never adopted. Values the
// readers would refuse are not adopted either.
function ratchet(raw: Record<string, unknown>, rec: Rec): void {
  const force = clamp(raw, { ...rec, ask: true }).obj ?? {};
  const conf: Record<string, unknown> = {};
  for (const t of TOP) {
    if (!Object.hasOwn(force, t.key)) continue; // the default: the safest value
    if (validTop(t.key, force[t.key])) conf[t.key] = force[t.key];
    else if (Object.hasOwn(rec.confirmed, t.key)) conf[t.key] = rec.confirmed[t.key];
  }
  // Codex round 4: no "sites" in force means none (every confirmed restriction still needed is put back by the clamp);
  // only a "sites" that does not parse keeps the confirmed entries.
  const sites = !Object.hasOwn(force, "sites") ? {} : recordSitesValid(force.sites) ? (force.sites as Sites) : confirmedSites(rec);
  const keepSites: Sites = {};
  for (const [k, r] of Object.entries(sites)) {
    const risky: Record<string, unknown> = {};
    for (const n of SITE_RISKY) if (Object.hasOwn(r, n)) risky[n] = r[n];
    if (Object.keys(risky).length) keepSites[k] = risky;
  }
  if (Object.keys(keepSites).length) conf.sites = keepSites;
  rec.confirmed = conf;
}
function validTop(key: string, v: unknown): boolean {
  try {
    if (Object.hasOwn(SECURITY_CHOICES, key)) parseChoice(key as SecurityChoice, v);
    else if (key === "saving") parseSaving(v);
    else if (key === "rendering") parseRender(v);
    else if (key === "translator") parseTranslator(v);
    else if (key === "scanner") parseScanner(v);
    else if (key === "anchoring") parseAnchoring(v);
    else if (key === "anchor_calendars") parseCalendars(v);
    else if (key === "safe_browsing") parseSafeBrowsing(v);
    return true;
  } catch {
    return false;
  }
}

// What a risky setting holds in an object (config.json, or the record's `confirmed`).
function valueIn(o: Record<string, unknown>, name: string, site?: string): unknown {
  if (site === undefined) return Object.hasOwn(o, name) ? o[name] : undefined;
  const s = sitesOf(o);
  return Object.hasOwn(s, site) && Object.hasOwn(s[site], name) ? s[site][name] : undefined;
}
function setIn(o: Record<string, unknown>, name: string, v: unknown, site?: string): void {
  if (site === undefined) {
    if (v === undefined) delete o[name];
    else o[name] = v;
    return;
  }
  const s = { ...sitesOf(o) };
  const rule = { ...(Object.hasOwn(s, site) ? s[site] : {}) };
  if (v === undefined) delete rule[name];
  else rule[name] = v;
  if (Object.keys(rule).length) s[site] = rule;
  else delete s[site];
  if (Object.keys(s).length) o.sites = s;
  else delete o.sites;
}

export const refusal = (phrase: string, again: string) => {
  const split = again.indexOf(" -- ");
  const retry = split < 0 ? `${again} --confirm ${sq(phrase)}` : `${again.slice(0, split)} --confirm ${sq(phrase)}${again.slice(split)}`;
  return `This loosens a risky setting, so it needs the exact confirmation ${JSON.stringify(phrase)}. Run it again with: ${retry}  (type it exactly, in capitals; it will be recorded in history with who made it, and shown in replies for ${NOTICE_HOURS} hours). To stop being asked for every risky setting: tiresias settings confirmations off --confirm ${sq(NEVER_ASK)}`;
};

// The one way Tiresias's own commands change a setting: under the config lock, checks the phrase against the
// CONFIRMED state (not just the file's), writes config.json, then updates the record and history. A change is looser
// when, after it, the setting would be held back by the clamp (so site settings are judged by their effect, Codex
// round 1). `change` edits the object as before; `again` is the command to repeat in a refusal. Every command, a
// setting that is not risky included, brings the record up to what is in force (the ratchet).
export function confirmedWrite(
  target: { name: string; site?: string },
  change: (o: Record<string, unknown>) => void | boolean,
  check: (o: Record<string, unknown>) => void,
  opts: { confirm?: string; again: string; confirmOnly?: boolean },
): void {
  const risky = isRisky(target.name);
  let pending: { rec: Rec; state: RecordState; was: string; change?: Change; committed: boolean } | null = null;
  writeConfig(
    (o) => {
      const before = valueIn(o, target.name, target.site);
      const sitesOk = !Object.hasOwn(o, "sites") || sitesValid(o.sites);
      const r = opts.confirmOnly ? false : change(o);
      const next = valueIn(o, target.name, target.site);
      const { rec, state } = loadRecord();
      const confirmedBefore = valueIn(rec.confirmed, target.name, target.site);
      // Codex round 2: a comparison that cannot be made is never taken as "stricter". A site setting is changed or
      // confirmed only while "sites" parses as the readers parse it; a risky value is confirmed only when valid.
      if (risky && !sitesOk && (target.site !== undefined || opts.confirmOnly))
        throw new ConfigError('config.json\'s "sites" has a problem (run tiresias settings to see it); fix it by hand first.');
      const removingHook = target.site === undefined && !opts.confirmOnly && (target.name === "scanner" || target.name === "translator") && next === undefined;
      if (risky && !removingHook && Object.hasOwn(o, "sites") && !sitesValid(o.sites)) parseSites(o.sites);
      if (risky && target.site === undefined && next !== undefined && !validTop(target.name, next))
        throw new ConfigError(`config.json's "${target.name}" does not hold a valid value (run tiresias settings to see it); fix or reset it first. Nothing was confirmed.`);
      // Codex round 3: the new record is built first, from the ORIGINAL one: what is in force under it (the ratchet),
      // then the target's own value. The change is looser when its target is held back under the original record, or
      // when the new record would let through anything the original held back (a wildcard's confirmed ban dropped
      // from under an exception, say), so nothing is ever unblocked without the phrase.
      const was = JSON.stringify(rec);
      const after: Rec = { ...rec, confirmed: structuredClone(rec.confirmed), recent: [...rec.recent] };
      ratchet(o, after);
      if (risky) setIn(after.confirmed, target.name, next, target.site);
      const key = (w: Waiting) => `${w.setting}\u0000${w.site ?? ""}`;
      const held = clamp(o, { ...rec, ask: true }).waiting;
      const stillHeld = new Set(clamp(o, { ...after, ask: true }).waiting.map(key));
      const looser = risky && held.some((w) => (w.setting === target.name && w.site === target.site) || !stillHeld.has(key(w)));
      let how: HowConfirmed = "not_needed";
      if (looser) {
        if (!rec.ask) how = "never_ask";
        else {
          const phrase = phraseFor(target.name, next, target.site);
          if (opts.confirm !== phrase) throw new ConfigError(refusal(phrase, opts.again));
          how = "phrase";
        }
      }
      const same = JSON.stringify(next) === JSON.stringify(before) && JSON.stringify(next) === JSON.stringify(confirmedBefore);
      const ch: Change | undefined = risky && !same ? { at: new Date().toISOString(), setting: target.name, ...(target.site !== undefined ? { site: target.site } : {}), change: looser ? "looser" : "stricter", by: whoNow(), confirmed: how } : undefined;
      if (ch) noteChange(ch, after);
      // Include the new event in the size check: retaining a full day of notices must never write an unreadable record.
      if (Buffer.byteLength(JSON.stringify(after)) > RECORD_MAX - 64 * 1024 || !parseRecord(JSON.stringify(after)))
        throw new ConfigError(`the confirmation record (${RECORD}) would not be valid after this change. Run tiresias settings to see what is wrong.`);
      pending = { rec: after, state, was, change: ch, committed: false };
      return r;
    },
    (o) => {
      check(o);
      commit(); // the record first, then config.json (writeConfig writes it right after this check)
    },
    () => {
      commit(); // nothing to write in config.json: the record alone
      if (pending?.change) appendHistory(pending.change);
    },
  );
  function commit(): void {
    if (!pending || pending.committed) return;
    pending.committed = true;
    if (JSON.stringify(pending.rec) !== pending.was || pending.state !== "ok") writeRecord(pending.rec);
  }
}

// `settings confirmations off|on`.
export function setAsking(on: boolean, confirm: string | undefined): { message: string; adopted: string[] } {
  const phrase = on ? ASK_AGAIN : NEVER_ASK;
  if (confirm !== phrase)
    throw new ConfirmError(`Not changed: ${on ? "turning confirmations back on" : "never asking again for risky settings"} needs the exact confirmation ${JSON.stringify(phrase)}. Run: tiresias settings confirmations ${on ? "on" : "off"} --confirm ${sq(phrase)}`);
  let adopted: string[] = [];
  let already = false;
  writeConfig(
    () => false,
    () => {},
    (raw) => {
      const { rec } = loadRecord();
      already = rec.ask === on;
      if (on && !rec.ask) {
        // Asking resumes: the risky values config.json holds now become the confirmed ones.
        const before = clamp(raw, { ...rec, ask: true }).waiting;
        adopted = before.map((w) => (w.site ? `${w.setting} for ${w.site}` : w.setting));
        // Codex round 3: only values the readers accept are adopted; anything else keeps its confirmed value.
        const conf: Record<string, unknown> = {};
        for (const k of RISKY_KEYS) {
          const v = Object.hasOwn(raw, k) && validTop(k, raw[k]) ? raw[k] : Object.hasOwn(raw, k) ? rec.confirmed[k] : undefined;
          if (v !== undefined) conf[k] = v;
        }
        const sites: Record<string, Record<string, unknown>> = {};
        for (const [s, r] of Object.entries(Object.hasOwn(raw, "sites") && sitesValid(raw.sites) ? sitesOf(raw) : !Object.hasOwn(raw, "sites") ? {} : confirmedSites(rec))) {
          const keep: Record<string, unknown> = {};
          for (const n of SITE_RISKY) if (Object.hasOwn(r, n)) keep[n] = r[n];
          if (Object.keys(keep).length) sites[s] = keep;
        }
        if (Object.keys(sites).length) conf.sites = sites;
        rec.confirmed = conf;
      }
      if (already) return;
      rec.ask = on;
      const ch: Change = { at: new Date().toISOString(), setting: "confirmations", change: on ? "ask_again" : "never_ask", by: whoNow(), confirmed: "phrase" };
      noteChange(ch, rec);
      writeRecord(rec);
      appendHistory(ch);
    },
  );
  const message = already
    ? on ? "Confirmations for risky settings were already on." : "Confirmations for risky settings were already off."
    : on
      ? `Confirmations for risky settings are on again: turning a risky setting on or looser takes its phrase.${adopted.length ? ` These values in config.json were not confirmed before and are now: ${adopted.join(", ")}.` : ""}`
      : "Confirmations for risky settings are off: no phrase is asked, and hand edits and environment variables apply as written. Changes are still recorded and shown in replies. Turn them back on with: tiresias settings confirmations on --confirm " + sq(ASK_AGAIN);
  return { message, adopted };
}
export class ConfirmError extends ConfigError {}

// ---- the notice in replies ----

// Fixed text only (setting names, validated site names, times, fixed words). Undefined when there is nothing to say.
export function notice(now = Date.now()): string[] | undefined {
  try {
    const lines: string[] = [];
    const { rec, state } = loadRecord();
    if (state === "damaged") lines.push(`The confirmation record (${RECORD}) could not be read or holds a value this version does not accept, so risky settings are held at their safe defaults until confirmed again (tiresias settings).`);
    let raw: Record<string, unknown> | null = null;
    try {
      raw = readConfigObject();
    } catch {
      raw = null; // a bad config.json is reported by the calls that use it
    }
    for (const w of clamp(raw, rec).waiting)
      lines.push(`config.json loosens ${w.setting}${w.site ? ` for ${w.site}` : ""}, but that was not confirmed, so it is not in force. To confirm: ${w.command}`);
    for (const e of envNotices(rec, raw)) lines.push(e);
    const since = now - NOTICE_HOURS * 3_600_000;
    const recent = rec.recent.filter((c) => c.change !== "stricter" && Date.parse(c.at) >= since).reverse();
    for (const c of recent) lines.push(`${c.at}: ${describe(c)}. See tiresias history.`);
    if (!lines.length) return undefined;
    return lines.length > MAX_NOTICE ? [...lines.slice(0, MAX_NOTICE), `And ${lines.length - MAX_NOTICE} more: run tiresias settings.`] : lines;
  } catch {
    return undefined;
  }
}

// v0.9.1 (Travis, 2026-10-31): `tiresias mcp` says it once on standard error, at start, when config.json loosens a
// risky setting that is held back until confirmed (the usual case right after an upgrade from v0.8), so an owner
// who only talks to Tiresias through an agent still sees it. One line, the exact commands, fixed text only
// (setting names, validated site names, the fixed phrases): nothing from a page and no secret.
const MAX_STARTUP_COMMANDS = 5;
export function startupNotice(profile = "default"): string | undefined {
  try {
    let raw: Record<string, unknown> | null = null;
    try {
      raw = readConfigObject();
    } catch {
      return undefined; // a bad config.json stops every call by name anyway
    }
    const waiting = clamp(raw, loadRecord().rec).waiting;
    if (!waiting.length) return undefined;
    const p = profile === "default" ? "" : ` --profile ${sq(profile)}`;
    const cmds = waiting.slice(0, MAX_STARTUP_COMMANDS).map((w) => `${w.command}${p}`);
    const more = waiting.length > MAX_STARTUP_COMMANDS ? `; and ${waiting.length - MAX_STARTUP_COMMANDS} more (tiresias settings${p})` : "";
    return `Tiresias: ${waiting.length} risky setting(s) in config.json ${waiting.length === 1 ? "is" : "are"} held back until you confirm ${waiting.length === 1 ? "it" : "them"} (after an upgrade from v0.8, each needs confirming once). Until then the last confirmed value stays in force (the safe default where nothing was confirmed). To confirm, run in a terminal: ${cmds.join("; ")}${more}`;
  } catch {
    return undefined;
  }
}

function envNotices(rec: Rec, raw: Record<string, unknown> | null): string[] {
  if (!rec.ask) return [];
  const out: string[] = [];
  const conf = clamp(raw, rec).obj ?? {};
  const r = process.env.TIRESIAS_RENDERING?.trim();
  if (r && renderRank(r) > renderRank(conf.rendering)) {
    const p = TOP_BY.get("rendering")!.phrase(r);
    if (!envConfirmed(p)) out.push(`TIRESIAS_RENDERING=${String(low(r)).slice(0, 10)} is ignored: it loosens rendering, so it needs TIRESIAS_CONFIRM=${sq(p)}.`);
  }
  const sb = process.env.TIRESIAS_SAFE_BROWSING?.trim();
  if (sb && /^(0|false|off|no)$/i.test(sb) && conf.safe_browsing !== false && !envConfirmed(ENV_PHRASE.safe_browsing))
    out.push(`TIRESIAS_SAFE_BROWSING=0 is ignored: it turns off Safe Browsing, so it needs TIRESIAS_CONFIRM=${sq(ENV_PHRASE.safe_browsing)}.`);
  const ports = process.env.TIRESIAS_ALLOW_PORTS?.trim();
  if (ports && !envConfirmed(ENV_PHRASE.ports)) out.push(`TIRESIAS_ALLOW_PORTS is ignored: it allows more ports, so it needs TIRESIAS_CONFIRM=${sq(ENV_PHRASE.ports)}.`);
  return out;
}

// For the settings listing.
export function stateForView(raw: Record<string, unknown> | null): { asking: boolean; record: RecordState; file: string; waiting: Waiting[]; recent: Change[] } {
  const { rec, state } = loadRecord();
  let file = RECORD;
  try {
    file = path.join(homeDir(), RECORD);
  } catch {
    // no profile folder yet
  }
  return { asking: rec.ask, record: state, file, waiting: clamp(raw, rec).waiting, recent: [...rec.recent].reverse() };
}
