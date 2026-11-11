// SPDX-License-Identifier: Apache-2.0
// N-10: safe fetching. Every network request in Tiresias goes through here.
// Why: an agent can be tricked into asking for http://169.254.169.254/ (cloud
// metadata) or an internal service. We refuse private addresses, follow
// redirects by hand so every hop is re-checked, and cap time and size.
//
// DNS rebinding: the address that is checked is the address that is used.
// The connection's own `lookup` hook resolves the name, validates every
// answer, and hands that same answer to the socket. TLS still verifies the
// hostname because we connect by name, not by IP.
import { guardGetAction } from "./getactions.js";
import { createHash } from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable, pipeline } from "node:stream";
import zlib from "node:zlib";
import { callContext } from "./context.js";
import { ConfigError, FetchError, SafetyError } from "./errors.js";
import { ENV_PHRASE, envMayLoosen } from "./confirm.js";
import { HEAD_BYTES, RISK, classify, declaredName, mimeOf, namesOf, type FileFlag, type FileKind, type ReadAs, type Risk, type Verdict } from "./files.js";
import { signingHeaders } from "./signing.js";
import { assertSiteAllowed, DEFAULT_PORTS, sitePortAllowed } from "./sites.js";
import { shutdownSignal } from "./lifetime.js";
import { USER_AGENT } from "./types.js";

export { FetchError, SafetyError } from "./errors.js";

// W-23: ask for markdown first (Cloudflare's markdown for agents and similar), then HTML, then anything.
export const ACCEPT = "text/markdown, text/html;q=0.9, */*;q=0.8";

export const LIMITS = {
  timeoutMs: 15_000,
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 5,
};

// The call's context (one AsyncLocalStorage for the whole call, context.ts): its abort signal (MCP
// cancellation plus an overall deadline), so no function needs a new argument.
const scope = callContext;
export type Gate = (u: URL) => Promise<void>;
export const withSignal = <T>(signal: AbortSignal, fn: () => Promise<T>, sent?: { requests: number; signed: number }, gate?: Gate, readOnly = false) => {
  const quarantine = new Set<string>();
  return scope.run({ ...scope.getStore(), signal, robots: new Map(), sent, gate, quarantine, readOnly }, async () => {
    try {
      return await fn();
    } finally {
      for (const f of quarantine) removeQuarantined(f);
    }
  });
};
// W-21: the quarantine set of the current call (undefined outside a call: nothing may be written then).
export const currentQuarantine = () => scope.getStore()?.quarantine;
// Delete one quarantine file: only a plain file (never a link), and forget it.
export function removeQuarantined(file: string): void {
  scope.getStore()?.quarantine?.delete(file);
  try {
    if (fs.lstatSync(file).isFile()) fs.rmSync(file, { force: true });
  } catch {
    // already gone
  }
}
// W-19: run outside any call (the shared Safe Browsing list download): no gate (the download must not
// check itself), and not tied to the signal or deadline of whichever call happened to start it, so it
// keeps running for the other calls waiting on it (Codex round 42). It has its own timeout.
// (Only the private flag is kept: a private call stays private even in work it shares.)
export const outsideCall = <T>(fn: () => Promise<T>): Promise<T> => {
  const priv = scope.getStore()?.private;
  return priv ? scope.run({ private: true }, fn) : scope.exit(fn);
};
export const currentSignal = () => scope.getStore()?.signal;
export const currentReadOnly = () => scope.getStore()?.readOnly === true;
// W-04: the Safe Browsing check and the request counter of the current call, so a form submit can
// check its target before claiming a slip, and know afterwards whether its request went out.
export const currentGate = () => scope.getStore()?.gate;
export const currentSent = () => scope.getStore()?.sent;
export const callCache = () => scope.getStore()?.robots;
// Throws if the caller cancelled or the call deadline passed. Used before
// reusing a cached body or saving anything, so a cancelled call has no effects.
export function throwIfCancelled(): void {
  if (scope.getStore()?.signal?.aborted) throw new FetchError("The request was cancelled.", "cancelled");
}

// TIRESIAS_ALLOW_PRIVATE=1 turns the private-address block off. It exists only so the test suite can
// talk to a server on 127.0.0.1, and since v0.5.1 it is honored ONLY under Node's test runner
// (NODE_TEST_CONTEXT is set): a production run ignores it.
export const testMode = () => !!process.env.NODE_TEST_CONTEXT && process.env.TIRESIAS_ALLOW_PRIVATE === "1";
const allowPrivate = testMode;

// v0.5.1 (N-10): the ports Tiresias calls on public addresses. 80, 443 and 8000 to 8999 by default;
// TIRESIAS_ALLOW_PORTS adds more ("8080,9000-9100"). A bad setting fails loudly, by name.
export function allowedPorts(): [number, number][] {
  const raw = process.env.TIRESIAS_ALLOW_PORTS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORTS;
  const out = [...DEFAULT_PORTS];
  for (const part of raw.split(",")) {
    const m = /^\s*(\d{1,5})(?:\s*-\s*(\d{1,5}))?\s*$/.exec(part);
    const lo = m ? Number(m[1]) : NaN;
    const hi = m ? Number(m[2] ?? m[1]) : NaN;
    if (!m || lo < 1 || hi > 65535 || lo > hi) throw new ConfigError(`TIRESIAS_ALLOW_PORTS must be ports or ranges separated by commas (like "8080,9000-9100"), got "${raw.slice(0, 60)}".`);
    out.push([lo, hi]);
  }
  // W-32 (v0.9): extra ports loosen a safety default: only with the phrase in TIRESIAS_CONFIRM (or confirmations off).
  if (!envMayLoosen(ENV_PHRASE.ports)) return DEFAULT_PORTS;
  return out;
}
const PORT_BLOCKED = "port_blocked: Refused: Tiresias calls only ports 80, 443 and 8000 to 8999 by default (TIRESIAS_ALLOW_PORTS adds more; so does a site's \"ports\" setting: tiresias settings).";
export function assertPort(u: URL): void {
  if (allowPrivate()) return; // the test suite's local servers listen on any port
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  // W-25 (v0.6): the owner's site settings can allow more ports for one site.
  if (!allowedPorts().some(([lo, hi]) => port >= lo && port <= hi) && !sitePortAllowed(u, port)) throw new SafetyError(PORT_BLOCKED, String(port));
}

