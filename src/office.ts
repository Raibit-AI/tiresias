// SPDX-License-Identifier: Apache-2.0
// v0.6 (track "files"), item 2: the text of an Office file (.docx, .xlsx, .pptx and their macro types),
// read from the zip in memory. Only the parts that hold text are inflated, each through readEntry
// (zipread.ts) under a per-part cap and a total cap, each checked against its declared size and CRC.
// Macros are never run: their presence (a vbaProject part, Excel 4 macro sheets, a macro-enabled content
// type) is the `macros` flag. Outside links (relationships with TargetMode="External", HYPERLINK fields and
// formulas) are listed, never fetched. Every XML part goes through xmltext.ts, which refuses any DOCTYPE or
// entity declaration and any part that is not well-formed; a part is validated whole (its root element
// included) before any of it is used. Runs only in the worker thread, like every untrusted parse.
//
// Only the main text is read (coordinator, 2026-10-24): a Word document's main part (word/document.xml), an
// Excel workbook's shared strings and the sheets it lists as visible, a presentation's slides in the order
// presentation.xml lists them. Each is found through the package's own relationships, and the main part must
// be at its usual name; anything else that may hold text (headers, footers, notes, comments, hidden sheets,
// linked workbooks, slide layouts and notes) is named in `skipped`, never read. Package metadata that is
// ambiguous (two main documents, duplicate ids, misplaced index entries) gives no text. XML is fail closed:
// a part outside the accepted subset is refused outright (`office_unreadable`). Text is taken only from
// elements matched by namespace AND name along a set of known container elements; text anywhere else is
// not shown, and `unsupported_content` says so. Hidden-text detection (a run's own vanish, hidden rows,
// columns, shapes, slides and sheets) is BEST EFFORT AND ADVISORY: everything here is untrusted text inside
// untrusted_content with the shield either way, so a missed hidden run can only change what untrusted text
// says. Where Tiresias cannot be sure it matches Office (alternative content, number formats, cached formula
// results, compressed positions), a flag says so. A zip whose structure does not add up gets no text.
import { Shield } from "./shield.js";
import { MAX_URL } from "./types.js";
import { XmlMalformed, XmlRefused, attrOf, isNCName, xmlString, xmlTokens, type XmlToken } from "./xmltext.js";
import { readEntry, type ZipEntry, type ZipFlag, type ZipListing } from "./zipread.js";

export type OfficeFlag =
  | "macros" | "activex" | "embedded_objects" | "external_links" | "external_template" | "dde" | "computed_links" | "checks_incomplete"
  | "xml_doctype" | "xml_malformed" | "unexpected_root" | "ambiguous_package" | "part_too_large" | "part_unreadable" | "part_missing" | "parts_omitted"
  | "hidden_text" | "visibility_uncertain" | "text_refused" | "not_ooxml" | "text_cut" | "alternate_content" | "raw_numbers" | "cached_results"
  | "positions_compressed" | "positions_inconsistent" | "unsupported_content" | "unresolved_cells" | "office_unreadable" | "parts_skipped";

export const OFFICE_FLAG_TEXT: Record<OfficeFlag, string> = {
  macros: "The file holds macros (code that runs when it is opened), or is a macro type. They were never run.",
  activex: "The file holds ActiveX controls (code components). They were never loaded.",
  embedded_objects: "The file has other files embedded in it (untrusted_content.inside.embedded names them). They were not opened.",
  external_links: "The file links to outside addresses (untrusted_content.inside.external_links). None was fetched; an Office program might fetch them when the file is opened.",
  external_template: "The file pulls its template from an outside address, a known way to load macros when it is opened. It was not fetched.",
  dde: "The file holds a DDE field or formula, which can start a program when the file is opened in Office. It was never run.",
  computed_links: "Some HYPERLINK formulas or fields compute their destination; those destinations were not worked out or listed.",
  checks_incomplete: "Some fields or formulas were too long, or too many, to check fully, so the DDE and link checks may have missed something.",
  xml_doctype: "A part has a document type or entity declaration, which Office files never need. That part was not read.",
  xml_malformed: "A part is not well-formed XML, so Office would not read it the way Tiresias would. That part was not read.",
  unexpected_root: "A part is not the kind of part the file says it is (its root element is wrong). That part was not read.",
  ambiguous_package: "The file's own index is ambiguous (two main documents, a repeated or missing relationship id, a part typed twice, or a main document of a type Tiresias does not know), so the part it names could not be told for sure.",
  part_too_large: "A part is larger than Tiresias inflates (8 MiB, or 32 MiB for the whole file), or claims a wrong size. It was not read.",
  part_unreadable: "A part could not be read (damaged, encrypted, or its checksum does not match). It was skipped.",
  part_missing: "A part the file refers to is not in it. It was skipped.",
  parts_omitted: "The file has more parts (relationship lists, slides, sheets, headers) than Tiresias reads; the rest were not read, so the text and the list of outside links may be incomplete.",
  hidden_text: "Some text is hidden when the file is opened (hidden runs, rows, columns, shapes, slides or sheets). It is not shown; see flag_details. Hidden-text detection is best effort and advisory: all of this text is untrusted either way.",
  visibility_uncertain: "Whether some text is hidden could not be fully worked out (very many hidden columns). Hidden-text flags are best effort and advisory.",
  text_refused: "The zip's structure does not add up (see the other flags), so no text was read from it: different programs could show different text.",
  not_ooxml: "Not an Office Open XML file Tiresias reads (no [Content_Types].xml, no single main document, or a main document of another type): only its listing was read.",
  text_cut: "The document has more text than Tiresias reads (200,000 characters, or a shared-string table past its limit): the rest was not read.",
  alternate_content: "Some content is marked for particular Office versions (alternative or ignorable markup); Tiresias read what an older program would, which may differ from what a given program shows.",
  raw_numbers: "Numbers and dates are shown as stored, without each cell's display format (a date shows as a serial number or an ISO date, a percentage as a fraction).",
  cached_results: "Values computed by formulas, Word fields or slide fields (dates, slide numbers) are shown as saved in the file, which Office may recalculate to something else when it is opened (or nothing, when none was saved). No formula or field was evaluated.",
  positions_compressed: "Some long runs of empty rows or columns were shortened, so the row and column positions of later cells are not exact.",
  office_unreadable: "A part Tiresias would read is outside the small XML subset it accepts (a document type or entity declaration, a processing instruction, malformed structure, a wrong root, a namespace it must understand and cannot, or bytes that are not valid text). That part was refused outright and gave no text.",
  parts_skipped: "Tiresias reads only the main text of an Office file (a Word document's body, an Excel file's shared strings and visible sheets, a presentation's listed slides). Other parts that may hold text (headers, footers, notes, comments, hidden sheets, linked workbooks, slide layouts and notes) were not read; untrusted_content.inside.skipped_parts names them.",
  positions_inconsistent: "Some rows or cells are out of order, repeated, or name another row, so they were placed where they came in the file; their positions in the text are not exact.",
  unresolved_cells: "Some cells refer to shared text that is not in the file (or not where it should be); they are shown empty.",
  unsupported_content: "Some visible content is in a form or place Tiresias does not read (an imported chunk, a chart, a diagram, a subdocument, text on a slide layout or master, or text in markup it does not know); it is not in the text, and text found in unknown markup is in flag_details as hidden text.",
};

export const PART_CAP = 8 * 1024 * 1024; // the most one part may inflate to
export const TOTAL_CAP = 32 * 1024 * 1024; // the most all parts of one file may inflate to
export const TEXT_MAX = 200_000; // characters of text read from one file
export const MAX_PARTS = 500; // slides, sheets, headers... read at most
export const MAX_RELS = 1_000; // .rels parts read at most
export const MAX_EXTERNAL = 200; // outside links listed at most
export const MAX_EMBEDDED = 50; // embedded file names listed at most (all are counted)
export const MAX_STRINGS = 1_000_000; // shared strings kept at most
export const MAX_GAP = 256; // empty columns, or empty rows, kept between two cells
export const MAX_HIDDEN_COLS = 1_000; // hidden column ranges kept
export const MAX_INSTR = 10_000; // characters of one field instruction or formula checked
export const MAX_CALLS = 100; // HYPERLINK calls looked at in one formula
export const TEXT_BUDGET = 40_000; // bytes of JSON of text in the reply
export const EXTERNAL_BUDGET = 12_000; // bytes of JSON of outside links in the reply

