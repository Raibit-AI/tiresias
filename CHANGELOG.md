# Changelog

Built from docs/SPEC.md, section 10, which has the full detail of every version.

## v1.1.0 (2026-11-10)

The security deep dive. Every promise in SECURITY.md was attacked end to end, the way a hostile page or a fooled agent would, and each finding was fixed with a test or written down as a known limit in SECURITY.md.

For owners:

- Four new settings, shown in `tiresias settings`. `get_form_actions` is `read` by default; `slip` makes reading an address that matches a known GET form action need a `submit_form` slip. `private_spacing` is `shared` by default, so private calls and previews now wait their turn across processes and write only the site's origin and times; `none` turns that off after confirmation. `hook_secrets` is `hidden` by default, so your scanner and translator hooks no longer receive Tiresias's own secret variables; `inherit` restores the old behavior after confirmation. `text_views` is `marked` by default, so `--text` views and the default `log` and `needs` output mark where web text begins; `wrapped` wraps it the way JSON output does.
- `tiresias keys rotate` gives you a new signing key while the old one stays in the directory for 7 days (`--overlap` 0 to 30). `--finish` ends the overlap early. `--slips` makes a new slip key and revokes every slip.
- SECURITY.md states the form promise as the code keeps it: no form is sent without your permission slip, and recognizing sign-in, payment and purchase forms is best-effort in 13 languages.

Forms:

- Purchase forms without card fields ("Pay now", checkout) and sign-in forms without a password field are now recognized and refused. Recognition is by word lists in English, Spanish, French, German, Portuguese, Italian, Dutch, Russian, Chinese, Japanese, Korean, Arabic and Hindi.
- A slip is checked again right before the form is sent. One that expired or was revoked while the submit waited is not used.
- A rendered page's scripts may not request an address that matches a GET form action on that page.

The site's rules:

- A robots.txt redirect to another site is followed only to that site's own `/robots.txt`. Anything else counts as the site saying no.
- Retry-After on a redirect is obeyed before the redirect is followed, for pages, robots.txt and rendered requests.
- A Crawl-delay longer than 30 seconds is no longer shortened to 30: Tiresias declines the read instead of waiting less than the site asked. When robots groups merge, the longest delay applies.
- An active Retry-After wait is not forgotten however large the cooldown log grows. If the wait cannot be read, Tiresias does not send.

Web text stays data:

- Machine translations are scanned by the injection shield. Flags stay with the reply, with snippets inside `untrusted_content`, and survive a translation dropped for size.
- A bookmark name chosen by an agent appears inside `untrusted_content` in `watch` replies, not beside Tiresias's own fields.
- Text an agent supplies to `resume` over MCP is recorded as provided by the agent, not by a person.

Secrets, files and limits:

- The Google Web Risk request gets the same private-address and port checks as every other request.
- The PDF child process may no longer start worker threads.
- Calendar files are always read in a worker thread with a time budget, whatever their size.
- A secret the site echoes back is looked for in the full text of an Office answer or a PDF title before anything is shortened.
- A page whose outline would take too long to build ends as `page_too_complex` instead of stalling other calls.
- Requests waiting during a render keep only a bounded set of header fields in memory.
- History and receipt scans stop on cancellation or at a 60 second deadline.

Testing and releases:

- An attack lab of hostile pages runs in the test suite, so every attack tried in this review stays tested.
- The fuzzer (`scripts/fuzz.mjs`, opt-in) gained two targets that drive the real MCP server and the form flow with malformed input.
- Releases are built by GitHub Actions and staged on npm through trusted publishing, with provenance and a software bill of materials. A person approves each staged version before anyone can install it, and no npm token is stored anywhere.

## v1.0.1 (2026-11-01)

