// SPDX-License-Identifier: Apache-2.0
// The read pipeline: choose a source, fetch it, decide walls and files, parse, cache, and build the reply
// (read, check and doors).
// (Split out of engine.ts in v0.5.1, behavior unchanged.)
import { hostKey } from "./sitekey.js";
import { startDoorProbe } from "./background.js";
import { loadDoorsMode } from "./config.js";
import { cooldownSeconds } from "./cooldown.js";
import { FLAG_TEXT, mimeOf, type FileFlag, type ReadAs } from "./files.js";
import { cachedDoors, noStore, probeOrigin, summarize, type OriginDoors } from "./doors.js";
import { FetchError, TiresiasError } from "./errors.js";
import { politeFetch } from "./fetcher.js";
import { after304, fromResponse, isFresh } from "./freshness.js";
import { shown, type Passage } from "./reader.js";
import { runUntrusted } from "./sandbox.js";
import { OVERLAY_TEXT, RENDERED_TEXT, RENDER_TEXT, loadRenderMode, looksLikeShell, renderHtml, type RenderMode, type RenderTop } from "./render.js";
import type { Change, DiffResult } from "./diff.js";
import * as receipts from "./receipts.js";
import { checkAllowed } from "./rules.js";
import { parseSafeUrl, throwIfCancelled, type RawResponse, type SafeFetchOptions } from "./safety.js";
import * as needs from "./needs.js";
import { cachePath, isPrivate, readJson, removeCache, sha256, writeJson } from "./store.js";
import { PARSER_VERSION, jsonBytes, type AvailableDoors, type Door, type Envelope, type Flag, type ParsedPage, type Receipt } from "./types.js";
import { detectWall, parsePrice, type WallInfo } from "./walls.js";
import { stampLanguage, type PageLanguage } from "./lang.js";
import { fitTranslation, translateReply } from "./translate.js";
import { saveSnapshot, savePolicy, savedText, type SaveInput, type SavedReason, type SavedTop } from "./saved.js";
export { stampLanguage } from "./lang.js";

import { BUDGET, CallMeta, DIFF_OMITTED, DiffState, MAX_AGENT, NO_BASELINE, NO_STORE_DIFF, OLD_READER, OTHER_SOURCE, Opts, Serve, Tool, Uc, env, fitEnvelope, wallEnv } from "./envelope.js";
import { fileOptions, fileWarning } from "./filereply.js";
import { CacheEntry, type RenderInspection } from "./pagecache.js";

// The private mark authenticates the inspection to the reader, but is not part of the page's identity.
export const renderedFingerprint = (html: string, mark?: string): string => sha256(mark ? html.replaceAll(mark, "data-t-inspected") : html);
const cachedRender = (entry: CacheEntry): RenderTop => ({ status: "cached", ...entry.render_inspection });
const inspectionCodes = ({ walls, hidden_text, overlay, markers_uninspected }: RenderTop): RenderInspection => ({
  walls, hidden_text, ...(overlay ? { overlay } : {}), ...(markers_uninspected ? { markers_uninspected } : {}),
});

// Things decided by status code and headers alone, before looking at content.
// Returns null for a plain 200.
export function earlyOutcome(url: string, res: RawResponse): Envelope | null {
  const w = detectWall({ status: res.status, headers: res.headers }); // cf-mitigated applies to ANY status, including 200
  if (w) return wallEnv(url, w, res.url, { final_url: res.url });
  if (res.status === 402)
    return env(url, "payment_required", {
      message: "The site wants payment. Tiresias read the price and did not pay.",
      uc: { final_url: res.url, price: parsePrice(res.headers, res.body) },
    });
  if (res.status === 429 || res.status === 503) {
    const ra = res.headers.get("retry-after");
    const secs = cooldownSeconds(res.status, ra);
    return env(url, "error", {
      retry_after_seconds: secs,
      message: `The site asked Tiresias to slow down (HTTP ${res.status}). It will not be called again until the wait is over.`,
      uc: { final_url: res.url, retry_after: ra?.slice(0, 200) },
    });
  }
  if (res.status !== 200) return env(url, "error", { message: `The site answered HTTP ${res.status}.`, uc: { final_url: res.url } });
  return null;
}

// W-20: how a page is parsed, by how it is read (files.ts decided that from its first bytes, its type and
// its name). Scripts, CSV, calendar and contact files are read as plain text, never as markdown.
export type ParseJob = { op: "parse"; kind: "html" | "json" | "text" | "svg" | "plain"; mode?: "script" | "csv" | "calendar" | "contact"; body: string; url: string; wall?: boolean; lang?: string; rendered?: Rendered } | { op: "pdf"; bytes: Uint8Array; url: string; lang?: string };
// v0.7 track 2: the HTML of a rendered page, its hidden elements marked by the browser, and whether the browser decided
// its walls (then its markup is not judged again).
export type Rendered = { mark: string; complete: boolean; wallDecided: boolean };
// `lang`: the Content-Language header (W-26, v0.7: a hint for language detection, cut at 200).
export function parseJob(read: ReadAs, body: string, bytes: Buffer | undefined, url: string, wall: boolean, lang?: string | null, rendered?: Rendered): ParseJob {
  const l = { ...(lang ? { lang: lang.slice(0, 200) } : {}), ...(rendered && read === "html" ? { rendered } : {}) };
  if (read === "pdf") return { op: "pdf", bytes: bytes ?? Buffer.from(body, "latin1"), url, ...l };
  if (read === "script" || read === "csv" || read === "calendar" || read === "contact") return { op: "parse", kind: "plain", mode: read, body, url, wall, ...l };
  return { op: "parse", kind: read, body, url, wall, ...l };
}
// W-20: is this response HTML, whatever reader its name chose? Declared HTML, or page markup in its first 64 KB
// (Codex rounds 63 to 66). ONE rule for reads, doors, form answers and saved pages: then its wall markers
// are always looked for, as before v0.5.
export const looksHtml = (contentType: string | null | undefined, body: string): boolean =>
  /html/.test(mimeOf(contentType)) || /<(!doctype html|html|body|form)\b/i.test(body.slice(0, 65536));
