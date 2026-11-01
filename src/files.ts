// SPDX-License-Identifier: Apache-2.0
// W-20: the dangerous file plan (SPEC section 4.4). Every response is named by its first bytes (its
// signature), never by its name or the type the site declares. A response that is a page Tiresias
// reads (HTML, text, JSON, PDF and the text kinds below) is read; anything else is a FILE: it is
// fingerprinted (SHA-256, by safety.ts as it streams) and flagged to the human, never run, opened,
// unpacked or saved.
//
// Everything here is a pure function over a bounded head of the body and a few header values, with
// fixed tables. No parser for any file format is involved: a signature is a few bytes at a fixed place.

// The media type alone (parameters dropped, lower case): "text/html; name=a.pdf" is "text/html".
export const mimeOf = (ct: string | null | undefined): string => (ct ?? "").split(";")[0].trim().toLowerCase();

export type FileKind = "program" | "script" | "shortcut" | "addon" | "archive" | "office" | "image" | "media" | "unknown";
export type Risk = "high" | "low";
// How a page is read. "script", "csv", "calendar" and "contact" are read as plain text (never as markdown).
export type ReadAs = "html" | "json" | "text" | "pdf" | "svg" | "script" | "csv" | "calendar" | "contact";
export type FileFlag = "type_mismatch" | "double_extension" | "macros"; // macros: v0.6, Office files (inside.ts)
export type Verdict = { read: ReadAs; flags: FileFlag[] } | { file: FileKind; flags: FileFlag[] };

// The most bytes looked at before deciding. ISO 9660's mark sits at 32,769 (and 34,817, 36,865).
export const HEAD_BYTES = 40 * 1024;

export const RISK: Record<FileKind, Risk> = {
  program: "high", script: "high", shortcut: "high", addon: "high", archive: "high",
  // v0.5 never looks inside an Office file, so macros cannot be ruled out: every Office kind is high.
  office: "high", unknown: "high",
  image: "low", media: "low",
};

// Fixed text per kind: why the human might care.
export const REASON: Record<FileKind, string> = {
  program: "A program or installer. It runs code on the machine if it is opened.",
  script: "A script. It runs code if it is opened, and is often disguised as text.",
  shortcut: "A shortcut or system file. It points at, or changes, something on the machine.",
  addon: "A browser or app add-on. It installs code that runs every time the browser or app does.",
  archive: "An archive or disk image. It can hide programs inside, expand to fill the disk, or write outside its folder when unpacked. Tiresias does not unpack it.",
  office: "An Office document Tiresias does not read. It can hold macros (code that runs when it is opened) or links to outside templates.",
  image: "An image. Tiresias does not decode images, so nothing was shown from it.",
  media: "Audio or video. Tiresias does not decode media, so nothing was shown from it.",
  unknown: "A file of a kind Tiresias does not recognise. Unknown files are treated like programs.",
};

// Fixed text for each W-20 flag, shown in flag_details. (The flag codes themselves are in types.ts.)
export const FLAG_TEXT = {
  type_mismatch: "What the site declared (its Content-Type, or the file name) does not match what the content is.",
  double_extension: "The file name hides a risky extension behind another one (like invoice.pdf.exe).",
  script: "This is a script. It is shown as text only and was never run. Do not run it.",
  svg: "An SVG image, read as text only and never drawn: its scripts and styles were dropped.",
  calendar: "A calendar file, read as text. Its links are listed and were not followed. Its events are in untrusted_content.events (v0.6); any link in them is checked by Safe Browsing before a visit, like any page link, and nothing in the invite was acted on.",
  contact: "A contact card, read as text. Its links are listed and were not followed.",
  csv_formulas: "Some cells start like a spreadsheet formula (=, +, -, @, a tab or a carriage return); counts.csv_formulas says how many. A formula runs if the file is opened in a spreadsheet. The text was not changed.",
  pdf_javascript: "The PDF holds JavaScript. Tiresias read its text only; the JavaScript was never run.",
  pdf_attachments: "The PDF has files attached. They were not opened or extracted.",
  pdf_launch: "The PDF has a Launch action (one that opens a program or file). It was never followed.",
  macros: "The Office file holds macros (code that runs when it is opened), or is a macro type by its name. They were never run.",
} as const;

