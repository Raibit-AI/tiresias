// SPDX-License-Identifier: Apache-2.0
// W-25 (v0.6): site settings, like Chrome's per-site settings. The owner sets them in config.json, key
// "sites", from the command line (tiresias settings set ...) or by editing the file; nothing reachable over
// MCP reads or changes them (W-29).
//
//   "sites": {
//     "example.com":   { "spacing_seconds": 5, "ports": "8443,9000-9100" },
//     "*.example.org": { "hand_off": true },
//     "tracker.test":  { "never_visit": true }
//   }
//
// A site is a host name ("example.com", applying to every scheme and port of exactly that host) or a
// wildcard ("*.example.org": that host and every name under it). For each setting the most specific entry
// that sets it wins: the exact host, then the closest wildcard. Settings:
//   spacing_seconds  the least time between two requests to the site, 1 to 30 seconds. It can only RAISE the
//                    spacing: the default 1 second and a robots.txt Crawl-delay still apply when larger.
//   ports            extra ports allowed for the site, on top of 80, 443 and 8000 to 8999 (and
//                    TIRESIAS_ALLOW_PORTS); written like that variable: "8443,9000-9100".
//   hand_off         true: never read it; every call about it gives the person the link instead (status wall,
//                    handoff.reason "owner_hand_off").
//   never_visit      true: never send it anything (status refused). Beats hand_off.
// They apply to every request of every call (the asked URL, each redirect hop, robots.txt, door checks, a form's
// target), and the reply names the ones that applied in top-level `site_settings`.
// A bad "sites" value fails every call that sends a request, with an error naming the site and the setting
// (fail closed: a broken entry might be a "never_visit"). clear and the daily trim never read it.
import net from "node:net";
import { readConfigObject } from "./config.js";
import { inForceConfig } from "./confirm.js";
import { callContext } from "./context.js";
import { ConfigError, Refused, SafetyError } from "./errors.js";
import { hostKey } from "./sitekey.js";
import type { SiteSettingCode } from "./types.js";

export interface SiteRule {
  spacing_seconds?: number;
  ports?: string;
  hand_off?: boolean;
  never_visit?: boolean;
}
export const SITE_SETTINGS = ["spacing_seconds", "ports", "hand_off", "never_visit"] as const;
export type SiteSettingName = (typeof SITE_SETTINGS)[number];
export const MAX_SITES = 500;
export const MAX_CONFIRMED_SITES = 5000;
export const MIN_SPACING_S = 1;
export const MAX_SPACING_S = 30;
export const DEFAULT_PORTS: [number, number][] = [[80, 80], [443, 443], [8000, 8999]];

const bad = (site: string, what: string) => new ConfigError(`config.json: "sites" → "${site.slice(0, 80)}": ${what}`);

// A port list like TIRESIAS_ALLOW_PORTS: "8443,9000-9100". Returns the ranges, or null when it does not parse.
export function parsePortList(raw: string): [number, number][] | null {
  if (raw.length > 200) return null;
  const out: [number, number][] = [];
  for (const part of raw.split(",")) {
    const m = /^\s*(\d{1,5})(?:\s*-\s*(\d{1,5}))?\s*$/.exec(part);
    const lo = m ? Number(m[1]) : NaN;
    const hi = m ? Number(m[2] ?? m[1]) : NaN;
    if (!m || lo < 1 || hi > 65535 || lo > hi) return null;
    out.push([lo, hi]);
  }
  return out.length ? out : null;
}

// The host a URL names, as site settings match it: lower case, IDNA (the URL parser's own form), no trailing dot.
export { hostKey } from "./sitekey.js";
const isIp = (h: string) => net.isIP(h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h) !== 0;

// The one written form of a site. `loose` (the CLI): also takes a full URL or capitals and returns the written
// form; strict (config.json): the key must already BE the written form, so one site is never two entries.
export function normalizeSite(raw: unknown, loose = false): string {
  const shown = typeof raw === "string" ? raw : String(raw);
  const fail = () => new ConfigError(`"${shown.slice(0, 80)}" is not a site. Write a host name like example.com, or *.example.com for it and every name under it.`);
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 260 || /[\u0000- \u007f]/.test(raw)) throw fail();
  let s = raw;
  if (loose && /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      s = new URL(s).hostname;
    } catch {
      throw fail();
    }
  }
  const wild = s.startsWith("*.");
  const base = wild ? s.slice(2) : s;
  if (!base || /[/?#@\\%*]/.test(base) || (/:/.test(base) && !(base.startsWith("[") && base.endsWith("]")))) throw fail();
  let host: string;
  try {
    const u = new URL(`http://${base}/`);
    if (u.port || u.username || u.password) throw fail();
    host = hostKey(u.hostname);
  } catch {
    throw fail();
  }
  if (!host || (wild && isIp(host)) || ["__proto__", "constructor", "prototype"].includes(host)) throw fail();
  // Codex v0.9 round 2: only the characters of DNS names and IP addresses. The URL parser lets a few others through
  // (like $ or parentheses), which no real host has; a site written in config.json reaches the commands Tiresias
  // suggests, so it must never hold shell syntax.
  if (!/^[a-z0-9_.-]+$/.test(host) && !/^\[[0-9a-f:.]+\]$/.test(host)) throw fail();
  const out = (wild ? "*." : "") + host;
  if (!loose && out !== raw) throw new ConfigError(`config.json: "sites" → "${raw.slice(0, 80)}" must be written as "${out}".`);
  return out;
}

export function parseSiteRule(site: string, v: unknown): SiteRule {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw bad(site, `must be an object of settings (${SITE_SETTINGS.join(", ")}).`);
  const o = v as Record<string, unknown>;
  const out: SiteRule = {};
  for (const k of Object.keys(o)) {
    const x = o[k];
    if (k === "spacing_seconds") {
      if (typeof x !== "number" || !Number.isFinite(x) || x < MIN_SPACING_S || x > MAX_SPACING_S)
        throw bad(site, `"spacing_seconds" must be a number of seconds from ${MIN_SPACING_S} to ${MAX_SPACING_S} (it can only raise the default spacing of 1 second).`);
      out.spacing_seconds = x;
    } else if (k === "ports") {
      if (typeof x !== "string" || !parsePortList(x)) throw bad(site, `"ports" must be ports or ranges separated by commas, like "8443,9000-9100".`);
      out.ports = x;
    } else if (k === "hand_off" || k === "never_visit") {
      if (typeof x !== "boolean") throw bad(site, `"${k}" must be true or false.`);
      out[k] = x;
    } else throw bad(site, `unknown setting "${k.slice(0, 60)}". Site settings: ${SITE_SETTINGS.join(", ")}.`);
  }
  return out;
}

export function parseSites(v: unknown, max = MAX_SITES): Record<string, SiteRule> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ConfigError('config.json: "sites" must be an object, like {"example.com": {"spacing_seconds": 5}}.');
  const keys = Object.keys(v);
  if (keys.length > max) throw new ConfigError(`config.json: "sites" has more than ${max} sites.`);
  const out: Record<string, SiteRule> = Object.create(null);
  for (const k of keys) {
    normalizeSite(k); // strict: the written form
    out[k] = parseSiteRule(k, (v as Record<string, unknown>)[k]);
  }
  return out;
}

