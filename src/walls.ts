// SPDX-License-Identifier: Apache-2.0
// N-05 and N-08: honest stop at walls, and price tags.
// A wall means a human is needed. We never retry, never solve, never route
// around. A 402 means the site wants money. We read the price and stop.
import { parseDocument } from "./dom.js";
import { ComplexityError, MAX_NODES } from "./errors.js";
import { challengeText } from "./forms.js";
import { NOT_RENDERED, cssTaint, plain } from "./shield.js";
import type { Price } from "./types.js";

// Fixed codes and fixed text. Nothing from the page is copied into these.
export type WallCode = "bot_challenge" | "captcha" | "login_required" | "forbidden";
export interface WallInfo {
  code: WallCode;
  explanation: string;
}

const TEXT: Record<WallCode, string> = {
  bot_challenge: "The site served a bot check. A person has to pass it.",
  captcha: "The page asks for a CAPTCHA. A person has to complete it.",
  login_required: "The page needs a login or credentials. A person has to sign in.",
  forbidden: "The site refused this visit (HTTP 403).",
};
const wall = (code: WallCode): WallInfo => ({ code, explanation: TEXT[code] });

// Marker scanning is plain indexOf over a bounded prefix. No regex with
// nested or lazy spans runs on page content: a hostile page like "<form " x
// 128,000 made the old CAPTCHA regex take seconds, and a synchronous match
// cannot be interrupted by a deadline.
const MAX_SCAN = 512 * 1024;
const MAX_TAG = 600; // a tag longer than this is not read as a password input
const MAX_FORM_CHECKS = 50;

function has(h: string, ...needles: string[]): boolean {
  return needles.some((n) => h.indexOf(n) !== -1);
}

// <title>Just a moment...
function cloudflareTitle(h: string): boolean {
  const t = h.indexOf("<title>");
  if (t === -1) return false;
  return h.slice(t + 7, t + 7 + 80).trimStart().startsWith("just a moment");
}

// "captcha" inside a <form>...</form>. For each occurrence of "captcha", look
// at the nearest <form before it and the first </form> after it.
// Returns where that form starts, or -1.
// Every form is looked at, once, in one forward pass (Codex round 75: a cap of 50 let early decoys hide
// the real one).
function captchaInForm(h: string): number {
  for (let from = 0; ; ) {
    const f = h.indexOf("<form", from);
    if (f === -1) return -1;
    let e = h.indexOf("</form>", f);
    if (e === -1) e = h.length;
    if (h.slice(f, e).indexOf("captcha") !== -1) return f;
    from = e + 1;
  }
}
const firstOf = (h: string, ...needles: string[]): number => {
  let best = -1;
  for (const n of needles) {
    const i = h.indexOf(n);
    if (i !== -1 && (best === -1 || i < best)) best = i;
  }
  return best;
};
// The page's main and article elements, found ONCE (Codex round 76: searching again for every marker was
// quadratic, and a capped search failed open): one pass over the walk's own exact tags pairs each opening
// with its close, and a prefix count of visible characters gives each element's own text in O(1). Returns
// the latest start of an element with at least 1,200 visible characters (-1 when none).
interface Layout {
  pre: Int32Array; // visible characters before each index
  lastContent: number; // start of the last qualifying <main> or <article>
}
function layout(h: string): Layout {
  const pre = new Int32Array(h.length + 1);
  let inTag = false;
  for (let i = 0; i < h.length; i++) {
    const ch = h.charCodeAt(i);
    if (ch === 60) inTag = true;
    else if (ch === 62) inTag = false;
    pre[i + 1] = pre[i] + (!inTag && ch > 32 && ch !== 62 ? 1 : 0);
  }
  let lastContent = -1;
  const open: Record<string, number[]> = { main: [], article: [] };
  const re = /<(\/?)(main|article)[ >]/g;
  for (let m = re.exec(h); m; m = re.exec(h)) {
    const stack = open[m[2]];
    if (!m[1]) stack.push(m.index);
    else {
      const start = stack.pop();
      if (start !== undefined && pre[m.index] - pre[start] >= 1200) lastContent = Math.max(lastContent, start);
    }
  }
  return { pre, lastContent };
}
const contentAfter = (L: Layout, i: number): boolean => L.lastContent > i;

