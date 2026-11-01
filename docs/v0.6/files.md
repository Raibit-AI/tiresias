# v0.6 track "files": inside zips, Office text, calendar events

Branch `v0.6-files`. Builder: Banks (Claude). Decisions here are for the coordinator to fold into SPEC.md
(sections 4.4, 6 and 9); SPEC.md itself is not edited on this branch.

## Progress

- [x] 1. Zip listing (`src/zipread.ts`, `src/inside.ts`; tests `src/test/zip.test.ts`)
- [x] 2. Office text (`src/office.ts`, `src/xmltext.ts`; tests `src/test/office.test.ts`)
- [x] 3. Calendar events (`src/ics.ts`; tests `src/test/ics.test.ts`)
- [x] Coordinator decisions applied (2026-10-24, below): fail-closed XML, narrow part selection, hidden text advisory, receipts deferred to integration
- [x] Codex review loop resumed from round 5 with the updated threat model; resumed again after round 13; round 15 reviewed round 14's allow-list; the loop ended there to save usage (Travis, 2026-10-26), with its findings deferred (below).

## Codex rounds

| Round | File | HIGH | MEDIUM | LOW | Result |
|---|---|---|---|---|---|
| 1 | `docs/reviews/2026-10-24-v06-files-round-1.md` | 0 | 17 | 4 | all 21 fixed with tests that fail without them (mutations checked) |
| 2 | `docs/reviews/2026-10-24-v06-files-round-2.md` | 0 | 14 | 4 | all 18 fixed with tests that fail without them (mutations checked) |
| 3 | `docs/reviews/2026-10-24-v06-files-round-3.md` | 0 | 13 | 2 | all 15 fixed with tests that fail without them (mutations checked) |
| 4 | `docs/reviews/2026-10-24-v06-files-round-4.md` | 0 | 11 | 1 | all 12 fixed with tests that fail without them (mutations checked); loop paused by the stop rule; resumed after the coordinator's decisions |
| 5 | `docs/reviews/2026-10-24-v06-files-round-5.md` | 0 | 8 | 3 | all 11 fixed with tests that fail without them (mutations checked; #1's guard is also covered by hidden_entries) |
| 6 | `docs/reviews/2026-10-24-v06-files-round-6.md` | 0 | 6 | 2 | all 8 fixed with tests that fail without them (mutations checked) |
| 7 | `docs/reviews/2026-10-24-v06-files-round-7.md` | 0 | 4 | 3 | all 7 fixed with tests that fail without them (mutations checked) |
| 8 | `docs/reviews/2026-10-24-v06-files-round-8.md` | 0 | 3 | 3 | all 6 fixed with tests that fail without them (mutations checked) |
| 9 | `docs/reviews/2026-10-24-v06-files-round-9.md` | 0 | 4 | 2 | all 6 fixed with tests that fail without them (mutations checked) |
| 10 | `docs/reviews/2026-10-24-v06-files-round-10.md` | 0 | 5 | 1 | all 6 fixed with tests that fail without them (mutations checked; the two row-separator bounds back each other up, the test fails when both go) |
| 11 | `docs/reviews/2026-10-24-v06-files-round-11.md` | 0 | 4 | 1 | all 5 fixed with tests that fail without them (mutations checked) |
| 12 | `docs/reviews/2026-10-24-v06-files-round-12.md` | 0 | 3 | 1 | all 4 fixed with tests that fail without them (mutations checked) |
| 13 | `docs/reviews/2026-10-24-v06-files-round-13.md` | 0 | 3 | 1 | all 4 fixed with tests that fail without them (mutations checked); the coordinator resumed the loop (guard: round 15) |
| 14 | `docs/reviews/2026-10-24-v06-files-round-14.md` | 0 | 2 | 1 | all 3 fixed with tests that fail without them (mutations checked) |
| 15 | `docs/reviews/2026-10-24-v06-files-round-15.md` | 0 | 1 | 1 | no HIGH; MEDIUM and LOW deferred to the compute-day sweep (Travis, 2026-10-26: save usage); loop ended here |

## Decisions

### Shared

| Date | Decision | Why |
|---|---|---|
| 2026-10-24 | A zip or Office file stays a `file_warning` (kind, risk, fingerprint, the owner's scanner all unchanged). Looking inside adds `file_warning.inside` (Tiresias's own facts: fixed codes, counts, fixed text per code in `details`) and `untrusted_content.inside` (names, text, links: everything from the file). The message gains one fixed sentence saying what was looked at. | The file is still a file nobody opened: the human still decides. Office text as a full page read (sections, receipts, cache) would change the page path and the 5 MB page cap for every kind; kept as an open question for the coordinator. |
| 2026-10-24 | Only a file whose first bytes are a zip local header (or an empty zip's end record), of kind `archive` or `office`, is held, in memory only, up to `TIRESIAS_MAX_INSPECT_BYTES` (default 20 MiB, separate from the 50 MB fingerprint cap). Over it: `inside: { listed: false, reason: "too_large" }`, fingerprint as before. The bytes are dropped as soon as the warning is built. Nothing is ever written to disk (the W-21 quarantine copy is unchanged and separate). | Holding a file whole is new for v0.6 (v0.5 never held a file); it is needed because a zip's directory is at its end. 20 MiB keeps one call's memory small. |
| 2026-10-24 | Programs that are zips (`.jar`, `.apk`), add-ons (`.xpi`) and other kinds are not listed, only `archive` and `office`. | Scope: the spec's table names zips and Office files. |
| 2026-10-24 | The inspection always runs in the worker thread (never inline, whatever the size), under the parse time budget and heap limit. zlib's native buffers are outside the heap limit, so every inflate has an explicit output cap (below), which bounds them by construction. Any failure (budget, heap, crash) is `reason: "too_complex"` and the warning goes on: fail closed, never an error. | The same pattern as every other untrusted parse; the explicit caps cover what the heap limit cannot see. |

### 1. Zip listing

| Date | Decision | Why |
|---|---|---|
| 2026-10-24 | The central directory is the listing; every record is compared with the local header it points at (name bytes, method, encryption bit, sizes and CRC when not deferred). Disagreement is `directory_mismatch` or `name_mismatch`. The end record is the one whose comment runs exactly to the end of the file (`trailing_data` otherwise, `multiple_directories` when more than one is valid). A directory offset that is off by a constant is read from where the directory really is (`leading_data`, as in a self-extracting program); any other disagreement is `directory_mismatch`. | A zip that reads differently in different programs is the attack; the reader says so instead of choosing. |
| 2026-10-24 | Zip bombs are reported from what the zip claims, never by unpacking: `high_ratio` (an entry over 1 MiB claiming over 100x its packed size), `huge_when_unpacked` (claimed total over 1 GiB), `overlapping_entries` (two entries' bytes share space). `unpacked_size` on the top level is the CLAIMED total and the note says so. | Nothing is unpacked, so a bomb costs nothing to list; the human still needs to know. |
| 2026-10-24 | `hidden_entries`: a local header mark in bytes no listed entry covers (a streaming unpacker would find a file the directory hides). Searched on each gap's own slice, so one pass over the file. | Directory-based and streaming unpackers disagree on such zips. |
| 2026-10-24 | Names: UTF-8 when the entry says so and it decodes, otherwise one byte per character. Control, invisible and direction characters raise `odd_name` and are shown as U+FFFD. Shown names are at most 255 characters (the end kept, it holds the extension). `path_traversal` (a `..` segment, also with trailing dots or spaces, with `/` or `\`), `absolute_path` (`/`, `//`, a drive letter), `deep_path` (over 16 segments). The Info-ZIP Unicode path field (0x7075), which some unpackers use instead of the name, is read: when it differs, `name_mismatch`, and both names are judged (the riskier kind counts). Same name twice (case and slash direction folded): `duplicate_names`. | Each is a way a name can write outside its folder or disguise a file. |
| 2026-10-24 | Kind of each entry: by its name (files.ts tables, new `innerKind`), and by its first bytes when the local header allows: stored entries are sliced; deflated ones are inflated from at most 1,024 compressed bytes with a sync flush and an output cap (deflate cannot pass about 1 MB from that), at most 1,000 entries and 16 MiB of output per zip. The riskier kind wins, and a name and bytes that disagree add `type_mismatch`. Flags `program_inside`, `script_inside`, `shortcut_inside`, `addon_inside`, `archive_inside`, `office_inside`. Encrypted entries and other methods are never sniffed (`first_bytes_unchecked` counts them). | "By name and by first bytes where the local header allows." |
| 2026-10-24 | Password-protected entries (bit 0, or method 99 AES) are listed with `encrypted: true`, counted in `inside.encrypted`, flagged `encrypted`; an encrypted directory is `encrypted_directory`. Symbolic links (Unix mode in the external attributes) are `symlink`. ZIP64 is read through its locator and record and flagged `zip64`; 64-bit numbers past 2^53 are treated as lies. Split zips are `multi_disk`. | |
| 2026-10-24 | Limits: 10,000 directory records read (`too_many_entries`, `entries_at_least`); the reply lists flagged entries first, then the rest, up to 24 KB of JSON (`shown`, `entries_omitted`). Nested archives are listed by name only, never opened. Names are scanned by the prompt-injection shield. | Keeps a reply under its size limit and the riskiest names always visible. |

### 2. Office text

| Date | Decision | Why |
|---|---|---|
| 2026-10-24 | Which parts are read follows the file's own relationships, as Office does: the root `_rels/.rels` names the main part (`officeDocument`); a Word document's rels name its headers, footers, footnotes, endnotes and comments; a workbook's rels name its sheets (in `workbook.xml` order) and shared strings; a presentation's rels name its slides (in `sldIdLst` order). A decoy `word/document.xml` beside the real main part is never shown. No main part or no `[Content_Types].xml`: `not_ooxml`, listing only (ODF files land here). | The text shown should be the text a person sees on opening the file. |
| 2026-10-24 | A zip whose structure does not add up (`overlapping_entries`, `directory_mismatch`, `hidden_entries`, `duplicate_names`, `name_mismatch`, `multiple_directories`, `encrypted_directory`, `out_of_bounds`) gets no text: `text_refused`. | Different readers could show different text; Tiresias does not guess. |
| 2026-10-24 | Bounded decompression: each part through `readEntry` with output capped at the smaller of 8 MiB and what is left of a 32 MiB total for the file; one byte over the declared size stops it, and the result must equal the declared size and CRC-32. Anything else: `part_too_large` or `part_unreadable`, the part skipped, never read in part. At most 1,000 `.rels` parts and 500 sections; 200,000 characters of text read (`text_cut`), at most 40 KB of it in the reply (`text_omitted` counts the rest), outside links at most 12 KB (`external_links_omitted`). | Bombs and lying sizes cost at most the caps. |
| 2026-10-24 | XML (xmltext.ts): one linear pass, no tree. Only `&lt; &gt; &amp; &quot; &apos;` and numeric references are decoded; since round 2 any other `&` (an undeclared entity, a reference to a character XML does not allow) makes the part `xml_malformed`. Any `<!` declaration other than a comment or CDATA (DOCTYPE, ENTITY, ELEMENT...) refuses the part: `xml_doctype`. UTF-16 parts by byte-order mark. | No XXE and no billion laughs by construction: nothing is ever resolved or expanded. |
| 2026-10-24 | `macros`: a `vbaProject.bin` (or `vbaData.xml`, `vbaProjectSignature`) anywhere, Excel 4 macro sheets (`xl/macrosheets/`), a macro-enabled or VBA content type in `[Content_Types].xml`, OR a macro type by name (`.docm .xlsm .pptm .dotm .xltm .potm .ppsm .xlam .ppam`) or declared type (`macroEnabled`), even when the file is not looked inside. It goes on `file_warning.flags` (and `inside.flags`). Risk stays `high` for every Office file. Also `activex` (`activeX/` parts) and `embedded_objects` (`embeddings/` parts, names listed, at most 50). | The flag the spec names, wherever the evidence is. Risk unchanged: a file without macros can still carry outside templates or DDE. |
| 2026-10-24 | Outside links: every relationship with `TargetMode="External"` (any case) in any `.rels` part is listed as `{ type, target }` (type is the last segment of the relationship type, like `attachedTemplate`, `hyperlink`, `oleObject`), never fetched: `external_links`; an outside template is also `external_template`. `dde`: a Word field (`instrText` or `fldSimple`) with DDE or DDEAUTO, an Excel `ddeLink`, or a cell formula shaped like `app|'topic'!item`. Field codes are never shown as text. | Template injection and DDE are the two ways a macro-free Office file runs code. |
| 2026-10-24 | Hidden text is left out and flagged `hidden_text` (the shield's `hidden_text` flag carries a snippet): Word runs with `vanish`/`specVanish` (not `w:val="0"`), slides with `show="0"`, sheets with `state="hidden"` or `veryHidden`. Phonetic runs in shared strings and deleted text (`delText`) are not text. All shown text goes through the prompt-injection shield. | The same rule as hidden HTML text. |
| 2026-10-24 | Old `.doc`/`.xls`/`.ppt` (the OLE signature) keep v0.5's fingerprint-only warning, with no `inside`. | Spec. |

### 3. Calendar events

| Date | Decision | Why |
|---|---|---|
| 2026-10-24 | A calendar file is still read as a page (W-20, `calendar` flag kept, text and links as before). Its events are added as `untrusted_content.events` (on the first page of the outline, and with a section or question): `summary`, `start`, `end` (ISO 8601 when the value has the usual `YYYYMMDD[THHMMSS[Z]]` form, otherwise as written), `start_tz`/`end_tz` (the TZID as written; no time zone is converted), `duration` (when there is no end), `organizer` (`mailto:` dropped) and `organizer_name` (CN), `location`, `description`, `url`, and `links`: every http(s) link in the event (URL, description, location, organizer, ATTACH, conference properties). | Structured events without changing how a calendar is read. |
| 2026-10-24 | Links are listed, never followed. "Checked by Safe Browsing like page links" means what it means for a page link: the check runs before any visit (W-19, at the fetcher), and nothing in an invite is requested by reading it. No link is sent to Google Web Risk just because it is listed. | The spec table: "checked by Safe Browsing (W-19) before any visit". Sending every listed link to Google on read would leak the invite's contents to Google for links nobody visits. |
| 2026-10-24 | Limits: 50 events kept (`events_omitted` counts the rest, and those past a 30 KB reply budget); values cut at summary 300, location 300, organizer 300, organizer name 200, description 1,000 characters, dates 64 (`cut: true` on the event); 20 links per event, each at most 2,048 characters; nested blocks followed 20 deep (an event buried deeper is not counted). Only the event's own properties count: an alarm's description inside the event is not the event's. An event cut off by the end of the file still counts. The first value of a repeated property wins. Values go through the prompt-injection shield. | Bounded output and work; no guessing about malformed input. |
| 2026-10-24 | `PARSER_VERSION` 10 -> 11, so cached calendar pages are read again with their events. (Another track may also bump it: the coordinator picks one number at merge.) | |

### After Codex round 1 (all 21 findings fixed)

| Date | Decision | Why |
|---|---|---|
| 2026-10-24 | The bytes held to look inside are one buffer that grows by doubling (never past the cap), not a list of pieces. | #1: tiny pieces must not cost more memory than their bytes. |
| 2026-10-24 | Every reply budget of this track counts UTF-8 bytes (`jsonBytes`). After the warning is built, the whole reply is checked against the hard limit (100 KB): `inside.entries`, `inside.embedded`, `inside.external_links`, `inside.sections`, then `flag_details` are dropped in that order, named in `dropped_for_size`; `file_warning` always stays. `events` joins the parts `fitEnvelope` may drop. | #4 |
| 2026-10-24 | Zip agreement now also covers: every general-purpose flag (not only encryption), the local ZIP64 sizes and local Unicode name, data descriptors (with or without their mark, 4- or 8-byte sizes; they must agree with the directory and count in the overlap ranges), the ZIP64 record's own length, and its disk fields. Directory entries pass their flags up like any entry. First bytes count as checked only when at least 8 bytes (or the whole entry) were seen; otherwise `first_bytes_unchecked`. Names without the UTF-8 bit are decoded as code page 437. | #5, #6, #7, #19 |
| 2026-10-24 | XML is strict: unfinished constructs, mismatched close tags, duplicate attributes (also by namespace), unbound prefixes, a second root or text outside the root make the part `xml_malformed`. Each part is validated whole before any of it is used, so a refused part contributes nothing (no text, no links). | #8 |
| 2026-10-24 | Elements and attributes are matched by namespace URI and local name (transitional and strict OOXML namespaces); relationship types must be the full standard URI. `mc:AlternateContent` is resolved: the `Fallback` when there is one, else the first `Choice`; the rest is skipped and `alternate_content` says so. The main part's format comes from its content type only. | #9 |
| 2026-10-24 | Hidden text also covers Word styles (`w:vanish` on a run or paragraph style, through `basedOn` chains up to 20 deep, and the document default), Excel hidden rows and columns, and PowerPoint hidden shapes. | #10 |
| 2026-10-24 | Nothing stops silently: a part the file refers to but lacks is `part_missing`; past the part or relationship limits `parts_omitted`; a shared-string table past its limit makes any reference beyond it `text_cut`. Row growth is checked at every cell. | #3, #11 |
| 2026-10-24 | Word headers and footers are the ones a section references (`w:headerReference`, `w:footerReference`); an unreferenced one is not shown. | #12 |
| 2026-10-24 | Also listed as outside links (never fetched): Word `HYPERLINK` fields and Excel `HYPERLINK(...)` formulas. Linked-workbook parts are found through the workbook's relationships, wherever they sit. | #13 |
| 2026-10-24 | The shield scans every string this track returns: Office section headings (sheet names), outside link types and targets, embedded names, and every string of a calendar event (links and time zones included). | #14 |
| 2026-10-24 | Excel cells keep their columns (from the cell reference, at most 256 empty columns kept between two cells); booleans show as TRUE/FALSE; `_xHHHH_` escapes are decoded; numbers are shown as stored and `raw_numbers` says so (no number formats are applied). | #15 |
| 2026-10-24 | Calendar: inside a block past the depth cap nothing counts for the event; an END that does not match the open block closes up to the block it names (or is ignored), and `events_malformed: true` says the file did not nest properly (also for an event never closed). ALTREP and DIR parameters are links; links past the cap of 20 or over 2,048 characters are counted in `links_omitted`. The event's `url` is its URL property's own value. Every bounded value (dates, time zones, duration too) sets `cut` when cut. | #16, #17, #20, #21 |
| 2026-10-24 | The macros flag by name looks at every name the response gave (both header names and the URL's), and also lands on `inside.flags`. | #18 |

### After Codex round 2 (all 18 findings fixed)

| Date | Decision | Why |
|---|---|---|
| 2026-10-24 | A stored entry's packed and unpacked sizes must be equal (`directory_mismatch` otherwise). `readEntry` also requires the deflate stream to end exactly at the end of the entry's packed bytes (zlib's count of input consumed), so trailing bytes cannot hide a second payload. The listing note now says that where each entry's data ends is also what the zip declares. | #1 |
| 2026-10-24 | Names are compared as they would be written: dot segments resolved, trailing dots and spaces dropped from each segment, Unicode composed (NFC), case folded. Duplicates are judged on that form; the kind is judged on the name, that form, and the part after a colon (an NTFS stream name). A segment ending in a dot or space, a character Windows forbids (`: * ? " < > |`, outside a drive letter) or a reserved device name (CON, PRN, AUX, NUL, COM0-9, LPT0-9) is `odd_name`. | #2 |
| 2026-10-24 | Stricter XML: invalid UTF-8/UTF-16 bytes, characters XML does not allow, `--` inside a comment, `]]>` in text, a misplaced `<?xml?>`, reserved namespace bindings broken (`xml` to anything but its own name, `xmlns` declared, a prefix bound to an empty name) are all `xml_malformed`. XML end-of-line handling (CR LF and CR become LF) and attribute-value normalization (literal tabs and line breaks become spaces; character references keep their character) are applied. | #3, #4 |
| 2026-10-24 | Each part must have the root element its role requires (`w:document`, `w:hdr`, `w:ftr`, `w:footnotes`, `w:endnotes`, `w:comments`, `w:styles`, `p:presentation`, `p:sld`, `s:workbook`, `s:worksheet`, `s:sst`, `s:externalLink`, `Relationships`, `Types`), or it is not read (`unexpected_root`). Text counts only inside the content element (`w:body` of the main document, `p:cSld` of a slide, `s:sheetData` of a sheet). Markup compatibility: an element in a namespace listed in an in-scope `mc:Ignorable` that Tiresias does not read is skipped with its content, unless `mc:ProcessContent` names it (then only its own tag is dropped); `alternate_content` says so. | #5 |
| 2026-10-24 | Word visibility: the default paragraph and character styles apply when a paragraph or run names none; `vanish` is treated as a toggle (direct formatting absolute; through styles, the paragraph-style chain and the character-style chain each flip it over the document default). Because this is approximate, any text whose visibility came from hiding styles raises `visibility_uncertain`; so do a style chain that loops or passes 20 steps, and more than 1,000 hidden column ranges. | #6, #7 |
| 2026-10-24 | Word fields: the instruction is assembled across runs between the field's `begin` and its `separate` (or `end`) marks, nested fields on a stack, at most 10,000 characters, then checked for DDE and HYPERLINK. | #8 |
| 2026-10-24 | Excel `HYPERLINK(...)`: the destination is the first argument only when it is one string literal (with `""` escapes); any other first argument (a cell, an expression, a string joined to something) is counted, never guessed: `computed_links`. Every call in a formula is found, nested ones too (at most 100 per formula). | #9 |
| 2026-10-24 | Inline strings drop phonetic runs like shared strings. Rows keep their numbers (skipped rows become blank lines), leading empty columns keep their tabs, and a gap over 256 rows or columns is shortened with `positions_compressed`. | #10, #11 |
| 2026-10-24 | `unsupported_content`: visible content Tiresias does not read (a Word `altChunk`, or an internal relationship of kind `aFChunk`, `chart`, `diagramData` or `subDocument`). | #12 |
| 2026-10-24 | Calendar: an event inside an event lends nothing to the outer one; a line that is not NAME:VALUE, a block left open at the end, and nesting past the cap all set `events_malformed`. Link schemes are matched in any case; a URI-valued property or parameter (URL, ATTACH, conference properties, ALTREP, DIR) is taken whole, keeping its punctuation. | #13, #15 |
| 2026-10-24 | Reply fitting puts `dropped_for_size` in place before each size check (it can then drop `inside.note` last), so the result is always under the limit. Embedded files are all counted (`inside.embedded`), at most 50 named, the rest in `embedded_omitted`. Sniffing holds each inflate to what is left of the 16 MiB total, and a call that fails spends its cap. | #14, #16, #17 |
| 2026-10-24 | Coverage added for ZIP64 entry sizes, wide data descriptors, encrypted directories, split zips, unsupported and AES methods, sniff budget exhaustion, and the relationship and outside-link limits. | #18 |

### After Codex round 3 (all 15 findings fixed)

| Date | Decision | Why |
|---|---|---|
| 2026-10-24 | Extra fields that carry a file type or permissions some unpackers prefer to the directory's (ASi Unix 0x756e, PKWARE Unix 0x000d, libarchive 0x6c78) raise `extra_attributes`; an ASi mode that is a link, or a PKWARE field holding a link target, is `symlink`. Every Unicode path field counts (none overwrites another); one with a version other than 1 or a CRC that does not match the entry's own name bytes is `odd_name`, and its name is still judged. A file at a place another entry needs as a folder (either order), or a file and a folder with the same name, is `path_conflict` (an Office file with it gets no text). | #1, #2, #3 |
| 2026-10-24 | An entry's first 512 bytes are looked at (was 64), and text shortcut and registry markers (files.ts `textShortcut`, as for a download) name it `shortcut` whatever its name. | #4 |
| 2026-10-24 | XML: a processing-instruction target must be an XML name; the XML declaration must be well-formed (version 1.x, optional encoding and standalone), and a declared encoding must be the one the bytes were read in (UTF-8, or UTF-16 by its mark); close tags take only XML white space after the name. | #5 |
| 2026-10-24 | Text is taken only along a set of known container elements per format (Word: body, paragraphs, runs, hyperlinks, fields, content controls, insertions, tables, text boxes through DrawingML and VML, equations; PowerPoint: the slide's shape tree, text bodies, paragraphs, runs, fields, tables). Text found anywhere else is not shown: `unsupported_content`, with the text in `flag_details` as hidden text (so the shield still sees it). This is a set of allowed containers, not a full schema path. A part that lists in `mc:MustUnderstand` a namespace Tiresias does not read is not read (`unsupported_content`), as Office would refuse it. | #6 (closes the context class raised in rounds 2 and 3) |
| 2026-10-24 | Package ambiguity gives no text (`ambiguous_package`, with `not_ooxml`): a relationship part with a missing or repeated id (its outside links are still listed), more than one main-document relationship, a part typed twice differently, or a main document whose content type is not exactly one of the known Word, Excel or PowerPoint main types. | #7 |
| 2026-10-24 | Revision history (`w:rPrChange`, `w:pPrChange` and every other `*Change` element) holds old properties and is never read as current, in the document and in styles. | #8 |
| 2026-10-24 | PowerPoint: text a slide inherits from its layout or master (shapes that are not placeholders) is not read; `unsupported_content` says so (each layout and master looked at once). Word equation text (`m:t`) is read as text. | #9 |
| 2026-10-24 | Formula cells: `cached_results` says the value shown is the one saved in the file (or none), never evaluated. | #10 |
| 2026-10-24 | Security checks never stop silently with the text: a field instruction or formula past 10,000 characters, or more than 100 HYPERLINK calls in one formula, is `checks_incomplete`; once the text cap is reached, every remaining part and sheet is still read for its DDE and link checks (only the text stops). | #11 |
| 2026-10-24 | Calendar events also keep `status`, `rrule`, `rdate`, `exdate` (repeats joined), `recurrence_id`, and the calendar's `method` on every event; recurrences are never expanded. Links come from every property's value and every parameter of the event; each omitted link is counted once. | #12, #13 |
| 2026-10-24 | Test fixtures are schema-shaped (columns before sheet data, slide text inside the shape tree); UTF-16 parts in both byte orders are tested; zip scripts and shortcuts are tested by content under innocent names. | #14, #15 |

### After Codex round 4 (all 12 findings fixed)

| Date | Decision | Why |
|---|---|---|
| 2026-10-24 | Main content types are looked up in a `Map`, never a plain object (a type named like an inherited property, such as `constructor`, found a value). | #1 (a real bug) |
| 2026-10-24 | Every token now carries the path of its ancestors. Package indexes count only where the schema puts them: content-type `Default`/`Override` directly under `Types`, `Relationship` directly under `Relationships`, `sldId` under `presentation/sldIdLst`, `sheet` under `workbook/sheets`; anything misplaced is `ambiguous_package` (and gives no text when it touches the package index). Shared-string items count only directly under `sst`, their text only in `si/t` or `si/r/t`. Styles are read only from `styles/style`, `styles/style/rPr` and `styles/docDefaults/rPrDefault/rPr`; a hiding property elsewhere is `visibility_uncertain`. | #2 |
| 2026-10-24 | XML names follow the XML 1.0 (fifth edition) name grammar with namespaces (at most one colon); a declaration whose `xml` is in any other case is refused; UTF-16 with a byte-order mark may declare `UTF-16` or its real byte order only. | #3 |
| 2026-10-24 | A zip entry is a folder by a trailing slash OR by its attributes (a Unix folder mode, or the DOS folder bit on DOS, NTFS or VFAT hosts); when the name and the attributes disagree, `attribute_mismatch`. | #4 |
| 2026-10-24 | An entry counts as checked only when its whole first 512 bytes (or the whole entry, when smaller) were seen; a cut or failed look is `first_bytes_unchecked` whatever size the entry claims. | #5 |
| 2026-10-24 | Word `vanish` along a basedOn chain is a toggle: each style that turns it on flips it, one that turns it off leaves it as inherited. ANY involvement of styles in a run's visibility (any style on its chains setting vanish, or a document default) raises `visibility_uncertain`, whichever way it comes out. | #6 |
| 2026-10-24 | Headers and footers are shown by type: `default` always, `first` only with the section's `titlePg`, `even` only with `evenAndOddHeaders` in the settings part. Footnotes, endnotes and comments are shown only when the document references their id, never separator notes. | #7 |
| 2026-10-24 | Characters written as elements: `noBreakHyphen` (U+2011), `ptab` (a tab); `sym`, date and page-number elements are `unsupported_content`. | #8 |
| 2026-10-24 | A shared-string reference that cannot be resolved (no table, past its end, not a number) is `unresolved_cells`; past a table Tiresias cut it is `text_cut`. | #9 |
| 2026-10-24 | Calendar: each `VCALENDAR` object keeps its own `METHOD` for its own events; events keep `uid`; `recurrence_id_tz`, `recurrence_range`, `rdate_tz` and `exdate_tz` keep the recurrence parameters. | #10, #11 |
| 2026-10-24 | Tests added: non-ASCII calendar budget (UTF-8 bytes), failed inflates spending the sniff budget. | #12 |

## Stopped early (2026-10-24, after round 4)

The brief says to stop and report when the same finding survives two fixes. Three themes did:

1. **XML strictness** (rounds 1, 2, 3, 4): each round found one more corner of the XML grammar the hand-written reader accepted (entities, encodings, comments, names, declarations). All found so far are fixed. The class only closes for good with a full conforming XML parser, which would be a new dependency (none is installed; any candidate needs `skillspector scan` first).
2. **Structural context in Office files** (rounds 2, 3, 4): matching by name, then by namespace, then by container set, then by exact parent path for package indexes. Text now comes only from known containers and unknown markup is flagged, not shown; but this is not a full OOXML schema validation, and Codex can always name another element whose context is not checked.
3. **Word visibility semantics** (rounds 1, 2, 4): direct formatting, styles, defaults, toggles, revision history. The rules are now approximated and any style involvement raises `visibility_uncertain`, so the output is honest about it, but it is not Word's exact algorithm.

**Decided by the coordinator (see the next section).** The options were: accept "approximate fidelity, always flagged" for Office text (the current design: anything Tiresias is not sure about is flagged and, where it could be decoy text, not shown), or narrow the feature (for example Office text only from the main document body, everything else flagged), or add a reviewed XML parser dependency. The zip listing and calendar parts did not hit the stop rule.

## Coordinator decisions (2026-10-24, after the round 4 stop)

| Date | Decision | Why |
|---|---|---|
| 2026-10-24 | **XML is fail closed.** A part with a DOCTYPE or entity declaration, malformed structure, a processing instruction other than the XML declaration, a wrong root, a namespace it must understand and cannot, or bytes that are not valid text is refused outright: no text from it, and `office_unreadable` (the specific flag stays beside it). No dependency added. | Coordinator: don't tolerate, reject. Ends the XML-strictness theme. |
| 2026-10-24 | **Narrow part selection.** Word: the main document only (`word/document.xml`); no styles, settings, headers, footers, notes or comments. Excel: shared strings and the worksheets the workbook lists as visible (a hidden sheet is not read). PowerPoint: the slides presentation.xml lists, in order (layouts, masters and notes not read). Each part is found through the package relationships, and the main part must be at its usual name (`word/document.xml`, `xl/workbook.xml`, `ppt/presentation.xml`) or the file gives no text. Parts that may hold text and were not read are named in `untrusted_content.inside.skipped_parts` (at most 50) with the `parts_skipped` flag; linked workbooks are skipped too, so the DDE check is `checks_incomplete` when one exists. | Coordinator. Ends the structural-context theme for everything outside the main text. |
| 2026-10-24 | **Hidden text is best effort and advisory.** Only a run's own `vanish`, hidden rows, columns, shapes, slides and sheets are honoured; Word styles are not read at all. A missed hidden run is NOT a finding: a decoy can only change what this untrusted text says, and it is inside `untrusted_content` with the shield either way. The Codex prompt's threat model says so from round 5. | Coordinator (same spirit as the 2026-10-23 walls decision). Ends the Word-visibility theme. |
| 2026-10-24 | **Receipts: deferred to the integration step.** Routing Office text through the normal read path (receipts, question search, section paging, the cache) means a new read kind across `pipeline.ts` (parse, cache, buildContent), `formflow.ts`, `resume.ts`, `safety.ts` (the page cap and the file decision) and `types.ts`; that is heavy work in shared files, so it is recorded here, not done on this track. Calendar files (.ics) already go through the normal read path, so they already have receipts, question search and paging; their structured `events` ride along on the first page. Suggested design for integration: when `inside` gives Office text, build a ParsedPage from its sections (headings as generated section labels) and serve it with `door_detail: "office"` like a PDF read, keeping the `file_warning` facts (kind, fingerprint, flags) in the reply. | Coordinator option 4: "if large or touching shared files heavily, record it". |
| 2026-10-24 | `PARSER_VERSION` stays 11 on this branch; the coordinator reconciles at merge. | Coordinator. |

## Open items

- ~~Office text is part of a `file_warning`, not a page read, until the integration step~~ Done at integration (2026-10-26): Office text has receipts, `section`/`page` paging and `question` search through `buildContent`, while the reply stays a `file_warning` (`src/filereply.ts` `officeContent`, `officePage`; tests at the end of `src/test/office.test.ts`). Not cached: each call downloads the file again. See SPEC.md section 9, 2026-10-26.
- `PARSER_VERSION` is 11 on this branch; other tracks may bump it too. Integration (2026-10-26): 11 everywhere; no other track bumped it.

### After Codex round 5 (all 11 findings fixed, under the coordinator's rules)

| Date | Decision | Why |
|---|---|---|
| 2026-10-24 | Office text needs a zip directory read to its end: past the 10,000-entry cap (`too_many_entries`, or a directory that stopped early) there is no text (`text_refused`). | #1 |
| 2026-10-24 | Relationship targets are used as written, with no percent-decoding; a target with a percent escape, a backslash, a query or a fragment names no part. | #2 |
| 2026-10-24 | An element with the `xmlns` prefix is malformed. | #3 |
| 2026-10-24 | Namespace obligations are checked over the whole part before it is used: after markup compatibility, every element and every prefixed attribute must be in a namespace Tiresias knows (the OOXML ones it reads, plus pictures, charts, diagrams, the drawing canvas, VML and Office's VML extensions, and Word's extension namespace) or one marked ignorable; otherwise the part is refused (`office_unreadable`). Extension lists (`extLst`) may hold any namespace. | #4 (fail closed, per the coordinator) |
| 2026-10-24 | Worksheet elements count only at their place in the grammar (`sheetData` under `worksheet`, rows, cells, values, inline strings, formulas, columns under `cols`); one found elsewhere is ignored and `unsupported_content`. | #5 |
| 2026-10-24 | Every selected child part must be typed for its role by its Override, or else the Default for its extension (shared strings, worksheets, slides); otherwise `ambiguous_package` and it is not read. Defaults typed twice differently are ambiguous. | #6 |
| 2026-10-24 | Skipped parts also include a sheet's drawings, comments and VML drawings, and a presentation's slide, notes and handout masters. | #7 |
| 2026-10-24 | A Word HYPERLINK field's destination is the first word that is neither a switch nor the argument of `\l`, `\o` or `\t`, quoted or not; a field with only a `\l` bookmark points inside the document and lists nothing. | #8 |
| 2026-10-24 | Zip entries: a PDF under a name that does not end in `.pdf` is `type_mismatch`; only a ZIP signature is refined by an Office, add-on or program name (any other archive stays an archive, with `type_mismatch`). | #9 |
| 2026-10-24 | Calendar parameters are comma-separated lists of quoted or plain items; RFC 6868 caret escapes (`^n`, `^^`, `^'`) are decoded; each item is searched for links on its own. | #10 |
| 2026-10-24 | Macro sheets are found by content type (`application/vnd.ms-excel.macrosheet+xml`, `intlmacrosheet`) and by relationship (`xlMacrosheet`, `xlIntlMacrosheet`, `vbaProject` in Microsoft's 2006 relationship namespace), wherever their parts are kept. | #11 |

### After Codex round 6 (all 8 findings fixed)

| Date | Decision | Why |
|---|---|---|
| 2026-10-24 | A ZIP64 locator before the end record is always read; when no classic field is at its maximum, the ZIP64 record must agree with the classic one, or `directory_mismatch`. | #1 |
| 2026-10-24 | General-purpose bit 5 (patch data) is `unsupported_method`: never sniffed, never read by `readEntry`. Bit 6 (strong encryption) counts as encrypted. | #2 |
| 2026-10-24 | Word fields that reach outside are listed: HYPERLINK, INCLUDETEXT, INCLUDEPICTURE and IMPORT by their first argument, LINK by its second; switches that take an argument skip it; a doubled backslash in a quoted path is one. Such a field with no destination found is `computed_links`. | #3 |
| 2026-10-24 | More than one shared-string table in a workbook is `ambiguous_package`: no text. | #4 |
| 2026-10-24 | Spreadsheet text keeps every row separator, leading empty rows included (only trailing white space is trimmed). | #5 |
| 2026-10-24 | Every calendar parameter item is searched for links (the content line's length bounds them). Each RDATE or EXDATE line keeps its own time zone: lines are joined with `;`, each as `TZID=<zone>:<values>` or `<values>` (the `rdate_tz`/`exdate_tz` fields are gone). | #6, #7 |
| 2026-10-24 | Test added for the 1,000-entry sniff limit. | #8 |

### After Codex round 7 (all 7 findings fixed)

| Date | Decision | Why |
|---|---|---|
| 2026-10-24 | ZIP64 reconciliation is per field: every classic field that is not at its maximum must equal its ZIP64 value. | #1 (round 6 #1's fix, made complete) |
| 2026-10-24 | Byte-order marks are never silently dropped: a leading U+FEFF in a zip name is kept (so it is `odd_name` and never matches another name), and after an XML part's one encoding mark, a second one is malformed. | #2 |
| 2026-10-24 | Indexes must be complete and unique: a slide without its own relationship id, or listed twice, and a sheet without its relationship id or sheet id, or with a repeated id, sheet id or name, make the index ambiguous: no text from that file. | #3 |
| 2026-10-24 | An unresolved HYPERLINK is `computed_links` unless it is a bookmark-only (`\l`) link; a field whose instruction holds another field is `checks_incomplete` and `computed_links`. | #4 |
| 2026-10-24 | A cut METHOD marks its calendar's events `cut`; a cut recurrence time zone marks its event `cut`. | #5 |
| 2026-10-24 | Date-typed cells (`t="d"`) are `raw_numbers` too (shown as stored). | #6 |
| 2026-10-24 | Test added: the macros flag by name survives when the file is not looked inside (over the inspect cap). | #7 |

### After Codex round 8 (all 6 findings fixed)

| Date | Decision | Why |
|---|---|---|
| 2026-10-24 | A second ZIP64 extra field in a directory record or a local header is `directory_mismatch` (readers differ on which one counts). | #1 |
| 2026-10-24 | Workbook defined names (`definedNames/definedName`) get the same DDE and HYPERLINK checks as cell formulas, within the same 10,000-character bound. | #2 |
| 2026-10-24 | Spreadsheet text escapes a cell's own tab, line feed, carriage return and backslash as `\t`, `\n`, `\r`, `\\`, since tabs and line breaks separate columns and rows. | #3 |
| 2026-10-24 | Calendar properties that may appear once (summary, start, end, duration, organizer, location, description, URL, UID, status, recurrence id, rule): a repeat is ignored whole, parameters included, and sets `events_malformed`. UID is a TEXT value: escapes decoded. | #4, #5 |
| 2026-10-24 | Tests added: a DOS folder attribute (host 0, bit 0x10), and the 1 KiB compressed-input bound of the sniff. | #6 |

### After Codex round 9 (all 6 findings fixed)

| Date | Decision | Why |
|---|---|---|
| 2026-10-24 | A relationship part must be typed `application/vnd.openxmlformats-package.relationships+xml` (its Override, else the Default for `.rels`), or it names nothing (`ambiguous_package`). | #1 |
| 2026-10-24 | Relationship ids must be XML identifiers (NCName); `TargetMode` must be absent, `Internal` or `External`, exactly; anything else makes the part ambiguous. | #2 |
| 2026-10-24 | The namespace exemption applies only below a real extension: an `ext` directly inside an `extLst` of DrawingML, PresentationML or SpreadsheetML. A container merely named extLst exempts nothing (and an unknown namespace below it refuses the part). | #3 |
| 2026-10-24 | Rows out of order or repeated, cells out of order or repeated, and a cell reference naming another row are `positions_inconsistent` (they are placed where they came in the file). | #4 |
| 2026-10-24 | Calendar ORGANIZER and ATTENDEE values (and any `VALUE=URI` value) are taken whole as URIs, punctuation kept. | #5 |
| 2026-10-24 | Tests added: a second ZIP64 field in a local header; the outside-link reply budget in UTF-8 bytes with its omitted count. | #6 |

### After Codex round 10 (all 6 findings fixed)

| Date | Decision | Why |
|---|---|---|
| 2026-10-24 | Every append to spreadsheet text, row gaps and row ends included, counts against the text bound. | #1 |
| 2026-10-24 | Extensions, made airtight: a DrawingML, PresentationML or SpreadsheetML `extLst` must sit directly inside an element of its own namespace, and hold only `ext` elements of that namespace; `ext` content is opaque (skipped whole, never text, any namespace allowed inside). Anything else is malformed structure and refuses the part. (Round 9's path exemption is gone.) | #2 (round 9 #3, closed by design) |
| 2026-10-24 | A relationship must have a non-empty `Target`, or its part is ambiguous. | #3 |
| 2026-10-24 | RD and DATABASE fields (outside documents and data sources Tiresias does not resolve) are `checks_incomplete` and `computed_links`; INCLUDE (the old name of INCLUDETEXT) is listed like INCLUDETEXT. A field instruction is read whole (at most 10,000 characters), with no separate word limit. | #4, #5 |
| 2026-10-24 | A calendar parameter without a value, or given twice on one line, makes the line malformed (skipped, `events_malformed`). | #6 |

### After Codex round 11 (all 5 findings fixed)

| Date | Decision | Why |
|---|---|---|
| 2026-10-24 | Text elements of the accepted subset must sit under their own parents, checked over the whole part before it is used. Word: `w:t`, tabs, breaks, hyphens, symbols, field marks and instructions under `w:r`; `w:r` under a paragraph, hyperlink, smart tag, content control, insertion, deletion, move, simple field, custom XML, bidi/dir, or ruby; `w:p` under the body, a table cell, a content control, a text box, custom XML, or a header/footer/note/comment root; `m:t` under `m:r`, `m:r` under a math element. PowerPoint: `a:t` under `a:r` or `a:fld`; those and `a:br` under `a:p`; `a:p` under a text body; `p:txBody` under `p:sp`. Anything else refuses the part (`office_unreadable`). | #1 (fail closed, per the coordinator) |
| 2026-10-24 | Workbook data connections (web queries, outside data sources) are named as skipped and make the link check `checks_incomplete`. | #2 |
| 2026-10-24 | A Word field's saved result is `cached_results` too (the flag's text now covers formulas and fields). | #3 |
| 2026-10-24 | Only XML 1.0 declarations are accepted (XML 1.1 has other character and line-end rules). | #4 |
| 2026-10-24 | Calendar: a second METHOD in one calendar object, or an event with both DTEND and DURATION (the end is kept, the duration dropped), sets `events_malformed`. | #5 |

### After Codex round 12 (all 4 findings fixed)

| Date | Decision | Why |
|---|---|---|
| 2026-10-24 | The accepted cell grammar is checked over the whole sheet before it is used: a cell holds at most one value, one formula and one inline string; an inline-string cell holds exactly one inline string and no value; no other cell holds an inline string. Anything else refuses the sheet (`office_unreadable`). | #1 (fail closed) |
| 2026-10-24 | A slide field's saved text (`a:fld`: dates, slide numbers) is `cached_results`. | #2 |
| 2026-10-24 | OOXML `_xHHHH_` escapes are decoded per text element, in shared and inline strings, never across runs. | #3 |
| 2026-10-24 | A local name (or local Unicode name) that differs from the directory's gets the same path and kind checks; the riskier kind counts. | #4 |

### After Codex round 13 (all 4 findings fixed)

| Date | Decision | Why |
|---|---|---|
| 2026-10-24 | Worksheet placement is now part of the whole-sheet check: any element Tiresias reads (`sheetData`, `cols/col`, `row`, `c`, `v`, `f`, `is`, `r`, `t`, `rPh`) outside its place in the worksheet grammar refuses the sheet (it was skipped and flagged before); an inline-string cell may hold its inline string only (no formula either). | #1 |
| 2026-10-24 | WEBSERVICE and IMAGE formulas are listed by their first argument like HYPERLINK (computed ones counted as `computed_links`); RTD (a real-time data server) is `checks_incomplete` and `computed_links`. | #2 |
| 2026-10-24 | HYPERLINK's `\m` (an image map) takes no argument. | #3 |
| 2026-10-24 | Test added: a local Unicode name gets the path and kind checks. | #4 |

## Stopped again (2026-10-25, after round 13)

The coordinator's rule after the Office decisions: stop and report if a finding survives two more fixes. **Worksheet structure** did: round 5 #5 (exact element places, fixed), round 12 #1 (cell cardinality and types, fixed), round 13 #1 (inline-string cells with formulas, and misplaced elements only skipped, fixed). Each round Codex named one more constraint of the SpreadsheetML cell grammar. All are fixed and the sheet check now refuses on any placement or cardinality error, but it is a hand-picked subset of the schema, not a schema validator.

Trend: findings per round went 21, 18, 15, 12, 11, 8, 7, 6, 6, 6, 5, 4, 4; no HIGH in any round. Round 13's fixes are not yet re-reviewed by Codex. The coordinator's merged-branch review covers them. Options for the coordinator: accept the current worksheet check as the supported subset (anything outside it is refused); or narrow Excel further (for example shared strings only, no cell structure); or continue the loop past the rule.

### After Codex round 14 (all 3 findings fixed)

| Date | Decision | Why |
|---|---|---|
| 2026-10-24 | Excel is now a whitelist grammar, checked whole before use: below `sheetData` and in the shared-string table every parent has a fixed set of allowed children (`sheetData`>`row`>`c`>`f`/`v`/`is`; `is`/`si`>`t`/`r`/`rPh`/`phoneticPr`; `r`>`rPr`/`t`; `rPr`> run formatting; `rPh`>`t`; `extLst` only where the schema puts it, its `ext` opaque); `v`, `f`, `t` and formatting are leaves (nothing nested). A string is one `t`, or one or more `r` each with exactly one `t`, never both. A sheet outside this is refused; a shared-string table outside it gives no strings (cells using them are `unresolved_cells`). | #1 |
| 2026-10-24 | A misplaced slide or sheet declaration makes the whole index ambiguous: the presentation or workbook gives no text (it was skipped before). | #2 |
| 2026-10-24 | The stored file record (receipts log) carries the warning's final flags, `macros` included. | #3 |

## Stopped (2026-10-26, after round 14)

The coordinator's guard: stop if a finding survives two fixes. **Excel structure** did: round 12 #1 (cell cardinality), round 13 #1 (inline cells, misplaced elements), round 14 #1 (leaf contents, string grammar). Round 14 replaces the hand-picked checks with a full parent-to-children whitelist for everything Tiresias reads in a sheet and the shared-string table, which closes the class as far as this design can; it has not yet been re-reviewed. Findings per round: 21, 18, 15, 12, 11, 8, 7, 6, 6, 6, 5, 4, 4, 3; no HIGH in any round.

## Deferred to compute-day sweep

Round 15 (2026-10-26) found no HIGH. Per Travis (via the coordinator, 2026-10-26: save usage), its MEDIUM and LOW findings are not fixed now; no round 16 was run, and the planned Excel narrowing (shared strings only, `office_partial`) was not done.

| Round | Severity | Summary | File |
|---|---|---|---|
| 15 | MEDIUM | Structure validation checks child names but not container cardinality or order: two `sheetData` in a worksheet, or two `body` in a Word document, are accepted and their text concatenated instead of refusing the part. (Same theme as rounds 12 to 14; the coordinator's fallback was to narrow Excel to the shared-strings table.) | `src/office.ts` (`cellsValid`, `grammarFor`, Word `parse`) |
| 15 | LOW | Tests do not pin the whole-entry decompression cap: the lying-size tests accept any refusal; they should require `too_large` / `part_too_large`, so removing `maxOutputLength` would fail them. | `src/test/zip.test.ts`, `src/test/office.test.ts` (cap in `src/zipread.ts` `readEntry`) |
