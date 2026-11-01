// SPDX-License-Identifier: Apache-2.0
// W-01: outline first, detail on request. Turns HTML (or markdown/plain text)
// into numbered sections and numbered links, with no AI involved.
//
// Two rules shape this file:
//  - Quotes must be real. A Block's `text` is exactly what was extracted;
//    link markers like [3] live beside it (`marks`), never inside it.
//  - Hostile pages must not crash us. All walks are iterative (no recursion
//    depth limit) and capped by a node budget.
import { parseDocument } from "./dom.js";
import { extractForms, publicForm, type FullForm } from "./forms.js";
import { FLAG_TEXT } from "./files.js";
import { hiddenReason, NOT_RENDERED, pageSheet, Shield, snippet, type HiddenSheet } from "./shield.js";
import { parseEvents, type CalEvent } from "./ics.js";
import { MAX_URL, jsonBytes, type Block, type Flag, type LinkItem, type PageMeta, type ParsedPage, type Section } from "./types.js";
import { ComplexityError } from "./errors.js";

interface N {
  type: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: N[];
  data?: string;
}

export const MAX_LINKS = 100;
export { MAX_NODES } from "./errors.js";
import { MAX_NODES } from "./errors.js";
export const MAX_BLOCK = 4000; // longest paragraph kept whole; longer ones are split
const MAX_STRUCTURED = 5 * 1024 * 1024; // the fetch cap: all structured data that arrived is kept
export const MAX_EXPANDED = 5 * 1024 * 1024; // pretty-printed JSON can expand ~500x; text past this is cut and counted
export const MAX_HEADING = 300; // returned metadata is bounded so one huge value cannot crowd out the rest
export const MAX_TITLE = 200;
export const MAX_LIST_INDENT = 8;

export { ComplexityError } from "./errors.js";

const SKIP = NOT_RENDERED; // shield.ts: shared with the wall check
const QUIET = new Set(["nav", "footer", "aside"]); // boilerplate: links kept, text dropped
// W-22 (v0.5.1): boilerplate by ARIA role and by class or id name (cookie banners, related posts, share
// bars, newsletter boxes, sidebars, ads). Matched on whole words of the class or id (split at - and _).
const QUIET_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search", "menubar", "toolbar"]);
const BOILER_WORDS = new Set([
  "cookie", "cookies", "consent", "gdpr", "related", "recommended", "share", "sharing", "social", "newsletter", "subscribe",
  "subscription", "sidebar", "breadcrumb", "breadcrumbs", "advert", "advertisement", "ads", "ad", "sponsored", "promo", "popup",
  "modal", "banner", "masthead", "footer", "nav", "navbar", "menu", "comments", "disqus",
]);
function boilerplate(a: Record<string, string>): boolean {
  if (QUIET_ROLES.has((a.role ?? "").toLowerCase())) return true;
  const names = `${a.class ?? ""} ${a.id ?? ""}`.slice(0, 500).toLowerCase();
  for (const word of names.split(/[\s_-]+/)) if (BOILER_WORDS.has(word)) return true;
  return false;
}
const BLOCK = new Set([
  "p", "div", "section", "article", "li", "ul", "ol", "tr", "table", "blockquote", "pre", "br", "hr", "main",
  "header", "aside", "form", "dl", "dt", "dd", "figure", "figcaption", "details", "summary", "caption",
]);

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

// Collapse whitespace while tracking where link markers land in the result.
function collapse(parts: (string | number)[]): Block {
  let text = "";
  let pendingSpace = false; // whitespace seen since the last character; written only if more text follows
  const marks: [number, number][] = [];
  for (const p of parts) {
    if (typeof p === "number") {
      marks.push([text.length, p]);
      continue;
    }
    for (const ch of p) {
      if (/\s/.test(ch)) pendingSpace = text.length > 0;
      else {
        if (pendingSpace) {
          text += " ";
          pendingSpace = false;
        }
        text += ch;
      }
    }
  }
  return { text, marks };
}

// Keep a UTF-16 boundary before an entire code point.
function splitEnd(text: string, end: number): number {
  const hi = text.charCodeAt(end - 1), lo = text.charCodeAt(end);
  return hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff ? end - 1 : end;
}

// Split an overlong paragraph at spaces. Every piece is an exact substring.
function splitBlock(b: Block): Block[] {
  if (b.text.length <= MAX_BLOCK) return [b];
  const out: Block[] = [];
  let start = 0;
  while (start < b.text.length) {
    let end = Math.min(start + MAX_BLOCK, b.text.length);
    if (end < b.text.length) {
      const sp = b.text.lastIndexOf(" ", end);
      if (sp > start + MAX_BLOCK / 2) end = sp;
    }
    end = splitEnd(b.text, end);
    const lo = start;
    const marks = b.marks.filter(([pos]) => (pos > lo || lo === 0) && pos <= end).map(([pos, n]) => [pos - lo, n] as [number, number]);
    out.push({ text: b.text.slice(start, end), marks });
    start = end;
    while (b.text[start] === " ") start++;
  }
  return out;
}

// What the agent sees for a block: the text with [n] markers after links.
export function shown(b: Block): string {
  let out = "";
  let last = 0;
  for (const [pos, n] of [...b.marks].sort((a, c) => a[0] - c[0])) {
    out += b.text.slice(last, pos) + ` [${n}]`;
    last = pos;
  }
  return out + b.text.slice(last);
}

