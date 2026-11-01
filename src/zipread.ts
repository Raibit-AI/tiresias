// SPDX-License-Identifier: Apache-2.0
// v0.6 (track "files"): the table of contents of a zip, read from its bytes in memory. Nothing is unpacked
// to disk, nothing is run, and no entry is opened in full: a listing reads the central directory (names,
// sizes, methods) and each entry's local header, and at most the first bytes of an entry's data (to name
// it by its signature, as files.ts names a download). Office text (office.ts) is the one caller that
// inflates whole entries, and only through readEntry below, under a hard output cap.
//
// Every number in a zip is a CLAIM made by whoever built it. So every offset and length is checked against
// the buffer before it is used, every loop has a fixed bound, the central directory is compared with the
// local headers it points at, and anything that does not add up is a flag, never a guess. Runs only in the
// worker thread (sandbox.ts), under the parse time budget and the worker's heap limit; zlib's own buffers
// are bounded by the explicit output caps here (SNIFF_*, and readEntry's `limit`).
import zlib from "node:zlib";
import { innerKind, signature, textShortcut, type FileKind } from "./files.js";

// ---- limits (fixed) ----
export const MAX_ENTRIES = 10_000; // central directory records read; past it the listing stops (too_many_entries)
export const MAX_DEPTH = 16; // path segments in a name before deep_path
export const MAX_NAME = 255; // characters of a name shown (the END is kept: it holds the extension)
export const SNIFF_IN = 1024; // compressed bytes inflated to see an entry's first bytes (deflate: at most ~1 MB out)
export const SNIFF_OUT = 512; // first bytes looked at per entry (enough for a text shortcut's marker, Codex round 3)
export const SNIFF_BUDGET = 16 * 1024 * 1024; // total bytes zlib may produce while sniffing one zip
export const SNIFF_MAX = 1_000; // entries sniffed at most
export const HIGH_RATIO = 100; // declared unpacked / packed above this (and over 1 MiB) is high_ratio
export const HUGE = 1024 * 1024 * 1024; // declared unpacked total over 1 GiB is huge_when_unpacked


// Fixed codes. Top-level ones go on file_warning.inside.flags; per-entry ones on each listed entry.
export type ZipFlag =
  | "program_inside" | "script_inside" | "shortcut_inside" | "addon_inside" | "archive_inside" | "office_inside"
  | "path_traversal" | "absolute_path" | "deep_path" | "odd_name" | "duplicate_names" | "name_mismatch"
  | "encrypted" | "encrypted_directory" | "symlink" | "unsupported_method"
  | "overlapping_entries" | "directory_mismatch" | "hidden_entries" | "out_of_bounds"
  | "high_ratio" | "huge_when_unpacked" | "zip64" | "multi_disk" | "too_many_entries" | "type_mismatch"
  | "leading_data" | "trailing_data" | "multiple_directories" | "path_conflict" | "extra_attributes" | "attribute_mismatch";

export interface ZipEntry {
  name: string; // decoded, shown form (bounded, control characters replaced)
  rawName: string; // decoded, unbounded (for matching inside office.ts)
  size: number; // declared unpacked size
  packed: number; // declared packed size
  method: number;
  crc: number;
  dir: boolean;
  encrypted: boolean;
  kind?: FileKind; // what the entry is: by its first bytes when they were seen, otherwise by its name
  flags: ZipFlag[];
  // where its data is, when the local header was valid (absent: the entry cannot be read)
  dataStart?: number;
  sniffed?: boolean;
}

export interface ZipListing {
  ok: true;
  entries: ZipEntry[]; // in directory order, at most MAX_ENTRIES
  declared: number; // the entry count the directory claims
  atLeast: boolean; // the listing stopped early: `entries.length` is a lower bound
  flags: ZipFlag[];
  totalSize: number; // sum of declared unpacked sizes (of the entries read)
  encrypted: number;
  unsniffed: number; // entries whose first bytes could not be looked at (encrypted, unsupported, budget)
}
export type ZipResult = ZipListing | { ok: false; reason: "not_zip" | "unreadable" };

