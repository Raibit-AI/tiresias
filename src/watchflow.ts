// SPDX-License-Identifier: Apache-2.0
// W-16: bookmarks and the watchlist (watch).
// (Split out of engine.ts in v0.5.1, behavior unchanged.)
import { type FileKind } from "./files.js";
import { SafetyError } from "./errors.js";
import { shown } from "./reader.js";
import type { Change } from "./diff.js";
import * as receipts from "./receipts.js";
import * as bookmarks from "./bookmarks.js";
import { NOTICE, jsonBytes, type Ctx, type Envelope, type Receipt } from "./types.js";

import { BUDGET, CallMeta, DEFAULT, Uc, guarded, sessionPrivate } from "./envelope.js";
import { len, paginate, run } from "./pipeline.js";

// ---- W-16: bookmarks and the watchlist ----

export interface BookmarkReply {
  status: "ok" | "refused" | "error";
  message: string;
  notice: string;
  counts?: { bookmarks: number; damaged: number; not_read: number };
  page?: number;
  pages?: number;
  // URLs may have been copied from a web page by an agent, so they sit with untrusted content.
  untrusted_content: { bookmark?: bookmarks.Bookmark; bookmarks?: bookmarks.Bookmark[] } | null;
}
export const PRIVATE_BOOKMARKS =
  "Private mode: bookmarks are not added or changed, because a private session creates nothing in the store. Run without private mode to change them.";

export async function bookmark(
  action: "add" | "remove" | "watch", name: string, url?: string, watch?: boolean, ctx: Ctx = DEFAULT,
): Promise<BookmarkReply> {
  const reply = (status: BookmarkReply["status"], message: string, b?: bookmarks.Bookmark): BookmarkReply =>
    ({ status, message, notice: NOTICE, untrusted_content: b ? { bookmark: b } : null });
  if (ctx.private || sessionPrivate()) return reply("refused", PRIVATE_BOOKMARKS);
  try {
    if (action === "add") {
      if (!url) return reply("error", "Give the URL to bookmark.");
      const b = bookmarks.add(name, url, !!watch);
      return reply("ok", b.watch ? "Bookmarked and watched." : "Bookmarked.", b);
    }
    if (action === "remove") {
      bookmarks.remove(name);
      return reply("ok", "Bookmark removed.");
    }
    if (watch === undefined) return reply("error", "Say whether to watch it: on or off.");
    const b = bookmarks.setWatch(name, watch);
    return reply("ok", watch ? "Now watched." : "No longer watched.", b);
  } catch (e) {
    if (e instanceof bookmarks.BookmarkError || e instanceof SafetyError) return reply("error", e.message);
    throw e;
  }
}

export function bookmarkList(page = 1): BookmarkReply {
  const l = bookmarks.list();
  const pg = paginate(l.items, len, page, 40_000);
  return {
    status: "ok",
    message: l.items.length ? `Bookmarks: ${l.items.length}, watched: ${l.items.filter((b) => b.watch).length}.` : "No bookmarks yet.",
    notice: NOTICE,
    counts: { bookmarks: l.items.length, damaged: l.damaged, not_read: l.not_read },
    page,
    pages: pg.pages,
    untrusted_content: { bookmarks: pg.slice },
  };
}

export const WATCH_ATTENTION = 100; // bookmarks named as needing attention, at most; the rest are counted
export const ATTENTION_URLS_BUDGET = 20_000; // characters of attention URLs (and wall pages to open) in one reply
export const WATCH_PAGE = 10; // watched bookmarks checked per page (bounds the work and the reply)
export const WATCH_CHANGES_BUDGET = 4000; // one bookmark's share of changes shown in a watch reply