- Cancelling a read while it waits its turn no longer adds extra delays to later requests.
- An unexpected robots.txt “not modified” response is retried once; browsing stops if it answers “not modified” again without providing rules.
- Malformed Retry-After headers keep the normal fallback cooldown.
- Relative HTML links follow the page's first base URL; receipts still name the page that was read.
- Rendered text with many lines stays readable when its final lines are visible. Incomplete geometry is reported as a partial inspection.
- Emoji and other Unicode characters remain intact when text is split into blocks.
- Large plain-format reads report how much text was omitted.
- Cached pages honor the current rendering setting and each read's rendering request.
- Markdown alternatives keep the original URL's query parameters.
- Office text is withheld with its receipts when the reply cannot fit both.
- Known archive signatures keep their archive warning even when the filename claims to be an Office document or application.
- Concurrent page saves cannot exceed the snapshot cap or push out earlier evidence.
- Replacing site restrictions no longer breaks unrelated browsing while confirmed restrictions are retained.
- Active calls keep their starting settings, including their scanner and translator hooks.
- Listing settings in private mode creates nothing and leaves folder permissions alone.
- Resuming a handoff works when an unrelated storage limit is invalid.
- History keeps questions up to 1,000 characters, marks longer cuts, and keeps questions that differ after character 500 separate in the needs report.

## v1.0.0 (2026-11-01)

The first public release. Tiresias is a browser for AI agents with no screen: your agent calls it over MCP (or you run it from the command line), it reads a page into a short outline with numbered links, answers questions with exact quotes and receipts, and says honestly who is calling. It obeys robots.txt and every request to wait, stops at a CAPTCHA, a bot check or a login and hands the page to you, and runs on your machine under your keys, with no account and no telemetry. macOS and Linux; Windows is not supported yet.

What the versions before it built, in one place:

- **Reading (v0.1, v0.5.1).** Outline first, then one section or the best quoted passages, in pages that fit a context window; markdown asked for first, `llms.txt` and `llms-full.txt` used, MCP servers, API specs and feeds reported. Every quote has a receipt. Page content always sits inside `untrusted_content`; hidden text, invisible characters and instructions aimed at an AI are flagged.
- **Honest by default (v0.1, v0.2).** A plain user agent, robots.txt, Crawl-delay and Retry-After on every request, one second between requests to a site, and optional Web Bot Auth signing of every request with your own key. Raibit's own copy is verified by Cloudflare (2026-11-01).
- **Memory (v0.3).** What changed since the last visit, a cache shared by every agent on the machine, bookmarks and a watchlist, a needs report, a hand-off ticket to resume a read after a person clears a wall, and a phishing check before every fetch (optionally Google Web Risk with your own key).
- **Permission (v0.4).** Profiles, and forms sent only with a permission slip you grant at a terminal; login, password, CAPTCHA and payment forms are never sent.
- **Files (v0.5, v0.6).** A file is named by its first bytes and comes back as a warning with its fingerprint, never run; zip listings, Office text and calendar invites are read in memory; your own virus checker can be plugged in. Tabs, a downloads shelf, per-site settings and a settings page.
- **JavaScript pages and languages (v0.7).** Rendering in the Google Chrome you already have, off until you allow it, with every request the page makes fetched under Tiresias's rules; walls and hidden text judged by what the browser shows; the language of every read; your own translator.
- **Proof (v0.8).** Signed snapshots of exactly what a read received, and free Bitcoin timestamps (OpenTimestamps) that prove a receipt existed then and was not edited.
- **Hardening (v0.9, v0.9.1).** Risky settings take an all-caps confirmation phrase and are logged; a security audit, a fuzz script, a memory ceiling for the MCP server and an optional Docker box; then every deferred finding from the reviews closed, so v1.0 ships with no known bug.

