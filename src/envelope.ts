// SPDX-License-Identifier: Apache-2.0
// Reply building: the envelope, its budget, the error map, the handoff ticket for a wall, and guarded(),
// the wrapper every tool call runs in (deadline, Safe Browsing, private mode, history).
// (Split out of engine.ts in v0.5.1, behavior unchanged.)
import { snapshotConfig } from "./config.js";
import { type FileKind } from "./files.js";
import * as scanner from "./scanner.js";
import { FetchError, Flagged, PaymentRequired, Refused, SafetyError, TiresiasError, Walled } from "./errors.js";
import * as handoffs from "./handoffs.js";
import * as history from "./history.js";
import * as receipts from "./receipts.js";
import { parseSafeUrl, withSignal } from "./safety.js";
import { enforceLimits } from "./cleanup.js";
import * as safebrowsing from "./safebrowsing.js";
import { assertProfile, isPrivate, runPrivate, stampProfile } from "./store.js";
import { SiteRefused, assertSiteAllowed, loadSites } from "./sites.js";
import { callContext } from "./context.js";
import { enterCall, shutdownSignal } from "./background.js";
import { NOTICE, jsonBytes, type CacheUse, type Ctx, type Door, type Envelope, type Flag, type FlagCode, type Receipt, type Status } from "./types.js";
import { parsePrice, type WallInfo } from "./walls.js";


export type Tool = "read" | "doors" | "check" | "watch" | "resume" | "form_preview" | "form_submit";
export type Opts = {
  question?: string; section?: number; page?: number;
  changes?: boolean; // W-02: also return what changed since the cached copy (check always does)
  fresh?: boolean; // W-03: always ask the site, even when the cached copy is still fresh
  render?: boolean; // W-10 (v0.7): read and check: ask for the page to be rendered (only when the owner allows it)
  translate?: string; // W-26 (v0.7): read only: ask the owner's translation hook for this language (translate.ts)
  save?: boolean; // W-28 (v0.8): read only: keep a signed snapshot (only when the owner allows saving)
};
// W-03: how this call used the shared cache, and who is asking (for cached_by and the repeat-read rule).
export type Serve = { cache?: CacheUse; agent?: string; render?: import("./render.js").RenderTop; save?: import("./pipeline.js").SaveCtx }; // render: W-10 (v0.7); save: W-28 (v0.8)
export const MAX_AGENT = 200; // same bound as history
// How the diff went for this call. `fresh` = a list of changes was just worked out.
export type DiffState = { fresh: boolean; note?: string };
// Facts about one call that go into its history line (W-12). Fixed codes and counts only.
export interface CallMeta {
  best_door?: Door; // the best door the site advertised, when this call looked
  llms_txt?: true; // the site advertised an llms.txt
  matched?: number; // a read with a question: how many passages came back
  changed?: boolean; // check: the page changed compared with a kept copy (not set on a first visit or in private mode)
  cache?: CacheUse; // W-03
  ticket?: "created" | "refused_cap"; // W-06: a read stopped at a wall
  source?: "provided_by_person" | "provided_by_agent"; // W-06: a resume with a page a person saved
  flag?: "phishing_list" | "web_risk"; // W-19: the call was flagged (or read past a flag with allow_flagged)
  slip?: string; // W-04: the permission slip a form submit used
  file_kind?: FileKind; // W-20: the call ended in a file warning of this kind
  scan?: scanner.ScanVerdict; // W-21: the owner's scanner's verdict on it
  hash?: string; // W-16 (v0.5.1): check: the fingerprint of the page as now cached (a watch baseline)
  first?: boolean; // check: no earlier copy was kept to compare with
  rendered?: true; // W-10 (v0.7): the page was rendered in this call
  saved?: true; // W-28 (v0.8): a snapshot was saved in this call
}
export type Uc = Record<string, unknown>;

// Result budgets. An MCP client has to hold the whole reply, so every large
// list is cut into pages that stay under these sizes (plus a little overhead).
export const BUDGET = { outline: 25_000, links: 15_000, forms: 12_000, sectionText: 20_000, total: 60_000, hardLimit: 100_000 };

