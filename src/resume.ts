// SPDX-License-Identifier: Apache-2.0
// W-06: handoff tickets and resume, including a page a person provided.
// (Split out of engine.ts in v0.5.1, behavior unchanged.)
import path from "node:path";
import { ConfigError, DEFAULT_LIMITS, readConfigObject } from "./config.js";
import { classify } from "./files.js";
import * as handoffs from "./handoffs.js";
import { decode, fetchCap, throwIfCancelled } from "./safety.js";
import { NOTICE, PARSER_VERSION, type Ctx, type Door, type Envelope } from "./types.js";

import { CallMeta, DEFAULT, Opts, env, guarded, sessionPrivate } from "./envelope.js";
import { ProvidedError, Source, fileWarning, hashPieces, providedFile, providedText } from "./filereply.js";
import { CacheEntry } from "./pagecache.js";
import { detailOf, finishPage, len, looksHtml, paginate, parsePage, run } from "./pipeline.js";

// ---- W-06: handoff tickets and resume ----

// Fixed text only: never repeats the file name, the id or anything from the page.
export const NO_TICKET = "There is no open handoff ticket with that id. It may have been used already, cleared, or expired. The handoffs tool (tiresias handoffs) lists the open ones.";
export const PRIVATE_RESUME = "Private mode: handoff tickets are not used or changed, because a private session changes nothing in the store. Run without private mode to resume.";
export const PROVIDED =
  "Read from the page a person provided. Tiresias sent no request to the site for it. It was not cached and is not compared for changes, because it may show the person's own logged-in view.";
export const STILL_WALLED =
  "The page the person provided still shows a wall (it may be the check or login page itself), so nothing was read. The ticket stays open: get through the wall, then save the page that follows.";

export interface Provided {
  text?: string; // MCP: the page as text (HTML, markdown or plain text)
  file?: string; // CLI: a saved page (HTML, markdown, text or PDF)
}


// Parse a page the person provided exactly like a fetched page of that type, in the worker (or the
// PDF child) under the same limits. No request of any kind is made. W-20: the same plan as a fetched
// response decides what it is (its first bytes, then its file name); a file that is not a page is a file
// warning, fingerprinted like a download.
export async function fromPerson(t: handoffs.Ticket, p: Provided, opts: Opts, meta: CallMeta, agent?: string): Promise<Envelope> {
  const source = p.file !== undefined ? "provided_by_person" : "provided_by_agent";
  const cap = fetchCap();
  if (p.text !== undefined && p.file !== undefined) throw new ProvidedError("Give the page as text or as a file, not both.");
  let src: Source;
  let close = () => {};
  let name: string | undefined;
  if (p.file !== undefined) {
    ({ src, close } = providedFile(p.file, cap));
    name = path.basename(p.file).slice(0, 255);
  } else {
    const text = p.text ?? "";
    if (Buffer.byteLength(text, "utf8") > cap) throw new ProvidedError(`That text is larger than ${cap} bytes, the most Tiresias reads (the same cap as a fetched page). It was not read.`);
    if (text.startsWith("%PDF-")) throw new ProvidedError("That text looks like a PDF, which cannot be passed as text. Save it as a file and run: tiresias resume <ticket> --from-file <file>.");
    src = providedText(text);
  }
  let raw: Buffer = Buffer.alloc(0);
  let v: ReturnType<typeof classify>;
  try {
    if (!src.head.length) throw new ProvidedError("The page provided is empty.");
    const names = name !== undefined ? { disposition: name } : {};
    // The same classification as a download, with the trailer read on its own (a dmg's only mark).
    v = classify(src.head, "", names, src.tail());
    if (!("file" in v)) {
      raw = src.whole();
      // A page is checked WHOLE for binary content, not only its first bytes (coordinator, 2026-10-20,
      // after Codex round 67): a NUL past a short head makes it a file like any other.
      v = classify(raw, "", names, src.tail());
    }
    if ("file" in v) {
      const f = hashPieces(v.file, v.flags, name, src);
      close();
      close = () => {};
      return await fileWarning(t.url, t.url, f, meta, agent, source, opts);
    }
  } finally {
    close();
  }
  const k = v.read;
  // Decoded exactly like a fetched body with no type: a byte-order mark (UTF-8 or UTF-16) decides, then an
  // HTML <meta> charset, else UTF-8 (Codex round 60: a UTF-16 CSV or login page was read as UTF-8).
  const body = k === "pdf" ? "" : decode(raw, null);
  // A saved page has no declared type: markup at its start decides whether its wall markers are looked for.
  const { parsed, wall } = await parsePage(k, body, k === "pdf" ? raw : undefined, t.url, v.flags, looksHtml(null, body));
  throwIfCancelled();
  if (wall)
    return env(t.url, "wall", { message: source === "provided_by_agent" ? "The page the agent provided still shows a wall. The ticket stays open for a person." : STILL_WALLED, handoff: { reason: wall.code, explanation: wall.explanation }, uc: { handoff: { open_this: t.open_this ?? t.url } } });
  let door: Door = "text";
  let detail: CacheEntry["door_detail"] = detailOf(k);
  if (k === "html" && parsed.structured_count) {
    detail = "html+json-ld";
    if (parsed.text_chars < 200) door = "structured";
  }
  const now = new Date().toISOString();
  // The receipt URL is the ticket's URL; the entry exists only in memory and is never saved.
  const entry: CacheEntry = {
    parser: PARSER_VERSION, url: t.url, source_url: t.url, final_url: t.url, door, door_detail: detail, hash: "", content_type: "",
    fetched_at: now, checked_at: now, parsed, source,
  };
  const out = await finishPage("read", t.url, entry, false, null, opts, null, now, () => {}, meta, { fresh: false });
  if (out.status === "ok") out.message = `${source === "provided_by_agent" ? "Read from text an agent provided. Tiresias sent no request to the site for it. It was not cached or compared for changes." : PROVIDED}${out.message ? " " + out.message : ""}`;
  return out;
}