// `wallCheck`: the response is HTML whatever reader its name chose, so its wall markers are looked for
// (Codex round 63: a login page served as text/html at /login.csv is still a wall).
export async function parsePage(read: ReadAs, body: string, bytes: Buffer | undefined, url: string, fileFlags: FileFlag[] = [], wallCheck = false, lang?: string | null, rendered?: Rendered) {
  const job = parseJob(read, body, bytes, url, wallCheck, lang, rendered);
  const r = await runUntrusted<{ parsed: ParsedPage; wall: WallInfo | null }>(job, job.op === "pdf" ? Infinity : body.length);
  // What the response said against what it is goes first, so the shield's cap never pushes it out.
  if (fileFlags.length) r.parsed.flags = [...fileFlags.map((f): Flag => ({ type: f, snippet: "", detail: FLAG_TEXT[f] })), ...r.parsed.flags];
  return r;
}
// W-20: a reply that carries the csv_formulas flag carries its count too.
export const csvCount = (e: Envelope, p: ParsedPage): void => {
  if (p.csv_formulas && e.counts && e.flags.includes("csv_formulas")) e.counts.csv_formulas = p.csv_formulas;
};
export const detailOf = (read: ReadAs): "pdf" | "html" | "json" | "text" => (read === "pdf" ? "pdf" : read === "html" ? "html" : read === "json" ? "json" : "text");

// Choose where to read from. Best first: llms.txt for a site root, then the
// markdown twin of a page that llms.txt lists, else the page itself.
// W-23 (v0.5.1): when llms.txt points to llms-full.txt (and the site serves it), a root read uses the full
// file: the whole site's text in one request.
export function pickSource(u: URL, od: OriginDoors | null): { source: string; detail: "llms.txt" | "llms-full.txt" | "markdown" | "html" } {
  if (od?.llms_full_listed && od.llms_full_txt && u.pathname === "/" && !u.search) return { source: od.llms_full_txt, detail: "llms-full.txt" };
  if (od?.llms_txt && u.pathname === "/" && !u.search) return { source: od.llms_txt, detail: "llms.txt" };
  if (od?.llms_md?.length) {
    // The door answers are kept under the site's one name (no trailing dot: sitekey.ts), so the candidates are
    // built from that name too (Codex round 6).
    const cu = new URL(u.href);
    cu.hostname = hostKey(cu.hostname);
    const base = cu.href.split("#")[0];
    const stripped = base.replace(/\/$/, "");
    const candidates = [base + ".md", stripped + ".md", base.endsWith("/") ? base + "index.html.md" : ""];
    const hit = candidates.find((c) => c && od.llms_md!.includes(c));
    if (hit) return { source: hit, detail: "markdown" };
  }
  return { source: u.href.split("#")[0], detail: "html" };
}

// `started` is when this call's own request began (W-03 counts a copy's age from it).
// Every page read is its own request: probe bodies are never reused (removed in Codex round 39;
// it cost at most one extra llms.txt request per call and carried redirect and cooldown holes).
export async function fetchSource(source: string, cache: CacheEntry | null, staleParse = false, keepRaw = false): Promise<{ res: RawResponse; started: number; validatorsSent: boolean }> {
  throwIfCancelled();
  const opts: SafeFetchOptions = { files: fileOptions(), ...(keepRaw ? { keepRaw: true } : {}) };
  // No validators when the parsed form must be rebuilt: a 304 would keep the old parse.
  if (cache && !staleParse && cache.source_url === source && cache.final_url) {
    const headers: Record<string, string> = {};
    if (cache.etag) headers["if-none-match"] = cache.etag;
    if (cache.last_modified) headers["if-modified-since"] = cache.last_modified;
    // Validators go only to the URL they came from. If the redirect chain now
    // ends somewhere else, that hop gets a plain request and a 304 can't happen.
    if (Object.keys(headers).length) opts.conditional = { url: cache.final_url, headers };
  }
  const started = Date.now();
  const res = await politeFetch(source, opts);
  return { res, started, validatorsSent: opts.conditional?.url === res.url };
}

// Rechecking a header hint still examines untrusted text, under the usual worker budget.
async function refreshLanguage(parsed: ParsedPage, header: string | null): Promise<ParsedPage> {
  const language = await runUntrusted<PageLanguage>({ op: "language", parsed, lang: header?.slice(0, 200) }, parsed.searchable_chars);
  return { ...parsed, language };
}

export function paginate<T>(items: T[], size: (t: T) => number, page: number, budget: number): { slice: T[]; pages: number } {
  const pages: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const it of items) {
    const sz = size(it);
    if (cur.length && bytes + sz > budget) {
      pages.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(it);
    bytes += sz;
  }
  if (cur.length) pages.push(cur);
  return { slice: pages[page - 1] ?? [], pages: Math.max(1, pages.length) };
}

export const len = jsonBytes; // every page budget counts UTF-8 bytes of the JSON sent

