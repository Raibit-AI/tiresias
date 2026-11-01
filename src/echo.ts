// SPDX-License-Identifier: Apache-2.0
// v0.9 (Travis 2026-10-31, item B, option (b)): a site's echo of a secret it set is withheld, never masked.
//
// After a form is sent with a permission slip, the site's answer may repeat a secret the site itself set for this
// call: a hidden form value or a cookie. Rewriting every spelling of it inside text that is then parsed, cut and
// normalized was open-ended (hardening rounds 2c to 4c), so Tiresias no longer tries. It looks ONCE at the raw
// answer (and again at anything built from it before it is recorded or returned), with both the answer and each
// secret brought to one canonical form; on a hit the answer is withheld whole and the reply carries fixed codes only.
//
// Canonical form: HTML character references, percent escapes (UTF-8, any case, "+" as a space) and JSON/JS escapes
// (\uXXXX, \xXX, \/) decoded, up to three rounds for nested encodings; then lower case, and every whitespace,
// quote, backtick, backslash, control and zero-width character removed. Erring toward a hit costs one withheld
// answer; a miss would pass a secret on. Known limit: an encoding Tiresias does not decode (base64, a hash, a value
// split across places) is not seen. Original values under MIN_SECRET characters are not checked (they would match
// ordinary words, and a value that short is no secret: SPEC section 9, 2026-10-20).
import { Parser } from "htmlparser2";

export const MIN_SECRET = 6;
const ROUNDS = 3;

const fromCode = (n: number, m: string): string => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : m);

function decodeOnce(s: string): string {
  // Use the reader's own decoder and entity table, including numeric leading zeroes and HTML's code-point
  // replacements. Escape literal '<' so tags stay text: decoding must not discard headers, markup or attributes.
  // The streaming parser builds no tree; both this scan and the escape replacement are linear.
  const parts: string[] = [];
  const parser = new Parser({ ontext: (t) => parts.push(t) });
  parser.end(s.replace(/</g, "&lt;"));
  s = parts.join("")
    .replace(/\\u\{([0-9a-f]{1,6})\}/gi, (m, h: string) => fromCode(parseInt(h, 16), m))
    .replace(/\\u([0-9a-f]{4})/gi, (m, h: string) => fromCode(parseInt(h, 16), m))
    .replace(/\\x([0-9a-f]{2})/gi, (m, h: string) => fromCode(parseInt(h, 16), m))
    .replace(/\+/g, " ");
  // Runs of percent escapes are decoded as UTF-8 bytes together, so a multi-byte character comes back whole.
  return s.replace(/(?:%[0-9a-f]{2})+/gi, (run) => Buffer.from(run.replace(/%/g, ""), "hex").toString("utf8"));
}

// Built from a string so the compiler never writes U+2028 or U+2029 into the output as raw line breaks.
const DROP = new RegExp("[\\s\"'`\\\\\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\ufeff]", "g");

export function canonical(s: string): string {
  for (let i = 0; i < ROUNDS; i++) {
    const d = decodeOnce(s);
    if (d === s) break;
    s = d;
  }
  // No Unicode normalization (Codex client-trust round 1: NFKC's reordering of long combining sequences is not
  // linear); every step here is a linear scan.
  return s.toLowerCase().replace(DROP, "");
}

const plain = (s: string): string => s.toLowerCase();

export interface Secrets {
  canon: string[];
  plain: string[];
}

// The secrets of one call: each value of MIN_SECRET or more characters, in both forms, longest first.
export function secretsOf(values: Iterable<string>): Secrets {
  const canon = new Set<string>();
  const pl = new Set<string>();
  for (const v of values) {
    if (typeof v !== "string" || v.length < MIN_SECRET) continue;
    pl.add(plain(v));
    const c = canonical(v);
    if (c.length) canon.add(c);
  }
  const byLength = (a: string, b: string) => b.length - a.length;
  return { canon: [...canon].sort(byLength), plain: [...pl].sort(byLength) };
}

export const noSecrets = (s: Secrets | undefined): boolean => !s || (!s.canon.length && !s.plain.length);

// Does any of these texts hold a secret, in any spelling the canonical form covers?
export function holdsSecret(texts: Iterable<string>, s: Secrets | undefined): boolean {
  if (noSecrets(s)) return false;
  for (const t of texts) {
    if (!t) continue;
    const p = plain(t);
    if (s!.plain.some((x) => p.includes(x))) return true;
    const c = canonical(t);
    if (s!.canon.some((x) => c.includes(x))) return true;
  }
  return false;
}

// Any value at all (a reply part, a record), as its JSON text: keys and strings both count.
export function valueHoldsSecret(x: unknown, s: Secrets | undefined): boolean {
  if (noSecrets(s) || x === undefined) return false;
  let text: string;
  try {
    text = JSON.stringify(x) ?? "";
  } catch {
    return true; // cannot be checked: treated as holding one
  }
  return holdsSecret([text], s);
}

// The raw answer: every header (name and value) except Set-Cookie, which Tiresias never passes on and which a
// site commonly repeats with the same session value; the final URL; and the body as received (decoded text, or
// the raw bytes as Latin-1 so ASCII spellings are found in a PDF or a file too). The caller runs the check in the
// worker under the parse time budget (work.ts, op "echo"), since the body may be megabytes.
export function rawTexts(a: { headers: Headers; url: string; body?: string; bytes?: Buffer; fileBody?: Buffer; declared?: (string | undefined)[] }): string[] {
  const texts: string[] = [a.url];
  for (const [k, v] of a.headers) if (k.toLowerCase() !== "set-cookie") texts.push(`${k}: ${v}`);
  for (const d of a.declared ?? []) if (d) texts.push(d);
  if (a.body) texts.push(a.body);
  if (a.bytes?.length) texts.push(a.bytes.toString("latin1"));
  if (a.fileBody?.length) texts.push(a.fileBody.toString("latin1"));
  return texts;
}

// Thrown where a file answer's inside (Office text, zip names) turns out to hold a secret, before anything from
// it is recorded; the form flow turns it into the withheld reply.
export class SecretWithheld extends Error {
  constructor() {
    super("secret_withheld");
  }
}
