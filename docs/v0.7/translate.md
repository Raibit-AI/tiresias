# v0.7 Track 3: translate (W-26)

Branch `v0.7`, from `bf59d22` (the paused render plan on top of v0.6.1, 802 tests passing). Decisions for the coordinator to fold into SPEC.md. Kept away from rendering (track 1): no change to the fetcher or the render plan; the touch points in shared files are listed at the end for the merge.

## Progress

- [x] Read SPEC (principles, section 5, W-26, N-02, W-21 and its decisions), the v0.6 plans and the render plan
- [x] This plan
- [x] `src/lang.ts`: the detector (scripts, then common words per block), no dependency
- [x] Detection on every read: HTML, markdown, text, JSON, feeds, PDFs, saved pages, form answers, Office text; `language` in the reply, the cache entry (`parsed.language`) and history (`lang`); the declared language checked against the text
- [x] Shield: phrases aimed at AI in 13 languages, picked by the scripts of each scanned text
- [x] `src/translate.ts` + `hookrunner.ts` output cap: the owner's translation hook (`translator` in config.json, `tiresias translator set|show|off`, listed in `tiresias settings`)
- [x] `read` with `translate` (MCP and CLI `--translate`): the hook's text in `untrusted_content.translation`, receipts still quote the original
- [x] Tests (`src/test/lang.test.ts`, `src/test/translate.test.ts`): 9 new; 802 before, 811 after
- [x] README, CHANGELOG (unreleased v0.7.0), SPEC W-26 row
- [x] Codex review loop: round 1 (`docs/reviews/2026-10-31-v07-translate-round-1.md`): HIGH 0, MEDIUM 0, LOW 1 (deferred below). No HIGH, so the loop ends at round 1.
- [x] Full suite 811 of 811 passing, 0 skipped; pushed `v0.7`, reported to Banks

## Design calls (with reasons)

### Detection

- **No dependency.** `src/lang.ts`, about 300 lines: Unicode script counts, then common-word profiles for the seven Latin-script languages. The thirteen languages: English, Spanish, French, German, Portuguese, Italian, Dutch, Russian, Chinese, Japanese, Korean, Arabic, Hindi. Anything else is reported as the nearest of these with low confidence, or `unknown`.
- **Per block, then summed.** The text is cut into its blocks (paragraphs, headings, the title; at most 64 KB of text sampled in page order). Each block of at least 20 letters gets a language of its own (script first; for Latin script, the language whose common words it uses most, accents as a tie-breaker), weighted by its letters. The page's language is the heaviest one. Why: one pass over the whole text would let a long English navigation drown a Spanish article, and mixed pages are the case the shield cares about.
- **Script decides where it can.** Hangul is Korean; kana (with or without Han) is Japanese; Han without kana is Chinese; Cyrillic is reported as Russian, Arabic script as Arabic, Devanagari as Hindi (the closest of the thirteen; confidence says how sure).
- **Reply:** top-level `language: { code, confidence, also?, declared? }`. `code` is a BCP 47 primary subtag from the fixed list, or `"unknown"` (under 20 letters, or no block could be placed); `confidence` is 0 to 1 with two decimals (the share of the text in that language times how clear its blocks were); `also` lists the other languages that hold at least 10% of the text (at most 4). Every value is made by Tiresias from a fixed list, so it sits at the top level.
- **The page's own declaration is a hint only.** `<html lang>` (or the first `lang` the reader keeps) and the `Content-Language` header, when present, go inside `untrusted_content.declared_language` (cut at 64). `language.declared` is `matches`, `differs` or `not_a_language` (not a tag we can read). When the text is clear (confidence 0.5 or more), the text wins and a `differs` adds a fixed sentence to the message. When the text is not clear but its script fits the declared language (for example a short Latin-script page declared `es`), the declared language is taken, with confidence 0.5 at most: it only breaks a tie the text could not.
- **Everywhere a page is read:** the worker sets `parsed.language` after every parse (HTML, markdown, text, JSON, feeds, SVG, scripts, CSV, calendars, contacts) and the PDF child after a PDF; Office text gets it on the main thread from its sections. So the reply of `read`, `check`'s cached copy, `resume` (retry or a saved page), a `form_submit` answer, a tab, and a file warning with Office text all carry it. `PARSER_VERSION` goes to 12 so older cache entries are re-read once and gain the field.
- **Cache and history:** the cache keeps it inside `parsed` (no new file). History records `lang` (the code, fixed list only; anything else is dropped and the record says `cut`). Tabs check it against the fixed list like the other top-level values from a cached copy.
- **Bounded:** at most 64 KB of text and 4,000 blocks are looked at; the word pass is linear; detection of a page runs in the worker under the parse time budget, like the parse itself.

### Shield (N-02)

- Phrase lists for all thirteen languages (ignore / disregard / forget the previous instructions, system prompt, new instructions, "you are now"), in `src/shieldphrases.ts`.
- **Which lists run on a scanned text is decided by its own scripts, every time the shield scans** (each block, heading, comment, hidden text, attribute): Latin script runs the seven Latin-script lists (English always), Cyrillic runs Russian, Arabic script Arabic, Devanagari Hindi, Hangul Korean, kana Japanese, Han Chinese and Japanese. Why not the page's detected language: the shield scans each piece as the reader meets it, before the page's language is known, and an attack in Spanish hidden in an English page is exactly the mixed case; deciding per piece checks every language found, piece by piece. Word profiles are not used for the choice because a one-line hidden instruction is too short to place reliably, and running all seven Latin lists on Latin text costs little.
- Latin-script lists match on the text with accents removed as well, so "ignora las instrucciones" and "ignorá lás instrucciónes" both match. Spaces in a phrase match any run of white space.
- A non-English match says which language in the flag's `detail` (`visible text; phrase in es`), inside `untrusted_content.flag_details` as before. The flag type is the same `ai_directed_instruction`.

