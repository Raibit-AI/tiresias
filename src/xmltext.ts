// SPDX-License-Identifier: Apache-2.0
// v0.6 (track "files"): a minimal, strict XML reader for the parts of an Office file. It is a single
// linear pass that yields start tags (with their attributes and namespaces resolved), end tags and text.
// It resolves NO entities except the five XML defines and numeric character references, and it REFUSES
// any document type declaration or entity declaration (<!DOCTYPE, <!ENTITY, <!ELEMENT, ...): so no outside
// entity can be fetched (no XXE), and no entity can expand (no "billion laughs"). It builds no tree.
//
// Strict (Codex round 1): a part that is not well-formed (an unfinished construct, a close tag that does
// not match, a duplicate attribute, an unbound prefix, more than one root, text outside the root) throws
// XmlMalformed, and callers refuse the WHOLE part (they validate it fully before using any of it), so a
// part Office would reject is never half-read.
//
// Everything is bounded by the input's length: each step moves forward, and every search is indexOf.

export class XmlRefused extends Error {
  constructor() {
    super("xml_doctype");
  }
}
export class XmlMalformed extends Error {
  constructor() {
    super("xml_malformed");
  }
}

export interface XmlAttr {
  name: string;
  local: string;
  ns: string; // "" for an attribute without a prefix (attributes do not take the default namespace)
  value: string;
}
export type XmlToken =
  | { t: "open"; name: string; local: string; ns: string; attrs: XmlAttr[]; self: boolean; scope: ReadonlyMap<string, string> } // scope: prefix -> namespace in force
  | { t: "close"; name: string; local: string; ns: string }
  | { t: "text"; text: string };

const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
const splitName = (n: string): [string, string] => {
  const i = n.indexOf(":");
  return i === -1 ? ["", n] : [n.slice(0, i), n.slice(i + 1)];
};
// XML names (XML 1.0, fifth edition, with Namespaces: a name has at most one colon, not at either end).
const START = "A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}";
const CHAR = START + "\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040";
const NCNAME = `[${START}][${CHAR}]*`;
const NCNAME_RE = new RegExp(`^${NCNAME}$`, "u");
export const isNCName = (s: string): boolean => NCNAME_RE.test(s); // an XML identifier with no colon
const NAME = new RegExp(`^${NCNAME}(:${NCNAME})?$`, "u"); // (Codex round 4: the real grammar, not an approximation)

// A code point XML allows (XML 1.0 "Char"): tab, line feed, carriage return, and the rest above 0x1F
// except surrogates and U+FFFE/U+FFFF.
const xmlChar = (cp: number) => cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
const BAD_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;

// The five predefined entities and numeric references. Any other "&" (an undeclared entity, a reference to
// a character XML does not allow, a bare ampersand) makes the document malformed (Codex round 2).
export function decodeEntities(s: string): string {
  if (s.indexOf("&") === -1) return s;
  let out = "";
  let i = 0;
  for (;;) {
    const a = s.indexOf("&", i);
    if (a === -1) return out + s.slice(i);
    const e = s.indexOf(";", a + 1);
    if (e === -1 || e - a > 12) throw new XmlMalformed();
    const g = s.slice(a + 1, e);
    let rep: string;
    if (g === "lt") rep = "<";
    else if (g === "gt") rep = ">";
    else if (g === "amp") rep = "&";
    else if (g === "quot") rep = '"';
    else if (g === "apos") rep = "'";
    else if (/^#x[0-9a-fA-F]{1,6}$/.test(g) || /^#[0-9]{1,7}$/.test(g)) {
      const cp = g[1] === "x" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      if (!xmlChar(cp)) throw new XmlMalformed();
      rep = String.fromCodePoint(cp);
    } else throw new XmlMalformed();
    out += s.slice(i, a) + rep;
    i = e + 1;
  }
}

const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";

// Attributes of one start tag, read left to right. Anything that is not name="value" is malformed.
function readAttrs(s: string): [string, string][] {
  const out: [string, string][] = [];
  const seen = new Set<string>();
  let i = 0;
  const n = s.length;
  for (;;) {
    while (i < n && isWs(s[i])) i++;
    if (i >= n) return out;
    const ks = i;
    while (i < n && s[i] !== "=" && !isWs(s[i])) i++;
    const key = s.slice(ks, i);
    while (i < n && isWs(s[i])) i++;
    if (s[i] !== "=" || !NAME.test(key)) throw new XmlMalformed();
    i++;
    while (i < n && isWs(s[i])) i++;
    const q = s[i];
    if (q !== '"' && q !== "'") throw new XmlMalformed();
    const end = s.indexOf(q, i + 1);
    if (end === -1) throw new XmlMalformed();
    const raw = s.slice(i + 1, end);
    if (raw.includes("<")) throw new XmlMalformed();
    if (seen.has(key)) throw new XmlMalformed();
    seen.add(key);
    // Attribute-value normalization: each literal white-space character is a space; a character reference
    // keeps the character it names (Codex round 2).
    out.push([key, decodeEntities(raw.replace(/[\t\n\r]/g, " "))]);
    i = end + 1;
    if (i < n && !isWs(s[i])) throw new XmlMalformed(); // attributes must be separated by white space
  }
}

