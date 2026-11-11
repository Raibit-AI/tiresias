// SPDX-License-Identifier: Apache-2.0
// W-17: reading PDFs with Mozilla's pdf.js, locked down. This file runs ONLY inside the worker
// thread (worker.ts), under the same time budget and heap limit as every other untrusted parse.
//
// What is and is not done with the PDF:
//   - the bytes are passed as `data`, never a URL; nothing is fetched (no workerSrc, no range or
//     streaming requests, no auto-fetch), and the character maps, standard fonts and WASM helpers
//     are read from the installed package folder by file path
//   - only text is read. No JavaScript or actions run (pdf.js has no scripting here), no
//     annotations or links are read, no attachments are extracted, no form is touched, no
//     page is rendered, no font is installed (disableFontFace)
//   - pdf.js runs its own "worker" as ordinary code inside this thread (it has no separate thread in
//     Node), so nothing is spawned outside our sandbox
import { holdsSecret, SecretWithheld, type Secrets } from "./echo.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PdfError } from "./errors.js";
import { FLAG_TEXT } from "./files.js";
import { MAX_EXPANDED, parsePdfText } from "./reader.js";
import type { Flag, ParsedPage } from "./types.js";

// W-20: a /Launch action named anywhere in the file's plain bytes (a name may spell letters as #hh).
// pdf.js does not report Launch actions, so this one is looked for directly, in one linear pass. Best
// effort: a name inside a compressed object stream is not seen. Nothing is ever launched either way.
export function hasLaunch(bytes: Uint8Array): boolean {
  const s = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  // PDF's own white-space bytes (NUL included; Codex round 62) and delimiters, as an explicit list.
  const delim = (c: string | undefined) => c === undefined || "\x00\t\n\f\r /<>[]()%{}".includes(c);
  for (let i = s.indexOf("/"); i !== -1; i = s.indexOf("/", i + 1)) {
    if (s[i + 1] !== "L" && s[i + 1] !== "#") continue;
    let name = "";
    let j = i + 1;
    while (j < s.length && !delim(s[j]) && name.length <= 12) {
      if (s[j] === "#" && /^[0-9a-fA-F]{2}$/.test(s.slice(j + 1, j + 3))) {
        name += String.fromCharCode(parseInt(s.slice(j + 1, j + 3), 16));
        j += 3;
      } else name += s[j++];
    }
    if (name === "Launch" && delim(s[j])) return true;
  }
  return false;
}

export const MAX_PDF_PAGES = 500;

const PDFJS = "pdfjs-dist/legacy/build/pdf.mjs";

// The installed pdfjs-dist folder (where cmaps/, standard_fonts/ and wasm/ live).
function packageDir(): string {
  const entry = fileURLToPath(import.meta.resolve(PDFJS));
  return path.resolve(path.dirname(entry), "..", "..");
}

// pdf.js prints warnings with console.log. In a worker that would go to this process's stdout,
// which is the MCP protocol stream. So console is silenced while a PDF is read.
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const c = console as unknown as Record<string, unknown>;
  const names = ["log", "info", "warn", "debug", "error"];
  const saved = names.map((n) => c[n]);
  for (const n of names) c[n] = () => {};
  try {
    return await fn();
  } finally {
    names.forEach((n, i) => (c[n] = saved[i]));
  }
}

const damaged = () => new PdfError("This PDF is damaged or not a PDF Tiresias can read. Nothing was read from it.");
const locked = () => new PdfError("This PDF is password protected or encrypted. Tiresias does not use passwords, so it was not read.");

const MAX_HIDDEN = 5000; // text items looked at for placement, per document
const MAX_OPS = 200_000; // drawing operations looked at for white text, per page