In this release: the docs were rewritten for a first-time reader (README, QUICKSTART, SECURITY.md, and a new docs/DEMO.md with real output), the install is `npm install -g @raibitsi/tiresias`, two failures seen only on Linux were fixed (the anchor's receipt cursor after a file is written again under the same inode; a test whose waits ended during a slow run), and two refusal texts no longer say "v0.x". The key directory signing guidance now covers live signing, which Cloudflare asks for.

**Upgrading from v0.8:** if you had turned on saving, rendering or anchoring, each is held off after the upgrade until you confirm it once, with whichever of these apply:

```
tiresias settings confirm saving --confirm "YES, TURN ON SAVING"
tiresias settings confirm rendering --confirm "YES, TURN ON RENDERING"
tiresias settings confirm anchoring --confirm "YES, TURN ON ANCHORING"
```

(`rendering` at `auto` takes `"YES, TURN ON AUTOMATIC RENDERING"`.) The first reply after the upgrade lists what is waiting, `tiresias mcp` prints it on standard error at start, and `tiresias settings` shows it. Upgrading from v0.9.x needs nothing.

## v0.9.1 (2026-10-31)

The pre-v1.0 sweep. Every MEDIUM and LOW finding deferred from v0.7.0, v0.8.0 and v0.9.0 (67 in all) was closed: 64 fixed, each with a test that fails without the fix, and 3 designed away (the behavior decided and written down). Two of them were decided by Travis: on a rendered page, text with `pointer-events: none` that cannot be measured for clipping now makes the inspection partial so the HTML checks also run; and any background image or gradient counts as covering the text under it (it can flag text under a see-through decorative layer, but never shows hidden text). Google Web Risk lookups stay exempt from site spacing (they are calls to Google, not site visits). Codex wrote the fixes and Claude reviewed each one; then Codex reviewed the whole sweep until a round came back clean. The full list is in SPEC.md, section 10, v0.9.1.

What you may notice:

- **`tiresias mcp` now tells you on standard error when a setting is held back.** If config.json turns on a risky setting that has not been confirmed (the usual case after upgrading from v0.8 with saving, rendering or anchoring on), the server prints one line at start with the exact `tiresias settings confirm ... --confirm '...'` command for each. Your AI app usually keeps that in its MCP server log.
- **Rendered pages:** walls and hidden text are judged more exactly (text in `display: contents` wrappers, dark-scheme pages, `color()` and `oklch()` colours, `xmp` and `textarea` text, page elements named like browser built-ins, CAPTCHA and password boxes past the first 2,000 candidates). A failed render keeps the last good rendered copy; an explicit `render` renders again unless a rendered copy is still fresh by the site's own caching rules (`fresh: true` always renders again); cached rendered replies keep their walls and hidden-text codes; a redirected script or style is handed to Chrome as a redirect; a large fixed layer above the text gets its own overlay note.
- **Save page and receipts:** a snapshot is never written that `saved verify` would refuse; quotes containing NUL and pages with odd characters verify; Office receipts name their snapshot; `clear` counts what it really removed. A failed `saved verify` or `receipts verify` now prints `status: "error"` with `reason: "verification_failed"` on standard error (exit codes unchanged).
- **Anchoring:** a bad answer from one calendar can no longer spoil a batch another calendar served well; calendars' Retry-After is honored; very large stores keep every batch searchable and resume long scans; `receipts prove --out` cleans up after itself on failure.
- **Confirmations:** every reply path carries the settings notice; a 24-hour notice is never cut short; always-allowed ports and the default spacing no longer ask for a phrase; `scanner off` and `translator off` work while `sites` is broken; suggested commands put `--confirm` in the right place.
- **Reading:** markdown code keeps its indentation; very deep pages and lists stay within the time budget; an unsolicited "not modified" answer is never served from an older parse; a JavaScript-only page read without rendering says so; `resume` keeps `render` and `translate`; a cancelled read writes nothing; `history --text` and `receipts --text` start with a count line. The parser version is 14, so a page cached by the older reader is parsed again once.
- **pdf.js's native canvas add-on** that an `npm install -g` puts on disk stays unbundled on purpose (it is never loaded; bundling would tie outside security fixes to Tiresias releases). README says so.

## v0.9.0 (2026-10-31)

Risky settings need confirmation (W-32). Turning a risky setting on or looser (`saving`, `rendering`, `translator`, `scanner` with `--send-file`, `anchoring`, `anchor_calendars`, `safe_browsing` off, and per site more `ports`, lower `spacing_seconds`, `never_visit` or `hand_off` off) takes an exact all-caps phrase naming it, passed as `--confirm` (for example `--confirm "YES, TURN ON SAVING"`); a wrong or missing phrase changes nothing and prints the phrase. Turning things off or stricter never asks. Each change is recorded in history and the daily log with who made it (a terminal or not, best effort), and CLI and MCP replies carry `settings_notice` for 24 hours. A hand edit of `config.json` that loosens is not in force until confirmed (`tiresias settings confirm`); the last confirmed state lives in `confirmations.json`, and no record means the safe defaults (an owner upgrading from v0.8 with a risky setting on confirms it once). `TIRESIAS_RENDERING`, `TIRESIAS_SAFE_BROWSING=0` and `TIRESIAS_ALLOW_PORTS` loosen only with their phrase in `TIRESIAS_CONFIRM`. `tiresias settings confirmations off|on` (each with its own phrase) stops or resumes the asking; `tiresias settings` shows the state. MCP still cannot read or change any setting. It stops accidents and casual page-text tricks, not a fully fooled agent; the log makes that visible. Full record: `docs/v0.9/confirm.md`.

**Upgrading from v0.8:** if you had turned on saving, rendering or anchoring, each is held off after the upgrade until you confirm it once. Run whichever apply:

```
tiresias settings confirm saving --confirm "YES, TURN ON SAVING"
tiresias settings confirm rendering --confirm "YES, TURN ON RENDERING"
tiresias settings confirm anchoring --confirm "YES, TURN ON ANCHORING"
```

(If you had `rendering` at `auto`, its phrase is `"YES, TURN ON AUTOMATIC RENDERING"`.) Until then the first reply after the upgrade, CLI or MCP, lists each held-off setting with its exact command, and `tiresias settings` shows what is waiting. If you use Tiresias only through an AI app, run `tiresias settings` once at a terminal after upgrading, since the notice reaches you only if the agent passes it on.

Hardening audit of the whole codebase as it will be published. A `SECURITY.md` threat model; SPDX license headers; `npm audit` fixes under the MCP SDK; an opt-in fuzz script (`npm run fuzz`). Fixed, each with a test: a `Content-Encoding` Tiresias does not decode now fails the request (a compressed robots.txt used to read as "no rules"); a robots.txt that is not text, any 2xx answer, a 206, and rules that write `*` or `$` as `%2A` / `%24` are all honored (unreadable means the site says no); the daily log is bounded; CLI `receipts` and `history` put their records inside `untrusted_content`, as MCP does; one MCP server runs at most 8 tool calls, 4 parser workers and 2 renders at once, with fixed-text refusals past their queues; the MCP message boundary caps arguments (1,000 elements, 8 MB) and open requests (64), pauses reading while output backs up, and never repeats a caller's text outside the envelope; bad dates get fixed texts; the in-process cooldown list is bounded (at most 10,000 waits by name, the rest in a fixed 8 MiB keyed store that never forgets or shortens a wait). README and SECURITY.md wording that overclaimed was corrected. Full record: `docs/v0.9/hardening.md`.

The MCP client is trusted, the server has a memory ceiling, and Docker is optional (W-33). The AI app that starts `tiresias mcp` is now trusted not to flood its own server (SECURITY.md says so; every limit stays). `tiresias mcp` runs the server under its own memory ceiling, `TIRESIAS_MEMORY_MB` (default 1024 MB, `off` to skip): at the ceiling it stops with a clear line on standard error and a "Server stopped" line in the daily log, and the app can start it again. A `Dockerfile` (official Node 22 slim image pinned by digest, non-root, rendering off) and `docs/docker.md` give advanced owners a hard box with memory, CPU and process limits and a read-only file system; same commands, same store. v1.0 will support macOS and Linux; Windows is not yet supported. Full record: `docs/v0.9/client-trust.md`.

A site's echo of a secret is withheld, not masked. When the answer to a sent form repeats a hidden value or a cookie the site set for that call (6 characters or more), Tiresias now withholds the whole answer (`form.reason: "secret_withheld"`, the HTTP status and size only) instead of masking it as `[hidden value]`. The answer is checked once as received, with HTML, percent and JSON escapes decoded and case, quotes and spaces ignored, and again before anything from it is recorded. `counts.receipts_withheld` is gone. Best effort, stated in SECURITY.md: an echo in an encoding Tiresias does not decode is not caught.

Private launch rehearsal: a newcomer's first hour, end to end (an npm tarball installed into a temporary prefix, a fresh home, the README followed literally, MCP through Claude Code and a small client, rendering, saving, anchoring against a local calendar, slips and forms, the upgrade from a v0.8 store, and the unhappy paths). Fixed what tripped them up: a label Tiresias makes, `(top of page)` and `(structured data)`, is no longer quoted in a receipt as if the page said it; `receipts --url https://example.com` finds what was recorded as `https://example.com/`; an older Node, a mistyped option, an address with no `https://`, a store folder that cannot be written and being offline each get a plain message saying what to do (the store one used to say "internal error"); `--text` prints a page read's receipt count instead of every receipt as JSON, and says so when a listing is empty; hints that name a risky setting now carry its phrase; `--help` starts with the first command to try. The README's Claude Code line uses `--scope user`, and states that an npm install puts pdf.js's optional native add-on on disk, where the PDF child's permission model keeps it from loading. New `docs/QUICKSTART.md` (shipped in the package). The recurring render flake under full-suite load (the first render of a test file starting Chrome cold under a shortened limit) is fixed in the tests. The parser version is 13, so a page cached by the older reader is parsed again. Full record: `docs/v0.9/rehearsal.md`.

## v0.8.0 (2026-10-31)

Save page (W-28) and tamper-proof receipts (W-08). With the owner's new `saving` setting at `ask` (default `off`; owner only, never through MCP or an environment variable), `read --save` and the MCP read's `save` keep a snapshot in the profile's `saved/` folder: the bytes the read received (after transfer framing and Content-Encoding, before charset decoding) and, for a rendered read, the rendered HTML, with a `manifest.json` signed by the profile's slip key. The snapshot's id is the SHA-256 of the manifest's facts; every receipt of that read carries it as `snapshot`. `tiresias saved` lists, shows, verifies (re-hash, signature, and each receipt's quote found in the saved bytes by the same reader steps) and deletes snapshots. A save always fetches; private mode, `no-store` pages, walls and errors save nothing; a file warning saves only its fingerprint. Caps: `max_saved_mb` (100) and 1,000 snapshots, a save over them is refused, never evicting; `keep_saved_days` (90) through `clear` and the daily trim. Full record: `docs/v0.8/save.md`. And with the owner's new `anchoring` setting `on` (default `off`; owner only, never through MCP or an environment variable), `tiresias anchor` timestamps the fingerprints of new receipt records and saved snapshots through OpenTimestamps (free, Bitcoin-backed, no wallet or account): one Merkle tree per batch over salted leaves in a random order, and only its root sent to the calendars (`anchor_calendars`, default the four public ones), through Tiresias's own fetcher. `anchor status`, `anchor upgrade`; `tiresias receipts` shows each record's `record_fingerprint` (a file warning keeps its own `fingerprint`, the file's SHA-256); `receipts prove <id> [--out]` exports the record, salt, Merkle path and a standard `.ots` file; `receipts verify <bundle>` checks it offline and names the step that needs a Bitcoin block header. The OpenTimestamps format is implemented in `src/ots.ts` (no new package). Private mode is never anchored; each profile anchors separately; anchoring is never on the read path. Full record: `docs/v0.8/anchor.md`. At integration the receipts listing's new field was named `record_fingerprint`, so a file-warning record keeps its own `fingerprint`. Integration review also closed five private-mode gaps, three of them older than v0.8: a private session (`--private` or `TIRESIAS_PRIVATE=1`) now refuses `receipts prove --out`, `clear` (except `--dry-run`), `log --to`, `keys init` and `keys sign-directory --out`, and `tiresias mcp --private` now serves a private session (the flag used to be ignored). 16 MEDIUM and LOW findings are deferred to the compute-day sweep (docs/SPEC.md section 10).

## v0.7.0 (2026-10-31)

JavaScript-only pages (W-10), translate (W-26), and walls and hidden text revisited with rendering (N-02, N-05). Optional rendering in the Google Chrome already installed, driven over a pipe with no new package, off by default and turned on only by the owner (`rendering` off|ask|auto); every request the page makes goes through Tiresias's own rules, under caps on time, requests and bytes. On a rendered page the browser decides walls and hidden text. Every read reports its language (13 languages, no dependency), the shield matches phrases aimed at an AI in all 13, and an optional owner-set translation hook (`tiresias translator`) answers `read` with `translate`. Every request is now counted and capped by the bytes its connection receives, for plain reads too. Built as three tracks, reviewed by Codex, then together; deferred MEDIUM and LOW findings are listed in SPEC.md, section 10, v0.7.0.

## v0.6.1 (2026-10-30)

The compute-day sweep: the 10 MEDIUM and LOW findings deferred from v0.6.0, each fixed with a test (written by Codex, reviewed by Claude). Office parts with repeated or out-of-order containers are refused; long Office lines page in bounded blocks and the whole reply stays in its limit; receipts from a file a person saved keep their source; resume honors section and question for a saved Office file; Office answers to a sent form withhold receipts touched by hidden values before anything is logged; tabs honor current site settings for cached copies; the downloads shelf keeps the macros flag; `tiresias settings` lists `TIRESIAS_MAX_INSPECT_BYTES`. See SPEC.md, "Deferred to compute-day sweep".

## v0.6.0 (2026-10-26)

Inside files, plus browser basics. Zip listing without unpacking, Office text without macros (with receipts, section paging and question search), and calendar events from `.ics` files; tabs and back/forward (W-24), the downloads shelf (W-27), site settings per host (W-25), the `tiresias settings` command (W-29) and a fast first read with the door checks in the background (W-30). Closes W-24, W-25, W-27, W-29, W-30 and the "Not in v0.5" items of section 4.4.

## v0.5.0 (2026-10-20)

Released: dangerous files (W-20) and the owner's own scanner (W-21), built to the coordinator's scope in section 4.4, after Codex round 68, the final, severity-rated round, found nothing HIGH (`reviews/2026-10-20-codex-round-68.md`: 0 high, 1 medium, 1 low). The entries below are the work log kept while v0.5 was built.

## v0.4.0 (2026-10-18)

Released: profiles (W-18), permission slips (W-05) and permission-gated forms (W-04), after Codex round 57 found nothing blocking. The entries below are the work log kept while v0.4 was built.

## v0.3.0 (2026-10-17)

Released: needs report (W-12), diffs (W-02), bookmarks and watchlist (W-16), handoff and resume (W-06), shared cache (W-03), Safe Browsing (W-19), after Codex round 45 found nothing blocking. The entries below are the work log kept while v0.3 was built.

## v0.2.0 (2026-10-17)

Released: signing (N-07), the daily log (W-13), private mode (W-14), storage limits (W-15) and PDFs (W-17), merged to main after Codex round 35 found nothing. **W-09:** submitted to Cloudflare's Bots and Agents Directory (BotBase) on 2026-10-17 as Tiresias, operator Raibit, Direct, category Agent, content use immediate, Web Bot Auth with the raibit.ai key directory. Status: waiting for review. The entries below are the work log kept while v0.2 was built.

## v0.1.8 (2026-10-16)

Software release. Closes the six non-blocking items from Codex review round 8 (`reviews/2026-10-16-codex-round-8.md`: no blocking findings, ready for a private push).

## v0.1.7 (2026-10-16)

Software release. Fixes Codex review round 7 (`reviews/2026-10-16-codex-round-7.md`: three blocking, two non-blocking).

## v0.1.6 (2026-10-16)

Software release. Fixes Codex review round 6 (`reviews/2026-10-16-codex-round-6.md`: round 5 verified fixed; four blocking items from a whole-repo pass, one small regression).

## v0.1.5 (2026-10-16)

Software release. Fixes Codex review round 5 (`reviews/2026-10-16-codex-round-5.md`: three blocking items in rotation, two small).

## v0.1.4 (2026-10-16)

Software release. Fixes Codex review round 4 (`reviews/2026-10-16-codex-round-4.md`: one blocking item, B1, plus small ones). Numbers: A = round-3 item status, B-1 and B-2 = new in round 4.

## v0.1.3 (2026-10-16)

Software release. Fixes Codex review round 3 (`reviews/2026-10-16-codex-round-3.md`: no High; B1 to B5 new, plus residual partials).

## v0.1.2 (2026-10-16)

Software release. Fixes Codex review round 2 (`reviews/2026-10-16-codex-round-2.md`: 13 fixed, 13 partial, 13 new). Numbers below: P = round-1 finding that was partial, N = new finding in round 2.

## v0.1.1 (2026-10-16)

Software release. Spec stays at 0.5 apart from section 6.1. Fixes Codex review round 1 (`reviews/2026-10-16-codex-round-1.md`, 26 findings, verdict "not ready").

## v0.1.0 (2026-10-16)

Software release. Spec stays at 0.5.
