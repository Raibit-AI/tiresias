# v0.9 Track 2: hardening audit

Branch `v0.9`, worktree `~/Code/tiresias-v09`, after track 1 (W-32 confirmations, `9f702cd`, 873 tests passing).
An audit of the whole codebase as it will be published, not of one diff. Decisions for the coordinator to fold into
SPEC.md.

## Progress

- [x] Read SPEC (principles, section 8 non-goals, section 9 decisions), the 2026-10-20 structure review, docs/v0.9/confirm.md
- [x] This plan
- [x] Dependencies: `npm audit` (fix), pinned versions, `npm pack --dry-run` contents, a tarball install, license headers, package metadata (no publish) (commits f675260, 2f836cc)
- [x] Codex whole-codebase audits, round 1, four passes in parallel: (a) disk and processes, (b) parsers of hostile input, (c) the MCP surface, (d) README promises against the code
  - [x] 1a disk and processes (`docs/reviews/2026-10-31-v09-hardening-round-1a-disk.md`): HIGH 0, MEDIUM 2, LOW 0. Pass clean of HIGH on its first round
  - [x] 1b parsers (`docs/reviews/2026-10-31-v09-hardening-round-1b-parsers.md`): HIGH 1, MEDIUM 2, LOW 1. HIGH fixed with a test: a `Content-Encoding` Tiresias does not decode (a list of two, `zstd`, `compress`, anything unknown) passed the bytes on as plain, so a compressed robots.txt parsed as "no rules"; now only none, `identity` or exactly one of gzip, deflate, br is read, anything else fails the request, and robots.txt that cannot be read means the site says no (`src/safety.ts` `decoderFor`)
  - [x] 1c MCP surface (`docs/reviews/2026-10-31-v09-hardening-round-1c-mcp.md`): HIGH 1, MEDIUM 1, LOW 1. HIGH fixed with a test: the `log` tool built the whole day in the MCP process, every lookup kept in memory, and an agent grows the day with every call; now at most 5,000 lookups are listed and 10,000 agents and pages counted one by one, totals still count every record (`src/dailylog.ts`)
  - [x] 1d README promises (`docs/reviews/2026-10-31-v09-hardening-round-1d-readme.md`): HIGH 3, MEDIUM 11, LOW 11. (1) Fixed in code, with a test: CLI `receipts` and `history` printed their records (quotes, URLs, file names, agent names, purposes) at the top level as `items`; they now use the same envelope as MCP (`untrusted_content.receipts` / `.history`, shared `receiptsEnvelope` / `historyEnvelope` in `src/envelope.ts`). (2) Designed away: hidden values under 6 characters are deliberately not masked (SPEC records it; masking every `1` would hide ordinary text, and a value that short is no secret); the README now says so. (3) Designed away: the OpenTimestamps calendars are services the owner chose and confirmed (W-32), not sites Tiresias reads, so robots.txt and Safe Browsing do not apply, like the phishing list download; the README now says how they are called. Honoring a calendar's Retry-After is deferred (MEDIUM). The README wording of every MEDIUM and LOW that was a wording problem is fixed in the same commit (signing is https only and Web Risk is unsigned; wire allowance; 5 Mi characters; page size with a translation; the 200 MB daily target; scanner needs a fingerprint; private and preview spacing; a malformed config.json; hooks are trusted owner programs; the PDF child's real permissions; the form guard errs toward refusing; 18 MCP tools; Office and calendar files are read; files held whole for inspection; signature first then names; phishing list refresh; `--text` errors; `hosts/`; preview cooldowns; lowering `max_saved_mb`)
