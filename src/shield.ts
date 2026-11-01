// SPDX-License-Identifier: Apache-2.0
// N-02: injection shield.
// Web pages can carry text meant for the AI that reads them, not for people:
// white-on-white text, display:none blocks, comments, "ignore previous
// instructions". We do three things: keep page content inside
// untrusted_content, leave hidden text OUT of the readable text, and report
// what we found in `flags` so the agent and its human can see the attempt.
import type { Flag } from "./types.js";
import { EN, otherMatches } from "./shieldphrases.js";
import { hiddenText } from "./inspect.js";

// v0.7 (W-26): the English list moved to shieldphrases.ts with the twelve other languages.
const AI_PHRASES: RegExp[] = EN;

// v0.5.1: a cap PER flag type (30 HTML comments must not push out a real injection flag), and the
// number dropped past it, per type (`flags_dropped`).
export const MAX_FLAGS = 30;

// Elements whose contents a person never reads as page text. ONE list, used by the reader and by the
// wall check (Codex round 71: the wall check had its own shorter list and counted iframe fallback text).
export const NOT_RENDERED = new Set(["title", "script", "style", "noscript", "svg", "template", "iframe", "head", "object", "canvas", "select"]);

// Zero-width, bidirectional-control and Unicode "tag" characters: invisible to a person, readable by a
// model. Their presence is a flag of its own (invisible_characters); they are stripped before phrases
// are matched, and the text is NFKC-normalized, so "ｉｇｎｏｒｅ" or "ig\u200Bnore" match like "ignore".
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/u;
const INVISIBLE_ALL = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu;
const MAX_SCAN = 200_000; // characters of one text normalized for matching (bounded work)
export const normalizeForMatch = (s: string): string => s.slice(0, MAX_SCAN).normalize("NFKC").replace(INVISIBLE_ALL, "");

export function snippet(s: string, around = 0, len = 120): string {
  const t = s.replace(/\s+/g, " ").trim();
  const start = Math.max(0, around - 30);
  return (start > 0 ? "..." : "") + t.slice(start, start + len) + (t.length > start + len ? "..." : "");
}

export class Shield {
  flags: Flag[] = [];
  dropped: Partial<Record<Flag["type"], number>> = {};
  sheet: HiddenSheet = emptySheet(); // v0.5.1: the page's own <style> rules that hide a class or id
  // The counts of flags dropped past the per-type cap, or undefined when none were.
  droppedOrNone() {
    return Object.keys(this.dropped).length ? this.dropped : undefined;
  }
  private perType = new Map<string, number>();

  private add(f: Flag) {
    if (this.flags.some((x) => x.type === f.type && x.snippet === f.snippet)) return;
    const n = this.perType.get(f.type) ?? 0;
    if (n >= MAX_FLAGS) {
      this.dropped[f.type] = (this.dropped[f.type] ?? 0) + 1;
      return;
    }
    this.perType.set(f.type, n + 1);
    this.flags.push(f);
  }

  // Look for phrases aimed at an AI, on the normalized text. `where` says if the text was visible.
  scan(text: string, where: string): void {
    if (INVISIBLE.test(text.slice(0, MAX_SCAN))) this.add({ type: "invisible_characters", snippet: snippet(text.replace(INVISIBLE_ALL, "\u2423")), detail: where });
    const norm = normalizeForMatch(text);
    for (const re of AI_PHRASES) {
      const m = re.exec(norm);
      if (m) this.add({ type: "ai_directed_instruction", snippet: snippet(norm, m.index), detail: where });
    }
    // v0.7 (W-26): the same kind of phrase in the other twelve languages, in every language whose script the
    // text contains (shieldphrases.ts).
    for (const o of otherMatches(norm)) this.add({ type: "ai_directed_instruction", snippet: snippet(o.text, o.index), detail: `${where}; phrase in ${o.lang}` });
  }

  hidden(reason: string, text: string): void {
    this.add({ type: "hidden_text", snippet: snippet(text), detail: reason });
    this.scan(text, "hidden text");
  }