const DECL = /^<\?xml[ \t\n\r]+version[ \t\n\r]*=[ \t\n\r]*(["'])1\.0\1(?:[ \t\n\r]+encoding[ \t\n\r]*=[ \t\n\r]*(["'])([A-Za-z][A-Za-z0-9._-]*)\2)?(?:[ \t\n\r]+standalone[ \t\n\r]*=[ \t\n\r]*(["'])(?:yes|no)\4)?[ \t\n\r]*\?>$/;

// Decode a part's bytes: UTF-16 by its byte-order mark, otherwise UTF-8 (a UTF-8 mark dropped). Bytes that
// are not valid in that encoding make the part malformed, never replacement characters (Codex round 2).
export function xmlString(b: Buffer): string {
  let text: string, used: "utf-8" | "utf-16le" | "utf-16be";
  try {
    if (b[0] === 0xff && b[1] === 0xfe) [text, used] = [new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true }).decode(b.subarray(2)), "utf-16le"];
    else if (b[0] === 0xfe && b[1] === 0xff) [text, used] = [new TextDecoder("utf-16be", { fatal: true, ignoreBOM: true }).decode(b.subarray(2)), "utf-16be"];
    else [text, used] = [new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3) : b), "utf-8"];
  } catch {
    throw new XmlMalformed();
  }
  // The XML declaration, when there is one, must be well-formed, and its encoding must be the one the bytes
  // were read in (Codex round 3): a part that says one encoding and is another is refused, never guessed.
  // Any "<?xml" at the start, in any case, is the declaration and must be exactly right (Codex round 4).
  if (/^<\?xml[ \t\n\r?]/i.test(text)) {
    const end = text.indexOf("?>");
    const decl = end === -1 ? "" : text.slice(0, end + 2);
    const m = DECL.exec(decl);
    if (!m) throw new XmlMalformed();
    const enc = m[3]?.toLowerCase();
    // UTF-16 with a byte-order mark may say "UTF-16", or the byte order it really is (Codex round 4).
    if (enc !== undefined && !(used === "utf-8" ? ["utf-8", "utf8"] : ["utf-16", used]).includes(enc)) throw new XmlMalformed();
  }
  return text;
}