export async function buildContent(entry: CacheEntry, opts: Opts): Promise<{ uc: Uc; receipts: Receipt[]; error?: string }> {
  const p = entry.parsed;
  const page = opts.page ?? 1;
  const fetchedAt = entry.fetched_at;
  // Receipts cite the URL that was actually read, and quote exact extracted text.
  const rc = (quote: string, section: number | null): Receipt => ({ quote, url: entry.final_url, section, fetched_at: fetchedAt, ...(entry.source ? { source: entry.source } : {}) });
  const base: Uc = { final_url: entry.final_url, title: p.title, ...(p.meta ? { metadata: p.meta } : {}), text_omitted: p.text_omitted, text_omitted_at_least: p.text_omitted_at_least, pdf_pages: p.pdf_pages, pdf_pages_omitted: p.pdf_pages_omitted, ...(p.events ? { events: p.events } : {}), ...(p.events_omitted ? { events_omitted: p.events_omitted } : {}), ...(p.events_malformed ? { events_malformed: true } : {}) };
  const titleReceipt = p.title ? [rc(p.title, null)] : [];
  // A heading Tiresias generated (a PDF's "Page N") is a label, not text from the source, so it gets no receipt.
  const labelled = (n: number) => !!p.sections.find((x) => x.n === n)?.generated;

  if (opts.question) {
    // Keep the best passages that fit the page budget, receipts included.
    const passages: Passage[] = [];
    let used = 0;
    const found = await runUntrusted<Passage[]>({ op: "search", parsed: p, question: opts.question, k: 5 }, p.searchable_chars + opts.question.length); // the question counts too (round 84)
    for (const x of found) {
      const cost = len(x) + len(rc(x.text, x.section)) + (labelled(x.section) ? 0 : len(rc(x.heading, x.section)));
      if (passages.length && used + cost > BUDGET.sectionText) break;
      passages.push(x);
      used += cost;
    }
    // Every returned fact is covered: each passage, and each distinct heading shown with one.
    const rs = [...titleReceipt];
    const seen = new Set<number>();
    for (const x of passages) {
      if (!seen.has(x.section)) {
        seen.add(x.section);
        if (!labelled(x.section)) rs.push(rc(x.heading, x.section));
      }
      rs.push(rc(x.text, x.section));
    }
    return { uc: { ...base, question: opts.question.slice(0, 500), passages }, receipts: rs };
  }
  if (opts.section !== undefined) {
    const s = p.sections.find((x) => x.n === opts.section);
    if (!s) return { uc: {}, receipts: [], error: `No section ${opts.section}. This page has ${p.sections.length} section${p.sections.length === 1 ? "" : "s"}.` };
    // The page size counts what is really sent: the text AND its receipt (which repeats the URL).
    const pg = paginate(s.blocks, (b) => len(shown(b)) + len(rc(b.text, s.n)) + 4, page, BUDGET.sectionText);
    const rs = pg.slice.map((b) => rc(b.text, s.n));
    rs.unshift(...(page === 1 ? titleReceipt : []), ...(s.generated ? [] : [rc(s.heading, s.n)])); // the heading is returned on every page (a generated label is not a quote)
    return {
      uc: { ...(page === 1 ? base : { final_url: entry.final_url }), section: { n: s.n, heading: s.heading, text: pg.slice.map(shown).join("\n\n"), page, pages: pg.pages } },
      receipts: rs,
    };
  }
  // Outline: each entry returns a heading and a preview, so each gets a receipt.
  const units = p.sections.map((s) => {
    const preview = (s.blocks[0]?.text ?? "").slice(0, 120);
    const receipts = [...(s.generated ? [] : [rc(s.heading, s.n)]), ...(preview ? [rc(preview, s.n)] : [])];
    return { item: { section: s.n, level: s.level, heading: s.heading, preview }, receipts };
  });
  const out = paginate(units, len, page, BUDGET.outline);
  const links = paginate(p.links, len, page, BUDGET.links);
  // W-04: forms, as fields, paged like links. Like links they carry no receipts (structure, not quotes).
  const forms = p.forms ? paginate(p.forms, len, page, BUDGET.forms) : null;
  const rs = out.slice.flatMap((u) => u.receipts);
  if (page === 1) rs.unshift(...titleReceipt);
  return {
    uc: {
      ...(page === 1 ? base : { final_url: entry.final_url }),
      outline: out.slice.map((u) => u.item),
      links: links.slice,
      ...(forms ? { forms: forms.slice, ...(page === 1 && p.forms_omitted ? { forms_omitted: p.forms_omitted } : {}), ...(forms.slice.length ? { forms_hint: FORMS_HINT } : {}) } : {}),
      page,
      pages: Math.max(out.pages, links.pages, forms?.pages ?? 1),
      section_count: p.sections.length,
      links_omitted: p.links_omitted,
      structured: p.structured_count || p.structured_skipped
        ? { count: p.structured_count, types: p.structured_types, skipped: p.structured_skipped, note: "See the '(structured data)' section." }
        : undefined,
      hint: "Call read again with section N for full text, question for quoted passages, or page for more of the outline.",
    },
    receipts: rs,
  };
}

export const FORMS_HINT =
  "Forms are listed as fields (hidden ones by name only). To see exactly what a form would send, call form_preview with this url, the form's index and your values. Sending needs a permission slip, which only the owner grants from the command line; a form with not_allowed is never sent.";

// One page of a kept list of changes. Added blocks are on the page now, so each gets a receipt.
// Removed blocks are not on the page any more: they carry no receipt, and `kind` says so.
export function changesPart(entry: CacheEntry, page: number, budget: number): { uc: Uc; receipts: Receipt[]; counts?: { added: number; removed: number }; omitted: boolean } {
  const ch = entry.changes!;
  // An omitted list has no totals (they are unknown), and a kept entry from before round 36 may
  // carry zeros there: never pass them on.
  if (ch.omitted || ch.added === undefined || ch.removed === undefined) return { uc: {}, receipts: [], omitted: true };
  const counts = { added: ch.added, removed: ch.removed };
  const rc = (c: Change): Receipt => ({ quote: c.text, url: entry.final_url, section: c.section, fetched_at: entry.fetched_at });
  const pg = paginate(ch.items, (c) => len(c) + (c.kind === "added" ? len(rc(c)) : 0), page, budget);
  return {
    uc: { changes: pg.slice, changes_page: page, changes_pages: pg.pages },
    receipts: pg.slice.filter((c) => c.kind === "added").map(rc),
    counts,
    omitted: false,
  };
}