// v0.5.1 (N-10): which statuses are redirects Tiresias follows, and where to. Only 301, 302, 303, 307
// and 308 with a Location; an https page never sends Tiresias to plain http (refused as a downgrade,
// as every browser refuses mixed content). Returns null when the response is the final answer.
export const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const DOWNGRADE = "downgrade: Refused: an https page redirected to plain http.";
export function redirectTarget(from: URL, status: number, location: string | undefined): URL | null {
  if (!REDIRECTS.has(status) || !location) return null;
  const next = parseSafeUrl(new URL(location, from).href); // re-validates the scheme of the new hop
  if (from.protocol === "https:" && next.protocol === "http:") throw new SafetyError(DOWNGRADE, next.host);
  return next;
}

// Signed headers never go out on plain http (v0.5.1): a signature on http could be read and replayed by
// anyone on the path. The one exception is the test suite's own loopback server.
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
export const mayCarrySignature = (u: URL): boolean => u.protocol === "https:" || (allowPrivate() && LOOPBACK.has(u.hostname));

function v4Blocked(a: number, b: number, c: number): boolean {
  return (
    a === 0 || // "this network", unspecified
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    a === 127 ||
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol, TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast and reserved
  );
}

function expandV6(ip: string): number[] | null {
  ip = ip.split("%")[0].toLowerCase(); // drop zone id
  // Turn a dotted tail (::ffff:1.2.3.4) into two hex groups.
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (dotted) {
    const p = dotted[2].split(".").map(Number);
    if (p.some((n) => n > 255)) return null;
    ip = dotted[1] + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

// IPv6 is default-deny: only global unicast (2000::/3) is allowed, minus the
// special-purpose blocks inside it, plus the two IPv4-in-IPv6 forms that carry
// a real public IPv4 (checked as IPv4).
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split(".").map(Number);
    return v4Blocked(a, b, c);
  }
  const g = expandV6(ip);
  if (!g) return true; // cannot parse, so do not trust it
  const embedded = (hi: number, lo: number) => v4Blocked(hi >> 8, hi & 255, lo >> 8);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return embedded(g[6], g[7]); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(g[6], g[7]); // NAT64 well-known /96
  if ((g[0] & 0xe000) !== 0x2000) return true; // not global unicast: ::, ::1, fc00::/7, fe80::/10, fec0::/10, ff00::/8, 64:ff9b:1::/48, ...
  if (g[0] === 0x2001 && g[1] < 0x0200) return true; // 2001::/23 IETF protocol assignments, Teredo
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2002) return embedded(g[1], g[2]); // 6to4 carries an IPv4
  if (g[0] === 0x3fff && (g[1] & 0xf000) === 0) return true; // documentation 3fff::/20
  return false;
}

export function parseSafeUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SafetyError("Not a valid URL. Give the whole address, starting with https:// (like https://example.com).");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new SafetyError("Only http and https are allowed.");
  if (u.username || u.password) throw new SafetyError("URLs with a username or password are refused.");
  return u;
}

const REFUSED_PRIVATE = "Refused: the address is private or internal (this computer or your own network). Tiresias reads public sites only, so a page can never use it to reach your devices.";

// IP literals never go through `lookup`, so check them here.
function assertLiteral(u: URL): void {
  if (allowPrivate()) return;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isPrivateAddress(host)) throw new SafetyError(REFUSED_PRIVATE, host);
}

// The pinned lookup. Every answer must be public or the whole lookup fails.
// A mixed answer is a classic trick, so one private address refuses all.
// The same validation as the pinned lookup, on its own: every answer public or a SafetyError, no
// answer a FetchError. Used by the connection (below) and by the Safe Browsing check before a name
// is ever sent to Google Web Risk (W-19), so a name Tiresias would refuse never leaves the machine.
async function resolvePublic(hostname: string): Promise<{ address: string; family: number }[]> {
  let addrs: { address: string; family: number }[];
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch {
    throw new FetchError("Could not resolve the host.", "network", hostname);
  }
  if (!addrs.length) throw new FetchError("Could not resolve the host.", "network", hostname);
  if (!allowPrivate()) {
    const bad = addrs.find((a) => isPrivateAddress(a.address));
    if (bad) throw new SafetyError(REFUSED_PRIVATE, `${hostname} -> ${bad.address}`);
  }
  return addrs;
}

// W-19: the address checks a request would get (scheme, IP literal, DNS answer), without sending it.
export async function assertPublicUrl(u: URL): Promise<void> {
  assertLiteral(u);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!net.isIP(host)) await resolvePublic(host);
}

function guardedLookup(hostname: string, options: { all?: boolean }, cb: (...a: any[]) => void): void {
  resolvePublic(hostname).then(
    (addrs) => {
      if (options.all) cb(null, addrs);
      else cb(null, addrs[0].address, addrs[0].family);
    },
    (e) => cb(e),
  );
}