export function* xmlTokens(input: string): Generator<XmlToken> {
  // End-of-line handling, as every XML reader does before parsing: CR LF and a lone CR are LF (Codex round 2).
  const xml = input.indexOf("\r") === -1 ? input : input.replace(/\r\n?/g, "\n");
  if (BAD_CHARS.test(xml)) throw new XmlMalformed(); // a character XML does not allow
  let i = 0;
  const n = xml.length;
  // Open elements: name and the namespace scope in force inside it (shared until an element declares one).
  const stack: { name: string; scope: Map<string, string> }[] = [];
  const root = new Map<string, string>([["xml", XML_NS]]);
  let roots = 0;
  const outside = (s: string) => {
    for (let k = 0; k < s.length; k++) if (!isWs(s[k])) throw new XmlMalformed(); // text outside the root element
  };
  while (i < n) {
    const lt = xml.indexOf("<", i);
    const chunk = xml.slice(i, lt === -1 ? n : lt);
    if (chunk) {
      if (!stack.length) outside(chunk);
      else {
        if (chunk.includes("]]>")) throw new XmlMalformed(); // not allowed in character data
        yield { t: "text", text: decodeEntities(chunk) };
      }
    }
    if (lt === -1) break;
    if (xml.startsWith("<?", lt)) {
      const e = xml.indexOf("?>", lt + 2);
      if (e === -1) throw new XmlMalformed();
      // The XML declaration only at the very start; no other processing instruction may be named "xml".
      const target = /^[^ \t\n\r?]*/.exec(xml.slice(lt + 2, e))![0];
      // A target is an XML name (Codex round 3); "xml" in any case only as the declaration, at the very start,
      // in lower case, with its grammar (Codex round 4).
      if (!NAME.test(target) || (target.toLowerCase() === "xml" && (lt !== 0 || target !== "xml" || !DECL.test(xml.slice(0, e + 2))))) throw new XmlMalformed();
      // The subset Tiresias accepts has no processing instructions but the declaration (coordinator, 2026-10-24:
      // anything outside the subset refuses the part).
      if (target !== "xml") throw new XmlMalformed();
      const after = xml[lt + 2 + target.length];
      if (after !== "?" && after !== " " && after !== "\t" && after !== "\n" && after !== "\r") throw new XmlMalformed();
      i = e + 2;
      continue;
    }
    if (xml.startsWith("<!--", lt)) {
      const e = xml.indexOf("-->", lt + 4);
      if (e === -1) throw new XmlMalformed();
      const body = xml.slice(lt + 4, e);
      if (body.includes("--") || body.endsWith("-")) throw new XmlMalformed(); // "--" is not allowed inside a comment
      i = e + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const e = xml.indexOf("]]>", lt + 9);
      if (e === -1 || !stack.length) throw new XmlMalformed();
      yield { t: "text", text: xml.slice(lt + 9, e) };
      i = e + 3;
      continue;
    }
    if (xml[lt + 1] === "!") throw new XmlRefused(); // <!DOCTYPE, <!ENTITY and every other declaration
    // A tag: up to the first ">" outside quotes.
    let j = lt + 1;
    let q = "";
    while (j < n) {
      const c = xml[j];
      if (q) {
        if (c === q) q = "";
      } else if (c === '"' || c === "'") q = c;
      else if (c === ">") break;
      j++;
    }
    if (j >= n) throw new XmlMalformed(); // an unfinished tag
    const inner = xml.slice(lt + 1, j);
    i = j + 1;
    if (inner[0] === "/") {
      const name = inner.slice(1).replace(/[ \t\n\r]+$/, ""); // only XML white space may follow the name
      const top = stack.pop();
      if (!top || top.name !== name) throw new XmlMalformed();
      const [p, local] = splitName(name);
      const ns = top.scope.get(p) ?? "";
      yield { t: "close", name, local, ns };
      continue;
    }
    const self = inner.endsWith("/");
    const body = self ? inner.slice(0, -1) : inner;
    let k = 0;
    while (k < body.length && !isWs(body[k])) k++;
    const name = body.slice(0, k);
    if (!NAME.test(name)) throw new XmlMalformed();
    if (!stack.length && roots++ > 0) throw new XmlMalformed(); // a second root element
    const raw = readAttrs(body.slice(k));
    const parent = stack.length ? stack[stack.length - 1].scope : root;
    let scope = parent;
    for (const [key, v] of raw) {
      if (key === "xmlns" || key.startsWith("xmlns:")) {
        const prefix = key === "xmlns" ? "" : key.slice(6);
        // Reserved bindings (Namespaces in XML): "xml" only to its own name, "xmlns" never, no other prefix to
        // either reserved name, and no prefix to the empty name (Codex round 2).
        if (prefix === "xmlns" || (prefix === "xml") !== (v === XML_NS) || v === XMLNS_NS || (prefix !== "" && v === "")) throw new XmlMalformed();
        if (scope === parent) scope = new Map(parent);
        scope.set(prefix, v);
      }
    }
    const resolve = (prefix: string, isAttr: boolean): string => {
      if (prefix === "xmlns") {
        if (!isAttr) throw new XmlMalformed(); // an element may never have the xmlns prefix (Codex round 5)
        return XMLNS_NS;
      }
      if (!prefix) return isAttr ? "" : (scope.get("") ?? "");
      const uri = scope.get(prefix);
      if (uri === undefined) throw new XmlMalformed(); // an unbound prefix
      return uri;
    };
    const [p, local] = splitName(name);
    const ns = resolve(p, false);
    const attrs: XmlAttr[] = raw.map(([key, value]) => {
      if (key === "xmlns") return { name: key, local: key, ns: XMLNS_NS, value };
      const [ap, al] = splitName(key);
      return { name: key, local: al, ns: resolve(ap, true), value };
    });
    // Two attributes with the same namespace and local name are one attribute twice.
    const ids = new Set<string>();
    for (const a of attrs) {
      const id = `${a.ns}\u0000${a.local}`;
      if (a.ns && ids.has(id)) throw new XmlMalformed();
      ids.add(id);
    }
    yield { t: "open", name, local, ns, attrs, self, scope };
    if (self) yield { t: "close", name, local, ns };
    else stack.push({ name, scope });
  }
  if (stack.length || roots !== 1) throw new XmlMalformed();
}

// The value of an attribute by namespace and local name (ns "" for an attribute without a prefix).
export function attrOf(tok: { attrs: XmlAttr[] }, ns: string | readonly string[], local: string): string | undefined {
  for (const a of tok.attrs) if (a.local === local && (typeof ns === "string" ? a.ns === ns : ns.includes(a.ns))) return a.value;
  return undefined;
}
