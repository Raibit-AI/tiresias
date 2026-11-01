// SPDX-License-Identifier: Apache-2.0
// W-26 (v0.7): language detection, written here with no dependency (docs/v0.7/translate.md).
// Two stages, per block of text: the Unicode script first (Hangul is Korean, kana Japanese, Han without kana
// Chinese, Cyrillic Russian, Arabic script Arabic, Devanagari Hindi), then, for Latin script, the language whose
// common words the block uses most. The page's language is the one holding the most text; the others that hold
// at least 10% are listed too. Bounded: at most 64 KB of text and 4,000 blocks are looked at, in one linear pass.
// The page's own declaration (<html lang>, Content-Language) is a hint only, checked against the text.
import type { Envelope, ParsedPage } from "./types.js";

export const LANGS = ["en", "es", "fr", "de", "pt", "it", "nl", "ru", "zh", "ja", "ko", "ar", "hi"] as const;
export type Lang = (typeof LANGS)[number];
export const LANG_SET: ReadonlySet<string> = new Set(LANGS);
export type Declared = "matches" | "differs" | "unchecked" | "not_a_language";
export const DECLARED: ReadonlySet<string> = new Set(["matches", "differs", "unchecked", "not_a_language"]);

// What a reply says at the top level: every value is Tiresias's own (a fixed code, a number it computed).
export interface LanguageTop {
  code: Lang | "unknown";
  confidence: number; // 0 to 1, two decimals
  also?: Lang[]; // other languages holding at least 10% of the text, most first (at most 4)
  declared?: Declared; // only when the page declared a language
}
// Kept with the parsed page (the cache): the top part, plus the page's own declaration (web text).
export interface PageLanguage extends LanguageTop {
  declared_text?: string; // what the page or its headers said (cut at 64): goes inside untrusted_content
}

export const MAX_SAMPLE = 64 * 1024;
const MAX_BLOCKS = 4000;
const MIN_LETTERS = 20; // under this, the language is unknown
const BLOCK_MIN = 15; // weighted letters a block needs to be placed alone; smaller ones are joined

type Script = "latin" | "cyrillic" | "arabic" | "devanagari" | "hangul" | "kana" | "han";
// Script of one code point, by range (fast, no regex per character).
export function scriptOf(cp: number): Script | null {
  if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return "latin";
  if (cp < 0xc0) return null;
  if ((cp <= 0x24f && cp !== 0xd7 && cp !== 0xf7) || (cp >= 0x1e00 && cp <= 0x1eff)) return "latin";
  if (cp >= 0x400 && cp <= 0x4ff) return "cyrillic";
  if ((cp >= 0x620 && cp <= 0x64a) || (cp >= 0x66e && cp <= 0x6d3) || (cp >= 0x6fa && cp <= 0x6ff) || (cp >= 0x750 && cp <= 0x77f) || (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfefc)) return "arabic";
  if (cp >= 0x900 && cp <= 0x97f && !(cp >= 0x966 && cp <= 0x96f)) return "devanagari";
  if ((cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x3130 && cp <= 0x318f)) return "hangul";
  if ((cp >= 0x3041 && cp <= 0x309f) || (cp >= 0x30a0 && cp <= 0x30ff && cp !== 0x30fb) || (cp >= 0x31f0 && cp <= 0x31ff) || (cp >= 0xff66 && cp <= 0xff9f)) return "kana";
  if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x20000 && cp <= 0x2ffff)) return "han";
  return null;
}
// A CJK character carries about a word's worth of meaning, so it weighs more than a Latin letter.
const WEIGHT: Record<Script, number> = { latin: 1, cyrillic: 1, arabic: 1, devanagari: 1, hangul: 3, kana: 3, han: 3 };

