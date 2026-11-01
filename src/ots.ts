// SPDX-License-Identifier: Apache-2.0
// W-08 (v0.8): the small part of the OpenTimestamps format Tiresias needs, written here instead of adding a package.
// A timestamp is a tree: each node holds a message; operations lead from a node's message to child nodes; attestations
// say "this message existed at this time" (pending at a calendar, or in a Bitcoin block). Only the operations
// calendars use are supported (sha256, append, prepend, and ripemd160 from older proofs); anything else (sha1,
// keccak256, reverse, hexlify) is refused, so nothing is kept that Tiresias cannot compute. Limits follow the reference implementation (python-opentimestamps): messages and arguments at most
// 4,096 bytes, attestation payloads 8,192, calendar addresses 1,000, nesting under 256.
import { createHash } from "node:crypto";

export const MAGIC = Buffer.concat([Buffer.from([0x00]), Buffer.from("OpenTimestamps"), Buffer.from([0x00, 0x00]), Buffer.from("Proof"), Buffer.from([0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94])]);
export const SHA256 = 0x08;
export const RIPEMD160 = 0x03; // in older Bitcoin proofs; read and computed, never written by Tiresias
export const APPEND = 0xf0;
export const PREPEND = 0xf1;
export const PENDING = Buffer.from("83dfe30d2ef90c8e", "hex");
export const BITCOIN = Buffer.from("0588960d73d71901", "hex");
const LITECOIN = Buffer.from("06869a0d73d71b45", "hex");
const ETHEREUM = Buffer.from("30fe8087b5c7ead7", "hex");
const MAX_MSG = 4096;
const MAX_PAYLOAD = 8192;
const MAX_URI = 1000;
const MAX_DEPTH = 256;
const MAX_NODES = 20_000; // in one parsed timestamp (a calendar answer is at most 10 KB; a stored proof far less)
const URI_RE = /^[A-Za-z0-9._\-/:]+$/; // the reference implementation's allowed characters

export class OtsError extends Error {}

export interface Op {
  tag: number;
  arg?: Buffer;
}
export interface Att {
  tag: Buffer; // 8 bytes
  payload: Buffer;
}
export interface Stamp {
  msg: Buffer;
  atts: Att[];
  ops: { op: Op; next: Stamp }[];
}

export const sha = (b: Buffer): Buffer => createHash("sha256").update(b).digest();
export const newStamp = (msg: Buffer): Stamp => ({ msg, atts: [], ops: [] });

export function apply(op: Op, msg: Buffer): Buffer {
  let out: Buffer;
  if (op.tag === SHA256) out = sha(msg);
  else if (op.tag === RIPEMD160) out = createHash("ripemd160").update(msg).digest();
  else if (op.tag === APPEND) out = Buffer.concat([msg, op.arg!]);
  else if (op.tag === PREPEND) out = Buffer.concat([op.arg!, msg]);
  else throw new OtsError("unsupported operation");
  if (out.length > MAX_MSG) throw new OtsError("message too long");
  return out;
}

// ---- writing ----

class Writer {
  parts: Buffer[] = [];
  nodes = 0;
  byte(n: number) {
    this.parts.push(Buffer.from([n]));
  }
  bytes(b: Buffer) {
    this.parts.push(b);
  }
  varuint(n: number) {
    const out: number[] = [];
    do {
      let b = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) b |= 0x80;
      out.push(b);
    } while (n > 0);
    this.parts.push(Buffer.from(out));
  }
  varbytes(b: Buffer) {
    this.varuint(b.length);
    this.bytes(b);
  }
  done = () => Buffer.concat(this.parts);
}

const cmpAtt = (a: Att, b: Att) => Buffer.compare(a.tag, b.tag) || Buffer.compare(a.payload, b.payload);
const cmpOp = (a: Op, b: Op) => a.tag - b.tag || Buffer.compare(a.arg ?? Buffer.alloc(0), b.arg ?? Buffer.alloc(0));
const sameOp = (a: Op, b: Op) => cmpOp(a, b) === 0;