  comment(data: string): void {
    const t = data.trim();
    if (!t || /^\[if /i.test(t)) return; // empty and IE conditional comments are noise
    this.add({ type: "html_comment", snippet: snippet(t) });
    this.scan(t, "comment");
  }
}

// One declaration block, read the way the cascade reads it (Codex round 74): for each property, an
// !important declaration beats a normal one, and otherwise the later one wins. Values are lowercased,
// with "!important" taken off.
function parseDecls(style: string): Map<string, { value: string; important: boolean }> {
  const out = new Map<string, { value: string; important: boolean }>();
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":");
    if (i <= 0) continue;
    let v = decl.slice(i + 1).trim().toLowerCase();
    const k = v.indexOf("!important"); // linear: no regex over attacker-sized whitespace
    const important = k !== -1;
    if (important) v = v.slice(0, k).trimEnd();
    const prop = decl.slice(0, i).trim().toLowerCase();
    const prev = out.get(prop);
    if (!prev || !prev.important || important) out.set(prop, { value: v, important });
  }
  return out;
}
function importantProps(style: string): Set<string> {
  return new Set([...parseDecls(style)].filter(([, d]) => d.important).map(([k]) => k));
}
function parseStyle(style: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, d] of parseDecls(style)) out[k] = d.value;
  return out;
}