// v0.5.1: text drawn in white (the usual way to hide words from a reader on a white page), from the page's
// drawing operations: the fill colour is followed through save and restore, and the glyphs shown while it
// is white are collected. Bounded; any trouble reads as "none found". (The text stays in the page text,
// since pdf.js does not tie these glyphs to its text items; it is flagged and scanned.)
async function drawnText(page: { getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }> }, OPS: Record<string, number>): Promise<{ white: string; runs: string[] }> {
  try {
    const ops = await page.getOperatorList();
    const stack: boolean[] = [];
    let white = false;
    let out = "";
    const runs: string[] = []; // every run of text drawn in another colour (to find text pdf.js left out)
    const isWhite = (a: unknown[]): boolean => {
      if (typeof a[0] === "string") return /^#f{6}$/i.test(a[0]);
      const v = a.filter((x): x is number => typeof x === "number");
      return v.length > 0 && v.every((x) => x >= 0.99 && x <= 1) || (v.length > 0 && v.every((x) => x >= 254));
    };
    for (let i = 0; i < Math.min(ops.fnArray.length, MAX_OPS) && out.length < 2000; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i] ?? [];
      if (fn === OPS.save) stack.push(white);
      else if (fn === OPS.restore) white = stack.pop() ?? false;
      else if (fn === OPS.setFillRGBColor || fn === OPS.setFillGray) white = isWhite(args);
      else if (fn === OPS.setFillCMYKColor) white = (args as number[]).every((x) => x === 0);
      else if (fn === OPS.showText || fn === OPS.showSpacedText) {
        let run = "";
        for (const g of (Array.isArray(args[0]) ? args[0] : []) as unknown[]) {
          const u = (g as { unicode?: unknown } | null)?.unicode;
          if (typeof u === "string") run += u;
        }
        if (white) out += run + " ";
        else if (runs.length < 5000) runs.push(run);
      }
    }
    return { white: out.trim().slice(0, 2000), runs };
  } catch {
    return { white: "", runs: [] };
  }
}