export const BASELINE_GONE = "Changed since the last watch. The earlier copy is no longer kept (the cache keeps pages 30 days), so what changed is not known; read the page to see it now.";
export interface WatchItem {
  name: string;
  url: string;
  added?: number;
  removed?: number;
  changes?: Change[]; // the START of check's page 1 of changes, as much as fits WATCH_CHANGES_BUDGET
  changes_pages?: number; // pages of changes as check numbers them (its own page budget)
  changes_more?: true; // more changes than shown: call check with this URL, starting at page 1
  changes_omitted?: true;
  changes_trimmed?: true; // left out to keep the reply small; call check with this URL, starting at page 1
  note?: string; // fixed text: why there is no list of changes
}
// A watched bookmark a person may need to act on. Every field is a name the owner chose
// (checked against [a-z0-9-]) or a fixed code or number Tiresias made, so it sits at the top level.
export interface WatchAttention {
  name: string;
  outcome: "walled" | "failed" | "waiting" | "file_warning";
  status: Envelope["status"]; // the fixed status of that check
  reason?: NonNullable<Envelope["handoff"]>["reason"]; // walls: the fixed handoff reason
  retry_after_seconds?: number; // waiting: how long the site asked Tiresias to wait
  file?: { kind: FileKind; risk: "high" | "low"; fingerprint?: string; scan?: string }; // W-20: the bookmark now leads to a file
}
export interface WatchReport {
  status: "ok";
  private?: true;
  signed?: boolean;
  message: string;
  notice: string;
  counts: {
    watched: number; checked: number; changed: number; unchanged: number; no_baseline: number;
    walled: number; failed: number; skipped_cooldown: number; not_run: number; receipts: number; changes_trimmed: number;
    file_warnings: number; // W-20: watched bookmarks that now lead to a file (named in attention)
    attention_omitted: number; // walled, failed or waiting bookmarks past WATCH_ATTENTION (or the size budget), not named
    attention_urls_omitted: number; // named ones whose URLs did not fit the reply
  };
  page?: number;
  pages: number;
  // `attention_urls`: each named bookmark's URL and, for a wall, the exact page to open (web-derived).
  untrusted_content: { attention?: WatchAttention[]; changed?: WatchItem[]; receipts?: Receipt[]; attention_urls?: { name: string; url: string; open_this?: unknown }[] } | null;
}

