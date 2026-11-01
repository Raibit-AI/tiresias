// SPDX-License-Identifier: Apache-2.0
// W-19: the Phishing.Database domain list, as plain functions with no I/O.
//
// normalizeList runs on the downloaded text (untrusted, about 11 MB) inside the worker under the
// parse budget (work.ts). It keeps one lower-case ASCII host per line (IDN names turned into
// punycode the way `new URL` does it), drops blanks, comments and anything that is not a host
// name, and returns the hosts sorted and unique. The stored file is that text, so a lookup is a
// binary search over the file's own bytes: about 13 MB of memory for about 400,000 domains
// (the file plus one 4-byte offset per line), with no per-entry objects.

export const MAX_HOST = 253;

// Common multi-label public suffixes: names under which unrelated people register or host their own
// sites. A list entry equal to one would flag every site under it, so a suffix is never matched as a
// PARENT domain (Codex rounds 41 and 43). The entry is kept and still flags its own exact host (com.es
// flags com.es, never shop.com.es); it is counted as `suffix_entries`. Exact hosts below a suffix
// (evil.github.io) still match, with their own subdomains. Not the full Public Suffix List (no new
// dependency): a bounded mitigation.
// Plus any two-label name whose first label is a generic second-level label AND whose second label is a
// two-letter country code (com.es, gob.mx, net.ar), as registries use under many countries (Codex round
// 42). A generic top-level domain is not a country code, so gov.com or co.com stay ordinary registrable
// domains (Codex round 43).
const GENERIC_SECOND = new Set(["com", "co", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "mil", "nom", "gob", "gen"]);
export function isPublicSuffix(h: string): boolean {
  if (PUBLIC_SUFFIXES.has(h)) return true;
  const dot = h.indexOf(".");
  return dot > 0 && h.indexOf(".", dot + 1) === -1 && GENERIC_SECOND.has(h.slice(0, dot)) && /^[a-z]{2}$/.test(h.slice(dot + 1));
}
export const PUBLIC_SUFFIXES = new Set([
  // country second levels
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "co.nz", "net.nz", "org.nz",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "com.br", "net.br", "org.br", "com.cn", "net.cn", "org.cn",
  "com.mx", "org.mx", "co.in", "net.in", "org.in", "co.za", "org.za", "com.tr", "com.sg", "com.hk",
  "com.tw", "co.kr", "or.kr", "com.ar", "com.co", "com.pe", "com.ph", "com.my", "co.id", "co.th",
  "com.vn", "com.ua", "com.pl", "co.il", "com.eg", "com.sa", "com.ng", "co.ke", "com.pk",
  // shared hosting
  "github.io", "gitlab.io", "pages.dev", "workers.dev", "netlify.app", "vercel.app", "herokuapp.com",
  "blogspot.com", "web.app", "firebaseapp.com", "azurewebsites.net", "cloudfront.net", "s3.amazonaws.com",
  "appspot.com", "000webhostapp.com", "weebly.com", "weeblysite.com", "wixsite.com", "glitch.me",
  "repl.co", "onrender.com", "fly.dev", "ngrok.io", "ngrok-free.app", "duckdns.org", "r2.dev",
  "translate.goog", "sharepoint.com", "myshopify.com", "wordpress.com", "godaddysites.com",
  "square.site", "framer.app", "webflow.io", "carrd.co", "surge.sh", "on.fleek.co", "ipfs.dweb.link",
]);

// a-z, 0-9, "-", "_" and "." (underscores occur in real DNS labels and the list has them).
function hostChar(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 95 || c === 46;
}

// A plain host: allowed characters only, no empty label, no leading or trailing dot, two labels or more
// (a single label like "com" would flag a whole top-level domain).
export function plainHost(s: string): boolean {
  if (s.length === 0 || s.length > MAX_HOST) return false;
  let dots = 0;
  let prev = 46; // as if a dot came before: a leading dot is an empty label
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!hostChar(c)) return false;
    if (c === 46) {
      if (prev === 46) return false;
      dots++;
    }
    prev = c;
  }
  return prev !== 46 && dots >= 1;
}

