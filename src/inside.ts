// SPDX-License-Identifier: Apache-2.0
// v0.6 (track "files"): looking inside a zip-shaped file without unpacking it. A plain zip (kind
// "archive") gets a listing: names and declared sizes, with anything risky flagged. An Office file
// (kind "office": .docx, .xlsx, .pptx and their macro types) gets its text only (office.ts). The work
// itself runs in the worker thread (sandbox.ts) under the parse time budget; this module holds the pieces
// both sides use: which files are held for it, the job, and how its answer becomes part of the warning.
//
// What comes back is split as everywhere else: the top level of the warning (file_warning.inside) holds
// only what Tiresias made (fixed codes, counts it took); every name and every word of text came from the
// file, so it sits in untrusted_content.inside, scanned by the prompt-injection shield.
import { MACRO_OFFICE_EXT, mimeOf, type FileKind } from "./files.js";
import { Shield } from "./shield.js";
import { ConfigError, FetchError } from "./errors.js";
import type { FileFacts } from "./safety.js";
import { listZip, type ZipEntry, type ZipFlag, type ZipListing } from "./zipread.js";
import { EXTERNAL_BUDGET, OFFICE_FLAG_TEXT, TEXT_BUDGET, officeText, type OfficeFlag } from "./office.js";
import { jsonBytes, type Envelope, type Flag, type FlagType } from "./types.js";

// The most bytes of one file held in memory to look inside (TIRESIAS_MAX_INSPECT_BYTES, default 20 MiB,
// never more than the file cap). A bigger file still gets its warning and fingerprint, with reason too_large.
export const INSPECT_MAX = 20 * 1024 * 1024;
export function inspectCap(): number {
  const v = process.env.TIRESIAS_MAX_INSPECT_BYTES;
  if (v === undefined) return INSPECT_MAX;
  const n = /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new ConfigError(`TIRESIAS_MAX_INSPECT_BYTES must be a positive whole number, got "${v.slice(0, 40)}".`);
  return n;
}

// A zip's own first bytes: a local file header, or the end record of an empty zip.
export const isZipHead = (head: Buffer): boolean =>
  head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && ((head[2] === 3 && head[3] === 4) || (head[2] === 5 && head[3] === 6));

// Which files are held in memory to look inside: zip-shaped archives and Office files only.
export const inspectable = (kind: FileKind): kind is "archive" | "office" => kind === "archive" || kind === "office";
export const keepFor = (kind: FileKind, head: Buffer): number => (inspectable(kind) && isZipHead(head) ? inspectCap() : 0);

export type InsideReason = "too_large" | "not_zip" | "unreadable" | "too_complex";
export type InsideFlag = ZipFlag | OfficeFlag;

// file_warning.inside: Tiresias's own facts only.
export interface InsideTop {
  format: "zip" | "office";
  listed: boolean; // the table of contents was read
  reason?: InsideReason; // why not (listed false), fixed code
  entries?: number; // entries read from the directory
  entries_at_least?: true; // the directory was not read to its end: entries is a lower bound
  shown?: number; // entries listed in untrusted_content.inside.entries
  encrypted?: number; // password-protected entries: never inspectable
  first_bytes_unchecked?: number; // entries whose first bytes could not be looked at
  unpacked_size?: number; // the sum of the sizes the zip DECLARES (a claim, never measured by unpacking)
  flags: InsideFlag[];
  text_chars?: number; // office: characters of text read (before the reply's own budget)
  external_links?: number; // office: outside links found (listed in untrusted_content.inside.external_links)
  embedded?: number; // office: embedded files found
  details?: Partial<Record<InsideFlag, string>>; // fixed text for each code in flags
}

export type InsideJob = { op: "inside"; bytes: Uint8Array; kind: "archive" | "office"; names: string[]; declared_type: string };
export interface InsideResult {
  top: InsideTop;
  uc: Record<string, unknown>;
  flags: Flag[]; // the shield's flags on the names and text
  flags_dropped?: Partial<Record<FlagType, number>>;
  macros?: boolean; // office: macros found (or a macro type by name)
  // office (v0.6 integration): every section of text read (up to office.ts TEXT_MAX, already shield-scanned),
  // numbered from 1 in order; the main thread pages and searches it with receipts (filereply.ts). Never sent as is.
  office_text?: { heading: string; text: string }[];
}

