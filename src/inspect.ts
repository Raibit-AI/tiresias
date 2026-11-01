// SPDX-License-Identifier: Apache-2.0
// v0.7 track 2 (N-02, N-05 with W-10): walls and hidden text, decided from what the browser actually shows.
//
// Runs inside a render (render.ts withRenderedPage), from the isolated world, after the page's scripts were stopped:
// the page cannot run during the inspection. Native prototypes from that world also bypass form controls exposed as
// named properties, and named elements overriding Document's built-ins. What the page does control, its CSS and its
// DOM, is exactly what is measured.
//
// The script marks every hidden element or text node in the live DOM with an attribute whose NAME is random per render
// (made by Tiresias after the page's scripts stopped, so the page cannot write or guess it). The serialized HTML then
// goes through the same reader and shield as any page, which honour only that mark (shield.ts hiddenReason).
// The wall verdict is computed here, in Node, from fixed counts the script returns; nothing the page wrote is used.
import crypto from "node:crypto";
import type { WallInfo } from "./walls.js";

// The hidden-text codes, each with the fixed text the flag's detail carries.
export const HIDDEN_CODES = {
  not_displayed: "rendered: not displayed",
  invisible: "rendered: visibility hidden",
  transparent: "rendered: transparent",
  zero_size: "rendered: zero size",
  off_screen: "rendered: off-screen",
  clipped: "rendered: clipped out of view",
  covered: "rendered: covered by another element",
  same_color: "rendered: same colour as its background",
} as const;
export type HiddenCode = keyof typeof HIDDEN_CODES;
export const hiddenText = (code: string): string => (Object.hasOwn(HIDDEN_CODES, code) ? HIDDEN_CODES[code as HiddenCode] : "rendered: hidden");

export const LIMITS = {
  textNodes: 20_000,
  marks: 5_000,
  workMs: 2_500, // inside the page
  evaluateMs: 6_000, // the evaluate call's own limit (render.ts turns a miss into page_busy)
  scrolls: 2_000,
  markers: 50,
  markerCandidates: 2_000, // per input/CAPTCHA scan
  thin: 1_200, // letters and digits of visible text outside a marker: the HTML rule's number (2026-10-21)
};
export const VIEWPORT = { width: 1280, height: 900 };

// A fresh mark name per render: "data-t-" and 16 hex characters.
export const newMark = (): string => `data-t-${crypto.randomBytes(8).toString("hex")}`;

// What the script returns (checked before use: it is built in the isolated world, but checked anyway).
export interface Inspection {
  complete: boolean; // all checks completed apart from the counted unmeasured click-through text
  unmeasured: number; // letters and digits of click-through text missed by hit tests, counted like `outside` (not in a
  // marker's form or site furniture): the upper bound the wall verdict adds (Claude review, sweep round 5)
  clickThrough: number; // all such letters and digits, anywhere: any makes the hidden-text inspection partial
  markersUninspected: number; // input/CAPTCHA candidate scan entries left by the work, scan or marker limits
  markers: { kind: "password" | "captcha" | "turnstile"; fixed: boolean }[]; // visible ones only
  overlay: boolean; // a fixed layer covering at least half of the viewport
  visible: number; // letters and digits of visible text
  outside: number; // of those, outside every marker's form and outside site furniture
  under: number; // letters and digits under an opaque overlay (not flagged one by one)
  marks: number;
}

export function checkInspection(v: unknown): Inspection | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const n = (x: unknown) => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
  if (typeof o.complete !== "boolean" || typeof o.overlay !== "boolean" || !n(o.unmeasured) || !n(o.clickThrough) || !n(o.markersUninspected) || !n(o.visible) || !n(o.outside) || !n(o.under) || !n(o.marks)) return null;
  if (!Array.isArray(o.markers) || o.markers.length > LIMITS.markers) return null;
  const markers: Inspection["markers"] = [];
  for (const m of o.markers) {
    if (!m || typeof m !== "object") return null;
    const k = (m as Record<string, unknown>).kind;
    const f = (m as Record<string, unknown>).fixed;
    if ((k !== "password" && k !== "captcha" && k !== "turnstile") || typeof f !== "boolean") return null;
    markers.push({ kind: k, fixed: f });
  }
  return { complete: o.complete, unmeasured: o.unmeasured as number, clickThrough: o.clickThrough as number, markersUninspected: o.markersUninspected as number, markers, overlay: o.overlay, visible: o.visible as number, outside: o.outside as number, under: o.under as number, marks: o.marks as number };
}