const u16 = (b: Buffer, o: number) => b.readUInt16LE(o);
const u32 = (b: Buffer, o: number) => b.readUInt32LE(o);
// A 64-bit little-endian number, or -1 when it is past what a JS number holds exactly (a lie in any file
// this small).
function u64(b: Buffer, o: number): number {
  const v = b.readBigUInt64LE(o);
  return v > BigInt(Number.MAX_SAFE_INTEGER) ? -1 : Number(v);
}
const inRange = (b: Buffer, off: number, len: number) => Number.isSafeInteger(off) && Number.isSafeInteger(len) && off >= 0 && len >= 0 && off + len <= b.length;

const EOCD = 0x06054b50, CEN = 0x02014b50, LOC = 0x04034b50, Z64_LOC = 0x07064b50, Z64_EOCD = 0x06064b50;

// The end-of-central-directory record: searched backwards over the last 22 + 65,535 bytes (its comment can
// be that long). The record whose comment runs exactly to the end of the file is the one; when none does,
// the last one found with its comment inside the file is used and trailing_data is flagged.
function findEocd(b: Buffer, flags: Set<ZipFlag>): number {
  const stop = Math.max(0, b.length - 22 - 0xffff);
  let exact = -1, loose = -1, found = 0;
  for (let i = b.length - 22; i >= stop; i--) {
    if (b[i] !== 0x50 || u32(b, i) !== EOCD) continue;
    const end = i + 22 + u16(b, i + 20);
    if (end > b.length) continue;
    found++;
    if (end === b.length && exact === -1) exact = i;
    if (loose === -1) loose = i;
  }
  if (found > 1) flags.add("multiple_directories");
  if (exact !== -1) return exact;
  if (loose !== -1) flags.add("trailing_data");
  return loose;
}

// The zip format's legacy code page (IBM 437) for names without the UTF-8 bit (Codex round 1).
const CP437_HIGH = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0";
export function cp437(raw: Buffer): string {
  let out = "";
  for (const c of raw) out += c < 0x80 ? String.fromCharCode(c) : CP437_HIGH[c - 0x80];
  return out;
}

// Names: UTF-8 when the entry says so (bit 11) and it decodes, otherwise each byte as one character (the
// old DOS code page differs only in characters no risky extension uses). Never more than 64 KB.
function decodeName(raw: Buffer, utf8: boolean): { name: string; odd: boolean } {
  let name: string;
  let odd = false;
  if (utf8) {
    try {
      name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw); // a leading U+FEFF is kept (Codex round 7)
    } catch {
      name = cp437(raw);
      odd = true;
    }
  } else name = cp437(raw);
  // Control characters, bidirectional controls and invisible characters can disguise a name ("invoice\u202efdp.exe").
  if (/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(name)) odd = true;
  return { name, odd };
}
export const showName = (n: string): string => {
  const clean = n.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "\ufffd");
  return clean.length > MAX_NAME ? "..." + clean.slice(-MAX_NAME) : clean;
};