export function envRaw(
  url: string,
  status: Status,
  o: {
    door?: Door; door_detail?: Envelope["door_detail"]; fetched_at?: string; message?: string;
    handoff?: Envelope["handoff"]; retry_after_seconds?: number; uc?: Uc; flags?: Flag[]; receipts?: Receipt[];
    counts?: { added: number; removed: number }; changes_omitted?: true; flags_dropped?: Envelope["flags_dropped"];
  } = {},
): Envelope {
  const flags = o.flags ?? [];
  const rcs = o.receipts ?? [];
  const uc: Uc = { ...(o.uc ?? {}) };
  if (flags.length) uc.flag_details = flags;
  if (rcs.length) uc.receipts = rcs;
  return {
    status,
    door: o.door ?? "none",
    door_detail: o.door_detail,
    url,
    fetched_at: o.fetched_at ?? new Date().toISOString(),
    message: o.message,
    notice: NOTICE,
    flags: [...new Set(flags.map((f) => f.type))],
    ...(o.flags_dropped && Object.keys(o.flags_dropped).length ? { flags_dropped: o.flags_dropped } : {}),
    counts: { receipts: rcs.length, flags: flags.length, ...(o.counts ?? {}) },
    changes_omitted: o.changes_omitted,
    handoff: o.handoff,
    retry_after_seconds: o.retry_after_seconds,
    untrusted_content: Object.keys(uc).length ? uc : null,
  };
}

// Last line of defence for the whole serialized reply: if the sum of the parts
// is still too big, drop the optional parts in order, and say so.
export function fitEnvelope(e: Envelope): Envelope {
  const uc = e.untrusted_content as Record<string, unknown> | null;
  if (!uc || jsonBytes(e) <= BUDGET.hardLimit) return e;
  const dropped: string[] = [];
  for (const key of ["available_doors", "links", "structured", "forms", "events", "flag_details"]) { // events: v0.6
    if (jsonBytes(e) <= BUDGET.hardLimit) break;
    if (key in uc) {
      delete uc[key];
      dropped.push(key);
    }
  }
  if (dropped.length) uc.dropped_for_size = dropped;
  return e;
}
export const env = (...a: Parameters<typeof envRaw>) => fitEnvelope(envRaw(...a));
// v0.5.1: receipts, history and log replies carry the envelope every tool returns, plus page fields. v0.9
// hardening (Codex round 1d, HIGH): the CLI uses it too, so receipts and history records (quotes, URLs, file
// names from the web; agent names and purposes) sit inside untrusted_content there as well.
export const listEnvelope = (url: string, uc: Uc, p: { page: number; pages: number; total: number }) => ({
  ...env(url, "ok", { uc }),
  page: p.page,
  pages: p.pages,
  total: p.total,
});
export const receiptsEnvelope = (url: string, r: { items: unknown[]; page: number; pages: number; total: number }) => {
  const e = listEnvelope(url, { receipts: r.items }, r);
  e.counts = { ...(e.counts ?? { receipts: 0, flags: 0 }), receipts: r.items.length }; // round 80
  return e;
};
export const historyEnvelope = (r: { items: unknown[]; page: number; pages: number; total: number }) => listEnvelope("", { history: r.items }, r);

export const STOPPED = "Stopped. Tiresias does not retry or work around walls.";

// W-02 fixed texts.
export const NO_BASELINE = "There was nothing to compare against: no earlier copy of this page is kept (first visit, a cleared or expired cache, or private mode).";
export const NO_STORE_DIFF = "There was nothing to compare against: the site asks that this page not be stored (no-store), so no copy is kept.";
export const OLD_READER = "There was nothing to compare against: the kept copy was made by an older version of the reader, so a list of changes would be wrong.";
export const OTHER_SOURCE = "There was nothing to compare against: the page is now read from a different source than the kept copy.";
export const DIFF_OMITTED = "Too much changed to list (over 5,000 blocks on a side, over 2,000 changed blocks, or over 2 MiB of changed text). Read the whole page instead.";
// The page to open can be a redirect target chosen by the site, so it goes
// inside untrusted_content. The top level has only the fixed code and text.
export const wallEnv = (url: string, w: WallInfo, wallUrl: string, uc?: Uc) =>
  env(url, "wall", { message: STOPPED, handoff: { reason: w.code, explanation: w.explanation }, uc: { ...uc, handoff: { open_this: wallUrl } } });