// One line of the list to a host, or null. Non-ASCII names go through the WHATWG URL parser, which
// turns them into punycode; anything that looks like more than a host (a path, credentials, a port,
// spaces, percent-escapes) is rejected rather than guessed at.
export function normalizeHost(line: string): string | null {
  let s = line.trim().toLowerCase();
  if (!s || s.startsWith("#")) return null;
  if (s.endsWith(".")) s = s.slice(0, -1);
  if (s.length > MAX_HOST * 4) return null;
  if (plainHost(s)) return s;
  if (/[\s/\\@:?#%[\]<>"'`]/.test(s)) return null;
  let h: string;
  try {
    h = new URL(`http://${s}/`).hostname;
  } catch {
    return null;
  }
  return plainHost(h) ? h : null;
}

export interface Normalized {
  text: string; // hosts, sorted, unique, one per line, each line ending in "\n"
  entries: number;
  rejected: number; // non-blank, non-comment lines that were not a host name
  suffix_entries: number; // entries that are a public suffix: kept, but they match only their own exact host
}

export function normalizeList(body: string): Normalized {
  const set = new Set<string>();
  const suffixes = new Set<string>();
  let rejected = 0;
  let start = 0;
  while (start <= body.length) {
    let end = body.indexOf("\n", start);
    if (end === -1) end = body.length;
    const line = body.slice(start, end);
    start = end + 1;
    const h = normalizeHost(line);
    if (h) {
      set.add(h);
      if (isPublicSuffix(h)) suffixes.add(h);
    }
    else if (line.trim() && !line.trim().startsWith("#")) rejected++;
  }
  // Every host is ASCII, so this order is also byte order: the stored file can be searched by bytes.
  const hosts = [...set].sort();
  return { text: hosts.length ? hosts.join("\n") + "\n" : "", entries: hosts.length, rejected, suffix_entries: suffixes.size };
}

// The stored list, read back: `buf` holds the hosts part of the file, `starts[i]` is where line i
// begins, and starts[entries] is the end. Built by indexList, which checks the order and the
// characters, so a damaged or hand-edited file is refused instead of giving wrong answers.
export interface Indexed {
  buf: Buffer;
  starts: Uint32Array;
  entries: number;
}

export function indexList(buf: Buffer): Indexed | null {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  if (buf.length && buf[buf.length - 1] !== 10) return null;
  const starts = new Uint32Array(n + 1);
  let s = 0;
  for (let i = 0, line = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c !== 10) {
      if (!hostChar(c)) return null;
      continue;
    }
    if (i === s) return null; // empty line
    if (line > 0 && Buffer.compare(buf.subarray(starts[line - 1], s - 1), buf.subarray(s, i)) >= 0) return null; // not sorted and unique
    starts[line++] = s;
    s = i + 1;
  }
  starts[n] = buf.length;
  return { buf, starts, entries: n };
}

function has(ix: Indexed, host: Buffer): boolean {
  let lo = 0;
  let hi = ix.entries - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const c = Buffer.compare(ix.buf.subarray(ix.starts[mid], ix.starts[mid + 1] - 1), host);
    if (c === 0) return true;
    if (c < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

// The host and each parent domain down to two labels: a.b.example.com, b.example.com, example.com.
// An IP address is matched as is. `host` is a URL's hostname (already lower case and punycode).
export function candidates(hostname: string): string[] {
  let h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (!h) return [];
  if (/^[\d.]+$/.test(h) || h.includes(":")) return [h];
  const labels = h.split(".");
  const out: string[] = [];
  // The host itself is always a candidate (an entry com.es flags com.es). A public suffix is never a
  // PARENT candidate, so an entry like co.uk never flags everything under it.
  for (let i = 0; i <= labels.length - 2; i++) {
    const c = labels.slice(i).join(".");
    if (i === 0 || !isPublicSuffix(c)) out.push(c);
  }
  return out.length || labels.length > 1 ? out : [h];
}

export function lookup(ix: Indexed, hostname: string): boolean {
  return candidates(hostname).some((c) => has(ix, Buffer.from(c, "latin1")));
}