// W-20: what is known about a response that is a FILE, not a page Tiresias reads. Its body was never
// kept: it was hashed as it streamed (and written nowhere, except a W-21 quarantine copy).
export interface FileFacts {
  kind: FileKind;
  risk: Risk;
  flags: FileFlag[];
  size: number; // decoded bytes received (the whole file when sha256 is set)
  sha256?: string; // hex, only when the whole file was hashed
  // Why there is no fingerprint: over the file cap (the download stopped), a Content-Length over the cap
  // (nothing downloaded), or the download ran out of time.
  stopped?: "too_large" | "not_downloaded" | "timeout";
  // From the web, bounded: they go only inside untrusted_content.
  declared_type: string;
  declared_name?: string;
  declared_size?: string;
  quarantine?: string; // W-21: the quarantine copy's path, when one was written
  // v0.6: the whole file, held in memory only, when it is a zip small enough to look inside (inside.ts).
  // Never written anywhere and never put in a reply or a record; dropped once the warning is built.
  body?: Buffer;
  names?: string[]; // v0.6: every name the response gave (header names and the URL's), for the macros flag
  inspect_too_large?: true; // v0.6: it would have been looked inside, but it is over the inspect cap
}

// W-20 file handling for one fetch. Without it (robots.txt, probes, doors, a form page, the Safe Browsing
// list) every response is still named, but its body is kept as text exactly as before v0.5, under the
// caller's own cap, and `read` is left out for a file: the caller's own rules decide (Codex round 58: a
// robots.txt starting "MZ" must still be parsed, never read as "no rules").
export interface FileSink {
  write(b: Buffer): void;
  done(): string | undefined; // the finished file's path, or undefined if writing failed
  drop(): void; // delete what was written
}
export interface FileOptions {
  maxBytes: number; // TIRESIAS_MAX_FILE_BYTES: the most hashed, and the most a quarantine copy holds
  onFile?: (f: { kind: FileKind; risk: Risk }) => FileSink | undefined; // W-21: where a copy goes, if anywhere
  // v0.6: how many bytes of this file to hold in memory to look inside it (0: none). Past it nothing is held.
  keep?: (kind: FileKind, head: Buffer) => number;
}

// v0.5.1: ONE way a file is taken in piece by piece, for a download (readBody) and for a file a person
// saved (engine hashPieces): each piece is counted against the file cap, hashed, and written to the W-21
// quarantine copy when the owner asked for one. Past the cap the copy is dropped and there is no hash.
export class FileIntake {
  size = 0;
  stopped: "too_large" | undefined;
  private hash = createHash("sha256");
  private sink: FileSink | undefined;
  // v0.6: the bytes held to look inside, while under keepMax: ONE buffer that grows by doubling (never past
  // keepMax), so many tiny pieces cost no more than their bytes (Codex round 1).
  private kept: Buffer | null;
  private keptLen = 0;
  constructor(private readonly maxBytes: number, sink: FileSink | undefined, private readonly keepMax = 0) {
    this.sink = sink;
    this.kept = keepMax > 0 ? Buffer.alloc(0) : null;
  }
  // False once the cap is passed (stop reading).
  write(b: Buffer): boolean {
    this.size += b.length;
    if (this.size > this.maxBytes) {
      this.stopped = "too_large";
      this.drop();
      return false;
    }
    this.hash.update(b);
    this.sink?.write(b);
    if (this.kept) {
      if (this.size > this.keepMax) this.kept = null; // too big to look inside: nothing is held
      else {
        if (this.keptLen + b.length > this.kept.length) {
          const grown = Buffer.allocUnsafe(Math.min(this.keepMax, Math.max(64 * 1024, this.kept.length * 2, this.keptLen + b.length)));
          this.kept.copy(grown, 0, 0, this.keptLen);
          this.kept = grown;
        }
        b.copy(this.kept, this.keptLen);
        this.keptLen += b.length;
      }
    }
    return true;
  }
  drop(): void {
    this.sink?.drop();
    this.sink = undefined;
    this.kept = null;
  }
  // The whole file's hash and the copy's path; neither when the cap was passed.
  finish(): { sha256?: string; quarantine?: string; body?: Buffer } {
    if (this.stopped) return {};
    const q = this.sink?.done();
    const body = this.kept ? this.kept.subarray(0, this.keptLen) : undefined;
    this.kept = null;
    return { sha256: this.hash.digest("hex"), ...(q ? { quarantine: q } : {}), ...(body ? { body } : this.keepMax > 0 ? { inspect_too_large: true as const } : {}) };
  }
}

export interface RawResponse {
  status: number;
  headers: Headers;
  body: string; // decoded text ("" for a PDF, which is kept as bytes instead, and for a file)
  bytes?: Buffer; // W-17: the raw bytes, kept only for a PDF (by content type or a %PDF- start)
  read?: ReadAs; // W-20: how this page is read (absent for a file)
  fileFlags?: FileFlag[]; // W-20: what the response says against what it is (pages too)
  file?: FileFacts; // W-20: set when the response is a file, not a page
  url: string; // final URL after redirects
  redirected: boolean; // any redirect at all was followed (W-03: such a copy is never reused fresh)
  truncated: boolean;
  size?: number; // v0.7: bytes this fetch's connections received, every hop (see Wire): what a render is charged
  raw?: Buffer; // W-28 (v0.8): with `keepRaw`, a page's body as received: after chunked framing and Content-Encoding are undone, before charset decoding
}

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  // Sent only on the hop whose URL equals `url`. Used for If-None-Match, so a
  // validator is never offered to (or accepted from) a different resource.
  conditional?: { url: string; headers: Record<string, string> };
  maxBytes?: number;
  timeoutMs?: number; // whole call: DNS, policy waits, every redirect, the body
  truncate?: boolean; // return the first maxBytes instead of failing
  signal?: AbortSignal;
  // Called before every hop (first request and each redirect). The polite
  // layer uses it for robots.txt, cooldowns and crawl-delay.
  beforeRequest?: (u: URL, signal: AbortSignal) => Promise<void>;
  beforeSend?: (u: URL) => void; // synchronous recheck after policy waits and signing, immediately before dispatch
  // Called for EVERY hop as soon as its headers arrive, before the body is read
  // and before any redirect is followed. It may throw to stop the call. This is
  // where Retry-After is recorded and where a challenged redirect is caught, so
  // neither depends on the body being read in full.
  onHeaders?: (hop: { url: URL; status: number; headers: Headers; redirect: boolean }) => void;
  // W-04 form submission. `method` and `body` (and `firstHeaders`) apply to the FIRST hop only.
  method?: "GET" | "POST";
  body?: Buffer;
  firstHeaders?: Record<string, string>;
  // With `submit`, no redirect is followed (Codex round 52): a 3xx comes back as the final response.
  submit?: boolean;
  // W-04: the cookies of one submit call; each hop gets only the ones its own host set.
  cookies?: { header(u: URL): string | undefined };
  // v0.7: the most bytes this fetch's connections may receive, all hops together (default: the body cap plus WIRE_EXTRA).
  wireBytes?: number;
  // W-28 (v0.8): keep a page's received body (`RawResponse.raw`) for a saved snapshot.
  keepRaw?: boolean;
  // Rendering hands each redirect back to Chrome, so its URL and CORS rules see every hop.
  followRedirects?: boolean;
  // W-20: hash a file response (status 200) up to its own cap instead of stopping at its first bytes.
  files?: FileOptions;
}