export function loadSites(): Record<string, SiteRule> {
  const raw = readConfigObject();
  if (raw && Object.hasOwn(raw, "sites")) parseSites(raw.sites);
  const o = inForceConfig(); // W-32: an unconfirmed loosening is held back
  return o && Object.hasOwn(o, "sites") ? parseSites(o.sites, MAX_SITES + MAX_CONFIRMED_SITES) : Object.create(null);
}

// The entries that can apply to a host, most specific first: the host itself, then each wildcard above it.
// A host name longer than DNS allows (253 characters) names no site anyone can reach: it is refused before any
// work is done on it (Codex round 2: every suffix of a huge name was built).
export const MAX_HOST = 253;
export const HOST_TOO_LONG = "Refused: the host name is longer than 253 characters, which no real site has.";
export function candidates(hostname: string): string[] {
  if (hostname.length > MAX_HOST + 3) throw new SafetyError(HOST_TOO_LONG); // + a trailing dot, or IPv6 brackets
  const h = hostKey(hostname);
  const keys = [h];
  if (!isIp(h)) for (let rest = h; rest; rest = rest.includes(".") ? rest.slice(rest.indexOf(".") + 1) : "") keys.push("*." + rest);
  return keys;
}

// The settings that apply to a host: for each one, the most specific entry that sets it.
// Within a call, the call's snapshot (context.ts); outside any call (shared work such as the Safe Browsing list
// download), the file as it is now.
export function ruleFor(hostname: string, sites: Record<string, SiteRule> = callContext.getStore()?.sites ?? loadSites()): SiteRule {
  const keys = candidates(hostname);
  const out: SiteRule = {};
  for (const name of SITE_SETTINGS)
    for (const k of keys) {
      const r = Object.hasOwn(sites, k) ? sites[k] : undefined;
      if (r && r[name] !== undefined) {
        (out as Record<string, unknown>)[name] = r[name];
        break;
      }
    }
  return out;
}

// Record that a site setting applied to the current call (guarded() puts the set on the reply).
export function noteApplied(code: SiteSettingCode): void {
  callContext.getStore()?.site?.add(code);
}

// A request the owner's site settings forbid. A Refused, so every path treats it as a "no" (a door probe as no
// door, robots.txt as a failure, a form as not sent); the reply is built from `setting` (envelope.ts).
export class SiteRefused extends Refused {
  constructor(public setting: "never_visit" | "hand_off", url: string) {
    super(setting === "never_visit" ? NEVER_VISIT : HAND_OFF, undefined, undefined, url);
  }
}
export const NEVER_VISIT = "Refused: the owner's site settings say never to visit this site. Nothing was sent to it.";
export const HAND_OFF = "The owner's site settings say a person handles this site: Tiresias does not read it. Give your person the link.";

// Before anything is sent to (or served for) a URL: never_visit, then hand_off.
export function assertSiteAllowed(u: URL): void {
  const r = ruleFor(u.hostname);
  if (r.never_visit) {
    noteApplied("never_visit");
    throw new SiteRefused("never_visit", u.href);
  }
  if (r.hand_off) {
    noteApplied("hand_off");
    throw new SiteRefused("hand_off", u.href);
  }
}

// The site's own spacing in seconds (0 when it has none).
export const siteSpacing = (u: URL): number => ruleFor(u.hostname).spacing_seconds ?? 0;

// Whether the site's own "ports" allow this port (checked only when the default list does not).
export function sitePortAllowed(u: URL, port: number): boolean {
  const p = ruleFor(u.hostname).ports;
  const ranges = p ? parsePortList(p) : null;
  if (!ranges || !ranges.some(([lo, hi]) => port >= lo && port <= hi)) return false;
  noteApplied("ports");
  return true;
}
