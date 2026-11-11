// SPDX-License-Identifier: Apache-2.0
// W-20 and W-21: replies for a response that is a file (the file warning, the owner's scanner) and the
// intake of a file a person saved (W-06), hashed piece by piece like a download.
// (Split out of engine.ts in v0.5.1, behavior unchanged.)
import fs from "node:fs";
import path from "node:path";
import { HEAD_BYTES, REASON, RISK, type FileFlag, type FileKind } from "./files.js";
import { fitInside, inspectFile, insideMessage, keepFor, macroByName } from "./inside.js";
import * as scanner from "./scanner.js";
import { TiresiasError } from "./errors.js";
import * as receipts from "./receipts.js";
import * as shelf from "./shelf.js";
import { FileIntake, fileCap, removeQuarantined, throwIfCancelled, type FileFacts, type FileOptions } from "./safety.js";
import { NONBLOCK, isPrivate, sha256 } from "./store.js";
import { type Envelope, type FileWarning, type ParsedPage, type Receipt } from "./types.js";
import type { CacheEntry } from "./pagecache.js";
import { MAX_BLOCK } from "./reader.js";
import { MAX_SAMPLE, detect, stampLanguage } from "./lang.js";
import { translateReply } from "./translate.js";
import { SecretWithheld, noSecrets, valueHoldsSecret, type Secrets } from "./echo.js";

import { runUntrusted } from "./sandbox.js";

import { BUDGET, CallMeta, Opts, Uc, env } from "./envelope.js";

export class ProvidedError extends TiresiasError {
  readonly kind = "provided";
}

// ---- W-20: the dangerous file plan; W-21: the owner's scanner ----

export const FILE_MESSAGE =
  "This link leads to a file, not a page Tiresias reads. Tiresias did not open, run, unpack or save it; it only named its kind from its first bytes and fingerprinted it (SHA-256). Skip this file and carry on with the rest of your task. Your person decides what to do with it: tell them it is here (file_warning has the kind, size and fingerprint).";
export const NO_FINGERPRINT: Record<NonNullable<FileFacts["stopped"]>, string> = {
  too_large: "The file is larger than TIRESIAS_MAX_FILE_BYTES (50 MB unless the owner changed it), so the download stopped there and the file was not fingerprinted.",
  not_downloaded: "The site says the file is larger than TIRESIAS_MAX_FILE_BYTES (50 MB unless the owner changed it), so it was not downloaded or fingerprinted.",
  timeout: "The download took too long, so it stopped and the file was not fingerprinted.",
};
export const SCANNER_PROBLEM = "The scanner setting in config.json is not valid, so the scanner was not run. The owner can check it with: tiresias scanner show.";
export const NO_QUARANTINE = "The scanner asks for the file itself (send_file), but the quarantine copy could not be written, so the scanner was not run.";

// The W-20 file options of a fetch whose body is a page or a file: hash a file up to the file cap, and
// (W-21 send_file, never in private mode) write a high-risk one to quarantine as it streams.
export function fileOptions(): FileOptions {
  return {
    maxBytes: fileCap(),
    keep: keepFor, // v0.6: a zip or Office file small enough is held in memory to look inside
    onFile: (f) => {
      if (f.risk !== "high" || isPrivate()) return undefined;
      const s = scanner.scannerConfig();
      return s.cfg?.send_file ? scanner.quarantineSink() : undefined;
    },
  };
}

