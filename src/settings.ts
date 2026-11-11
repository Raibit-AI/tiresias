// SPDX-License-Identifier: Apache-2.0
// W-29 (v0.6): one settings view. Tiresias has no screen, so its settings page is a command:
//   tiresias settings                              every owner setting: name, value, default, what it does, where it lives
//   tiresias settings set <name> [<site>] <value>  change one (site settings take the site)
//   tiresias settings reset <name> [<site>]        back to its default (removed from config.json)
// CLI only. Nothing reachable over MCP reads or changes a setting (like the scanner hook, W-21): a page that
// tricks an agent must never loosen the owner's rules. Every value is checked with the same parser the reader
// uses, the whole file is checked before it is written, and it is written atomically under a lock (config.ts).
// Environment variables are listed too (read only here: they live in the shell that starts Tiresias); the Web
// Risk key is shown only as set or not set.
import os from "node:os";
import path from "node:path";
import {
  parseChoice, ConfigError, DEFAULT_ANCHORING, DEFAULT_CALENDARS, DEFAULT_DOORS, DEFAULT_LIMITS, DEFAULT_SAVING, parseAnchoring, parseCalendars, KNOWN_KEYS, parseAgentStyle, parseDoors, parseKeyFile, parseSafeBrowsing, parseSaving, parseScanner,
  parseSignatureAgent, parseTranslator, readConfigObject, writeConfig,
} from "./config.js";
import { defaultKeyFile } from "./safebrowsing.js";
import { DEFAULT_RENDER, parseRender } from "./render.js";
import { MAX_SPACING_S, MIN_SPACING_S, candidates, loadSites, normalizeSite, parsePortList, parseSiteRule, parseSites, type SiteRule, type SiteSettingName } from "./sites.js";
import { homeDir, profileName } from "./store.js";
import { ASK_AGAIN, NEVER_ASK, confirmedWrite, sq, inForceConfig, isRisky, setAsking, stateForView, type Change, type RecordState, type Waiting } from "./confirm.js";

interface Def {
  name: string;
  description: string;
  default: unknown; // as shown
  check: (v: unknown) => unknown; // validates a stored value (throws a ConfigError naming the key)
  fromText?: (s: string) => unknown; // the CLI's text to the stored value; absent: not settable here
  howToSet?: string; // when not settable with `settings set`
}

const wholeDays = (name: string) => (v: unknown) => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw new ConfigError(`config.json: "${name}" must be a whole number of 1 or more.`);
  return v;
};
const wholeText = (name: string) => (s: string) => {
  if (!/^\d{1,9}$/.test(s)) throw new ConfigError(`"${name}" takes a whole number of 1 or more, like 30.`);
  return wholeDays(name)(Number(s));
};
const onOff = (name: string) => (s: string) => {
  const t = s.toLowerCase();
  if (t === "on" || t === "true") return true;
  if (t === "off" || t === "false") return false;
  throw new ConfigError(`"${name}" takes on or off.`);
};