### Translation hook (built like W-21)

- **Owner only.** `config.json` key `translator: { command: [full path, ...args], timeout_seconds (1 to 60, default 20) }`, set with `tiresias translator set [--timeout N] -- <full path> [args...]`, `translator show`, `translator off`, or by editing the file; listed in `tiresias settings`. Same checks as the scanner: a full path, no `..`, at most 31 arguments, no control characters, the program must exist when set; refused in private mode. No MCP tool reads, sets or changes it.
- **What an agent can do:** only ask, per read, for a translation into one language: MCP `read` with `translate: "<language>"`, CLI `read --translate <language>`. The language must be a plain BCP 47 tag (`^[a-z]{2,3}(-[a-z0-9]{2,8}){0,2}$`, case-folded, at most 20 characters), so the argument handed to the owner's command can never look like an option or carry anything else.
- **The run:** the command is run directly through `hookrunner.ts` (no shell, its own process group, killed whole at the time cap, on cancellation, or when Tiresias is gone), as `<command> [args...] <source> <target>`, where `<source>` is the detected language code (or `und` when unknown) and `<target>` the asked one. Standard input: the text this reply shows (the title and, for an outline, each heading and preview; for a section, its text; for a question, the passages), plain UTF-8, at most 32 KB (cut on a character boundary; the reply says `input_cut`). Standard output: at most 64 KB, UTF-8 (invalid bytes replaced), used as the translation. Standard error is ignored.
- **Failure is not an error:** the page is returned as always, with top-level `translation: { status, by, from, to, reason? }`. `status` is `ok`, `failed`, `skipped` or `unavailable`; `reason` one of `not_set`, `bad_setting`, `missing_command`, `timeout`, `too_large`, `exit_code`, `empty`, `cancelled`, `same_language`, `nothing_to_translate`, `unsupported_platform` (no hooks on Windows, as for the scanner).
- **Untrusted, labelled, never quoted:** the hook's text goes inside `untrusted_content.translation: { text, note }`, the note a fixed sentence: a machine translation by the owner's tool of the text above, not the page's own words; receipts quote the original. Receipts are built before the hook runs and never include the translation, and the translation is never cached, never written to history or receipts, and never scanned into the page's flags (it is not the page's words). The reply's size guard drops `translation` first when the reply is over its limit.
- **Private mode:** the hook still runs when asked (it is the owner's own tool, as with the scanner), nothing about it is kept.
- **Not on tabs, check or watch:** only `read`. An agent that wants a translation of a tab reads the page again (cheap: it is cached).

## Deferred to compute-day sweep

| Round | Severity | Summary | File |
|---|---|---|---|
| 1 | LOW | A read that ends in a file warning with Office text ignores `translate` (no translation, no `translation` status). Run the hook after the Office reply's final size and receipt filtering, on reads only, with `shownText` also collecting `untrusted_content.inside` text. | `src/filereply.ts`, `src/pipeline.ts`, `src/translate.ts` |

## Files touched outside the new modules (for the merge)

New: `src/lang.ts` (detector, `stampLanguage`), `src/shieldphrases.ts` (phrase lists), `src/hook.ts` (the one runner client, split out of `scanner.ts`), `src/translate.ts` (hook, `translator set|show|off`), tests `src/test/lang.test.ts`, `src/test/translate.test.ts`.

Touched (small, additive):
- `src/types.ts`: `PARSER_VERSION` 12, `ParsedPage.language`, `Envelope.language` and `Envelope.translation`.
- `src/work.ts`: `lang` on parse and PDF jobs, `parsed.language` set after each parse.
- `src/pipeline.ts`: `parseJob`/`parsePage` take the Content-Language header; `finishPage` stamps the language (`withCache`), counts `translate` as asking for content, and runs `translateReply` on a read. Re-exports `stampLanguage`. (Rendering will also touch `run`; the changes here are at the parse call and in `finishPage` only.)
- `src/envelope.ts`: `Opts.translate`; history gets `lang`.
- `src/history.ts`: `lang` field, checked against the fixed list.
- `src/shield.ts`: English list moved to `shieldphrases.ts`; `scan` also runs the other languages.
- `src/scanner.ts`: `runScanner` uses `hook.ts` (same behavior); `src/hookrunner.ts` takes an optional `max=<bytes>` before the program.
- `src/config.ts`: `translator` key (`parseTranslator`, `loadTranslator`), checked only where used.
- `src/settings.ts`: the `translator` row.
- `src/formflow.ts`, `src/tabs.ts`, `src/filereply.ts`: `stampLanguage` on a form answer, a tab, and Office text.
- `src/mcp.ts`: `translate` on `read` (schema-checked tag). `src/cli.ts`: `read --translate`, `translator set|show|off`, the text summary lines.