export async function parsePdf(bytes: Uint8Array, baseUrl: string, secrets?: Secrets): Promise<ParsedPage> {
  return quietly(async () => {
    const pdfjs = await import(PDFJS);
    const dir = packageDir();
    const dirUrl = (sub: string) => path.join(dir, sub) + path.sep; // plain file paths, not URLs
    const task = pdfjs.getDocument({
      data: new Uint8Array(bytes), // a copy: pdf.js takes ownership of its buffer
      // Nothing is fetched or evaluated:
      isEvalSupported: false, // no new Function() for fonts
      useWorkerFetch: false,
      disableAutoFetch: true,
      disableStream: true,
      disableRange: true,
      // Nothing is installed or looked up on this machine:
      disableFontFace: true,
      useSystemFonts: false,
      // Text only:
      enableXfa: false,
      stopAtErrors: false, // read what can be read from a slightly damaged file
      verbosity: 0,
      // Helper data, from the installed package on disk by path:
      cMapUrl: dirUrl("cmaps"),
      cMapPacked: true,
      standardFontDataUrl: dirUrl("standard_fonts"),
      wasmUrl: dirUrl("wasm"),
      iccUrl: dirUrl("iccs"),
    });
    let doc;
    try {
      doc = await task.promise;
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === "PasswordException") throw locked();
      throw damaged();
    }
    try {
      const total: number = doc.numPages;
      let title = "";
      try {
        const meta = await doc.getMetadata();
        const t = (meta.info as Record<string, unknown> | undefined)?.Title;
        if (typeof t === "string") title = t;
      } catch {
        // no usable metadata
      }
      if (holdsSecret([title], secrets)) throw new SecretWithheld();
      const pages: string[] = [];
      const hidden: { page: number; reason: string; text: string }[] = [];
      let kept = 0;
      let cut = 0;
      let stoppedAt = 0; // the first page not read, when the text cap was reached
      let jsOnPages = false; // W-20: a page's own JavaScript actions
      let attachedOnPages = false; // W-20: a file attached to a page
      for (let n = 1; n <= Math.min(total, MAX_PDF_PAGES); n++) {
        const page = await doc.getPage(n);
        try {
          const pj = await page.getJSActions();
          if (pj && pj.size) jsOnPages = true;
        } catch {
          // none readable
        }
        try {
          // Annotation metadata only (Codex round 60): a file attached to a page, not in the catalog. The
          // attachment's content is never requested.
          const an = (await page.getAnnotations({ intent: "any" })) as { subtype?: string }[]; // hidden ones too (Codex round 61)
          if (an.some((a) => a.subtype === "FileAttachment")) attachedOnPages = true;
        } catch {
          // none readable
        }
        let text = "";
        let pageLen = 0; // the page's full text length, counted even for text not kept
        try {
          const tc = await page.getTextContent();
          const [x0, y0, x1, y1] = (page.view as number[] | undefined) ?? [0, 0, Infinity, Infinity];
          const off: string[] = [];
          const tiny: string[] = [];
          for (const it of tc.items as { str?: string; hasEOL?: boolean; transform?: number[]; width?: number; height?: number }[]) {
            if (typeof it.str !== "string") continue;
            // v0.5.1: where the item sits. Text placed off the page is left out of the page text; text
            // under 1 point is kept; both are flagged as hidden.
            const t = it.transform;
            if (t && it.str.trim() && hidden.length + off.length + tiny.length < MAX_HIDDEN) {
              const size = Math.hypot(t[2] ?? 0, t[3] ?? 0);
              const x = t[4] ?? 0;
              const y = t[5] ?? 0;
              if (x + (it.width ?? 0) < x0 - 1 || x > x1 + 1 || y < y0 - size - 1 || y > y1 + 1) {
                off.push(it.str);
                continue;
              }
              if (size > 0 && size < 1) tiny.push(it.str); // kept in the text (a quote may need it), and flagged
            }
            const piece = it.str + (it.hasEOL ? "\n" : "");
            pageLen += piece.length;
            if (text.length < MAX_EXPANDED) text += piece; // stop building once this page alone has passed the cap; keep counting
          }
          const drawn = await drawnText(page, pdfjs.OPS);
          // pdf.js itself leaves out text drawn outside the page: it is never read, but it is flagged.
          const seen = (tc.items as { str?: string }[]).map((i) => i.str ?? "").join(" ");
          for (const r of drawn.runs) if (r.trim() && !seen.includes(r.trim()) && !off.includes(r)) off.push(r);
          if (off.length) hidden.push({ page: n, reason: "text placed off the page", text: off.join(" ").slice(0, 2000) });
          if (tiny.length) hidden.push({ page: n, reason: "text under 1 point", text: tiny.join(" ").slice(0, 2000) });
          if (drawn.white) hidden.push({ page: n, reason: "white text", text: drawn.white });
        } finally {
          page.cleanup();
        }
        const room = MAX_EXPANDED - kept;
        if (pageLen > room) {
          cut += pageLen - room; // exact: every item's length was counted
          text = text.slice(0, Math.max(0, room));
          pages.push(text);
          kept += text.length;
          stoppedAt = n + 1;
          break;
        }
        pages.push(text);
        kept += text.length;
      }
      // W-20: what pdf.js reports about code, attachments and actions. Nothing is run or opened.
      const own: Flag[] = [];
      let js = jsOnPages;
      try {
        const d = await doc.getJSActions();
        if (d && d.size) js = true;
      } catch {
        // none readable
      }
      try {
        if (await doc.hasJSActions()) js = true;
      } catch {
        // none readable
      }
      if (js) own.push({ type: "pdf_javascript", snippet: "", detail: FLAG_TEXT.pdf_javascript });
      let attached = attachedOnPages;
      try {
        const a = (await doc.getAttachments()) as unknown;
        if (a instanceof Map ? a.size : a && typeof a === "object" ? Object.keys(a).length : 0) attached = true;
      } catch {
        // none readable
      }
      if (attached) own.push({ type: "pdf_attachments", snippet: "", detail: FLAG_TEXT.pdf_attachments });
      if (hasLaunch(bytes)) own.push({ type: "pdf_launch", snippet: "", detail: FLAG_TEXT.pdf_launch });
      const read = pages.length;
      // Pages never read are counted. Their text is unknown, so the cut count is then a lower bound.
      const unread = total - read;
      const parsed = parsePdfText(pages, { title, pageCount: total, pagesOmitted: unread, cut, cutIsLowerBound: stoppedAt > 0 && unread > 0, hidden }, baseUrl);
      parsed.flags = [...own, ...parsed.flags];
      return parsed;
    } finally {
      await task.destroy();
    }
  });
}