// Namespaces (transitional and strict forms).
const NS: Record<"w" | "a" | "p" | "s" | "r" | "rel" | "ct" | "mc" | "m" | "wp" | "wps" | "wpg" | "v", readonly string[]> = {
  w: ["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"],
  a: ["http://schemas.openxmlformats.org/drawingml/2006/main", "http://purl.oclc.org/ooxml/drawingml/main"],
  p: ["http://schemas.openxmlformats.org/presentationml/2006/main", "http://purl.oclc.org/ooxml/presentationml/main"],
  s: ["http://schemas.openxmlformats.org/spreadsheetml/2006/main", "http://purl.oclc.org/ooxml/spreadsheetml/main"],
  r: ["http://schemas.openxmlformats.org/officeDocument/2006/relationships", "http://purl.oclc.org/ooxml/officeDocument/relationships"],
  rel: ["http://schemas.openxmlformats.org/package/2006/relationships"],
  ct: ["http://schemas.openxmlformats.org/package/2006/content-types"],
  mc: ["http://schemas.openxmlformats.org/markup-compatibility/2006"],
  m: ["http://schemas.openxmlformats.org/officeDocument/2006/math", "http://purl.oclc.org/ooxml/officeDocument/math"],
  wp: ["http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing", "http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing"],
  wps: ["http://schemas.microsoft.com/office/word/2010/wordprocessingShape"],
  wpg: ["http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"],
  v: ["urn:schemas-microsoft-com:vml"],
};
// Namespaces Tiresias reads (for markup compatibility: an ignorable element in any OTHER namespace is skipped
// with its content, and a part that MUST be understood in another namespace is not read).
// Since round 5 a part that uses any OTHER namespace without marking it ignorable is refused outright (fail
// closed), so this list also names the standard namespaces Office files use around the text Tiresias reads
// (pictures, charts and diagrams by reference, the drawing canvas, VML and its Office extensions, Word's
// own extension namespace); their content is never taken as text unless it sits in a known container.
const UNDERSTOOD = new Set<string>([
  ...Object.values(NS).flat(),
  "http://schemas.openxmlformats.org/drawingml/2006/picture", "http://purl.oclc.org/ooxml/drawingml/picture",
  "http://schemas.openxmlformats.org/drawingml/2006/chart", "http://purl.oclc.org/ooxml/drawingml/chart",
  "http://schemas.openxmlformats.org/drawingml/2006/diagram", "http://purl.oclc.org/ooxml/drawingml/diagram",
  "http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas", "http://schemas.microsoft.com/office/word/2006/wordml",
  "urn:schemas-microsoft-com:office:office", "urn:schemas-microsoft-com:office:word", "urn:schemas-microsoft-com:office:excel", "urn:schemas-microsoft-com:office:powerpoint",
]);
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

// The container elements text may sit in, per format (Codex round 3): text inside anything else is not shown.
type Allow = [readonly string[], readonly string[] | "*"][];
const words = (s: string) => s.split(" ");
const DOCX_PATH: Allow = [
  [NS.w, words("document body hdr ftr footnotes footnote endnotes endnote comments comment p r t hyperlink smartTag sdt sdtContent ins moveTo fldSimple tbl tr tc customXml bdo dir txbxContent drawing pict object ruby rubyBase tab ptab br cr noBreakHyphen softHyphen sym")],
  [NS.wp, words("inline anchor")], [NS.a, words("graphic graphicData")], [NS.wps, words("wsp txbx")], [NS.wpg, words("wgp grpSp")],
  [NS.v, words("shape textbox group rect roundrect oval")], [NS.m, "*"],
];
const PPTX_PATH: Allow = [
  [NS.p, words("sld cSld spTree sp grpSp graphicFrame txBody")],
  [NS.a, words("p r fld t br graphic graphicData tbl tr tc txBody")],
];
// The places of the worksheet elements Tiresias reads (Codex rounds 5, 12, 13).
const W_ROW = "s:worksheet/s:sheetData", W_CELL = W_ROW + "/s:row", W_IN_CELL = W_CELL + "/s:c";
const SHEET_WHERE: Record<string, string[]> = {
  sheetData: ["s:worksheet"], col: ["s:worksheet/s:cols"], row: [W_ROW], c: [W_CELL], v: [W_IN_CELL], is: [W_IN_CELL], f: [W_IN_CELL],
  t: [W_IN_CELL + "/s:is", W_IN_CELL + "/s:is/s:r", W_IN_CELL + "/s:is/s:rPh"], rPh: [W_IN_CELL + "/s:is"], r: [W_IN_CELL + "/s:is"],
};
// The whole accepted grammar below sheetData and in the shared-string table (Codex round 14): for each
// parent, the children it may have. Anything else under these parents (a nested element in a value, a
// formula or a text leaf included) refuses the part.
const RUN_FORMAT = "s:b s:i s:strike s:condense s:extend s:outline s:shadow s:u s:vertAlign s:sz s:color s:rFont s:family s:charset s:scheme";
const CHILDREN: Record<string, Set<string>> = {
  "s:sheetData": new Set(["s:row"]),
  "s:row": new Set(["s:c", "s:extLst"]),
  "s:c": new Set(["s:f", "s:v", "s:is", "s:extLst"]),
  "s:is": new Set(["s:t", "s:r", "s:rPh", "s:phoneticPr"]),
  "s:si": new Set(["s:t", "s:r", "s:rPh", "s:phoneticPr"]),
  "s:sst": new Set(["s:si", "s:extLst"]),
  "s:r": new Set(["s:rPr", "s:t"]),
  "s:rPr": new Set(RUN_FORMAT.split(" ")),
  "s:rPh": new Set(["s:t"]),
};
const LEAVES = new Set(["s:v", "s:f", "s:t", "s:phoneticPr", "s:extLst", ...RUN_FORMAT.split(" ")]);
// One rich or simple string (an <is> or an <si>): one t, or one or more r each with exactly one t; never both.
type StrState = { t: number; r: number; rT: number[] };
const inSet = (s: string) => {
  const set = new Set(s.split(" "));
  return (parent: string) => set.has(parent);
};
const RUN_CHILD = inSet("w:r");
const DOCX_PARENTS: Record<string, (parent: string) => boolean> = {
  "w:t": RUN_CHILD, "w:tab": RUN_CHILD, "w:br": RUN_CHILD, "w:cr": RUN_CHILD, "w:noBreakHyphen": RUN_CHILD, "w:softHyphen": RUN_CHILD,
  "w:ptab": RUN_CHILD, "w:sym": RUN_CHILD, "w:instrText": RUN_CHILD, "w:fldChar": RUN_CHILD, "w:delText": RUN_CHILD,
  "w:r": inSet("w:p w:hyperlink w:smartTag w:sdtContent w:ins w:del w:moveTo w:moveFrom w:fldSimple w:customXml w:bdo w:dir w:rubyBase w:rt"),
  "w:p": inSet("w:body w:tc w:sdtContent w:txbxContent w:customXml w:hdr w:ftr w:footnote w:endnote w:comment"),
  "m:t": inSet("m:r"),
  "m:r": (p) => p.startsWith("m:"),
};
const PPTX_PARENTS: Record<string, (parent: string) => boolean> = {
  "a:t": inSet("a:r a:fld"), "a:r": inSet("a:p"), "a:fld": inSet("a:p"), "a:br": inSet("a:p"),
  "a:p": inSet("a:txBody p:txBody"), "p:txBody": inSet("p:sp"),
};
const allowed = (t: Extract<XmlToken, { t: "open" }>, path: Allow) => path.some(([ns, names]) => ns.includes(t.ns) && (names === "*" || names.includes(t.local)));

const REL_BASES = ["http://schemas.openxmlformats.org/officeDocument/2006/relationships/", "http://purl.oclc.org/ooxml/officeDocument/relationships/"];
// The short name of a standard relationship type ("header", "officeDocument"), or null for any other type.
export const relKind = (type: string): string | null => {
  for (const b of REL_BASES) if (type.startsWith(b) && type.length > b.length && !type.slice(b.length).includes("/")) return type.slice(b.length);
  return null;
};
// The main part's content type, exactly (Codex round 3: never by a piece of it).
// A Map, never a plain object: a content type like "constructor" must not find an inherited value (Codex round 4).
const MAIN_TYPES = new Map<string, "docx" | "xlsx" | "pptx">();
for (const t of words("wordprocessingml.document.main+xml wordprocessingml.template.main+xml")) MAIN_TYPES.set(`application/vnd.openxmlformats-officedocument.${t}`, "docx");
for (const t of words("document.macroenabled.main+xml template.macroenabledtemplate.main+xml")) MAIN_TYPES.set(`application/vnd.ms-word.${t}`, "docx");
for (const t of words("spreadsheetml.sheet.main+xml spreadsheetml.template.main+xml")) MAIN_TYPES.set(`application/vnd.openxmlformats-officedocument.${t}`, "xlsx");
for (const t of words("sheet.macroenabled.main+xml template.macroenabled.main+xml addin.macroenabled.main+xml")) MAIN_TYPES.set(`application/vnd.ms-excel.${t}`, "xlsx");
for (const t of words("presentationml.presentation.main+xml presentationml.slideshow.main+xml presentationml.template.main+xml")) MAIN_TYPES.set(`application/vnd.openxmlformats-officedocument.${t}`, "pptx");
for (const t of words("presentation.macroenabled.main+xml slideshow.macroenabled.main+xml template.macroenabled.main+xml addin.macroenabled.main+xml")) MAIN_TYPES.set(`application/vnd.ms-powerpoint.${t}`, "pptx");
const CANON = { docx: "word/document.xml", xlsx: "xl/workbook.xml", pptx: "ppt/presentation.xml" } as const;
// Visible content in a form Tiresias does not read.
const UNSUPPORTED_KINDS = new Set(["aFChunk", "diagramData", "chart", "subDocument"]);
type Ns = readonly string[];
// A token with the path of its ancestors ("w:document/w:body/w:p"), namespaces shown by their short key.
type PT = XmlToken & { path: string; ign?: ReadonlySet<string> }; // ign: on open tags, the ignorable namespaces in force
const NSKEY = new Map<string, string>();
for (const [k, list] of Object.entries(NS)) for (const u of list) NSKEY.set(u, k);
const keyOf = (t: { ns: string; local: string }) => `${NSKEY.get(t.ns) ?? "?"}:${t.local}`;
const is = (t: XmlToken, ns: Ns, local: string): boolean => t.t !== "text" && t.local === local && ns.includes(t.ns);
const ON = (v: string | undefined) => v === undefined || !/^(0|false|off)$/i.test(v);

