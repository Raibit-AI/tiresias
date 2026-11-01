// SPDX-License-Identifier: Apache-2.0
// W-26 (v0.7): the owner's translation hook. A slot, not a translator: Tiresias ships with none and calls no
// service. Built like the scanner hook (W-21): the owner names ONE command in config.json ("translator"), from
// the command line (tiresias translator set) or by editing the file. Nothing reachable over MCP reads the
// command, sets it or changes it; an agent can only ask, per read, for a translation into one language, and only
// when the owner has set the hook.
//
// The command is run directly (hook.ts: no shell, a full path, its own process group, killed whole at the time
// cap) as  <command> [args...] <source> <target>,  with the text the reply shows on its standard input (UTF-8,
// at most 32 KB) and at most 64 KB of its standard output kept. That output is the translation: it goes inside
// untrusted_content.translation, marked as a machine translation by the owner's tool, never as the page's own
// words. Receipts are built before the hook runs and always quote the ORIGINAL text; the translation is never
// cached, logged, kept in history or receipts, or scanned into the page's flags.
import fs from "node:fs";
import path from "node:path";
import { ConfigError, loadTranslator, parseTranslator, readConfigObject, type TranslatorConfig } from "./config.js";
import { confirmedWrite, sq } from "./confirm.js";
import { runHook } from "./hook.js";
import { byteLen, jsonBytes, type Envelope } from "./types.js";

export const MAX_INPUT = 32 * 1024; // bytes of text handed to the hook
export const MAX_OUTPUT = 64 * 1024; // bytes of its output kept
const HARD_LIMIT = 100_000; // the reply's size guard (envelope.ts BUDGET.hardLimit)

export type TranslationReason =
  | "not_set" | "bad_setting" | "missing_command" | "timeout" | "too_large" | "exit_code" | "empty" | "cancelled"
  | "same_language" | "nothing_to_translate" | "unsupported_platform" | "bad_language";
// The top level of a reply: every value is Tiresias's own (fixed codes, the owner's command's file name, the
// detected language code, and the target language the caller passed, checked against a strict pattern).
export interface TranslationTop {
  status: "ok" | "failed" | "skipped" | "unavailable";
  reason?: TranslationReason;
  by?: string; // the command's file name (the owner's own setting)
  from: string; // the detected language, or "und" when it is unknown
  to: string;
  input_cut?: true; // the text was longer than 32 KB: only its start was translated
}

// A target language: a plain BCP 47 tag (language, then up to two subtags), case-folded. Nothing else can reach
// the owner's command as an argument: it never starts with a dash and holds only letters, digits and hyphens.
export const TARGET = /^[a-z]{2,3}(-[a-z0-9]{2,8}){0,2}$/;
export function parseTarget(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 20) return null;
  const t = v.trim().toLowerCase().replace(/_/g, "-");
  return TARGET.test(t) ? t : null;
}

export const NOTE =
  "A machine translation of the text above, made by the owner's own translation tool. It is not the page's own words and may be wrong; every receipt quotes the original text, never this.";
const MSG_OK = "A translation by the owner's own tool is in untrusted_content.translation; receipts quote the original text.";
const MSG_NOT = "No translation was made (see translation.reason). The page is shown in its own language.";

