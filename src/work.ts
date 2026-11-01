// SPDX-License-Identifier: Apache-2.0
// The CPU work done on untrusted content, as plain functions. They run inside
// a worker thread (worker.ts) when the input is big, so a hostile page that
// makes one of them slow cannot stall the main thread: the main thread just
// terminates the worker when the time budget runs out (sandbox.ts).
import { PdfError } from "./errors.js";
import { ComplexityError, parseHtml, parseJsonText, parseMarkdown, parsePlain, parseSvg, topPassages, type Passage, type PlainMode } from "./reader.js";
import { diffSections } from "./diff.js";
import { languageOf } from "./lang.js";
import { inspect } from "./inside.js";
import { normalizeList } from "./safelist.js";
import { holdsSecret } from "./echo.js";
import type { ParsedPage, Section } from "./types.js";
import { approxTextLength, detectWall, type WallInfo } from "./walls.js";

export type Job =
  // W-20: "svg" and "plain" (scripts, CSV, calendar and contact files, by `mode`) are read as text only
  // `wall`: also look for wall markers when the reader is not HTML (a response declared HTML but read as
  // CSV, a script or SVG because of its name; Codex round 63)
  // `lang`: the Content-Language the site sent (W-26: a hint for language detection only)
  // `rendered` (v0.7 track 2): the HTML of a rendered page, its hidden elements marked by the browser (inspect.ts)
  | { op: "parse"; kind: "html" | "json" | "text" | "svg" | "plain"; mode?: PlainMode; body: string; url: string; wall?: boolean; lang?: string; rendered?: { mark: string; complete: boolean; wallDecided: boolean } }
  | { op: "wall"; status: number; html: string; textChars?: number; lenient?: boolean; alsoThin?: boolean }
  | { op: "pdf"; bytes: Uint8Array; url: string; lang?: string } // runs only in its own process (pdfproc.ts, pdfchild.ts)
  | { op: "search"; parsed: ParsedPage; question: string; k: number }
  | { op: "language"; parsed: ParsedPage; lang?: string } // refresh a cached parse's header hint without reparsing it
  | { op: "diff"; old: Section[]; new: Section[] } // W-02: block diff against the cached copy
  | { op: "blocklist"; body: string } // W-19: the downloaded Phishing.Database list, normalized
  | import("./inside.js").InsideJob // v0.6: inside a zip or an Office file (inside.ts), always in the worker
  | { op: "forms"; body: string; url: string } // W-04: a page's forms WITH hidden values (preview and submit; never cached)
  | { op: "echo"; texts: string[]; secrets: import("./echo.js").Secrets }; // v0.9 item B: does a form answer repeat a secret?

export type Done = { result: unknown } | { error: "complexity" | "too_large" | "failed" | "pdf"; message?: string };

export function handle(job: Job): Done {
  const done = handleJob(job);
  // Check in the worker, before structured cloning and before anything can be cached on the parent.
  return "result" in done && JSON.stringify(done.result).length > MAX_WORKER_RESULT_CHARS ? { error: "too_large" } : done;
}

export const MAX_WORKER_RESULT_CHARS = 16 * 1024 * 1024;

function handleJob(job: Job): Done {
  try {
    switch (job.op) {
      case "parse": {
        const parsed =
          job.kind === "html" ? parseHtml(job.body, job.url, undefined, job.rendered)
          : job.kind === "json" ? parseJsonText(job.body, job.url)
          : job.kind === "svg" ? parseSvg(job.body, job.url)
          : job.kind === "plain" ? parsePlain(job.body, job.url, job.mode ?? "script")
          : parseMarkdown(job.body, job.url);
        parsed.language = languageOf(parsed, job.lang); // W-26 (v0.7): in the worker, under the parse budget
        // Page-content markers only; header-based walls are checked by the caller.
        const wall: WallInfo | null =
          // v0.7 track 2: a rendered page whose walls the browser decided is not judged again from its markup.
          (job.kind === "html" || job.wall) && !job.rendered?.wallDecided
            ? detectWall({
                status: 200, headers: new Headers(), html: job.body, rendered: job.rendered,
                // The visible-text length the HTML reader finds, whatever reader was chosen (Codex round 64:
                // markup counted as CSV text had hidden a login page behind padding).
                textChars: job.kind === "html" ? parsed.text_chars : parseHtml(job.body, job.url).text_chars,
              })
            : null;
        return { result: { parsed, wall } };
      }
      case "forms": {
        const keep: { forms?: import("./forms.js").FullForm[] } = {};
        const parsed = parseHtml(job.body, job.url, keep);
        const wall: WallInfo | null = detectWall({ status: 200, headers: new Headers(), html: job.body, textChars: parsed.text_chars });
        return { result: { forms: keep.forms ?? [], omitted: parsed.forms_omitted ?? 0, flags: parsed.flags, wall } };
      }
      case "wall": {
        const chars = job.textChars ?? approxTextLength(job.html);
        const w =
          detectWall({ status: job.status, headers: new Headers(), html: job.html, textChars: chars }, job.lenient) ??
          (job.alsoThin ? detectWall({ status: 200, headers: new Headers(), html: job.html, textChars: 0 }, job.lenient) : null);
        return { result: w };
      }
      case "pdf":
        return { error: "failed", message: "PDFs are read only in their own process" };
      case "search":
        return { result: topPassages(job.parsed, job.question, job.k) as Passage[] };
      case "language":
        return { result: languageOf(job.parsed, job.lang) };
      case "diff":
        return { result: diffSections(job.old, job.new) };
      case "blocklist":
        return { result: normalizeList(job.body) };
      case "inside":
        return { result: inspect(job) };
      case "echo":
        return { result: holdsSecret(job.texts, job.secrets) };
    }
  } catch (e) {
    if (e instanceof ComplexityError) return { error: "complexity" };
    if (e instanceof PdfError) return { error: "pdf", message: e.message };
    return { error: "failed", message: (e as Error).message };
  }
}

// The one asynchronous job (pdf.js is async). Called only from the PDF child process.
export async function handleAsync(job: Job): Promise<Done> {
  if (job.op !== "pdf") return handle(job);
  try {
    const { parsePdf } = await import("./pdf.js");
    const parsed = await parsePdf(job.bytes, job.url);
    parsed.language = languageOf(parsed, job.lang); // W-26 (v0.7)
    return { result: { parsed, wall: null } };
  } catch (e) {
    if (e instanceof PdfError) return { error: "pdf", message: e.message };
    if (e instanceof ComplexityError) return { error: "complexity" };
    return { error: "failed", message: (e as Error).message };
  }
}

// The most a PDF child may send back (characters of JSON). A real page of up to 5 MiB of text is far below it.
export const MAX_PDF_RESULT_CHARS = 16 * 1024 * 1024;

// Used by the child before sending: an answer over the cap is replaced by a tiny "too large" one, so the
// parent never has to receive it.
export function capDone(done: Done, max = MAX_PDF_RESULT_CHARS): Done {
  if (!("result" in done)) return done;
  return JSON.stringify(done.result).length > max ? { error: "failed", message: "too_large" } : done;
}