// Zip flags under which no text is read.
const UNSAFE: ZipFlag[] = ["overlapping_entries", "directory_mismatch", "hidden_entries", "duplicate_names", "name_mismatch", "multiple_directories", "encrypted_directory", "out_of_bounds", "path_conflict", "too_many_entries"];

export interface OfficeText {
  format: "docx" | "xlsx" | "pptx" | null;
  sections: { heading: string; text: string }[];
  flags: OfficeFlag[];
  external: { type: string; target: string }[];
  externalOmitted: number;
  embedded: string[];
  embeddedCount: number;
  skipped: string[]; // parts that may hold text and were not read (at most 50 named)
  macros: boolean;
  textChars: number;
}

const lastSeg = (s: string) => s.slice(s.lastIndexOf("/") + 1);
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");
// A relationship target, relative to the part that names it (or absolute from the package root).
export function resolvePart(source: string, target: string): string | null {
  // A part name is used as written: no percent-decoding, which could pick a different member (Codex round 5).
  // A target with a percent escape, a backslash, a query or a fragment is refused (no part), never guessed.
  if (/[%\\?#]/.test(target)) return null;
  const t = target;
  const segs = (t.startsWith("/") ? t.slice(1) : dirOf(source) + t).split("/");
  const out: string[] = [];
  for (const s of segs) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (!out.length) return null; // above the package root: no such part
      out.pop();
    } else out.push(s);
  }
  return out.join("/");
}
// The rels part of a part: word/document.xml -> word/_rels/document.xml.rels
const relsOf = (part: string) => `${dirOf(part)}_rels/${lastSeg(part)}.rels`;

// OOXML escapes in spreadsheet strings: _xHHHH_ is that character; _x005F_ keeps a literal underscore.
export const unescapeOoxml = (s: string): string =>
  s.indexOf("_x") === -1 ? s : s.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));

// Column number of a cell reference ("AB12" -> 27), 0-based; -1 when it has none.
export function colOf(ref: string | undefined): number {
  if (!ref) return -1;
  let n = 0;
  let i = 0;
  for (; i < ref.length && i < 4; i++) {
    const c = ref.charCodeAt(i) | 0x20;
    if (c < 0x61 || c > 0x7a) break;
    n = n * 26 + (c - 0x60);
  }
  return i === 0 || n > 16384 ? -1 : n - 1;
}

// The destination of a field that reaches outside the document (Codex rounds 5 and 6): HYPERLINK,
// INCLUDETEXT, INCLUDEPICTURE and IMPORT name it as their first argument, LINK as its second (after the
// class name). The instruction is split into words (a quoted word may hold spaces); switches start with a
// backslash, and the ones that take an argument (per field) take the next word. Undefined: not such a field;
// null: such a field with no destination found (HYPERLINK with only a \l bookmark points inside the document).
const FIELD_ARGS: Record<string, { at: number; withArg: string }> = {
  // (HYPERLINK's \m, an image map, takes no argument: Codex round 13)
  HYPERLINK: { at: 0, withArg: "lot" }, INCLUDETEXT: { at: 0, withArg: "cntx" }, INCLUDE: { at: 0, withArg: "cntx" }, INCLUDEPICTURE: { at: 0, withArg: "c" }, IMPORT: { at: 0, withArg: "c" }, LINK: { at: 1, withArg: "" },
};
export function fieldTarget(instr: string): { field: string; target: string | null; local?: true } | undefined {
  const m = /^\s*([A-Za-z]+)/.exec(instr);
  const field = m?.[1].toUpperCase();
  if (!field || !FIELD_ARGS[field]) return undefined;
  const spec = FIELD_ARGS[field];
  const words: { w: string; quoted: boolean }[] = [];
  for (let i = m![0].length; i < instr.length; ) { // the whole instruction (at most MAX_INSTR characters) is read (Codex round 10)
    while (i < instr.length && /\s/.test(instr[i])) i++;
    if (i >= instr.length) break;
    if (instr[i] === '"') {
      const e = instr.indexOf('"', i + 1);
      const end = e === -1 ? instr.length : e;
      words.push({ w: instr.slice(i + 1, end).replace(/\\\\/g, "\\"), quoted: true }); // a doubled backslash in a quoted path is one
      i = end + 1;
    } else {
      let e = i;
      while (e < instr.length && !/\s/.test(instr[e])) e++;
      words.push({ w: instr.slice(i, e), quoted: false });
      i = e;
    }
  }
  let seen = 0;
  for (let k = 0; k < words.length; k++) {
    const { w, quoted } = words[k];
    if (!quoted && w.startsWith("\\")) {
      if (w.length === 2 && spec.withArg.includes(w[1].toLowerCase())) k++; // its argument
      continue;
    }
    if (seen++ === spec.at) return { field, target: w };
  }
  // A HYPERLINK with only a \l bookmark points inside the document (Codex round 7: only that case is local).
  if (field === "HYPERLINK" && words.some((x) => !x.quoted && /^\\l$/i.test(x.w))) return { field, target: null, local: true };
  return { field, target: null };
}
export const hyperlinkTarget = (instr: string): string | null => fieldTarget(instr)?.target ?? null;

// The destinations of every HYPERLINK(...) call in a formula: the first argument when it is a string
// literal ("" is a quote inside it); any other first argument is computed and only counted (Codex round 2).
// `more` is set when there were more calls than MAX_CALLS (Codex round 3: never a silent stop).
export function hyperlinkCalls(f: string, fn = "HYPERLINK"): { targets: string[]; computed: number; more?: true } {
  const out: { targets: string[]; computed: number; more?: true } = { targets: [], computed: 0 };
  const re = new RegExp(`\\b${fn}\\s*\\(`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(f))) {
    if (out.targets.length + out.computed >= MAX_CALLS) {
      out.more = true;
      break;
    }
    let i = m.index + m[0].length;
    while (f[i] === " ") i++;
    if (f[i] !== '"') {
      out.computed++;
      continue;
    }
    let s = "";
    for (i++; i < f.length; i++) {
      if (f[i] === '"') {
        if (f[i + 1] === '"') {
          s += '"';
          i++;
          continue;
        }
        break;
      }
      s += f[i];
    }
    const after = f.slice(i + 1).trimStart()[0];
    if (i < f.length && (after === "," || after === ")")) out.targets.push(s);
    else out.computed++; // a string joined to something else ("a" & B1): computed
  }
  return out;
}