// The reply for a file. The scanner hook (W-21) runs here, on a high-risk file with a fingerprint; its
// quarantine copy is deleted as soon as the hook is done. Recorded in the receipts log (W-20) unless private.
export async function fileWarning(url: string, finalUrl: string, f: FileFacts, meta: CallMeta, agent: string | undefined, source?: "provided_by_person" | "provided_by_agent", opts: Opts = {}, secrets?: Secrets, saveSnapshot?: () => string | undefined): Promise<Envelope> {
  try {
    const fw: FileWarning = {
      kind: f.kind, risk: f.risk, size: f.size,
      ...(f.sha256 ? { fingerprint: `sha256:${f.sha256}` } : { fingerprint_note: NO_FINGERPRINT[f.stopped ?? "too_large"] }),
      flags: f.flags, reason: REASON[f.kind],
    };
    const uc: Uc = {
      final_url: finalUrl, declared_type: f.declared_type,
      ...(f.declared_name !== undefined ? { declared_name: f.declared_name } : {}),
      ...(f.declared_size !== undefined ? { declared_size: f.declared_size.slice(0, 24) } : {}),
    };
    if (f.risk === "high" && f.sha256) {
      const s = scanner.scannerConfig();
      if (s.problem) {
        fw.scan = { verdict: "failed", by: "config.json" };
        uc.scan_note = SCANNER_PROBLEM;
      } else if (s.cfg) {
        if (s.cfg.send_file && !isPrivate() && !f.quarantine) {
          fw.scan = { verdict: "failed", by: path.basename(s.cfg.command[0]).slice(0, 100) };
          uc.scan_note = NO_QUARANTINE;
        } else {
          const r = await scanner.runScanner(s.cfg, {
            kind: f.kind, size: f.size, fingerprint: `sha256:${f.sha256}`, declared_type: f.declared_type, url: finalUrl,
            ...(s.cfg.send_file && f.quarantine ? { file: f.quarantine } : {}),
          });
          fw.scan = { verdict: r.verdict, by: r.by };
          if (r.note !== undefined) uc.scan_note = r.note;
        }
      }
    }
    // v0.6: inside a zip or an Office file, in the worker, without unpacking it (inside.ts).
    const ins = await inspectFile(f);
    if (ins?.office_text && !noSecrets(secrets)) {
      const texts = [JSON.stringify(ins.office_text), ins.office_text.map((s) => s.text).join("\n")];
      if (await runUntrusted<boolean>({ op: "echo", texts, secrets: secrets! }, Infinity)) throw new SecretWithheld();
    }
    if (macroByName(f) || ins?.macros) fw.flags = [...new Set([...fw.flags, "macros" as const])];
    if (ins) {
      fw.inside = ins.top;
      if (Object.keys(ins.uc).length) uc.inside = ins.uc;
    }
    meta.file_kind = f.kind;
    if (fw.scan) meta.scan = fw.scan.verdict;
    const e = env(url, "file_warning", { message: ins ? `${FILE_MESSAGE} ${insideMessage(ins.top)}` : FILE_MESSAGE, uc, flags: ins?.flags ?? [], flags_dropped: ins?.flags_dropped });
    e.file_warning = fw;
    // v0.6 integration: Office text gets receipts, section paging and question search, like a page read.
    const firstLook = opts.question === undefined && opts.section === undefined && opts.page === undefined;
    let rs: Receipt[] = [];
    if (ins?.office_text) {
      rs = await officeContent(e, ins.office_text, finalUrl, opts, meta, source);
      e.message = `${e.message} ${OFFICE_MORE}`;
      const secs = ins.office_text;
      stampLanguage(e, detect((function* () {
        for (const s of secs) yield* s.text.slice(0, MAX_SAMPLE).split("\n");
      })())); // W-26 (v0.7): the language of the Office text (bounded: lang.ts samples at most 64 KB)
    }
    // v0.9 (item B): a form answer whose inside (Office text, zip names) repeats a secret the site set for the
    // form is withheld whole by the caller, before anything from it is recorded or put on the shelf.
    if (valueHoldsSecret({ uc: e.untrusted_content, rs, inside: fw.inside, flags: e.flags }, secrets)) throw new SecretWithheld();
    const ucOf = () => e.untrusted_content as Record<string, unknown> | null;
    // Reserve the snapshot ids for the size guard without writing anything before translation.
    if (saveSnapshot) for (const r of rs) r.snapshot = "0".repeat(64);
    if (rs.length && ucOf()) ucOf()!.receipts = rs; // in place before the size check, so it counts
    if (e.counts) e.counts.receipts = rs.length;
    if (ins) fitInside(e, BUDGET.hardLimit); // v0.6: the whole reply, warning included, within its limit
    // A receipt is kept only for text the reply still shows.
    const inside = ucOf()?.inside as Record<string, unknown> | undefined;
    const contentKey = firstLook ? "sections" : opts.question ? "passages" : opts.section !== undefined ? "section" : "outline";
    if (!ucOf()?.receipts || !inside || !(contentKey in inside)) rs = [];
    if (e.counts) e.counts.receipts = rs.length;
    if (ucOf()) {
      if (rs.length) ucOf()!.receipts = rs;
      else delete ucOf()!.receipts;
    }
    if (ins?.office_text && opts.translate !== undefined) await translateReply(e, opts.translate);
    throwIfCancelled();
    // Parsing and translation succeeded. Save the fingerprint before recording its receipts.
    const snapshot = saveSnapshot?.();
    if (!isPrivate()) {
      try {
        receipts.recordFile({
          url, final_url: finalUrl, file_kind: f.kind, risk: f.risk, size: f.size, ...(f.sha256 ? { fingerprint: `sha256:${f.sha256}` } : {}), flags: fw.flags, // the final flags, macros included (Codex round 14)
          declared_type: f.declared_type, ...(f.declared_name !== undefined ? { declared_name: f.declared_name } : {}), ...(fw.scan ? { scan: fw.scan.verdict } : {}),
          agent: agent ?? "unknown", ...(source ? { source } : {}),
        });
      } catch (err) {
        console.error(`Could not write the file record: ${(err as Error).message}`); // a log failure never fails the call
      }
      // v0.6 W-27: the downloads shelf. A warning that could not be put on it says so (fixed code).
      let shelved = false;
      try {
        shelved = shelf.record({ url, finalUrl, fw, f, agent, source });
      } catch (err) {
        console.error(`Could not put the file on the shelf: ${(err as Error).message}`);
      }
      if (!shelved) e.shelf = "not_recorded";
    }
    for (const r of rs) {
      if (snapshot) r.snapshot = snapshot;
      else delete r.snapshot;
    }
    if (rs.length) {
      e.counts = { ...(e.counts ?? { receipts: 0, flags: e.flags.length }), receipts: rs.length };
      if (!isPrivate()) {
        try {
          receipts.record(rs);
        } catch (err) {
          console.error(`Could not write the receipts: ${(err as Error).message}`); // a log failure never fails the call
        }
      }
    }
    return e;
  } finally {
    if (f.quarantine) removeQuarantined(f.quarantine); // the hook is done (or never ran): the copy goes now
    delete f.body; // v0.6: the bytes held to look inside go now
  }
}