export const DEFS: Def[] = [
  { name: "get_form_actions", default: "read", description: 'Reading a URL matching a GET form action seen on its source page: "read" reads it normally; "slip" requires a submit_form slip. Rendered scripts may never request the GET form actions on that page.', check: (v) => parseChoice("get_form_actions", v), fromText: (v) => parseChoice("get_form_actions", v) },
  { name: "private_spacing", default: "shared", description: 'Private calls and form previews: "shared" writes origin and times only to share spacing across processes; "none" writes nothing and separate processes do not space these calls against each other.', check: (v) => parseChoice("private_spacing", v), fromText: (v) => parseChoice("private_spacing", v) },
  { name: "hook_secrets", default: "hidden", description: 'Scanner and translator environment: "hidden" removes Tiresias secret variables; "inherit" passes the full owner environment, including those secrets.', check: (v) => parseChoice("hook_secrets", v), fromText: (v) => parseChoice("hook_secrets", v) },
  { name: "text_views", default: "marked", description: 'Text views: "marked" keeps them readable with a marker before web content; "wrapped" wraps the text inside untrusted_content, like JSON. Agents should use JSON output.', check: (v) => parseChoice("text_views", v), fromText: (v) => parseChoice("text_views", v) },
  { name: "doors", default: DEFAULT_DOORS, description: 'How a first read of a site treats its door checks (llms.txt, MCP, API): "background" returns the page at once and checks them afterwards; "wait" checks them first (slower).', check: parseDoors, fromText: parseDoors },
  { name: "rendering", default: DEFAULT_RENDER, description: 'Running a page\'s JavaScript (W-10), in the installed Google Chrome, sandboxed and throwaway, with every request it makes going through Tiresias\'s rules: "off" never; "ask" when a read asks for it; "auto" also when a plain read is an empty JavaScript shell. TIRESIAS_RENDERING overrides it.', check: parseRender, fromText: parseRender },
  { name: "saving", default: DEFAULT_SAVING, description: 'Keeping a signed snapshot of a page a read asks to save (W-28): "off" never; "ask" when a read asks for it (read --save, or save on the MCP read). Snapshots are kept in this profile\'s saved/ folder; see tiresias saved.', check: parseSaving, fromText: parseSaving },
  { name: "anchoring", default: DEFAULT_ANCHORING, description: 'Timestamping fingerprints of this profile\'s receipts and saved snapshots on a public chain (W-08, OpenTimestamps, free): "off" never; "on" when you run tiresias anchor (by hand or from cron). Only a hash of each batch leaves the machine, never content or URLs; private mode is never anchored.', check: parseAnchoring, fromText: parseAnchoring },
  { name: "anchor_calendars", default: DEFAULT_CALENDARS, description: "The OpenTimestamps calendars tiresias anchor submits to (1 to 8 https addresses, comma-separated). They learn a batch's hash and your IP address.", check: parseCalendars, fromText: (s: string) => parseCalendars(s.split(",").map((x) => x.trim()).filter(Boolean)) },
  { name: "keep_history_days", default: DEFAULT_LIMITS.keep_history_days, description: "Days of history kept before clear and the daily trim remove them.", check: wholeDays("keep_history_days"), fromText: wholeText("keep_history_days") },
  { name: "keep_receipts_days", default: DEFAULT_LIMITS.keep_receipts_days, description: "Days of receipts kept.", check: wholeDays("keep_receipts_days"), fromText: wholeText("keep_receipts_days") },
  { name: "keep_cache_days", default: DEFAULT_LIMITS.keep_cache_days, description: "Days a cached page is kept.", check: wholeDays("keep_cache_days"), fromText: wholeText("keep_cache_days") },
  { name: "keep_handoff_days", default: DEFAULT_LIMITS.keep_handoff_days, description: "Days a handoff ticket stays open.", check: wholeDays("keep_handoff_days"), fromText: wholeText("keep_handoff_days") },
  { name: "keep_saved_days", default: DEFAULT_LIMITS.keep_saved_days, description: "Days a saved snapshot is kept.", check: wholeDays("keep_saved_days"), fromText: wholeText("keep_saved_days") },
  { name: "max_saved_mb", default: DEFAULT_LIMITS.max_saved_mb, description: "Cap for this profile's saved snapshots, in MB (not counted by max_disk_mb); a save that would pass it is refused.", check: wholeDays("max_saved_mb"), fromText: wholeText("max_saved_mb") },
  { name: "max_disk_mb", default: DEFAULT_LIMITS.max_disk_mb, description: "Disk cap for this profile's folder, in MB; the oldest days and pages go first.", check: wholeDays("max_disk_mb"), fromText: wholeText("max_disk_mb") },
  { name: "signature_agent", default: null, description: "The site (https://...) where your signing key directory is hosted; with it set, every request is signed.", check: parseSignatureAgent, fromText: parseSignatureAgent },
  { name: "signature_agent_style", default: "quoted", description: 'How the Signature-Agent header is written: "quoted" (what Cloudflare accepts today) or "dictionary" (the current draft).', check: parseAgentStyle, fromText: parseAgentStyle },
  { name: "safe_browsing", default: true, description: "Check every URL against the Phishing.Database list (and Google Web Risk, with a key) before requesting it.", check: parseSafeBrowsing, fromText: onOff("safe_browsing") },
  { name: "web_risk_key_file", default: null, description: "The file holding WEB_RISK_API_KEY= (a full path). Default for the default profile: ~/.config/tiresias/secrets.env.", check: parseKeyFile, fromText: parseKeyFile },
  { name: "scanner", default: null, description: "Your own virus checker, run on every high-risk file warning (none is included).", check: parseScanner, howToSet: "Set it with: tiresias scanner set [--timeout 10] [--send-file] -- /full/path/to/program [args...]" },
  { name: "translator", default: null, description: "Your own translation program, run only when an agent asks a read for a translation; it gets the page's text on standard input and the source and target languages as its last two arguments (none is included).", check: parseTranslator, howToSet: "Set it with: tiresias translator set [--timeout 20] -- /full/path/to/program [args...]" },
];
const DEF = new Map(DEFS.map((d) => [d.name, d]));
// The default as the reader applies it (Codex round 2): the Web Risk key file has one only for the default profile.
const defaultOf = (d: Def): unknown => (d.name === "web_risk_key_file" && profileName() === "default" ? defaultKeyFile() : d.default);