// The markup with what a person never sees removed (Codex rounds 69 and 70). The page is PARSED (never
// matched as text), so an attribute value is never taken for an attribute, and every element is judged by
// the reader's own visibility rules (shield.ts hiddenReason: the hidden attribute, aria-hidden, inline
// display, visibility, opacity, font-size, clipping, off-screen positions, invisible colour, screen-reader
// classes, and the page's own <style> rules for classes and ids). Comments, <head>, <title>, <script>,
// <style>, <noscript> and <template> are dropped. What is left is written back as minimal markup: each
// visible element as <name> with only its type, class, id and role, and the visible text with "<" and ">"
// turned into spaces, so the indexOf checks below see exactly what a person would.
const RAW_SKIP = NOT_RENDERED; // the reader's own list (shield.ts)
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const KEEP_ATTRS = ["type", "class", "id", "role"];
const EMBEDS = new Set(["iframe", "object", "embed", "frame"]);
const CHROME = new Set(["nav", "footer", "header", "aside"]);
interface WN {
  type: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: WN[];
  data?: string;
}
// The document's first <title>, from the parse (Codex round 74: a raw prefix could be filled by a comment).
let lastTitle = "";
export const parsedTitle = () => lastTitle;
const MARKER_WORDS = ["g-recaptcha", "h-captcha", "hcaptcha", "cf-turnstile", "captcha", "recaptcha"];
export function visibleHtml(h: string, mark?: string): string {
  lastTitle = "";
  const tree = parseDocument(h);
  const doc = tree.doc as unknown as WN;
  const taint = cssTaint(doc);
  // A rendered fallback still honours the browser's private hidden marks, including text wrappers.
  // Preserve their source ancestry when the bounded parser flattens a deeply nested hidden subtree.
  const marked = new WeakSet<Record<string, string>>();
  const hidden = (a: Record<string, string>) => marked.has(a) || (mark !== undefined && Object.hasOwn(a, mark));
  if (mark && /^data-t-[0-9a-f]{16}$/.test(mark)) {
    if (tree.flattened) for (const [a, parent] of tree.inherited) if (hidden(parent)) marked.add(a);
  } else mark = undefined;
  // The first <title> anywhere in the document, found on its own walk (Codex round 75: the main walk skips
  // <head>, where a title lives).
  {
    const t: WN[] = [doc];
    for (let n = 0; t.length && n < MAX_NODES; n++) {
      const x = t.pop()!;
      if ((x.type === "tag" || x.type === "script" || x.type === "style") && (x.name ?? "").toLowerCase() === "title") {
        lastTitle = (x.children ?? []).map((c) => c.data ?? "").join("").slice(0, 200);
        break;
      }
      const ch = x.children ?? [];
      for (let k = ch.length - 1; k >= 0; k--) t.push(ch[k]);
    }
  } // the reader's own sheet (shield.ts): media, inert styles and the cascade
  let out = "";
  // Codex round 73: what a CSS rule seems to hide still has its MARKERS kept (its tags), only its text is
  // dropped. A misjudged rule can then only make a page look thinner (more walls), never hide a login form
  // or a CAPTCHA. Items carry whether their text counts.
  const stack: (WN | string | { off: WN })[] = [doc];
  let nodes = 0;
  while (stack.length) {
    const item = stack.pop()!;
    const textOff = typeof item === "object" && "off" in item;
    const x = (textOff ? (item as { off: WN }).off : item) as WN | string;
    // Codex round 71: running out of budget with work left fails closed (page_too_complex), never returns
    // partial markup. Only elements and text count, as in the reader's own walk.
    if (typeof x !== "string" && ++nodes > MAX_NODES) throw new ComplexityError();
    if (typeof x === "string") {
      out += x;
      continue;
    }
    if (x.type === "text") {
      // Only letters and digits count as content (Codex round 73: no-break and zero-width spaces padded a
      // page); everything else becomes a plain space.
      // Default-ignorable characters (fillers like U+3164 that are letters but draw nothing) are dropped
      // first (Codex round 74).
      if (!textOff) out += (x.data ?? "").replace(/\p{Default_Ignorable_Code_Point}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ");
      continue;
    }
    if (x.type === "comment" || x.type === "directive" || x.type === "cdata") continue;
    if (x.type === "tag" || x.type === "script" || x.type === "style") {
      const name = (x.name ?? "").toLowerCase();
      const a = x.attribs ?? {};
      // An embedded frame is a marker itself (a CAPTCHA served in a frame: Codex rounds 72 and 73): its tag
      // and address are kept, never its fallback text, whatever hides it.
      if (EMBEDS.has(name)) {
        // Marker words from the WHOLE address before it is shortened (Codex round 75).
        // The address a browser uses: `data` for an object, `src` for the others (Codex round 76).
        const addr = String((name === "object" ? a.data : a.src) ?? "").toLowerCase();
        // A challenge served in a frame is a marker on its own, form or not (Codex round 76): it is written
        // back as the widget it stands for, so the same checks see it.
        const marker = /turnstile|challenges\.cloudflare\.com/.test(addr) ? `<i class="cf-turnstile"></i>` : challengeText(addr) ? `<i class="g-recaptcha"></i>` : "";
        out += `<${name} src="${addr.slice(0, 300).replace(/["<>]/g, " ")}"></${name}>${marker}`;
        continue;
      }
      if (RAW_SKIP.has(name)) {
        continue;
      }
      // Markers are taken from the WHOLE attribute before anything is shortened (Codex round 74).
      const words = MARKER_WORDS.filter((w) => `${a.class ?? ""} ${a.id ?? ""}`.toLowerCase().includes(w));
      out += "<" + name + KEEP_ATTRS.filter((k) => k in a).map((k) => ` ${k}="${String(a[k]).slice(0, 200).replace(/["<>]/g, " ")}"`).join("") + (words.length ? ` data-markers="${words.join(" ")}"` : "") + ">";
      if (VOID.has(name)) continue;
      stack.push(`</${name}>`);
    }
    // Text counts only inside plain elements (the allow-list in shield.ts), and never inside nav, footer,
    // header or aside (site furniture, judged by parsed ancestry: Codex round 75).
    const off =
      typeof x !== "string" && (x.type === "tag" || x.type === "script" || x.type === "style")
        ? textOff || hidden(x.attribs ?? {}) || CHROME.has((x.name ?? "").toLowerCase()) || !plain(x.attribs ?? {}, taint)
        : textOff;
    const ch = x.children ?? [];
    for (let k = ch.length - 1; k >= 0; k--) stack.push(off ? { off: ch[k] } : ch[k]);
  }
  return out;
}

// Visible characters (outside tags, not white space) in h[from, to), counting as if `from` were outside a
// tag, and stopping once `stop` are seen.
function visible(h: string, from: number, to: number, stop = Infinity): number {
  let n = 0;
  let inTag = false;
  for (let i = from; i < to && i < h.length && n < stop; i++) {
    const ch = h.charCodeAt(i);
    if (ch === 60) inTag = true;
    else if (ch === 62) inTag = false;
    else if (!inTag && ch > 32) n++;
  }
  return n;
}
// Where `chars` more visible characters have been seen after `from` (or the end).
function topEnd(h: string, from: number, chars: number): number {
  let n = 0;
  let inTag = false;
  for (let i = from; i < h.length; i++) {
    const ch = h.charCodeAt(i);
    if (ch === 60) inTag = true;
    else if (ch === 62) inTag = false;
    else if (!inTag && ch > 32 && ++n > chars) return i;
  }
  return h.length;
}

// The next <input ... type=password ...> at or after `start` (its index, or -1), reading each tag only up
// to MAX_TAG characters.
function passwordInput(h: string, start = 0): number {
  let from = start;
  for (;;) {
    const i = h.indexOf("<input", from);
    if (i === -1) return -1;
    let end = h.indexOf(">", i);
    if (end === -1 || end - i > MAX_TAG) end = i + MAX_TAG;
    const tag = h.slice(i, end);
    for (let t = tag.indexOf("type"); t !== -1; t = tag.indexOf("type", t + 4)) {
      const rest = tag.slice(t + 4).trimStart();
      if (rest.startsWith("=") && /^["']?password/.test(rest.slice(1).trimStart())) return i;
    }
    from = i + 6;
  }
}

// Rough visible length (characters outside tags), in one linear pass.
export function approxTextLength(html: string): number {
  let n = 0;
  let inTag = false;
  for (let i = 0; i < html.length; i++) {
    const ch = html.charCodeAt(i);
    if (ch === 60) inTag = true; // <
    else if (ch === 62) inTag = false; // >
    else if (!inTag) n++;
  }
  return n;
}

export function detectWall(
  o: { status: number; headers: Headers; html?: string; textChars?: number; rendered?: { mark: string } },
  // lenient: used for probe paths like /.well-known/mcp.json. A bare 401/403
  // there often just means "no such file", so only real challenges count.
  lenient = false,
): WallInfo | null {
  if ((o.headers.get("cf-mitigated") ?? "").toLowerCase() === "challenge") return wall("bot_challenge");
  if (!lenient && o.status === 401) return wall("login_required");
  if (!lenient && o.status === 403) return wall("forbidden");

  const raw = (o.html ?? "").slice(0, MAX_SCAN);
  const h = raw.toLowerCase();
  if (!h) return null;
  if (cloudflareTitle(h)) return wall("bot_challenge"); // always a wall (prefix; the parsed title is checked below too)
  if (o.status !== 200) {
    if (has(h, "cf-turnstile")) return wall("bot_challenge");
    if (has(h, "g-recaptcha", "hcaptcha", "h-captcha") || captchaInForm(h) !== -1) return wall("captcha");
  }
  // v0.5.1: no whole-page length threshold (a login page padded below the form slipped past). A challenge
  // widget, a CAPTCHA in a form, or a password box is a wall when it is what the TOP of the page is about:
  // fewer than 1,200 visible characters (800 for a password) come before it, and no real content follows.
  // A long article with a captcha'd comment form, or a forum page with a sign-in box in its header, is read.
  // "More follows" means a <main> or <article> after the marker with at least 1,200 visible characters
  // (its <footer> and <nav> not counted): a content page with a sign-in box. Any other text after the
  // marker (the padding a login page can carry, in a footer or a plain block) does not spare it.
  // Codex round 69 (HIGH): the counting is done on the VISIBLE markup only: scripts, styles, <head>,
  // comments and hidden subtrees are removed first, so invisible source text cannot pad a login page.
  // Codex round 71: parsed and judged on the ORIGINAL markup (class names are case-sensitive); only the
  // written-back visible markup is lowercased for the marker checks.
  // Codex round 73: the WHOLE fetched page is parsed (the fetch cap bounds it; the node budget fails
  // closed), not a 512 KB prefix a comment could fill.
  const v = visibleHtml(o.html ?? "", o.rendered?.mark).toLowerCase();
  if (parsedTitle().trimStart().toLowerCase().startsWith("just a moment")) return wall("bot_challenge");
  const L = layout(v);
  const ends = (i: number, before: number) => i !== -1 && L.pre[i] < before && !contentAfter(L, i);
  if (ends(firstOf(v, "cf-turnstile"), 1200)) return wall("bot_challenge");
  if (ends(firstOf(v, "g-recaptcha", "hcaptcha", "h-captcha"), 1200) || ends(captchaInForm(v), 1200)) return wall("captcha");
  // Every password box near the top is looked at (no cap: Codex round 75); the text before each is counted
  // as the scan goes, so this stays one pass.
  for (let from = 0; ; ) {
    const p = passwordInput(v, from);
    if (p === -1 || L.pre[p] >= 800) break;
    if (!contentAfter(L, p)) return wall("login_required");
    from = p + 6;
  }
  return null;
}

const NEVER_PAY = "Tiresias reads prices and never pays. Nothing was sent to the payee.";
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const short = (v: string | undefined) => v?.slice(0, 200);

// x402 payment requirements, validated against each version's required fields
// (https://github.com/coinbase/x402 specs). An invalid body is never used, and
// never hides a valid payment-required header or another format.
//   v1 option: scheme, network, maxAmountRequired, resource, description,
//              mimeType, payTo, maxTimeoutSeconds, asset. Top level: x402Version 1, accepts[].
//   v2 option: scheme, network, amount, asset, payTo, maxTimeoutSeconds.
//              Top level: x402Version 2, resource {url}, accepts[].
// The amount field belongs to its version: v1 only maxAmountRequired, v2 only amount.
const digits = (v: unknown): v is string => typeof v === "string" && /^\d{1,78}$/.test(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isSecs = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function validOption(o: unknown, version: 1 | 2): Record<string, unknown> | null {
  if (!o || typeof o !== "object") return null;
  const a = o as Record<string, unknown>;
  if (!isStr(a.scheme) || !isStr(a.network) || !isStr(a.asset) || !isStr(a.payTo) || !isSecs(a.maxTimeoutSeconds)) return null;
  if (version === 1) {
    if (!digits(a.maxAmountRequired) || "amount" in a) return null;
    if (!isStr(a.resource) || typeof a.description !== "string" || !isStr(a.mimeType)) return null;
  } else if (!digits(a.amount) || "maxAmountRequired" in a) return null;
  return a;
}

function fromX402(obj: unknown): Price | null {
  if (!obj || typeof obj !== "object") return null;
  const top = obj as { x402Version?: unknown; accepts?: unknown; resource?: unknown };
  const version = top.x402Version;
  if (version !== 1 && version !== 2) return null;
  if (version === 2) {
    const r = top.resource as { url?: unknown } | null | undefined;
    if (!r || typeof r !== "object" || !isStr(r.url)) return null;
  }
  if (!Array.isArray(top.accepts)) return null;
  const good = top.accepts.map((x) => validOption(x, version)).filter((x): x is Record<string, unknown> => x !== null);
  if (!good.length) return null;
  const o = good[0];
  const extra = o.extra && typeof o.extra === "object" ? (o.extra as Record<string, unknown>) : {};
  return {
    method: "x402",
    amount: String(version === 1 ? o.maxAmountRequired : o.amount),
    asset: short(str(o.asset)),
    currency: short(str(extra.name)),
    payee: short(str(o.payTo)),
    network: short(str(o.network)),
    scheme: short(str(o.scheme)),
    options: good.length,
    // x402 amounts are in the asset's smallest unit (10000 = 0.01 at 6 decimals).
    note: NEVER_PAY + " Amount is in the asset's smallest unit.",
  };
}

export function parsePrice(headers: Headers, body: string): Price {
  try {
    const p = fromX402(JSON.parse(body));
    if (p) return p;
  } catch {
    // not JSON
  }
  // x402 v2 puts the same JSON, base64 encoded, in a header.
  const pr = headers.get("payment-required");
  if (pr) {
    try {
      const p = fromX402(JSON.parse(Buffer.from(pr, "base64").toString("utf8")));
      if (p) return p;
    } catch {
      // fall through
    }
  }
  // Cloudflare Pay Per Crawl style: crawler-price: USD 0.01
  const cp = headers.get("crawler-price");
  if (cp) {
    const m = /([A-Za-z]{3})\s*([\d.]+)|([\d.]+)\s*([A-Za-z]{3})/.exec(cp);
    if (m) return { method: "pay-per-crawl", currency: (m[1] ?? m[4]).toUpperCase(), amount: m[2] ?? m[3], note: NEVER_PAY };
  }
  // Unknown format: show the headers that look relevant and let a human decide.
  const raw: Record<string, string> = {};
  headers.forEach((v, k) => {
    if (/price|payment|x402|crawler|pay/i.test(k)) raw[k] = v.slice(0, 500);
  });
  return { method: "unknown", raw_headers: raw, note: NEVER_PAY + " The price format was not recognized." };
}
