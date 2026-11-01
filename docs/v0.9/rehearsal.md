# v0.9 Track 3: private launch rehearsal

Branch `v0.9`, worktree `~/Code/tiresias-v09`, after tracks 1, 2 and 2b (`293f80f`, 891 tests passing).
A brand-new developer finds the repo and follows it end to end; what trips them up is fixed here (docs, error
messages, small rough edges) or listed under "For Travis". Everything runs under a fresh temporary HOME and a
temporary npm prefix: the real `~/.tiresias`, `~/.claude` and every real config are never touched, no real calendar
is contacted, nothing is published.

## Progress

- [x] Read README, SPEC section 6, docs/v0.9/confirm.md, hardening.md, client-trust.md
- [x] This plan
- [x] `npm pack`, install the tarball globally into a temporary prefix, fresh HOME
- [x] README from the top, literally: install, first read, every quickstart command
- [x] MCP setup for Claude Code (config written to the temp HOME only) and reads through a tiny local MCP client
- [x] Rendering with Chrome, saving, anchoring against a local fake calendar, slips, forms on local test pages, a PDF
- [x] Upgrade path from a v0.8 store with saving, rendering and anchoring on (W-32: confirm each once)
- [x] Unhappy paths: Node 20 (not on this Mac: simulated), no Chrome, a read-only home, a typo'd command, offline; Docker (not installed: untested)
- [x] Fixes for what tripped the newcomer; `docs/QUICKSTART.md`; `tiresias --help` and README agree
- [x] The recurring render flake under full-suite load (W-10 "a JavaScript page renders")
- [x] Full suite at the checkpoint (`9bc1fdb`, with Codex running alongside): 894 of 894 (891 before, 3 new), 0 skipped; both render tests that used to flake passed under that load
- [x] Codex review loop on the code changed here (fix HIGH only; MEDIUM and LOW deferred below)
  - [x] Round 1 (`docs/reviews/2026-10-31-v09-rehearsal-round-1.md`, on `9bc1fdb`): **HIGH 0, MEDIUM 1, LOW 0**: the loop ends. Codex confirmed a page's real heading reading "(top of page)" keeps its receipt, and found nothing else in scope. The MEDIUM (copies cached by the older reader keep their label receipts, and a later diff could list the label as removed) was a one-line fix already in the working tree, so it went in with a test rather than to the sweep: `PARSER_VERSION` 13, so an older cached copy is parsed again (the test makes a cached copy look older and fails at version 12)
- [x] Full suite at the end (`7cf5701`): 894 of 894 (891 before, 3 new), 0 skipped
- [x] Secret scan (0 matches for all five patterns), push `v0.9`, report to Banks

## How the rehearsal is run