function positiveInt(v: unknown, name: string): number {
  const n = typeof v === "string" ? (/^\d+$/.test(v.trim()) ? Number(v) : NaN) : Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new ConfigError(`${name} must be a positive whole number, got "${String(v).slice(0, 40)}".`);
  return n;
}

// The most bytes Tiresias reads from one response (TIRESIAS_MAX_BYTES, default 5 MB). A page a
// person provides for a handoff (W-06) is held to the same cap.
export const fetchCap = (): number => positiveInt(process.env.TIRESIAS_MAX_BYTES ?? LIMITS.maxBytes, "TIRESIAS_MAX_BYTES");

// W-20: the most bytes of one FILE Tiresias hashes (TIRESIAS_MAX_FILE_BYTES, default 50 MB). Past it the
// download stops and the warning has no fingerprint; a Content-Length over it is not downloaded at all.
export const fileCap = (): number => positiveInt(process.env.TIRESIAS_MAX_FILE_BYTES ?? 50 * 1024 * 1024, "TIRESIAS_MAX_FILE_BYTES");

export { mimeOf } from "./files.js";

// W-17: is this response a PDF? Only the exact type application/pdf, or the first bytes %PDF- when the
// type is missing or a generic binary type. An explicit text or HTML type stays text, whatever its body starts with.
export function isPdf(ct: string | null | undefined, head: Buffer | string): boolean {
  const m = mimeOf(ct);
  if (m === "application/pdf") return true;
  if (m !== "" && m !== "application/octet-stream" && m !== "binary/octet-stream") return false;
  const first = typeof head === "string" ? head.slice(0, 5) : head.subarray(0, 5).toString("latin1");
  return first === "%PDF-";
}

// `Content-Encoding: deflate` is meant to be zlib-wrapped, but many servers send raw deflate, and no prefix
// of the bytes tells them apart for certain (Codex rounds 72 and 73). So a deflate body is collected
// (compressed, up to `cap` bytes) and inflated WHOLE: as zlib, and if that fails, as raw deflate; the
// output is capped at `cap` + 1 bytes, so the size checks after it still see a body that is too large.
// Deflate is rare on the web, so holding the compressed body is a fair price for a sure answer.
async function* inflateWhole(msg: AsyncIterable<Buffer>, cap: number, truncate: boolean): AsyncGenerator<Buffer> {
  // The DECODED cap is applied to the output (by the readers after this); the compressed input gets room
  // for deflate's own framing on top of it (Codex round 74: a stored block is a few bytes larger than its
  // content).
  const inCap = cap + Math.ceil(cap / 1024) * 8 + 1024;
  const parts: Buffer[] = [];
  let size = 0;
  let cut = false;
  for await (const c of msg) {
    size += c.length;
    // Over the compressed budget: refused even for a caller that takes the first bytes (Codex round 82: a
    // partial robots.txt could leave out a Disallow). A truncated decode is never passed on as whole.
    if (size > inCap) throw new FetchError(`Response is larger than ${cap} bytes.`, "too_large");
    parts.push(Buffer.from(c));
  }
  const all = Buffer.concat(parts);
  // Which format: zlib if a zlib inflate of the whole body works (or only runs past the output cap);
  // otherwise raw. Then the body is inflated as a stream, so the size checks after it cut or refuse it.
  let wrapped = true;
  try {
    zlib.inflateSync(all, { maxOutputLength: cap + 1, ...(cut ? { finishFlush: zlib.constants.Z_SYNC_FLUSH } : {}) });
  } catch (e) {
    wrapped = (e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE";
  }
  const z = wrapped ? zlib.createInflate(cut ? { finishFlush: zlib.constants.Z_SYNC_FLUSH } : {}) : zlib.createInflateRaw(cut ? { finishFlush: zlib.constants.Z_SYNC_FLUSH } : {});
  z.end(all);
  try {
    for await (const c of z) yield c as Buffer;
  } catch {
    throw new FetchError("The response could not be read (network or bad compression).", "network");
  } finally {
    z.destroy();
  }
}

// v0.9 hardening (Codex round 1, HIGH): an encoding Tiresias does not decode (a list of several, `compress`,
// `zstd`, anything unknown) used to pass the bytes on as if plain. A compressed robots.txt then parsed as no
// rules at all. Now only no encoding, `identity`, or exactly one of the three Tiresias asks for is read; anything
// else fails the request (robots.txt that cannot be read means "the site says no").
export const UNSUPPORTED_ENCODING = "The response used a compression Tiresias does not read.";
export function decoderFor(encoding: string | undefined) {
  const codings = (encoding ?? "").split(",").map((c) => c.toLowerCase().trim()).filter((c) => c !== "" && c !== "identity");
  if (codings.length === 0) return null;
  if (codings.length > 1) throw new FetchError(UNSUPPORTED_ENCODING, "network");
  switch (codings[0]) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return "deflate" as const; // zlib-wrapped or raw: inflated whole (inflateWhole)
    case "br":
      return zlib.createBrotliDecompress();
    default:
      throw new FetchError(UNSUPPORTED_ENCODING, "network");
  }
}