// The person's file: opened without blocking (a pipe fails at once), checked to be a regular file. Links are
// followed: the person chose this file, it is not in the store.
// W-20 (Codex round 59): the person's file is never read whole before its kind is known. Its first bytes
// decide; a page is then read up to the fetch cap as before, and a file is hashed (and, for the owner's
// scanner, copied) piece by piece up to the file cap, like a download.
// The first bytes looked at: never more than the file cap allows, as for a download (Codex round 66).
export const headBytes = () => Math.min(HEAD_BYTES, fileCap() + 1);
export type Source = { head: Buffer; size: number; pieces: () => Iterable<Buffer>; whole: () => Buffer; tail: () => Buffer };
export const PIECE = 64 * 1024;
export function providedFile(file: string, cap: number): { src: Source; close: () => void } {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NONBLOCK);
  } catch {
    throw new ProvidedError("That file cannot be opened.");
  }
  const close = () => fs.closeSync(fd);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new ProvidedError("That is not a plain file. Give a saved page (HTML, markdown, text or PDF).");
    const readAt = (buf: Buffer, pos: number) => {
      let n = 0;
      for (let r = -1; r !== 0 && n < buf.length; n += r) r = fs.readSync(fd, buf, n, buf.length - n, pos + n);
      return buf.subarray(0, n);
    };
    const head = readAt(Buffer.alloc(headBytes()), 0);
    const tooBig = () => new ProvidedError(`That file is larger than ${cap} bytes, the most Tiresias reads (the same cap as a fetched page). It was not read.`);
    return {
      close,
      src: {
        head, size: st.size,
        tail: () => (st.size >= 512 ? readAt(Buffer.alloc(512), st.size - 512) : Buffer.alloc(0)),
        *pieces() {
          for (let pos = 0; ; ) {
            const b = readAt(Buffer.alloc(PIECE), pos);
            if (!b.length) return;
            pos += b.length;
            yield b;
          }
        },
        whole() {
          if (st.size > cap) throw tooBig();
          const b = readAt(Buffer.alloc(cap + 1), 0);
          if (b.length > cap) throw tooBig();
          return b;
        },
      },
    };
  } catch (e) {
    close();
    throw e;
  }
}
export function providedText(text: string): Source {
  return {
    head: Buffer.from(text.slice(0, headBytes()), "utf8").subarray(0, headBytes()),
    size: Buffer.byteLength(text, "utf8"),
    *pieces() {
      for (let i = 0; i < text.length; ) {
        let end = Math.min(text.length, i + PIECE);
        const c = text.charCodeAt(end - 1);
        if (end < text.length && c >= 0xd800 && c <= 0xdbff) end--; // never split a surrogate pair
        yield Buffer.from(text.slice(i, end), "utf8");
        i = end;
      }
    },
    whole: () => Buffer.from(text, "utf8"),
    tail: () => Buffer.from(text.slice(-512), "utf8").subarray(-512),
  };
}
// Hash a file piece by piece up to the file cap, with the W-21 quarantine copy when the owner asked for one.
export function hashPieces(kind: FileKind, flags: FileFlag[], name: string | undefined, src: Source): FileFacts {
  const opt = fileOptions();
  const f: FileFacts = { kind, risk: RISK[kind], flags, size: 0, declared_type: "", ...(name !== undefined ? { declared_name: name } : {}) };
  if (src.size > opt.maxBytes) {
    f.size = src.size;
    f.stopped = "too_large";
    return f;
  }
  // The same intake a download uses (safety.ts FileIntake): cap, hash and quarantine copy, piece by piece.
  const intake = new FileIntake(opt.maxBytes, opt.onFile?.({ kind, risk: f.risk }), opt.keep?.(kind, src.head) ?? 0);
  try {
    for (const b of src.pieces()) if (!intake.write(b)) break;
  } catch (e) {
    intake.drop();
    throw e;
  }
  f.size = intake.size;
  if (intake.stopped) {
    f.stopped = "too_large";
    return f;
  }
  return Object.assign(f, intake.finish());
}