function writeAtt(w: Writer, a: Att) {
  w.bytes(a.tag);
  w.varbytes(a.payload);
}
function writeOp(w: Writer, o: Op) {
  w.byte(o.tag);
  if (o.tag !== SHA256 && o.tag !== RIPEMD160) w.varbytes(o.arg!);
}
// The reference serialization: every item but the last is preceded by 0xff; an attestation is 0x00 then its tag and
// payload; an operation is its tag (and argument) then the child timestamp.
function writeStamp(w: Writer, s: Stamp, depth = 0) {
  if (depth >= MAX_DEPTH) throw new OtsError("too deep");
  if (++w.nodes > MAX_NODES) throw new OtsError("too many nodes");
  if (!s.atts.length && !s.ops.length) throw new OtsError("an empty timestamp cannot be written");
  const atts = [...s.atts].sort(cmpAtt);
  const ops = [...s.ops].sort((a, b) => cmpOp(a.op, b.op));
  for (const a of atts.slice(0, -1)) {
    w.bytes(Buffer.from([0xff, 0x00]));
    writeAtt(w, a);
  }
  if (!ops.length) {
    w.byte(0x00);
    writeAtt(w, atts[atts.length - 1]);
    return;
  }
  if (atts.length) {
    w.bytes(Buffer.from([0xff, 0x00]));
    writeAtt(w, atts[atts.length - 1]);
  }
  ops.forEach((o, i) => {
    if (i < ops.length - 1) w.byte(0xff);
    writeOp(w, o.op);
    writeStamp(w, o.next, depth + 1);
  });
}
// Reserve the operations/nodes that will precede this timestamp in a detached proof.
export function serialize(s: Stamp, prefix = 0): Buffer {
  const w = new Writer();
  w.nodes = prefix;
  writeStamp(w, s, prefix);
  return w.done();
}
// A detached timestamp file (.ots) for a SHA-256 file digest.
export function fileBytes(digest: Buffer, s: Stamp): Buffer {
  if (digest.length !== 32 || !digest.equals(s.msg)) throw new OtsError("the digest does not start the timestamp");
  const w = new Writer();
  w.bytes(MAGIC);
  w.varuint(1);
  w.byte(SHA256);
  w.bytes(digest);
  writeStamp(w, s);
  return w.done();
}

// ---- reading ----

class Reader {
  pos = 0;
  nodes = 0;
  constructor(readonly buf: Buffer) {}
  byte(): number {
    if (this.pos >= this.buf.length) throw new OtsError("ends too early");
    return this.buf[this.pos++];
  }
  bytes(n: number): Buffer {
    if (this.pos + n > this.buf.length) throw new OtsError("ends too early");
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return Buffer.from(b);
  }
  varuint(): number {
    let v = 0;
    for (let shift = 0; ; shift += 7) {
      if (shift > 49) throw new OtsError("number too large");
      const b = this.byte();
      v += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return v;
    }
  }
  varbytes(max: number, min = 0): Buffer {
    const n = this.varuint();
    if (n > max || n < min) throw new OtsError("length out of range");
    return this.bytes(n);
  }
  eof(): void {
    if (this.pos !== this.buf.length) throw new OtsError("unexpected bytes at the end");
  }
}