type Body = { page: Buffer; truncated: boolean; verdict: Verdict } | { file: FileFacts };
type Declared = { contentType: string; names: ReturnType<typeof namesOf> };

// Read one response body. The first bytes (HEAD_BYTES, or the cap when smaller) decide what it is
// (files.ts). A page is kept up to `max` as before. A file is hashed as it streams and never held whole:
// only the first bytes are kept until the decision, then nothing but the running hash (and the last 512
// bytes, for a disk image's trailer). With no `files` option (or a status that is not a success) the body
// is kept as a page whatever it is, as before v0.5.
async function readBody(msg: http.IncomingMessage, max: number, truncate: boolean, signal: AbortSignal, d: Declared, files?: FileOptions): Promise<Body> {
  let chosen: ReturnType<typeof decoderFor>;
  try {
    chosen = decoderFor(msg.headers["content-encoding"] as string | undefined);
  } catch (e) {
    msg.destroy();
    throw e;
  }
  let dec = chosen === "deflate" ? null : chosen;
  // Cap applies to the DECODED bytes, so a small compressed bomb cannot slip past.
  const source: AsyncIterable<Buffer> =
    chosen === "deflate" ? inflateWhole(msg, Math.max(max, files ? files.maxBytes : 0), truncate) : dec ? (pipeline(msg, dec, () => {}) as unknown as AsyncIterable<Buffer>) : msg;
  // A deadline or a cancellation ends the read at once (the stream is destroyed with the reason).
  const onAbort = () => {
    msg.destroy(signal.reason);
    dec?.destroy(signal.reason);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  // The head is never longer than either cap allows (Codex round 66: a 1 KB file cap must stop at 1 KB).
  const headCap = Math.min(HEAD_BYTES, max + 1, files ? files.maxBytes + 1 : Infinity);
  let head: Buffer[] = [];
  let firstBytes = Buffer.alloc(0); // the head, kept (at most 40 KB) to classify again once the trailer is known
  let headLen = 0;
  // (`as` keeps TypeScript from narrowing these to their first value: the closures below change them.)
  let mode = "head" as "head" | "page" | "file";
  let verdict = null as Verdict | null;
  // page mode
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  // file mode
  let intake = null as FileIntake | null;
  let size = 0;
  let tail = Buffer.alloc(0);
  let stopped = undefined as FileFacts["stopped"];
  const facts = (kind: FileKind, flags: FileFlag[]): FileFacts => ({
    kind, risk: RISK[kind], flags, size, ...(stopped ? { stopped } : {}),
    declared_type: d.contentType.slice(0, 200), ...(declaredName(d.names) ? { declared_name: declaredName(d.names) } : {}),
    names: [d.names.disposition, ...(d.names.others ?? []), d.names.url].filter((x): x is string => !!x),
  });
  // For a read (files set) a page candidate is hashed as it comes and its last 512 bytes kept, so a disk
  // image named only by its trailer needs no second pass; and it is held to the file cap as well as the
  // page cap (Codex round 65).
  const pageHash = files ? createHash("sha256") : null;
  const pageMax = files ? Math.min(max, files.maxBytes) : max;
  const toPage = (c: Buffer): boolean => {
    if (pageHash) {
      if (total + c.length > pageMax) throw new FetchError(`Response is larger than ${pageMax} bytes.`, "too_large");
      pageHash.update(c);
      tail = c.length >= 512 ? Buffer.from(c.subarray(c.length - 512)) : Buffer.concat([tail, c]).subarray(-512);
    }
    if (total + c.length > max) {
      if (!truncate) throw new FetchError(`Response is larger than ${max} bytes.`, "too_large");
      chunks.push(c.subarray(0, max - total));
      total = max;
      truncated = true;
      return false;
    }
    total += c.length;
    chunks.push(c);
    return true;
  };
  const toFile = (c: Buffer): boolean => {
    const ok = intake!.write(c);
    size = intake!.size;
    if (!ok) {
      stopped = "too_large";
      return false;
    }
    tail = c.length >= 512 ? Buffer.from(c.subarray(c.length - 512)) : Buffer.concat([tail, c]).subarray(-512);
    return true;
  };
  // Decide from the head, then hand the head's chunks to the chosen mode. False: stop reading.
  const decide = (): boolean => {
    firstBytes = Buffer.concat(head).subarray(0, HEAD_BYTES);
    verdict = classify(firstBytes, d.contentType, d.names);
    const kept = head;
    head = [];
    if ("read" in verdict || !files) {
      mode = "page";
      for (const c of kept) if (!toPage(c)) return false;
      return true;
    }
    mode = "file";
    intake = new FileIntake(files.maxBytes, files.onFile?.({ kind: verdict.file, risk: RISK[verdict.file] }), files.keep?.(verdict.file, firstBytes) ?? 0);
    for (const c of kept) if (!toFile(c)) return false;
    return true;
  };
  const timedOut = () => signal.reason instanceof FetchError && signal.reason.code === "timeout";
  try {
    try {
      for await (const chunk of source) {
        const c = Buffer.from(chunk);
        if (mode === "head") {
          head.push(c);
          headLen += c.length;
          if (headLen >= headCap && !decide()) break;
        } else if (mode === "page") {
          if (!toPage(c)) break;
        } else if (!toFile(c)) break;
      }
      if (signal.aborted) throw signal.reason;
      if (mode === "head") decide(); // the body ended before the head filled
    } catch (e) {
      if (signal.aborted) {
        // A file that runs out of time is still a file: the warning says so, with no fingerprint.
        if (mode === "file" && verdict && "file" in verdict && timedOut()) {
          intake?.drop();
          stopped = "timeout";
          return { file: facts(verdict.file, verdict.flags) };
        }
        // Out of time before the head filled (Codex round 61): what arrived still names it; a file is a warning.
        if (mode === "head" && files && timedOut()) {
          const v = classify(Buffer.concat(head).subarray(0, HEAD_BYTES), d.contentType, d.names);
          if ("file" in v) {
            size = headLen;
            stopped = "timeout";
            return { file: facts(v.file, v.flags) };
          }
        }
        throw signal.reason;
      }
      if (e instanceof FetchError) throw e;
      throw new FetchError("The response could not be read (network or bad compression).", "network");
    }
  } catch (e) {
    intake?.drop();
    throw e;
  } finally {
    signal.removeEventListener("abort", onAbort);
    msg.destroy();
  }
  const v = verdict!;
  if (mode === "page" || !("file" in v)) {
    // A disk image has no mark at its start, only a trailer: one that arrived looking like text is still a
    // file, never a page (Codex round 63). Only for reads, which hash files; the hash and the trailer were
    // kept as the body came (round 65), and the copy is written in pieces.
    // Once the body has ended its last bytes are known, and the same classification runs again with them
    // (a dmg's only mark is its trailer). A file decided this way is a file like any other: its flags come
    // from the signature, the text check's are dropped (2026-10-20, coordinator after Codex round 67).
    const last = pageHash ? classify(firstBytes, d.contentType, d.names, tail) : v;
    if (pageHash && "file" in last) {
      size = total;
      const f = facts(last.file, last.flags);
      f.sha256 = pageHash.digest("hex");
      const copy = files!.onFile?.({ kind: last.file, risk: RISK[last.file] });
      if (copy) {
        for (const c of chunks) copy.write(c);
        const q = copy.done();
        if (q) f.quarantine = q;
      }
      return { file: f };
    }
    return { page: Buffer.concat(chunks), truncated, verdict: v };
  }
  if (stopped || !intake) {
    intake?.drop();
    return { file: facts(v.file, v.flags) };
  }
  // The same classification again, now with the trailer (a dmg has no mark at its start).
  const final = classify(firstBytes, d.contentType, d.names, tail);
  const f = "file" in final ? facts(final.file, final.flags) : facts(v.file, v.flags);
  Object.assign(f, intake.finish());
  return { file: f };
}

// Pick a text decoder: byte-order mark, then the HTTP charset, then a <meta>
// charset in the first 2 KB of HTML, else UTF-8.
export function decode(buf: Buffer, contentType: string | null): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return new TextDecoder("utf-8").decode(buf.subarray(3));
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf.subarray(2));
  let label = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1];
  if (!label && (!contentType || /html/i.test(contentType))) {
    const head = buf.subarray(0, 2048).toString("latin1");
    label = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(label ?? "utf-8").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

function toHeaders(h: http.IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    for (const x of Array.isArray(v) ? v : [v]) out.append(k, x);
  }
  return out;
}