export async function run(tool: Tool, rawUrl: string, opts: Opts, meta: CallMeta = {}, agent?: string): Promise<Envelope> {
  const u = parseSafeUrl(rawUrl); // N-10: scheme and credentials
  const url = u.href.split("#")[0];
  // N-06: ask robots.txt BEFORE any probe of the site.
  const rule = await checkAllowed(u);
  if (rule.wall) return wallEnv(url, rule.wall, rule.wallUrl ?? url);
  if (!rule.allowed)
    return env(url, "refused", { message: rule.reason, retry_after_seconds: rule.retrySeconds, uc: rule.retryAfter ? { retry_after: rule.retryAfter } : undefined });

  const cacheFile = cachePath(url);
  // W-14: a private call neither reads nor writes the page cache, so it never
  // reveals an earlier visit and never records this one.
  const priv = isPrivate();
  const cache = priv ? null : readJson<CacheEntry>(cacheFile);
  // An entry parsed by an older reader keeps its provenance (where it was read
  // from, its baseline) but its parsed form is rebuilt from the next response.
  // Older rendered entries lack the inspection codes and predate the textarea inspection. Rebuild them.
  const staleParse = !!cache && (cache.parser !== PARSER_VERSION || (!!cache.rendered && !cache.render_inspection));
  // W-30: the owner's "doors" setting, read (and checked: a bad value fails the read, by name) on EVERY read,
  // whichever path it takes (Codex round 2).
  const doorsMode = tool === "read" ? loadDoorsMode() : "wait";
  // W-10 (v0.7): the owner's render setting (a bad value fails the read, by name). A read that asks for rendering
  // when it is allowed, and a check of a copy that was rendered, never reuse a plain copy as is.
  const renderMode: RenderMode = tool === "read" || tool === "check" ? loadRenderMode() : "off";
  // Explicit renders and checks of rendered copies need a body and a new browser run, even after a 304.
  // The one shortcut is an already rendered copy still fresh under the site's cache rules (below).
  const rerender = renderMode !== "off" && (!!opts.render || (tool === "check" && !!cache?.rendered));
  // W-28 (v0.8): a read that asks to save, when the owner allows it (a bad setting fails the read, by name). A save
  // keeps what THIS read received, so it never uses a fresh copy, a 304 or a cached rendering: it always fetches.
  const sv: SaveCtx | undefined = tool === "read" && opts.save && savePolicy() === "ask" ? {} : undefined;
  // W-03: a copy that is still fresh by the site's own caching rules is served with no request to
  // the site at all (robots.txt was obeyed above). Its doors come from the discovery cache only.
  // Only a copy whose fetch had no redirect at all (recorded by the fetch itself; a missing field
  // means no) and that was read from the page itself, not llms.txt or a twin: the rules just
  // checked are then the rules of the page being served (Codex rounds 38 and 39).
  if (cache && !staleParse && (!rerender || cache.rendered) && !sv && !opts.fresh && cache.redirected === false && cache.source_url === url && isFresh(cache)) {
    meta.cache = "fresh";
    const od = tool === "read" ? cachedDoors(u.origin) : null;
    if (od) noteDoors(meta, summarize(od));
    // W-30 (Codex round 1): a copy served from the cache with no door answers starts (or reports) the
    // background checks too, so a cancelled or refused job is retried and a running one is reported.
    const later = tool === "read" && !od && !priv && doorsMode === "background";
    const out = await finishPage(tool, url, cache, true, null, opts, later ? pageOnly(u.origin) : od, new Date().toISOString(), () => {}, meta, { fresh: false }, false, { cache: "fresh", agent });
    return later ? afterDeferred(out, u.origin) : out;
  }
  // check never probes; it just revisits where it read from last time.
  // W-30 (v0.6): a read uses the door checks already cached; with none, the page goes first and the checks
  // run afterwards in the background (background.ts), unless the owner set `doors` to "wait". A private read
  // keeps nothing, so it can neither use nor keep background answers: it waits for the checks as before.
  const deferred = tool === "read" && !priv && doorsMode === "background" && !cachedDoors(u.origin);
  const od = tool === "read" && !deferred ? await probeOrigin(u.origin) : null;
  if (od) noteDoors(meta, summarize(od)); // origin doors alone; refined with the page's own links below
  // Without fresh door answers, a read goes back to where the kept copy came from (a markdown twin, llms.txt),
  // as check does, so the source does not flip each time the door answers expire.
  const { source, detail } = (tool === "check" || deferred) && cache ? { source: cache.source_url, detail: cache.door_detail } : pickSource(u, od);
  const done = (e: Envelope): Envelope => (deferred ? afterDeferred(e, u.origin) : e);
  // While the checks are pending, the reply still lists the doors the page itself shows (feeds, an API
  // description, structured data), from an empty origin answer (Codex round 1).
  const shown = deferred ? pageOnly(u.origin) : od;

  let { res, started, validatorsSent } = await fetchSource(source, cache, staleParse || rerender || !!sv, !!sv);
  // An unsolicited 304 proves nothing about this parse or representation. Ask once for a full body.
  if (res.status === 304 && (!validatorsSent || staleParse)) {
    throwIfCancelled();
    if (!priv && noStore(res.headers)) removeCache(cacheFile);
    ({ res, started, validatorsSent } = await fetchSource(source, null, true, !!sv));
  }
  throwIfCancelled(); // a cancelled call saves nothing and returns nothing
  const now = new Date().toISOString();
  // Cache-Control: no-store means the site does not want this kept. The old copy goes now,
  // before parsing or any early return, whatever happens next.
  if (!priv && noStore(res.headers)) removeCache(cacheFile);
  // W-28: the site asked that this page not be kept, so it is not saved either (principle 2).
  if (sv && noStore(res.headers)) sv.reason = "no_store";

  if (res.status === 304) {
    // Only valid if it came from the exact URL the validators belong to.
    if (!cache || staleParse || !validatorsSent || res.url !== cache.final_url) return env(url, "error", { message: "The site sent an unexpected 304.", uc: { final_url: res.url } });
    cache.checked_at = now;
    // Missing 304 headers retain their stored values; a supplied language replaces the old hint.
    if (res.headers.has("content-language")) cache.parsed = await refreshLanguage(cache.parsed, res.headers.get("content-language"));
    // W-03: a 304 updates the stored caching headers (RFC 9111 4.3.4); ones it does not repeat are kept.
    // A 304 never clears a block and refreshes only a copy that was already reusable (freshness.ts).
    const f = after304(cache, res.headers, started);
    delete cache.fresh_until;
    delete cache.reuse_blocked;
    Object.assign(cache, f, { redirected: res.redirected });
    meta.cache = "revalidated";
    // A 304 can carry no-store too; the stored copy is already gone (above) and is not saved again.
    const save = () => (noStore(res.headers) ? undefined : writeJson(cacheFile, cache));
    return done(await finishPage(tool, url, cache, true, null, opts, shown, now, save, meta, { fresh: false }, noStore(res.headers), { cache: "revalidated", agent }));
  }
  const early = earlyOutcome(url, res);
  if (early) return early;

  // W-20: a file, not a page. It was never kept, so there is nothing to cache; a kept copy of what this
  // URL used to be no longer describes it and goes.
  if (res.file) {
    if (!priv) removeCache(cacheFile);
    // W-28 + W-20: a file is never saved, only its fingerprint (Tiresias's own values).
    const f = res.file;
    const saveFile = () => {
      if (!sv) return undefined;
      sv.top = sv.reason ? { status: "not_saved", reason: sv.reason } : f.sha256
        ? saveSnapshot({ url, source_url: source, final_url: res.url, status: res.status, content_type: res.headers.get("content-type") ?? "", read_as: null, file_flags: [...f.flags], language_header: null, file: { kind: f.kind, risk: f.risk, size: f.size, sha256: f.sha256 } }, [])
        : { status: "not_saved", reason: "no_fingerprint" };
      if (sv.top.status === "saved") meta.saved = true;
      return sv.top.id;
    };
    const fw = await fileWarning(url, res.url, res.file, meta, agent, undefined, tool === "read" ? opts : { ...opts, translate: undefined }, undefined, saveFile); // Save after parsing succeeds, before Office receipts are logged
    if (sv?.top) addSaved(fw, sv.top);
    return fw;
  }
  const ct = res.headers.get("content-type") ?? "";
  const k = res.read ?? "text";

  // All parsing of the page runs under a hard time budget (sandbox.ts).
  let { parsed, wall: pageWall } = await parsePage(k, res.body, res.bytes, res.url, res.fileFlags, looksHtml(ct, res.body), res.headers.get("content-language"));
  throwIfCancelled();

  // W-10 (v0.7): rendering. Asked for by the read, or (owner's "auto") an empty JavaScript shell, or a check of a
  // copy that was rendered (so like is compared with like). The rendered HTML goes through the same reader and
  // shield; a render that stops leaves the plain read in place, and the reply says why.
  let render: RenderTop | undefined;
  let renderedHash = "";
  let renderedSave: SaveInput["rendered"]; // W-28: the HTML the reader parsed, when this read rendered
  // A copy that was rendered stays rendered while the owner allows it, so a later section, question or page refers to
  // the same outline; when the page's own body is unchanged, the rendered copy is reused without starting a browser
  // (an explicit render asks for a new rendering).
  const plainHash = sha256(Buffer.concat([Buffer.from(`${k}|${(res.fileFlags ?? []).join(",")}|`), res.bytes ?? Buffer.from(res.body, "utf8")]));
  const wantRender = !!opts.render || (renderMode !== "off" && !!cache?.rendered) || (renderMode === "auto" && k === "html" && looksLikeShell(parsed.text_chars, res.body));
  const reuse = tool !== "check" && !opts.fresh && !opts.render && !sv && !staleParse && !!cache?.rendered && !!cache.render_hash && cache.plain_hash === plainHash && cache.source_url === source && cache.final_url === res.url;
  // v0.7 track 2: a CAPTCHA or login wall found in the plain HTML's markers waits for the render's verdict when a render
  // will decide this read (the browser sees whether the box is shown). A bot check (it is passed by running its script,
  // principle 1) and the header and status walls never wait. If the render stops, the plain verdict stands.
  const renderDecides = wantRender && renderMode !== "off" && k === "html";
  if (pageWall && !(renderDecides && (pageWall.code === "captcha" || pageWall.code === "login_required"))) return wallEnv(url, pageWall, res.url, { final_url: res.url });
  if (wantRender && renderMode === "off") {
    if (opts.render) render = { status: "not_allowed" };
  } else if (wantRender && k !== "html") {
    if (opts.render) render = { status: "not_html" };
  } else if (wantRender && reuse) {
    parsed = await refreshLanguage(cache!.parsed, res.headers.get("content-language"));
    renderedHash = cache!.render_hash!;
    render = cachedRender(cache!);
  } else if (wantRender) {
    const r = await renderHtml(res.url, res.body);
    throwIfCancelled();
    render = r.top;
    if (r.ok) {
      // The reader, hash and snapshot must all see the same UTF-8 text, even for lone DOM surrogates.
      const html = Buffer.from(r.html, "utf8").toString("utf8");
      const f = r.findings;
      const rendered: Rendered | undefined = f ? { mark: f.mark, complete: f.hiddenComplete, wallDecided: f.verdict.decided } : undefined;
      const again = await parsePage("html", html, undefined, res.url, res.fileFlags, true, res.headers.get("content-language"), rendered);
      throwIfCancelled();
      const wall = f?.verdict.decided ? f.verdict.wall : again.wall;
      if (wall) return renderNote(wallEnv(url, wall, res.url, { final_url: res.url }), render, meta);
      parsed = again.parsed;
      renderedHash = renderedFingerprint(html, f?.mark);
      if (sv) renderedSave = { html, mark: rendered?.mark ?? "", complete: rendered?.complete ?? false, wallDecided: rendered?.wallDecided ?? false };
    }
  }
  // The render did not run or stopped: a plain wall that waited for it stands, decided by the HTML.
  if (pageWall && !renderedHash) {
    if (render?.status === "failed") render = { ...render, walls: "html" };
    return renderNote(wallEnv(url, pageWall, res.url, { final_url: res.url }), render, meta);
  }

  // The fingerprint of a copy covers how it was read as well as its bytes (Codex round 59): the same bytes
  // served now as CSV or as a script are a different copy, read again with their own flags.
  // A rendered copy's fingerprint covers what the rendering made too (W-10), so a plain and a rendered copy differ.
  const hash = renderedHash ? sha256(`${plainHash}|rendered:${renderedHash}`) : plainHash;
  const keepRendered = !!cache?.rendered && (render?.status === "failed" || render?.status === "unavailable");
  const sameBody = !!cache && cache.source_url === source && cache.final_url === res.url && cache.hash === hash;
  let door: Door = "text";
  // W-23: a page asked for as HTML that the site answered in markdown is read as markdown, and says so.
  const servedMarkdown = /^text\/(x-)?markdown$/.test(mimeOf(ct));
  let doorDetail: CacheEntry["door_detail"] = k === "pdf" || k === "html" || k === "json" ? detailOf(k) : detail === "html" ? (servedMarkdown ? "markdown" : "text") : detail;
  if (k === "html" && parsed.structured_count) {
    doorDetail = "html+json-ld";
    if (parsed.text_chars < 200) door = "structured"; // the data is all there is
  }
  // W-03: the response's own caching rules decide how long the copy may be served without asking.
  const fresh = fromResponse(res.headers, started);
  let entry: CacheEntry;
  if (sameBody && !staleParse) {
    const { fresh_until: _f, reuse_blocked: _b, ...rest } = cache!; // a full 200 judges freshness from scratch
    // Same bytes: the copy is kept, but how the site now describes it is taken fresh (round 83).
    // A saving read uses the fresh parse; otherwise only the current language hint needs refreshing.
    entry = { ...rest, ...fresh, parsed: sv ? parsed : { ...rest.parsed, language: parsed.language }, ...(renderedHash && render ? { render_inspection: inspectionCodes(render) } : {}), content_type: ct, shell: k === "html" && looksLikeShell(parsed.text_chars, res.body) ? true : undefined, door_detail: doorDetail, redirected: res.redirected, etag: res.headers.get("etag") ?? cache!.etag, last_modified: res.headers.get("last-modified") ?? cache!.last_modified, checked_at: now };
  } else
    entry = {
      parser: PARSER_VERSION, url, source_url: source, final_url: res.url, door, door_detail: doorDetail, hash, content_type: ct, parsed,
      ...(k === "html" && looksLikeShell(parsed.text_chars, res.body) ? { shell: true as const } : {}),
      etag: res.headers.get("etag") ?? undefined,
      last_modified: res.headers.get("last-modified") ?? undefined,
      // an identical body keeps its original read time, and with it the agent that first fetched it
      fetched_at: sameBody ? cache!.fetched_at : now, checked_at: now,
      fetched_by: sameBody ? cache!.fetched_by : agent?.slice(0, MAX_AGENT),
      redirected: res.redirected,
      ...(renderedHash ? { rendered: true as const, render_hash: renderedHash, plain_hash: plainHash, render_inspection: inspectionCodes(render!) } : {}),
      ...fresh,
    };
  if (cache) meta.cache = "refetched";
  // W-02: what changed, worked out against the cached copy BEFORE it is replaced. Private calls
  // never read the cache, so they never have a copy to compare with.
  const diff: DiffState = { fresh: false };
  if ((tool === "check" || opts.changes) && !sameBody && !keepRendered) {
    if (priv || !cache) diff.note = NO_BASELINE;
    else if (noStore(res.headers)) diff.note = NO_STORE_DIFF;
    else if (staleParse) diff.note = OLD_READER;
    else if (cache.source_url !== source) diff.note = OTHER_SOURCE;
    else {
      // CPU work over untrusted text: in the worker, under the parse time budget.
      const d = await runUntrusted<DiffResult>({ op: "diff", old: cache.parsed.sections, new: parsed.sections }, cache.parsed.searchable_chars + parsed.searchable_chars);
      throwIfCancelled();
      entry.changes = d.omitted
        ? { from: cache.fetched_at, at: now, omitted: true, items: [] }
        : { from: cache.fetched_at, at: now, items: d.items, added: d.added, removed: d.removed };
      diff.fresh = true;
    }
  }
  // No-store pages are not saved (the old copy already went, above). Otherwise the new copy is saved only once the answer is built (finishPage), so a call that fails leaves nothing new behind. A private call touches no page cache at all.
  const save = priv || keepRendered ? () => {} : () => (noStore(res.headers) ? undefined : writeJson(cacheFile, entry));
  if (sv && !sv.reason)
    sv.input = {
      url, source_url: source, final_url: res.url, status: res.status, content_type: ct, read_as: k, file_flags: [...(res.fileFlags ?? [])], language_header: res.headers.get("content-language"),
      received: res.raw ?? res.bytes ?? Buffer.from(res.body, "utf8"), ...(renderedSave ? { rendered: renderedSave } : {}),
    };
  // A failed rendering is no evidence of a content change. Show the plain read, with no diff or new baseline.
  const out = await finishPage(keepRendered && tool === "check" ? "read" : tool, url, entry, sameBody, cache && !sameBody && !keepRendered ? cache.fetched_at : null, keepRendered ? { ...opts, changes: false } : opts, shown, now, save, meta, diff, noStore(res.headers), { cache: meta.cache, agent, render, save: sv });
  if (keepRendered && tool === "check") out.message = (out.message ?? "") + " The rendered copy could not be compared; no changes were recorded.";
  return done(out);
}