// The text a reply shows, as plain lines: the title, then the outline's headings and previews, a section's text,
// or the passages and their headings.
export function shownText(uc: Record<string, unknown> | null): string {
  if (!uc) return "";
  const L: string[] = [];
  const str = (x: unknown) => (typeof x === "string" && x ? L.push(x) : 0);
  str(uc.title);
  if (Array.isArray(uc.outline)) for (const o of uc.outline as Record<string, unknown>[]) (str(o?.heading), str(o?.preview));
  const sec = uc.section as Record<string, unknown> | undefined;
  if (sec && typeof sec === "object") (str(sec.heading), str(sec.text));
  if (Array.isArray(uc.passages)) for (const p of uc.passages as Record<string, unknown>[]) (str(p?.heading), str(p?.text));
  const inside = uc.inside;
  if (inside && typeof inside === "object" && !Array.isArray(inside)) {
    const content = inside as Record<string, unknown>;
    if (Array.isArray(content.sections)) for (const s of content.sections as Record<string, unknown>[]) (str(s?.heading), str(s?.text));
    str(shownText({ outline: content.outline, section: content.section, passages: content.passages }));
  }
  return L.join("\n");
}
// Cut to at most `max` UTF-8 bytes, on a character boundary.
export function cutBytes(s: string, max: number): { text: string; cut: boolean } {
  if (byteLen(s) <= max) return { text: s, cut: false };
  let lo = 0;
  let hi = Math.min(s.length, max);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (byteLen(s.slice(0, mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  if (lo > 0 && /[\ud800-\udbff]/.test(s[lo - 1])) lo--;
  return { text: s.slice(0, lo), cut: true };
}

// The hook of this profile, or why there is none.
function config(): { cfg: TranslatorConfig } | { reason: "not_set" | "bad_setting" } {
  try {
    const cfg = loadTranslator();
    return cfg ? { cfg } : { reason: "not_set" };
  } catch {
    return { reason: "bad_setting" };
  }
}

// Adds a translation to a reply that shows a page, in place. Never throws: anything that goes wrong is a fixed
// reason on `translation`, and the page is returned as it is.
export async function translateReply(e: Envelope, wanted: string): Promise<void> {
  const from = e.language && e.language.code !== "unknown" ? e.language.code : "und";
  const to = parseTarget(wanted);
  const set = (t: TranslationTop) => {
    e.translation = t;
    e.message = `${e.message ? e.message + " " : ""}${t.status === "ok" ? MSG_OK : MSG_NOT}`;
  };
  if (!to) return set({ status: "skipped", reason: "bad_language", from, to: "und" });
  const c = config();
  if ("reason" in c) return set({ status: "unavailable", reason: c.reason, from, to });
  const by = path.basename(c.cfg.command[0]).slice(0, 100);
  if (from === to.split("-")[0]) return set({ status: "skipped", reason: "same_language", by, from, to });
  const shown = shownText(e.untrusted_content as Record<string, unknown> | null);
  if (!shown.trim()) return set({ status: "skipped", reason: "nothing_to_translate", by, from, to });
  let file: fs.Stats | null = null;
  try {
    file = fs.statSync(c.cfg.command[0]);
  } catch {
    // gone
  }
  if (!file?.isFile()) return set({ status: "failed", reason: "missing_command", by, from, to });
  const input = cutBytes(shown, MAX_INPUT);
  const cut = input.cut ? { input_cut: true as const } : {};
  const r = await runHook(c.cfg.command, [from, to], c.cfg.timeout_seconds * 1000, MAX_OUTPUT, input.text);
  if (!r.ok) {
    const reason: TranslationReason = r.reason === "no_answer" ? "exit_code" : r.reason;
    return set({ status: "failed", reason, by, from, to, ...cut });
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(r.out).replace(/^﻿/, "");
  if (!text.trim()) return set({ status: "failed", reason: "empty", by, from, to, ...cut });
  const uc = (e.untrusted_content ?? {}) as Record<string, unknown>;
  uc.translation = { text, note: NOTE };
  e.untrusted_content = uc;
  set({ status: "ok", by, from, to, ...cut });
  fitTranslation(e);
}

// Saving adds metadata after the hook; check again once that metadata is in place too.
export function fitTranslation(e: Envelope): void {
  if (e.translation?.status !== "ok" || jsonBytes(e) <= HARD_LIMIT) return;
  const uc = e.untrusted_content as Record<string, unknown> | null;
  if (uc) delete uc.translation;
  e.message = (e.message ?? "").replace(MSG_OK, MSG_NOT);
  e.translation = { ...e.translation, status: "failed", reason: "too_large" };
}

// ---- The owner's commands (CLI only) ----

const PRIVATE = "Private mode: the translator setting is not changed, because a private session changes nothing.";

export function setTranslator(command: string[], opts: { timeout?: string; confirm?: string }, priv = false): TranslatorConfig {
  if (priv) throw new ConfigError(PRIVATE);
  const timeout = opts.timeout === undefined ? 20 : /^\d{1,2}$/.test(opts.timeout) ? Number(opts.timeout) : NaN;
  const cfg = parseTranslator({ command, timeout_seconds: timeout });
  let st: fs.Stats;
  try {
    st = fs.statSync(cfg.command[0]);
  } catch {
    throw new ConfigError(`${cfg.command[0]} does not exist. Give the full path to the program to run.`);
  }
  if (!st.isFile()) throw new ConfigError(`${cfg.command[0]} is not a file. Give the full path to the program to run.`);
  // W-32 (v0.9): a new translator program takes its phrase; every change is recorded.
  const shown = cfg.command.map((x) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(x) ? x : sq(x))).join(" "); // Codex round 5: never expandable
  confirmedWrite({ name: "translator" }, (o) => void (o.translator = cfg), () => {}, { confirm: opts.confirm, again: `tiresias translator set --timeout ${cfg.timeout_seconds} -- ${shown}` });
  return cfg;
}

export function clearTranslator(priv = false): boolean {
  if (priv) throw new ConfigError(PRIVATE);
  const o = readConfigObject();
  if (!o || !Object.hasOwn(o, "translator")) return false;
  confirmedWrite({ name: "translator" }, (x) => void delete x.translator, () => {}, { again: "tiresias translator off" });
  return true;
}