// v0.7 (Banks, after Codex round 5 on W-10): EVERY request is capped, and counted, by the bytes its connection
// receives: status lines and headers of every response (1xx informational ones included), the body as sent (still
// compressed, if it was), chunk framing and trailers. The decoded-size caps stay as a second check. The count is the
// socket's `bytesRead`: on plain http the bytes off the wire, on https the bytes after TLS decryption (Node's
// TLSSocket counts the plaintext; TLS records and the handshake are not counted). The cap and every charge use this
// same count. Each request has its own connection (agent: false), and the count is the change since the socket was
// handed to the request, so a reused socket could never be charged its earlier bytes.
// A read is checked as each chunk arrives, so the count can pass the cap by at most one read of the socket
// (READ_SLACK: Node reads at most 64 KB at a time).
export const READ_SLACK = 64 * 1024;
// What one request may receive beyond its body cap when the caller does not say: headers, redirects, 1xx, framing.
export const WIRE_EXTRA = 1024 * 1024;
const WIRE_TEXT = "The site sent more than Tiresias reads for one request. It was not read.";
export class Wire {
  total = 0;
  over = false;
  constructor(readonly cap: number) {}
  // Integration round 1 (Codex): once over, the whole fetch is over. Every socket that passes the cap is cut, and a
  // socket handed to a later hop after the cap was passed is cut before it reads anything; callers also check
  // `assertUnder` before following a redirect and before returning a response (a read that crosses the cap can
  // complete a response's headers in the same chunk).
  watch(req: http.ClientRequest): void {
    req.on("socket", (sock) => {
      if (this.over) {
        sock.destroy(new FetchError(WIRE_TEXT, "too_large"));
        return;
      }
      const base = sock.bytesRead;
      let seen = 0;
      const count = () => {
        const now = sock.bytesRead - base;
        this.total += now - seen;
        seen = now;
        if (this.total > this.cap) {
          this.over = true;
          if (!sock.destroyed) sock.destroy(new FetchError(WIRE_TEXT, "too_large"));
        }
      };
      sock.on("data", count);
      sock.once("close", count);
    });
  }
  assertUnder(): void {
    if (this.over || this.total > this.cap) {
      this.over = true;
      throw new FetchError(WIRE_TEXT, "too_large");
    }
  }
}

