// SPDX-License-Identifier: Apache-2.0
// The engine: one pipeline, used by both the MCP server and the CLI.
// Order (SPEC section 5): safety -> rules -> cache check -> fetch ->
// walls/402 -> doors -> reader -> shield -> receipts -> history.
//
// Envelope rule: the top level holds only values Tiresias made itself. Every
// value that came from the web goes inside `untrusted_content`.
//
// v0.5.1: this file keeps only the entry points; the work is in envelope.ts, pagecache.ts, pipeline.ts,
// filereply.ts, resume.ts, watchflow.ts and formflow.ts, each re-exported here.
import path from "node:path";
import * as history from "./history.js";
import * as receipts from "./receipts.js";
import * as dailylog from "./dailylog.js";
import * as needs from "./needs.js";
import * as slips from "./slips.js";
import * as safebrowsing from "./safebrowsing.js";
import { NOTICE, type Ctx } from "./types.js";

import { DEFAULT, Opts, guarded } from "./envelope.js";
import { addSaved, doorsOnly, len, paginate, run } from "./pipeline.js";
import { savePolicy, type SavedTop } from "./saved.js";
export * from "./pagecache.js";
export * from "./envelope.js";
export * from "./filereply.js";
export * from "./pipeline.js";
export * from "./watchflow.js";
export * from "./resume.js";
export * from "./formflow.js";

export const read = async (url: string, opts: Opts = {}, ctx: Ctx = DEFAULT) => {
  const saveFallback = opts.save ? saveRefusal() : undefined;
  const out = await guarded("read", url, ctx, opts.question, (m) => run("read", url, opts, m, ctx.agent), {}, { create: { question: opts.question, section: opts.section, render: opts.render, translate: opts.translate } });
  // W-28 (v0.8): a read that asked to save always says what happened to the save (the pipeline sets it when it got
  // as far as a page or a file).
  if (opts.save && !out.saved) addSaved(out, out.private ? { status: "private" } : saveFallback!);
  return out;
};
function saveRefusal(): SavedTop {
  try {
    const p = savePolicy();
    return p === "ask" ? { status: "not_saved", reason: "no_page" } : { status: p };
  } catch {
    return { status: "not_allowed" }; // a bad setting: the read itself already said so
  }
}
export const check = (url: string, ctx: Ctx = DEFAULT, opts: { page?: number; fresh?: boolean } = {}) =>
  guarded("check", url, ctx, undefined, (m) => run("check", url, { page: opts.page, fresh: opts.fresh }, m, ctx.agent));
export const doors = (url: string, ctx: Ctx = DEFAULT) => guarded("doors", url, ctx, undefined, (m) => doorsOnly(url, m));
export const queryReceipts = receipts.query;


// ---- W-05: permission slips (read only here; granting and revoking are CLI-only, in cli.ts) ----

export interface SlipsReply {
  status: "ok";
  message: string;
  notice: string;
  counts: { active: number; expired: number; used_up: number; damaged: number };
  page: number;
  pages: number;
  // Validated by Tiresias: a fixed action code, an origin as URL.origin writes it, a checked path, times
  // it wrote, whole numbers, and random ids. The owner's free-text notes sit in untrusted_content.
  slips: Omit<slips.SlipView, "note">[];
  untrusted_content: { notes: { id: string; note: string }[] };
}

export function slipList(page = 1): SlipsReply {
  const l = slips.list();
  const pg = paginate(l.items, len, page, 40_000);
  const c = l.counts;
  return {
    status: "ok",
    message: c.active
      ? `Active permission slips: ${c.active}. Each allows only its action, on its site and path, until it expires or its uses run out. Only the owner can grant, extend or revoke a slip.`
      : "No active permission slips. Only the owner can grant one, from the command line (tiresias slip grant).",
    notice: NOTICE,
    counts: c,
    page,
    pages: pg.pages,
    slips: pg.slice.map(({ note: _note, ...rest }) => rest),
    untrusted_content: { notes: pg.slice.filter((s) => s.note !== null).map((s) => ({ id: s.id, note: s.note! })) },
  };
}
export const claimSlip = slips.claimSlip;
export const checkSlip = slips.checkSlip;

export const queryHistory = history.query;
export const dailyLog = async (day?: string, page = 1) => {
  const log = await dailylog.buildLog(day);
  return { day: log.day, entries: log.entries, ...dailylog.pageOf(log, page) };
};
export const exportDailyLog = dailylog.exportLog;
// W-12: generated from the history when asked, never stored.
export const needsReport = (since?: string, page = 1) => needs.buildNeeds(since, page);
// W-19: tiresias safety status | update.
export const safetyStatus = safebrowsing.status;
export const safetyUpdate = safebrowsing.update;