// What a declared type or a file name says the content is, by family. Two claims of the same family
// agree (a .js page served as text/html is text either way).
type Family = "text" | "pdf" | "image" | "media" | "archive" | "program" | "ole" | "shortcut";

type Sig = { family: Family; kind: FileKind | "pdf" | "script"; zip?: true };

const at = (b: Buffer, off: number, bytes: number[] | string): boolean => {
  const want = typeof bytes === "string" ? Buffer.from(bytes, "latin1") : Buffer.from(bytes);
  return b.length >= off + want.length && b.subarray(off, off + want.length).equals(want);
};

// The fixed signature table. Order matters only where one mark is a prefix of another. `tail` is the last
// 512 bytes, when known: a dmg's only mark is its trailer, and it is one more signature on the same path.
export function signature(b: Buffer, tail?: Buffer): Sig | null {
  // Programs
  if (at(b, 0, "MZ")) return { family: "program", kind: "program" }; // Windows (PE) and DOS programs
  if (at(b, 0, [0x7f, 0x45, 0x4c, 0x46])) return { family: "program", kind: "program" }; // ELF (Linux)
  for (const m of [[0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe]])
    if (at(b, 0, m)) return { family: "program", kind: "program" }; // Mach-O, fat Mach-O (and Java class files)
  if (at(b, 0, [0x00, 0x61, 0x73, 0x6d])) return { family: "program", kind: "program" }; // WebAssembly
  if (at(b, 0, "dex\n")) return { family: "program", kind: "program" }; // Android Dalvik
  // dmg: "koly" at the start of the last 512 bytes. Before "#!" (round 68): a text first line must not
  // hide a disk-image trailer, so a "#!" body with a koly trailer is a file, not script text.
  if (tail && isDmgTrailer(tail)) return { family: "archive", kind: "archive" };
  if (at(b, 0, "#!")) return { family: "text", kind: "script" }; // a script's interpreter line
  // Shortcuts and add-ons
  if (at(b, 0, [0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00])) return { family: "shortcut", kind: "shortcut" }; // Windows .lnk
  if (at(b, 0, "Cr24")) return { family: "archive", kind: "addon" }; // Chrome extension
  // Archives and disk images
  if (at(b, 0, "PK\x03\x04") || at(b, 0, "PK\x05\x06") || at(b, 0, "PK\x07\x08")) return { family: "archive", kind: "archive", zip: true }; // zip and its family
  if (at(b, 0, "Rar!\x1a\x07")) return { family: "archive", kind: "archive" };
  if (at(b, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { family: "archive", kind: "archive" }; // 7z
  if (at(b, 0, [0x1f, 0x8b])) return { family: "archive", kind: "archive" }; // gzip
  if (at(b, 0, "BZh") && b.length > 3 && b[3] >= 0x31 && b[3] <= 0x39) return { family: "archive", kind: "archive" }; // bzip2
  if (at(b, 0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return { family: "archive", kind: "archive" }; // xz
  if (at(b, 0, [0x28, 0xb5, 0x2f, 0xfd])) return { family: "archive", kind: "archive" }; // zstd
  if (at(b, 0, "MSCF")) return { family: "archive", kind: "archive" }; // cab
  if (at(b, 0, "xar!")) return { family: "archive", kind: "archive" }; // xar (macOS .pkg)
  if (at(b, 0, "!<arch>\n")) return { family: "archive", kind: "archive" }; // ar (.deb)
  if (at(b, 0, [0xed, 0xab, 0xee, 0xdb])) return { family: "archive", kind: "archive" }; // rpm
  if (at(b, 0, "vhdxfile") || at(b, 0, "conectix")) return { family: "archive", kind: "archive" }; // virtual disks
  if (at(b, 257, "ustar")) return { family: "archive", kind: "archive" }; // tar
  for (const off of [0x8001, 0x8801, 0x9001]) if (at(b, off, "CD001")) return { family: "archive", kind: "archive" }; // ISO 9660
  // Old Office (and .msi): the OLE compound file
  if (at(b, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return { family: "ole", kind: "office" };
  // PDF (read as text by W-17)
  if (at(b, 0, "%PDF-")) return { family: "pdf", kind: "pdf" };
  // Images
  if (at(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { family: "image", kind: "image" }; // PNG
  if (at(b, 0, [0xff, 0xd8, 0xff])) return { family: "image", kind: "image" }; // JPEG
  if (at(b, 0, "GIF87a") || at(b, 0, "GIF89a")) return { family: "image", kind: "image" };
  if (at(b, 0, "RIFF") && at(b, 8, "WEBP")) return { family: "image", kind: "image" };
  if (at(b, 0, [0x49, 0x49, 0x2a, 0x00]) || at(b, 0, [0x4d, 0x4d, 0x00, 0x2a])) return { family: "image", kind: "image" }; // TIFF
  if (at(b, 0, [0x00, 0x00, 0x01, 0x00])) return { family: "image", kind: "image" }; // ICO
  if (at(b, 0, "BM") && at(b, 6, [0, 0, 0, 0])) return { family: "image", kind: "image" }; // BMP (reserved bytes zero)
  if (at(b, 4, "ftyp")) {
    const brand = b.subarray(8, 12).toString("latin1");
    return ["heic", "heix", "mif1", "msf1", "avif", "avis"].includes(brand) ? { family: "image", kind: "image" } : { family: "media", kind: "media" };
  }
  // Audio and video
  if (at(b, 0, "ID3") || at(b, 0, "OggS") || at(b, 0, "fLaC") || at(b, 0, "MThd") || at(b, 0, "FLV\x01")) return { family: "media", kind: "media" };
  if (at(b, 0, "RIFF") && (at(b, 8, "WAVE") || at(b, 8, "AVI "))) return { family: "media", kind: "media" };
  if (at(b, 0, [0x1a, 0x45, 0xdf, 0xa3])) return { family: "media", kind: "media" }; // Matroska, WebM
  if (b.length >= 2 && b[0] === 0xff && [0xfb, 0xf3, 0xf2, 0xf1, 0xf9].includes(b[1])) return { family: "media", kind: "media" }; // MP3, AAC frames
  return null;
}

// A dmg has no mark at its start; its "koly" trailer is the start of the last 512 bytes, when present.
export const isDmgTrailer = (tail: Buffer): boolean => tail.length >= 512 && at(tail.subarray(tail.length - 512), 0, "koly");

// ---- What the site and the name claim ----

const SCRIPT_TYPES = new Set([
  "application/javascript", "application/x-javascript", "text/javascript", "application/ecmascript", "text/ecmascript", "text/jscript",
  "application/x-sh", "application/x-shellscript", "text/x-shellscript", "text/x-sh", "application/x-csh", "text/x-csh",
  "text/x-python", "application/x-python", "application/x-python-code", "text/x-perl", "application/x-perl", "text/x-ruby", "application/x-ruby",
  "application/x-powershell", "text/x-powershell", "application/x-bat", "text/x-bat", "text/vbscript", "application/x-vbscript",
  "application/hta", "text/x-applescript", "application/x-applescript",
]);
const SHORTCUT_TYPES = new Set([
  "application/x-mswinurl", "application/internet-shortcut", "application/x-url", "wwwserver/redirection",
  "application/x-desktop", "text/x-ms-regedit", "application/x-ms-regedit", "application/x-apple-aspen-config",
  "application/x-ms-shortcut", "application/x-setupscript",
]);
// Generic types say nothing about the content.
const GENERIC = new Set(["", "application/octet-stream", "binary/octet-stream", "application/x-download", "application/force-download", "application/download", "application/binary", "application/unknown"]);
const TYPE_FAMILY: Record<string, Family> = {
  "application/pdf": "pdf",
  "application/zip": "archive", "application/x-zip-compressed": "archive", "application/x-zip": "archive", "application/gzip": "archive", "application/x-gzip": "archive",
  "application/x-tar": "archive", "application/x-gtar": "archive", "application/x-7z-compressed": "archive", "application/vnd.rar": "archive", "application/x-rar-compressed": "archive", "application/x-rar": "archive",
  "application/x-bzip2": "archive", "application/x-bzip": "archive", "application/x-xz": "archive", "application/zstd": "archive", "application/vnd.ms-cab-compressed": "archive",
  "application/x-iso9660-image": "archive", "application/x-apple-diskimage": "archive", "application/x-xar": "archive", "application/vnd.debian.binary-package": "archive", "application/x-rpm": "archive",
  "application/java-archive": "archive", "application/x-java-archive": "archive", "application/vnd.android.package-archive": "archive", "application/x-xpinstall": "archive", "application/x-chrome-extension": "archive",
  "application/epub+zip": "archive", "application/vnd.ms-appx": "archive", "application/msix": "archive",
  "application/x-msdownload": "program", "application/x-dosexec": "program", "application/x-executable": "program", "application/x-mach-binary": "program", "application/x-elf": "program",
  "application/vnd.microsoft.portable-executable": "program", "application/x-msdos-program": "program", "application/wasm": "program", "application/x-sharedlib": "program",
  "application/msword": "ole", "application/vnd.ms-excel": "ole", "application/vnd.ms-powerpoint": "ole", "application/x-msi": "ole", "application/x-ole-storage": "ole", "application/vnd.ms-outlook": "ole",
  "application/x-ms-shortcut": "shortcut",
};
function typeFamily(m: string): Family | null {
  if (GENERIC.has(m)) return null;
  if (TYPE_FAMILY[m]) return TYPE_FAMILY[m];
  if (/^application\/vnd\.(openxmlformats-officedocument|ms-[a-z]+\.[a-z.]*macroenabled|oasis\.opendocument)/.test(m)) return "archive";
  if (m.startsWith("text/") || /json|xml/.test(m) || SCRIPT_TYPES.has(m) || SHORTCUT_TYPES.has(m) || m === "application/markdown") return "text";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/") || m.startsWith("video/")) return "media";
  return null; // an unknown type claims nothing
}

const words = (s: string) => s.split(" ");
const EXT: Record<string, Family> = {};
for (const e of words("exe dll scr com cpl sys drv ocx efi so dylib wasm class dex elf")) EXT[e] = "program";
for (const e of words("zip rar 7z gz tgz bz2 tbz tbz2 xz txz zst tar cab iso img vhd vhdx dmg pkg deb rpm jar apk ipa msix appx xap xpi crx vsix docx xlsx pptx docm xlsm pptm dotx dotm xltx xltm potx potm ppsx ppsm xlam ppam odt ods odp epub"))
  EXT[e] = "archive";
for (const e of words("doc xls ppt msi msg dot xlt pot pps vsd pub")) EXT[e] = "ole";
EXT.pdf = "pdf";
EXT.lnk = "shortcut";
for (const e of words("png jpg jpeg gif webp bmp ico tif tiff heic heif avif")) EXT[e] = "image";
for (const e of words("mp3 mp4 m4a m4v mov avi mkv webm ogg oga ogv opus wav flac mid midi flv aac")) EXT[e] = "media";
const SCRIPT_EXT = new Set(words("ps1 psm1 psd1 bat cmd sh bash zsh ksh csh vbs vbe js jse mjs cjs wsf wsh hta py pyw pl rb applescript"));
const SHORTCUT_EXT = new Set(words("url desktop reg inf mobileconfig library-ms website"));
for (const e of [...SCRIPT_EXT, ...SHORTCUT_EXT, ...words("html htm xhtml txt text md markdown json xml csv tsv svg ics ifb vcf vcard css")]) EXT[e] = "text";
// A name ending in one of these is risky when it hides behind another known extension (invoice.pdf.exe).
const RISKY_LAST = new Set([...words("exe dll scr com cpl msi lnk jar apk app crx xpi vsix"), ...SCRIPT_EXT, ...SHORTCUT_EXT]);
const OFFICE_EXT = new Set(words("docx xlsx pptx docm xlsm pptm dotx dotm xltx xltm potx potm ppsx ppsm xlam ppam odt ods odp doc xls ppt dot xlt pot pps"));
const ADDON_EXT = new Set(words("xpi crx vsix"));
const ZIP_PROGRAM_EXT = new Set(words("apk ipa jar msix appx xap"));

// v0.6: the kind a name INSIDE an archive claims, by its last extension (null when it claims nothing risky
// or known). Programs include the zip-shaped ones (.jar, .apk) and .msi; scripts and shortcuts as above.
export const MACRO_OFFICE_EXT = new Set(words("docm xlsm pptm dotm xltm potm ppsm xlam ppam"));
export function innerKind(name: string): FileKind | null {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const e = lastExt(base);
  if (!e) return null;
  if (ZIP_PROGRAM_EXT.has(e) || e === "msi" || e === "app" || EXT[e] === "program") return "program";
  if (SCRIPT_EXT.has(e) || e === "jse" || e === "vbe") return "script";
  if (SHORTCUT_EXT.has(e) || e === "lnk") return "shortcut";
  if (ADDON_EXT.has(e)) return "addon";
  if (OFFICE_EXT.has(e) || EXT[e] === "ole") return "office";
  if (EXT[e] === "archive") return "archive";
  if (EXT[e] === "image") return "image";
  if (EXT[e] === "media") return "media";
  return null;
}

const extsOf = (name: string): string[] => {
  const parts = name.toLowerCase().split(".").map((p) => p.trim());
  return parts.length > 1 ? parts.slice(1) : [];
};
const lastExt = (name: string | undefined): string | null => {
  if (!name) return null;
  const e = extsOf(name);
  return e.length ? e[e.length - 1] : null;
};

// The name a response carries, from Content-Disposition (filename*= first, then filename=) and from the
// last segment of the final URL's path. Bounded; only the part after the last slash or backslash.
export interface Names {
  disposition?: string;
  others?: string[]; // every other distinct name the header gave (Codex round 65: each one counts)
  url?: string;
}
const MAX_NAME = 255;
const baseName = (s: string) => s.slice(Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\")) + 1).replace(/[\u0000-\u001f\u007f]/g, "").slice(-MAX_NAME); // the END is kept: it holds the extensions (Codex round 61)
// Content-Disposition parameters, split by a linear tokenizer: `;` outside quotes ends a parameter, and a
// quoted value may hold `\"`. Only the exact keys `filename` and `filename*` count (Codex round 64: a
// regular expression took `xfilename*` for `filename*`).
function dispositionNames(h: string): string[] {
  const params: [string, string][] = [];
  let i = h.indexOf(";");
  while (i !== -1 && i < h.length) {
    i++;
    let key = "";
    while (i < h.length && h[i] !== "=" && h[i] !== ";") key += h[i++];
    if (h[i] !== "=") continue;
    i++;
    while (h[i] === " " || h[i] === "\t") i++;
    let value = "";
    if (h[i] === '"') {
      i++;
      while (i < h.length && h[i] !== '"') {
        if (h[i] === "\\" && i + 1 < h.length) i++;
        value += h[i++];
      }
      i = h.indexOf(";", i);
    } else {
      const end = h.indexOf(";", i);
      value = (end === -1 ? h.slice(i) : h.slice(i, end)).trim();
      i = end;
    }
    params.push([key.trim().toLowerCase(), value]);
  }
  const out: string[] = [];
  for (const [k, v] of params) {
    if (k === "filename*") {
      // RFC 8187: charset'language'percent-encoded. UTF-8 and ISO-8859-1 are decoded; anything else, or a
      // value that does not decode, is kept as written, so its extension still counts (Codex round 66: a
      // name is never dropped).
      const q1 = v.indexOf("'");
      const q2 = q1 >= 0 ? v.indexOf("'", q1 + 1) : -1;
      const charset = q2 >= 0 ? v.slice(0, q1).toLowerCase() : "";
      const enc = q2 >= 0 ? v.slice(q2 + 1) : v;
      let name = enc;
      try {
        const bytes = Buffer.from(enc.replace(/%([0-9a-fA-F]{2})|([^%])/g, (_m, h: string | undefined, c: string | undefined) => (h ? String.fromCharCode(parseInt(h, 16)) : c!)), "latin1");
        if (charset === "iso-8859-1") name = bytes.toString("latin1");
        else if (charset === "utf-8" || charset === "") name = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        name = enc;
      }
      out.unshift(name);
    } else if (k === "filename") out.push(v);
  }
  return out;
}

export function namesOf(disposition: string | null, finalUrl: string): Names {
  const out: Names = {};
  // The whole header is read (Node already bounds a header's size; Codex round 62). Both names a header
  // gives (filename* first, then filename) are kept: the strictest rule of either applies.
  if (disposition) {
    const all = dispositionNames(disposition).map(baseName).filter((x) => x);
    if (all[0]) out.disposition = all[0];
    const others = [...new Set(all.slice(1))].filter((x) => x !== all[0]);
    if (others.length) out.others = others;
  }
  try {
    const seg = new URL(finalUrl).pathname.split("/").pop() ?? "";
    let n = seg;
    try {
      n = decodeURIComponent(seg);
    } catch {
      // keep it as written
    }
    const b = baseName(n);
    if (b && b.includes(".")) out.url = b;
  } catch {
    // not a URL: no name
  }
  return out;
}
export const declaredName = (n: Names): string | undefined => n.disposition ?? n.url;

// Only extensions in the fixed table claim anything: a URL ending .php or .aspx (a route on a server) claims nothing.
function nameFamily(name: string | undefined): Family | null {
  const e = lastExt(name);
  return e ? (EXT[e] ?? null) : null;
}

function doubleExtension(name: string | undefined): boolean {
  if (!name) return false;
  const e = extsOf(name);
  return e.length >= 2 && RISKY_LAST.has(e[e.length - 1]) && Object.hasOwn(EXT, e[e.length - 2]) && !RISKY_LAST.has(e[e.length - 2]);
}

// A zip, OLE or Chrome add-on is one family with several kinds. The kind inside the family is taken from
// what the response says it is, since nothing inside the file is read.
function refine(kind: FileKind, sigFamily: Family, ct: string, names: Names, zip = false): FileKind {
  const exts = [names.disposition, ...(names.others ?? []), names.url].map(lastExt).filter((x): x is string => !!x);
  if (sigFamily === "ole") return exts.includes("msi") || ct === "application/x-msi" ? "program" : "office";
  if (kind !== "archive" || !zip) return kind;
  if (exts.some((e) => ADDON_EXT.has(e)) || ct === "application/x-xpinstall" || ct === "application/x-chrome-extension") return "addon";
  if (exts.some((e) => ZIP_PROGRAM_EXT.has(e)) || ["application/java-archive", "application/x-java-archive", "application/vnd.android.package-archive", "application/vnd.ms-appx", "application/msix"].includes(ct)) return "program";
  if (exts.some((e) => OFFICE_EXT.has(e)) || /^application\/vnd\.(openxmlformats-officedocument|ms-[a-z]+\.[a-z.]*macroenabled|oasis\.opendocument)/.test(ct)) return "office";
  return "archive";
}

// The start of a text body as text: UTF-16 by its byte-order mark, otherwise UTF-8 (a UTF-8 mark dropped).
// The same decoding is used for every check on content, so a UTF-16 shortcut is still a shortcut (Codex round 58).
function headText(head: Buffer, max = 4096): string {
  const b = head.subarray(0, max);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2, 2 + ((b.length - 2) & ~1)));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2, 2 + ((b.length - 2) & ~1)));
  return new TextDecoder("utf-8").decode(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3) : b);
}

// A binary body, not text: a NUL in the head, or (for UTF-16 with its byte-order mark) a NUL character once
// decoded. A declared charset alone proves nothing (Codex round 58).
function looksBinary(head: Buffer): boolean {
  if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)) return headText(head, head.length).includes("\u0000");
  return head.indexOf(0) !== -1;
}

const SHORTCUT_TEXT = ["[internetshortcut]", "[desktop entry]", "regedit4", "windows registry editor version"];
export const textShortcut = (head: Buffer) => {
  let t = headText(head, 512).trimStart().toLowerCase();
  if (t.startsWith("#!")) t = t.slice(t.indexOf("\n") + 1).trimStart(); // an interpreter line does not hide what follows
  return SHORTCUT_TEXT.some((p) => t.startsWith(p));
};
const startsHtml = (head: Buffer) => /^\s*(<!doctype html|<html)/i.test(headText(head, 1024));

// The text kind a name asks for, under a generic text type or none.
function textByName(name: string | undefined): ReadAs | "shortcut" | null {
  const e = lastExt(name);
  if (!e) return null;
  if (SHORTCUT_EXT.has(e)) return "shortcut";
  if (SCRIPT_EXT.has(e)) return "script";
  if (e === "svg") return "svg";
  if (e === "csv") return "csv";
  if (e === "ics" || e === "ifb") return "calendar";
  if (e === "vcf" || e === "vcard") return "contact";
  return null;
}

// THE decision for one response. `head` is the first HEAD_BYTES of the decoded body (or all of it when
// shorter), `contentType` the declared Content-Type, `names` the declared names.
// `tail`, when given, is the body's last 512 bytes (known only once the body has ended).
export function classify(head: Buffer, contentType: string, names: Names, tail?: Buffer): Verdict {
  const m = mimeOf(contentType);
  const sig = signature(head, tail);
  const verdict = decide(head, m, names, sig);
  // Flags: what the response says against what it is. A binary body with no known signature cannot be
  // told apart from a binary kind Tiresias does not list, so it disagrees only with a claim of text.
  const body: Family | "binary" = sig ? sig.family : looksBinary(head) ? "binary" : "text";
  const claims = [typeFamily(m), ...[names.disposition, ...(names.others ?? []), names.url].map(nameFamily)].filter((x): x is Family => x !== null);
  const flags: FileFlag[] = [];
  if (claims.some((c) => (body === "binary" ? c === "text" : c !== body))) flags.push("type_mismatch");
  if ([names.disposition, ...(names.others ?? []), names.url].some(doubleExtension)) flags.push("double_extension");
  verdict.flags = flags;
  return verdict;
}

function decide(head: Buffer, m: string, names: Names, sig: Sig | null): Verdict {
  if (sig && sig.kind === "pdf") {
    // W-17 (kept): a PDF is read only under application/pdf or a missing or generic type. Under an explicit
    // text type the body stays text; under any other type it is a file Tiresias does not open.
    if (m === "application/pdf" || GENERIC.has(m)) return { read: "pdf", flags: [] };
    if (typeFamily(m) === "text") return { read: m.includes("html") ? "html" : "text", flags: [] };
    return { file: "unknown", flags: [] };
  }
  if (sig && sig.kind !== "script") return { file: refine(sig.kind as FileKind, sig.family, m, names, sig.zip), flags: [] };
  if (!sig && m === "application/pdf") return { read: "pdf", flags: [] }; // W-17: the declared type alone (a broken PDF fails to read)
  if (looksBinary(head)) return { file: "unknown", flags: [] };
  // Every text rule that applies is collected (from the content, the declared type and both names) and the
  // strictest wins (Codex round 59): a shortcut is never read, then CSV (its formulas are counted), then a
  // script, then SVG, calendar, contact. So a "#!" first line cannot turn a .desktop file into a script,
  // and a text/csv body named x.js still has its formulas counted.
  const wants = new Set<ReadAs | "shortcut">();
  if (textShortcut(head) || SHORTCUT_TYPES.has(m)) wants.add("shortcut");
  for (const n of [names.disposition, ...(names.others ?? []), names.url]) {
    const x = textByName(n);
    if (x) wants.add(x);
  }
  if (sig?.kind === "script" || SCRIPT_TYPES.has(m)) wants.add("script");
  if (m === "image/svg+xml") wants.add("svg");
  if (m === "text/csv" || m === "application/csv") wants.add("csv");
  if (m === "text/calendar") wants.add("calendar");
  if (m === "text/vcard" || m === "text/x-vcard" || m === "text/directory") wants.add("contact");
  if (wants.has("shortcut")) return { file: "shortcut", flags: [] };
  for (const r of ["csv", "script", "svg", "calendar", "contact"] as const) if (wants.has(r)) return { read: r, flags: [] };
  if (/html|xhtml/.test(m)) return { read: "html", flags: [] };
  if (/json/.test(m)) return { read: "json", flags: [] };
  if (m.startsWith("text/") || /markdown|xml/.test(m)) return { read: "text", flags: [] };
  if (GENERIC.has(m)) {
    const e = lastExt(names.disposition) ?? lastExt(names.url);
    if (e === "html" || e === "htm" || e === "xhtml") return { read: "html", flags: [] };
    if (e === "json") return { read: "json", flags: [] };
    if (e === "txt" || e === "text" || e === "md" || e === "markdown" || e === "xml") return { read: "text", flags: [] };
    if (m === "") return { read: startsHtml(head) ? "html" : "text", flags: [] }; // no type at all: the content decides, as before v0.5
    return { file: "unknown", flags: [] }; // a generic binary type with nothing that says it is text
  }
  return { file: "unknown", flags: [] }; // any other declared type with no known signature
}