// What a name says about where it would be written when unpacked.
function pathFlags(name: string, flags: ZipFlag[]): void {
  const n = name.replace(/\\/g, "/");
  if (n.startsWith("/") || /^[a-zA-Z]:/.test(n) || n.startsWith("//")) flags.push("absolute_path");
  const segs = n.split("/");
  if (segs.some((s) => s === ".." || /^\.\.[ .]*$/.test(s))) flags.push("path_traversal");
  if (segs.filter((s) => s !== "").length > MAX_DEPTH) flags.push("deep_path");
  // Names that different systems write differently (Codex round 2): a segment ending in a dot or a space
  // (Windows drops them, so "a.exe." is "a.exe"), a stream after a colon ("a.txt:b.exe"), characters Windows
  // forbids, or a reserved device name (CON, NUL, COM1...).
  if (segs.some((s) => /[. ]$/.test(s) && s !== "." && s !== "..") || /[:*?"<>|]/.test(n.replace(/^[a-zA-Z]:/, "")) || segs.some((s) => /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(s)))
    flags.push("odd_name");
}
// The forms a name may take once written (for duplicate and kind checks): dot segments dropped, trailing
// dots and spaces dropped from each segment, case folded, Unicode composed; plus, for a colon, the part after
// it (an alternate stream's name).
export function destination(name: string): string {
  const segs = name.normalize("NFC").replace(/\\/g, "/").split("/").map((x) => x.replace(/[. ]+$/, (m) => (x === "." || x === ".." ? m : "")));
  const out: string[] = [];
  for (const x of segs) {
    if (x === "" || x === ".") continue;
    if (x === "..") out.pop();
    else out.push(x);
  }
  return out.join("/").toLowerCase();
}
const nameForms = (n: string): string[] => {
  const d = destination(n);
  const forms = [n, d];
  const c = d.lastIndexOf(":");
  if (c !== -1) forms.push(d.slice(c + 1));
  return forms;
};

// The kind an entry's name claims (files.ts tables), and the flag each risky kind raises.
const KIND_FLAG: Partial<Record<FileKind, ZipFlag>> = {
  program: "program_inside", script: "script_inside", shortcut: "shortcut_inside", addon: "addon_inside", archive: "archive_inside", office: "office_inside",
};

// An entry's first bytes, by its signature. Stored entries are sliced; deflated ones are inflated from at
// most SNIFF_IN compressed bytes with a sync flush (so a cut stream gives what it has), output capped.
function sniff(b: Buffer, e: ZipEntry, budget: { left: number }): Buffer | null {
  if (e.dataStart === undefined || e.encrypted || e.dir || e.flags.includes("unsupported_method")) return null;
  const avail = Math.min(e.packed, b.length - e.dataStart);
  if (avail <= 0) return Buffer.alloc(0);
  if (e.method === 0) return b.subarray(e.dataStart, e.dataStart + Math.min(avail, SNIFF_OUT));
  if (e.method !== 8) return null;
  if (budget.left <= 0) return null;
  const input = b.subarray(e.dataStart, e.dataStart + Math.min(avail, SNIFF_IN));
  let out: Buffer;
  // Deflate expands at most ~1032 times, so SNIFF_IN bytes in stay under SNIFF_IN * 1100 out; each call is
  // also held to what is left of the total (Codex round 2), and a call that hits that limit spends it.
  const cap = Math.min(SNIFF_IN * 1100, budget.left);
  try {
    out = zlib.inflateRawSync(input, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: cap });
  } catch {
    budget.left -= cap; // a failed call may have produced up to its cap
    return null; // bad data or over the budget: nothing seen, counted as unchecked
  }
  budget.left -= out.length;
  return out.subarray(0, SNIFF_OUT);
}

// Name an entry by its first bytes, as a download is named. A text entry with no signature keeps its name's kind.
function kindOfBytes(head: Buffer, nameKind: FileKind | null): FileKind | "pdf" | null {
  const sig = signature(head);
  if (!sig) return textShortcut(head) ? "shortcut" : null; // a text shortcut or registry file, as for a download (Codex round 3)
  if (sig.kind === "pdf") return "pdf"; // a PDF: not a risky kind, but a name that says otherwise is a mismatch (Codex round 5)
  if (sig.kind === "script") return "script";
  if (sig.family === "ole") return nameKind === "program" ? "program" : "office"; // .msi is an OLE file too
  // Only a ZIP is refined by its name (a zip named .docx/.xpi/.jar is that); any other archive stays an archive.
  const isZip = head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b;
  if (sig.kind === "archive" && isZip && (nameKind === "office" || nameKind === "addon" || nameKind === "program")) return nameKind;
  return sig.kind as FileKind;
}

// An Info-ZIP Unicode path field: version 1, the CRC-32 of the entry's own name bytes, then the name in
// UTF-8. A field that is not valid that way is odd_name, and its name is still judged (some unpackers use
// it anyway); one that does not decode gives no name.
function unicodePath(b: Buffer, d: number, len: number, nameBytes: Buffer, flags: ZipFlag[]): string | null {
  if (len < 5) {
    flags.push("odd_name");
    return null;
  }
  if (b[d] !== 1 || u32(b, d + 1) !== zlib.crc32(nameBytes)) flags.push("odd_name");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b.subarray(d + 5, d + len));
  } catch {
    flags.push("odd_name");
    return null;
  }
}
// Extra fields that carry a file type or permissions some unpackers use instead of the directory's
// (Codex round 3): the ASi Unix field (0x756e; its mode is read, a link is symlink), the PKWARE Unix field
// (0x000d, which holds a link's target) and libarchive's 0x6c78 field. Any of them is extra_attributes.
function attrExtra(b: Buffer, id: number, d: number, len: number, flags: ZipFlag[]): void {
  if (id !== 0x756e && id !== 0x000d && id !== 0x6c78) return;
  flags.push("extra_attributes");
  if (id === 0x756e && len >= 6 && (u16(b, d + 4) & 0o170000) === 0o120000) flags.push("symlink");
  if (id === 0x000d && len > 12) flags.push("symlink"); // variable data after the fixed part: a link target
}