// Fixed text for each code. Tiresias's own words, so they sit at the top level (file_warning.inside.details,
// for the codes present only).
export const INSIDE_FLAG_TEXT: Record<InsideFlag, string> = {
  ...OFFICE_FLAG_TEXT,
  program_inside: "A program or installer is inside (by its name or its first bytes).",
  script_inside: "A script is inside (by its name or its first bytes).",
  shortcut_inside: "A shortcut or system file is inside.",
  addon_inside: "A browser or app add-on is inside.",
  archive_inside: "Another archive is inside. Tiresias lists it by name only and never opens it.",
  office_inside: "An Office document is inside. It was not opened.",
  path_traversal: "A name climbs out of its folder (..): unpacked, it would be written outside the folder chosen.",
  absolute_path: "A name is an absolute path (starts with / or a drive letter): unpacked, it could be written anywhere.",
  deep_path: "A name is nested unusually deep.",
  odd_name: "A name holds control, invisible or direction-changing characters, or is not valid text: it may disguise what the file is.",
  duplicate_names: "Two entries have the same name: different unpackers would keep different files.",
  name_mismatch: "An entry carries two different names (directory, local header or Unicode name): different unpackers would see different files.",
  encrypted: "Password-protected entries: their contents cannot be inspected.",
  encrypted_directory: "The zip's directory itself is encrypted: the names shown may not be the real ones.",
  symlink: "An entry is a symbolic link: unpacked, it can point anywhere on the machine.",
  unsupported_method: "An entry uses a compression method Tiresias does not read: its first bytes were not looked at.",
  overlapping_entries: "Entries share the same bytes: the trick behind small zips that unpack to enormous sizes.",
  directory_mismatch: "The zip's directory does not agree with the entries it points at: the listing may not be what an unpacker would produce.",
  hidden_entries: "There are file headers the directory does not list: some unpackers would find files that are not shown here.",
  out_of_bounds: "An entry points outside the file.",
  high_ratio: "An entry claims to unpack to over 100 times its packed size: a possible zip bomb.",
  huge_when_unpacked: "The entries claim to unpack to over 1 GiB in total: a possible zip bomb.",
  zip64: "The zip uses the large-file (ZIP64) format.",
  multi_disk: "The zip says it is split across several files: only this part was looked at.",
  too_many_entries: "The zip has more entries than Tiresias reads (10,000): the listing stops there.",
  type_mismatch: "An entry's first bytes say it is a different kind of file than its name does.",
  leading_data: "There is data in front of the zip (as in a self-extracting program).",
  trailing_data: "There is data after the zip's end record.",
  multiple_directories: "The file holds more than one zip end record: different unpackers may read different listings.",
  path_conflict: "One entry is a file where another needs a folder (or the other way round): unpacked, one of them is lost or the result depends on the unpacker.",
  attribute_mismatch: "An entry's name and its attributes disagree about whether it is a folder: unpackers may treat it differently.",
  extra_attributes: "An entry carries file-type or permission fields that some unpackers use instead of the directory's; on some systems it may become a link or a program.",
};

// Listed entries: the flagged ones first, then the rest, until this many bytes of JSON.
export const LIST_BUDGET = 24_000;
export const OFFICE_NOTE = "Text only, read in memory. The document was never opened in any program: macros were never run, and outside links were never fetched.";
export const SIZES_NOTE = "Sizes, and where each entry's data ends, are what the zip declares; nothing was unpacked to measure them. Nothing inside was opened, run or saved.";

function shownEntry(e: ZipEntry) {
  return {
    name: e.name, size: e.size, packed: e.packed,
    ...(e.kind ? { kind: e.kind } : {}),
    ...(e.dir ? { dir: true } : {}),
    ...(e.encrypted ? { encrypted: true } : {}),
    ...(e.flags.length ? { flags: e.flags } : {}),
  };
}

// The listing part of a result, shared by archives and Office files (which show only flagged entries).
export function listingParts(z: ZipListing, onlyFlagged: boolean, shield: Shield): { top: InsideTop; entries: ReturnType<typeof shownEntry>[]; omitted: number } {
  const order = [...z.entries.filter((e) => e.flags.length), ...(onlyFlagged ? [] : z.entries.filter((e) => !e.flags.length))];
  const out: ReturnType<typeof shownEntry>[] = [];
  let used = 0;
  for (const e of order) {
    const s = shownEntry(e);
    const cost = jsonBytes(s) + 1; // UTF-8 bytes, as every reply budget counts (Codex round 1)
    if (used + cost > LIST_BUDGET) break;
    out.push(s);
    used += cost;
  }
  for (const e of z.entries) shield.scan(e.name, "a name inside the file");
  const top: InsideTop = {
    format: "zip", listed: true, entries: z.entries.length,
    ...(z.atLeast ? { entries_at_least: true as const } : {}),
    shown: out.length,
    ...(z.encrypted ? { encrypted: z.encrypted } : {}),
    ...(z.unsniffed ? { first_bytes_unchecked: z.unsniffed } : {}),
    unpacked_size: z.totalSize,
    flags: z.flags,
  };
  return { top, entries: out, omitted: order.length - out.length };
}