interface SiteDef {
  name: SiteSettingName;
  description: string;
  default: string;
  fromText: (s: string) => unknown;
}
export const SITE_DEFS: SiteDef[] = [
  {
    name: "spacing_seconds", default: "1 (the default spacing; a robots.txt Crawl-delay still applies when larger)",
    description: `Least seconds between two requests to the site, ${MIN_SPACING_S} to ${MAX_SPACING_S}. It can only raise the spacing.`,
    fromText: (s) => {
      if (!/^\d{1,2}(\.\d{1,3})?$/.test(s)) throw new ConfigError(`"spacing_seconds" takes seconds from ${MIN_SPACING_S} to ${MAX_SPACING_S}, like 5 or 2.5.`);
      return Number(s);
    },
  },
  {
    name: "ports", default: "none (80, 443 and 8000 to 8999, plus TIRESIAS_ALLOW_PORTS)",
    description: 'Extra ports allowed for the site, like "8443,9000-9100".',
    fromText: (s) => {
      if (!parsePortList(s)) throw new ConfigError('"ports" takes ports or ranges separated by commas, like 8443,9000-9100.');
      return s.replace(/\s+/g, "");
    },
  },
  { name: "hand_off", default: "off", description: "Never read the site: every call about it gives your person the link instead.", fromText: onOff("hand_off") },
  { name: "never_visit", default: "off", description: "Never send the site anything. Beats hand_off.", fromText: onOff("never_visit") },
];
const SITE_DEF = new Map(SITE_DEFS.map((d) => [d.name as string, d]));