// The data descriptor at `at`: its length when it agrees with the directory, -1 otherwise. With or without
// its mark, with 4- or 8-byte sizes (ZIP64).
function descriptor(b: Buffer, at: number, crc: number, packed: number, size: number): number {
  for (const mark of [true, false])
    for (const wide of [false, true]) {
      const o = at + (mark ? 4 : 0);
      const len = (mark ? 4 : 0) + 4 + (wide ? 16 : 8);
      if (!inRange(b, at, len)) continue;
      if (mark && u32(b, at) !== 0x08074b50) continue;
      const p = wide ? u64(b, o + 4) : u32(b, o + 4);
      const s = wide ? u64(b, o + 12) : u32(b, o + 8);
      if (u32(b, o) === crc && p === packed && s === size) return len;
    }
  return -1;
}

export function listZip(b: Buffer): ZipResult {
  if (b.length < 22) return { ok: false, reason: "not_zip" };
  const top = new Set<ZipFlag>();
  const eocd = findEocd(b, top);
  if (eocd < 0) return { ok: false, reason: "not_zip" };
  let declared = u16(b, eocd + 10);
  let cdSize = u32(b, eocd + 12);
  let cdOff = u32(b, eocd + 16);
  if (u16(b, eocd + 4) !== 0 || u16(b, eocd + 6) !== 0 || u16(b, eocd + 8) !== declared) top.add("multi_disk");
  let cdEnd = eocd; // where the central directory must end
  // ZIP64: a locator just before the end record is always looked at, as some readers use it whenever it is
  // there (Codex round 6); every classic field must agree with it unless at its maximum (round 7).
  {
    const loc = eocd - 20;
    if (loc >= 0 && u32(b, loc) === Z64_LOC) {
      top.add("zip64");
      const recOff = u64(b, loc + 8);
      if (recOff < 0 || !inRange(b, recOff, 56) || u32(b, recOff) !== Z64_EOCD || recOff > loc) return { ok: false, reason: "unreadable" };
      // The record's own length must fit before the locator (Codex round 1).
      const recLen = u64(b, recOff + 4);
      if (recLen < 44 || recOff + 12 + recLen > loc) return { ok: false, reason: "unreadable" };
      if (u32(b, recOff + 16) !== 0 || u32(b, recOff + 20) !== 0 || u64(b, recOff + 24) !== u64(b, recOff + 32) || u32(b, loc + 4) !== 0 || u32(b, loc + 16) > 1) top.add("multi_disk");
      const n = u64(b, recOff + 32);
      const sz = u64(b, recOff + 40);
      const off = u64(b, recOff + 48);
      if (n < 0 || sz < 0 || off < 0) return { ok: false, reason: "unreadable" };
      // Each classic field not at its maximum must agree with its ZIP64 value, field by field (Codex round 7).
      if ((declared !== 0xffff && n !== declared) || (cdSize !== 0xffffffff && sz !== cdSize) || (cdOff !== 0xffffffff && off !== cdOff)) top.add("directory_mismatch");
      declared = n;
      cdSize = sz;
      cdOff = off;
      cdEnd = recOff;
    }
  }
  // Where the directory really starts: it must end where the end record (or the ZIP64 record) begins. A
  // declared offset that disagrees is a directory that lies, or data glued in front (leading_data).
  const actualStart = cdEnd - cdSize;
  if (actualStart < 0) return { ok: false, reason: "unreadable" };
  let base = 0; // added to every offset the zip states
  if (cdOff !== actualStart) {
    if (actualStart > cdOff && inRange(b, actualStart, 4) && u32(b, actualStart) === CEN) {
      base = actualStart - cdOff;
      top.add("leading_data");
    } else top.add("directory_mismatch");
  }
  const start = cdOff + base;
  if (!inRange(b, start, 0) || start > cdEnd) return { ok: false, reason: "unreadable" };
  if (declared > MAX_ENTRIES) top.add("too_many_entries");

  const entries: ZipEntry[] = [];
  const ranges: [number, number][] = [];
  const seen = new Map<string, { dir: boolean }>();
  const folders = new Set<string>(); // every folder some entry's path needs
  let p = start;
  let atLeast = false;
  let totalSize = 0;
  let encrypted = 0;
  while (p < cdEnd) {
    if (entries.length >= MAX_ENTRIES) {
      atLeast = true;
      top.add("too_many_entries");
      break;
    }
    if (!inRange(b, p, 46) || p + 46 > cdEnd || u32(b, p) !== CEN) {
      top.add("directory_mismatch"); // the directory ends early or holds something that is not a record
      atLeast = true;
      break;
    }
    const madeBy = u16(b, p + 4);
    const gp = u16(b, p + 8);
    const method = u16(b, p + 10);
    const crc = u32(b, p + 16);
    let packed = u32(b, p + 20);
    let size = u32(b, p + 24);
    const nLen = u16(b, p + 28), xLen = u16(b, p + 30), cLen = u16(b, p + 32);
    const disk = u16(b, p + 34);
    const ext = u32(b, p + 38);
    let lOff = u32(b, p + 42);
    const recLen = 46 + nLen + xLen + cLen;
    if (p + recLen > cdEnd) {
      top.add("directory_mismatch");
      atLeast = true;
      break;
    }
    const rawNameBytes = b.subarray(p + 46, p + 46 + nLen);
    const { name: raw, odd } = decodeName(rawNameBytes, (gp & 0x0800) !== 0);
    const flags: ZipFlag[] = [];
    if (odd) flags.push("odd_name");
    let diskNo = disk;
    // Extra fields: the ZIP64 sizes and offset (only the ones the record set to the maximum, in order),
    // and the Info-ZIP Unicode path (a second name some unpackers use instead: it must agree).
    const unicodeNames: string[] = []; // every Info-ZIP Unicode path field (none overwrites another, Codex round 3)
    let z64Seen = 0;
    for (let x = p + 46 + nLen, xEnd = x + xLen; x + 4 <= xEnd; ) {
      const id = u16(b, x), len = u16(b, x + 2);
      const d = x + 4;
      if (d + len > xEnd) {
        flags.push("directory_mismatch");
        break;
      }
      if (id === 0x0001) {
        if (z64Seen++) flags.push("directory_mismatch"); // a second ZIP64 field: readers differ on which counts (Codex round 8)
        let q = d;
        const take = () => {
          if (q + 8 > d + len) {
            flags.push("directory_mismatch");
            return -1;
          }
          const v = u64(b, q);
          q += 8;
          return v;
        };
        if (size === 0xffffffff) size = take();
        if (packed === 0xffffffff) packed = take();
        if (lOff === 0xffffffff) lOff = take();
        if (diskNo === 0xffff && q + 4 <= d + len) diskNo = u32(b, q);
        top.add("zip64");
      } else if (id === 0x7075) {
        const u = unicodePath(b, d, len, rawNameBytes, flags);
        if (u !== null) unicodeNames.push(u);
      } else attrExtra(b, id, d, len, flags);
      x = d + len;
    }
    p += recLen;
    if (size < 0 || packed < 0 || lOff < 0) {
      flags.push("directory_mismatch");
      size = Math.max(size, 0);
      packed = Math.max(packed, 0);
    }
    if (diskNo !== 0) top.add("multi_disk");
    // Bit 0 (encrypted), bit 6 (strong encryption) and AES (method 99) are encryption. Bit 5 (patch data) changes
    // what the bytes mean for an unpacker that supports it: unsupported_method, never sniffed or read (Codex round 6).
    const isEnc = (gp & 0x0001) !== 0 || (gp & 0x0040) !== 0 || method === 99;
    const patched = (gp & 0x0020) !== 0;
    if ((gp & 0x2000) !== 0) top.add("encrypted_directory");
    // A folder by its name (a trailing slash) or by its attributes (a Unix folder mode, or the DOS folder
    // bit), as unpackers decide; when the two disagree it is attribute_mismatch (Codex round 4).
    const slashDir = raw.endsWith("/") || raw.endsWith("\\");
    const hostOs = madeBy >> 8;
    const unixType = (ext >>> 16) & 0o170000;
    const attrDir = hostOs === 3 || hostOs === 19 ? unixType === 0o040000 : hostOs === 0 || hostOs === 10 || hostOs === 14 ? (ext & 0x10) !== 0 : false;
    const attrFile = (hostOs === 3 || hostOs === 19) && unixType !== 0 && unixType !== 0o040000;
    if ((attrDir && !slashDir) || (slashDir && attrFile)) flags.push("attribute_mismatch");
    const dir = slashDir || attrDir;
    const names = [...new Set([raw, ...unicodeNames])];
    if (names.length > 1) flags.push("name_mismatch");
    const unicodeName = unicodeNames[0] ?? null;
    for (const n of names) pathFlags(n, flags);
    // Symbolic links: a Unix mode in the high half of the external attributes, when made on Unix (host 3) or macOS (19).
    const host = madeBy >> 8;
    if ((host === 3 || host === 19) && ((ext >>> 16) & 0o170000) === 0o120000) flags.push("symlink");
    if (isEnc) {
      flags.push("encrypted");
      encrypted++;
    }
    if ((method !== 0 && method !== 8 && method !== 99 && !dir) || patched) flags.push("unsupported_method");
    // Where it would be written: the same place twice is duplicate_names; a file where another entry needs a
    // folder (or the other way round) is path_conflict, in either order (Codex round 3).
    const key = destination(raw);
    const before = seen.get(key);
    if (before !== undefined) flags.push(before.dir === dir ? "duplicate_names" : "path_conflict");
    else seen.set(key, { dir });
    if (!dir && folders.has(key)) flags.push("path_conflict");
    const parts = key.split("/");
    for (let k = 1; k < parts.length; k++) {
      const parent = parts.slice(0, k).join("/");
      if (seen.get(parent)?.dir === false) flags.push("path_conflict");
      folders.add(parent);
    }
    // Kind by name (every name the entry carries; the riskiest counts).
    let nameKind: FileKind | null = null;
    for (const n of names.flatMap(nameForms)) {
      const k = innerKind(n);
      if (k && (!nameKind || RANK[k] > RANK[nameKind])) nameKind = k;
    }
    const e: ZipEntry = { name: showName(unicodeName ?? raw), rawName: raw, size, packed, method, crc, dir, encrypted: isEnc, flags, ...(nameKind && !dir ? { kind: nameKind } : {}) };
    // The local header it points at must exist and agree with the directory.
    const lh = lOff + base;
    if (!inRange(b, lh, 30) || u32(b, lh) !== LOC) flags.push("directory_mismatch");
    else {
      const lgp = u16(b, lh + 6), lMethod = u16(b, lh + 8);
      const lnLen = u16(b, lh + 26), lxLen = u16(b, lh + 28);
      const dataStart = lh + 30 + lnLen + lxLen;
      if (!inRange(b, lh + 30, lnLen + lxLen)) flags.push("out_of_bounds");
      else {
        const lname = b.subarray(lh + 30, lh + 30 + lnLen);
        // Every name an unpacker might use is judged: a different local name gets the same path and kind checks
        // as the directory's (Codex round 12).
        const judge = (n: string) => {
          pathFlags(n, flags);
          for (const f of nameForms(n)) {
            const k = innerKind(f);
            if (k && !dir && (!e.kind || RANK[k] > RANK[e.kind])) e.kind = k;
          }
        };
        if (!lname.equals(rawNameBytes)) {
          flags.push("name_mismatch");
          judge(decodeName(lname, (u16(b, lh + 6) & 0x0800) !== 0).name);
        }
        // Every general-purpose flag must agree, not only encryption (Codex round 1).
        if (lMethod !== method || lgp !== gp) flags.push("directory_mismatch");
        // The local extra fields: a ZIP64 size field and a Unicode name, which must agree with the directory.
        let lsize = u32(b, lh + 22), lpacked = u32(b, lh + 18);
        const lc = u32(b, lh + 14);
        let lz64 = 0;
        for (let x = lh + 30 + lnLen, xEnd = x + lxLen; x + 4 <= xEnd; ) {
          const id = u16(b, x), len = u16(b, x + 2);
          const d = x + 4;
          if (d + len > xEnd) {
            flags.push("directory_mismatch");
            break;
          }
          if (id === 0x0001) {
            if (lz64++) flags.push("directory_mismatch"); // a second ZIP64 field in the local header
            if (lsize === 0xffffffff && len >= 8) lsize = u64(b, d);
            if (lpacked === 0xffffffff && len >= 16) lpacked = u64(b, d + 8);
          } else if (id === 0x7075) {
            const lu = unicodePath(b, d, len, lname, flags);
            if (lu !== null && lu !== (unicodeName ?? raw)) {
              flags.push("name_mismatch");
              judge(lu);
            }
          } else attrExtra(b, id, d, len, flags);
          x = d + len;
        }
        let end = dataStart + packed;
        if ((lgp & 0x0008) === 0) {
          // Sizes and CRC are in the local header: they must agree.
          if (lsize !== size || lpacked !== packed || lc !== crc) flags.push("directory_mismatch");
        } else {
          // Deferred to a data descriptor after the data: the local fields are zero (or agree), and the
          // descriptor (with or without its mark; 4- or 8-byte sizes) must agree with the directory.
          if ((lc !== 0 && lc !== crc) || (lsize !== 0 && lsize !== size) || (lpacked !== 0 && lpacked !== packed)) flags.push("directory_mismatch");
          const dd = descriptor(b, end, crc, packed, size);
          if (dd < 0) flags.push("directory_mismatch");
          else end += dd;
        }
        if (!inRange(b, dataStart, packed) || end > start) flags.push("out_of_bounds");
        else {
          e.dataStart = dataStart;
          ranges.push([lh, end]);
        }
      }
    }
    // A stored entry is its own bytes: its packed and unpacked sizes are the same (Codex round 2).
    if (method === 0 && !isEnc && !dir && packed !== size) flags.push("directory_mismatch");
    if (!dir) {
      totalSize += size;
      if (size > 1024 * 1024 && (packed === 0 || size / packed > HIGH_RATIO)) flags.push("high_ratio");
    }
    entries.push(e);
  }
  if (!atLeast && entries.length !== declared) top.add("directory_mismatch");
  if (p !== cdEnd && !atLeast) top.add("directory_mismatch");

  // Overlap: two entries whose bytes share space (the trick behind small zips that unpack to petabytes).
  const sorted = ranges.map((r, i) => [...r, i] as [number, number, number]).sort((a, c) => a[0] - c[0] || a[1] - c[1]);
  let reach = -1;
  for (const [s, end] of sorted) {
    if (s < reach) {
      top.add("overlapping_entries");
      break;
    }
    reach = Math.max(reach, end);
  }
  // Local headers outside every listed entry: a streaming unpacker would find files the directory hides.
  {
    let marks = 0;
    let gapStart = base;
    const gaps: [number, number][] = [];
    for (const [s, end] of sorted) {
      if (s > gapStart) gaps.push([gapStart, s]);
      gapStart = Math.max(gapStart, end);
    }
    if (start > gapStart) gaps.push([gapStart, start]);
    const sigLoc = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    // Each gap is searched on its own slice, so the whole search is one pass over the file.
    for (const [s, end] of gaps) {
      if (b.subarray(s, end).indexOf(sigLoc) !== -1) {
        marks++;
        break;
      }
    }
    if (marks) top.add("hidden_entries");
  }
  // First bytes, budgeted; entry and top-level kind flags.
  const budget = { left: SNIFF_BUDGET };
  let unsniffed = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    for (const f of e.flags) if (ENTRY_TO_TOP.has(f)) top.add(f); // directories too (Codex round 1)
    if (e.dir) continue;
    const head = i < SNIFF_MAX ? sniff(b, e, budget) : null;
    // Checked only when the whole first SNIFF_OUT bytes (or the whole entry, when smaller) were seen: a cut
    // or failed look is counted as unchecked, whatever size the entry claims (Codex round 4).
    const complete = !!head && head.length > 0 && head.length >= Math.min(SNIFF_OUT, e.size);
    if (head && head.length) {
      e.sniffed = complete;
      const bytesKind = kindOfBytes(head, e.kind ?? null);
      if (bytesKind === "pdf" && !/\.pdf$/i.test(e.rawName)) e.flags.push("type_mismatch"); // named as something else, but a PDF
      const byBytes = bytesKind === "pdf" ? null : bytesKind;
      if (byBytes && (!e.kind || byBytes !== e.kind)) {
        if (e.kind) e.flags.push("type_mismatch");
        if (!e.kind || RANK[byBytes] >= RANK[e.kind]) e.kind = byBytes;
      }
    }
    if (!complete && !(head && head.length === 0 && e.size === 0)) unsniffed++;
    if (e.kind) {
      const f = KIND_FLAG[e.kind];
      if (f) {
        e.flags.push(f);
        top.add(f);
      }
    }
    for (const f of e.flags) if (ENTRY_TO_TOP.has(f)) top.add(f);
  }
  if (totalSize > HUGE) top.add("huge_when_unpacked");
  for (const e of entries) e.flags = [...new Set(e.flags)];
  return { ok: true, entries, declared, atLeast, flags: [...top], totalSize, encrypted, unsniffed };
}