// W-16: check every watched bookmark, one after another, with the same rules as any check
// (robots, cooldowns, signing), and report only the ones that changed. Each check is recorded
// in history as tool "watch". No scheduler: the owner runs this from cron or launchd.
// With a page, only that slice of WATCH_PAGE bookmarks is checked; without one (the CLI), all.
export async function watch(ctx: Ctx = DEFAULT, page?: number): Promise<WatchReport> {
  const priv = !!ctx.private || sessionPrivate();
  const all = bookmarks.list().items.filter((b) => b.watch);
  const pages = Math.max(1, Math.ceil(all.length / WATCH_PAGE));
  const slice = page === undefined ? all : all.slice((page - 1) * WATCH_PAGE, page * WATCH_PAGE);
  const counts: WatchReport["counts"] = {
    watched: all.length, checked: 0, changed: 0, unchanged: 0, no_baseline: 0, walled: 0, failed: 0, skipped_cooldown: 0, not_run: 0, receipts: 0, changes_trimmed: 0, file_warnings: 0, attention_omitted: 0, attention_urls_omitted: 0,
  };
  let urlChars = 0;
  const attention: WatchAttention[] = [];
  const attentionUrls: { name: string; url: string; open_this?: unknown }[] = [];
  const flag = (b: bookmarks.Bookmark, out: Envelope, outcome: WatchAttention["outcome"], uc: Uc) => {
    if (attention.length >= WATCH_ATTENTION) return void counts.attention_omitted++;
    const a: WatchAttention = { name: b.name, outcome, status: out.status };
    if (out.handoff) a.reason = out.handoff.reason;
    if (out.retry_after_seconds !== undefined) a.retry_after_seconds = out.retry_after_seconds;
    const fw = out.file_warning;
    if (fw) a.file = { kind: fw.kind, risk: fw.risk, ...(fw.fingerprint ? { fingerprint: fw.fingerprint } : {}), ...(fw.scan ? { scan: fw.scan.verdict } : {}) };
    attention.push(a);
    const open = (uc.handoff as { open_this?: unknown } | undefined)?.open_this;
    const u = { name: b.name, url: b.url, ...(open !== undefined ? { open_this: open } : {}) };
    // Bounded by size as well as count: a wall's page to open can be a long redirect target.
    const size = len(u);
    if (urlChars + size > ATTENTION_URLS_BUDGET) return void counts.attention_urls_omitted++;
    urlChars += size;
    attentionUrls.push(u);
  };
  const changed: WatchItem[] = [];
  const rcpts: Receipt[][] = [];
  let sent = 0;
  let signed = 0;
  for (const b of slice) {
    if (ctx.signal?.aborted) {
      counts.not_run++;
      continue;
    }
    const meta: CallMeta = {};
    const out = await guarded("watch", b.url, ctx, b.name, (m) => run("check", b.url, { page: 1 }, m, ctx.agent), meta);
    counts.checked++;
    if (!priv && meta.hash && (out.status === "ok" || out.status === "unchanged"))
      try {
        bookmarks.setFingerprint(b.name, meta.hash, b); // the baseline outlives the page cache (bound to this bookmark)
      } catch (e) {
        console.error(`Could not keep the watch fingerprint: ${(e as Error).message}`);
      }
    if (out.signed !== undefined) (sent++, out.signed && signed++);
    const uc = (out.untrusted_content ?? {}) as Uc;
    if (out.status === "ok" && meta.changed) {
      counts.changed++;
      const item: WatchItem = { name: b.name, url: b.url };
      if (Array.isArray(uc.changes) || out.changes_omitted) {
        if (out.changes_omitted) item.changes_omitted = true; // totals unknown: added and removed stay absent
        else {
          item.added = out.counts?.added;
          item.removed = out.counts?.removed;
          // Show the start of check's own page 1, so the page numbers watch advertises are check's.
          const all = uc.changes as Change[];
          const rs = (uc.receipts as Receipt[] | undefined) ?? []; // one per added change, in the same order
          const shown: Change[] = [];
          let used = 0;
          let added = 0;
          for (const c of all) {
            const cost = len(c) + (c.kind === "added" ? len(rs[added]) : 0);
            if (shown.length && used + cost > WATCH_CHANGES_BUDGET) break;
            shown.push(c);
            used += cost;
            if (c.kind === "added") added++;
          }
          item.changes = shown;
          item.changes_pages = uc.changes_pages as number;
          if (shown.length < all.length || item.changes_pages > 1) item.changes_more = true;
          rcpts.push(rs.slice(0, added));
          changed.push(item);
          continue;
        }
      } else item.note = out.message;
      changed.push(item);
      rcpts.push([]);
    } else if (out.status === "ok" && meta.first && meta.hash && b.last_fingerprint && b.last_fingerprint !== meta.hash) {
      // v0.5.1: the cached copy was gone (the cache keeps pages 30 days), but the bookmark kept the last
      // fingerprint: the page changed, though what changed is not known.
      counts.changed++;
      changed.push({ name: b.name, url: b.url, note: BASELINE_GONE });
      rcpts.push([]);
    } else if (out.status === "ok" && meta.first && meta.hash && b.last_fingerprint === meta.hash) counts.unchanged++;
    else if (out.status === "ok") counts.no_baseline++;
    else if (out.status === "unchanged") counts.unchanged++;
    else if (out.status === "wall") (counts.walled++, flag(b, out, "walled", uc));
    else if (out.status === "file_warning") (counts.file_warnings++, flag(b, out, "file_warning", uc));
    else if (out.status === "refused" && out.retry_after_seconds !== undefined) (counts.skipped_cooldown++, flag(b, out, "waiting", uc));
    else (counts.failed++, flag(b, out, "failed", uc));
  }
  const report: WatchReport = {
    status: "ok",
    ...(priv ? { private: true as const } : {}),
    ...(sent ? { signed: signed === sent } : {}),
    message: all.length
      ? `Watched bookmarks checked: ${counts.checked}; changed: ${counts.changed}. Only the changed ones are listed, plus any walled, failed or waiting ones, and any that now lead to a file, by name (attention). Where a list of changes is cut short, call check with that URL for the full list, starting at page 1.`
      : "No bookmarks are watched. Add one with bookmark add <name> <url> --watch.",
    notice: NOTICE,
    counts,
    ...(page === undefined ? {} : { page }),
    pages: page === undefined ? 1 : pages,
    untrusted_content: null,
  };
  // Keep a paged reply inside the result budget: drop whole lists of changes from the last
  // changed bookmark backwards, and count each one dropped. The counts stay exact.
  const build = () => {
    const rs = rcpts.flat();
    report.counts.receipts = rs.length;
    const uc = { ...(attention.length ? { attention } : {}), ...(changed.length ? { changed } : {}), ...(rs.length ? { receipts: rs } : {}), ...(attentionUrls.length ? { attention_urls: attentionUrls } : {}) };
    report.untrusted_content = Object.keys(uc).length ? uc : null;
  };
  build();
  const over = () => page !== undefined && jsonBytes(report) > BUDGET.total;
  for (let i = changed.length - 1; over() && i >= 0; i--) {
    if (!changed[i].changes) continue;
    delete changed[i].changes;
    delete changed[i].changes_more;
    changed[i].changes_trimmed = true;
    rcpts[i] = [];
    counts.changes_trimmed++;
    build();
  }
  // Then attention URLs, then attention names, from the end, each counted. What remains is at most
  // 10 changed bookmarks (URL up to 2,048 characters each) and counts, which always fits.
  while (over() && attentionUrls.length) {
    attentionUrls.pop();
    counts.attention_urls_omitted++;
    build();
  }
  while (over() && attention.length) {
    attention.pop();
    counts.attention_omitted++;
    build();
  }
  return report;
}