export type Overlay = "login" | "captcha" | "other";
export interface WallVerdict {
  decided: boolean; // false: the inspection could not decide; the HTML heuristics run instead
  wall: WallInfo | null;
  overlay?: Overlay;
}

const TEXT = {
  bot_challenge: "The site served a bot check. A person has to pass it.",
  captcha: "The page asks for a CAPTCHA. A person has to complete it.",
  login_required: "The page needs a login or credentials. A person has to sign in.",
} as const;
const wallOf = (k: Inspection["markers"][number]["kind"]): WallInfo =>
  k === "turnstile" ? { code: "bot_challenge", explanation: TEXT.bot_challenge } : k === "captcha" ? { code: "captcha", explanation: TEXT.captcha } : { code: "login_required", explanation: TEXT.login_required };
// One marker for the verdict, in the HTML rule's order: a bot check, then a CAPTCHA, then a password box.
const first = (ms: Inspection["markers"]) => ms.find((m) => m.kind === "turnstile") ?? ms.find((m) => m.kind === "captcha") ?? ms[0];

export function wallVerdict(i: Inspection): WallVerdict {
  // An overlay with a sign-in or CAPTCHA in a fixed layer: a wall whatever is beneath.
  const inLayer = i.overlay ? i.markers.filter((m) => m.fixed) : [];
  if (inLayer.length) {
    const m = first(inLayer);
    return { decided: true, wall: wallOf(m.kind), overlay: m.kind === "password" ? "login" : "captcha" };
  }
  // A detected overlay needs its own note, even when it is transparent or covers little text.
  const overlay: Overlay | undefined = i.overlay ? "other" : undefined;
  // A found marker can still prove a wall, but an unscanned candidate could hide a fixed-layer marker.
  // Even if every unmeasured character were visible outside the markers, this page would still be thin.
  if (i.markers.length && i.complete && i.outside + i.unmeasured < LIMITS.thin) return { decided: true, wall: wallOf(first(i.markers).kind), ...(overlay ? { overlay } : {}) };
  if (i.markersUninspected) return { decided: false, wall: null, ...(overlay ? { overlay } : {}) };
  // A visible marker on a page whose visible text outside it is thin. Counting stops at the limits, so an incomplete
  // inspection can only prove "not thin".
  if (i.markers.length && i.outside < LIMITS.thin) return { decided: false, wall: null, ...(overlay ? { overlay } : {}) };
  return { decided: true, wall: null, ...(overlay ? { overlay } : {}) };
}

// elementsFromPoint is front to back. Stop at page content: layers later in that order are backgrounds.
export function overlayLayers<T>(elements: T[], fixedOf: (el: T) => T | null, content: (el: T) => boolean, large: (el: T) => boolean): Set<T> {
  const above = new Set<T>();
  for (const el of elements) {
    const fixed = fixedOf(el);
    if (fixed) {
      if (large(fixed)) above.add(fixed);
    } else if (content(el)) return above;
  }
  return new Set();
}