export const keepDays = () => {
  const value = readConfigObject()?.keep_handoff_days;
  if (value === undefined) return DEFAULT_LIMITS.keep_handoff_days;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new ConfigError('config.json: "keep_handoff_days" must be a whole number of 1 or more.');
  return value;
};

// W-06: pick up a read that stopped at a wall. Without `provided`, the original read runs again
// (same URL, question, section, render and translate options) with every rule in force: robots.txt, waits, signing and wall
// detection; it always asks the site (a cached copy is never taken as proof the wall is gone).
// With `provided`, the page a person saved is parsed and NOTHING is sent to the site.
// The ticket is deleted when the read succeeds; a wall keeps it open (no new ticket is made).
export async function resume(id: string, provided?: Provided, ctx: Ctx = DEFAULT): Promise<Envelope> {
  if (ctx.private || sessionPrivate()) return env("", "refused", { message: PRIVATE_RESUME });
  // v0.5.1: the ticket is CLAIMED first (renamed away in one step), so two resumes of one ticket never
  // both run; it goes back to its name unless this resume solved it.
  let c: handoffs.Claim | null;
  try {
    c = handoffs.claim(id, keepDays());
  } catch (e) {
    if (e instanceof handoffs.HandoffError || e instanceof ConfigError) return env("", "error", { message: e.message });
    throw e;
  }
  if (!c) return env("", "error", { message: NO_TICKET });
  const claimed = c;
  const ticket = c.ticket;
  let solved = false;
  let open = true;
  let out: Envelope;
  try {
    const opts: Opts = { question: ticket.question, section: ticket.section, render: ticket.render, translate: ticket.translate };
    const person = !!provided && (provided.text !== undefined || provided.file !== undefined);
    const source = provided?.file !== undefined ? "provided_by_person" : "provided_by_agent";
    const meta: CallMeta = person ? { source } : {};
    out = await guarded(
      "resume", ticket.url, ctx, ticket.question,
      (m) => (person ? fromPerson(ticket, provided!, opts, m, ctx.agent) : run("read", ticket.url, { ...opts, fresh: true }, m, ctx.agent)),
      meta, { existing: ticket.id }, !person,
    );
    if (person) out.source = source;
    solved = out.status === "ok" || (!person && out.status === "unchanged");
  } finally {
    try {
      handoffs.release(claimed, solved);
      open = !solved;
    } catch (e) {
      // The read worked but the ticket could not be closed (or put back): say it is still open
      // rather than claim it was closed (Codex round 40).
      open = true;
      console.error(`Could not update the handoff ticket: ${(e as Error).message}`);
    }
  }
  out.ticket = { id: ticket.id, open };
  return out;
}

export interface HandoffsReply {
  status: "ok";
  message: string;
  notice: string;
  counts: { open: number; expired: number; damaged: number };
  page: number;
  pages: number;
  // Tickets hold URLs, the page to open, questions and agent names from outside.
  untrusted_content: { handoffs: handoffs.Ticket[] };
}

export function handoffList(page = 1): HandoffsReply {
  const l = handoffs.list(keepDays());
  const pg = paginate(l.items, len, page, 40_000);
  return {
    status: "ok",
    message: l.items.length
      ? `Open handoff tickets: ${l.items.length}. Each waits for a person; resume one with its id once they are through the wall.`
      : "No open handoff tickets.",
    notice: NOTICE,
    counts: { open: l.items.length, expired: l.expired, damaged: l.damaged },
    page,
    pages: pg.pages,
    untrusted_content: { handoffs: pg.slice },
  };
}