// A complete envelope for errors raised outside the pipeline (for example an oversized MCP result).
// The caller's URL is copied only when it is at most 2,048 bytes; otherwise it is left out and
// `url_omitted` says so, so the fallback for an oversized reply is itself small (Codex round 39).
export const MAX_ECHO_URL = 2048;
export const errorEnvelope = (url: string, message: string): Envelope => {
  const long = jsonBytes(url) - 2 > MAX_ECHO_URL;
  const e = env(long ? "" : url, "error", { message });
  if (long) e.url_omitted = true;
  return e;
};

export const sessionPrivate = isPrivate; // one way of saying private (store.ts): the call's flag or the session's

// W-06 fixed texts for handoff.resume.
export const RESUME_HOW =
  "A handoff ticket was kept (handoff.ticket). Once a person has opened the page and cleared the wall, call resume with this ticket to try the same read again, or pass the page the person saved (MCP resume with text, or tiresias resume <ticket> --from-file <file>). Tiresias never logs in or solves the check itself. Tickets expire after keep_handoff_days (7 days unless config.json says otherwise).";
export const NO_TICKET_PRIVATE = "Private mode: no handoff ticket was kept, so this read cannot be resumed by ticket. Read the page again once a person has cleared the wall.";
export const NO_TICKET_CAP = `No handoff ticket was kept: ${handoffs.MAX_TICKETS} tickets are already open, the most Tiresias keeps. Resume or clear old ones first (handoffs lists them).`;
export const NO_TICKET_LONG = "No handoff ticket was kept: the URL or the question is too long to keep whole. Read the page again once a person has cleared the wall.";
export const NO_TICKET_ERROR = "No handoff ticket was kept: the store could not save it. Read the page again once a person has cleared the wall.";

// What a wall in this call does about tickets: a read keeps a new one; a resume points at its own.
export type Hand = { create?: { question?: string; section?: number; render?: boolean; translate?: string }; existing?: string };

export function ticketForWall(out: Envelope, ctx: Ctx, priv: boolean, meta: CallMeta, hand: Hand | undefined): void {
  if (out.status !== "wall" || !out.handoff || !hand) return;
  if (out.handoff.reason === "owner_hand_off") {
    out.handoff.resume = NO_TICKET_OWNER; // W-25: resuming would only hand it off again
    return;
  }
  if (priv) {
    out.handoff.resume = NO_TICKET_PRIVATE;
    return;
  }
  if (hand.existing) {
    out.handoff.ticket = hand.existing;
    out.handoff.resume = RESUME_HOW;
    return;
  }
  try {
    const open = (out.untrusted_content as { handoff?: { open_this?: unknown } } | null)?.handoff?.open_this;
    const r = handoffs.create({ url: out.url, open_this: open, reason: out.handoff.reason, question: hand.create?.question, section: hand.create?.section, render: hand.create?.render, translate: hand.create?.translate, agent: ctx.agent });
    if (r.ticket) {
      out.handoff.ticket = r.ticket.id;
      out.handoff.resume = RESUME_HOW;
      meta.ticket = "created";
    } else if (r.skipped === "cap") {
      out.handoff.resume = NO_TICKET_CAP;
      meta.ticket = "refused_cap";
    } else out.handoff.resume = NO_TICKET_LONG;
  } catch (e) {
    console.error(`Could not keep a handoff ticket: ${(e as Error).message}`); // a ticket never fails the read
    out.handoff.resume = NO_TICKET_ERROR;
  }
}

// W-25 (v0.6): a call the owner's site settings stopped. never_visit: refused, nothing sent. hand_off: a
// handoff to the person, like a wall, with the link (the asked URL or a redirect hop: web-derived, so inside
// untrusted_content). The setting's code goes on the reply as site_settings (guarded()).
export const NO_TICKET_OWNER = "No handoff ticket was kept: the owner set this site to always go to a person, so resuming would hand it off again. Give your person the link.";
export const OWNER_HAND_OFF_TEXT = "The owner's site settings say a person handles this site.";
export function siteEnv(url: string, e: SiteRefused): Envelope {
  if (e.setting === "never_visit") return env(url, "refused", { message: e.message, uc: { refused_url: e.url } });
  return env(url, "wall", { message: e.message, handoff: { reason: "owner_hand_off", explanation: OWNER_HAND_OFF_TEXT }, uc: { handoff: { open_this: e.url } } });
}