class Builder {
  sections: Section[] = [];
  links: LinkItem[] = [];
  parts: (string | number)[] = [];
  private byUrl = new Map<string, number>();
  omitted = 0;
  private cur: Section | null = null;
  lists: { ordered: boolean; reversed?: boolean; n: number }[] = []; // W-22: the open lists, innermost last
  keepIndent = false;
  cells = 0; // cells seen in the current table row
  rowDepth = 0; // inside a table row (its cells' block elements do not end it) // a nested list item's leading indent survives the white-space collapse
  main: Set<N> | null = null; // W-22: the main content's element and its ancestors, when one was found
  inMain = new Set<N>(); // every node inside the main content element
  parentOf = new Map<N, N>();
  constructor(public shield: Shield, public base: string) {}
  // A preformatted block, kept exactly, fenced.
  // The pending marker of a list item, taken to lead a block written directly (a <pre>: round 79).
  // Outside an item, or for an item already led, the continuation indent (round 80).
  takeLoneMarker(): string {
    const item = this.items[this.items.length - 1];
    if (!this.loneMarker()) return item?.led ? item.indent : "";
    const m = this.parts.filter((p) => typeof p === "string").join("").replace(/\s+$/, ""); // nesting indent kept
    this.parts = [];
    this.marker = false;
    if (item) item.led = true;
    return m + " ";
  }
  // `indent` goes in front of EVERY line of the block, its fences included, so a <pre> inside a list item
  // stays inside it (Codex round 81); the first chunk starts with `lead` (the item's marker) instead.
  pre(raw: string, marks: [number, number][] = [], lead = "", indent = "") {
    if (!this.cur) this.startTop();
    for (let i = 0; i < raw.length; ) {
      const end = splitEnd(raw, Math.min(i + MAX_BLOCK, raw.length));
      const piece = raw.slice(i, end);
      // A fence longer than any run of backticks inside, so the text cannot close it (round 78).
      let run = 0;
      for (const m of piece.match(/`+/g) ?? []) run = Math.max(run, m.length);
      const fence = "`".repeat(Math.max(3, run + 1));
      const head = i === 0 && lead ? lead : indent;
      const body = indent ? piece.split("\n").map((l) => indent + l).join("\n") : piece;
      const m = marks
        .filter(([pos]) => pos > i && pos <= end)
        .map(([pos, n]) => {
          const p = pos - i;
          const lines = indent ? piece.slice(0, p).split("\n").length : 0; // lines up to the mark, each indented
          return [head.length + fence.length + 1 + p + indent.length * lines, n] as [number, number];
        });
      this.cur!.blocks.push({ text: `${head}${fence}\n${body}\n${indent}${fence}`, marks: m });
      this.shield.scan(piece, "visible text");
      i = end;
    }
  }

  // Text before the first heading goes under a label Tiresias makes, not text from the page: it gets no
  // receipt (v0.9 rehearsal: "(top of page)" was quoted as if the page said it).
  startTop() {
    this.start(0, "(top of page)");
    this.cur!.generated = true;
  }
  start(level: number, heading: string) {
    this.shield.scan(heading, "heading"); // headings are returned text too
    // The heading shown in the outline is bounded. The full text is not lost:
    // an overlong heading also becomes the section's first block, so it can
    // be expanded, searched and quoted.
    this.cur = { n: this.sections.length + 1, level, heading: heading.slice(0, MAX_HEADING), blocks: [] };
    if (heading.length > MAX_HEADING) this.cur.blocks.push(...splitBlock({ text: heading, marks: [] }));
    this.sections.push(this.cur);
  }
  marker = false; // a list item's marker was pushed and has not yet led any content
  private loneMarker(): boolean {
    return this.marker && !collapse(this.parts.filter((p) => typeof p === "string")).text.replace(/^\s*(-|-?\d+\.)\s*$/, "");
  }
  dropLoneMarker(): void {
    if (this.loneMarker()) this.parts = [];
    this.marker = false;
  }
  items: { indent: string; led: boolean }[] = []; // open list items: their continuation indent (round 79)
  flush() {
    // A list marker alone is not a block: it stays to lead the item's first content (Codex round 78).
    if (this.loneMarker()) return;
    const leading = this.marker;
    this.marker = false;
    const item = this.items[this.items.length - 1];
    let indent = this.keepIndent && typeof this.parts[0] === "string" ? /^ */.exec(this.parts[0] as string)![0] : "";
    // A later block of the same item is indented under its marker, so it stays part of the item.
    if (item && !leading && item.led && !indent) indent = item.indent;
    if (item && leading) item.led = true;
    this.keepIndent = false;
    const b = collapse(this.parts);
    if (indent && b.text) {
      b.text = indent + b.text;
      b.marks = b.marks.map(([pos, n]) => [pos + indent.length, n] as [number, number]);
    }
    this.parts = [];
    if (!b.text) return;
    if (!this.cur) this.startTop();
    // Every piece of a long block in a list item stays under the item (round 82): the pieces after the
    // first get the item's continuation indent.
    const pieces = splitBlock(b);
    const cont = item ? item.indent : "";
    this.cur!.blocks.push(
      ...pieces.map((pc, k) =>
        k > 0 && cont ? { text: cont + pc.text, marks: pc.marks.map(([pos, n]) => [pos + cont.length, n] as [number, number]) } : pc,
      ),
    );
    this.shield.scan(b.text, "visible text");
  }
  takeHeading(): string {
    const t = collapse(this.parts.filter((p) => typeof p === "string")).text;
    this.parts = [];
    // A heading that took a pending list marker leads its item (round 83).
    if (this.marker) {
      this.marker = false;
      const item = this.items[this.items.length - 1];
      if (item) item.led = true;
    }
    return t;
  }
  // A parent item whose first content is a nested list: its marker is written as its own line, and the
  // item counts as led, so its later content is indented under it (round 83).
  flushLoneMarker(): void {
    if (!this.loneMarker()) return;
    const m = this.parts.filter((p) => typeof p === "string").join("").replace(/\s+$/, "");
    this.parts = [];
    this.marker = false;
    const item = this.items[this.items.length - 1];
    if (item) item.led = true;
    if (!this.cur) this.startTop();
    this.cur!.blocks.push({ text: m, marks: [] });
  }
  // Returns the link number, or 0 if it is not a followable link or the cap is hit.
  link(href: string | undefined, text: string): number {
    if (!href) return 0;
    let u: URL;
    try {
      u = new URL(href.trim(), this.base);
    } catch {
      return 0;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return 0;
    u.hash = "";
    if (u.href.length > MAX_URL) {
      this.omitted++; // a shortened URL is a different destination, so it is left out and counted
      return 0;
    }
    const known = this.byUrl.get(u.href);
    if (known) return known;
    if (this.links.length >= MAX_LINKS) return 0;
    const n = this.links.length + 1;
    const label = snippet(text, 0, 80);
    this.shield.scan(label, "link text");
    this.links.push({ n, url: u.href, text: label });
    this.byUrl.set(u.href, n);
    return n;
  }
}

// Visible text of a node (same hidden/skip rules as the main walk), capped.
function visibleText(root: N, cap = 300, sheet?: HiddenSheet): string {
  let out = "";
  const stack: N[] = [root];
  let seen = 0;
  while (stack.length && out.length < cap && seen++ < 2000) {
    const n = stack.pop()!;
    if (n.type === "text") out += (n.data ?? "") + " ";
    else if (n.type === "tag" && (SKIP.has(n.name!) || hiddenReason(n.attribs ?? {}, sheet))) continue;
    else if (n.children) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  return out;
}

// The text of a <pre>, white space kept, under the SAME rules as the main walk (Codex round 69): elements
// that are not rendered are skipped, hidden ones are flagged and left out, and <br> is a line break.
// Links inside it are collected like anywhere else and get their [n] marker (Codex round 76).
function preText(root: N, b: Builder, cap: number, marks: [number, number][] = []): string {
  let out = "";
  // quiet: inside boilerplate (nav, footer, aside, an advert...): its text is left out as in the main walk,
  // its links are still collected (Codex round 93: a <pre> brought suppressed text back).
  type It = { n: N; quiet: boolean } | { mark: number };
  const stack: It[] = [...(root.children ?? [])].reverse().map((n) => ({ n, quiet: false }));
  let seen = 0;
  while (stack.length && out.length < cap) {
    const item = stack.pop()!;
    if ("mark" in item) {
      marks.push([out.length, item.mark]); // a link marker is not a node: it does not count (Codex round 91)
      continue;
    }
    // Backstop (restored after Codex round 93): past the node limit the page is refused as too complex,
    // never cut without notice. chooseMain does not enter boilerplate, so it does not count all of these.
    if (++seen > MAX_NODES) throw new ComplexityError();
    const { n } = item;
    let quiet = item.quiet;
    if (n.type === "text") {
      if (!quiet) out += n.data ?? "";
      continue;
    }
    if (n.type === "comment") {
      b.shield.comment(n.data ?? "");
      continue;
    }
    if (n.type !== "tag" && n.type !== "script" && n.type !== "style") continue;
    if (SKIP.has(n.name!)) continue;
    const attribs = n.attribs ?? {};
    const why = hiddenReason(attribs, b.shield.sheet);
    if (why) {
      const txt = norm(rawText(n));
      if (txt) b.shield.hidden(why, txt);
      continue;
    }
    if (QUIET.has(n.name!) || boilerplate(attribs)) quiet = true;
    if (n.name === "br" && !quiet) out += "\n";
    if (n.name === "a") {
      const num = b.link(attribs.href, visibleText(n, 300, b.shield.sheet));
      if (num && !quiet) stack.push({ mark: num });
    }
    for (let i = (n.children ?? []).length - 1; i >= 0; i--) stack.push({ n: n.children![i], quiet });
  }
  return out;
}

function rawText(root: N, cap = 5000): string {
  let out = "";
  const stack: N[] = [root];
  let seen = 0;
  while (stack.length && out.length < cap && seen++ < MAX_NODES) {
    const n = stack.pop()!;
    if (n.type === "text") out += (n.data ?? "") + " ";
    else if (n.children) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  return out;
}

type Task = { n: N; quiet: boolean } | (() => void);

function pushChildren(stack: Task[], n: N, quiet: boolean) {
  const ch = n.children ?? [];
  for (let i = ch.length - 1; i >= 0; i--) stack.push({ n: ch[i], quiet });
}

function walk(root: N, b: Builder): void {
  const stack: Task[] = [{ n: root, quiet: false }];
  let count = 0;
  while (stack.length) {
    const t = stack.pop()!;
    if (typeof t === "function") {
      t();
      continue;
    }
    if (++count > MAX_NODES) throw new ComplexityError();
    const { n } = t;
    let quiet = t.quiet;
    if (n.type === "text") {
      // A "|" inside a table cell is escaped, so only Tiresias's own separators split cells (round 78).
      if (!quiet) b.parts.push(b.rowDepth > 0 ? (n.data ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|") : n.data ?? "");
      continue;
    }
    if (n.type === "comment") {
      b.shield.comment(n.data ?? "");
      continue;
    }
    if (n.type !== "tag" && n.type !== "script" && n.type !== "style") {
      pushChildren(stack, n, quiet); // document root
      continue;
    }
    const name = n.name!;
    const attribs = n.attribs ?? {};
    const why = hiddenReason(attribs, b.shield.sheet);
    if (why) {
      const txt = norm(rawText(n));
      if (txt) b.shield.hidden(why, txt);
      continue;
    }
    for (const a of ["alt", "title"]) if (attribs[a]) b.shield.scan(attribs[a], `${a} attribute`);
    if (name === "script" || SKIP.has(name)) continue;
    if (QUIET.has(name) || boilerplate(attribs) || (b.main !== null && !b.main.has(n) && !b.inMain.has(n))) quiet = true;
    // Inside a table row, block elements (paragraphs, lists, headings, pre, nested rows) do not end the
    // row: their text joins the cell (Codex round 76).
    const inRow = b.rowDepth > 0;
    if (!quiet && !inRow && name === "pre") {
      // W-22: preformatted text keeps its white space, fenced like markdown code.
      b.flush();
      // No cut of its own (Codex round 73): the page's own size caps bound it, and pre() splits it into blocks.
      const marks: [number, number][] = [];
      const full = preText(n, b, Infinity, marks);
      let lead = 0;
      while (full.charCodeAt(lead) === 10) lead++; // leading newlines, linearly (Codex round 75: the old regex was quadratic)
      const raw = full.slice(lead).trimEnd();
      const itemIndent = b.items.length ? b.items[b.items.length - 1].indent : "";
      if (raw.trim()) b.pre(raw, marks.map(([pos, num]) => [Math.min(pos - lead, raw.length), num] as [number, number]), b.takeLoneMarker(), itemIndent);
      continue;
    }
    if (!quiet && (name === "ul" || name === "ol")) {
      const reversed = name === "ol" && "reversed" in attribs;
      const count = (n.children ?? []).filter((c) => c.type === "tag" && c.name === "li").length;
      const st = Number.parseInt(attribs.start ?? "", 10);
      b.lists.push({ ordered: name === "ol", reversed, n: Number.isNaN(st) ? (reversed ? count : 1) : st }); // start="0" is kept (round 78)
      stack.push(() => void b.lists.pop());
    }
    if (!quiet && !inRow && name === "li") {
      b.flushLoneMarker(); // a parent item that starts with a nested list keeps its marker (round 83)
      b.flush();
      const l = b.lists[b.lists.length - 1];
      const depth = Math.min(MAX_LIST_INDENT, Math.max(0, b.lists.length - 1));
      // An item's own value sets its number; a reversed list counts down (Codex round 79).
      const value = Number.parseInt(attribs.value ?? "", 10);
      if (l?.ordered && !Number.isNaN(value)) l.n = value;
      const mark = l?.ordered ? `${l.reversed ? l.n-- : l.n++}. ` : "- ";
      // A nested item starts under its parent item's text, whatever the parent marker's width (round 81).
      const prefix = b.items.length ? b.items[Math.min(b.items.length, MAX_LIST_INDENT) - 1].indent : "  ".repeat(depth);
      b.parts.push(prefix + mark);
      b.keepIndent = prefix.length > 0;
      b.marker = true; // the marker waits for the item's first content (round 78)
      const indent = b.items.length >= MAX_LIST_INDENT ? prefix : prefix + " ".repeat(mark.length);
      b.items.push({ indent, led: false }); // under the marker's text (round 80), up to eight levels
      stack.push(() => {
        b.dropLoneMarker(); // an empty item: no lone bullet
        b.flush();
        b.items.pop();
      });
      pushChildren(stack, n, quiet);
      continue;
    }
    if (!quiet && !inRow && name === "tr") {
      // W-22: a table row is one block, its cells separated by " | ".
      b.flush();
      b.parts.push("| ");
      b.cells = 0;
      b.rowDepth++;
      stack.push(() => {
        b.rowDepth--;
        b.parts.push(" |");
        b.flush();
      });
      pushChildren(stack, n, quiet);
      continue;
    }
    if (!quiet && inRow && name === "tr") {
      // a row of a table inside a cell: its cells join the outer cell, never the outer columns (round 79)
      b.rowDepth++;
      b.parts.push(" ");
      stack.push(() => {
        b.rowDepth--;
        b.parts.push(" ");
      });
      pushChildren(stack, n, quiet);
      continue;
    }
    if (!quiet && b.rowDepth > 1 && (name === "td" || name === "th")) {
      b.parts.push(" ");
      pushChildren(stack, n, quiet);
      continue;
    }
    if (!quiet && b.rowDepth === 1 && (name === "td" || name === "th")) {
      if (b.cells++ > 0) b.parts.push(" | ");
      pushChildren(stack, n, quiet);
      continue;
    }
    if (!quiet && !inRow && /^h[1-6]$/.test(name)) {
      b.flush();
      const level = Number(name[1]);
      stack.push(() => {
        const heading = b.takeHeading();
        if (heading) b.start(level, heading);
      });
      pushChildren(stack, n, quiet);
      continue;
    }
    if (name === "a") {
      const num = b.link(attribs.href, visibleText(n, 300, b.shield.sheet));
      if (num && !quiet) stack.push(() => b.parts.push(num));
      pushChildren(stack, n, quiet);
      continue;
    }
    const block = BLOCK.has(name) && !quiet;
    if (block && inRow) {
      // a space keeps words apart; the row stays one block
      b.parts.push(" ");
      stack.push(() => b.parts.push(" "));
    } else if (block) {
      b.flush();
      stack.push(() => b.flush());
    }
    pushChildren(stack, n, quiet);
  }
}

// W-22 (v0.5.1): main-content scoring, in-house (no library). Every element's visible text and link text
// are summed in one pass from the leaves up. The main content is a <main> (or role=main) element with real
// text; else the <article> with the most text; else the container whose text, less its link text, is
// largest, when it holds most of the page's text. Text outside it is dropped (its links are kept), as
// for nav and footer. A page with no clear main part is read whole, as before.
// What the scoring never counts (Codex round 69): what is not rendered, what is hidden (the same rules as
// the walk, the page's own style rules included), and boilerplate. So invisible filler cannot win.
const unscored = (n: N, b: Builder): boolean =>
  (n.type === "tag" || n.type === "script" || n.type === "style") &&
  (SKIP.has(n.name!) || n.name === "script" || QUIET.has(n.name!) || boilerplate(n.attribs ?? {}) || hiddenReason(n.attribs ?? {}, b.shield.sheet) !== null);

function chooseMain(root: N, b: Builder): void {
  const text = new Map<N, number>();
  const link = new Map<N, number>();
  const order: N[] = [];
  const stack: N[] = [root];
  let count = 0;
  while (stack.length) {
    const n = stack.pop()!;
    if (++count > MAX_NODES) throw new ComplexityError();
    order.push(n);
    if (unscored(n, b)) continue;
    for (const c of n.children ?? []) {
      b.parentOf.set(c, n);
      stack.push(c);
    }
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i];
    let t = n.type === "text" ? norm(n.data ?? "").length : 0;
    let l = 0;
    if (unscored(n, b)) t = 0;
    else for (const c of n.children ?? []) {
      t += text.get(c) ?? 0;
      l += link.get(c) ?? 0;
    }
    if (n.name === "a") l = t;
    text.set(n, t);
    link.set(n, l);
  }
  const total = text.get(root) ?? 0;
  if (total < 500) return;
  let best: N | null = null;
  const tags = order.filter((n) => n.type === "tag" && !unscored(n, b) && (text.get(n) ?? 0) > 0);
  const mains = tags.filter((n) => n.name === "main" || (n.attribs?.role ?? "").toLowerCase() === "main");
  const articles = tags.filter((n) => n.name === "article");
  if (mains.length === 1 && (text.get(mains[0]) ?? 0) >= 200) best = mains[0];
  else if (articles.length) {
    const top = articles.reduce((a, c) => ((text.get(c) ?? 0) > (text.get(a) ?? 0) ? c : a));
    if ((text.get(top) ?? 0) >= 200) best = top;
  }
  if (!best) {
    let score = 0;
    for (const n of tags) {
      if (!["div", "section", "td"].includes(n.name!)) continue;
      const t = text.get(n) ?? 0;
      const s = t - 2 * (link.get(n) ?? 0);
      if (s > score) (score = s), (best = n);
    }
    // A wrapper around everything scores highest; go down to the tightest container that still holds
    // nearly all (85%) of the winner's score.
    const sc = (n: N) => (text.get(n) ?? 0) - 2 * (link.get(n) ?? 0);
    for (let moved = true, k = 0; best && moved && k < 1000; k++) {
      moved = false;
      const desc: N[] = [...(best.children ?? [])];
      while (desc.length) {
        const c = desc.pop()!;
        if (c.type !== "tag") continue;
        if (["div", "section", "td"].includes(c.name!) && sc(c) >= score * 0.85) {
          best = c;
          moved = true;
          break;
        }
        if (!["div", "section", "td"].includes(c.name!)) for (const g of c.children ?? []) desc.push(g);
      }
    }
    // Only a clear winner: it must hold at least half of the page's text.
    if (best && (text.get(best) ?? 0) < total * 0.5) best = null;
  }
  if (!best) return;
  const keep = new Set<N>();
  for (let p: N | undefined = best; p; p = b.parentOf.get(p)) keep.add(p);
  b.main = keep;
  const st: N[] = [best];
  while (st.length) {
    const n = st.pop()!;
    b.inMain.add(n);
    for (const c of n.children ?? []) st.push(c);
  }
}

interface Found {
  title?: N;
  base?: N;
  ld: N[];
  links: N[];
  metas: N[];
  lang?: string;
  time?: string; // the first <time datetime>
  byline?: N; // the first rel=author link or byline element
}

function scanHead(root: N): Found {
  const found: Found = { ld: [], links: [], metas: [] };
  const stack: N[] = [root];
  let count = 0;
  while (stack.length) {
    const n = stack.pop()!;
    if (++count > MAX_NODES) throw new ComplexityError();
    if (n.name === "title" && !found.title) found.title = n;
    else if (n.name === "script" && /ld\+json/i.test(n.attribs?.type ?? "")) found.ld.push(n);
    else if (n.name === "base" && !found.base && n.attribs?.href !== undefined) found.base = n;
    else if (n.name === "link") found.links.push(n);
    else if (n.name === "meta" && found.metas.length < 200) found.metas.push(n);
    else if (n.name === "html" && n.attribs?.lang && !found.lang) found.lang = n.attribs.lang;
    else if (n.name === "time" && n.attribs?.datetime && !found.time) found.time = n.attribs.datetime;
    if (!found.byline && n.type === "tag" && (/(^|\s)author(\s|$)/i.test(n.attribs?.rel ?? "") || /(^|[\s_-])(byline|author)([\s_-]|$)/i.test(n.attribs?.class ?? ""))) found.byline = n;
    if (n.children) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  return found;
}

// W-22: the page's own metadata, bounded (text 300 characters; URLs kept whole up to MAX_URL or left out).
function pageMeta(f: Found, baseUrl: string): PageMeta | undefined {
  const m: PageMeta = {};
  const txt = (v?: string) => (v ? norm(v).slice(0, 300) || undefined : undefined);
  const url = (v?: string) => {
    if (!v) return undefined;
    try {
      const u = new URL(v.trim(), baseUrl);
      return (u.protocol === "https:" || u.protocol === "http:") && u.href.length <= MAX_URL ? u.href : undefined;
    } catch {
      return undefined;
    }
  };
  const byName = new Map<string, string>();
  for (const n of f.metas) {
    const k = (n.attribs?.property ?? n.attribs?.name ?? "").toLowerCase();
    const c = n.attribs?.content;
    if (k && typeof c === "string" && !byName.has(k)) byName.set(k, c);
  }
  m.lang = f.lang ? f.lang.slice(0, 35) : undefined;
  const can = f.links.find((l) => (l.attribs?.rel ?? "").toLowerCase().split(/\s+/).includes("canonical"));
  m.canonical = url(can?.attribs?.href);
  m.byline = txt(byName.get("author") ?? byName.get("article:author") ?? (f.byline ? rawText(f.byline, 300) : undefined));
  m.published = txt(byName.get("article:published_time") ?? byName.get("date") ?? f.time)?.slice(0, 40);
  m.modified = txt(byName.get("article:modified_time"))?.slice(0, 40);
  m.description = txt(byName.get("description"));
  const og = { title: txt(byName.get("og:title")), description: txt(byName.get("og:description")), type: txt(byName.get("og:type"))?.slice(0, 40), site_name: txt(byName.get("og:site_name")), image: url(byName.get("og:image")), url: url(byName.get("og:url")) };
  if (Object.values(og).some((v) => v !== undefined)) m.og = JSON.parse(JSON.stringify(og));
  const out = JSON.parse(JSON.stringify(m)) as PageMeta;
  return Object.keys(out).length ? out : undefined;
}

const typeOf = (x: unknown): string[] => {
  const t = (x as { "@type"?: unknown } | null)?.["@type"];
  return typeof t === "string" ? [t] : Array.isArray(t) ? t.filter((y): y is string => typeof y === "string") : [];
};

function finish(b: Builder, base: Partial<ParsedPage>): ParsedPage {
  b.flush();
  const text_chars = b.sections.reduce((n, s) => n + s.heading.length + s.blocks.reduce((m, x) => m + x.text.length, 0), 0);
  return {
    title: "", structured_count: 0, structured_types: [], feeds: [], service_desc: [],
    ...base, sections: b.sections, links: b.links, links_omitted: b.omitted || undefined, flags: b.shield.flags, flags_dropped: b.shield.droppedOrNone(), text_chars, searchable_chars: text_chars,
  };
}

// Raw text sliced into exact pieces, so quotes from it are real substrings.
// v0.5.1 (W-02): pretty-printed JSON (and JSON-LD) as blocks of whole LINES, so one inserted value changes
// one block in a diff instead of every fixed 4,000-character slice after it. Up to MAX_LINE_BLOCKS lines,
// one line per block; past that, runs of lines that end where a line's own content says so (a cheap hash
// of the line), so a change still only moves the blocks around it. A line longer than MAX_BLOCK is cut.
// Each block is an exact piece of the text, so a quote of it is a real substring.
const MAX_LINE_BLOCKS = 5000;
export function lineBlocks(text: string): Block[] {
  // Lines as [start, end) offsets into the text, so every block is an exact slice of it (Codex round 75:
  // joining kept lines with "\n" dropped the blank lines between them and made quotes that are not in
  // the text).
  const lines: [number, number][] = [];
  for (let i = 0; i < text.length; ) {
    let j = text.indexOf("\n", i);
    if (j === -1) j = text.length;
    for (let k = i; k < j; ) {
      const e = splitEnd(text, Math.min(j, k + MAX_BLOCK));
      if (text.slice(k, e).trim()) lines.push([k, e]);
      k = e;
    }
    i = j + 1;
  }
  if (lines.length <= MAX_LINE_BLOCKS) return lines.map(([a, b]) => ({ text: text.slice(a, b), marks: [] }));
  const out: Block[] = [];
  let start = -1;
  let end = -1;
  const cut = (l: string) => {
    let h = 0;
    for (let i = 0; i < l.length; i++) h = (h * 31 + l.charCodeAt(i)) | 0;
    return (h & 31) === 0;
  };
  for (const [a, b] of lines) {
    if (start === -1) start = a;
    else if (b - start > MAX_BLOCK) {
      out.push({ text: text.slice(start, end), marks: [] }); // a run never grows past MAX_BLOCK
      start = a;
    }
    end = b;
    if (cut(text.slice(a, b))) {
      out.push({ text: text.slice(start, end), marks: [] });
      start = -1;
    }
  }
  if (start !== -1) out.push({ text: text.slice(start, end), marks: [] });
  return out;
}

function rawBlocks(text: string): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < text.length; ) {
    const end = splitEnd(text, Math.min(i + MAX_BLOCK, text.length));
    out.push({ text: text.slice(i, end), marks: [] });
    i = end;
  }
  return out;
}

// `keep`, when given, receives the forms WITH their hidden values (W-04 preview and submit only).
// The parsed page itself, which may be cached, holds only the public listing.
// `rendered` (v0.7 track 2): the HTML of a rendered page whose hidden elements the browser marked (inspect.ts).
export function parseHtml(html: string, baseUrl: string, keep?: { forms?: FullForm[] }, rendered?: { mark: string; complete: boolean }): ParsedPage {
  const tree = parseDocument(html);
  const doc = tree.doc as unknown as N;
  const shield = new Shield();
  shield.sheet = pageSheet(doc);
  if (rendered && /^data-t-[0-9a-f]{16}$/.test(rendered.mark)) shield.sheet.rendered = { mark: rendered.mark, complete: rendered.complete === true };
  if (tree.flattened) {
    shield.sheet.inherited = new WeakMap();
    const reasons = new WeakMap<Record<string, string>, string | null>();
    for (const [attrs, parent] of tree.inherited) {
      let why = reasons.get(parent);
      if (why === undefined) reasons.set(parent, why = hiddenReason(parent, shield.sheet));
      if (why) shield.sheet.inherited.set(attrs, why);
    }
  }
  const found = scanHead(doc);
  let linkBase = baseUrl;
  try {
    const base = new URL(found.base?.attribs?.href ?? "", baseUrl);
    if (base.protocol === "http:" || base.protocol === "https:") linkBase = base.href;
  } catch {
    // An unusable first base leaves links relative to the fetched page.
  }
  const b = new Builder(shield, linkBase);
  chooseMain(doc, b);
  walk(doc, b);
  b.flush();

  let title = found.title ? norm(rawText(found.title, MAX_TITLE * 2)).slice(0, MAX_TITLE) : "";
  if (!title) title = (b.sections.find((s) => s.level === 1)?.heading ?? "").slice(0, MAX_TITLE);
  shield.scan(title, "title");

  // Features of the page itself.
  const resolve = (h?: string) => {
    try {
      return h ? new URL(h, linkBase).href : null;
    } catch {
      return null;
    }
  };
  const feeds: string[] = [];
  const service_desc: string[] = [];
  for (const l of found.links) {
    const rel = (l.attribs?.rel ?? "").toLowerCase().split(/\s+/);
    const type = (l.attribs?.type ?? "").toLowerCase();
    const href = resolve(l.attribs?.href);
    if (!href) continue;
    if (rel.includes("alternate") && /(rss|atom)\+xml|feed\+json/.test(type)) feeds.push(href);
    if (rel.includes("service-desc")) service_desc.push(href);
  }

  const page = finish(b, { title, feeds, service_desc });
  page.meta = pageMeta(found, linkBase);
  for (const v of [page.meta?.byline, page.meta?.description, page.meta?.og?.title, page.meta?.og?.description]) if (v) shield.scan(v, "page metadata");

  // Structured data (JSON-LD) becomes its own numbered section, so it can be
  // expanded, searched and quoted like any other part of the page. It is
  // parsed, never executed, and phrases inside it are flagged.
  const types = new Set<string>();
  const rawParts: string[] = [];
  let used = 0;
  const skipped = { invalid: 0, too_large: 0 };
  for (const s of found.ld) {
    const raw = rawText(s, MAX_STRUCTURED).trim();
    if (!raw) continue;
    if (used + raw.length > MAX_STRUCTURED) {
      skipped.too_large++; // reported with a reason, not silent
      continue;
    }
    try {
      const data = JSON.parse(raw) as unknown;
      for (const it of Array.isArray(data) ? data : [data]) typeOf(it).forEach((t) => types.add(t));
      shield.scan(raw, "JSON-LD");
      // Pretty-printed, one value per line, so a diff is by line even when the page minifies it (Codex
      // round 77); kept raw when the printed form would pass the structured-data cap.
      // The bounded printer stops at the remaining budget (Codex round 78: printing whole first could use
      // far more memory than the cap); a print that does not fit whole keeps the raw text.
      let pretty = raw;
      try {
        const p = boundedPretty(data, Math.max(0, MAX_STRUCTURED - used));
        if (!p.omitted && p.exact) pretty = p.text;
      } catch {
        // keep raw
      }
      rawParts.push(pretty);
      used += pretty.length;
    } catch {
      skipped.invalid++; // bad JSON-LD is common; it is counted so the omission is visible
    }
  }
  page.structured_count = rawParts.length;
  page.structured_types = [...types].slice(0, 20).map((t) => t.slice(0, 100));
  page.searchable_chars += used;
  page.structured_skipped = skipped.invalid || skipped.too_large ? skipped : undefined;
  if (rawParts.length) {
    page.sections.push({ n: page.sections.length + 1, level: 0, heading: "(structured data)", generated: true, blocks: rawParts.flatMap(lineBlocks) });
  }
  // W-04: the page's forms, as fields. Labels and option texts are returned text, so the shield reads them.
  const fx = extractForms(doc, baseUrl, tree.flattened);
  if (fx.forms.length || fx.omitted) {
    page.forms = fx.forms.map(publicForm);
    if (fx.omitted) page.forms_omitted = fx.omitted;
    for (const f of page.forms)
      for (const x of f.fields) {
        if (x.label) shield.scan(x.label, "form label");
        for (const o of x.options ?? []) if (o.label) shield.scan(o.label, "form option");
      }
  }
  if (keep) keep.forms = fx.forms;
  page.flags = shield.flags;
  page.flags_dropped = shield.droppedOrNone();
  return page;
}

// W-20: an SVG image, never drawn. Read like HTML (element text only; scripts and styles dropped; hidden
// text and AI-directed phrases flagged by the same shield), with the svg flag. Every element whose local
// name is script, style or foreignObject is removed first, whatever its namespace prefix or case. The <svg> element itself is
// on HTML's skip list, so the walk starts inside it. Forms are never listed from an image.
// An element's local name: lower case, any namespace prefix dropped ("s:Script" is "script").
const localName = (n: N) => (n.name ?? "").toLowerCase().split(":").pop()!;
// Never read from an SVG, whatever their prefix or case (coordinator, 2026-10-20, after Codex round 67).
const SVG_DROP = new Set(["script", "style", "foreignobject"]);
function pruneSvg(root: N): void {
  const stack: N[] = [root];
  let count = 0;
  while (stack.length) {
    const n = stack.pop()!;
    if (++count > MAX_NODES) throw new ComplexityError();
    if (!n.children) continue;
    n.children = n.children.filter((c) => !(c.type !== "text" && c.type !== "comment" && SVG_DROP.has(localName(c))));
    for (const c of n.children) stack.push(c);
  }
}

export function parseSvg(body: string, baseUrl: string): ParsedPage {
  const doc = parseDocument(body).doc as unknown as N;
  pruneSvg(doc);
  const shield = new Shield();
  const b = new Builder(shield, baseUrl);
  const inner: N[] = [];
  for (const c of doc.children ?? []) {
    if (c.type === "tag" && localName(c) === "svg") {
      const why = hiddenReason(c.attribs ?? {});
      if (why) {
        const txt = norm(rawText(c));
        if (txt) shield.hidden(why, txt);
        continue;
      }
      inner.push(...(c.children ?? []));
    } else inner.push(c);
  }
  walk({ type: "root", children: inner }, b);
  b.flush();
  const found = scanHead(doc);
  const title = found.title ? norm(rawText(found.title, MAX_TITLE * 2)).slice(0, MAX_TITLE) : "";
  shield.scan(title, "title");
  const page = finish(b, { title });
  page.flags = [{ type: "svg", snippet: "", detail: FLAG_TEXT.svg }, ...shield.flags];
  page.flags_dropped = shield.droppedOrNone();
  return page;
}

// W-20: text that is read as it is, never as markdown or HTML: scripts, CSV, calendar and contact files.
// Lines are grouped into paragraphs (a blank line ends one), each an exact piece of the text, under one
// generated heading. Scripts are never run; CSV cells are counted, never changed; calendar and contact
// links are listed like page links and never followed.
export type PlainMode = "script" | "csv" | "calendar" | "contact";
const PLAIN_HEADING: Record<PlainMode, string> = { script: "(script)", csv: "(CSV)", calendar: "(calendar)", contact: "(contact)" };
export function parsePlain(text: string, baseUrl: string, mode: PlainMode): ParsedPage {
  const omitted = text.length > MAX_EXPANDED ? text.length - splitEnd(text, MAX_EXPANDED) : 0;
  if (omitted) text = text.slice(0, text.length - omitted);
  // Calendar and contact lines may be folded (a line break followed by a space or tab continues the line).
  if (mode === "calendar" || mode === "contact") text = text.replace(/\r?\n[ \t]/g, "");
  const shield = new Shield();
  const b = new Builder(shield, baseUrl);
  const blocks = pdfBlocks(text.replace(/\r\n?/g, "\n"));
  for (const x of blocks) shield.scan(x.text, "text");
  b.sections.push({ n: 1, level: 0, heading: PLAIN_HEADING[mode], generated: true, blocks });
  if (mode === "calendar" || mode === "contact") for (const u of bareUrls(text)) b.link(u, u);
  const page = finish(b, { text_omitted: omitted || undefined });
  if (mode === "calendar") calendarEvents(text, page, shield); // v0.6: the invite's events, structured (ics.ts)
  const own: Flag[] = [];
  if (mode === "csv") {
    const n = csvFormulas(text);
    if (n) {
      page.csv_formulas = n;
      own.push({ type: "csv_formulas", snippet: "", detail: FLAG_TEXT.csv_formulas });
    }
  } else own.push({ type: mode, snippet: "", detail: FLAG_TEXT[mode] });
  page.flags = [...own, ...shield.flags];
  page.flags_dropped = shield.droppedOrNone();
  return page;
}

// v0.6: a calendar's events (ics.ts), kept up to EVENTS_BUDGET bytes of JSON; the rest are counted. Every
// value is web text: the shield scans it, and it is shown only inside untrusted_content.
export const EVENTS_BUDGET = 30_000;
function calendarEvents(text: string, page: ParsedPage, shield: Shield): void {
  const { events, total, malformed } = parseEvents(text);
  const kept: CalEvent[] = [];
  let used = 0;
  for (const e of events) {
    // Every string of the event goes through the shield (Codex round 1), links included.
    for (const v of Object.values(e)) for (const x of Array.isArray(v) ? v : [v]) if (typeof x === "string" && x) shield.scan(x, "calendar event");
    const c = jsonBytes(e) + 1; // UTF-8 bytes, as every reply budget counts
    if (used + c > EVENTS_BUDGET) break;
    kept.push(e);
    used += c;
  }
  if (kept.length) page.events = kept;
  if (total > kept.length) page.events_omitted = total - kept.length;
  if (malformed) page.events_malformed = true;
}

// http(s) URLs written out in text, found with indexOf (linear). A URL ends at whitespace, a quote, an
// angle bracket or a backslash (an escape in calendar text).
function bareUrls(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (out.length < MAX_LINKS * 2) {
    const a = text.indexOf("http://", i);
    const c = text.indexOf("https://", i);
    const s = a === -1 ? c : c === -1 ? a : Math.min(a, c);
    if (s === -1) break;
    let e = s;
    while (e < text.length && !/[\s"'<>\\]/.test(text[e])) e++;
    out.push(text.slice(s, e).replace(/[.,;:)]+$/, ""));
    i = e;
  }
  return out;
}

// CSV cells that start like a formula: =, +, -, @, a tab or a carriage return (inside quotes, the first
// character after the quote). One linear pass; quoted fields may hold commas and line breaks. Records end
// at LF, CR or CRLF (Codex round 61: CR-only files), so outside quotes a carriage return ends a record.
export function csvFormulas(text: string): number {
  const risky = (ch: string | undefined) => ch === "=" || ch === "+" || ch === "-" || ch === "@" || ch === "\t" || ch === "\r";
  const sep = (ch: string | undefined) => ch === "," || ch === "\n" || ch === "\r";
  let n = 0;
  let i = 0;
  const len = text.length;
  while (i < len) {
    // at the start of a cell
    if (text[i] === '"') {
      if (risky(text[i + 1])) n++;
      i++;
      for (;;) {
        if (i >= len) return n;
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      // skip anything after the closing quote up to the separator
      while (i < len && !sep(text[i])) i++;
    } else {
      if (risky(text[i]) && text[i] !== "\r") n++;
      while (i < len && !sep(text[i])) i++;
    }
    if (text[i] === "\r" && text[i + 1] === "\n") i++; // CRLF is one separator
    if (i < len) i++; // the separator
  }
  return n;
}

// Comment removal and link scanning use indexOf, never lazy regex spans, so a
// hostile document cannot make them quadratic (see walls.ts).
function stripComments(text: string, onComment: (c: string) => void): string {
  let out = "";
  let i = 0;
  for (;;) {
    const s = text.indexOf("<!--", i);
    if (s === -1) return out + text.slice(i);
    const e = text.indexOf("-->", s + 4);
    if (e === -1) return out + text.slice(i);
    out += text.slice(i, s);
    onComment(text.slice(s + 4, e));
    i = e + 3;
  }
}

interface MdLink {
  start: number;
  end: number; // exclusive
  text: string;
  href: string;
}

// [text](url "title"), found in one linear pass. The next "]" and ")" are
// remembered, so a line of thousands of "[" does not rescan the line each time.
function scanMdLinks(line: string): MdLink[] {
  const out: MdLink[] = [];
  let i = 0;
  let close = -2;
  let paren = -2;
  while ((i = line.indexOf("[", i)) !== -1) {
    if (close < i) {
      close = line.indexOf("]", i);
      if (close === -1) break;
    }
    const textLen = close - i - 1;
    if (textLen >= 1 && textLen <= 300 && line[close + 1] === "(") {
      if (paren < close + 2) {
        paren = line.indexOf(")", close + 2);
        if (paren === -1) break;
      }
      // Any length: an oversized destination is still a link, so Builder.link counts it
      // as omitted instead of leaving the raw URL in the text.
      const inner = line.slice(close + 2, paren);
      const first = inner.search(/\s/);
      const href = first === -1 ? inner : inner.slice(0, first);
      if (href && first !== 0) {
        out.push({ start: i, end: paren + 1, text: line.slice(i + 1, close), href });
        i = paren + 1;
        continue;
      }
    }
    i++;
  }
  return out;
}

// "# Heading" with one to four #, then spaces, then the text (trailing # and spaces dropped).
function mdHeading(line: string): { level: number; text: string } | null {
  let n = 0;
  while (n < 5 && line[n] === "#") n++;
  if (n < 1 || n > 4 || !/\s/.test(line[n] ?? "")) return null;
  let text = line.slice(n).trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end--;
  const stripped = text.slice(0, end).trimEnd();
  text = stripped || text;
  return text ? { level: n, text } : null;
}

// Markdown and plain text (llms.txt, .md pages, text/plain).
export function parseMarkdown(text: string, baseUrl: string): ParsedPage {
  const shield = new Shield();
  const b = new Builder(shield, baseUrl);
  let title = "";
  // Find code before stripping comments or scanning links: everything in code is literal text.
  const prose = (raw: string) => {
    const clean = stripComments(raw, (c) => shield.comment(c));
    for (const line of clean.split("\n")) {
      const h = mdHeading(line);
      if (h) {
        b.flush();
        // Keep link text only. Spans and labels are collected and joined ONCE (no copying per link).
        const pieces: string[] = [];
        let at = 0;
        for (const l of scanMdLinks(h.text)) {
          pieces.push(h.text.slice(at, l.start), l.text);
          at = l.end;
        }
        pieces.push(h.text.slice(at));
        const heading = norm(pieces.join(""));
        if (!title && h.level === 1) title = heading.slice(0, MAX_TITLE);
        b.start(h.level, heading);
        continue;
      }
      if (!line.trim()) {
        b.flush();
        continue;
      }
      // [text](url): the text stays, the link gets a number shown beside it.
      let last = 0;
      for (const m of scanMdLinks(line)) {
        b.parts.push(line.slice(last, m.start), m.text);
        const n = b.link(m.href, m.text);
        if (n) b.parts.push(n);
        last = m.end;
      }
      b.parts.push(line.slice(last) + " ");
      if (/^\s*[-*]\s/.test(line)) b.flush(); // one list item per block
    }
  };
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let pending: string[] = [];
  const flushProse = () => { prose(pending.join("\n")); pending = []; b.flush(); };
  for (let i = 0; i < lines.length; ) {
    const fence = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    const indented = /^( {4}|\t)/.test(lines[i]) && (i === 0 || !lines[i - 1].trim());
    if (!fence && !indented) { pending.push(lines[i++]); continue; }
    flushProse();
    const code: string[] = [];
    if (fence) {
      const indent = new RegExp("^ {0," + fence[1].length + "}");
      i++;
      while (i < lines.length) {
        const end = /^ {0,3}(`+|~+)\s*$/.exec(lines[i]);
        if (end && end[1][0] === fence[2][0] && end[1].length >= fence[2].length) { i++; break; }
        // An indented opening fence removes at most that much indentation from its code lines.
        code.push(lines[i++].replace(indent, ""));
      }
    } else {
      while (i < lines.length && (!lines[i].trim() || /^( {4}|\t)/.test(lines[i]))) {
        code.push(lines[i++].replace(/^( {4}|\t)/, ""));
      }
      while (code.length && !code[code.length - 1].trim()) code.pop();
    }
    b.pre(code.join("\n"));
  }
  flushProse();
  shield.scan(title, "title");
  return finish(b, { title });
}

// Nesting deeper than this cannot fit under MAX_EXPANDED anyway (the indentation alone passes 5 MiB
// near depth 2,300). It only bounds the memory of the walk's own stack (a 5 MB document can nest
// 2.5 million levels), so past it the walk stops and the omitted count becomes a lower bound.
export const MAX_PRETTY_DEPTH = 100_000;

// JSON.stringify(value, null, 2), byte for byte, but it never builds more than `max` characters.
// It walks the value with an explicit stack (no recursion, so depth cannot overflow the stack) and
// keeps counting the length of what it does not write, so the omitted count is exact and costs
// arithmetic, not memory. Returns { text, omitted, exact }: `exact` is false only when the nesting
// passed MAX_PRETTY_DEPTH, and then `omitted` is a lower bound.
export function boundedPretty(root: unknown, max = MAX_EXPANDED): { text: string; omitted: number; exact: boolean } {
  const out: string[] = [];
  let used = 0; // characters kept
  let total = 0; // characters the full output would have
  const put = (piece: string) => {
    total += piece.length;
    if (used < max) {
      const keep = piece.length <= max - used ? piece : piece.slice(0, max - used);
      out.push(keep);
      used += keep.length;
    }
  };
  // A newline plus 2*depth spaces. Past the cap only the length is counted, never the string.
  const line = (depth: number) => {
    total += 1 + depth * 2;
    if (used < max) {
      const piece = "\n" + " ".repeat(Math.min(depth * 2, max - used));
      const keep = piece.slice(0, max - used);
      out.push(keep);
      used += keep.length;
    }
  };
  interface Frame {
    arr?: unknown[];
    obj?: Record<string, unknown>;
    keys?: string[];
    i: number;
    n: number;
    depth: number;
  }
  const stack: Frame[] = [];
  let exact = true;
  const value = (v: unknown, depth: number) => {
    if (typeof v !== "object" || v === null) return put(JSON.stringify(v) ?? "null");
    if (Array.isArray(v)) {
      if (v.length === 0) return put("[]");
      put("[");
      stack.push({ arr: v, i: 0, n: v.length, depth });
    } else {
      const keys = Object.keys(v);
      if (keys.length === 0) return put("{}");
      put("{");
      stack.push({ obj: v as Record<string, unknown>, keys, i: 0, n: keys.length, depth });
    }
  };
  value(root, 0);
  while (stack.length) {
    const f = stack[stack.length - 1];
    if (f.depth + 1 > MAX_PRETTY_DEPTH) {
      exact = false;
      break;
    }
    if (f.i < f.n) {
      if (f.i > 0) put(",");
      line(f.depth + 1);
      let child: unknown;
      if (f.arr) child = f.arr[f.i];
      else {
        const k = f.keys![f.i];
        put(JSON.stringify(k) + ": ");
        child = f.obj![k];
      }
      f.i++;
      value(child, f.depth + 1);
    } else {
      stack.pop();
      line(f.depth);
      put(f.arr ? "]" : "}");
    }
  }
  return { text: out.join(""), omitted: Math.max(0, total - max), exact };
}

export function parseJsonText(text: string, baseUrl: string): ParsedPage {
  let pretty = text;
  let omitted = 0;
  let exact = true;
  try {
    // A small nested document can expand to tens of MB. The printer stops writing at MAX_EXPANDED
    // characters and counts the rest, so the full expansion is never held in memory.
    const r = boundedPretty(JSON.parse(text));
    pretty = r.text;
    omitted = r.omitted;
    exact = r.exact;
  } catch {
    // keep raw
  }
  if (pretty.length > MAX_EXPANDED) {
    // raw text that is not JSON: keep the first MAX_EXPANDED characters and count the rest
    const end = splitEnd(pretty, MAX_EXPANDED);
    omitted = pretty.length - end;
    pretty = pretty.slice(0, end);
  }
  const shield = new Shield();
  shield.scan(pretty, "JSON body");
  const b = new Builder(shield, baseUrl);
  // Keep all of it (the fetch cap bounds the size); pages of it are read on request.
  b.sections.push({ n: 1, level: 0, heading: "(JSON)", generated: true, blocks: lineBlocks(pretty) });
  return finish(b, { text_omitted: omitted || undefined, text_omitted_at_least: omitted && !exact ? true : undefined });
}

// W-17: a PDF, as one section per page ("Page N", section N = page N) so a receipt's section is the page
// number. `pages` is the text of the pages that were read, in order. Only text is kept: no links, no
// attachments, no annotations. The page cap and the text cap are applied by the extractor, which says
// how many pages it left unread (`pagesOmitted`) and how many characters it cut (`cut`).
export function parsePdfText(
  pages: string[],
  meta: { title: string; pageCount: number; pagesOmitted: number; cut: number; cutIsLowerBound: boolean; hidden?: { page: number; reason: string; text: string }[] },
  baseUrl: string,
): ParsedPage {
  const shield = new Shield();
  // v0.5.1 N-02: text a person cannot see on the page (white, tiny or off the page), found from pdf.js
  // positions and fill colours; off-page text is not in the page text (pdf.js leaves it out), tiny and white text
  // stay in it; all three are flagged.
  for (const h of meta.hidden ?? []) shield.hidden(`PDF page ${h.page}: ${h.reason}`, h.text);
  const title = meta.title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  if (title) shield.scan(title, "title");
  const b = new Builder(shield, baseUrl);
  pages.forEach((text, i) => {
    shield.scan(text, `PDF page ${i + 1}`);
    b.sections.push({ n: i + 1, level: 1, heading: `Page ${i + 1}`, generated: true, blocks: pdfBlocks(text) });
  });
  return finish(b, {
    title,
    pdf_pages: meta.pageCount,
    pdf_pages_omitted: meta.pagesOmitted || undefined,
    text_omitted: meta.cut || undefined,
    text_omitted_at_least: meta.cut && meta.cutIsLowerBound ? true : undefined,
  });
}

// Lines of one page grouped into paragraphs (a blank line ends one), none longer than MAX_BLOCK.
// Each block is an exact piece of the extracted text, so a quote of it is a real substring.
function pdfBlocks(text: string): Block[] {
  const out: Block[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) out.push({ text: cur, marks: [] });
    cur = "";
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      flush();
      continue;
    }
    let l = line;
    while (l.length > MAX_BLOCK) {
      flush();
      const end = splitEnd(l, MAX_BLOCK);
      out.push({ text: l.slice(0, end), marks: [] });
      l = l.slice(end);
    }
    if (cur && cur.length + 1 + l.length > MAX_BLOCK) flush();
    cur = cur ? cur + "\n" + l : l;
  }
  flush();
  return out;
}

const STOP = new Set(
  "the a an and or of to in on for with is are was were be by at as it this that from what which who how when where why do does did can i you we they about".split(" "),
);
// W-22 (v0.5.1): words in any script (letters and digits of every alphabet, NFKC-normalized). Scripts
// written without spaces (Chinese, Japanese, Korean, Thai) are split into overlapping pairs of characters.
// Script EXTENSIONS, so marks shared by these scripts (the long-vowel mark "ー") count as theirs (round 79).
const NOSPACE = /^[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Thai}]+$/u;
const RUNS = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Thai}]+|[^\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Thai}]+/gu;
export const tokens = (s: string): string[] => {
  const out: string[] = [];
  // Each word is split into runs of no-space scripts and the rest, so "サーバー2台" still pairs its
  // Japanese (round 80).
  const words = (s.slice(0, 200_000).normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) ?? []).flatMap((w) => w.match(RUNS) ?? []);
  for (const w of words) {
    if (NOSPACE.test(w)) {
      // single characters too, so a one-character query finds its passage (round 81)
      // by code points, never UTF-16 units (Codex round 97: a character outside the BMP made half pairs)
      const cs = [...w];
      for (const ch of cs) out.push(ch);
      for (let i = 0; i + 1 < cs.length; i++) out.push(cs[i] + cs[i + 1]);
    } else if (w.length >= 2 && !STOP.has(w)) out.push(w);
  }
  return out;
};

export interface Passage {
  section: number;
  heading: string;
  text: string; // exact extracted text, at most MAX_BLOCK characters
  score: number;
}

// Plain keyword overlap. Honest and boring on purpose: no AI, no surprises.
export function topPassages(p: ParsedPage, question: string, k = 5): Passage[] {
  const q = new Set(tokens(question));
  if (!q.size) return [];
  const scored: Passage[] = [];
  for (const s of p.sections) {
    const headTokens = new Set(tokens(s.heading));
    for (const block of s.blocks) {
      const bt = new Set(tokens(block.text));
      let hits = 0;
      for (const t of q) if (bt.has(t)) hits++;
      for (const t of q) if (headTokens.has(t)) hits += 0.5; // a matching heading helps a little
      if (hits > 0) scored.push({ section: s.n, heading: s.heading, text: block.text, score: Math.round((hits / q.size) * 100) / 100 });
    }
  }
  return scored.sort((a, b) => b.score - a.score || a.section - b.section).slice(0, k);
}