// W-30: once the page has been read, the door checks start in the background (only after a page that was
// read: a wall, a price tag, a refusal or an error starts nothing), and the reply says they are running.
// An origin answer with nothing in it: only the page's own doors are summarized (never cached, never used to
// pick a source).
const pageOnly = (origin: string): OriginDoors => ({ v: 0, origin, probed_at: 0, sitemaps: [] });
export const DOORS_PENDING = "Door checks for this site (llms.txt, MCP, API) are still running in the background; the next read uses them.";
function afterDeferred(e: Envelope, origin: string): Envelope {
  if (e.status !== "ok" && e.status !== "unchanged") return e;
  if (!startDoorProbe(origin)) return e;
  e.doors_pending = true;
  e.message = e.message ? `${e.message} ${DOORS_PENDING}` : DOORS_PENDING;
  return e;
}

export async function finishPage(
  tool: Tool, url: string, entry: CacheEntry, unchanged: boolean, changedFrom: string | null,
  opts: Opts, od: OriginDoors | null, now: string, persist: () => void, meta: CallMeta, diff: DiffState, notKept = false, serve: Serve = {},
): Promise<Envelope> {
  const wantsContent = opts.question !== undefined || opts.section !== undefined || opts.page !== undefined || (tool === "read" && (opts.translate !== undefined || !!opts.save));
  // W-28 (v0.8): the snapshot is written before the receipts are recorded, so each recorded receipt names it.
  const sv = tool === "read" ? serve.save : undefined;
  const saveNow = (rs: Receipt[]) => {
    if (!sv) return;
    if (sv.input) sv.top = saveSnapshot(sv.input, rs);
    if (sv.top?.status === "saved") meta.saved = true;
  };
  const savedOn = (e: Envelope): Envelope => (sv ? addSaved(e, sv.top ?? { status: "not_saved", reason: sv.reason ?? "no_page" }) : e);
  const common = {
    door: entry.door, door_detail: entry.door_detail, fetched_at: entry.fetched_at, flags: entry.parsed.flags, flags_dropped: entry.parsed.flags_dropped,
  };
  // W-03: a reply served from, or validated against, the shared cache says so. Who fetched it is
  // caller-supplied, so it sits inside untrusted_content with the time.
  const fromCache = serve.cache === "fresh" || serve.cache === "revalidated";
  const cacheUc: Uc = fromCache ? { cached_at: entry.fetched_at, ...(entry.fetched_by !== undefined ? { cached_by: entry.fetched_by } : {}) } : {};
  const withCache = (e: Envelope): Envelope => {
    csvCount(e, entry.parsed); // W-20: on every reply that carries the page's flags
    stampLanguage(e, entry.parsed.language); // W-26 (v0.7)
    renderNote(e, serve.render ?? (entry.rendered ? cachedRender(entry) : undefined), meta);
    if (serve.cache) e.cache = serve.cache;
    if (tool === "read" && entry.shell && !entry.rendered && !opts.render) {
      const note = "This page looks like a JavaScript-only shell. Ask for rendering to read its content.";
      e.message = e.message ? `${e.message} ${note}` : note;
    }
    if (fromCache) e.untrusted_content = { ...(e.untrusted_content ?? {}), ...cacheUc };
    if (sv) {
      // Reserve every field a successful save will add BEFORE sizing or translation. The real
      // hash has the same length; the byte/file counts already come from the bytes to be saved.
      const input = sv.top ? undefined : sv.input;
      const top: SavedTop = input ? {
        status: "saved", id: "0".repeat(64),
        files: Number(!!input.received) + Number(!!input.rendered),
        bytes: (input.received?.length ?? 0) + (input.rendered ? Buffer.byteLength(input.rendered.html, "utf8") : 0),
        ...(input.rendered ? { rendered: true } : {}),
      } : sv.top ?? { status: "not_saved", reason: sv.reason ?? "no_page" };
      if (input) for (const r of (e.untrusted_content?.receipts ?? []) as Receipt[]) r.snapshot = top.id;
      addSaved(e, top);
    }
    return fitEnvelope(e);
  };
  const freshNote = serve.cache === "fresh" ? ` Served from the shared cache without asking the site: by the site's own max-age (at most an hour) this copy stays fresh until ${new Date(entry.fresh_until!).toISOString()}.` : "";
  const priv = isPrivate();
  const ad = od ? summarize(od, entry.parsed) : null;
  if (ad) noteDoors(meta, ad);
  const doorsUc: Uc = ad ? { available_doors: ad } : {};
  const page = opts.page ?? 1;
  // One page size for every list of changes (check, read and watch all number pages the same way).
  const budget = BUDGET.sectionText;
  // A kept list of changes is shown when it was just worked out, or when the page is unchanged
  // and the caller asks for a page of it (the later pages of a long list).
  // A no-store answer (an identical 200, or a 304) never serves a kept list: the site asked that
  // nothing be kept, and the kept copy is already gone (Codex round 36).
  const showChanges = !notKept && !!entry.changes && (diff.fresh || (unchanged && opts.page !== undefined && (tool === "check" || !!opts.changes)));
  const ch = showChanges ? changesPart(entry, page, budget) : null;
  const chMsg = ch
    ? diff.fresh
      ? ch.omitted
        ? `Changed since ${entry.changes!.from}. ${DIFF_OMITTED}`
        : `Changed since ${entry.changes!.from}: ${ch.counts!.added} blocks added, ${ch.counts!.removed} removed.`
      : ch.omitted
        ? `Unchanged since ${entry.fetched_at}. When it last changed (found ${entry.changes!.at}), ${DIFF_OMITTED[0].toLowerCase() + DIFF_OMITTED.slice(1)}`
        : `Unchanged since ${entry.fetched_at}. These are the changes found when it last changed (${entry.changes!.at}, compared with the copy from ${entry.changes!.from}).`
    : undefined;
  const chFields = ch ? { counts: ch.counts, changes_omitted: ch.omitted || undefined } : {};
  if (tool === "check") {
    meta.changed = !unchanged && !!changedFrom && !priv;
    if (!priv) (meta.hash = entry.hash), (meta.first = !unchanged && !changedFrom);
    persist();
    if (ch) {
      if (!priv) recordReceipts(ch.receipts);
      return withCache(env(url, unchanged ? "unchanged" : "ok", { ...common, ...chFields, message: chMsg + (diff.fresh ? " The new version is cached." : "") + freshNote, uc: { final_url: entry.final_url, ...ch.uc }, receipts: ch.receipts }));
    }
    const message = priv
      ? "Private check: nothing is saved, so there is no earlier visit to compare with. The page answered."
      : unchanged
      ? `Unchanged since ${entry.fetched_at}${serve.cache === "fresh" ? "." : ` (checked ${now}).`}${freshNote}`
      : changedFrom
        ? `Changed since ${changedFrom}. ${diff.note ? diff.note + " " : ""}${notKept ? "" : "The new version is cached. Call read to see it."}`.trim()
        : "First visit. Recorded it, so there is nothing to compare yet.";
    return withCache(env(url, unchanged ? "unchanged" : "ok", { ...common, message, uc: { final_url: entry.final_url } }));
  }
  // The one-line "unchanged" answer is for the agent that already has this copy. The cache is shared,
  // so another agent (or an older entry with no agent recorded) gets the content instead.
  if (unchanged && !wantsContent && entry.fetched_by !== undefined && entry.fetched_by === serve.agent?.slice(0, MAX_AGENT)) {
    persist();
    return withCache(env(url, "unchanged", {
      ...common,
      message: `Unchanged since ${entry.fetched_at}${serve.cache === "fresh" ? "." : ` (checked ${now}).`} Nothing was re-read. Ask for page 1 (the outline), a section or a question to see it again.${freshNote}`,
      uc: { final_url: entry.final_url, ...doorsUc },
    }));
  }
  const c = await buildContent(entry, opts);
  if (opts.question !== undefined && Array.isArray(c.uc.passages)) meta.matched = c.uc.passages.length;
  if (c.error) {
    persist(); // the page itself was read fine; only the section asked for is missing
    if (sv) sv.top = { status: "not_saved", reason: "no_page" };
    return savedOn(withCache(env(url, "error", { ...common, message: c.error, uc: { final_url: entry.final_url } })));
  }
  throwIfCancelled();
  const rs = ch ? [...c.receipts, ...ch.receipts] : c.receipts;
  const message = chMsg ?? (unchanged ? (sv ? `Unchanged since ${entry.fetched_at}; fetched again to save it.` : `Unchanged since ${entry.fetched_at}. Answered from the local cache.`) : opts.changes ? diff.note : undefined);
  const reply = env(url, unchanged ? "unchanged" : "ok", {
    ...common,
    ...chFields,
    message: message === undefined ? (freshNote ? freshNote.trim() : undefined) : message + freshNote,
    uc: { ...c.uc, ...doorsUc, ...(ch?.uc ?? {}) },
    receipts: rs,
  });
  if (entry.parsed.forms && reply.counts) reply.counts.forms = entry.parsed.forms.length + (entry.parsed.forms_omitted ?? 0); // W-04
  const out = withCache(reply);
  // W-26 (v0.7): the owner's translation hook, only when asked and only on a read. The receipts above were
  // built from the original text; the translation never becomes one.
  if (tool === "read" && opts.translate !== undefined) {
    await translateReply(out, opts.translate);
  }
  throwIfCancelled();
  // Use exactly the receipts retained in the final answer, with no placeholder left on a failed save.
  const kept = (out.untrusted_content?.receipts ?? []) as Receipt[];
  if (sv?.input) for (const r of kept) delete r.snapshot;
  persist();
  saveNow(kept);
  if (!priv) recordReceipts(kept);
  return savedOn(out);
}