// Which kind wins when an entry's name and bytes disagree: the riskier one.
const RANK: Record<FileKind, number> = { program: 9, script: 8, shortcut: 7, addon: 6, unknown: 5, archive: 4, office: 3, media: 1, image: 1 };
const ENTRY_TO_TOP = new Set<ZipFlag>([
  "path_conflict", "extra_attributes", "attribute_mismatch",
  "path_traversal", "absolute_path", "deep_path", "odd_name", "duplicate_names", "name_mismatch", "encrypted", "symlink",
  "unsupported_method", "directory_mismatch", "out_of_bounds", "high_ratio", "type_mismatch",
]);

// One entry's whole content, for office.ts only: stored or deflated, not encrypted, with a valid local
// header, inflated with output capped at `limit` bytes. The result must be exactly the declared size and
// match the declared CRC-32; anything else is refused (a size that lies is a bomb or a broken file).
export type EntryRead = { ok: true; data: Buffer } | { ok: false; reason: "too_large" | "unreadable" };
export function readEntry(b: Buffer, e: ZipEntry, limit: number): EntryRead {
  if (e.dataStart === undefined || e.encrypted || e.dir || (e.method !== 0 && e.method !== 8) || e.flags.includes("unsupported_method")) return { ok: false, reason: "unreadable" };
  if (e.size > limit) return { ok: false, reason: "too_large" };
  const input = b.subarray(e.dataStart, e.dataStart + e.packed);
  let data: Buffer;
  if (e.method === 0) data = input;
  else {
    try {
      // One byte over the declared size is enough to know it lies. The stream must also end exactly at the
      // end of the packed data (Codex round 2): bytes after it would be a second, hidden payload.
      const r = zlib.inflateRawSync(input, { maxOutputLength: Math.max(1, e.size + 1), info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      if (r.engine.bytesWritten !== input.length) return { ok: false, reason: "unreadable" };
      data = r.buffer;
    } catch (err) {
      return { ok: false, reason: (err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ? "too_large" : "unreadable" };
    }
  }
  if (data.length !== e.size || zlib.crc32(data) !== e.crc) return { ok: false, reason: "unreadable" };
  return { ok: true, data };
}