const px = (v?: string) => (v && /^-?[\d.]+(px|em|rem|vw|vh)?$/.test(v) ? parseFloat(v) : NaN);
const isWhiteish = (v?: string) =>
  !!v && /^(white|transparent|#fff|#ffffff|#fffffe?|rgba?\(\s*255\s*,\s*255\s*,\s*255\s*(,\s*[\d.]+\s*)?\)|rgba?\([^)]*,\s*0\s*\))$/.test(v.replace(/\s+/g, " ").trim());

// v0.5.1: the page's own <style> rules, read (never run) for the four ways a class or id can hide text:
// display:none, visibility:hidden, font-size:0, opacity:0. Only plain `.class` and `#id` selectors (alone
// or in a comma list) are used; anything more complex is left alone. Bounded: 256 KB of CSS, 5,000 rules.
// For each plain .class or #id selector, the last declaration of each of the four properties, with where
// it came (source order) and whether it was !important. An element's value for a property is decided
// across ALL its classes and its id, as the cascade does (Codex round 73): !important first, then an id
// over a class, then the later rule.
export interface Decl {
  hides: boolean;
  value: string;
  order: number;
  important: boolean;
}
export interface HiddenSheet {
  classes: Map<string, Map<string, Decl>>;
  ids: Map<string, Map<string, Decl>>;
  // Internal source ancestry retained when the DOM depth cap flattened an element.
  inherited?: WeakMap<Record<string, string>, string>;
  // v0.7 track 2: a rendered page whose hidden elements the browser marked (inspect.ts). `mark` is the attribute's
  // random name; `complete` false means some text was not judged, so the HTML guesses still apply to unmarked elements.
  rendered?: { mark: string; complete: boolean };
}
export const emptySheet = (): HiddenSheet => ({ classes: new Map(), ids: new Map() });
const MAX_CSS = 256 * 1024;
const HIDING_PROPS = ["display", "visibility", "font-size", "opacity"] as const;
// A CSS number, whole: "0", "0.0", ".0" (Codex round 73: "0garbage" is invalid CSS, which a browser
// ignores, so it hides nothing).
// The CSS number grammar, exponent included (round 74), written without overlapping repeats (round 80:
// "\d+\.?\d*" backtracked quadratically on a long run of digits ending in a letter).
const NUM = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i;
const propHides = (k: string, v: string): boolean =>
  k === "display" ? v === "none" : k === "visibility" ? v === "hidden" || v === "collapse" : k === "font-size" ? px(v) === 0 : k === "opacity" ? NUM.test(v) && Number(v) === 0 : false;
// Read in ORDER, as the cascade does (Codex round 72): for each plain .class or #id selector, each of the
// four properties keeps the value of the LAST rule that set it, so `.x{display:none} .x{display:block}`
// leaves .x visible. @-blocks (media queries and the like) are skipped whole, braces counted.
export function readStyleRules(css: string, into: HiddenSheet = emptySheet()): HiddenSheet {
  let s = css.slice(0, MAX_CSS);
  let out = "";
  for (let i = 0; i < s.length; ) {
    const j = s.indexOf("/*", i);
    if (j === -1) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, j);
    const k = s.indexOf("*/", j + 2);
    if (k === -1) break;
    i = k + 2;
  }
  s = out;
  let rules = 0;
  for (let i = 0; i < s.length && rules < 5000; rules++) {
    const open = s.indexOf("{", i);
    if (open === -1) break;
    const selector = s.slice(i, open).trim();
    if (selector.startsWith("@")) {
      // Skip the whole block, nested braces included.
      let depth = 1;
      let k = open + 1;
      for (; k < s.length && depth > 0; k++) {
        if (s[k] === "{") depth++;
        else if (s[k] === "}") depth--;
      }
      i = k;
      continue;
    }
    const close = s.indexOf("}", open + 1);
    if (close === -1) break;
    const body = s.slice(open + 1, close);
    const decl = parseStyle(body);
    const important = importantProps(body);
    // Each declaration judged ONCE, not once per selector (Codex round 83).
    const judged = new Map<string, Decl>();
    for (const k of HIDING_PROPS) if (decl[k] !== undefined) judged.set(k, { hides: propHides(k, decl[k]), value: decl[k].slice(0, 40), order: rules, important: important.has(k) });
    i = close + 1;
    if (!judged.size) continue;
    for (const sel of selector.split(",")) {
      const t = sel.trim();
      if (!/^[.#]-?[A-Za-z_][\w-]*$/.test(t)) continue;
      const map = t[0] === "." ? into.classes : into.ids;
      let st = map.get(t.slice(1));
      for (const [k, d] of judged) {
        if (!st) map.set(t.slice(1), (st = new Map()));
        const prev = st.get(k);
        if (!prev || !prev.important || d.important) st.set(k, d);
      }
    }
  }
  return into;
}

// The page's own style sheet, from its <style> elements, ONE way for the reader and the wall check
// (Codex round 72): a <style> inside <template> or <noscript> is inert, and one whose media is not for the
// screen (media="print") does not apply. Bounded: 256 KB of CSS, MAX_STYLE_NODES nodes.
interface SN {
  type: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: SN[];
  data?: string;
}
const INERT = new Set(["template", "noscript"]);
const screenMedia = (m?: string) => m === undefined || /^\s*(all|screen)?\s*$/i.test(m);
export function pageSheet(root: SN): HiddenSheet {
  let css = "";
  const stack: SN[] = [root];
  for (let seen = 0; stack.length && seen < 200_000 && css.length < MAX_CSS; seen++) {
    const n = stack.pop()!;
    const name = (n.name ?? "").toLowerCase();
    if (n.type === "style" || (n.type === "tag" && name === "style")) {
      if (screenMedia(n.attribs?.media)) for (const c of n.children ?? []) if (c.type === "text") css += (c.data ?? "") + "\n";
      continue;
    }
    if (INERT.has(name)) continue;
    for (let i = (n.children ?? []).length - 1; i >= 0; i--) stack.push(n.children![i]);
  }
  return css ? readStyleRules(css) : emptySheet();
}
// ---- The wall check's ALLOW-LIST (Codex rounds 69 to 75) ----
// Deciding what CSS hides is open-ended (each round found another way: invalid declarations, units,
// exponents, percentages, negative values, the cascade, limits). So the wall check does not try: it
// counts text only where NO style could plausibly hide it. An element is "plain" when it has no hidden
// or aria-hidden attribute, no inline style declaring anything outside SAFE_PROPS, and no class or id
// named by a page rule that declares anything outside SAFE_PROPS. If the page has such a rule with any
// other kind of selector (an element, *, an attribute, a pseudo-class), or more CSS than is read, then
// no text on the page is plain. Erring this way can only make a page look thinner (a false wall).
const SAFE_PROPS = /^(margin|padding|border|outline|font-family|font-weight|font-style|line-height|text-align|text-decoration|list-style|cursor|vertical-align|white-space|word-break|word-wrap|overflow-wrap|border-radius|box-shadow|box-sizing|transition|caret-color|accent-color)(-[a-z-]+)?$/;
export interface Taint {
  all: boolean; // no text can be trusted as visible
  names: Set<string>; // ".class" and "#id" named by a risky rule
}
const riskyDecls = (body: string): boolean => {
  for (const decl of body.split(";")) {
    const i = decl.indexOf(":");
    if (i <= 0) {
      if (decl.trim()) return true; // something that is not a plain declaration
      continue;
    }
    if (!SAFE_PROPS.test(decl.slice(0, i).trim().toLowerCase())) return true;
  }
  return false;
};
export function cssTaint(root: SN): Taint {
  const t: Taint = { all: false, names: new Set() };
  let css = "";
  const stack: SN[] = [root];
  let n = 0;
  for (; stack.length && n < 200_000; n++) {
    const x = stack.pop()!;
    const name = (x.name ?? "").toLowerCase();
    if (x.type === "style" || (x.type === "tag" && name === "style")) {
      for (const c of x.children ?? []) if (c.type === "text") css += (c.data ?? "") + "\n";
      continue; // every <style>, inert or not: counting only errs toward a wall
    }
    for (let i = (x.children ?? []).length - 1; i >= 0; i--) stack.push(x.children![i]);
  }
  if (stack.length || css.length > MAX_CSS) return { all: true, names: t.names };
  // Comments out, then every block: an @-block's inner rules are read as rules too (its selectors count).
  let s = "";
  for (let i = 0; i < css.length; ) {
    const j = css.indexOf("/*", i);
    if (j === -1) {
      s += css.slice(i);
      break;
    }
    s += css.slice(i, j);
    const k = css.indexOf("*/", j + 2);
    if (k === -1) break;
    i = k + 2;
  }
  let rules = 0;
  for (let i = 0; i < s.length; ) {
    if (++rules > 20_000) return { all: true, names: t.names };
    const close = s.indexOf("}", i);
    const open = s.indexOf("{", i);
    if (open === -1) break;
    if (close !== -1 && close < open) {
      i = close + 1; // the end of an @-block
      continue;
    }
    const nextOpen = s.indexOf("{", open + 1);
    const end = close === -1 ? s.length : close;
    const selector = s.slice(i, open).trim();
    if (nextOpen !== -1 && nextOpen < end) {
      i = open + 1; // an @-block opening: read its inner rules
      continue;
    }
    i = end + 1;
    if (selector.startsWith("@") || !riskyDecls(s.slice(open + 1, end))) continue;
    for (const sel of selector.split(",")) {
      const one = sel.trim();
      if (!/^([.#]-?[A-Za-z_][\w-]*)+$/.test(one)) {
        t.all = true; // an element, *, an attribute or a pseudo-class could reach any text
        continue;
      }
      for (const m of one.match(/[.#]-?[A-Za-z_][\w-]*/g) ?? []) t.names.add(m);
    }
  }
  return t;
}
export function plain(attribs: Record<string, string>, t: Taint): boolean {
  if (t.all || "hidden" in attribs || (attribs["aria-hidden"] ?? "").toLowerCase() === "true") return false;
  if (attribs.style !== undefined && riskyDecls(attribs.style)) return false;
  if (attribs.id !== undefined && t.names.has("#" + attribs.id)) return false;
  for (const c of (attribs.class ?? "").split(/\s+/)) if (c && (t.names.has("." + c) || SR_ONLY.has(c.toLowerCase()))) return false;
  return true;
}

// Class names that conventionally mean "for screen readers only" (hidden from sighted people).
const SR_ONLY = new Set(["sr-only", "visually-hidden", "visuallyhidden", "screen-reader-text", "screenreader-only", "sr-only-focusable", "a11y-hidden", "u-visually-hidden"]);

// Returns why an element is hidden from people, or null. Inline styles, the conventional screen-reader
// class names, and (v0.5.1) the page's own <style> rules for its classes and ids. We do not run CSS: a
// rule in an external stylesheet, or one with a complex selector, is still a known gap (see SPEC).
// clip: rect(top, right, bottom, left) hides everything only when the rectangle is empty (Codex round 73:
// "rect(0px,100px,100px,0px)" is a visible 100 by 100 box).
function emptyClip(v?: string): boolean {
  const m = v ? /^rect\(\s*([^,\s)]+)[\s,]+([^,\s)]+)[\s,]+([^,\s)]+)[\s,]+([^,\s)]+)\s*\)$/.exec(v) : null;
  if (!m) return false;
  const [t, r, b, l] = m.slice(1, 5).map((x) => px(x));
  return [t, r, b, l].every((x) => !Number.isNaN(x)) && (b <= t || r <= l);
}

export function hiddenReason(attribs: Record<string, string>, sheet?: HiddenSheet): string | null {
  const inherited = sheet?.inherited?.get(attribs);
  if (inherited) return inherited;
  // v0.7 track 2: on a rendered page the browser decided. Its mark is the answer; with every text node judged, an
  // unmarked element is shown, whatever its source looks like (the guesses below can be wrong both ways).
  if (sheet?.rendered) {
    const code = attribs[sheet.rendered.mark];
    if (code !== undefined) return hiddenText(code);
    if (sheet.rendered.complete) return null;
  }
  if ("hidden" in attribs) return "hidden attribute";
  if (attribs["aria-hidden"] === "true") return "aria-hidden";
  const cls = attribs.class ? attribs.class.split(/\s+/).slice(0, 50) : [];
  for (const c of cls) if (SR_ONLY.has(c.toLowerCase())) return `screen-reader-only class (${c.slice(0, 40)})`;
  if (sheet) {
    // Per property, the winning declaration across the element's classes and id; an inline style beats any
    // rule that is not !important.
    const inline = attribs.style ? parseStyle(attribs.style) : {};
    const inlineImportant = attribs.style ? importantProps(attribs.style) : new Set<string>();
    for (const k of HIDING_PROPS) {
      let win: (Decl & { sel: string; spec: number }) | null = null;
      const consider = (d: Decl | undefined, sel: string, spec: number) => {
        if (!d) return;
        if (!win || (d.important && !win.important) || (d.important === win.important && (spec > win.spec || (spec === win.spec && d.order > win.order)))) win = { ...d, sel, spec };
      };
      for (const c of cls) consider(sheet.classes.get(c)?.get(k), "." + c, 1);
      if (attribs.id) consider(sheet.ids.get(attribs.id)?.get(k), "#" + attribs.id, 2);
      const w = win as (Decl & { sel: string; spec: number }) | null;
      if (!w || !w.hides) continue;
      if (inline[k] !== undefined && (!w.important || inlineImportant.has(k))) continue; // the inline value decides (below)
      return `${k}:${w.value} (page style ${w.sel.slice(0, 60)})`;
    }
  }
  const style = attribs.style;
  if (!style) return null;
  const s = parseStyle(style);
  if (s.display === "none") return "display:none";
  if (s.visibility === "hidden" || s.visibility === "collapse") return "visibility:hidden";
  if (s.opacity !== undefined && propHides("opacity", s.opacity)) return "opacity:0";
  if (s["font-size"] !== undefined && px(s["font-size"]) === 0) return "font-size:0";
  if (emptyClip(s.clip) || /^inset\(\s*(50|100)%\s*\)$/.test(s["clip-path"] ?? "")) return "clipped to nothing";
  if ((s.height === "0" || px(s.height) === 0) && /hidden/.test(s.overflow ?? "")) return "zero height";
  if (s.position === "absolute" || s.position === "fixed") {
    for (const k of ["left", "top", "right", "bottom", "margin-left", "text-indent"])
      if (px(s[k]) <= -500) return `positioned off-screen (${k}:${s[k]})`;
  }
  if (px(s["text-indent"]) <= -500) return "text-indent off-screen";
  if (isWhiteish(s.color)) {
    const bg = s.background ?? s["background-color"];
    if (!bg || isWhiteish(bg)) return `invisible text color (${s.color})`;
  }
  return null;
}