// W-28 (v0.8): what a read that asked to save carries through the pipeline: the bytes to save, or why not; and the result.
export type SaveCtx = { input?: SaveInput; reason?: SavedReason; top?: SavedTop };
// The top-level `saved` (fixed codes, Tiresias's own hash and counts) and its fixed sentence.
export function addSaved(e: Envelope, top: SavedTop): Envelope {
  const previous = e.saved;
  e.saved = top;
  const text = savedText(top);
  e.message = previous ? e.message?.replace(savedText(previous), text) : e.message ? `${e.message} ${text}` : text;
  fitTranslation(e);
  return fitEnvelope(e);
}

// W-10 (v0.7): the top-level `render` (fixed codes and counts) and its fixed sentence; history notes a rendered read.
export function renderNote(e: Envelope, render: RenderTop | undefined, meta: CallMeta): Envelope {
  if (!render) return e;
  e.render = render;
  if (render.status === "rendered") meta.rendered = true;
  const text = (render.status === "rendered" ? RENDERED_TEXT : RENDER_TEXT[render.status]) + (render.overlay === "other" ? ` ${OVERLAY_TEXT}` : "");
  e.message = e.message ? `${e.message} ${text}` : text;
  return e;
}

export function recordReceipts(rs: Receipt[]): void {
  try {
    receipts.record(rs);
  } catch (e) {
    console.error(`Could not write receipts: ${(e as Error).message}`); // a log failure never fails the browsing call
  }
}