// Environment variables: read only here. TIRESIAS_WEB_RISK_KEY is never shown, only whether it is set.
const ENV: { name: string; default: string; description: string; secret?: true }[] = [
  { name: "TIRESIAS_HOME", default: "~/.tiresias", description: "The store folder (shared by every agent pointed at it)." },
  { name: "TIRESIAS_PROFILE", default: "default", description: "The profile to use when --profile is not given." },
  { name: "TIRESIAS_PRIVATE", default: "off", description: "1 makes the whole session private: no page records are saved; minimal politeness state still applies." },
  { name: "TIRESIAS_SAFE_BROWSING", default: "on", description: "0 turns the Safe Browsing check off for the session." },
  { name: "TIRESIAS_ALLOW_PORTS", default: "none", description: 'More ports to allow on every site, like "8080,9000-9100".' },
  { name: "TIRESIAS_MAX_BYTES", default: String(5 * 1024 * 1024), description: "The most bytes of a page that are read." },
  { name: "TIRESIAS_MAX_FILE_BYTES", default: String(50 * 1024 * 1024), description: "The most bytes of a file that are fingerprinted." },
  { name: "TIRESIAS_MAX_INSPECT_BYTES", default: String(20 * 1024 * 1024), description: "The most bytes held to look inside a zip or Office file, never more than the file cap." },
  { name: "TIRESIAS_PARSE_BUDGET_MS", default: "5000", description: "Time allowed to parse one page, in milliseconds." },
  { name: "TIRESIAS_WORKER_HEAP_MB", default: "512", description: "Memory allowed to the page parser, in MB." },
  { name: "TIRESIAS_PDF_MEMORY_MB", default: "1024", description: "Memory allowed to the PDF reader, in MB." },
  { name: "TIRESIAS_RENDERING", default: "not set", description: 'off, ask or auto: overrides the "rendering" setting for the session.' },
  { name: "TIRESIAS_CHROME", default: "not set", description: "The full path of the Chrome program used to render pages, when it is not in the usual place. Tiresias never downloads a browser." },
  { name: "TIRESIAS_WEB_RISK_KEY", default: "not set", description: "A Google Web Risk key (shown here only as set or not set).", secret: true },
];

export interface SettingRow {
  name: string;
  site?: string;
  value: unknown;
  default: unknown;
  description: string;
  stored: string; // where the value lives: the config.json path, or "environment variable"
  is_set: boolean; // false: the default applies
  problem?: string; // the stored value does not validate (fixed text naming the key)
  // W-32 (v0.9), risky settings only:
  risky?: true;
  confirmed?: boolean; // false: config.json loosens it without a confirmation, so `in_force` applies instead
  in_force?: unknown;
}
export interface SettingsView {
  status: "ok" | "error";
  message: string;
  profile: string;
  file: string;
  settings: SettingRow[];
  site_settings: SettingRow[]; // one row per site and setting set, plus each setting's default when no site sets it
  environment: SettingRow[];
  confirmations: { asking: boolean; record: RecordState; file: string; waiting: Waiting[]; recent: Change[]; how: string }; // W-32 (v0.9)
}

export const configFile = (): string => path.join(homeDir(), "config.json");
const tilde = (p: string) => (p.startsWith(os.homedir() + path.sep) ? "~" + p.slice(os.homedir().length) : p);
const msgOf = (e: unknown) => (e instanceof ConfigError ? e.message : "could not be read");