- [x] Fix every round-1 HIGH, with a test (`src/test/hardening.test.ts`); MEDIUM and LOW deferred below
- [x] Codex round 2 (and on) for the passes that had a HIGH: (a) clean in round 1; (d) clean in round 2; (b) clean in round 4 apart from the stopped echo class; (c) round 7 clean apart from the two stopped classes and one regression, fixed
  - [x] 2b parsers (`docs/reviews/2026-10-31-v09-hardening-round-2b-parsers.md`): HIGH 1, MEDIUM 0, LOW 0. Codex confirmed the round-1 encoding fix. HIGH fixed with a test: a robots.txt sent as a PDF (declared, or `%PDF-` under a generic type) came back from the fetcher with no text and parsed as "no rules"; now robots.txt that is not text means the site says no (`src/rules.ts`)
  - [x] 2c MCP (`docs/reviews/2026-10-31-v09-hardening-round-2c-mcp.md`): HIGH 1, MEDIUM 0, LOW 0. Codex confirmed the round-1 log fix (100,000 records stayed at 5,000 listed). HIGH fixed with a test (`forms.test.ts`): `form_submit` masked echoes of the form's hidden values but not of the cookies the site set while the form was fetched; now both are masked, and receipts quoting either are withheld (`src/forms.ts` `CookieJar.values`, `src/formflow.ts`)
  - [x] 2d README (`docs/reviews/2026-10-31-v09-hardening-round-2d-readme.md`): **HIGH 0**, MEDIUM 12, LOW 10: the pass is done. Codex confirmed the round-1 CLI fix and both exceptions now stated. Wording fixed at once in README and SECURITY.md (four of the findings were overclaims in the new SECURITY.md: list freshness, the disk target, service calls outside site rules, private mode's cooldown exception): JSON and diff limits in characters; signing step 3 needs `--host` before step 5; the shelf's caps; form record value cut; which settings changes are recorded; background probe walls; list refresh; private mode and Chrome's temp profile; private sessions never download the list; the slip key also signs snapshots; IPv4-mapped and NAT64; signed field scope; inspection bounds; tabs open on success only; the envelope wording; the CI path; Web Risk not spaced; deflate bodies collected whole. Two code items deferred below
  - [x] 3b parsers (`docs/reviews/2026-10-31-v09-hardening-round-3b-parsers.md`): HIGH 2, MEDIUM 0, LOW 0. Codex confirmed the encoding and 200-as-PDF fixes. Both HIGH fixed with a test: (1) only a 200 robots.txt was parsed, so 201, 202, 203 fell through to "no robots.txt"; now every 2xx is followed (and the non-text refusal applies to all of them), and a 206 means the site says no; (2) a rule writes a literal `*` or `$` as `%2A` / `%24` (RFC 9309 2.2.3), but the URL being checked kept them literal, so `/a*b` missed `Disallow: /a%2Ab`; the checked URL now encodes both (`normalizePath(s, pattern)`)
  - [x] 3c MCP (`docs/reviews/2026-10-31-v09-hardening-round-3c-mcp.md`): HIGH 1, MEDIUM 0, LOW 0. Codex confirmed the log, robots and CLI fixes. The cookie fix's first follow-up (same class, first survival): a quoted cookie value was tracked only with its quotes, so the site's echo of the bare token was not masked; the bare value is now tracked too, with a test
  - [x] 4b parsers (`docs/reviews/2026-10-31-v09-hardening-round-4b-parsers.md`): HIGH 1, MEDIUM 0, LOW 0. Codex confirmed the robots fixes. The one HIGH is the echo-masking class again (a cookie or hidden value echoed with lowercase percent escapes is not masked): **STOPPED, not fixed** (below)
  - [x] 4c MCP (`docs/reviews/2026-10-31-v09-hardening-round-4c-mcp.md`): HIGH 2, MEDIUM 0, LOW 0. Codex confirmed the quoted-cookie fix for its own case. (1) The echo-masking class again (a long secret echoed is cut to a 120-character preview before masking looks for it; whitespace-bearing cookies normalized by the HTML parser): **STOPPED, not fixed**. (2) Fixed with a test: concurrent MCP calls had no cap, each big parse started its own 512 MB worker and each render its own Chrome. Now one server runs at most 8 tool calls (32 waiting, then an error envelope at once), at most 4 parser workers (64 waiting) and 2 renders (8 waiting, then `render: failed, busy`) per process (`src/slots.ts`, `src/mcp.ts`, `src/sandbox.ts`, `src/render.ts`); PDF children were already 2 at a time
  - [x] 5c MCP (`docs/reviews/2026-10-31-v09-hardening-round-5c-mcp.md`): HIGH 3, MEDIUM 0, LOW 0, all at the message boundary below the round-4 caps, all fixed with one test (`guardTransport`, `src/mcp.ts`, applied by `createServer` to every transport): (1) the SDK validated arguments before any cap, so a call with a huge set of form values built a large error tree in the main process: now at most 1,000 elements (the SDK's `maxToolInputElements`) and 8 MB of arguments; (2) with standard output not drained, requests kept being accepted and answers kept piling up: now at most 64 requests open at once (the rest answered at once with fixed text), and on stdio reading pauses while more than 8 MB of output waits; (3) the SDK's own answers to an unknown tool or arguments that do not fit the schema repeated the caller's keys and tool name outside the envelope: every tools/call answer that is not Tiresias's envelope is replaced by a fixed-text error envelope
  - [x] 6c MCP (`docs/reviews/2026-10-31-v09-hardening-round-6c-mcp.md`): HIGH 3, MEDIUM 1, LOW 0. (1) The round-5 boundary's refusals used the sender captured before the stdio backpressure wrapper, so they bypassed it (and long string ids amplified them): refusals now go out through the outermost sender, and string ids over 128 characters are ignored. This is the resource class's second survival: **the loop on MCP-caller resource exhaustion STOPS here** (below). (2) Fixed: `log` and `needs_report`/`history`/`receipts` repeated a bad `day` or `since` in the top-level message; the texts are now fixed. (3) Fixed: the in-process cooldown map never shrank; past 10,000 entries expired ones go (corrected in round 7c: live ones are never dropped). All three with one test. The MEDIUM (the PDF child's own slot hands over like round 4's did before the fix) is deferred
  - [x] 7c MCP, confirmation round (`docs/reviews/2026-10-31-v09-hardening-round-7c-mcp.md`): HIGH 1, MEDIUM 0, LOW 0. Codex confirmed the sender, id and date fixes and found no other HIGH outside the two stopped classes. The HIGH was a regression in the round-6 cooldown fix: dropping a live wait because the shared file held it is unsafe, since that file is read only from its last 8 MiB. Fixed with a test: only expired waits are ever dropped. Not re-reviewed by Codex after this last fix (a five-line removal); it goes into the next round
  - **MCP-caller resource exhaustion stopped under the two-fix rule.** Rounds 4c, 5c and 6c each found another way for a client sending many or huge calls to make the server hold more memory (no call cap; validation before the cap and unread output; refusals outside backpressure, cooldown map). Each was fixed with a test, but the class is open-ended at the SDK boundary. Decision wanted, in "For Travis"
  - **Echo masking stopped under the two-fix rule.** Rounds 2c, 3c, 4b and 4c each found another way for a site's echo of a secret it set (hidden value, cookie) to escape masking: cookies at all, quoted cookies, lowercase percent escapes, truncation to a preview before masking, parser whitespace normalization. Each fix closed one spelling; matching spellings of a string inside text that is then cut and normalized is open-ended, as the form guard's marker words were in v0.5.1. Decision wanted, in "For Travis"
- [x] SECURITY.md threat model (what Tiresias promises and what it does not, matching section 8), checked by Codex pass d round 2
- [x] README wording that overclaims, fixed (Codex pass d rounds 1 and 2)
- [x] The 2026-10-20 structure review, item by item: done, still open or dropped (below)
- [x] Opt-in fuzz script (`scripts/fuzz.mjs`, Node built-ins only), run for a bounded time, results below
- [x] Full suite at the end: 883 tests (873 before, 10 new: 8 in `src/test/hardening.test.ts`, 2 in `forms.test.ts`), 0 skipped; 882 passed, and the one failure was an older test matching the old date error text, updated and its file rerun (31 of 31). Earlier checkpoint: 882 of 882
- [x] Secret scan (0 matches for all five patterns), push `v0.9`, report to Banks

## Design calls (with reasons)

- **Codex audits run as focused passes, in parallel, each looping on its own.** The brief names three passes; a
  fourth, (d) README promises against the code, was added so "check every promise" got a reader who opens the code
  for each sentence. Review files are named `round-<N><pass>` (`round-1a-disk`, `round-2b-parsers`). A pass is done
  when one of its rounds has no HIGH; pass (a) was clean on round 1.
- **README findings are fixed in the README when the code does what the SPEC decided.** A HIGH there that the code
  answers by design (short hidden values not masked; calendars are owner-chosen services, not sites read) is
  "designed away" by stating the exception, not by changing behavior the SPEC chose. Wording problems among the
  MEDIUM and LOW were fixed at once (they cost one sentence each and are the point of the audit); only code changes
  are deferred.
- **Unknown `Content-Encoding` fails the request** instead of being read as plain bytes. A list of codings is
  refused rather than decoded layer by layer: Tiresias asks for one of gzip, deflate or br, and decoding stacks of
  layers is new attack surface for a case no honest server needs.
- **The daily log is bounded by count, not by a time budget**: 5,000 lookups listed, 10,000 agents and pages
  counted one by one, totals exact. That keeps memory flat whatever the day holds; reading the files stays linear.
- **CLI `receipts` and `history` now print the standard envelope** (`untrusted_content.receipts` / `.history`,
  `page`, `pages`, `total`), the same as MCP. This changes the CLI's JSON shape (`items` is gone); acceptable before
  v1.0, and agents with a shell read the CLI as much as MCP.
- **SPDX identifiers on every source file**, not the long Apache header: Apache-2.0 does not require per-file
  notices, LICENSE and NOTICE carry the terms, and one line keeps files readable while still marking provenance for
  anyone who copies a single file.
- **`npm audit fix` taken** (body-parser 2.4.0, fast-uri 3.1.9, both pulled in by the MCP SDK; Tiresias uses only
  the stdio transport, so neither was reachable, but a clean audit is what a user sees first). Every direct
  dependency stays pinned to an exact version.
- **The npm tarball** holds `dist` (no tests), the canvas stub, README, LICENSE and NOTICE: no docs, reviews, keys or
  fixtures. A tarball install with `--omit=optional` was run and `tiresias --version` works. No `prepack` script:
  `.npmrc` turns lifecycle scripts off, so it would never run (the release step is in "For Travis").
- **The fuzz script runs under Node's permission model**, allowed to write only to a throwaway store, so "no write
  outside the store" is enforced by Node rather than checked after the fact. It is opt-in (`npm run fuzz`), never in
  `npm test`.
- **The CI workflow is not touched**: the token here cannot write workflow files and the push would be rejected;
  the two changes wanted are in "For Travis".

## Fuzzing

`npm run fuzz` (or `node scripts/fuzz.mjs --seconds N --seed S`): 20 targets (HTML, forms, walls, question search,
block diffs, JSON, markdown, SVG, calendar, CSV, vCard, scripts, robots.txt, the phishing list, zip listings, Office
text, OpenTimestamps proofs, the file classifier, the XML tokenizer, PDFs in their own child), seeded inputs mutated at
random (bit flips, inserted markup, deleted and repeated ranges up to 1 MiB, splices, truncation), run through the same
job handler the worker uses, under Node's permission model with writes allowed only to a throwaway store.

Runs on this branch: 20 s (seed 7, 1,080 inputs): nothing. 300 s (seed 20261031, 2,182 inputs, under load from a
Codex review): no crash, no write outside the store, no slow input of 8 KB or less (the main-thread path), no PDF child
past its budget, no worker out of memory. Three inputs ran past 8 s in the fuzz worker, all deep nesting repeated to
about 0.5 MB: `<table><tr><td>` 32,000 deep (parse), `<svg>` 100,000 deep (the forms walk) and `<ul><li>` 14,000
deep (the round-1b list finding). Replayed through Tiresias's own worker, each ends as `page_too_complex` at 5.0 s:
the cap holds, so this is a MEDIUM (deferred below), not a hang. The OpenTimestamps and XML errors counted are the
parsers' own refusals (`OtsError`, `XmlMalformed`, `XmlRefused`); the PDF errors are `PdfError` and `PageTooComplex`.

## The 2026-10-20 structure review, revisited

v0.5.1 took the review as its whole scope (SPEC section 10, v0.5.1 checklist A to G). Each item checked against
the code on this branch:

| Review item | Verdict | Reason / where |
|---|---|---|
| N-01 ladder: sitemap made `best` "feed"; `door` meant two things | done | v0.5.1 F4: a sitemap alone is not a feed; `door` is the door used, `available` the best offered |
| N-02 shield gaps (own `<style>`, sr-only, zero-width and tag characters, non-English, hidden PDF text, one shared cap of 30) | done | v0.5.1 F2 (caps per flag type, style rules, sr-only, invisible characters, NFKC, hidden PDF text); 13 languages in v0.7 (W-26). External style sheets on unrendered reads stay advisory by the 2026-10-23 decision |
| N-03 quotes are 4,000-char blocks, not per fact | dropped | A receipt is an exact substring of the block it came from (`MAX_BLOCK` 4,000, `src/reader.ts`); `question` returns the best passages, each with its receipt. Sentence-level facts would need the reader to decide what a fact is, which is the agent's job |
| Wall size thresholds a big login page slips past | done, then advisory | v0.5.1 F3 and the round 73 to 75 decisions; walls are a courtesy (2026-10-23), measured by the browser on rendered reads (2026-10-31) |
| N-06: no default spacing; spacing per process; Crawl-delay inside the 15 s timer | done | v0.5.1 D and item 2: one second per site by default, shared across processes; the policy wait pauses the request timer |
| N-10: any port; https to http; `TIRESIAS_ALLOW_PRIVATE` in production; raw deflate; 300/304 with Location | done | Ports 80, 443, 8000 to 8999 by default (`src/safety.ts:93`); downgrades refused (`safety.ts:121`); the private-address bypass needs the Node test runner too (`safety.ts:88`); raw deflate inflated whole (`safety.ts:418`); only 301/302/303/307/308 are followed |
| W-20 wording in section 4.4 | done | Reworded 2026-10-20 |
| W-02 JSON in fixed 4,000-char slices | done | v0.5.1 F5: line diffs, content-defined runs past 5,000 lines |
| W-13 daily log unescaped Markdown | done | v0.5.1 E7 |
| W-14 private mode enforced per call site | done | v0.5.1 E4: the store's write functions fail closed |
| W-16 watch baseline in the page cache | done | v0.5.1 E6: baselines live in the bookmark file |
| Register stale | done | Fixed 2026-10-20; registers kept current per version since |
| 1. Slips protect against MCP, not a shell | done (optional part after v1.0) | v0.5.1 C: grant and revoke need a person at a terminal typing the site back; revoked ids kept; signed use files. Touch ID: after v1.0, a v1.x want (Travis, 2026-10-31; SPEC section 9) |
| 2. `engine.ts` holds nine jobs; no error base class | done | v0.5.1 E1 and E2: `engine.ts` is 98 lines, with envelope, pagecache, pipeline, filereply, resume, watchflow, formflow split out; `TiresiasError` with a `kind` |
| 3. Transport knows too much (safety imports signing and files; sandbox imports reader; two ambient contexts) | partly done, rest dropped | v0.5.1 E3 fixed the sandbox/reader import and made one `CallContext`. `safety.ts` still imports signing (each redirect hop is signed for its own site) and files (the file classifier runs on the first bytes as they stream, so a program is never fetched whole); both are by design, and moving them would split one fetch over two modules |
| 4. Hot path reads disk; in-memory maps grow forever | done | `cooldownLeft` reads a memo keyed on the file's stamp (`src/cooldown.ts:90`); the queue maps are bounded (`MAX_HOSTS`, `src/queue.ts`); the robots cache is per call |
| 5. Three copies of "one JSON file per item"; tickets and bookmarks written in place | done | v0.5.1 E5: `src/itemfiles.ts`, temp then rename |
| 6. No schema versions; receipts with no `kind` | done | v0.5.1 E6 |
| 7. PDF child resource-caged, not privilege-caged | done, network part open | v0.5.1 E8: Node's `--permission`, reads only Tiresias's own folders. Node 22's model does not limit the network; the child has no address and no fetching code (SPEC 2026-10-21), stated in SECURITY.md |
| MCP: no annotations; descriptions repeated | done | v0.5.1 G2 |
| CLI: always exit 0; no `--version`; plain-text errors | done | v0.5.1 G1 |
| Tests named by round; timing tests flake on CI; MCP has 2 tests | done | v0.5.1 G5 (`timing()` skips upper bounds on CI) |
| Packaging: `private: true`, no `files`, canvas stub only for source installs | done | v0.5.1 G3; checked again here: a tarball install with `--omit=optional` gets the stub (npm resolves the `file:` path inside the package) and `tiresias --version` runs |
| Missing CI, SECURITY.md, CONTRIBUTING, CHANGELOG, examples; README drift | done | v0.5.1 G4 and G6; SECURITY.md's threat model written in this track |
| Reader behind the state of the art (scoring, tables, `pre`, lists, h5/h6, metadata, Unicode tokens, `Accept: */*`) | done | W-22 and W-23 (v0.5.1) |
| Borrow from browsers: tabs, back/forward, reader mode, translate, save page, site settings, mixed content, downloads, markdown first | done | W-24, W-22, W-26, W-28, W-25, the downgrade refusal, W-27, W-23 |
| Borrow from browsers: find in page with phrase search and a fuzzy fallback | still open | Unicode tokens shipped (W-22); phrase and fuzzy search did not. Not a security item; a v1.x want |

## Deferred to compute-day sweep

| Round | Severity | Summary | File | Fix or design away |
|---|---|---|---|---|
| 1a | MEDIUM | `writeJson()` ignores `writeSync`'s byte count, so a short write (disk full) publishes a truncated JSON file (caches, tabs, anchor batches) | src/store.ts:410 | Fix: one buffer, loop until every byte is written, refuse zero progress, remove the temp file on failure (`writeFileSync` on the fd does the loop) |
| 1a | MEDIUM | `receipts prove --out` writes its files one by one; a later collision or failure leaves earlier files behind and a retry then fails | src/anchor.ts:535 | Fix: write all to exclusive temp names first, then link into place without overwriting, removing only this run's files on failure |
| 1b | MEDIUM | Deeply nested HTML lists grow indentation quadratically: a 132 KB page gave 52 M characters of text in the worker, then cloned and cached on the main thread | src/reader.ts:416, 206 | Fix: cap the indentation depth (as markdown readers do, e.g. 8 levels) and cap the worker's result size before posting it (fail as `page_too_complex`) |
| fuzz | MEDIUM | Deep nesting is super-linear: about 0.5 MB of nested `<table><tr><td>` (parse) or `<svg>` (the forms walk) runs past the 5 s budget and ends as `page_too_complex` (the cap holds; such a page cannot be read) | src/reader.ts, src/forms.ts | Fix: cap the depth the reader and the forms walk track (as htmlparser2's consumers usually do, e.g. 256 levels, deeper content flattened), with a fuzz seed for each |
| 1b | MEDIUM | Rendered reads inspect only the first 2,000 inputs and CAPTCHA candidates without saying so, so a password box after them gives a definite "no wall" | src/inspect.ts:229, 97 | Fix: count what was not inspected and make the verdict "not decided" (falls back to the HTML heuristic) when anything was left |
| 1b | LOW | A CDP message that crosses the size cap in its final chunk is accepted (the cap is checked only on unterminated tails) | src/cdp.ts:48 | Fix: check held length plus the final fragment before joining |
| 1c | MEDIUM | MCP `history` and `receipts` with an invalid `since` throw a plain SDK error instead of the envelope | src/mcp.ts:138, 160 | Fix: catch and return an `error` envelope with fixed text |
| 1d | MEDIUM | A `section` that does not exist returns `status: "error"` after `saveNow([])` already saved a snapshot, though errors are never saved | src/pipeline.ts:558 | Fix: check the section before saving; save nothing on that branch |
| 1d | MEDIUM | A saved Office read logs its receipts before the fingerprint-only snapshot exists, so those receipts carry no `snapshot` | src/pipeline.ts:336 | Fix: create the snapshot first and pass its id into `fileWarning`, or say in README that fingerprint-only saves link no receipts |
| 1d | MEDIUM | Anchor calendar answers' Retry-After (429/503) is not recorded, and an existing cooldown for a calendar is not checked | src/anchor.ts:248 | Fix: check `cooldownLeft` before `ask()` and `setCooldown` on 429/503 (the calendars stay outside robots.txt by design) |
| 1d | LOW | With signing set up, a plain-http read never loads the key, so a damaged key file goes unnoticed on http-only use | src/safety.ts:861 | Design away: README now says http is never signed; optionally check the key once per call when signing is configured |
| 2d | MEDIUM | Fenced code in a markdown page loses its indentation and line breaks (lines are joined and whitespace collapsed); HTML `<pre>` is kept | src/reader.ts:1074, 196 | Fix: send fenced and indented markdown code through the same preformatted-block path as `<pre>` (README now states the gap) |
| 2d | MEDIUM | `saved verify` and `receipts verify` print a failed verification as pretty JSON on stdout with `status: "ok"` and exit 1, unlike every other error | src/cli.ts:543, 593 | Fix: a failed verification is `status: "error"` (or its own `failed` status) printed through the normal error printer |
| 6c | MEDIUM | The PDF child's slot is released before the next waiter takes it, so a third child can start in between (each child keeps its own memory and time caps) | src/pdfproc.ts:85 | Fix: use `Slots` (src/slots.ts), which hands the slot over directly |
| 1c | LOW | Tool annotations: `read` says read-only though `save` writes a snapshot; `bookmark`, `resume`, `tab` say not destructive though they can delete or consume | src/mcp.ts:78, 211, 252; src/browsetools.ts:60 | Fix: mark them conservatively (`readOnlyHint: false` on `read`, `destructiveHint: true` on the three); clients then ask before calling |

## For Travis

Decisions wanted before the public launch:

A. **DECIDED 2026-10-31 (Travis): trust the client, ceiling built in, Docker optional; built in track 2b, `docs/v0.9/client-trust.md`.** **How far to defend against the agent's own MCP client.** Tiresias now caps calls, workers, renders, argument
   size and open requests, and pauses reading while output backs up. Codex keeps finding more ways a client that
   sends thousands of calls, or stops reading answers, can make the server use more memory (three rounds, each fixed).
   The client is the agent's own program on your machine: a prompt-injected agent can send many calls, but cannot
   make its client stop reading answers, and the worst outcome is the agent's own Tiresias server stopping (no data
   leaves, nothing is written outside the store). Recommendation: state in SECURITY.md (which today lists an MCP caller exhausting memory as HIGH) that the MCP client is trusted
   not to flood its own server (a crash of the server is a bug, not a HIGH), keep the caps as they are, and stop
   treating new variants as HIGH. The alternative is a full message-queue rewrite of the stdio layer below the SDK.

B. **DECIDED 2026-10-31 (Travis): option (b), withhold; built in track 2b, `docs/v0.9/client-trust.md`.** **Echo masking (needed before v1.0 under the no-open-bugs rule).** When an agent sends a form with a slip, the
   site's answer may echo back a hidden value or a cookie the site set. Since Codex round 54 Tiresias masks such echoes
   as `[hidden value]` and withholds receipts quoting them. This audit found four more ways around the masking in four
   rounds (cookies, quoted cookies, lowercase percent escapes, a long value cut to a preview before masking looks for
   it), and stopped under the two-fix rule. Matching every spelling of a string in text that is then cut and
   normalized is open-ended. Note who is harmed: the secret is one the site itself set during this one call (Tiresias
   keeps no cookies or logins between calls), so a hostile site echoing it gives away only its own token. Options:
   **(a)** declare echo masking a courtesy, best effort, like walls and hidden-text flags (2026-10-23), keep what
   works, and drop "cookie" and "hidden form value" from SECURITY.md's HIGH list; **(b)** refuse structurally: before
   parsing, look for any secret in the raw answer bytes after decoding percent and HTML escapes in any case, and if
   one is there, return the answer as fixed codes only (status, size, no text, no receipts); one check on raw bytes,
   no spelling chase, at the cost of showing nothing for those answers; **(c)** keep chasing spellings (not
   recommended). Recommendation: (b) if you want it to stay a promise, else (a). Either needs a SPEC decision row.

1. **Turn on private vulnerability reporting when the repo goes public.** SECURITY.md sends reporters to GitHub's
   "Report a vulnerability" button, which is off until it is enabled in the repo's Settings, Security section. Without it,
   the only way to report is a public issue. (Or name a security email address instead.)
2. **DECIDED 2026-10-31 (Travis): kept private at launch (launch step in item 6 and `docs/v0.9/client-trust.md`).** **The Codex review logs in `docs/reviews/`** (167 files, 65 MB) would become public with the repo. They show the
   process honestly, which is a selling point, but they also show local paths with your Mac user name and every bug
   ever found, in detail. They are not in the npm package either way. Options: keep them (recommended: the
   story is the review process); or move them to a private archive and keep a short summary per version.
3. **CI hardening needs a workflow-scope login.** `.github/workflows/ci.yml` still starts with a stale comment ("Move
   this file to ...") and uses actions by tag (`@v4`), which an attacker who took over those actions could change.
   Pin them by commit: `actions/checkout@11d5960a326750d5838078e36cf38b85af677262` (v4) and
   `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020` (v4). The token used here cannot write workflow
   files; either run `gh auth refresh -s workflow` once or make the two-line edit on the GitHub website.
4. **DECIDED 2026-10-31 (Travis): after v1.0.** **Touch ID for permission slips** (the structure review's optional part, skipped in v0.5.1): a person at a
   terminal typing the site back stops an agent granting itself a slip in passing, not a program faking a terminal.
   Touch ID would close that on Macs. Before v1.0, or a v1.x want?
5. **DECIDED 2026-10-31 (Travis): macOS and Linux; Windows not yet supported.** **Platforms for v1.0.** PDFs cannot be read on Windows (memory cannot be watched there), and the scanner and
   translator hooks are macOS and Linux only. Say "macOS and Linux" for v1.0, or plan Windows work?
6. **Publishing checklist (track 3 or launch day).** The scoped package `@raibit/tiresias` needs the `raibit` npm
   organization and `npm publish --access public` (scoped packages are private by default). Because `.npmrc` turns
   install scripts off, a `prepack` script would not run, so the release step must rebuild by hand:
   `rm -rf dist && npm run build && npm pack` and check the file list. A tarball install was tested here and works
   (the canvas stub resolves from inside the package).
   Launch step added 2026-10-31 (item 2, decided): before the repo is made public, move `docs/reviews/` to a private
   archive (for example a private `Raibit-AI/tiresias-reviews` repo) and publish a history that does not hold it:
   either a fresh public repo started from the release tree, or a copy rewritten with `git filter-repo --path
   docs/reviews --invert-paths`. Removing the folder in one commit is not enough, because old commits would still
   show it. Check that no doc links into `docs/reviews/` break (the SPEC's version history names review files by
   path; keep the names as plain text). Nothing is deleted before launch day.
7. **Small inputs are parsed without a time budget.** Pages of 8 KB or less are parsed on the main thread (cheaper
   than starting the worker), with no deadline. The fuzz run found nothing slow there, and the README states it, but
   a future parser bug with super-linear time on tiny inputs would hang the MCP server instead of returning
   `page_too_complex`. Keeping it is a speed choice; sending everything to the worker costs a few milliseconds per
   read. Recommendation: keep, and keep the fuzz script's `slow_inline` check as the tripwire.