// v0.7: one plain GET, no redirects, guarded lookup, capped by its connection's bytes (Wire). For API calls to a
// fixed endpoint (Google Web Risk), never for a site. The body is read up to `bodyMax`; past it, null.
export function boundedGet(url: string, headers: Record<string, string>, bodyMax: number, wire: Wire, signal: AbortSignal): Promise<{ status: number; body: Buffer | null }> {
  return new Promise((resolve, reject) => {
    const u = parseSafeUrl(url);
    assertLiteral(u);
    assertPort(u);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request({ hostname: u.hostname.replace(/^\[|\]$/g, ""), port: u.port || undefined, path: u.pathname + u.search, method: "GET", headers, lookup: guardedLookup as never, agent: false, signal }, (res) => {
      if (res.statusCode !== 200) {
        res.destroy();
        return resolve({ status: res.statusCode ?? 0, body: null });
      }
      const chunks: Buffer[] = [];
      let n = 0;
      res.on("data", (c: Buffer) => {
        n += c.length;
        if (n > bodyMax) {
          res.destroy();
          return resolve({ status: 200, body: null });
        }
        chunks.push(c);
      });
      res.on("end", () => (wire.over ? reject(new FetchError(WIRE_TEXT, "too_large")) : resolve({ status: 200, body: Buffer.concat(chunks) })));
      res.on("error", reject);
    });
    wire.watch(req);
    req.on("error", reject);
    req.end();
  });
}