export function view(): SettingsView {
  const file = configFile();
  const where = tilde(file);
  let obj: Record<string, unknown> | null = null;
  const problems: string[] = [];
  try {
    obj = readConfigObject();
  } catch (e) {
    problems.push(msgOf(e));
  }
  const o = obj ?? {};
  const conf = stateForView(obj);
  const held = (name: string, site?: string) => conf.waiting.some((w) => w.setting === name && w.site === site);
  let force: Record<string, unknown> = {};
  try {
    force = inForceConfig() ?? {};
  } catch {
    // reported above
  }
  const forceSites = (typeof force.sites === "object" && force.sites !== null ? force.sites : {}) as Record<string, Record<string, unknown>>;
  const settings: SettingRow[] = DEFS.map((d) => {
    const set = Object.hasOwn(o, d.name);
    const dflt = defaultOf(d);
    const row: SettingRow = { name: d.name, value: set ? o[d.name] : dflt, default: dflt, description: d.description, stored: where, is_set: set };
    if (isRisky(d.name)) {
      row.risky = true;
      row.confirmed = !held(d.name);
      if (!row.confirmed) row.in_force = Object.hasOwn(force, d.name) ? force[d.name] : dflt;
    }
    if (set)
      try {
        d.check(o[d.name]);
      } catch (e) {
        row.problem = msgOf(e);
        problems.push(row.problem);
      }
    return row;
  });
  for (const k of Object.keys(o))
    if (!KNOWN_KEYS.includes(k)) {
      const problem = `config.json has an unknown setting "${k.slice(0, 60)}". Remove it with: tiresias settings reset ${k.slice(0, 60)}`;
      settings.push({ name: k.slice(0, 60), value: o[k], default: null, description: "Not a Tiresias setting.", stored: where, is_set: true, problem });
      problems.push(problem);
    }
  const site_settings: SettingRow[] = [];
  const used = new Set<string>();
  const rawSites = Object.hasOwn(o, "sites") ? o.sites : undefined;
  if (rawSites !== undefined) {
    let ok = true;
    try {
      parseSites(rawSites);
    } catch (e) {
      ok = false;
      problems.push(msgOf(e));
    }
    if (typeof rawSites === "object" && rawSites !== null && !Array.isArray(rawSites))
      for (const [site, rule] of Object.entries(rawSites as Record<string, unknown>)) {
        let siteProblem: string | undefined;
        if (!ok)
          try {
            normalizeSite(site);
            parseSiteRule(site, rule);
          } catch (e) {
            siteProblem = msgOf(e);
          }
        if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
          site_settings.push({ name: "(site)", site, value: rule, default: null, description: "A site's settings.", stored: where, is_set: true, problem: siteProblem });
          continue;
        }
        for (const [name, value] of Object.entries(rule as Record<string, unknown>)) {
          const d = SITE_DEF.get(name);
          used.add(name);
          const row: SettingRow = { name, site, value, default: d?.default ?? null, description: d?.description ?? "Not a site setting.", stored: where, is_set: true, ...(siteProblem ? { problem: siteProblem } : {}) };
          if (isRisky(name)) {
            row.risky = true;
            row.confirmed = !held(name, site);
            if (!row.confirmed) row.in_force = forceSites[site]?.[name] ?? null;
          }
          site_settings.push(row);
        }
      }
  }
  for (const d of SITE_DEFS) if (!used.has(d.name)) site_settings.push({ name: d.name, value: null, default: d.default, description: d.description + " (Set it for one site: tiresias settings set " + d.name + " <site> <value>.)", stored: where, is_set: false });
  const environment: SettingRow[] = ENV.map((e) => {
    const v = process.env[e.name];
    const set = v !== undefined && v !== "";
    return { name: e.name, value: e.secret ? (set ? "set" : "not set") : set ? v!.slice(0, 200) : e.default, default: e.default, description: e.description, stored: "environment variable", is_set: set };
  });
  return {
    status: problems.length ? "error" : "ok",
    message: problems.length
      ? `config.json has ${problems.length} problem${problems.length === 1 ? "" : "s"}: ${problems.join(" ")}`
      : `Every owner setting. Change one with: tiresias settings set <name> [<site>] <value>; undo with: tiresias settings reset <name> [<site>]. Only from this command line: no MCP tool reads or changes a setting. Risky settings (marked) take a confirmation phrase to turn on or loosen${conf.asking ? "" : " (confirmations are off)"}.${conf.waiting.length ? ` ${conf.waiting.length} loosening(s) in config.json wait for confirmation and are not in force.` : ""}`,
    profile: profileName(),
    file,
    settings,
    site_settings,
    environment,
    confirmations: {
      ...conf,
      how: conf.asking
        ? `Turning a risky setting on or looser takes an exact phrase naming it (--confirm "..."); a wrong or missing phrase changes nothing and prints the phrase. Turn this off with: tiresias settings confirmations off --confirm "${NEVER_ASK}"`
        : `Confirmations are OFF: no phrase is asked. Turn them back on with: tiresias settings confirmations on --confirm "${ASK_AGAIN}"`,
    },
  };
}

// The whole object, checked as the reader checks it, before anything is written.
export function validateConfig(o: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(o)) {
    if (k === "sites") parseSites(v);
    else if (DEF.has(k)) DEF.get(k)!.check(v);
    else throw new ConfigError(`config.json has an unknown setting "${k.slice(0, 60)}". Remove it with: tiresias settings reset ${k.slice(0, 60)}`);
  }
}