export function officeText(b: Buffer, z: ZipListing, shield: Shield): OfficeText {
  const flags = new Set<OfficeFlag>();
  const out: OfficeText = { format: null, sections: [], flags: [], external: [], externalOmitted: 0, embedded: [], embeddedCount: 0, skipped: [], macros: false, textChars: 0 };
  const skip = (part: string | null) => {
    flags.add("parts_skipped");
    if (part !== null && !out.skipped.includes(part) && out.skipped.length < 50) out.skipped.push(part);
  };
  const byName = new Map<string, ZipEntry>();
  for (const e of z.entries) if (!byName.has(e.rawName.toLowerCase())) byName.set(e.rawName.toLowerCase(), e);
  // Macros, ActiveX and embedded files, by part name: always looked for, whatever else happens.
  for (const e of z.entries) {
    const n = e.rawName.toLowerCase().replace(/\\/g, "/");
    if (/(^|\/)vbaproject\.bin$/.test(n) || /(^|\/)vbadata\.xml$/.test(n) || n.startsWith("xl/macrosheets/") || /(^|\/)vbaprojectsignature/.test(n)) flags.add("macros");
    if (/(^|\/)activex\//.test(n)) flags.add("activex");
    if (/(^|\/)embeddings\//.test(n) && !e.dir) {
      flags.add("embedded_objects");
      out.embeddedCount++;
      if (out.embedded.length < MAX_EMBEDDED) out.embedded.push(e.name);
    }
  }
  const link = (type: string, target: string) => {
    flags.add("external_links");
    if (out.external.length >= MAX_EXTERNAL || target.length > MAX_URL) out.externalOmitted++;
    else out.external.push({ type: type.slice(0, 100), target });
  };
  let budget = TOTAL_CAP;
  // One part's text. A part that is missing, refused or fails its checks gives nothing.
  const read = (name: string | null): string | null => {
    if (name === null) {
      flags.add("part_missing");
      return null;
    }
    const e = byName.get(name.toLowerCase());
    if (!e) {
      flags.add("part_missing");
      return null;
    }
    const limit = Math.min(PART_CAP, budget);
    const r = readEntry(b, e, limit);
    // What zlib may have produced counts against the total even when the part is refused (at most its
    // declared size plus one byte), so failing parts cannot repeat for free. A part over the limit is
    // refused before any inflate.
    if (e.size <= limit) budget -= Math.min(limit, e.size + 1);
    if (!r.ok) {
      flags.add(r.reason === "too_large" ? "part_too_large" : "part_unreadable");
      return null;
    }
    try {
      return xmlString(r.data);
    } catch {
      flags.add("xml_malformed"); // not valid UTF-8 or UTF-16, or a declaration that does not match
      flags.add("office_unreadable");
      return null;
    }
  };
  // A part's tokens, validated WHOLE first (a refused or malformed part, one whose root element is not
  // `root`, or one that requires a namespace Tiresias does not read, gives nothing at all). Then markup
  // compatibility is applied: alternative content gives its Fallback when there is one, else its first
  // Choice; an element in an ignorable namespace Tiresias does not read is skipped with its content (or,
  // named in ProcessContent, without its own tag only).
  const tokens = (xml: string | null, root?: [Ns, string]): Iterable<PT> | null => {
    if (xml === null) return null;
    const fallbacks: boolean[] = []; // per mc:AlternateContent, in document order: has it a Fallback?
    try {
      const open: number[] = [];
      let first = true;
      for (const t of xmlTokens(xml)) {
        if (t.t !== "open") {
          if (t.t === "close" && is(t, NS.mc, "AlternateContent")) open.pop();
          continue;
        }
        if (first) {
          first = false;
          if (root && !is(t, root[0], root[1])) {
            flags.add("unexpected_root");
            flags.add("office_unreadable");
            return null;
          }
        }
        const must = attrOf(t, NS.mc, "MustUnderstand");
        if (must)
          for (const p of must.split(/\s+/))
            if (p && !UNDERSTOOD.has(t.scope.get(p) ?? "")) {
              flags.add("unsupported_content"); // Office would not open a part it must understand and cannot
              flags.add("office_unreadable");
              return null;
            }
        if (is(t, NS.mc, "AlternateContent")) {
          open.push(fallbacks.length);
          fallbacks.push(false);
        } else if (is(t, NS.mc, "Fallback") && open.length) fallbacks[open[open.length - 1]] = true;
      }
    } catch (e) {
      if (e instanceof XmlRefused) flags.add("xml_doctype");
      else if (e instanceof XmlMalformed) flags.add("xml_malformed");
      else throw e;
      flags.add("office_unreadable"); // fail closed: the whole part is refused (coordinator, 2026-10-24)
      return null;
    }
    if (fallbacks.length) flags.add("alternate_content");
    let badExt = false;
    const gen = function* (): Generator<PT> {
      let ac = 0;
      const alts: { fallback: boolean; taken: boolean }[] = [];
      // Per open element: the ignorable namespaces and ProcessContent names in force, and whether its own
      // tags were dropped (ProcessContent) so its close tag is dropped too.
      const frames: { ign: Set<string>; proc: Set<string>; dropTag: boolean }[] = [];
      let skip = 0; // depth inside a skipped subtree
      const anc: string[] = []; // the yielded open elements, for each token's path
      const out2 = (t: XmlToken): PT => {
        if (t.t === "open") {
          const path = anc.join("/");
          anc.push(keyOf(t));
          return { ...t, path, ign: frames[frames.length - 1]?.ign };
        }
        if (t.t === "close") anc.pop();
        return { ...t, path: anc.join("/") };
      };
      for (const t of xmlTokens(xml)) {
        if (skip) {
          if (t.t === "open") skip++;
          else if (t.t === "close") skip--;
          continue;
        }
        // Extensions (Codex rounds 9 and 10): an extLst of DrawingML, PresentationML or SpreadsheetML must sit
        // inside an element of its own namespace; its `ext` children are opaque (never read, never text, any
        // namespace allowed inside). An extLst anywhere else, or anything but `ext` inside one, is malformed
        // structure and refuses the part.
        if (t.t === "open") {
          const k = NSKEY.get(t.ns);
          const parentKey = anc[anc.length - 1] ?? "";
          if (k && (k === "a" || k === "p" || k === "s") && t.local === "extLst" && !parentKey.startsWith(`${k}:`)) badExt = true;
          if (parentKey.endsWith(":extLst") && ["a", "p", "s"].includes(parentKey.split(":")[0])) {
            if (!(k === parentKey.split(":")[0] && t.local === "ext")) badExt = true;
            skip = 1; // the extension's content is opaque
            continue;
          }
        }
        if (t.t === "open") {
          const parent = frames[frames.length - 1];
          let ign = parent?.ign ?? new Set<string>();
          let proc = parent?.proc ?? new Set<string>();
          const ignAttr = attrOf(t, NS.mc, "Ignorable");
          const procAttr = attrOf(t, NS.mc, "ProcessContent");
          if (ignAttr) {
            ign = new Set(ign);
            for (const p of ignAttr.split(/\s+/)) if (p && t.scope.has(p)) ign.add(t.scope.get(p)!);
          }
          if (procAttr) {
            proc = new Set(proc);
            for (const q of procAttr.split(/\s+/)) {
              const [p, l] = q.split(":");
              if (p && l && t.scope.has(p)) proc.add(`${t.scope.get(p)}|${l}`);
            }
          }
          if (ign.has(t.ns) && !UNDERSTOOD.has(t.ns)) {
            flags.add("alternate_content");
            if (proc.has(`${t.ns}|${t.local}`) || proc.has(`${t.ns}|*`)) {
              frames.push({ ign, proc, dropTag: true });
              continue;
            }
            skip = 1;
            continue;
          }
          frames.push({ ign, proc, dropTag: false });
        } else if (t.t === "close") {
          const f = frames.pop();
          if (f?.dropTag) continue;
        }
        if (t.t === "open" && is(t, NS.mc, "AlternateContent")) {
          alts.push({ fallback: fallbacks[ac++], taken: false });
          continue;
        }
        if (t.t === "close" && is(t, NS.mc, "AlternateContent")) {
          alts.pop();
          continue;
        }
        const top = alts[alts.length - 1];
        if (top && t.t === "open" && (is(t, NS.mc, "Choice") || is(t, NS.mc, "Fallback"))) {
          const want = is(t, NS.mc, "Fallback") ? true : !top.fallback && !top.taken;
          if (!want) {
            frames.pop(); // the skipped element's frame
            skip = 1;
          } else top.taken = true;
          continue;
        }
        if (top && t.t === "close" && (is(t, NS.mc, "Choice") || is(t, NS.mc, "Fallback"))) continue;
        yield out2(t);
      }
    };
    // Namespace obligations, checked over the WHOLE part before any of it is used (Codex round 5): after
    // markup compatibility, every element and every prefixed attribute must be in a namespace Tiresias
    // knows, or one marked ignorable; anything else refuses the part, as Office would. Extension lists
    // (extLst) hold any namespace by design and are exempt (their content is never text).
    try {
      for (const t of gen()) {
        if (t.t !== "open") continue; // (extension content never reaches here: it is skipped as opaque)
        const ok = (ns: string, attr: boolean) => UNDERSTOOD.has(ns) || (attr && (ns === "" || ns === XML_NS || ns === XMLNS_NS)) || (t.ign?.has(ns) ?? false);
        if (!ok(t.ns, false) || t.attrs.some((a) => !ok(a.ns, true))) {
          flags.add("unsupported_content");
          flags.add("office_unreadable");
          return null;
        }
      }
    } catch (e) {
      if (!(e instanceof XmlMalformed)) throw e;
      flags.add("xml_malformed");
      flags.add("office_unreadable");
      return null;
    }
    if (badExt) {
      flags.add("xml_malformed");
      flags.add("office_unreadable");
      return null;
    }
    return gen();
  };
  const finish = (): OfficeText => {
    out.flags = [...flags];
    out.macros = flags.has("macros");
    return out;
  };
  // A directory read only in part (past the entry cap) cannot vouch for the parts chosen (Codex round 5).
  if (z.atLeast || z.flags.some((f) => UNSAFE.includes(f))) {
    flags.add("text_refused");
    return finish();
  }
  // Content types: a macro-enabled type anywhere is the macros flag; a part typed twice is ambiguous.
  const types = new Map<string, string>();
  const defaults = new Map<string, string>(); // extension -> content type (Default entries)
  const ctXml = byName.has("[content_types].xml") ? read("[Content_Types].xml") : null;
  const ctToks = tokens(ctXml, [NS.ct, "Types"]);
  if (ctToks)
    for (const t of ctToks) {
      if (t.t !== "open" || !NS.ct.includes(t.ns) || (t.local === "Types" && t.path === "")) continue;
      // Only a Default or Override directly under Types counts; anything else there is ambiguous (Codex round 4).
      if (t.path !== "ct:Types" || (t.local !== "Default" && t.local !== "Override")) {
        flags.add("ambiguous_package");
        continue;
      }
      const type = (attrOf(t, "", "ContentType") ?? "").toLowerCase();
      if (/macroenabled|vbaproject|ms-office\.activex|macrosheet/.test(type)) flags.add("macros");
      if (t.local === "Default") {
        const ext = (attrOf(t, "", "Extension") ?? "").toLowerCase();
        if (ext && defaults.has(ext) && defaults.get(ext) !== type) flags.add("ambiguous_package");
        if (ext) defaults.set(ext, type);
      }
      if (t.local === "Override") {
        const p = (attrOf(t, "", "PartName") ?? "").replace(/^\//, "").toLowerCase();
        if (!p) continue;
        if (types.has(p) && types.get(p) !== type) flags.add("ambiguous_package");
        types.set(p, type);
      }
    }
  // Every relationship part: outside links are listed (never fetched), and remembered by source part. A
  // part with a missing or repeated id is ambiguous: its outside links are still listed, but it names no
  // part (Codex round 3).
  type Rel = { id: string; type: string; kind: string | null; target: string; external: boolean };
  const rels = new Map<string, Rel[]>();
  let relsRead = 0;
  for (const e of z.entries) {
    if (!e.rawName.toLowerCase().endsWith(".rels") || e.dir) continue;
    if (relsRead++ >= MAX_RELS) {
      flags.add("parts_omitted");
      break;
    }
    // A relationship part must be typed as one (Codex round 9); otherwise it names nothing.
    const lower = e.rawName.toLowerCase();
    if ((types.get(lower) ?? defaults.get("rels")) !== "application/vnd.openxmlformats-package.relationships+xml") {
      flags.add("ambiguous_package");
      continue;
    }
    const toks = tokens(read(e.rawName), [NS.rel, "Relationships"]);
    if (!toks) continue;
    const list: Rel[] = [];
    const ids = new Set<string>();
    let bad = false;
    for (const t of toks) {
      if (t.t !== "open" || !is(t, NS.rel, "Relationship")) continue;
      if (t.path !== "rel:Relationships") bad = true; // a relationship anywhere but directly under the root (Codex round 4)
      const id = attrOf(t, "", "Id");
      const type = attrOf(t, "", "Type");
      const target = attrOf(t, "", "Target") ?? "";
      // Ids are XML identifiers, once each; the mode is absent, Internal or External, exactly (Codex round 9).
      const mode = attrOf(t, "", "TargetMode");
      if (!id || !type || !attrOf(t, "", "Target") || ids.has(id) || !isNCName(id) || (mode !== undefined && mode !== "Internal" && mode !== "External")) bad = true;
      if (id) ids.add(id);
      const external = mode === "External";
      const kind = relKind(type ?? "");
      // Macro sheets and VBA projects by relationship, wherever their parts are kept (Codex round 5).
      if (/^http:\/\/schemas\.microsoft\.com\/office\/2006\/relationships\/(xlMacrosheet|xlIntlMacrosheet|vbaProject)$/.test(type ?? "")) flags.add("macros");
      list.push({ id: id ?? "", type: type ?? "", kind, target, external });
      if (!external) {
        if (kind && UNSUPPORTED_KINDS.has(kind)) flags.add("unsupported_content");
        continue;
      }
      if (kind === "attachedTemplate") flags.add("external_template");
      link(kind ?? lastSeg(type ?? ""), target);
    }
    if (bad) flags.add("ambiguous_package");
    else rels.set(e.rawName.toLowerCase(), list);
  }
  // A selected part's effective content type (its Override, else the Default for its extension) must be the
  // one its role needs; anything else is ambiguous and the part is not read (Codex round 5).
  const typed = (part: string | null, want: string): boolean => {
    if (part === null || !byName.has(part.toLowerCase())) return true; // missing parts are reported by read()
    const lower = part.toLowerCase();
    const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
    const t = types.get(lower) ?? defaults.get(ext);
    if (t === `application/vnd.openxmlformats-officedocument.${want}`) return true;
    flags.add("ambiguous_package");
    return false;
  };
  const relsFor = (part: string) => rels.get(relsOf(part).toLowerCase()) ?? [];
  const internal = (part: string, kind: string) => relsFor(part).filter((r) => !r.external && r.kind === kind);
  // The main part: exactly one officeDocument relationship, to a part typed exactly as a main document.
  const mains = internal("", "officeDocument");
  if (mains.length > 1) flags.add("ambiguous_package");
  const mainPart = mains.length === 1 ? resolvePart("", mains[0].target) : null;
  if (ctXml === null || !mainPart || !byName.has(mainPart.toLowerCase()) || flags.has("ambiguous_package")) {
    flags.add("not_ooxml");
    return finish();
  }
  out.format = MAIN_TYPES.get(types.get(mainPart.toLowerCase()) ?? "") ?? null;
  // The main part must also be where each format keeps it (coordinator, 2026-10-24: narrow part selection).
  if (out.format && mainPart.toLowerCase() !== CANON[out.format]) {
    flags.add("ambiguous_package");
    out.format = null;
  }
  if (!out.format) {
    flags.add("ambiguous_package");
    flags.add("not_ooxml");
    return finish();
  }
  // Text, section by section, up to TEXT_MAX characters in all. Spreadsheet rows keep their leading tabs
  // (empty first columns are positions, not white space).
  const add = (heading: string, text: string, keepLeading = false) => {
    // Spreadsheet text keeps every row separator and leading position (Codex round 6); other text is tidied.
    const t = keepLeading ? text.trimEnd() : text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!t.replace(/\s+/g, "")) return;
    const room = TEXT_MAX - out.textChars;
    if (room <= 0) {
      flags.add("text_cut");
      return;
    }
    const kept = t.length > room ? t.slice(0, room) : t;
    if (kept.length < t.length) flags.add("text_cut");
    out.textChars += kept.length;
    shield.scan(kept, heading);
    out.sections.push({ heading, text: kept });
  };
  // Text that grows past twice the cap stops growing (and is flagged); the part is still read to its end
  // for its security checks (DDE, links), which never stop with the text (Codex round 3).
  const tooLong = (n: number) => {
    if (n <= TEXT_MAX * 2) return false;
    flags.add("text_cut");
    return true;
  };
  const hidden = (where: string, text: string) => {
    const t = text.trim();
    if (!t) return;
    flags.add("hidden_text");
    shield.hidden(where, t.slice(0, 2000));
  };
  const unknownPlace = (where: string, text: string) => {
    const t = text.trim();
    if (!t) return;
    flags.add("unsupported_content");
    shield.hidden(where, t.slice(0, 2000));
  };
  // A Word field's whole instruction (assembled across runs between its begin and separate/end marks).
  const field = (s: string, cut: boolean) => {
    if (cut) flags.add("checks_incomplete");
    if (/\bDDE(AUTO)?\b/i.test(s)) flags.add("dde");
    // Fields that reach outside in ways Tiresias does not resolve (a referenced document, a database
    // connection) leave the check incomplete (Codex round 10).
    if (/^\s*(RD|DATABASE)\b/i.test(s)) {
      flags.add("checks_incomplete");
      flags.add("computed_links");
    }
    const f = fieldTarget(s);
    if (f?.target) link(`${f.field} field`, f.target);
    else if (f && !f.local) flags.add("computed_links"); // reaches outside, destination not found

  };
  // A spreadsheet formula's checks: DDE-shaped references and HYPERLINK calls (cells and defined names).
  const formulaChecks = (formula: string, cut: boolean) => {
    if (cut) flags.add("checks_incomplete");
    if (/\|\s*'?[^!]*'?\s*!/.test(formula) || /\bDDE(AUTO)?\b/i.test(formula)) flags.add("dde");
    // Functions that fetch from an address (Codex round 13): HYPERLINK, WEBSERVICE and IMAGE, by their first
    // argument; RTD (a real-time data server) cannot be resolved and leaves the check incomplete.
    for (const fn of ["HYPERLINK", "WEBSERVICE", "IMAGE"]) {
      const h = hyperlinkCalls(formula, fn);
      for (const u of h.targets) link(`${fn} formula`, u);
      if (h.computed) flags.add("computed_links");
      if (h.more) flags.add("checks_incomplete");
    }
    if (/\bRTD\s*\(/i.test(formula)) {
      flags.add("checks_incomplete");
      flags.add("computed_links");
    }
  };
  // The text elements of the accepted subset, each only under its own parents (Codex round 11): one found
  // anywhere else is outside the subset, and the whole part is refused (office_unreadable).
  const placed = (toks: Iterable<PT> | null, rules: Record<string, (parent: string) => boolean>): boolean => {
    if (!toks) return false;
    const order = orderedFor();
    for (const t of toks) {
      if (!order(t)) return false;
      if (t.t !== "open") continue;
      const rule = rules[keyOf(t)];
      if (rule && !rule(t.path.slice(t.path.lastIndexOf("/") + 1))) {
        flags.add("office_unreadable");
        flags.add("unsupported_content");
        return false;
      }
    }
    return true;
  };
  // Ordered children, with * for repeats. Check whole parts before any text is used.
  const sequences: Record<string, string[]> = {
    "w:document": words("w:background w:body"),
    "w:body": ["*", "w:sectPr"],
    "s:worksheet": words("s:sheetPr s:dimension s:sheetViews s:sheetFormatPr s:cols* s:sheetData s:sheetCalcPr s:sheetProtection s:protectedRanges s:scenarios s:autoFilter s:sortState s:dataConsolidate s:customSheetViews s:mergeCells s:phoneticPr s:conditionalFormatting* s:dataValidations s:hyperlinks s:printOptions s:pageMargins s:pageSetup s:headerFooter s:rowBreaks s:colBreaks s:customProperties s:cellWatches s:ignoredErrors s:smartTags s:drawing s:legacyDrawing s:legacyDrawingHF s:picture s:oleObjects s:controls s:webPublishItems s:tableParts s:extLst"),
    "s:row": words("s:c* s:extLst"),
    "s:c": words("s:f s:v s:is s:extLst"),
    "s:sst": words("s:si* s:extLst"),
    "s:si": words("s:t s:r* s:rPh* s:phoneticPr"),
    "s:is": words("s:t s:r* s:rPh* s:phoneticPr"),
    "s:r": words("s:rPr s:t"),
  };
  const orderedFor = () => {
    const stack: { key: string; last: number }[] = [];
    let bodies = 0, sheetData = 0;
    const bad = () => {
      flags.add("office_unreadable");
      flags.add("unsupported_content");
      return false;
    };
    return (t: PT): boolean => {
      if (t.t === "text") return true;
      if (t.t === "close") {
        stack.pop();
        return true;
      }
      const key = keyOf(t), parent = stack[stack.length - 1];
      if (key === "w:body" && (t.path !== "w:document" || ++bodies > 1)) return bad();
      if (key === "s:sheetData" && ++sheetData > 1) return bad();
      const seq = parent && sequences[parent.key];
      if (seq) {
        let at = seq.findIndex((s) => s === key || s === key + "*");
        if (at < 0) at = seq.indexOf("*");
        if (at >= 0) {
          if (at < parent.last || (at === parent.last && !seq[at].endsWith("*"))) return bad();
          parent.last = at;
        }
      }
      stack.push({ key, last: -1 });
      return true;
    };
  };
  // The accepted cell grammar (Codex round 12): a cell holds at most one value, one formula and one inline
  // string; an inline-string cell (t="inlineStr") holds its inline string and no value, and no other cell
  // holds an inline string. Anything else refuses the whole sheet.
  // The children rules (CHILDREN, LEAVES) and the string rule (StrState), for one token at a time. A
  // closure per part: call grammarFor() to get a fresh checker.
  const grammarFor = () => {
    const order = orderedFor();
    const strs: StrState[] = [];
    return (t: PT): boolean => {
      if (!order(t)) return false;
      if (t.t === "text") return true;
      const parent = t.path.slice(t.path.lastIndexOf("/") + 1);
      const key = keyOf(t);
      if (t.t === "open") {
        if (LEAVES.has(parent)) return false; // nothing inside a leaf
        if (Object.hasOwn(CHILDREN, parent) && !CHILDREN[parent].has(key)) return false;
        if (key === "s:is" || key === "s:si") strs.push({ t: 0, r: 0, rT: [] });
        const top = strs[strs.length - 1];
        if (top) {
          if (key === "s:t" && (parent === "s:is" || parent === "s:si")) top.t++;
          else if (key === "s:r" && (parent === "s:is" || parent === "s:si")) {
            top.r++;
            top.rT.push(0);
          } else if (key === "s:t" && parent === "s:r") top.rT[top.rT.length - 1]++;
        }
        return true;
      }
      if (key === "s:is" || key === "s:si") {
        const s = strs.pop();
        if (!s) return false;
        if (s.t > 1 || (s.t === 1 && s.r > 0) || (s.t === 0 && s.r === 0 && key === "s:is")) return false;
        if (s.rT.some((n) => n !== 1)) return false;
      }
      return true;
    };
  };
  let grammar = grammarFor();
  const sstValid = (toks: Iterable<PT> | null): boolean => {
    if (!toks) return false;
    const g = grammarFor();
    for (const t of toks)
      if (!g(t)) {
        flags.add("office_unreadable");
        flags.add("unsupported_content");
        return false;
      }
    return true;
  };
  const cellsValid = (toks: Iterable<PT> | null): boolean => {
    grammar = grammarFor();
    if (!toks) return false;
    let c: { type: string; v: number; f: number; is: number } | null = null;
    const bad = () => {
      flags.add("office_unreadable");
      flags.add("unsupported_content");
      return false;
    };
    for (const t of toks) {
      // Every element Tiresias reads must be at its place in the worksheet grammar, or the sheet is refused.
      if (t.t === "open" && NS.s.includes(t.ns) && Object.hasOwn(SHEET_WHERE, t.local) && !SHEET_WHERE[t.local].includes(t.path)) return bad();
      if (!grammar(t)) return bad();
      if (t.t === "open" && is(t, NS.s, "c")) c = { type: attrOf(t, "", "t") ?? "", v: 0, f: 0, is: 0 };
      else if (t.t === "open" && c && t.path.endsWith("s:row/s:c")) {
        if (is(t, NS.s, "v")) c.v++;
        else if (is(t, NS.s, "f")) c.f++;
        else if (is(t, NS.s, "is")) c.is++;
      } else if (t.t === "close" && is(t, NS.s, "c") && c) {
        if (c.v > 1 || c.f > 1 || c.is > 1) return bad();
        if (c.type === "inlineStr" ? c.v > 0 || c.f > 0 || c.is !== 1 : c.is > 0) return bad(); // an inline string has nothing else
        c = null;
      }
    }
    return true;
  };
  const limitParts = <T>(list: T[]): T[] => {
    if (list.length > MAX_PARTS) flags.add("parts_omitted");
    return list.slice(0, MAX_PARTS);
  };
  if (out.format === "docx") docx(mainPart);
  else if (out.format === "pptx") pptx(mainPart);
  else xlsx(mainPart);
  return finish();

  // ---- Word ----
  function docx(mainPart: string) {
    // Only the main document is read (coordinator, 2026-10-24): no styles, settings, headers, footers, notes
    // or comments. Hidden text is best effort and advisory: only a run's own vanish property is honoured.
    const isChange = (t: XmlToken) => t.t !== "text" && NS.w.includes(t.ns) && t.local.endsWith("Change");
    // Revision history (w:rPrChange and the like) holds OLD properties and is never read as current.
    const parse = (label: string, root: string, xml: string | null) => {
      if (!placed(tokens(xml, [NS.w, root]), DOCX_PARENTS)) return; // refused before anything is used (Codex round 11)
      const toks = tokens(xml, [NS.w, root]);
      if (!toks) return;
      let text = "", hid = "", odd = "";
      let inT = false, inInstr = false, inRPr = false, inPPr = false, inChange = 0, textOff = false;
      let direct: boolean | undefined, decided: boolean | null = null;
      const fields: { instr: string; done: boolean; cut: boolean; nested?: boolean }[] = [];
      const pathOk: boolean[] = []; // per open element: it and all its ancestors are allowed containers
      // Only the content (w:body in the main document) counts; text along a path Tiresias does not know is not
      // shown (Codex round 3).
      let inBody = root !== "document";
      const put = (s: string) => {
        if (!inBody || textOff) return;
        if (pathOk.length && !pathOk[pathOk.length - 1]) {
          odd += s;
          return;
        }
        if (decided === null) decided = direct ?? false; // best effort: a run's own vanish only
        if (decided) hid += s;
        else text += s;
        if (tooLong(text.length + hid.length + odd.length)) textOff = true;
      };
      // A field whose instruction holds another field is computed at display time: its checks are marked
      // incomplete and its destination unresolved (Codex round 7).
      const check = (f: { instr: string; done: boolean; cut: boolean; nested?: boolean } | undefined) => {
        if (f && !f.done) {
          f.done = true;
          field(f.instr, f.cut);
          if (f.nested) {
            flags.add("checks_incomplete");
            flags.add("computed_links");
          }
        }
      };
      for (const t of toks) {
        if (t.t === "open") pathOk.push((pathOk.length ? pathOk[pathOk.length - 1] : true) && allowed(t, DOCX_PATH));
        else if (t.t === "close") pathOk.pop();
        if (t.t === "text") {
          if (inT) put(t.text);
          else if (inInstr && inBody) {
            const f = fields[fields.length - 1];
            if (f) {
              if (f.instr.length + t.text.length > MAX_INSTR) f.cut = true;
              f.instr = (f.instr + t.text).slice(0, MAX_INSTR);
            } else field(t.text.slice(0, MAX_INSTR), t.text.length > MAX_INSTR); // an instruction outside any field mark is still checked
          }
          continue;
        }
        if (isChange(t)) {
          inChange += t.t === "open" ? 1 : -1;
          continue;
        }
        if (NS.m.includes(t.ns) && t.local === "t") {
          inT = t.t === "open"; // Word's equation text is visible text (Codex round 3)
          continue;
        }
        if (!NS.w.includes(t.ns)) continue;
        const name = t.local;
        if (t.t === "open" && (name === "fldChar" || name === "fldSimple")) flags.add("cached_results"); // a field's saved result (Codex round 11)
        if (t.t === "open") {
          if (name === "body") inBody = true;
          else if (inChange) continue; // old properties inside revision history
          else if (name === "r") {
            direct = undefined;
            decided = null;
          } else if (name === "pPr") inPPr = true;
          else if (name === "rPr") inRPr = true;
          else if ((name === "vanish" || name === "specVanish") && inRPr && !inPPr) direct = ON(attrOf(t, NS.w, "val"));
          else if (name === "t") inT = true;
          else if (name === "instrText") inInstr = true;
          else if (name === "fldChar") {
            const type = attrOf(t, NS.w, "fldCharType");
            if (type === "begin") {
              const outer = fields[fields.length - 1];
              if (outer && !outer.done) outer.nested = true; // a field inside another field's instruction
              fields.push({ instr: "", done: false, cut: false });
            }
            else if (type === "separate") check(fields[fields.length - 1]);
            else if (type === "end") check(fields.pop());
          } else if (name === "fldSimple") {
            const ins = attrOf(t, NS.w, "instr") ?? "";
            field(ins.slice(0, MAX_INSTR), ins.length > MAX_INSTR);
          } else if (name === "tab" || name === "ptab") put("\t");
          else if (name === "br" || name === "cr") put("\n");
          else if (name === "noBreakHyphen") put("‑"); // characters written as elements (Codex round 4)
          else if (name === "sym" || /^(day|month|year)(Short|Long)$/.test(name) || name === "pgNum") flags.add("unsupported_content");
          else if (name === "altChunk") flags.add("unsupported_content");
          continue;
        }
        if (name === "t") inT = false;
        else if (name === "instrText") inInstr = false;
        else if (name === "rPr") {
          inRPr = false;
          decided = null;
        } else if (name === "pPr") inPPr = false;
        else if (name === "r") direct = undefined;
        else if (name === "p") put("\n");
        else if (name === "body" && root === "document") inBody = false;
      }
      while (fields.length) check(fields.pop()); // fields never closed are still checked
      hidden(`hidden text in the ${label.toLowerCase()} of a Word document`, hid);
      unknownPlace(`text in markup Tiresias does not read, in the ${label.toLowerCase()} of a Word document`, odd);
      add(label, text);
    };
    parse("Document", "document", read(mainPart));
    // Every other part that may hold text is named as skipped, never read.
    for (const r of relsFor(mainPart)) if (!r.external && r.kind && ["header", "footer", "footnotes", "endnotes", "comments", "glossaryDocument"].includes(r.kind)) skip(resolvePart(mainPart, r.target));
  }

  // ---- PowerPoint ----
  function pptx(mainPart: string) {
    const pt = tokens(read(mainPart), [NS.p, "presentation"]);
    if (!pt) return;
    const ids: string[] = [];
    for (const t of pt)
      if (t.t === "open" && is(t, NS.p, "sldId")) {
        if (t.path !== "p:presentation/p:sldIdLst") {
          flags.add("ambiguous_package"); // a slide listed outside the slide list: the index is ambiguous, no text (Codex round 14)
          return;
        }
        const id = attrOf(t, NS.r, "id");
        // Every listed slide needs its own relationship id, once (Codex round 7): otherwise the index is
        // ambiguous and the presentation gives no text.
        if (!id || ids.includes(id)) {
          flags.add("ambiguous_package");
          return;
        }
        ids.push(id);
      }
    const byId = new Map(relsFor(mainPart).filter((r) => !r.external).map((r) => [r.id, r]));
    const SHAPES = ["sp", "grpSp", "graphicFrame", "cxnSp", "pic"];
    // Masters (whose shapes can show on every slide) are named as skipped, never read (Codex round 5).
    for (const x of relsFor(mainPart)) if (!x.external && x.kind && ["slideMaster", "notesMaster", "handoutMaster"].includes(x.kind)) skip(resolvePart(mainPart, x.target));
    let n = 0;
    for (const id of limitParts(ids)) {
      const r = byId.get(id);
      if (!r || r.kind !== "slide") {
        flags.add("part_missing");
        continue;
      }
      n++;
      const slidePart = resolvePart(mainPart, r.target);
      if (out.textChars >= TEXT_MAX) {
        flags.add("text_cut");
        break;
      }
      if (!typed(slidePart, "presentationml.slide+xml")) continue;
      const slideXml = read(slidePart);
      if (!placed(tokens(slideXml, [NS.p, "sld"]), PPTX_PARENTS)) continue; // refused before anything is used (Codex round 11)
      const toks = tokens(slideXml, [NS.p, "sld"]);
      if (!toks) continue;
      let text = "", hid = "", odd = "";
      let inT = false, slideHidden = false, first = true, textOff = false;
      const shapes: boolean[] = []; // per open shape or group: hidden?
      const path: boolean[] = [];
      const put = (s: string) => {
        if (textOff) return;
        if (path.length && !path[path.length - 1]) odd += s;
        else if (shapes.includes(true)) hid += s;
        else text += s;
        if (tooLong(text.length + hid.length + odd.length)) textOff = true;
      };
      for (const t of toks) {
        if (t.t === "open") {
          path.push((path.length ? path[path.length - 1] : true) && allowed(t, PPTX_PATH));
          if (first) {
            first = false;
            slideHidden = !ON(attrOf(t, "", "show"));
          }
          if (NS.p.includes(t.ns) && SHAPES.includes(t.local)) shapes.push(false);
          else if (is(t, NS.p, "cNvPr") && shapes.length && ON(attrOf(t, "", "hidden") ?? "0")) shapes[shapes.length - 1] = true;
          else if (is(t, NS.a, "t")) inT = true;
          else if (is(t, NS.a, "br")) put("\n");
          if (is(t, NS.a, "fld")) flags.add("cached_results"); // a slide field's saved text (date, slide number; Codex round 12)
        } else if (t.t === "close") {
          path.pop();
          if (NS.p.includes(t.ns) && SHAPES.includes(t.local)) shapes.pop();
          else if (is(t, NS.a, "t")) inT = false;
          else if (is(t, NS.a, "p")) put("\n");
        } else if (inT) put(t.text);
      }
      if (slideHidden) hidden(`hidden slide ${n} of a presentation`, text + "\n" + hid);
      else {
        hidden(`hidden shapes on slide ${n} of a presentation`, hid);
        unknownPlace(`text in markup Tiresias does not read, on slide ${n} of a presentation`, odd);
        add(`Slide ${n}`, text);
      }
      // A slide's layout, notes and comments may hold text; they are named as skipped, never read.
      if (slidePart !== null) for (const x of relsFor(slidePart)) if (!x.external && x.kind && ["slideLayout", "notesSlide", "comments"].includes(x.kind)) skip(resolvePart(slidePart, x.target));
    }
  }

  // ---- Excel ----
  function xlsx(mainPart: string) {
    const wt = tokens(read(mainPart), [NS.s, "workbook"]);
    if (!wt) return;
    const wbRels = relsFor(mainPart).filter((r) => !r.external);
    const sheets: { name: string; id: string; sheetId: string; hidden: boolean }[] = [];
    // Defined names hold formulas cells can use: each gets the same DDE and link checks (Codex round 8).
    let dn: string | null = null;
    for (const t of wt) {
      if (t.t === "open" && is(t, NS.s, "definedName") && t.path === "s:workbook/s:definedNames") dn = "";
      else if (t.t === "close" && is(t, NS.s, "definedName") && dn !== null) {
        formulaChecks(dn.slice(0, MAX_INSTR), dn.length > MAX_INSTR);
        dn = null;
      } else if (t.t === "text" && dn !== null && dn.length <= MAX_INSTR + 1) dn += t.text;
      if (t.t === "open" && is(t, NS.s, "sheet")) {
        if (t.path !== "s:workbook/s:sheets") {
          flags.add("ambiguous_package"); // a sheet listed outside the sheet list: the index is ambiguous, no text (Codex round 14)
          return;
        }
        const id = attrOf(t, NS.r, "id");
        const name = attrOf(t, "", "name") ?? "";
        const sheetId = attrOf(t, "", "sheetId") ?? "";
        // Every sheet needs its own relationship id, sheet id and name, each once (Codex round 7): otherwise
        // the index is ambiguous and the workbook gives no text.
        if (!id || !sheetId || sheets.some((x) => x.id === id || x.sheetId === sheetId || x.name.toLowerCase() === name.toLowerCase())) {
          flags.add("ambiguous_package");
          return;
        }
        sheets.push({ name: name.slice(0, 100), id, sheetId, hidden: /hidden/i.test(attrOf(t, "", "state") ?? "") });
      }
    }
    // Shared strings: the text of each <si>, phonetic runs (<rPh>) left out, OOXML escapes decoded.
    const strings: string[] = [];
    let stringsCut = false;
    // A workbook has ONE shared-string table; more than one relationship to one is ambiguous: no text (Codex round 6).
    const ssRels = wbRels.filter((r) => r.kind === "sharedStrings");
    if (ssRels.length > 1) {
      flags.add("ambiguous_package");
      return;
    }
    const ssRel = ssRels[0];
    const ssPart = ssRel ? resolvePart(mainPart, ssRel.target) : null;
    const ssXml = ssRel && typed(ssPart, "spreadsheetml.sharedstrings+xml") ? read(ssPart) : null;
    // The whole table is checked against the string grammar first; a table outside it gives no strings.
    const ss = ssXml !== null && sstValid(tokens(ssXml, [NS.s, "sst"])) ? tokens(ssXml, [NS.s, "sst"]) : null;
    if (ss) {
      let cur = "", piece = "", inT = false, inPh = false, inSi = false, total = 0;
      for (const t of ss) {
        if (t.t === "open") {
          if (is(t, NS.s, "si")) {
            if (t.path !== "s:sst") {
              flags.add("unsupported_content"); // a string item outside the table is not a string (Codex round 4)
              continue;
            }
            inSi = true;
            cur = "";
          } else if (is(t, NS.s, "rPh")) inPh = true;
          else if (is(t, NS.s, "t")) inT = t.path === "s:sst/s:si" || t.path === "s:sst/s:si/s:r";
        } else if (t.t === "close") {
          if (is(t, NS.s, "si") && inSi) {
            inSi = false;
            const v = cur; // each text element was decoded on its own (Codex round 12)
            strings.push(v);
            total += v.length;
            if (total > TEXT_MAX * 4 || strings.length >= MAX_STRINGS) {
              stringsCut = true; // more strings than could ever be shown
              break;
            }
          } else if (is(t, NS.s, "rPh")) inPh = false;
          else if (is(t, NS.s, "t")) {
            if (inT && !inPh && inSi) cur += unescapeOoxml(piece); // escapes belong to one text element
            piece = "";
            inT = false;
          }
        } else if (inT && !inPh && inSi) {
          piece += t.text;
          if (cur.length + piece.length > TEXT_MAX * 4) {
            stringsCut = true;
            break;
          }
        }
      }
    }
    // A reference to a string that is not there: past a table Tiresias cut is text_cut; anything else (no
    // table, an index past its end, not a number) is unresolved_cells (Codex round 4), never a quiet blank.
    const shared = (i: number): string => {
      if (i >= 0 && i < strings.length) return strings[i];
      flags.add(stringsCut && i >= strings.length ? "text_cut" : "unresolved_cells");
      return "";
    };
    // Linked workbooks (where DDE links live) are not read: named as skipped, and the DDE check is incomplete.
    // Data connections (web queries, outside data sources, refreshed on opening) are not read either.
    for (const r of wbRels.filter((x) => x.kind === "connections")) {
      skip(resolvePart(mainPart, r.target));
      flags.add("checks_incomplete");
    }
    for (const r of wbRels.filter((x) => x.kind === "externalLink")) {
      skip(resolvePart(mainPart, r.target));
      flags.add("checks_incomplete");
    }
    const byId = new Map(wbRels.map((r) => [r.id, r]));
    let n = 0;
    // Every sheet is read for its formula checks, even once the text is full.
    for (const sh of limitParts(sheets)) {
      const r = byId.get(sh.id);
      if (!r || r.kind !== "worksheet") {
        flags.add("part_missing");
        continue;
      }
      n++;
      // A hidden sheet is not read (coordinator, 2026-10-24: only the sheets the workbook lists as visible).
      if (sh.hidden) {
        skip(resolvePart(mainPart, r.target));
        flags.add("hidden_text");
        continue;
      }
      const sheetPart = resolvePart(mainPart, r.target);
      if (!typed(sheetPart, "spreadsheetml.worksheet+xml")) continue;
      // Drawings (text boxes), comments and VML drawings on the sheet may hold text: named as skipped.
      if (sheetPart !== null) for (const x of relsFor(sheetPart)) if (!x.external && x.kind && ["drawing", "comments", "vmlDrawing"].includes(x.kind)) skip(resolvePart(sheetPart, x.target));
      const sheetXml = read(sheetPart);
      if (!cellsValid(tokens(sheetXml, [NS.s, "worksheet"]))) continue; // refused before anything is used (Codex round 12)
      const toks = tokens(sheetXml, [NS.s, "worksheet"]);
      if (!toks) continue;
      let text = "", hid = "", row = "", hrow = "", cell = "", piece = "", ctype = "", formula = "", ref: string | undefined;
      let inV = false, inIsT = false, inIs = false, inPh = false, inF = false, inData = false, rowHidden = false, col = 0, rowNo = 0;
      let hasF = false, hasV = false, textOff = false, fCut = false, inRow = false, inCell = false;
      const hiddenCols: [number, number][] = [];
      const colHidden = (c: number) => hiddenCols.some(([a, z2]) => c >= a && c <= z2);
      // Each recognized element counts only at its place in the worksheet grammar (Codex round 5); one found
      // anywhere else is ignored and flagged.
      const ROW = W_ROW, CELL = W_CELL; // (placement was checked over the whole sheet by cellsValid)
      for (const t of toks) {
        if (t.t === "open") {
          if (is(t, NS.s, "sheetData")) inData = true;
          else if (is(t, NS.s, "col") && ON(attrOf(t, "", "hidden") ?? "0")) {
            if (hiddenCols.length < MAX_HIDDEN_COLS) hiddenCols.push([Number(attrOf(t, "", "min") ?? 0) - 1, Number(attrOf(t, "", "max") ?? 0) - 1]);
            else flags.add("visibility_uncertain"); // more hidden ranges than kept: some hidden cells may show
          } else if (!inData) continue;
          else if (is(t, NS.s, "row")) {
            inRow = true;
            rowHidden = ON(attrOf(t, "", "hidden") ?? "0");
            col = 0;
            // The row's own number keeps skipped rows as blank lines (at most MAX_GAP of them).
            const rn = Number(attrOf(t, "", "r") ?? NaN);
            if (Number.isSafeInteger(rn) && rn <= rowNo) flags.add("positions_inconsistent"); // a row out of order or repeated (Codex round 9)
            const next = Number.isSafeInteger(rn) && rn > rowNo ? rn : rowNo + 1;
            const gap = next - rowNo - 1;
            if (gap > MAX_GAP) flags.add("positions_compressed");
            if (gap > 0 && !textOff) {
              text += "\n".repeat(Math.min(gap, MAX_GAP));
              if (tooLong(text.length + hid.length)) textOff = true; // every append counts (Codex round 10)
            }
            rowNo = next;
          } else if (is(t, NS.s, "c")) {
            inCell = true;
            ctype = attrOf(t, "", "t") ?? "";
            ref = attrOf(t, "", "r");
            cell = "";
            hasF = false;
            hasV = false;
          } else if (is(t, NS.s, "v")) {
            inV = true;
            hasV = true;
          } else if (is(t, NS.s, "is")) inIs = true;
          else if (is(t, NS.s, "rPh") && inIs) inPh = true;
          else if (is(t, NS.s, "t") && inIs) {
            inIsT = true;
            piece = "";
          }
          else if (is(t, NS.s, "f")) {
            inF = true;
            hasF = true;
            formula = "";
            fCut = false;
          }
        } else if (t.t === "close") {
          if (is(t, NS.s, "sheetData")) inData = false;
          else if (!inData) continue;
          else if (is(t, NS.s, "v")) inV = false;
          else if (is(t, NS.s, "t")) {
            // An inline string's escapes are decoded per text element (Codex round 12).
            if (inIsT && !inPh && !textOff) cell += unescapeOoxml(piece);
            piece = "";
            inIsT = false;
          }
          else if (is(t, NS.s, "rPh")) inPh = false;
          else if (is(t, NS.s, "is")) inIs = false;
          else if (is(t, NS.s, "f")) {
            inF = false;
            formulaChecks(formula, fCut);
          } else if (is(t, NS.s, "c") && inCell && t.path === CELL) {
            inCell = false;
            if (hasF) flags.add("cached_results"); // a formula's saved result, never evaluated (Codex round 3)
            let v = cell;
            if (ctype === "s") v = shared(/^\d+$/.test(cell.trim()) ? Number(cell.trim()) : -1);
            else if (ctype === "b") v = cell.trim() === "1" ? "TRUE" : cell.trim() === "0" ? "FALSE" : cell;
            else if (ctype === "str") v = unescapeOoxml(cell); // (an inline string was decoded per text element)
            else if (ctype === "d") flags.add("raw_numbers"); // a stored date, shown without its display format (Codex round 7)
            else if ((ctype === "" || ctype === "n") && hasV && cell.trim() !== "") flags.add("raw_numbers");
            // The cell's own column keeps sparse rows aligned (at most MAX_GAP empty columns are kept).
            const c = colOf(ref);
            // A cell out of order, repeated, or naming another row is placed in the next column, and flagged.
            const refRow = ref ? Number(/[0-9]+$/.exec(ref)?.[0] ?? NaN) : NaN;
            if ((c !== -1 && c < col) || (ref && Number.isSafeInteger(refRow) && refRow !== rowNo)) flags.add("positions_inconsistent");
            const at = c >= col ? c : col;
            if (at - col > MAX_GAP) flags.add("positions_compressed");
            const gap = Math.min(at - col, MAX_GAP);
            col = at + 1;
            // Tabs and line breaks are the row and column separators, so a cell's own ones (and backslashes)
            // are written as \t, \n, \r and \\ (Codex round 8): one cell never looks like two.
            v = v.replace(/[\\\t\n\r]/g, (c) => (c === "\\" ? "\\\\" : c === "\t" ? "\\t" : c === "\n" ? "\\n" : "\\r"));
            if (!textOff) {
              if (rowHidden || colHidden(at)) hrow += v + "\t";
              else row += "\t".repeat(gap) + v + "\t";
              if (tooLong(text.length + row.length + hid.length + hrow.length)) textOff = true;
            }
          } else if (is(t, NS.s, "row") && inRow && t.path === ROW) {
            inRow = false;
            if (!textOff) {
              if (rowHidden) hid += row + hrow + "\n";
              else {
                text += row.replace(/\t+$/, "") + "\n";
                if (tooLong(text.length + hid.length)) textOff = true;
                if (hrow) hid += hrow + "\n";
              }
            }
            row = "";
            hrow = "";
          }
        } else if (!inData) continue;
        else if (inV || (inIsT && !inPh)) {
          if (!textOff) {
            if (inIsT) piece += t.text;
            else cell += t.text;
            if (tooLong(cell.length + piece.length)) textOff = true;
          }
        } else if (inF) {
          if (formula.length + t.text.length > MAX_INSTR) fCut = true;
          formula = (formula + t.text).slice(0, MAX_INSTR);
        }
      }
      if (!textOff) text += row.replace(/\t+$/, "");
      const label = `Sheet ${n}${sh.name ? `: ${sh.name}` : ""}`;
      hidden(`hidden rows or columns on sheet ${n} of a workbook`, hid);
      add(label, text, true);
    }
  }
}