// The worker side: one file, its kind decided by files.ts, its bytes held in memory.
export function inspect(job: InsideJob): InsideResult {
  const b = Buffer.from(job.bytes.buffer, job.bytes.byteOffset, job.bytes.byteLength);
  const format = job.kind === "office" ? "office" : "zip";
  const z = listZip(b);
  if (!z.ok) return { top: { format, listed: false, reason: z.reason, flags: [] }, uc: {}, flags: [] };
  const shield = new Shield();
  const office = job.kind === "office";
  // An Office file lists only its flagged entries (its parts are noise); its text comes from office.ts.
  const { top, entries, omitted } = listingParts(z, office, shield);
  const uc: Record<string, unknown> = {};
  if (entries.length || !office) uc.entries = entries;
  if (omitted) uc.entries_omitted = omitted;
  let macros = false;
  let officeSecs: { heading: string; text: string }[] | undefined;
  if (office) {
    const o = officeText(b, z, shield);
    officeSecs = o.sections;
    macros = o.macros;
    top.format = "office";
    top.flags = [...top.flags, ...o.flags];
    top.text_chars = o.textChars;
    if (o.external.length || o.externalOmitted) top.external_links = o.external.length + o.externalOmitted;
    if (o.embeddedCount) top.embedded = o.embeddedCount; // all of them, though at most 50 are named
    // The text, section by section, up to TEXT_BUDGET bytes of JSON; the rest is counted.
    const sections: { n: number; heading: string; text: string }[] = [];
    let used = 0, cut = 0;
    for (const [i, sec] of o.sections.entries()) {
      const room = TEXT_BUDGET - used - jsonBytes(sec.heading) - 30;
      if (room <= 0) {
        cut += sec.text.length;
        continue;
      }
      let text = sec.text;
      while (jsonBytes(text) > room) text = text.slice(0, Math.floor(text.length * 0.8)); // shrinks geometrically
      if (text.length && /[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1); // never half a character
      cut += sec.text.length - text.length;
      if (text) sections.push({ n: i + 1, heading: sec.heading, text }); // n: the section number for `section`
      used += jsonBytes(sec.heading) + jsonBytes(text) + 30;
    }
    if (sections.length) uc.sections = sections;
    if (cut) uc.text_omitted = cut;
    const links: { type: string; target: string }[] = [];
    let lused = 0;
    for (const l of o.external) {
      const c = jsonBytes(l) + 1;
      if (lused + c > EXTERNAL_BUDGET) break;
      links.push(l);
      lused += c;
    }
    if (links.length) uc.external_links = links;
    if (o.external.length + o.externalOmitted > links.length) uc.external_links_omitted = o.external.length + o.externalOmitted - links.length;
    if (o.embedded.length) uc.embedded = o.embedded;
    if (o.embeddedCount > o.embedded.length) uc.embedded_omitted = o.embeddedCount - o.embedded.length;
    if (o.skipped.length) uc.skipped_parts = o.skipped; // parts that may hold text and were not read (coordinator, 2026-10-24)
    // Every other string from the file goes through the shield too: headings, link types and targets,
    // embedded names (Codex round 1).
    for (const sec of sections) shield.scan(sec.heading, "a heading inside the file");
    for (const l of links) {
      shield.scan(l.type, "an outside link inside the file");
      shield.scan(l.target, "an outside link inside the file");
    }
    for (const n of o.embedded) shield.scan(n, "an embedded file's name");
    for (const n of o.skipped) shield.scan(n, "a part name inside the file");
    if (!macros && macroName(job.names, job.declared_type)) macros = true;
    if (macros && !top.flags.includes("macros")) top.flags.push("macros");
    uc.note = OFFICE_NOTE;
  } else uc.note = SIZES_NOTE;
  return { top, uc, flags: shield.flags, ...(shield.droppedOrNone() ? { flags_dropped: shield.droppedOrNone() } : {}), ...(macros ? { macros } : {}), ...(office && officeSecs?.length ? { office_text: officeSecs } : {}) };
}

// ---- the main-thread side ----

// A macro type by its name or declared type (.docm, application/vnd.ms-word.document.macroEnabled.12):
// the `macros` flag whether or not the file is looked inside.
// Every name the response gave counts (the header's names and the URL's), not only the one shown (Codex round 1).
export function macroName(names: string[], declaredType: string): boolean {
  for (const raw of names) {
    const n = raw.toLowerCase();
    const ext = n.includes(".") ? n.slice(n.lastIndexOf(".") + 1).trim() : "";
    if (MACRO_OFFICE_EXT.has(ext)) return true;
  }
  return /macroenabled/.test(mimeOf(declaredType));
}
export const allNames = (f: Pick<FileFacts, "declared_name" | "names">): string[] => [...new Set([...(f.names ?? []), ...(f.declared_name !== undefined ? [f.declared_name] : [])])];
export function macroByName(f: Pick<FileFacts, "kind" | "declared_name" | "declared_type" | "names">): boolean {
  return f.kind === "office" && macroName(allNames(f), f.declared_type);
}

// The whole reply must fit its hard limit (envelope.ts BUDGET.hardLimit). The parts of a look inside are
// dropped in this order when it would not, and the reply says which (dropped_for_size); the warning
// itself (file_warning) always stays (Codex round 1).
export function fitInside(e: Envelope, hardLimit: number): void {
  const uc = e.untrusted_content as Record<string, unknown> | null;
  const ins = uc?.inside as Record<string, unknown> | undefined;
  if (!uc || jsonBytes(e) <= hardLimit) return;
  // The note saying what was dropped is part of the reply, so it is in place before each size check
  // (Codex round 2: added after the last check, it could push the reply back over).
  const dropped: string[] = [...((uc.dropped_for_size as string[] | undefined) ?? [])];
  uc.dropped_for_size = dropped;
  const steps: [Record<string, unknown> | undefined, string, string][] = [
    [ins, "entries", "inside.entries"], [ins, "skipped_parts", "inside.skipped_parts"], [ins, "embedded", "inside.embedded"], [ins, "external_links", "inside.external_links"],
    [uc, "receipts", "receipts"], [ins, "sections", "inside.sections"], [ins, "section", "inside.section"],
    [ins, "passages", "inside.passages"], [ins, "outline", "inside.outline"], [uc, "flag_details", "flag_details"], [ins, "note", "inside.note"],
  ];
  for (const [obj, key, label] of steps) {
    if (jsonBytes(e) <= hardLimit) break;
    if (obj && key in obj) {
      delete obj[key];
      dropped.push(label);
    }
  }
  if (!dropped.length) delete uc.dropped_for_size;
}

export const INSIDE_MESSAGE = {
  zip: "Tiresias also read the zip's table of contents (names and declared sizes) in memory, without unpacking it: file_warning.inside has the counts and flags, untrusted_content.inside the names. Nothing inside was opened, run or saved.",
  office: "Tiresias also read the document's text only, in memory, without opening it in any program: file_warning.inside has the counts and flags, untrusted_content.inside the text. Macros were never run and outside links were never fetched.",
  not: "Tiresias did not look inside it (file_warning.inside.reason says why).",
};
export const insideMessage = (t: InsideTop): string => (!t.listed ? INSIDE_MESSAGE.not : t.format === "office" ? INSIDE_MESSAGE.office : INSIDE_MESSAGE.zip);

// Look inside one file, when it is a zip-shaped archive or Office file. Undefined for every other file.
// Any failure (time budget, heap, a bug) is a warning without a listing, never an error: fail closed.
export async function inspectFile(f: FileFacts): Promise<InsideResult | undefined> {
  if (!inspectable(f.kind)) return undefined;
  const format = f.kind === "office" ? "office" : "zip";
  const not = (reason: InsideReason): InsideResult => ({ top: { format, listed: false, reason, flags: [] }, uc: {}, flags: [] });
  if (!f.body) return f.inspect_too_large ? not("too_large") : undefined;
  if (!isZipHead(f.body)) return undefined; // the final verdict changed (a disk image's trailer): not a zip
  const { runUntrusted } = await import("./sandbox.js");
  try {
    const r = await runUntrusted<InsideResult>(
      { op: "inside", bytes: f.body, kind: f.kind, names: allNames(f), declared_type: f.declared_type },
      Number.MAX_SAFE_INTEGER, // never inline: always the worker, under the time budget and heap limit
    );
    if (r.top.flags.length) r.top.details = Object.fromEntries(r.top.flags.map((c) => [c, INSIDE_FLAG_TEXT[c]]));
    return r;
  } catch (e) {
    if (e instanceof FetchError && e.code === "cancelled") throw e;
    return not("too_complex");
  }
}