// The timing rule (coordinator, after Codex round 11): a call reads the settings once, when it starts.
export const APPLIES = " Applies to new requests; requests already running finish under the settings they started with.";
const PRIVATE = "Private mode: settings are not changed, because a private session changes nothing.";
const notChanged = (e: unknown): never => {
  if (e instanceof ConfigError) throw new ConfigError(`Not changed. ${e.message}`);
  throw e;
};

export interface ChangeResult {
  status: "ok";
  message: string;
  name: string;
  site?: string;
  value: unknown; // the value now in force (the default after a reset)
  file: string;
}

function siteArgs(name: string, rest: string[], wantValue: boolean): { site: string; value?: string } {
  if (rest.length !== (wantValue ? 2 : 1)) throw new ConfigError(`Usage: tiresias settings ${wantValue ? "set" : "reset"} ${name} <site>${wantValue ? " <value>" : ""}  (a site is a host name like example.com, or *.example.com)`);
  return { site: normalizeSite(rest[0], true), value: rest[1] };
}

// `settings set <name> [<site>] <value>`.
export function set(name: string | undefined, rest: string[], priv: boolean, confirm?: string): ChangeResult {
  if (priv) throw new ConfigError(PRIVATE);
  if (!name) throw new ConfigError("Usage: tiresias settings set <name> [<site>] <value>. Run tiresias settings to see every name.");
  const file = configFile();
  const sd = SITE_DEF.get(name);
  if (sd) {
    const { site, value } = siteArgs(name, rest, true);
    const v = sd.fromText(value!);
    try {
      confirmedWrite({ name, site }, (o) => {
        if (Object.hasOwn(o, "sites")) parseSites(o.sites); // a broken "sites" is never overwritten: it is reported
        const s = (Object.hasOwn(o, "sites") ? o.sites : {}) as Record<string, SiteRule>;
        const own = Object.hasOwn(s, site) ? s[site] : {};
        o.sites = { ...s, [site]: { ...own, [name]: v } };
      }, validateConfig, { confirm, again: `tiresias settings set ${name} ${sq(site)} ${sq(value!)}` });
    } catch (e) {
      notChanged(e);
    }
    return { status: "ok", message: `Set ${name} for ${site} to ${JSON.stringify(v)}.${APPLIES}`, name, site, value: v, file };
  }
  const d = DEF.get(name);
  if (!d) throw new ConfigError(`"${name.slice(0, 60)}" is not a setting. Run tiresias settings to see every name.`);
  if (!d.fromText) throw new ConfigError(`"${name}" is not changed with settings set. ${d.howToSet ?? ""}`.trim());
  if (rest.length !== 1) throw new ConfigError(`Usage: tiresias settings set ${name} <value>`);
  const v = d.fromText(rest[0]);
  try {
    confirmedWrite({ name }, (o) => void (o[name] = v), validateConfig, { confirm, again: `tiresias settings set ${name} ${sq(rest[0])}` });
  } catch (e) {
    notChanged(e);
  }
  return { status: "ok", message: `Set ${name} to ${JSON.stringify(v)}.${APPLIES}`, name, value: v, file };
}