- Temporary root `R` (in the coordinator's scratch folder): `R/home` is `HOME`, `R/prefix` the npm prefix
  (`npm install -g --prefix R/prefix <tarball>`), `PATH=R/prefix/bin:...`. No `TIRESIAS_HOME`: the default
  `~/.tiresias` resolves inside the temporary HOME, as it would for a newcomer.
- Local test pages and the fake OpenTimestamps calendar run on `127.0.0.1`. Tiresias refuses private addresses
  outside its own test runner (by design), so steps against local servers set `NODE_TEST_CONTEXT=child` and
  `TIRESIAS_ALLOW_PRIVATE=1` in that one command's environment. A newcomer cannot do this, and should not; noted in
  the friction log.

## Friction log

Each step: what happened, what a newcomer would think, and the fix (or where it went).

| # | Step | What happened | What a newcomer thinks | Fix |
|---|---|---|---|---|
| 1 | `npm pack`, `npm install -g --omit=optional --prefix <tmp> <tarball>` | Installs in 3 s; `tiresias --version` works. But `node_modules/pdfjs-dist/node_modules/@napi-rs/canvas` (the real one) and `@napi-rs/canvas-darwin-arm64` (a native `.node` binary) are installed, with or without `--omit=optional`, and with an `npm-shrinkwrap.json` too: npm applies `overrides` only to the root project, so the stub covers source installs only | (a careful one) "the README says no native code from pdf.js is ever installed" | It never loads: the PDF child runs under Node's permission model, which refuses every native add-on (checked: `ERR_DLOPEN_DISABLED`; without the permission model the same file loads). README corrected (no false claim, `--omit=optional` dropped from the v1.0 line), a test pins the refusal. Keeping it off disk entirely: For Travis |
| 2 | `tiresias read https://example.com --text` (first read) | Works, 10 s wall time (11 MB list download, door checks finished before exit) | "is it stuck?" | README and QUICKSTART say the first read takes a few seconds and why |
| 3 | The outline of example.com | One section, `(top of page)`, and a receipt whose quote is `(top of page)`: a label Tiresias made, quoted as if the page said it (same for `(structured data)`) | "receipts are supposed to be exact quotes" | Both labels are marked generated (like a PDF's "Page N"): no receipt (`src/reader.ts`), test |
| 4 | `tiresias read https://example.com` again (the README's next line, "outline + numbered links") | `unchanged`, no outline | "where is the outline?" | The message now says "Ask for page 1 (the outline), a section or a question"; README and QUICKSTART explain |
| 5 | `tiresias receipts --url https://example.com --since 7d` (README line) | 0 receipts: they were recorded as `https://example.com/` | "receipts are broken" | The filter also matches the address as a URL parser writes it (`src/receipts.ts`), test |
| 6 | `receipts --text`, `history --text` | Printed only a header when empty; a page read's `--text` printed every receipt as a JSON line | "is --text a summary or not?" | Empty listings say "No receipts match."; a read's `--text` prints the receipt count (`src/cli.ts`), test |
| 7 | `tiresias doors https://example.com --text` | Message began "v0.1 detects every door" | "am I on v0.1?" | "Tiresias detects every door..." |
| 8 | `tabs`, `slip` and `saved` listings, `--section 2` on a one-section page | "1 tabs", "1 uses left", "1 saved snapshots", "1 sections" | small, but reads as unfinished | Singular forms |
| 9 | `read http://127.0.0.1:8765/` (a newcomer's own dev page) | `Refused: the address is private or internal.` | "why? how do I try it locally?" | Message says it is this computer or your own network, refused on purpose so a page cannot reach your devices; README and QUICKSTART say so. (The rest of this rehearsal ran local pages with the test runner's allowance, which a newcomer cannot and should not use) |
| 10 | `slip grant` from a script | Refused, needs a terminal (by design); with a real pty (`expect`) it asks to type the site back and grants | (as designed) | none |
| 11 | `form preview`, `form submit --preview <hash>`, a second submit | Exact request shown, hidden value as `[set by the site]`; sent once with the slip; the second submit `no_slip` | clear | README notes `--unset` (it was only in `--help`) |
| 12 | `settings set saving ask` without the phrase | Refused with the exact command to repeat | clear | none |
| 13 | Hints that name a risky setting (`saved` when empty, `anchor` when off, `--help` for `--save`, `anchor`, `scanner --send-file`, `translator set`) | Gave the command without `--confirm`, so following the hint failed once | "the hint is wrong" | Each hint carries its phrase; the render hint an agent sees says the command prints the phrase |
| 14 | `read --save`, `saved verify <16-char id from the list>` | Saved, verified; the short id works | clear | none |
| 15 | `read /js` (a JavaScript-only page) without rendering | `OK` with no outline and nothing saying it looks like a JavaScript page | "the page is empty?" | Deferred (a hint when a plain read looks like an empty JavaScript shell and rendering was not asked); see below |
| 16 | `settings set rendering ask --confirm ...`, `read --render` | Rendered in 5 s, 2 requests, blocked counted | clear | none |
| 17 | `anchor` against a local fake calendar, `anchor upgrade`, `receipts prove --out`, `receipts verify` | Works. The anchor message ended "It is pending ... No pending batches." | "pending or not?" | Only earlier batches are mentioned after a new one ("Earlier batches: ...") |
| 18 | `receipts verify` given the record file instead of the bundle | "not a Tiresias proof bundle" | "which file is the bundle?" | The message names the `.proof.json` file |
| 19 | The settings notice when a confirmed value is refused by this version (seen when the rehearsal's local calendar was read outside the test allowance) | "The confirmation record could not be read" though the file was fine | "my file is broken?" | "could not be read or holds a value this version does not accept" |
| 20 | `claude mcp add tiresias -- tiresias mcp` (README line, run inside the repo) | Added with local scope: only in that folder | "Tiresias is missing in my project" | README, QUICKSTART and `--help` use `--scope user` and show `claude mcp list` (checked: `tiresias: ... Connected`). Config written to the temp HOME only (`CLAUDE_CONFIG_DIR`); the real `~/.claude.json` was not touched (its time stamp checked) |
| 21 | A tiny MCP client (`@modelcontextprotocol/sdk`): 18 tools, read with a question, a section, render, save, receipts, history, slips, doors, an unknown tool | All as documented; the unknown tool gets the fixed error | clear | none |
| 22 | PDF from a local page (npm-installed copy) | Read as "Page 1" with its text | clear | none |
| 23 | Upgrade: a v0.8.0 build turned on saving, rendering, anchoring; then v0.9 | Each held off; every reply's notice gives the exact command (`tiresias settings confirm saving --confirm 'YES, TURN ON SAVING'`); after the three commands, saving works. The read itself said "the saving setting is off" | "but I set it to ask" | The not_allowed texts say "off, or turned on in config.json and not yet confirmed; tiresias settings shows which"; README and QUICKSTART have an "Upgrading from v0.8" note. An MCP-only owner sees the notice only through the agent's replies: For Travis |
| 24 | Node 20 | Not installed on this Mac (only 22.22 and 26.8); not downloaded. npm only warns (`EBADENGINE`) and every builtin Tiresias imports by name exists in Node 20, so it would start and fail later on a newer API | "cryptic error" | `src/nodecheck.ts`, imported first by the CLI: under 22.13 it prints "Tiresias needs Node 22.13 or newer; this is Node X" and exits 1 (version logic tested; the real Node 20 run is untested) |
| 25 | No Chrome (`TIRESIAS_CHROME` at a missing path) | Plain read, `render: unavailable`, how to enable it | clear | none |
| 26 | Read-only home (`chmod 555`) | "Tiresias hit an internal error." plus four stderr lines | "it's broken" | A file-system refusal on the store says "Tiresias cannot write to its store folder ... set TIRESIAS_HOME ... or add --private" (`src/envelope.ts`), test. `--private` works there |
| 27 | Typos: `tiresias raed`, `tiresias read`, `read example.com`, `--qestion` | Unknown command (good); usage (good); "Not a valid URL." (no hint); Node's own message about positional arguments | "what?" | "Give the whole address, starting with https://"; "Unknown option "--qestion". Run tiresias read --help for the options it takes." (test) |
| 28 | Offline (`sandbox-exec` with outbound network denied) | "robots.txt could not be fetched, so Tiresias assumes the site says no." (REFUSED, exit 2) | "the site refuses me?" | The message adds "(the site did not answer, or this computer is offline)" |
| 29 | Docker | Not installed on this Mac, and not installed for this rehearsal | | Untested here (track 2b simulated its run stage without Docker) |
| 30 | `--help` against README | The README's commands and options all appear in `--help` (checked by script) except forms of the same lines; `--unset` was missing from README | | Added; `--help` now starts with "First try", the Claude Code line, and where the guides are |
| 31 | Source install (`git clone` of the branch, `npm install --ignore-scripts`, `npm run build`) | 1 s + 1 s; only the stub canvas; first read works | clear | none |

## The render flake

"W-10: a JavaScript page renders" (render.test) and "v0.7 hidden text, rendered" (walls-rendered.test) are each
the FIRST Chrome render in their test file. Alone the first render takes about 3.6 s against about 1.2 s for later
ones (Chrome starting cold); the files shorten the render limit to 8 and 10 s so the tests that wait for it to run
out stay quick. Under a loaded machine the cold start passed the shortened limit, the render stopped, and the read
fell back to plain: the failure seen in tracks 1 and 2b. Fix (tests only): the first render of each file runs
under the real 20-second limit (`coldStart` in both files), and `saved.test`, whose one render is also a cold start,
uses the real limit. The limit is unchanged in Tiresias itself.

## Deferred to compute-day sweep

| Round | Severity | Summary | File | Fix or design away |
|---|---|---|---|---|
| Rehearsal | LOW | A plain read of a JavaScript-only page comes back `ok` with an empty outline and no word that it needs rendering (friction 15) | src/pipeline.ts | Fix: when a plain read is HTML that `looksLikeShell` and rendering was not asked, add a fixed sentence to the message ("looks like a JavaScript-only page; read it with render when the owner allows rendering") |
| Rehearsal | LOW | `read --save` on an unchanged page says "Answered from the local cache" while `cache` says `refetched` (a save always fetches) | src/pipeline.ts | Fix: when the read saved, say "Unchanged since ...; fetched again to save it" |
| Rehearsal | LOW | `history --text` and `receipts --text` start with the page-read header `OK    (door: none)` (an empty URL, a door that means nothing for a listing) | src/cli.ts | Fix: a listing gets its own first line ("History: N records, page P of Q") |
| Rehearsal | LOW | With a home folder that cannot be written, every command downloads the 11 MB phishing list again (it cannot be saved) and prints four lines to standard error | src/safebrowsing.ts | Design away: when the store root cannot be created, skip the download and say `safety: unchecked` once |

## For Travis

1. **The native canvas add-on in an npm install.** `npm install -g @raibit/tiresias` will put pdf.js's optional
   native drawing library (`@napi-rs/canvas` and a platform `.node` binary) on disk, whatever flags are used: npm
   applies Tiresias's `overrides` stub only when Tiresias is the root project (a source install). It is never
   loaded (the PDF child's permission model refuses native add-ons, now pinned by a test), and the README now says
   exactly that. To keep it off disk entirely before v1.0, options: (a) publish with `bundleDependencies` so the
   package carries its own dependency tree with the stub (bigger tarball, the standard way for CLIs); (b) depend on
   a pdf.js build without the optional dependency; (c) accept and keep the honest wording. Recommendation: (c) for
   v1.0 (no risk, nothing runs), (a) as a follow-up if a reviewer asks.
2. **An MCP-only owner and the upgrade notice.** After an upgrade from v0.8 with saving, rendering or anchoring on,
   those are held off until confirmed, and the notice is in every reply. An owner who only uses Tiresias through an
   agent sees it only if the agent passes it on. Options: the release notes say it plainly (done in CHANGELOG and
   README), or `tiresias mcp` also prints the notice once to standard error at start (most apps show server stderr
   in their logs). Recommendation: the release notes are enough for v1.0.
3. **Version string.** Done at the release step (0.9.0 in `package.json`, `src/types.ts` and the README).
