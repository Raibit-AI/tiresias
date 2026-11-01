# v0.9 Track 2b: trusted MCP client, built-in memory ceiling, optional Docker; echo secrets withheld

Branch `v0.9`, worktree `~/Code/tiresias-v09`, from `d3ee1ff` (track 2 hardening, 883 tests passing). Builds Travis's
decisions on "For Travis" items A and B of `docs/v0.9/hardening.md` (2026-10-31), plus three small decisions.
Decisions for the coordinator to fold into SPEC.md (the rows are added there too, as asked).

## Progress

- [x] Read SPEC (principles, section 8, section 9), SECURITY.md, docs/v0.9/hardening.md (item A, pass c's rounds), docs/v0.9/confirm.md
- [x] This plan
- [x] A1. Trust boundary: SECURITY.md threat model and HIGH definition; SPEC section 9 row (W-33)
- [x] A2. Built-in memory ceiling (`src/ceiling.ts`): first built as a re-exec with `--max-old-space-size`, replaced after Codex round 1 by an in-process watch after each full garbage collection; `TIRESIAS_MEMORY_MB` (default 1024), a clear stderr line and a history record (daily log) when the server stops at it; tests (`src/test/ceiling.test.ts`, 5 new, including a real flood to the ceiling)
- [x] A3. Optional Docker: `Dockerfile`, `.dockerignore`, `docs/docker.md`, README section, CHANGELOG. No Docker on this Mac: the Dockerfile was checked by reading, and its run stage was simulated without Docker (the same `npm ci --omit=dev --omit=optional --ignore-scripts` from the same files into a folder, `dist` without tests, the app folder made read-only, `HOME` a fresh folder): `--version`, an MCP `initialize` and a real `read https://example.com` all worked, the store created under `HOME/.tiresias`
- [x] B. Echo secrets withheld (`src/echo.ts`): one check of the raw answer of a form submit; a hit returns fixed codes only (`secret_withheld`); masking removed (`maskDeep`, `echoSecrets`, `counts.receipts_withheld`); SPEC row; SECURITY.md; README; form_submit's description. Tests: one new test with 18 spellings (raw, lower, mixed and double percent escapes, form-encoded, decimal, hex and named entities, JSON escapes, upper case, a header only, split by tags, zero-width characters, a 176-character value past the preview, a cookie with whitespace normalized, a quoted cookie, plain text, a Location with lowercase escapes), all withheld, plus a clean answer and a short value shown; the five older masking tests (rounds 54, 56, 2c, 3c, office sweep) now expect the answer withheld; round 87 and 88 tests check the matcher on header names
- [x] C. Small decisions: docs/reviews/ kept private at launch (launch checklist step); Touch ID after v1.0 (hardening.md, SPEC); v1.0 platforms macOS and Linux (README, SPEC)
- [x] Checkpoint: full suite, 889 of 889 (883 before, 6 new), 0 skipped (before the Codex fixes)
- [x] Codex review loop (fix HIGH only), round 1 includes the track-2 cooldown-entry fix (`src/cooldown.ts`, "active waits are never dropped")
  - [x] Round 1 (`docs/reviews/2026-10-31-v09-client-trust-round-1.md`): HIGH 3, MEDIUM 5, LOW 1. (1) Fixed with a test: `--max-old-space-size` is process-wide and overrides worker threads' `resourceLimits` (measured: 64 MB asked, 1,072 MB given), so the re-exec ceiling lifted every parser worker's 512 MB cap; the ceiling is now an in-process watch after each full garbage collection, no flag, no second process (`src/ceiling.ts`; the test starts `tiresias mcp` and checks a worker asking for 64 MB still gets under 200 MB, and floods it to the ceiling). This also designs away MEDIUM 6 (no supervisor when already capped) and MEDIUM 7 (parent-death race). (2) Fixed with a test: NFKC on a whole answer on the main thread is not linear; NFKC is dropped (every canonical step is now a linear scan) and the raw check runs in the parser worker under its time budget, failing closed (a check that cannot finish withholds the answer) (`src/echo.ts`, `src/work.ts` op `echo`, `src/formflow.ts`). (3) Cooldown memory under many sequential hostile origins: **STOPPED, not fixed** (below). MEDIUM 8 and LOW 9 were wording in `docs/docker.md` and the Dockerfile, fixed at once (every runnable `docker run` line carries the limits; rendering says `not_allowed` while off). MEDIUM 4 and 5 deferred below
  - [x] Round 2 (`docs/reviews/2026-10-31-v09-client-trust-round-2.md`): **HIGH 0**, MEDIUM 3, LOW 0: the loop ends. Codex confirmed both round-1 HIGH fixes (a worker asking for 64 MB gets 112 MB under the new ceiling) and the Docker wording and digest. The two round-1 MEDIUMs on the matcher were raised again (still deferred); one new MEDIUM deferred below
  - **Cooldown memory stopped under the two-fix rule (closed by design 2026-10-31: Travis approved the bounded store, built below).** Hardening round 6c (the in-process cooldown map never shrank: fix 1, drop expired entries past 10,000), round 7c (dropping a live wait is unsafe: fix 2, only expired ones are dropped) and now client-trust round 1 (live waits from many distinct hostile origins still grow without a bound) are the same HIGH surviving two fixes. Not fixed; decision wanted (For Banks). Context: each entry is a few hundred bytes and needs a separate site answering 429/503, so a gigabyte takes millions of sequential reads of attacker sites; with the new ceiling the end state is a clean exit, not a machine out of memory. Proposed structural fix, not built: past 10,000 live entries, keep further waits in a fixed-size "max sketch" (for example 1 M slots of 8 bytes, 3 hashes per origin, each slot holding the latest deadline written to it; a lookup takes the smallest of its 3 slots). Fixed memory (8 MB), never forgets a live wait, and a collision only makes Tiresias wait longer for an unrelated site (fails closed). Or: accept it as covered by the ceiling and SECURITY.md's caps wording
- [x] Cooldown store (Travis approved, 2026-10-31): the fixed-size store for waits past the in-process list (`src/cooldown.ts`), tests (`src/test/cooldown-store.test.ts`, 1 new; the round-7c assertion in `hardening.test.ts` updated: the list now stays bounded), SPEC section 9 row
- [x] Codex round 3, on the cooldown store only (`docs/reviews/2026-10-31-v09-client-trust-round-3.md`): **HIGH 0, MEDIUM 0, LOW 1.** The LOW (the test's checks would pass from the shared file alone) was a test gap and closed at once: the test now removes `cooldowns.jsonl` before checking, and a mutation (the store answering nothing) makes it fail
- [x] Full suite after the cooldown store: 891 tests (890 before, 1 new), 890 pass, 0 skipped; the 1 failure was the Chrome render test "W-10: a JavaScript page renders" (the render was stopped under the full run's load and the read fell back to plain, as in track 1), and `render.test` alone passes 18 of 18 at the same commit
- [x] Full suite at the end of the first loop: 890 of 890 (883 before; 7 new: 5 in `src/test/ceiling.test.ts`, 2 in `forms.test.ts`; 7 older tests rewritten from masking to withholding), 0 skipped
- [x] Secret scan (0 matches for all five patterns), push `v0.9`, report to Banks

## Design calls (with reasons)

### A1. The MCP client is trusted not to flood its own server

The MCP client is the AI app that starts `tiresias mcp` and talks to it over standard input and output (Claude
Desktop, Claude Code, Cursor...). It is a program the owner installed and runs as the owner. From now on:

- **Trusted:** the client itself, for resource use. Floods of calls, huge messages, not reading answers: if only the
  client can cause it, it is an ordinary bug (fix when convenient), not a HIGH.
- **Untrusted, as before:** websites, servers and files; and the agent's tool calls. A prompt-injected agent calls
  tools normally through the client, one call at a time as the model decides; anything it can do that way to
  exhaust memory or hang Tiresias is still a HIGH. The difference is that an agent cannot make its client stop
  reading answers, send malformed JSON-RPC, or send thousands of calls at once: those are the client's behaviour.
- **Every limit already built stays** (8 calls at once, 32 waiting, argument caps, 64 open requests, stdio
  backpressure, worker and render slots): they are cheap and they also protect against a buggy client.
- **Docker closes the remaining gap** for owners who do not trust their client (below), and the built-in ceiling
  makes the worst case a clean exit instead of a machine running out of memory.
- **Section 9 row: W-33** (the next free W-number, a new want: "a server that stops cleanly at its own memory
  ceiling, and runs in Docker for owners who want a hard box"). W-32's neighbour would have mixed a settings gate
  with a process limit, which are separate things to read about.

### A2. Built-in memory ceiling

- **Mechanism (after Codex round 1): the server watches its own heap.** After every full garbage collection
  (`perf_hooks` "gc" entries of kind major) `tiresias mcp` reads `v8.getHeapStatistics().used_heap_size`; once that
  is over `TIRESIAS_MEMORY_MB`, it writes one line to stderr, records a history entry, and exits 1 through the usual
  shutdown (calls and background jobs cancelled, leases removed; a timer forces the exit if that cleanup cannot
  finish). A one-second timer also stops it if the heap is ever 1.5 times the ceiling between collections. Reading
  after a full collection measures what is really held, not garbage waiting to be collected, so an honest burst does
  not trip it.
- **Why not Node's `--max-old-space-size`** (the first build re-executed `tiresias mcp` with it, under a supervising
  parent): Codex round 1 found, and a check here confirmed, that the flag is process-wide and overrides worker
  threads' own `resourceLimits`: a worker asking for 64 MB got 1,072 MB under `--max-old-space-size=1024`, so every
  page-parser worker's 512 MB cap would have risen to the ceiling. SPEC already noted the override (2026-10-16 row).
  `NODE_OPTIONS` and a launcher flag have the same effect, and a `#!/usr/bin/env -S node ...` line also needs `env
  -S`. The in-process watch keeps the worker caps as they are, needs no second process (so no parent-death or
  startup races, Codex round 1 MEDIUM 6 and 7, are designed away), and the dying process itself writes the message.
  V8's own default heap limit (about 2 GB on this Mac, up to about 4 GB on larger machines) stays the hard stop.
  The owner's own `NODE_OPTIONS=--max-old-space-size` still works but also lifts the worker caps; the docs say so.
- **Only `tiresias mcp`** gets the ceiling. It is the one long-running process an outside program drives; the other
  commands are one call each and end on their own.
- **Setting: `TIRESIAS_MEMORY_MB`** (an environment variable, set in the MCP client's `env` block), default 1024,
  from 256 to 65536, or `off` to skip it. Not a `config.json` setting: it belongs to the process, not to a profile,
  and is read once at start. Not a risky setting under W-32: it gives nothing more reach. A value that is not valid
  stops `tiresias mcp` at once with a message naming the variable, like every other `TIRESIAS_*` variable.
- **Why 1024 MB:** the main heap holds at most 8 calls at once, each with a response of at most 5 MB (the default
  `TIRESIAS_MAX_BYTES`) plus its text, outline and JSON reply, a file of up to 50 MB being inspected, and arguments up
  to 8 MB; parsing, PDFs and rendering happen in workers and child processes with their own caps (512 MB per parser
  worker, 1024 MB per PDF child), outside this heap. A worst-case honest load is a few hundred MB, so 1024 leaves
  room, and it is half of Node's own default on this Mac (2,096 MB, measured), so a flood stops well before the
  machine suffers. Measured: the idle server's heap is 17 MB (83 MB resident).
- **The message:** `Tiresias stopped: the MCP server reached its memory ceiling (1024 MB, TIRESIAS_MEMORY_MB).
  Nothing was lost; your AI app can start it again.`; the history entry is `tool: "server"`, `event:
  "memory_ceiling"`, `memory_mb`, listed by the daily log under "Server stopped". Private mode writes no record.
- **Honest limits:** the ceiling is the main process's JavaScript heap, checked between steps: one synchronous
  allocation burst inside a single call can pass it before the check runs, up to V8's own limit (each call's inputs
  are capped, so the burst is bounded). Memory outside the heap, workers and child processes have their own caps.
  Docker's `--memory` caps everything together.

### A3. Optional Docker

- **Base:** `node:22.23.4-bookworm-slim` pinned by its multi-arch digest
  (`sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da`, Docker Hub, 2026-10-28), the official
  image. Two stages: build (`npm ci`, `tsc`) and run (`npm ci --omit=dev`, `dist`, the canvas stub). `.npmrc`
  (install scripts off) is copied in, so no package runs code at install, as on the owner's machine.
- **Rendering is off in the container** (no Chrome is installed). Reasons: Chrome's sandbox needs privileges a
  hardened container takes away (user namespaces or `SYS_ADMIN` and a custom seccomp profile), and SPEC section 9
  (2026-10-31) says Chrome's sandbox stays on: Tiresias never runs Chrome with `--no-sandbox`. Loosening the
  container to make room for Chrome would undo the point of the container. It would also add about 350 MB and a
  second apt source. With no Chrome, a read that asks to render says `render.status: "not_allowed"` while rendering is off (the default) and `"unavailable"` once the owner turns it on, which Tiresias
  already does on any machine without Chrome. Everything else works: pages, PDFs (Linux reads `/proc`), files,
  forms, receipts, signing.
- **`docker run` line:** `-i --rm --init`, `--memory 2g --memory-swap 2g`, `--cpus 2`, `--pids-limit 256`,
  `--read-only`, `--tmpfs /tmp`, `--cap-drop ALL`, `--security-opt no-new-privileges`, user `node` (uid 1000, set in
  the image), and a named volume `tiresias-store` at `/home/node/.tiresias` (the same store format and path layout as
  `~/.tiresias`). Why 2 GB: the 1024 MB heap ceiling still runs inside, and parser workers and PDF children need room
  of their own; the container limit is the hard box around all of it.
- **Same commands:** the image's entry point is `node dist/cli.js`, default command `mcp`, so
  `docker run ... tiresias read <url>` and every other command work as on the machine. Nothing in Tiresias changes
  for Docker.
- **Not built or run here:** Docker is not installed on this Mac and is not installed by this track (Docker
  Desktop has licence terms). The Dockerfile was checked by reading; building and running it once is for Banks.

### B. Echo secrets withheld (Travis: "if a web site is sending back secrets... that is kind of on them and we can just try to not see it. B")

- **What is checked:** after a form is sent with a permission slip, the site's answer (the decoded body bytes, the
  final URL, every response header name and value) is checked ONCE, before it is parsed, for any secret Tiresias
  knows for this call: the form's hidden values and the values of the cookies the site set during this call (with
  and without quotes). Only values of 6 characters or more are checked.
- **How it matches (one canonical form, not a list of spellings):** both the answer and each secret are brought to
  the same form: HTML character references decoded (named, decimal, hex, any case), percent escapes decoded (any
  case, `+` as a space), JSON `\uXXXX` and `\/` escapes decoded, repeated up to three times for nested encodings;
  then lower-cased, and whitespace, quotes and backslashes removed. A secret is found when its canonical form is in
  the answer's canonical form, or its plain lower-cased form is in the answer's plain lower-cased form. Erring toward
  a hit costs one withheld answer; a miss would hand a secret on.
- **On a hit, the answer is withheld:** the reply says the form was sent, the HTTP status and the answer's size, with
  `form.reason: "secret_withheld"` and a fixed message; `untrusted_content` is `null` (not even the final URL); no
  receipts, file record or shelf entry are recorded or returned; nothing is cached (a form answer never is). The
  record of the form sent (`receipts`, kind `form`) is still written, as for every submit: it holds what Tiresias
  sent, not the answer.
- **Three places, one matcher:** (1) the raw answer at the top of `afterSubmit` (headers except `Set-Cookie`, the
  final URL, the decoded body, a PDF's or a held file's raw bytes as Latin-1, the declared type and name), before any
  parse; (2) what was built from it (the outline, text and receipts, a file's inside: Office text and zip names)
  before any receipt is recorded, which catches what only appears once decoded (a PDF's text, an Office file's
  compressed text, a value split by tags); (3) the whole reply after the call, which covers error replies after the
  request left (a cut-off answer, a redirect's address).
- **`Set-Cookie` is left out of the check:** Tiresias never passes it on, and a site commonly re-sends the same
  session cookie with its answer, which would withhold nearly every answer for nothing.
- **Masking is removed** (`maskDeep`, `[hidden value]`): no spelling is ever rewritten in a reply again. The receipt
  filter that withheld a quote holding a secret is no longer needed (the answer is withheld whole) and is removed.
- **Short values stay unchecked** (the SPEC's under-6 rule stands; (b) does not make it moot): a check for a 1 to 5
  character value would withhold nearly every answer (`"1"`, `"en"`, `"true"`), and a value that short is no secret.
- **Honest limit, stated in SECURITY.md:** an echo in an encoding Tiresias does not decode (base64, a hash, a value
  split over several places) is not detected; per Travis that is the site's own doing. Echo detection moves from
  the HIGH list to "best effort, withheld when seen".

### C. Small decisions (Travis, 2026-10-31, all yes)

- **`docs/reviews/` stays private at launch.** Nothing is deleted now. The launch checklist (hardening.md "For
  Travis" item 6 and the SPEC v1.0 row) gets a step: before the repo is made public, move `docs/reviews/` to a
  private archive repo (for example `Raibit-AI/tiresias-reviews`) with `git mv` into a new repo or a copy, remove it
  from the public repo in one commit, and check that no history rewrite is needed (the reviews have been in history
  since v0.1, so making the repo public would still show them in old commits: the step is either a fresh public repo
  from a squashed tree, or `git filter-repo` on a copy; the choice is the launch-day step's, and it is written there).
- **Touch ID for permission slips: after v1.0** (a v1.x want), marked in hardening.md's structure-review table and
  the SPEC.
- **v1.0 platforms: macOS and Linux.** Windows is not yet supported (PDFs cannot be read there; the scanner and
  translator do not run there). README and SPEC say so.

## For Banks

- **Build and run the Docker image once** (Docker is not on this Mac): `docker build -t tiresias:0.9 .`, then the `docker run ... mcp` line in `docs/docker.md` with an MCP `initialize`, and `docker run ... read https://example.com --text`. Check that the store lands on the volume and the container runs as uid 1000 with a read-only root.
- **Fold into SPEC:** the rows were added in section 9 (W-33 and four 2026-10-31 rows) as asked; section 10's v0.9.0 entry is the coordinator's.

### D. The fixed-size cooldown store (Travis approved, 2026-10-31)

- The in-process list holds at most 10,000 waits (`MEM_MAX`). When it is full of waits that have not ended, after
  dropping expired ones, a new wait goes into a fixed-size store: 1,048,576 deadlines of 8 bytes (8 MiB), made on
  first use. Each origin maps to 3 slots by HMAC-SHA-256 under a random key made when the process starts, so a site
  cannot choose names that land on another site's slots. Writing keeps the later deadline in each slot; reading
  takes the earliest of the origin's 3 slots.
- **Never forgets, never shortens:** every slot of a stored origin holds at least its deadline, so a lookup is never
  earlier than the wait the site asked for. **Errs toward waiting longer:** when other origins fill all 3 of a site's
  slots, that site reads as waiting until the earliest of them, longer than asked or a wait it never asked for.
  With 3 slots in a million, about 1 unrelated site in 45,000 reads as waiting when 10,000 waits are in the store, and
  about 1 in 65 at 100,000; past that the store fills and more sites read as waiting, which is the fail-closed
  direction.
- An origin name over 400 characters goes straight to the fixed-size store, so the list stays bounded in bytes too.
- Whether a new line goes to `cooldowns.jsonl` is decided from exact sources only (the list and the file), never the
  store, because a collision could make the store answer later than the truth and the line would then be missing
  for other processes.
- Memory: at most 10,000 short entries plus 8 MiB, whatever the number of sites. Lookups and writes are 3 slots each.

## Log

## Deferred to compute-day sweep

| Round | Severity | Summary | File | Fix or design away |
|---|---|---|---|---|
| 2 | MEDIUM | The ceiling's garbage-collection callback reads the heap when it runs (Node delivers it on a later turn), not at the end of the collection, so allocations in between can count; an earlier collection under the ceiling could then stop the server on short-lived use | src/ceiling.ts | Fix: stop only when two readings in a row after full collections are over the ceiling (or read `v8.getHeapSpaceStatistics` in the callback and require the old space alone to be over); say in the docs that the reading is taken just after a collection |
| 1 | MEDIUM | A secret of 6 or more characters whose canonical form is shorter than 6 (quotes, backslashes, `+` removed) loses its canonical check, so an encoded spelling of it is caught only if it also appears plainly | src/echo.ts `secretsOf` | Fix: apply the 6-character rule to the original value only; keep any non-empty canonical form (and treat an empty one as matching nothing but log it) |
| 1 | MEDIUM | Numeric character references with more than 6 hex or 7 decimal digits (leading zeroes) and named entities outside the table are not decoded by the matcher though the HTML reader decodes them; the post-parse check then sees content already cut to its preview, so a long secret's prefix could pass | src/echo.ts `decodeOnce`, src/formflow.ts | Fix: allow leading zeroes in numeric references and use the reader's own entity table (htmlparser2's `entities` package, already a dependency); run the post-parse check on the full extracted text before previews and paging |