// `settings reset <name> [<site>]`: removed from config.json, so the default applies. An unknown key that sits in
// the file can be reset too (that is how a bad file is repaired without an editor).
export function reset(name: string | undefined, rest: string[], priv: boolean, confirm?: string): ChangeResult {
  if (priv) throw new ConfigError(PRIVATE);
  if (!name) throw new ConfigError("Usage: tiresias settings reset <name> [<site>]. Run tiresias settings to see every name.");
  const file = configFile();
  if (SITE_DEF.has(name)) {
    const { site } = siteArgs(name, rest, false);
    let had = false;
    try {
      confirmedWrite({ name, site }, (o) => {
        if (typeof o.sites !== "object" || o.sites === null || Array.isArray(o.sites)) return false;
        const s = { ...(o.sites as Record<string, Record<string, unknown>>) };
        const own = Object.hasOwn(s, site) ? s[site] : undefined;
        if (!own || typeof own !== "object" || Array.isArray(own) || !Object.hasOwn(own, name)) return false;
        had = true;
        const { [name]: _gone, ...left } = own;
        if (Object.keys(left).length) s[site] = left;
        else delete s[site];
        if (Object.keys(s).length) o.sites = s;
        else delete o.sites;
      }, validateConfig, { confirm, again: `tiresias settings reset ${name} ${sq(site)}` });
    } catch (e) {
      notChanged(e);
    }
    // What is in force for that site now: a wider wildcard's value, or the default (Codex round 1).
    const dflt = SITE_DEF.get(name)!.default;
    const table = loadSites() as Record<string, Record<string, unknown>>;
    const base = site.startsWith("*.") ? site.slice(2) : site;
    const from = candidates(base).filter((k) => k !== site && !(site.startsWith("*.") && k === base)).find((k) => table[k]?.[name] !== undefined);
    const now = from ? table[from][name] : null;
    const inForce = from ? `${JSON.stringify(now)}, from the entry for ${from}` : `the default (${dflt})`;
    return { status: "ok", message: had ? `Reset ${name} for ${site}. Now in force: ${inForce}.${APPLIES}` : `${name} was not set for ${site}. In force: ${inForce}.`, name, site, value: now, file };
  }
  if (rest.length) throw new ConfigError(`Usage: tiresias settings reset ${name}`);
  if (name === "sites") throw new ConfigError("Reset one site setting at a time: tiresias settings reset <name> <site>.");
  let had = false;
  try {
    confirmedWrite(
      { name },
      (o) => {
        had = Object.hasOwn(o, name);
        if (!had) return false;
        delete o[name];
      },
      // A key that is being removed may be the broken one; every OTHER key must still be right.
      validateConfig,
      { confirm, again: `tiresias settings reset ${name}` },
    );
  } catch (e) {
    notChanged(e);
  }
  const d = DEF.get(name);
  if (!d && !had) throw new ConfigError(`"${name.slice(0, 60)}" is not a setting. Run tiresias settings to see every name.`);
  const dflt = d ? defaultOf(d) : null;
  return { status: "ok", message: had ? `Reset ${name}: the default applies${d ? ` (${JSON.stringify(dflt)})` : ""}.${APPLIES}` : `${name} was not set.`, name, value: dflt, file };
}

// W-32 (v0.9): `settings confirm <name> [<site>]`: confirm what config.json now holds for a risky setting (a hand
// edit that loosened it). Nothing in config.json changes; the record does, and history says who confirmed it.
export function confirmNow(name: string | undefined, rest: string[], priv: boolean, confirm?: string): ChangeResult {
  if (priv) throw new ConfigError(PRIVATE);
  if (!name || !isRisky(name)) throw new ConfigError("Usage: tiresias settings confirm <risky setting> [<site>] --confirm \"...\". Risky settings: private_spacing, hook_secrets, saving, rendering, translator, scanner, anchoring, anchor_calendars, safe_browsing, and the site settings ports, spacing_seconds, never_visit, hand_off.");
  const site = SITE_DEF.has(name) ? siteArgs(name, rest, false).site : undefined;
  if (!site && rest.length) throw new ConfigError(`Usage: tiresias settings confirm ${name} --confirm "..."`);
  const file = configFile();
  try {
    confirmedWrite({ name, site }, () => false, () => {}, { confirm, again: `tiresias settings confirm ${name}${site ? ` ${sq(site)}` : ""}`, confirmOnly: true });
  } catch (e) {
    notChanged(e);
  }
  const force = inForceConfig() ?? {};
  const value = site ? ((force.sites as Record<string, Record<string, unknown>> | undefined)?.[site]?.[name] ?? null) : (force[name] ?? null);
  return { status: "ok", message: `${name}${site ? ` for ${site}` : ""} as config.json holds it is confirmed and in force: ${JSON.stringify(value)}.${APPLIES}`, name, ...(site ? { site } : {}), value, file };
}