function readAtt(r: Reader): Att {
  const tag = r.bytes(8);
  const payload = r.varbytes(MAX_PAYLOAD);
  const p = new Reader(payload);
  if (tag.equals(PENDING)) {
    const uri = p.varbytes(MAX_URI).toString("latin1");
    if (!URI_RE.test(uri)) throw new OtsError("bad calendar address");
    p.eof();
  } else if (tag.equals(BITCOIN) || tag.equals(LITECOIN) || tag.equals(ETHEREUM)) {
    const height = p.varuint();
    if (!tag.equals(ETHEREUM) && height > 0xffffffff) throw new OtsError("block height too large");
    p.eof();
  }
  return { tag, payload };
}
function readOp(r: Reader, tag: number): Op {
  if (tag === SHA256 || tag === RIPEMD160) return { tag };
  if (tag === APPEND || tag === PREPEND) return { tag, arg: r.varbytes(MAX_MSG, 1) };
  throw new OtsError("unsupported operation");
}
function readStamp(r: Reader, msg: Buffer, depth: number): Stamp {
  if (depth >= MAX_DEPTH) throw new OtsError("too deep");
  if (++r.nodes > MAX_NODES) throw new OtsError("too many nodes");
  const s = newStamp(msg);
  const one = (tag: number) => {
    if (tag === 0x00) {
      const a = readAtt(r);
      if (!s.atts.some((x) => cmpAtt(x, a) === 0)) s.atts.push(a);
      return;
    }
    const op = readOp(r, tag);
    const next = readStamp(r, apply(op, msg), depth + 1);
    const same = s.ops.find((o) => sameOp(o.op, op));
    if (same) merge(same.next, next);
    else s.ops.push({ op, next });
  };
  let tag = r.byte();
  while (tag === 0xff) {
    one(r.byte());
    tag = r.byte();
  }
  one(tag);
  return s;
}
// A timestamp starting at `msg` (a calendar's answer, or a stored proof). The whole buffer must be one timestamp.
export function parse(msg: Buffer, buf: Buffer): Stamp {
  const r = new Reader(buf);
  const s = readStamp(r, msg, 0);
  r.eof();
  return s;
}
export function parseFile(buf: Buffer): { digest: Buffer; stamp: Stamp } {
  const r = new Reader(buf);
  if (!r.bytes(MAGIC.length).equals(MAGIC)) throw new OtsError("not an OpenTimestamps proof");
  if (r.varuint() !== 1) throw new OtsError("unknown version");
  if (r.byte() !== SHA256) throw new OtsError("the file digest is not SHA-256");
  const digest = r.bytes(32);
  const stamp = readStamp(r, digest, 0);
  r.eof();
  return { digest, stamp };
}

// ---- merging and walking ----

// Add everything `b` holds to `a` (both start at the same message).
export function merge(a: Stamp, b: Stamp, depth = 0): void {
  if (depth >= MAX_DEPTH) throw new OtsError("too deep");
  if (!a.msg.equals(b.msg)) throw new OtsError("timestamps for different messages");
  for (const x of b.atts) if (!a.atts.some((y) => cmpAtt(x, y) === 0)) a.atts.push(x);
  for (const o of b.ops) {
    const same = a.ops.find((p) => sameOp(p.op, o.op));
    if (same) merge(same.next, o.next, depth + 1);
    else a.ops.push(o);
  }
}

export function* nodes(s: Stamp): Generator<Stamp> {
  const stack = [s];
  while (stack.length) {
    const n = stack.pop()!;
    yield n;
    for (const o of n.ops) stack.push(o.next);
  }
}

export type AttInfo = { kind: "pending"; uri: string } | { kind: "bitcoin"; height: number } | { kind: "other"; tag: string };
export function describe(a: Att): AttInfo {
  const p = new Reader(a.payload);
  if (a.tag.equals(PENDING)) return { kind: "pending", uri: p.varbytes(MAX_URI).toString("latin1") };
  if (a.tag.equals(BITCOIN)) return { kind: "bitcoin", height: p.varuint() };
  return { kind: "other", tag: a.tag.toString("hex") };
}
export function attestations(s: Stamp): { msg: Buffer; att: AttInfo; node: Stamp }[] {
  const out: { msg: Buffer; att: AttInfo; node: Stamp }[] = [];
  for (const n of nodes(s)) for (const a of n.atts) out.push({ msg: n.msg, att: describe(a), node: n });
  return out;
}
export const pendingAtt = (uri: string): Att => {
  const w = new Writer();
  w.varbytes(Buffer.from(uri, "latin1"));
  return { tag: PENDING, payload: w.done() };
};
export const bitcoinAtt = (height: number): Att => {
  const w = new Writer();
  w.varuint(height);
  return { tag: BITCOIN, payload: w.done() };
};
// Append a chain of operations to a node; returns the last node.
export function chain(s: Stamp, ops: Op[]): Stamp {
  let cur = s;
  for (const op of ops) {
    const next = newStamp(apply(op, cur.msg));
    cur.ops.push({ op, next });
    cur = next;
  }
  return cur;
}