// ---- v0.6 integration: Office text through the normal read path (receipts, `section` + `page`, `question`) ----

export const OFFICE_MORE = "Ask again with section N (and page) for a section's full text, or with question for quoted passages; each quote comes with a receipt.";

// The Office text as a page: one section per part (its heading is a label Tiresias made: never a receipt),
// bounded blocks from each line, so a receipt quotes exact extracted text. Built on the main thread from text the worker
// already scanned; searched in the worker like any page.
export function officePage(secs: { heading: string; text: string }[]): ParsedPage {
  let chars = 0;
  const sections = secs.map((s, i) => {
    const blocks: ParsedPage["sections"][number]["blocks"] = [];
    for (const line of s.text.split("\n").filter((t) => t.trim())) {
      for (let start = 0; start < line.length; ) {
        let end = Math.min(start + MAX_BLOCK, line.length);
        if (end < line.length && /[\ud800-\udbff]/.test(line[end - 1])) end--;
        const text = line.slice(start, end);
        blocks.push({ text, marks: [] });
        chars += text.length;
        start = end;
      }
    }
    return { n: i + 1, level: 1, heading: s.heading, generated: true as const, blocks };
  });
  return { title: "", sections, links: [], structured_count: 0, structured_types: [], feeds: [], service_desc: [], flags: [], text_chars: chars, searchable_chars: chars };
}

// Fills untrusted_content.inside for this call and returns its receipts. The first look (no question, section
// or page) keeps the budgeted sections and quotes each one; otherwise the answer is the page reader's own
// (buildContent): passages, one section page, or a page of the outline.
async function officeContent(e: Envelope, secs: { heading: string; text: string }[], finalUrl: string, opts: Opts, meta: CallMeta, source?: "provided_by_person" | "provided_by_agent"): Promise<Receipt[]> {
  const ins = (e.untrusted_content as Uc | null)?.inside as Record<string, unknown> | undefined;
  if (!ins) return [];
  const now = new Date().toISOString();
  if (opts.question === undefined && opts.section === undefined && opts.page === undefined) {
    const shownSecs = (ins.sections as { n: number; text: string }[] | undefined) ?? [];
    return shownSecs.map((s) => ({ quote: s.text, url: finalUrl, section: s.n, fetched_at: now, ...(source ? { source } : {}) }));
  }
  const { buildContent } = await import("./pipeline.js"); // pipeline.ts imports this module
  const c = await buildContent({ final_url: finalUrl, fetched_at: now, parsed: officePage(secs), ...(source ? { source } : {}) } as CacheEntry, opts);
  delete ins.sections;
  delete ins.text_omitted; // both describe the first look only
  if (c.error) {
    e.message = `${e.message} ${c.error}`;
    return [];
  }
  for (const k of ["question", "passages", "section", "outline", "page", "pages", "section_count"]) if (k in c.uc) ins[k] = c.uc[k];
  if (opts.question !== undefined && Array.isArray(c.uc.passages)) meta.matched = c.uc.passages.length;
  return c.receipts;
}