export const noteDoors = (meta: CallMeta, ad: AvailableDoors) => {
  meta.best_door = ad.best;
  if (ad.llms_txt) meta.llms_txt = true;
};

export async function doorsOnly(rawUrl: string, meta: CallMeta = {}): Promise<Envelope> {
  const u = parseSafeUrl(rawUrl);
  const url = u.href.split("#")[0];
  const rule = await checkAllowed(u);
  if (rule.wall) return wallEnv(url, rule.wall, rule.wallUrl ?? url);
  if (!rule.allowed) return env(url, "refused", { message: rule.reason, retry_after_seconds: rule.retrySeconds });
  const od = await probeOrigin(u.origin);
  // The page itself is fetched (capped) only to read its <link> tags and JSON-LD.
  let page: ParsedPage | undefined;
  let finalUrl = url;
  try {
    const res = await politeFetch(url, { maxBytes: 1024 * 1024, truncate: true });
    finalUrl = res.url;
    const early = earlyOutcome(url, res);
    if (early && (early.status === "wall" || early.status === "payment_required")) return early;
    // Declared HTML is parsed as HTML here whatever its name says, so its wall markers are always seen (Codex round 65).
    if (res.status === 200 && (res.read === "html" || looksHtml(res.headers.get("content-type"), res.body))) {
      const r = await runUntrusted<{ parsed: ParsedPage; wall: WallInfo | null }>({ op: "parse", kind: "html", body: res.body, url: res.url }, res.body.length);
      page = r.parsed;
      if (r.wall) return wallEnv(url, r.wall, res.url, { final_url: res.url });
    }
  } catch (e) {
    // An unreachable page is fine (origin doors still count). Policy outcomes are not.
    // Every Tiresias error but a plain fetch failure is a policy outcome or a real failure (a flag stops
    // the call, a bad setting fails it); a fetch failure stops it only when the caller cancelled.
    if (e instanceof TiresiasError && (e.kind !== "fetch" || (e as FetchError).code === "cancelled")) throw e;
  }
  const ad = summarize(od, page);
  noteDoors(meta, ad);
  // v0.5.1: `door` means the door USED, everywhere; doors reads no content through any, so it is "none",
  // and the best door the site offers is `available`.
  const out = env(url, "ok", {
    door: "none",
    message: "Tiresias detects every door but reads only llms.txt/markdown, structured data and page text. Use the listed URLs to go further.",
    uc: { final_url: finalUrl, available_doors: ad },
    flags: page?.flags,
    flags_dropped: page?.flags_dropped,
  });
  out.available = ad.best;
  return out;
}