// Common words of the seven Latin-script languages: the words that decide a block. Overlaps (de, que, a) are
// fine: the scores are compared, so the words only one language uses decide.
const WORDS: Record<"en" | "es" | "fr" | "de" | "pt" | "it" | "nl", string> = {
  en: "the and of to is in that it for with was on are this be as by have from not but or an they which you we has were their will would there been what can all its more when about also these other into than only our how he she his her who if do does did had",
  es: "el la los las de que y en un una es por con para del se al lo como su más pero sus le ya o este esta ha muy también fue son entre cuando todo sobre desde nos durante uno ni contra ese eso hay donde porque así puede está están ser tiene sin hasta según cada otros",
  fr: "le la les de des du et est un une en que qui dans pour pas sur au aux avec ce cette il elle sont ne se plus par mais ou nous vous leur été être très aussi comme tout fait sans entre peut ces son sa ses je on était avait ont lui",
  de: "der die das und ist nicht ein eine zu den dem mit von auf für sich des auch im es an als wird werden bei oder aber wie nach sind noch nur einer einen über so wir sie hat kann durch wenn ich um zum zur aus dass mehr schon wurde wurden diese dieser haben",
  pt: "o a os as de do da dos das e em um uma que para com não no na nos nas por se mais como mas ao ele ela foi são ser tem também à seu sua pelo pela já está muito isso quando entre até ou nem você este esta pode há essa esse",
  it: "il lo la i gli le di del della dei delle e è un una che per con non in nel nella sono si da al alla anche come ma più questo questa ha ci se essere tutto molto quando dopo perché già solo suo sua loro ancora degli dalla sul stato",
  nl: "de het een en van is dat in op te zijn voor met niet die er aan ook als bij maar om door naar dan wordt of uit nog wel worden kan geen deze zo heeft hun we ze je ik was over tot meer zich al dit hij werd",
};
type Latin = keyof typeof WORDS;
const LATIN: Latin[] = ["en", "es", "fr", "de", "pt", "it", "nl"];
const WORDSETS = new Map<Latin, Set<string>>(LATIN.map((l) => [l, new Set(WORDS[l].split(" "))]));
// Letters that lean one way (a small bonus, a tie-breaker): ñ ¿ ¡ Spanish, ã õ Portuguese, ß German, ij Dutch.
const LEAN: [RegExp, Latin, number][] = [
  [/[ñ¿¡]/g, "es", 1], [/[ãõ]/g, "pt", 1], [/ß/g, "de", 1], [/[äöü]/g, "de", 0.3], [/ij/g, "nl", 0.3],
  [/[èùœ]/g, "fr", 0.3], [/[ìò]/g, "it", 0.3], [/ç/g, "fr", 0.15], [/ç/g, "pt", 0.15], [/[êâô]/g, "fr", 0.15], [/[êâô]/g, "pt", 0.15],
];

// The Latin-script language of a piece of text, by its common words: scores per language.
function latinScores(text: string): { scores: Map<Latin, number>; words: number } {
  const scores = new Map<Latin, number>(LATIN.map((l) => [l, 0]));
  const lower = text.toLowerCase();
  let words = 0;
  for (const m of lower.matchAll(/\p{L}+/gu)) {
    if (++words > 3000) break;
    const w = m[0];
    for (const l of LATIN) if (WORDSETS.get(l)!.has(w)) scores.set(l, scores.get(l)! + 1);
  }
  for (const [re, l, b] of LEAN) {
    const n = Math.min(4, (lower.match(re) ?? []).length);
    if (n) scores.set(l, scores.get(l)! + n * b);
  }
  return { scores, words };
}
function best<K>(scores: Map<K, number>): { top: K | null; first: number; second: number } {
  let top: K | null = null;
  let first = 0;
  let second = 0;
  for (const [k, v] of scores) {
    if (v > first) {
      second = first;
      first = v;
      top = k;
    } else if (v > second) second = v;
  }
  return { top, first, second };
}

interface Counted {
  weight: number;
  by: Map<Script, number>;
}
function count(text: string): Counted {
  const by = new Map<Script, number>();
  let weight = 0;
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    if (cp > 0xffff) i++;
    const s = scriptOf(cp);
    if (!s) continue;
    by.set(s, (by.get(s) ?? 0) + 1);
    weight += WEIGHT[s];
  }
  return { weight, by };
}
// The dominant script of a counted piece, by weight.
function dominant(c: Counted): Script | null {
  let top: Script | null = null;
  let w = 0;
  for (const [s, n] of c.by) if (n * WEIGHT[s] > w) (w = n * WEIGHT[s]), (top = s);
  return top;
}