function requestOnce(u: URL, headers: Record<string, string>, signal: AbortSignal, onSent?: () => void, method = "GET", body?: Buffer, wire?: Wire): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        hostname: u.hostname.replace(/^\[|\]$/g, ""),
        port: u.port || undefined,
        path: u.pathname + u.search,
        method,
        headers: body ? { ...headers, "content-length": String(body.length) } : headers,
        lookup: guardedLookup as never,
        agent: false, // no connection reuse: each hop is its own checked connection
        signal,
      },
      resolve,
    );
    wire?.watch(req);
    req.on("error", reject);
    req.once("finish", () => onSent?.()); // the request has really been written out (not a DNS failure or a refusal)
    if (body) req.end(body);
    else req.end();
  });
}

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<RawResponse> {
  const max = opts.maxBytes !== undefined ? positiveInt(opts.maxBytes, "maxBytes") : fetchCap();
  const timeoutMs = positiveInt(opts.timeoutMs ?? LIMITS.timeoutMs, "timeoutMs");
  const ctl = new AbortController();
  // The request timer measures the SITE (DNS, connection, answer, body). Policy waits (robots.txt,
  // Crawl-delay spacing, the per-host queue) pause it and run on the call's own 60-second deadline
  // instead (v0.5.1: a Crawl-delay of 20 seconds was reported as "The site took too long to answer").
  let left = timeoutMs;
  let since = Date.now();
  const fire = () => ctl.abort(new FetchError("The site took too long to answer.", "timeout"));
  let timer: NodeJS.Timeout | undefined = setTimeout(fire, left);
  const pause = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    left -= Date.now() - since;
  };
  const resume = () => {
    if (timer !== undefined || ctl.signal.aborted) return;
    since = Date.now();
    timer = setTimeout(fire, Math.max(0, left));
  };
  // v0.6: a shutdown ends every request too. Every listener is removed when the request ends (Codex round 4: the
  // process-wide shutdown signal otherwise kept one per request ever made).
  const listening: [AbortSignal, () => void][] = [];
  for (const s of [scope.getStore()?.signal, opts.signal, shutdownSignal]) {
    if (!s) continue;
    const cancel = () => ctl.abort(new FetchError("The request was cancelled.", "cancelled"));
    if (s.aborted) cancel();
    else {
      s.addEventListener("abort", cancel, { once: true });
      listening.push([s, cancel]);
    }
  }
  // Race any await against the deadline, so a stalled DNS lookup or robots
  // fetch cannot outlive it.
  const abortable = <T>(p: Promise<T>): Promise<T> =>
    Promise.race([
      p,
      new Promise<never>((_, rej) => {
        if (ctl.signal.aborted) rej(ctl.signal.reason);
        else ctl.signal.addEventListener("abort", () => rej(ctl.signal.reason), { once: true });
      }),
    ]);

  // v0.7: the connection bytes of every hop of this fetch together, capped (Wire, above).
  const wire = new Wire(opts.wireBytes !== undefined ? positiveInt(opts.wireBytes, "wireBytes") : Math.max(max, opts.files ? opts.files.maxBytes : 0) + WIRE_EXTRA);
  try {
    let u = parseSafeUrl(rawUrl);
    const method = opts.method ?? "GET";
    const body = opts.body;
    for (let hop = 0; hop <= LIMITS.maxRedirects; hop++) {
      assertLiteral(u);
      assertPort(u);
      assertSiteAllowed(u); // W-25 (v0.6): the owner's never_visit and hand_off, on every hop
      // W-19: the Safe Browsing check comes before anything is sent to this hop's host, robots.txt included.
      // v0.6 (Codex round 7): it can wait (a list download, a site spacing on the Web Risk endpoint), so it runs
      // on the call's deadline with the site's own request timer paused, like every policy wait.
      const gate = scope.getStore()?.gate;
      if (gate) {
        pause();
        try {
          await abortable(gate(u));
        } finally {
          resume();
        }
      }
      // Policy work (robots, cooldown, crawl-delay queue) runs under THIS call's
      // deadline and cancellation, including any robots fetch it makes.
      if (opts.beforeRequest) {
        const before = opts.beforeRequest;
        pause();
        try {
          await abortable(scope.run({ ...scope.getStore(), signal: ctl.signal }, () => before(u, ctl.signal)));
        } finally {
          resume();
        }
      }
      const headers: Record<string, string> = {
        "user-agent": USER_AGENT,
        accept: ACCEPT, // W-23 (v0.5.1): markdown first, for sites that hand agents markdown
        "accept-encoding": "gzip, deflate, br",
        ...opts.headers,
        ...(opts.conditional && opts.conditional.url === u.href ? opts.conditional.headers : {}),
        ...(hop === 0 ? opts.firstHeaders : {}),
      };
      const cookie = opts.cookies?.header(u);
      if (cookie) headers.cookie = cookie;
      // N-07: sign this hop for its own authority. A signing error fails the call; it never sends unsigned.
      const signed = mayCarrySignature(u) ? await abortable(signingHeaders(u)) : null;
      if (signed) Object.assign(headers, signed);
      const sent = scope.getStore()?.sent;
      // Counted when the request is actually written to the connection, not when headers are built.
      const onSent = () => {
        if (sent) (sent.requests++, signed && sent.signed++);
      };
      if (!opts.submit && (hop > 0 || method === "GET")) guardGetAction(u);
      opts.beforeSend?.(u);
      let msg: http.IncomingMessage;
      try {
        msg = await abortable(requestOnce(u, headers, ctl.signal, onSent, hop === 0 ? method : "GET", hop === 0 ? body : undefined, wire));
      } catch (e) {
        if (ctl.signal.aborted) throw ctl.signal.reason;
        if (wire.over) throw new FetchError(WIRE_TEXT, "too_large");
        if (e instanceof SafetyError || e instanceof FetchError) throw e;
        throw new FetchError("The network request failed.", "network", (e as Error).message);
      }
      const status = msg.statusCode ?? 0;
      const location = msg.headers.location;
      if (opts.onHeaders) {
        try {
          opts.onHeaders({ url: u, status, headers: toHeaders(msg.headers), redirect: REDIRECTS.has(status) && !!location });
        } catch (e) {
          msg.destroy();
          throw e;
        }
      }
      // The read that crossed the cap may have completed these headers. Checked AFTER onHeaders (integration round
      // 2): headers that did arrive are still honoured for politeness (a Retry-After is recorded), never followed.
      try {
        wire.assertUnder();
      } catch (e) {
        msg.destroy();
        throw e;
      }
      // A submit follows no redirect at all (Codex round 52): any 3xx is its final answer.
      if (!opts.submit) {
        let next: URL | null;
        try {
          next = redirectTarget(u, status, location);
        } catch (e) {
          msg.destroy();
          throw e;
        }
        if (next) {
          msg.destroy();
          wire.assertUnder();
          if (opts.followRedirects === false)
            return { status, headers: toHeaders(msg.headers), body: "", url: u.href, redirected: hop > 0, truncated: false, size: wire.total };
          u = next;
          continue;
        }
      }
      const ct = msg.headers["content-type"] ?? null;
      const declared: Declared = { contentType: ct ?? "", names: namesOf(msg.headers["content-disposition"] ?? null, u.href) };
      const redirected = hop > 0;
      // A read only ever reads a 200; a form's answer is any success (Codex round 58: a 201 is hashed too).
      const files = status === 200 || (opts.submit && status >= 200 && status < 300) ? opts.files : undefined;
      // W-20: a file the site says is over the file cap is not downloaded at all. A page that size was
      // never going to be read either, so it fails as too large, as before.
      // Any run of digits (leading zeroes included: Codex round 60); a huge one is simply over the cap.
      const cl = /^\d+$/.test(String(msg.headers["content-length"] ?? "")) ? Number(msg.headers["content-length"]) : NaN;
      if (files && cl > files.maxBytes) {
        msg.destroy();
        const v = classify(Buffer.alloc(0), declared.contentType, declared.names);
        if ("read" in v)
          throw new FetchError(v.read === "pdf" ? `This PDF is larger than ${max} bytes (the site says ${cl}), the most Tiresias will read. It was not read.` : `Response is larger than ${max} bytes.`, "too_large");
        const name = declaredName(declared.names);
        const file: FileFacts = {
          kind: "unknown", risk: RISK.unknown, flags: v.flags.filter((f) => f === "double_extension"), size: 0, stopped: "not_downloaded",
          declared_type: declared.contentType.slice(0, 200), ...(name ? { declared_name: name } : {}), declared_size: String(cl),
        };
        return { status, headers: toHeaders(msg.headers), body: "", url: u.href, redirected, truncated: false, file };
      }
      let read: Body;
      try {
        read = await readBody(msg, max, !!opts.truncate, ctl.signal, declared, files);
      } catch (e) {
        if (e instanceof FetchError && e.code === "too_large" && mimeOf(ct) === "application/pdf") {
          throw new FetchError(`This PDF is larger than ${max} bytes${Number.isFinite(cl) && cl > 0 ? ` (the site says ${cl})` : ""}, the most Tiresias will read. It was not read.`, "too_large");
        }
        throw e;
      }
      wire.assertUnder();
      if ("file" in read) {
        if (Number.isFinite(cl)) read.file.declared_size = String(cl);
        return { status, headers: toHeaders(msg.headers), body: "", url: u.href, redirected, truncated: false, file: read.file };
      }
      const { page: buf, truncated, verdict } = read;
      const common = { status, headers: toHeaders(msg.headers), url: u.href, redirected, truncated, size: wire.total, ...("read" in verdict ? { read: verdict.read } : {}), fileFlags: verdict.flags };
      const kept = opts.keepRaw ? { raw: buf } : {};
      if ("read" in verdict && verdict.read === "pdf") return { ...common, ...kept, body: "", bytes: buf };
      return { ...common, ...kept, body: decode(buf, ct) };
    }
    throw new FetchError(`More than ${LIMITS.maxRedirects} redirects.`, "too_many_redirects");
  } catch (e) {
    if (ctl.signal.aborted && ctl.signal.reason instanceof Error) throw ctl.signal.reason;
    if (wire.over) throw new FetchError(WIRE_TEXT, "too_large"); // whatever error the cut connection surfaced as
    throw e;
  } finally {
    for (const [s, f] of listening) s.removeEventListener("abort", f);
    clearTimeout(timer);
  }
}