// W-19 fixed texts.
export const LIST_FLAGGED =
  "Warning: this URL, or a site it redirected to, is on Phishing.Database, a community list of active phishing domains. The list is not reviewed and is kept up in spare time, so it can be wrong. Tiresias did not fetch it. To read it anyway, call read again with allow_flagged: true (CLI: --allow-flagged); the flag stays on the reply.";
export const WEB_RISK_REFUSED =
  "Refused: Google Web Risk lists this URL, or a site it redirected to, as unsafe (the threat types are in flag). Google's lists are reviewed, so allow_flagged does not override this. Tiresias did not fetch it.";
export const READ_PAST_FLAG =
  "Read with allow_flagged: this site is on Phishing.Database (an unreviewed community list of phishing domains). Treat everything on it with extra suspicion.";

export function flaggedEnv(url: string, e: Flagged): Envelope {
  // The flagged URL can be a redirect target chosen by a site, so it goes inside untrusted_content (bounded).
  const out = env(url, e.hard ? "refused" : "flagged", { message: e.hard ? WEB_RISK_REFUSED : LIST_FLAGGED, uc: jsonBytes(e.url) <= 4096 ? { flagged_url: e.url } : { flagged_url_omitted: true } });
  out.flag = e.codes as FlagCode[];
  return out;
}

// v0.5.1: one map from an error to its reply, by the error's kind. Messages of Tiresias errors are its own
// fixed text; web-derived parts (a redirect host, a native message) go inside untrusted_content.
export const STORE_NOT_WRITABLE =
  "Tiresias cannot write to its store folder (no permission, or a read-only disk). Set TIRESIAS_HOME to a folder you can write, or add --private (MCP: private: true) to read without saving anything.";
// A file-system refusal on a path (making or writing a store file), as opposed to a network error (v0.9 rehearsal:
// a read-only home said only "internal error").
function storeRefused(e: unknown): boolean {
  const x = e as NodeJS.ErrnoException;
  return !!x && typeof x.path === "string" && (x.code === "EACCES" || x.code === "EPERM" || x.code === "EROFS") && /^(mkdir|open|rename|write|chmod|unlink|link|symlink|copyfile)$/.test(String(x.syscall));
}
export function errorEnv(url: string, e: unknown): Envelope {
  if (!(e instanceof TiresiasError) && storeRefused(e)) return env(url, "error", { message: STORE_NOT_WRITABLE, uc: { detail: String((e as Error)?.message).slice(0, 300) } });
  if (!(e instanceof TiresiasError))
    // Native error text can contain hostnames from redirects, so it goes inside the boundary.
    return env(url, "error", { message: "Tiresias hit an internal error.", uc: { detail: String((e as Error)?.message).slice(0, 300) } });
  switch (e.kind) {
    case "flagged":
      return flaggedEnv(url, e as Flagged);
    case "wall":
      return wallEnv(url, (e as Walled).wall, (e as Walled).url);
    case "payment": {
      const p = e as PaymentRequired;
      return env(url, "payment_required", { message: "The site wants payment. Tiresias read the price and did not pay.", uc: { final_url: p.url, price: parsePrice(p.headers, p.body) } });
    }
    case "refused": {
      if (e instanceof SiteRefused) return siteEnv(url, e); // W-25 (v0.6)
      const r = e as Refused;
      return env(url, "refused", { message: r.message, retry_after_seconds: r.retrySeconds, uc: { refused_url: r.url, retry_after: r.retryAfter } });
    }
    case "safety": {
      const d = (e as SafetyError).detail;
      return env(url, "refused", { message: e.message, uc: d ? { detail: d } : undefined });
    }
    case "fetch": {
      const d = (e as FetchError).detail;
      return env(url, "error", { message: e.message, uc: d ? { detail: d.slice(0, 300) } : undefined });
    }
    case "page_too_complex":
      return env(url, "error", { message: "page_too_complex: Tiresias stopped reading this page because it took too long to process. Nothing was saved." });
    default: // signing, pdf, safe_browsing, profile, slip, config, complex, provided, handoff, bookmark, private_write
      return env(url, "error", { message: e.message });
  }
}