// One block: its language and how clear it was (0 to 1), or null when it cannot be placed.
export function blockLanguage(text: string, c: Counted = count(text)): { lang: Lang; clarity: number } | null {
  const s = dominant(c);
  if (!s) return null;
  if (s === "hangul") return { lang: "ko", clarity: 1 };
  if (s === "cyrillic") return { lang: "ru", clarity: 0.9 };
  if (s === "arabic") return { lang: "ar", clarity: 0.9 };
  if (s === "devanagari") return { lang: "hi", clarity: 0.9 };
  if (s === "kana" || s === "han") {
    const kana = c.by.get("kana") ?? 0;
    const han = c.by.get("han") ?? 0;
    return kana >= Math.max(1, 0.1 * (kana + han)) ? { lang: "ja", clarity: 1 } : kana ? { lang: "zh", clarity: 0.6 } : { lang: "zh", clarity: 0.9 };
  }
  const { scores, words } = latinScores(text);
  const b = best(scores);
  if (!b.top) return null;
  // Placed when the best language has two hits and leads clearly, or a short block has one hit and no rival.
  if (!((b.first >= 2 && b.first - b.second >= 1) || (b.first >= 1 && b.second === 0 && words <= 6))) return null;
  const clarity = Math.min(1, (b.first - b.second) / b.first) * Math.min(1, b.first / Math.max(2, words * 0.2));
  return { lang: b.top, clarity: Math.max(0.1, Math.round(clarity * 100) / 100) };
}

// The script a language is written in (to check a declared language against the text).
const SCRIPT_OF: Record<Lang, Script[]> = {
  en: ["latin"], es: ["latin"], fr: ["latin"], de: ["latin"], pt: ["latin"], it: ["latin"], nl: ["latin"],
  ru: ["cyrillic"], ar: ["arabic"], hi: ["devanagari"], ko: ["hangul"], ja: ["kana", "han"], zh: ["han"],
};

// The primary subtag of a declared language: the first tag of `lang="..."` or `Content-Language: a, b`.
export function declaredPrimary(s: string): string | null {
  const m = /^\s*([A-Za-z]{2,3})(?:[-_][A-Za-z0-9]{1,8})*\s*(?:[,;]|$)/.exec(s);
  return m ? m[1].toLowerCase() : null;
}

const round2 = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 100) / 100;

// The language of a list of text pieces (blocks, in page order), with the page's declaration as a hint.
export function detect(pieces: Iterable<string>, declared?: string): PageLanguage {
  const weights = new Map<Lang, number>();
  const clear = new Map<Lang, number>(); // the sum of clarity times weight, per language
  let total = 0;
  let sampled = 0;
  let blocks = 0;
  let pending = "";
  let pendingC: Counted = { weight: 0, by: new Map() };
  const scriptTotals = new Map<Script, number>();
  const place = (text: string, c: Counted) => {
    total += c.weight;
    for (const [s, n] of c.by) scriptTotals.set(s, (scriptTotals.get(s) ?? 0) + n * WEIGHT[s]);
    const r = blockLanguage(text, c);
    if (!r) return;
    weights.set(r.lang, (weights.get(r.lang) ?? 0) + c.weight);
    clear.set(r.lang, (clear.get(r.lang) ?? 0) + c.weight * r.clarity);
  };
  for (const raw of pieces) {
    if (sampled >= MAX_SAMPLE || blocks >= MAX_BLOCKS) break;
    const piece = raw.slice(0, MAX_SAMPLE - sampled).normalize("NFKC");
    sampled += piece.length;
    blocks++;
    const c = count(piece);
    if (!c.weight) continue;
    if (c.weight >= BLOCK_MIN && !pending) {
      place(piece, c);
      continue;
    }
    // Small pieces are joined until there is enough to judge.
    pending = pending ? pending + " " + piece : piece;
    for (const [s, n] of c.by) pendingC.by.set(s, (pendingC.by.get(s) ?? 0) + n);
    pendingC.weight += c.weight;
    if (pendingC.weight >= BLOCK_MIN) {
      place(pending, pendingC);
      pending = "";
      pendingC = { weight: 0, by: new Map() };
    }
  }
  if (pending) place(pending, pendingC);

  let code: Lang | "unknown" = "unknown";
  let confidence = 0;
  const ranked = [...weights].sort((a, b) => b[1] - a[1]);
  if (total >= MIN_LETTERS && ranked.length) {
    const [top, w] = ranked[0];
    code = top;
    confidence = (w / total) * (0.5 + (0.5 * clear.get(top)!) / w);
  }
  const also = total >= MIN_LETTERS ? ranked.slice(1).filter(([, w]) => w / total >= 0.1).slice(0, 4).map(([l]) => l) : [];
  const out: PageLanguage = { code, confidence: round2(confidence), ...(also.length ? { also } : {}) };
  if (declared !== undefined && declared.trim()) {
    out.declared_text = declared.slice(0, 64);
    const d = declaredPrimary(declared);
    if (!d) out.declared = "not_a_language";
    else if (total < MIN_LETTERS) out.declared = "unchecked";
    else if (code !== "unknown" && confidence >= 0.5) out.declared = d === code ? "matches" : "differs";
    else if (LANG_SET.has(d)) {
      // The text is not clear: the declaration breaks the tie when the text's main script fits it.
      let top: Script | null = null;
      let tw = 0;
      for (const [s, w] of scriptTotals) if (w > tw) (tw = w), (top = s);
      if (top && SCRIPT_OF[d as Lang].includes(top)) {
        out.code = d as Lang;
        out.confidence = round2(Math.max(code === d ? confidence : 0, Math.min(0.5, confidence + 0.2)));
        if (out.also) out.also = out.also.filter((l) => l !== d);
        if (out.also && !out.also.length) delete out.also;
        out.declared = "matches";
      } else out.declared = code === "unknown" ? "unchecked" : d === code ? "matches" : "differs";
    } else out.declared = code === "unknown" ? "unchecked" : "differs";
  }
  return out;
}

