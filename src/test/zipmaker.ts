// SPDX-License-Identifier: Apache-2.0
// v0.6 tests: a tiny zip WRITER, so tests can build zips byte by byte, including zips that lie. Never used
// outside tests. Each entry may override any field the reader checks.
import zlib from "node:zlib";

export interface ZEntry {
  name: string | Buffer;
  data?: Buffer | string;
  method?: number; // 0 stored, 8 deflated (made here); any other number is written as is, data unchanged
  utf8?: boolean;
  encrypted?: boolean;
  size?: number; // declared unpacked size (default: the real one)
  packed?: number; // declared packed size (default: the real one)
  crc?: number;
  localName?: string | Buffer; // a different name in the local header
  localSize?: number; // a different unpacked size in the local header
  unixMode?: number; // made on Unix, with this mode in the external attributes
  dosAttr?: number; // made on DOS (host 0), with these attributes (0x10: a folder)
  cdExtra?: Buffer;
  localOffset?: number; // point the directory record at another offset
  skipCd?: boolean; // write the local header and data, but leave the entry out of the directory
  localFlags?: number; // other general-purpose flags in the local header
  localExtra?: Buffer; // extra fields in the local header
  packedData?: Buffer; // write these bytes as the packed data, as they are
  descriptor?: { crc?: number; packed?: number; size?: number; mark?: boolean; wide?: boolean }; // sizes deferred to a data descriptor
  gpExtra?: number; // more general-purpose flag bits, in both headers
  zip64Sizes?: boolean; // sizes as 0xFFFFFFFF with the real ones in ZIP64 extra fields (both headers)
}
export interface ZOpts {
  prefix?: Buffer; // bytes before the zip (as in a self-extracting program)
  trailing?: Buffer; // bytes after the end record
  count?: number; // the entry count the end record claims
  cdOffsetDelta?: number; // added to the directory offset the end record states
  zip64?: boolean; // write a ZIP64 end record and locator, and set the classic fields to their maximum
  comment?: string;
  disk?: number; // the disk number the end record states
}

const buf = (x: string | Buffer) => (typeof x === "string" ? Buffer.from(x, "utf8") : x);

export function makeZip(entries: ZEntry[], o: ZOpts = {}): Buffer {
  const parts: Buffer[] = [];
  let off = 0;
  const push = (b: Buffer) => {
    parts.push(b);
    off += b.length;
  };
  if (o.prefix) push(o.prefix);
  const base = off;
  const cd: Buffer[] = [];
  let n = 0;
  for (const e of entries) {
    const data = buf(e.data ?? "");
    const method = e.method ?? 0;
    const packedData = e.packedData ?? (method === 8 ? zlib.deflateRawSync(data) : data);
    const name = buf(e.name);
    const lname = buf(e.localName ?? e.name);
    const crc = e.crc ?? zlib.crc32(data);
    const flags = (e.encrypted ? 1 : 0) | (e.utf8 ? 0x800 : 0) | (e.descriptor ? 8 : 0) | (e.gpExtra ?? 0);
    const dd = e.descriptor;
    const z64 = (a: number, b2: number) => {
      const x = Buffer.alloc(20);
      x.writeUInt16LE(1, 0);
      x.writeUInt16LE(16, 2);
      x.writeBigUInt64LE(BigInt(a), 4);
      x.writeBigUInt64LE(BigInt(b2), 12);
      return x;
    };
    const lextra = Buffer.concat([e.zip64Sizes ? z64(e.size ?? data.length, e.packed ?? packedData.length) : Buffer.alloc(0), e.localExtra ?? Buffer.alloc(0)]);
    const localAt = off - base;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(e.localFlags ?? flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(dd ? 0 : crc >>> 0, 14);
    lh.writeUInt32LE(dd ? 0 : e.zip64Sizes ? 0xffffffff : (e.packed ?? packedData.length), 18);
    lh.writeUInt32LE(dd ? 0 : e.zip64Sizes ? 0xffffffff : (e.localSize ?? e.size ?? data.length), 22);
    lh.writeUInt16LE(lname.length, 26);
    lh.writeUInt16LE(lextra.length, 28);
    push(Buffer.concat([lh, lname, lextra, packedData]));
    if (dd) {
      const d = Buffer.alloc(dd.wide ? 24 : 16);
      d.writeUInt32LE(0x08074b50, 0);
      d.writeUInt32LE((dd.crc ?? crc) >>> 0, 4);
      if (dd.wide) {
        d.writeBigUInt64LE(BigInt(dd.packed ?? packedData.length), 8);
        d.writeBigUInt64LE(BigInt(dd.size ?? data.length), 16);
      } else {
        d.writeUInt32LE(dd.packed ?? packedData.length, 8);
        d.writeUInt32LE(dd.size ?? data.length, 12);
      }
      push(dd.mark === false ? d.subarray(4) : d);
    }
    if (e.skipCd) continue;
    n++;
    const extra = e.zip64Sizes ? z64(e.size ?? data.length, e.packed ?? packedData.length) : (e.cdExtra ?? Buffer.alloc(0));
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(e.unixMode !== undefined ? (3 << 8) | 20 : 20, 4); // host 0 (DOS) unless a Unix mode is given
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc >>> 0, 16);
    c.writeUInt32LE(e.zip64Sizes ? 0xffffffff : (e.packed ?? packedData.length), 20);
    c.writeUInt32LE(e.zip64Sizes ? 0xffffffff : (e.size ?? data.length), 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(extra.length, 30);
    c.writeUInt32LE(e.unixMode !== undefined ? (e.unixMode << 16) >>> 0 : (e.dosAttr ?? 0), 38);
    c.writeUInt32LE(e.localOffset ?? localAt, 42);
    cd.push(Buffer.concat([c, name, extra]));
  }
  const cdStart = off - base;
  for (const c of cd) push(c);
  const cdSize = off - base - cdStart;
  const count = o.count ?? n;
  if (o.zip64) {
    const recAt = off - base;
    const r = Buffer.alloc(56);
    r.writeUInt32LE(0x06064b50, 0);
    r.writeBigUInt64LE(44n, 4);
    r.writeUInt16LE(45, 12);
    r.writeUInt16LE(45, 14);
    r.writeBigUInt64LE(BigInt(count), 24);
    r.writeBigUInt64LE(BigInt(count), 32);
    r.writeBigUInt64LE(BigInt(cdSize), 40);
    r.writeBigUInt64LE(BigInt(cdStart + (o.cdOffsetDelta ?? 0)), 48);
    push(r);
    const l = Buffer.alloc(20);
    l.writeUInt32LE(0x07064b50, 0);
    l.writeBigUInt64LE(BigInt(recAt + base), 8);
    l.writeUInt32LE(1, 16);
    push(l);
  }
  const comment = Buffer.from(o.comment ?? "", "latin1");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(o.disk ?? 0, 4);
  end.writeUInt16LE(o.zip64 ? 0xffff : count, 8);
  end.writeUInt16LE(o.zip64 ? 0xffff : count, 10);
  end.writeUInt32LE(o.zip64 ? 0xffffffff : cdSize, 12);
  end.writeUInt32LE(o.zip64 ? 0xffffffff : cdStart + (o.cdOffsetDelta ?? 0), 16);
  end.writeUInt16LE(comment.length, 20);
  push(Buffer.concat([end, comment]));
  if (o.trailing) push(o.trailing);
  return Buffer.concat(parts);
}