// The --text listing.
export function viewText(v: SettingsView): string {
  const show = (x: unknown) => (x === null || x === undefined ? "(none)" : typeof x === "string" ? x : JSON.stringify(x));
  const L = [v.message, `Profile: ${v.profile}   File: ${v.file}`, "", "Settings (config.json):"];
  const conf = (r: SettingRow) => (r.risky ? (r.confirmed ? "  [risky: confirmed]" : `  [risky: NOT CONFIRMED, in force: ${show(r.in_force)}]`) : "");
  for (const r of v.settings) L.push(`  ${r.name} = ${show(r.value)}${r.is_set ? "" : "  (default)"}${conf(r)}${r.problem ? `  PROBLEM: ${r.problem}` : ""}\n      ${r.description} Default: ${show(r.default)}.`);
  L.push("", "Site settings (config.json, per site):");
  for (const r of v.site_settings) L.push(r.site ? `  ${r.site}: ${r.name} = ${show(r.value)}${conf(r)}${r.problem ? `  PROBLEM: ${r.problem}` : ""}\n      ${r.description} Default: ${show(r.default)}.` : `  ${r.name}: not set for any site.\n      ${r.description} Default: ${show(r.default)}.`);
  L.push("", "Environment variables (set in the shell that starts Tiresias; not changed here):");
  for (const r of v.environment) L.push(`  ${r.name} = ${show(r.value)}${r.is_set ? "" : "  (default)"}\n      ${r.description}`);
  const c = v.confirmations;
  L.push("", `Confirmations for risky settings: ${c.asking ? "ON" : "OFF (never ask)"}${c.record === "damaged" ? "  PROBLEM: the record could not be read; risky settings are held at their defaults" : ""}   Record: ${c.file}`, `  ${c.how}`);
  for (const w of c.waiting) L.push(`  Waiting: ${w.setting}${w.site ? ` for ${w.site}` : ""} is loosened in config.json but not confirmed. Confirm: ${w.command}`);
  for (const ch of c.recent.slice(0, 5)) L.push(`  ${ch.at}  ${ch.setting}${ch.site ? ` ${ch.site}` : ""}: ${ch.change}, ${ch.by === "terminal" ? "from a terminal" : "not from a terminal"}, ${ch.confirmed}`);
  return L.join("\n");
}

const USAGE = 'Usage: tiresias settings | settings set <name> [<site>] <value> [--confirm "..."] | settings reset <name> [<site>] [--confirm "..."] | settings confirm <name> [<site>] --confirm "..." | settings confirmations off|on --confirm "..."';
// The command itself (cli.ts hands it the words after "settings"). Throws a ConfigError on a bad request.
export function command(words: string[], priv: boolean, opts: { confirm?: string } = {}): { reply: SettingsView | ChangeResult | { status: "ok"; message: string; asking: boolean }; text: string; code: number } {
  const [sub, name, ...rest] = words;
  if (sub === undefined || sub === "show" || sub === "list") {
    if (name !== undefined) throw new ConfigError(USAGE);
    const v = view();
    return { reply: v, text: viewText(v), code: v.status === "ok" ? 0 : 1 };
  }
  if (sub === "set" || sub === "reset") {
    const r = sub === "set" ? set(name, rest, priv, opts.confirm) : reset(name, rest, priv, opts.confirm);
    return { reply: r, text: r.message, code: 0 };
  }
  if (sub === "confirm") {
    const r = confirmNow(name, rest, priv, opts.confirm);
    return { reply: r, text: r.message, code: 0 };
  }
  if (sub === "confirmations") {
    if (priv) throw new ConfigError(PRIVATE);
    if ((name !== "on" && name !== "off") || rest.length) throw new ConfigError(`Usage: tiresias settings confirmations off --confirm "${NEVER_ASK}" | settings confirmations on --confirm "${ASK_AGAIN}"`);
    const r = setAsking(name === "on", opts.confirm);
    return { reply: { status: "ok", message: r.message, asking: name === "on" }, text: r.message, code: 0 };
  }
  throw new ConfigError(USAGE);
}