export async function guarded(...args: Parameters<typeof guardedCall>): Promise<Envelope> {
  let config: ReturnType<typeof snapshotConfig> | undefined;
  let configError: unknown;
  try {
    config = snapshotConfig();
  } catch (e) {
    configError = e;
  }
  return callContext.run({ ...callContext.getStore(), config, configError, getActions: undefined }, () => guardedCall(...args));
}

async function guardedCall(
  tool: Tool, url: string, ctx: Ctx, purpose: string | undefined, fn: (meta: CallMeta) => Promise<Envelope>, meta: CallMeta = {}, hand?: Hand,
  safetyCheck = true, // W-19: false only for a page a person provided (nothing is requested)
  record = true, // W-04: false for form_preview, which writes nothing (no trim, no history line)
): Promise<Envelope> {
  const priv = !!ctx.private || sessionPrivate();
  // W-15: the once-a-day trim. Not in private mode (a private call leaves the store as it found it).
  if (!priv && record) await enforceLimits();
  // One deadline for the whole call, plus the caller's cancellation if any, plus the server shutting down (v0.6).
  const signals = [AbortSignal.timeout(60_000), shutdownSignal, ...(ctx.signal ? [ctx.signal] : [])];
  const endCall = enterCall(); // a shutdown waits for this call's own cleanup (background.ts)
  let out: Envelope;
  const sent = { requests: 0, signed: 0 };
  let gate: safebrowsing.CallSafety | undefined;
  const site = new Set<import("./types.js").SiteSettingCode>(); // W-25 (v0.6): site settings that applied
  try {
    // W-19: the asked URL is checked first, before robots.txt or anything else, and before a copy is
    // served from the cache. Every later hop on a new host is checked by the fetcher (safety.ts).
    if (callContext.getStore()?.configError) throw callContext.getStore()!.configError;
    assertProfile(); // W-18: a profile that does not exist fails here, by name, before anything else
    gate = safetyCheck ? safebrowsing.makeGate({ allowFlagged: !!ctx.allow_flagged, priv, readOnly: !record }) : undefined;
    const g = gate;
    const body = async () => {
      const store = callContext.getStore();
      if (store) {
        store.site = site;
        store.sites = loadSites(); // the call's snapshot of the site settings (a bad value fails the call, by name)
      }
      // W-25 (v0.6): the owner's never_visit and hand_off come first, before Safe Browsing and before a copy is
      // served from the cache. Not for a page a person provided (nothing is requested: that IS the handoff).
      if (safetyCheck) assertSiteAllowed(parseSafeUrl(url));
      if (g) await g.check(parseSafeUrl(url));
      return fn(meta);
    };
    out = await withSignal(AbortSignal.any(signals), priv ? () => runPrivate(body) : body, sent, g?.check, !record);
  } catch (e) {
    out = errorEnv(url, e);
  } finally {
    endCall();
  }
  if (sent.requests > 0) out.signed = sent.signed === sent.requests;
  if (site.size) out.site_settings = [...new Set([...(out.site_settings ?? []), ...site])].sort();
  if (gate?.code) out.safety = gate.code;
  if (gate?.flags.size && !out.flag) {
    out.flag = [...gate.flags];
    out.message = READ_PAST_FLAG + (out.message ? " " + out.message : "");
  }
  if (out.flag) meta.flag = out.flag.some((f) => f.startsWith("web_risk:")) ? "web_risk" : "phishing_list";
  ticketForWall(out, ctx, priv, meta, hand);
  out = stampProfile(out); // W-18
  if (priv) {
    out.private = true;
    return out; // private: no history line
  }
  if (!record) return out;
  try {
    history.record({
      time: new Date().toISOString(), tool, url, agent: ctx.agent, purpose, status: out.status, door: out.door,
      reason: out.handoff?.reason, matched: meta.matched, best_door: meta.best_door, llms_txt: meta.llms_txt,
      ticket: meta.ticket, source: meta.source, cache: meta.cache, flag: meta.flag, slip: meta.slip, file_kind: meta.file_kind, scan: meta.scan,
      lang: out.language?.code, // W-26 (v0.7)
      rendered: meta.rendered, // W-10 (v0.7)
      saved: meta.saved, // W-28 (v0.8)
    });
  } catch (e) {
    console.error(`Could not write history: ${(e as Error).message}`);
  }
  return out;
}

export const DEFAULT: Ctx = { agent: "cli" };