// The script, run in the isolated world with returnByValue. `mark` is the attribute name (checked here: it is put in
// the source as a string literal).
export function inspectScript(mark: string): string {
  if (!/^data-t-[0-9a-f]{16}$/.test(mark)) throw new Error("bad mark");
  return `(() => {
  const MARK = ${JSON.stringify(mark)};
  const L = ${JSON.stringify(LIMITS)};
  const T0 = performance.now();
  // Document named elements override built-ins; forms expose controls as named properties, even in this world.
  // Read and call native prototypes directly on either object (including a text node's parent, which may be a form).
  const documentElement = Object.getOwnPropertyDescriptor(Document.prototype, 'documentElement').get;
  const documentBody = Object.getOwnPropertyDescriptor(Document.prototype, 'body').get;
  const createElement = Document.prototype.createElement, elementsFromPoint = Document.prototype.elementsFromPoint;
  const getElementsByTagName = Document.prototype.getElementsByTagName, querySelectorAll = Document.prototype.querySelectorAll;
  const createRange = Document.prototype.createRange, createTreeWalker = Document.prototype.createTreeWalker;
  const checkVisibility = Element.prototype.checkVisibility;
  const nodeType = Object.getOwnPropertyDescriptor(Node.prototype, 'nodeType').get;
  const textContent = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent').get;
  const parentElement = Object.getOwnPropertyDescriptor(Node.prototype, 'parentElement').get;
  const tagName = Object.getOwnPropertyDescriptor(Element.prototype, 'tagName').get;
  const nativeContains = Node.prototype.contains, nativeClosest = Element.prototype.closest;
  const nativeRect = Element.prototype.getBoundingClientRect, nativeAttr = Element.prototype.getAttribute;
  const setAttribute = Element.prototype.setAttribute;
  const insertBefore = Node.prototype.insertBefore;
  const parent = (el) => parentElement.call(el);
  const tag = (el) => tagName.call(el);
  const contains = (el, child) => nativeContains.call(el, child);
  const closest = (el, selector) => nativeClosest.call(el, selector);
  const rect = (el) => nativeRect.call(el);
  const attr = (el, name) => nativeAttr.call(el, name);
  const out = { complete: true, unmeasured: 0, clickThrough: 0, markersUninspected: 0, markers: [], overlay: false, visible: 0, outside: 0, under: 0, marks: 0 };
  const de = documentElement.call(document);
  const body = documentBody.call(document);
  if (!de || !body) return out;
  const W = window.innerWidth, H = window.innerHeight;
  const pageW = Math.max(de.scrollWidth, body.scrollWidth, W), pageH = Math.max(de.scrollHeight, body.scrollHeight, H);
  const styles = new Map();
  const st = (el) => { let s = styles.get(el); if (!s) { s = getComputedStyle(el); styles.set(el, s); } return s; };
  const SKIP = 'script,style,noscript,template,title,select,svg,iframe,object,canvas,head';
  const FURNITURE = 'nav,header,footer,aside,[role=navigation],[role=banner],[role=contentinfo],[role=complementary]';
  const REPLACED = new Set(['IMG','VIDEO','CANVAS','IFRAME','OBJECT','EMBED','PICTURE','svg','SVG','INPUT','SELECT','TEXTAREA','BUTTON']);
  const vis = (el, o) => { try { return checkVisibility.call(el, o); } catch (e) { out.complete = false; return true; } };
  // Computed wide-gamut colours retain color()/oklch() syntax. Let Chrome convert them to sRGB with alpha.
  const colors = new Map();
  let colorContext;
  const rgba = (s) => {
    if (s === 'transparent') return [0, 0, 0, 0];
    const m = /^rgba?\\(\\s*([\\d.]+)[,\\s]+([\\d.]+)[,\\s]+([\\d.]+)(?:\\s*[,/]\\s*([\\d.]+%?))?\\s*\\)$/.exec(s);
    if (m) {
      const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return [+m[1], +m[2], +m[3], a];
    }
    if (colors.has(s)) return colors.get(s);
    let c = null;
    try {
      if (CSS.supports('color', s)) {
        if (!colorContext) {
          const canvas = createElement.call(document, 'canvas');
          canvas.width = canvas.height = 1;
          colorContext = canvas.getContext('2d', { willReadFrequently: true });
        }
        colorContext.clearRect(0, 0, 1, 1);
        colorContext.fillStyle = s;
        colorContext.fillRect(0, 0, 1, 1);
        const p = colorContext.getImageData(0, 0, 1, 1).data;
        c = [p[0], p[1], p[2], p[3] / 255];
      }
    } catch (e) { /* unavailable colour conversion leaves the inspection partial */ }
    if (!c) out.complete = false;
    colors.set(s, c);
    return c;
  };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const opac = new Map();
  const effOpacity = (el) => {
    if (!el || nodeType.call(el) !== 1) return 1;
    if (opac.has(el)) return opac.get(el);
    const v = (st(el).display === 'contents' ? 1 : (parseFloat(st(el).opacity) || 0)) * effOpacity(parent(el));
    opac.set(el, v);
    return v;
  };
  const fixedMemo = new Map();
  const fixedOf = (el) => {
    if (!el || nodeType.call(el) !== 1) return null;
    if (fixedMemo.has(el)) return fixedMemo.get(el);
    const p = st(el).position;
    const v = p === 'fixed' || p === 'sticky' ? el : fixedOf(parent(el));
    fixedMemo.set(el, v);
    return v;
  };
  // Row 7.7, designed away (Travis, 2026-11-01): any background image or gradient counts as
  // opaque, as in v0.9.0. It can flag text under a transparent decorative layer as covered; it never calls hidden text shown.
  const opaque = (el) => {
    if (effOpacity(el) < 0.9) return false;
    if (REPLACED.has(tag(el))) return true;
    const s = st(el);
    if (s.backgroundImage && s.backgroundImage !== 'none') return true;
    const c = rgba(s.backgroundColor);
    return !!c && c[3] >= 0.9;
  };
  const timeUp = () => performance.now() - T0 > L.workMs;
  let scrolls = 0;
  // Brings a page point into the viewport and returns its viewport coordinates, or null.
  const toView = (px, py) => {
    let x = px - window.scrollX, y = py - window.scrollY;
    if (x >= 0 && x < W && y >= 0 && y < H) return [x, y];
    if (scrolls >= L.scrolls) return null;
    scrolls++;
    window.scrollTo({ left: Math.max(0, px - W / 2), top: Math.max(0, py - H / 2), behavior: 'instant' });
    x = px - window.scrollX; y = py - window.scrollY;
    return x >= 0 && x < W && y >= 0 && y < H ? [x, y] : null;
  };
  window.scrollTo({ left: 0, top: 0, behavior: 'instant' });

  // Overlays: fixed layers covering at least half of the viewport, painted ABOVE content at a grid point.
  const overlays = new Set();
  const overlayLayers = ${overlayLayers.toString()};
  for (let gx = 1; gx <= 4; gx++) for (let gy = 1; gy <= 4; gy++) {
    const layers = overlayLayers(elementsFromPoint.call(document, (W * gx) / 5, (H * gy) / 5), fixedOf,
      (e) => e === body || e === de || !!(textContent.call(e) || '').trim(), (f) => {
      if (st(f).position !== 'fixed') return false;
      const r = rect(f);
      const w = Math.max(0, Math.min(r.right, W) - Math.max(r.left, 0)), h = Math.max(0, Math.min(r.bottom, H) - Math.max(r.top, 0));
      return w * h * 2 >= W * H;
    });
    for (const layer of layers) overlays.add(layer);
  }
  out.overlay = overlays.size > 0;
  const inOverlay = (el) => { const f = fixedOf(el); if (!f) return false; for (const o of overlays) if (o === f || contains(o, f) || contains(f, o)) return true; return false; };

  // What is above a point of an element: 'clear', 'clipped' (it is not under the point at all), 'covered' (an opaque,
  // non-fixed element above it), 'overlay' (an opaque overlay above it), or 'unmeasured' (text omitted from hit tests).
  const pointState = (el, x, y, markerMode) => {
    const list = elementsFromPoint.call(document, x, y);
    let i = 0;
    for (; i < list.length; i++) if (list[i] === el || contains(el, list[i]) || (st(el).display === 'contents' && contains(list[i], el))) break;
    if (i === list.length) {
      if (st(el).pointerEvents !== 'none') return 'clipped';
      // A miss cannot distinguish honest click-through text from clipping. Keep the marker rule, but do not
      // treat unmeasured text as proven visible (row 7.22).
      return markerMode ? 'clear' : 'unmeasured';
    }
    let state = 'clear';
    for (let k = 0; k < i; k++) {
      const a = list[k];
      if (contains(a, el) || !opaque(a)) continue;
      if (inOverlay(a)) return 'overlay';
      if (markerMode || !fixedOf(a)) state = 'covered';
    }
    return state;
  };

  // Visible markers.
  const boxOk = (el) => {
    if (!vis(el) || !vis(el, { visibilityProperty: true, checkVisibilityCSS: true }) || !vis(el, { opacityProperty: true, checkOpacity: true }) || effOpacity(el) < 0.05) return null;
    const r = rect(el);
    if (r.width < 10 || r.height < 10) return null;
    const px = r.left + window.scrollX + r.width / 2, py = r.top + window.scrollY + r.height / 2;
    if (px < 0 || py < 0 || px >= pageW || py >= pageH) return null;
    return [px, py];
  };
  const markerVisible = (el) => {
    const c = boxOk(el);
    if (!c) return false;
    const v = toView(c[0], c[1]);
    if (!v) return true; // out of reach of the hit tests: judged by the checks above
    return pointState(el, v[0], v[1], true) === 'clear';
  };
  const excluded = [];
  const addMarker = (el, kind) => {
    if (out.markers.length >= L.markers || !markerVisible(el)) return;
    const f = fixedOf(el);
    out.markers.push({ kind, fixed: !!f && st(f).position === 'fixed' });
    excluded.push(closest(el, 'form') || el);
  };
  const inputs = getElementsByTagName.call(document, 'input');
  let inputCount = 0;
  for (; inputCount < inputs.length && inputCount < L.markerCandidates && !timeUp() && out.markers.length < L.markers; inputCount++) if (inputs[inputCount].type === 'password') addMarker(inputs[inputCount], 'password');
  out.markersUninspected += inputs.length - inputCount;
  const caps = querySelectorAll.call(document, '[class*="recaptcha" i],[class*="hcaptcha" i],[class*="h-captcha" i],[class*="turnstile" i],[id*="captcha" i],[data-sitekey],iframe,frame,object,embed');
  let k = 0;
  for (; k < caps.length && k < L.markerCandidates && !timeUp() && out.markers.length < L.markers; k++) {
    const el = caps[k];
    const t = tag(el);
    let kind = null;
    if (t === 'IFRAME' || t === 'FRAME' || t === 'OBJECT' || t === 'EMBED') {
      const a = String((t === 'OBJECT' ? attr(el, 'data') : attr(el, 'src')) || '').toLowerCase();
      kind = /turnstile|challenges\\.cloudflare\\.com/.test(a) ? 'turnstile' : /captcha/.test(a) ? 'captcha' : null;
    } else {
      const c = String(attr(el, 'class') || '').toLowerCase();
      kind = /turnstile/.test(c) ? 'turnstile' : 'captcha';
    }
    if (kind) addMarker(el, kind);
  }
  out.markersUninspected += caps.length - k;
  window.scrollTo({ left: 0, top: 0, behavior: 'instant' });

  // Hidden text.
  const marks = [];
  const hiddenRoots = new Set();
  const markedRoot = (el) => { for (let x = el; x; x = parent(x)) if (hiddenRoots.has(x)) return true; return false; };
  const count = (s) => (s.match(/[\\p{L}\\p{N}]/gu) || []).length;
  const range = createRange.call(document);
  // Resolve the system canvas colour in the root's used colour scheme (including the browser's preference).
  const canvasProbe = createElement.call(document, 'div');
  canvasProbe.style.cssText = 'all:initial!important;display:none!important;color-scheme:inherit!important;background-color:Canvas!important';
  de.appendChild(canvasProbe);
  const canvasColor = rgba(getComputedStyle(canvasProbe).backgroundColor);
  canvasProbe.remove();
  const bgAt = (el, list, i) => {
    // The first opaque background painted under the text: its own element, then what lies below it at the point.
    const paint = boxOf(el);
    const own = rgba(st(paint).backgroundColor);
    if (!own || st(paint).backgroundImage !== 'none') return null;
    if (own && own[3] >= 0.9) return own;
    if (own && own[3] > 0.1) return null;
    if (list) {
      for (let k = i + 1; k < list.length; k++) {
        const b = list[k];
        if (REPLACED.has(tag(b))) return null;
        const s = st(b);
        if (s.backgroundImage !== 'none') return null;
        const c = rgba(s.backgroundColor);
        if (!c) return null;
        if (c[3] >= 0.9) return c;
        if (c[3] > 0.1) return null;
      }
      return canvasColor;
    }
    for (let x = parent(el); x; x = parent(x)) {
      const s = st(x);
      if (s.display === 'contents') continue;
      if (s.backgroundImage !== 'none') return null;
      const c = rgba(s.backgroundColor);
      if (!c) return null;
      if (c[3] >= 0.9) return c;
      if (c[3] > 0.1) return null;
    }
    return canvasColor;
  };
  const hidesContents = (el) => { const s = st(el); return s.display === 'none' || (s.display !== 'contents' && s.contentVisibility === 'hidden'); };
  const hiddenMemo = new Map();
  const underHidden = (el) => {
    if (!el || nodeType.call(el) !== 1) return false;
    if (hiddenMemo.has(el)) return hiddenMemo.get(el);
    const v = hidesContents(el) || underHidden(parent(el));
    hiddenMemo.set(el, v);
    return v;
  };
  const boxOf = (el) => { while (parent(el) && st(el).display === 'contents') el = parent(el); return el; };
  const judge = (t, el) => {
    // A contents wrapper has no box, but its direct text still has range rectangles.
    const contents = st(el).display === 'contents';
    if (underHidden(el)) return 'not_displayed';
    if (!contents && !vis(el)) return 'not_displayed';
    if (st(el).visibility !== 'visible' || (!contents && !vis(el, { visibilityProperty: true, checkVisibilityCSS: true }))) return 'invisible';
    if ((!contents && !vis(el, { opacityProperty: true, checkOpacity: true })) || effOpacity(el) < 0.05) return 'transparent';
    range.selectNodeContents(t);
    // A textarea paints its text inside a native control, not in its child text node's range boxes.
    // Judge that control, and mark the element so its raw-text serialization keeps the mark.
    const all = tag(el) === 'TEXTAREA' ? [rect(el)] : range.getClientRects();
    const rects = [];
    for (let k = 0; k < all.length; k++) {
      if (timeUp()) { out.complete = false; return 'unmeasured'; }
      if (all[k].width >= 2 && all[k].height >= 2) rects.push(all[k]);
    }
    if (!rects.length) return 'zero_size';
    const sx = window.scrollX, sy = window.scrollY;
    const page = rects.map((r) => ({ l: r.left + sx, t: r.top + sy, r: r.right + sx, b: r.bottom + sy }));
    if (page.every((r) => r.r <= 0 || r.b <= 0 || r.l >= pageW || r.t >= pageH)) return 'off_screen';
    const picks = [page[0], page[page.length - 1], page[Math.floor(page.length / 2)]].filter((r, k, a) => a.indexOf(r) === k);
    const states = [];
    let colorAt = null;
    for (const r of picks) {
      const v = toView((r.l + r.r) / 2, (r.t + r.b) / 2);
      if (!v) continue;
      states.push(pointState(el, v[0], v[1], false));
      if (!colorAt) colorAt = v;
    }
    const unmeasured = states.includes('unmeasured');
    if (states.length) {
      if (states.every((s) => s === 'clipped')) return 'clipped';
      if (states.every((s) => s === 'overlay' || s === 'covered') && states.includes('overlay')) return 'under';
      if (states.every((s) => s === 'covered')) return 'covered';
    }
    const s = st(el);
    const fg = rgba(s.webkitTextFillColor || s.color);
    if (fg) {
      if (fg[3] < 0.1) return 'same_color';
      let list = null, i = 0;
      if (colorAt) {
        list = elementsFromPoint.call(document, colorAt[0], colorAt[1]);
        const box = boxOf(el);
        for (; i < list.length; i++) if (list[i] === box || contains(box, list[i])) break;
        if (i === list.length) list = null;
      }
      const bg = bgAt(el, list, i);
      if (bg && contrast(fg, bg) < 1.2) return 'same_color';
    }
    return unmeasured ? 'unmeasured' : null;
  };
  const walker = createTreeWalker.call(document, body, NodeFilter.SHOW_TEXT);
  let nodes = 0;
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const n = count(t.data);
    if (!n) continue;
    if (++nodes > L.textNodes || timeUp() || marks.length >= L.marks) { out.complete = false; break; }
    const el = t.parentElement;
    if (!el || closest(el, SKIP) || markedRoot(el)) continue;
    if (closest(el, 'details:not([open])') && !vis(el)) { out.visible += n; continue; } // a closed disclosure: one click away
    const why = judge(t, el);
    if (why === 'unmeasured') {
      out.clickThrough += n;
      // Only where outside would count it: text in a marker's form or in site furniture never makes a page thick.
      if (!closest(el, FURNITURE) && !excluded.some((x) => contains(x, el))) out.unmeasured += n;
      continue;
    }
    if (why === 'not_displayed') {
      let r = el;
      // Climb to the topmost element inside the hidden subtree (one hidden block, one mark), never past it onto a
      // shown ancestor (a display: contents wrapper fails checkVisibility() though its contents show).
      while (parent(r) && parent(r) !== de && underHidden(parent(r))) r = parent(r);
      hiddenRoots.add(r);
      marks.push([r, why]);
      continue;
    }
    if (why === 'under') { out.under += n; continue; }
    // Raw-text elements serialize their children literally: a thidden wrapper would become readable text.
    if (why) { marks.push([closest(el, 'textarea,xmp,plaintext,noembed,noframes') || t, why]); continue; }
    out.visible += n;
    if (!closest(el, FURNITURE) && !excluded.some((x) => contains(x, el))) out.outside += n;
  }
  // Marks go in after every measurement, so they cannot change what was measured.
  for (const [x, why] of marks) {
    if (nodeType.call(x) === 1) setAttribute.call(x, MARK, why);
    else {
      const w = createElement.call(document, 'thidden');
      w.setAttribute(MARK, why);
      insertBefore.call(x.parentNode, w, x);
      w.appendChild(x);
    }
  }
  out.marks = marks.length;
  window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
  return out;
})()`;
}
