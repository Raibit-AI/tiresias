// SPDX-License-Identifier: Apache-2.0
// W-38 (v1.2): the meaning check's one network client. It talks to the owner's OWN embedding endpoint (LM Studio,
// Ollama, or any OpenAI-compatible /v1/embeddings), never to a site, so it is deliberately not the page fetcher:
// no robots.txt, no signing, no spacing, no cache, no Tiresias user agent promise. What it keeps from the fetcher's
// hardening is what protects the owner: one request, no redirect ever followed, a hard timeout, a cap on the bytes
// read, and a reply that is checked in full before a single number from it is used.
//
// Where it may send: the setting's address is resolved here, at call time, and the connection goes to the address
// that was checked (no second lookup). An address on this machine or the owner's network (loopback, private, link
// local, CGNAT 100.64.0.0/10 that Tailscale uses) is fine. Anything else means page text would leave the owner's
// network, so it needs `allow_public`, which only `tiresias guard setup` writes and only with the typed
// confirmation; plain http to such an address is refused whatever the setting says.
//
// The key: TIRESIAS_GUARD_KEY, read from the environment at call time and sent as a Bearer token. It is never
// stored, logged or put in a reply or an error.
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { isOwnerAddress } from "./guardnetwork.js";
import type { GuardConfig } from "./config.js";

// Every reason a call can fail, as a fixed code. Error text never carries the reply, the address or a page's words.
export type EmbedFailure = "refused_public" | "refused_http" | "dns" | "network" | "timeout" | "cancelled" | "http_status" | "redirect" | "too_large" | "bad_json" | "bad_shape" | "wrong_count" | "wrong_dimension" | "not_finite" | "zero_vector";
const WORDS: Record<EmbedFailure, string> = {
  refused_public: "the endpoint's address is not on this machine or your network, and sending page text there was not confirmed",
  refused_http: "the endpoint's address is not on this machine or your network, and plain http to it is refused",
  dns: "the endpoint's name could not be looked up",
  network: "the endpoint could not be reached",
  timeout: "the endpoint did not answer in time",
  cancelled: "the call was cancelled",
  http_status: "the endpoint answered with an error status",
  redirect: "the endpoint answered with a redirect, which is never followed",
  too_large: "the endpoint's answer was larger than allowed",
  bad_json: "the endpoint's answer was not JSON",
  bad_shape: "the endpoint's answer did not have a data list of embeddings",
  wrong_count: "the endpoint returned a different number of embeddings than texts sent",
  wrong_dimension: "the endpoint returned embeddings of an unexpected length",
  not_finite: "the endpoint returned a number that is not finite",
  zero_vector: "the endpoint returned an embedding of all zeros",
};
export class EmbedError extends Error {
  constructor(public readonly code: EmbedFailure, public readonly status?: number) {
    super(`The embedding call failed: ${WORDS[code]}${status !== undefined ? ` (HTTP ${status})` : ""}.`);
  }
}

// Bounds. A batch is at most MAX_BATCH texts; a reply at most MAX_REPLY bytes (64 texts of 4,096 numbers written
// out in full is about 6 MB); a dimension from 8 to 8,192.
export const MAX_BATCH = 64;
export const MAX_REPLY = 16 * 1024 * 1024;
export const MIN_DIM = 8;
export const MAX_DIM = 8192;
// v1.2: the whole input, including the configured prefix, must fit. Never silently embed a truncated text.
export const MAX_INPUT_CHARS = 8_000;

const isLoopbackName = (h: string) => h === "localhost" || h.endsWith(".localhost");
const bare = (h: string) => (h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h);

// The addresses a host name stands for, every one checked. A literal address is used as it is.
async function resolve(host: string, signal: AbortSignal): Promise<{ address: string; family: number }[]> {
  if (signal.aborted) throw new EmbedError(signal.reason === "timeout" ? "timeout" : "cancelled");
  const h = bare(host);
  if (net.isIP(h)) return [{ address: h, family: net.isIP(h) }];
  const lookup = dns.promises.lookup(isLoopbackName(h) ? "localhost" : h, { all: true, verbatim: true });
  const abort = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new EmbedError(signal.reason === "timeout" ? "timeout" : "cancelled")), { once: true }));
  let found: { address: string; family: number }[];
  try {
    found = await Promise.race([lookup, abort]);
  } catch (e) {
    if (e instanceof EmbedError) throw e;
    throw new EmbedError("dns");
  }
  if (!found.length) throw new EmbedError("dns");
  return found;
}

// "local" when every address is loopback, private, link local or CGNAT: page text stays on the owner's network.
export async function classify(url: string, signal = new AbortController().signal): Promise<"local" | "public"> {
  const addrs = await resolve(new URL(url).hostname, signal);
  return addrs.every((a) => isOwnerAddress(a.address)) ? "local" : "public";
}

// The whole check for one address: may page text be sent there under this setting?
export async function destination(cfg: Pick<GuardConfig, "url" | "allow_public">, signal: AbortSignal): Promise<{ address: string; family: number }> {
  const u = new URL(cfg.url);
  const addrs = await resolve(u.hostname, signal);
  const local = addrs.every((a) => isOwnerAddress(a.address));
  if (!local) {
    if (u.protocol !== "https:") throw new EmbedError("refused_http");
    if (cfg.allow_public !== true) throw new EmbedError("refused_public");
  }
  return addrs[0];
}

export interface EmbedOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  dim?: number; // the stored dimension; every vector must have it
}