// The text pieces of a parsed page, in page order: the title, then each section's heading and blocks.
export function* pagePieces(p: Pick<ParsedPage, "title" | "sections">): Generator<string> {
  if (p.title) yield p.title;
  for (const s of p.sections) {
    if (s.heading && !s.generated && s.heading !== "(structured data)") yield s.heading;
    if (s.heading === "(structured data)") continue; // JSON-LD keys are not the page's language
    for (const b of s.blocks) yield b.text;
  }
}

// Sets parsed.language. `header` is the Content-Language the site sent; the page's own lang wins as the hint.
export function languageOf(p: ParsedPage, header?: string): PageLanguage {
  return detect(pagePieces(p), p.meta?.lang ?? (header ? header.slice(0, 200) : undefined));
}

// The top-level part of a kept language (checked: a cached copy could be edited, so only fixed codes and a
// number in range pass; anything else is left out).
export function languageTop(l: unknown): LanguageTop | undefined {
  if (!l || typeof l !== "object") return undefined;
  const o = l as Record<string, unknown>;
  if (!(o.code === "unknown" || (typeof o.code === "string" && LANG_SET.has(o.code)))) return undefined;
  if (typeof o.confidence !== "number" || !(o.confidence >= 0 && o.confidence <= 1)) return undefined;
  const top: LanguageTop = { code: o.code as LanguageTop["code"], confidence: o.confidence };
  if (Array.isArray(o.also) && o.also.length && o.also.length <= 4 && o.also.every((x) => typeof x === "string" && LANG_SET.has(x))) top.also = [...(o.also as Lang[])];
  if (typeof o.declared === "string" && DECLARED.has(o.declared)) top.declared = o.declared as Declared;
  return top;
}

export const LANGUAGE_DIFFERS = "The page declares a different language than its text reads as (see language.declared).";

// W-26 (v0.7): the language of the text read, on a reply that shows a page. The top level gets only the checked
// codes and number (a cached copy could be edited); what the page itself declared goes inside untrusted_content,
// and a declaration the text contradicts adds a fixed sentence to the message.
export function stampLanguage(e: Envelope, l: unknown): void {
  const top = languageTop(l);
  if (!top) return;
  e.language = top;
  const said = (l as { declared_text?: unknown }).declared_text;
  if (typeof said === "string" && said) e.untrusted_content = { ...(e.untrusted_content ?? {}), declared_language: said.slice(0, 64) };
  if (top.declared === "differs") e.message = e.message ? `${e.message} ${LANGUAGE_DIFFERS}` : LANGUAGE_DIFFERS;
}