// One POST to <url>/embeddings with { model, input }, and the vectors from data[i].embedding, each made unit length.
// Throws an EmbedError with a fixed code on anything unexpected.
export async function embed(cfg: Pick<GuardConfig, "url" | "model" | "allow_public">, inputs: string[], opts: EmbedOptions): Promise<Float32Array[]> {
  if (inputs.length === 0) return [];
  if (inputs.length > MAX_BATCH) throw new RangeError("too many texts in one batch");
  if (inputs.some(t => t.length > MAX_INPUT_CHARS)) throw new RangeError("text too long for one embedding input");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort("timeout"), opts.timeoutMs);
  const outer = opts.signal;
  const onOuter = () => ctl.abort("cancelled");
  if (outer?.aborted) ctl.abort("cancelled");
  else outer?.addEventListener("abort", onOuter, { once: true });
  try {
    const to = await destination(cfg, ctl.signal);
    const body = Buffer.from(JSON.stringify({ model: cfg.model, input: inputs }));
    const raw = await post(new URL(cfg.url.replace(/\/+$/, "") + "/embeddings"), body, to, ctl.signal);
    return parseVectors(raw, inputs.length, opts.dim);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuter);
  }
}

function post(u: URL, body: Buffer, to: { address: string; family: number }, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolveP, reject) => {
    const fail = (code: EmbedFailure, status?: number) => reject(new EmbedError(code, status));
    if (signal.aborted) return fail(signal.reason === "timeout" ? "timeout" : "cancelled");
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json", "content-length": String(body.length) };
    const key = process.env.TIRESIAS_GUARD_KEY;
    if (key) headers.authorization = `Bearer ${key}`;
    const mod = u.protocol === "https:" ? https : http;
    // The connection goes to the address checked above: a lookup that answers with it, never a second DNS query.
    const lookup = (_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) =>
      o?.all ? cb(null, [{ address: to.address, family: to.family }]) : cb(null, to.address, to.family);
    const req = mod.request(u, { method: "POST", headers, lookup: lookup as never, agent: false, signal }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.destroy();
        return fail("redirect", status);
      }
      if (status !== 200) {
        res.destroy();
        return fail("http_status", status);
      }
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > MAX_REPLY) {
        res.destroy();
        return fail("too_large");
      }
      const parts: Buffer[] = [];
      let total = 0;
      res.on("data", (c: Buffer) => {
        total += c.length;
        if (total > MAX_REPLY) {
          res.destroy();
          return fail("too_large");
        }
        parts.push(c);
      });
      res.on("end", () => resolveP(Buffer.concat(parts, total)));
      res.on("error", () => fail(signal.aborted ? (signal.reason === "timeout" ? "timeout" : "cancelled") : "network"));
    });
    req.on("error", () => fail(signal.aborted ? (signal.reason === "timeout" ? "timeout" : "cancelled") : "network"));
    req.end(body);
  });
}

// The reply, checked whole: a data list of exactly `count` embeddings (if any item has an index, all must have a
// distinct index in range), each a list of finite numbers of one length (the stored dimension when there is one).
export function parseVectors(raw: Buffer, count: number, dim?: number): Float32Array[] {
  let j: unknown;
  try {
    j = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new EmbedError("bad_json");
  }
  const data = j && typeof j === "object" && !Array.isArray(j) ? (j as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) throw new EmbedError("bad_shape");
  if (data.length !== count) throw new EmbedError("wrong_count");
  let order = data;
  const idx = data.map((d) => (d && typeof d === "object" ? (d as { index?: unknown }).index : undefined));
  if (idx.some((i) => i !== undefined)) {
    if (!idx.every((i) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < count) || new Set(idx).size !== count) throw new EmbedError("bad_shape");
    order = new Array(count);
    data.forEach((d, k) => (order[idx[k] as number] = d));
  }
  const out: Float32Array[] = [];
  let len = dim;
  for (const d of order) {
    const e = d && typeof d === "object" ? (d as { embedding?: unknown }).embedding : undefined;
    if (!Array.isArray(e)) throw new EmbedError("bad_shape");
    if (len === undefined) {
      if (e.length < MIN_DIM || e.length > MAX_DIM) throw new EmbedError("wrong_dimension");
      len = e.length;
    }
    if (e.length !== len) throw new EmbedError("wrong_dimension");
    const v = new Float32Array(len);
    let n = 0;
    let storedNorm = 0;
    for (let i = 0; i < len; i++) {
      const x = e[i];
      if (typeof x !== "number" || !Number.isFinite(x)) throw new EmbedError("not_finite");
      // Reject values outside the stored format before they can become infinities or an all-zero vector.
      const stored = Math.fround(x);
      if (!Number.isFinite(stored)) throw new EmbedError("not_finite");
      storedNorm += stored * stored;
      n += x * x;
    }
    n = Math.sqrt(n);
    if (!(n > 0) || !Number.isFinite(n) || !(storedNorm > 0)) throw new EmbedError("zero_vector");
    let finalNorm = 0;
    for (let i = 0; i < len; i++) {
      v[i] = e[i] / n;
      if (!Number.isFinite(v[i])) throw new EmbedError("not_finite");
      finalNorm += v[i] * v[i];
    }
    if (!(finalNorm > 0) || !Number.isFinite(finalNorm)) throw new EmbedError("zero_vector");
    out.push(v);
  }
  return out;
}

// Several batches in order, within one deadline.
export async function embedAll(cfg: Pick<GuardConfig, "url" | "model" | "allow_public">, inputs: string[], opts: EmbedOptions & { batch?: number; progress?: (done: number) => void }): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  const size = Math.min(opts.batch ?? 32, MAX_BATCH);
  for (let i = 0; i < inputs.length; i += size) {
    const v = await embed(cfg, inputs.slice(i, i + size), { ...opts, dim: opts.dim ?? (out[0]?.length) });
    out.push(...v);
    opts.progress?.(out.length);
  }
  return out;
}
