# v1.1 security deep dive: findings

Source: nine read-only Codex audits, one per guarantee in SECURITY.md plus the misled-agent review
(`docs/reviews/2026-11-01-v11-audit-*`, private), triaged by Claude on 2026-11-01. Duplicates merged:
5.6 = 9.3 (cooldowns forgotten), 6.1 = 9.2 (GET side effects). 21 distinct items.

Codex first refused all nine runs when they were briefed as attacks ("flagged for possible cybersecurity risk");
the same work briefed as a defensive audit of our own guarantees ran with no refusals.

## Decisions (Travis, 2026-11-01, all four as recommended)

- **D1, GET side effects (6.1, 9.2):** honest wording. Permission slips gate sending forms; reading a link is a read,
  as in every browser. A site that changes something on a plain GET breaks HTTP's rule that GET is safe (RFC 9110
  9.2.1), and that is on the site, the same reasoning as the echoed-secret decision (2026-10-31). SECURITY.md says so.
  One guard is still added: a rendered page's own scripts may not request a URL that matches a GET form action on
  that page.
- **D2, private calls and spacing (5.2):** private calls and form previews take part in cross-process spacing and
  write the minimal politeness state it needs (origin and times only, nothing about the page), the same exception
  private mode already makes for Retry-After. Obeying sites comes first.
- **D3, hook environment (7.1):** the scanner and translator hooks keep inheriting the owner's environment, minus
  Tiresias's own secrets (`TIRESIAS_WEB_RISK_KEY` and any other `TIRESIAS_*` variable that holds a secret). Refines
  the SPEC row that let hooks inherit the environment.
- **D4, text views (1.1):** `--text` views and the default Markdown `log` and `needs` output stay readable for
  people; each marks where web-derived text begins ("web content below is untrusted") and the docs say agents should
  use the JSON output, which keeps `untrusted_content`.

## The four decisions are settings (Travis, 2026-11-01: "save all these choices for settings. I just labeled what it comes out of the box.")

Each choice above is the default; the owner can choose the other option. Owner-only, like every setting: the
command line or config.json, never MCP. An option that loosens a protection is a risky setting (W-32): it needs the
all-caps confirmation, is logged, and shows in replies. Shown in `tiresias settings`.

| Setting | Default (Travis's pick) | Other option | Loosening? |
|---|---|---|---|
| `get_form_actions` | `read`: a URL is read normally even if it matches a GET form action (D1) | `slip`: reading a URL that matches a GET form action seen on the page it came from needs a `submit_form` slip, like sending the form | no (tightens) |
| `private_spacing` | `shared`: private calls and previews take part in cross-process spacing, writing origin and times only (D2) | `none`: private calls write nothing, and private reads in separate processes are not spaced against each other | yes: confirmation |
| `hook_secrets` | `hidden`: hooks never receive Tiresias's own secret variables (D3) | `inherit`: hooks receive the full environment, as before v1.1 | yes: confirmation |
| `text_views` | `marked`: readable, with a marker where web content begins (D4) | `wrapped`: web text in text views is wrapped the way JSON wraps it | no (tightens) |

## Items

| # | Area | Severity (Codex) | Item | Fix |
|---|---|---|---|---|
| 1.1 | data | HIGH | CLI `--text`, default `log` and `needs` print web text without the wrapper | D4 |
| 2.1 | code | HIGH, plausible | `--allow-worker` in the PDF child lets a worker read files the child cannot | move the watchdog out of the child, drop `--allow-worker`; test with a worker probe |
| 2.2 | code | MEDIUM | small calendar files are parsed inline, without the worker budget | always use the worker for calendars |
| 4.1 | network | HIGH, plausible | the Web Risk request skips the private-address and port checks | guarded lookup, literal and port checks in `boundedGet` |
| 5.1 | rules | HIGH | a robots.txt redirect can request another origin's forbidden path | follow a cross-origin robots redirect only to that origin's own `/robots.txt`; anything else fails closed (site says no) |
| 5.2 | rules | HIGH | private calls and previews skip cross-process spacing | D2 |
| 5.3 | rules | MEDIUM | Retry-After on a redirect is ignored | obey it before following, pages, robots and rendered |
| 5.4 | rules | MEDIUM | Crawl-delay over 30 s is stored as 30 | keep the full learned delay; decline when the wait exceeds the budget |
| 5.5 | rules | MEDIUM | merged robots groups keep the first Crawl-delay, not the longest | keep the maximum applicable delay |
| 5.6 | rules | HIGH | an active Retry-After is forgotten once it falls outside the cooldown log's last 8 MiB | durable state for unexpired waits; fail closed if it cannot be read |
| 6.1 | forms | HIGH | GET form actions reachable through `read`, preview and rendered fetches | D1 |
| 6.2 | forms | HIGH | "Pay now", checkout and purchase forms without card fields are not refused | payment and purchase action markers |
| 6.3 | forms | HIGH | passwordless sign-in forms are not refused | sign-in action markers and `autocomplete="username"` |
| 6.4 | forms | HIGH, plausible | a slip can expire or be revoked while its claimed submit waits in the queue | recheck the slip right before sending |
| 7.1 | secrets | HIGH | hooks inherit `TIRESIAS_WEB_RISK_KEY` | D3 |
| 7.2 | secrets | MEDIUM | echoed secrets in Office answers checked only after shortening | check the full extracted text first |
| 7.3 | secrets | MEDIUM | PDF title shortened before the echo check | check full decoded metadata first |
| 8.1 | caps | HIGH | outline building can block the event loop for ~17 s | bound receipt work before building; `page_too_complex` |
| 8.2 | caps | HIGH, plausible | rendered requests' headers retained in memory while waiting | keep only bounded fields; bound outstanding metadata |
| 8.3 | caps | MEDIUM | history and receipt scans ignore cancellation | pass the signal and a deadline into `pageLog` |
| 9.1 | agent | HIGH | agent-chosen bookmark names appear in top-level `attention` from `watch` | move them inside `untrusted_content` |
| 9.4 | agent | MEDIUM | MCP `resume` text is recorded as provided by a person | record `provided_by_agent` for MCP-supplied content |

## Deferred to compute-day sweep

All seven fixed in the compute-day sweep of 2026-11-06 (Fixed column).

Codex r1 on `keys rotate` (f21d6a3, 2026-11-06): 0 HIGH, 4 MEDIUM, 3 LOW. Per the round budget (fix HIGH mid-week), all seven wait for the Thursday sweep. Full report: `docs/reviews/2026-11-06-v11-keys-rotate-codex-r1.md`.

| # | Severity | Item | Where | Fixed |
|---|---|---|---|---|
| K.1 | MEDIUM | a concurrent `keys show` can mistake the just-kept previous key for an interrupted rotation and delete it, so a second rotation then loses it | `src/keys.ts:433` | Fixed in the compute-day sweep commit ("v1.1: compute-day sweep, Codex K.1 to K.7"): lock around rotate, --finish and every previous-key cleanup, plus a second look before deleting |
| K.2 | MEDIUM | an interruption between linking and unlinking the previous-key temp file leaves an old private key copy that `--finish` never removes | `src/keys.ts:406` | Fixed in the compute-day sweep commit ("v1.1: compute-day sweep, Codex K.1 to K.7"): leftover previous-key temp files swept by rotate, --finish and window expiry |
| K.3 | MEDIUM | two concurrent slip rotations can retire only the first key, so a page signed in between with the middle key stops verifying; needs a lock and a current-key recheck | `src/keys.ts:661` | Fixed in the compute-day sweep commit ("v1.1: compute-day sweep, Codex K.1 to K.7"): slip rotation lock plus a recheck that the retired key is still current |
| K.4 | MEDIUM | slip rotation revokes every slip before the synced-folder refusal, so a refused rotation still destroys the slips; check first | `src/slips.ts:521` | Fixed in the compute-day sweep commit ("v1.1: compute-day sweep, Codex K.1 to K.7"): every refusal runs before any slip is revoked |
| K.5 | LOW | past 1,000 retired slip keys the oldest is dropped without a warning | `src/keys.ts:663` | Fixed in the compute-day sweep commit ("v1.1: compute-day sweep, Codex K.1 to K.7"): all retired keys kept (cap 100,000, then rotation is refused, never a silent drop) |
| K.6 | LOW | tests check the key file instead of an actual signed request, and test retired-key refusal after deleting every slip | `src/test/v11-keys-rotate.test.ts:59, 275` | Fixed in the compute-day sweep commit ("v1.1: compute-day sweep, Codex K.1 to K.7"): tests sign a real request after rotation, and check a retired-key slip that still exists |
| K.7 | LOW | SECURITY.md omits that an exposed (0644) slip key is replaced without keeping its public half, so its saved pages stop verifying | `SECURITY.md:111` | Fixed in the compute-day sweep commit ("v1.1: compute-day sweep, Codex K.1 to K.7"): SECURITY.md names the exposed-key exception |

Codex r2 on the K fixes (98c58d4, 2026-11-06): K.1 to K.7 confirmed fixed; 0 HIGH, 1 MEDIUM, 1 LOW, deferred to the next sweep. Report: `docs/reviews/2026-11-06-v11-keys-rotate-codex-r2.md`.

| # | Severity | Item | Where |
|---|---|---|---|
| K.8 | MEDIUM | `keys init --force` replaces the key and deletes the previous key without taking `ed25519.rotate.lock`, so a concurrent rotation's kept key can be deleted (FIXED 2026-11-09: init holds the rotation lock and sweeps leftover temp copies) | `src/keys.ts:365` |
| K.9 | LOW | a lock left by a crashed rotation is never recovered if its pid is reused by another process (no start-time or boot id in the owner token) (FIXED 2026-11-09: the lock records its owner's kernel start stamp; a live pid whose stamp differs, read in the same scope, is a different process and the lock is recovered; the wall clock is never used and anything unclear counts as alive. Codex rounds 3 to 7, last one clean: `docs/reviews/2026-11-09-v11-k8-k9-codex-r3-r7.md`) | `src/savedlock.ts:14` |

Codex r1 on the attack lab (df98aeb, 2026-11-06): 0 HIGH, 4 MEDIUM, 2 LOW, all about tests too weak to prove their guarantee (no product bug found). Deferred to the next sweep; until fixed, "every attack held" is unproven for these six. Report: `docs/reviews/2026-11-06-v11-attack-lab-codex-r1.md`.

| # | Severity | Item | Where |
|---|---|---|---|
| L.1 | MEDIUM | form tests submit a fake preview hash, so they stop at `form_changed` and never reach the slip check; preview first, assert `no_slip` (FIXED 2026-11-06) | `src/test/v11-attack-lab.test.ts:104, 157` |
| L.2 | MEDIUM | the echo test would pass if the answer were kept with only the token redacted; assert no content and no receipts (FIXED 2026-11-06: no content, no receipts) | `:149` |
| L.3 | MEDIUM | Office bomb and calendar tests don't prove the inflate refusal or the event cap (FIXED 2026-11-06: high_ratio flag and tiny text asserted; events bounded with the rest counted as omitted) | `:115` |
| L.4 | MEDIUM | slow-drip passes on any early error; assert the route was reached and the cancel happened mid-body (FIXED 2026-11-06: route reached, body bytes sent before the cancel) | `:139` |
| L.5 | LOW | huge-headers test accepts `ok`; require the header-limit error (FIXED 2026-11-06: now requires `error`) | `:94` |
| L.6 | LOW | hard wall-clock limits instead of the repo's `timing()` helper; flaky on CI (FIXED 2026-11-06) | `:93, 114, 140` |

Codex r1 on attack lab round 2 (679235f, 2026-11-09): 0 HIGH, 6 MEDIUM, 2 LOW, all about tests too weak to prove their guarantee (no product bug found by the review). Strengthened on 2026-11-10 as recorded below; live Chrome validation remains pending on a runner that can start the browser. Sound as written, per Codex: PDF caps, `/es-news`, both `get_form_actions` tests, and the huge, large and deep JSON cases. Report: `docs/reviews/2026-11-09-v11-attack-lab2-codex-r1.md`.

| # | Severity | Item | Where |
|---|---|---|---|
| M.1 | MEDIUM | `/booby.pdf`: the probe counts the parent's memory check, not a child; inline parsing would still pass. Observe a distinct child pid finishing the parse (FIXED 2026-11-10: The real fork PID and its IPC answer carry an in-child parse completion observation.) | `src/test/v11-attack-lab.test.ts:221` |
| M.2 | MEDIUM | `/booby.pdf`: "payload absent from the reply" does not prove the attachment was never opened (read and discard passes). Instrument attachment access or use a fixture that fails if decoded (FIXED 2026-11-10: The PDF child observes attachment APIs and embedded stream construction before content access or decoding.) | `:234` |
| M.3 | MEDIUM | `/render-clicks`: the blocked-counter floors are met before the form submits and the location change run; require a completion marker and evidence per attack. `window.open` hits the product's own no-op, so popup blocking is not exercised (FIXED 2026-11-10: Each attack has its own render and completion marker with matching CDP refusal evidence; an activated popup link must create a target that Tiresias closes.) | `:282`, `src/test/lab/site.ts:323` |
| M.4 | MEDIUM | the render tests delete `TIRESIAS_CHROME` before deciding to skip, so a Chrome that exists only at the configured path skips them; keep the configured path, and run them in at least one Chrome-equipped CI job (FIXED 2026-11-10: Both test files retain configured Chrome paths, restore temporary overrides, and the Linux CI job requires Chrome.) | `:19` |
| M.5 | MEDIUM | `/wall-hop`: `noLeak()` exempts the whole `url` field, so the hostile final address could leak there; assert `r.url` equals the request (FIXED 2026-11-10: The wall reply URL must equal the original wall-hop request.) | `:322` |
| M.6 | MEDIUM | long JSON string: only the first two pages and `pages > 100` are checked; a silent cut to 1,000,000 characters passes. Check the end, the total length and the omission count (FIXED 2026-11-10: Every JSON page is reconstructed and checked against the full fixture, including its tail, length and zero omissions.) | `:457` |
| M.7 | LOW | the PDF Launch trap needs Windows `cmd.exe`; zero network hits on macOS/Linux does not prove no launch was attempted (FIXED 2026-11-10: The PDF child records process start attempts before permission or missing executable failures.) | `site.ts:225`, `:231` |
| M.8 | LOW | the whole `/sw-news` test is todo, so its working containment checks are non-blocking too; split it, leaving only the missing-flag line as todo (FIXED 2026-11-09 with P.1: the whole test is now blocking) | `:366` |

Product gap found by lab round 2 (builder, confirmed real by Codex r1), approved for fixing by Travis on 2026-11-09:

| # | Severity | Item | Where |
|---|---|---|---|
| P.1 | FIXED 2026-11-09 | Successful machine translations are scanned by the existing shield; findings stay inside the reply, with fixed top-level codes and untrusted snippets labelled by location. | `src/translate.ts` |

Builder's notes, untested: a script that fires its navigations while the page is still loading makes the render run to its 20 s timeout before the safe fallback (slow, nothing gets through).

P.1 fix (2026-11-09): written by Codex, reviewed by Banks (no blocking findings). Banks's notes for the sweep: (a) translation findings are reply-only, so the owner's daily log and history never show them (Codex's deliberate choice, in line with "translations are never stored"); (b) up to 30 capped findings stay in a reply whose translation was dropped for size, so a reply already within a few KB of the 100,000-byte limit could exceed it and fall to the MCP size guard (`src/mcp.ts:47`); not tested.

Flaky test seen on the full run of the P.1 fix (2026-11-09, machine under load 5.6): `review-fixes.test.ts` "round 75: one answer at a time across processes" failed once (1135 of 1136), then passed 6 of 6 alone. It asserts a spawned Node process waited at least 400 ms of a 600 ms hold, which fails when that process takes over 200 ms to start. Unrelated to P.1 (`hosts.ts`).

| # | Severity | Item | Where |
|---|---|---|---|
| N.1 | LOW | wall-clock assertion on a child process's start-up time; measure from a "child is ready" signal instead (FIXED 2026-11-10: The hold begins after an IPC signal that the child has called acquireActive, with exclusion and eventual acquisition checked.) | `src/test/review-fixes.test.ts` (round 75 test) |
| N.2 | LOW | FIXED 2026-11-10: Refusing a main frame navigation before load makes Chrome abort the document load, so `Page.loadEventFired` never arrives and the render waited until timeout. A parsed document now settles after the normal quiet period, while an unparsed document gets a short grace before returning the plain read with reason `navigated`. | `src/render.ts`, `src/test/render.test.ts` |
| S.2 | LOW | FIXED 2026-11-10: Settlement now waits for every paused request handler, including live form checks and awaited refusal replies, and each handler refreshes activity when it finishes. | `src/render.ts` |
| N.3 | LOW | OPEN, test housekeeping only: test files and the fuzzer leave their temp folders behind (about 200,000 `tiresias-test-*` folders were found in the Mac's temp folder on 2026-11-10 after the fuzz nights and 80 days without a restart). Nothing the package ships is involved. Wanted: `freshHome()` and the fuzzer remove their folders on exit. Left for a later sweep; a restart clears the folder | `src/test/helper.ts:21`, `scripts/fuzz.mjs` |

2026-11-10 validation for M.1–M.7 and N.1: `npx tsc` passed. The requested serial attack-lab run attempted all 35 tests: 20 passed; the two PDF tests stopped at memory-watch setup because the sandbox denies `/bin/ps`, and all 12 render-clicks cases plus render-private stopped at Chrome startup (`browser_failed`; a direct launch exited with SIGABRT). Loopback listening worked. No tests were skipped or marked todo. A supplemental run using the existing `pdfproc.hooks.probe` with a constant memory reading passed both PDF tests; that stand-in validates the new observations and PDF caps but does not validate memory enforcement. Round 75 passed, including with a deliberately delayed 1.2-second child startup. The existing render.test.ts unavailable-browser and sandbox-arguments cases passed; its selected auto-render case hit the same browser startup barrier.

Mutation checks rejected inline PDF parsing, public attachment read-and-discard, internal attachment reading, direct embedded stream decoding, a caught cmd.exe spawn attempt, a hostile top-level wall URL, a silent JSON cut to 1,000,000 characters, and bypassing the cross-process lease. Configured-path-only gate checks passed for both test files and failed when Chrome deletion was restored. All mutations were reverted. Live render mutations could not run because Chrome cannot start here. No product source lines were changed and no new product failure was confirmed; render guarantees still require the Chrome-equipped CI run.

Banks's validation on the real machine (2026-11-10, macOS with Chrome, after the hour-long fuzz run ended): the attack-lab file 35 of 35 and `render.test.js` 27 of 27, nothing skipped; full suite **1147 of 1147**. So the "validation remains pending" notes above are closed: every strengthened test has now run for real.

## Fuzzing, v1.1 (2026-11-10)

Scope section 5 asked for fuzz targets on the MCP request layer and on form handling. Both are in `scripts/fuzz.mjs`
(`--targets mcp`, `--targets formflow`); the older `forms` target (the form parser alone) is unchanged. No product
code was changed.

**How they run.** Both targets speak raw JSON-RPC through an in-memory pipe to the real `createServer()`, so the SDK's
schema checks, the message guard (`guardTransport`), the call slots and every tool handler run as over stdio; each
message is first checked the way the stdio transport checks a line, and one it would drop is not sent. The network
is faked inside the fuzz worker: `http`/`https` `request` serve the fuzzed page and a 404 robots.txt and refuse
everything else, DNS `lookup` answers from a fixed table, and `net.Socket` connect throws, so nothing can leave the
machine. The fake calls the lookup Tiresias passes, as Node does. The worker sets Node's test-runner marker only so
the existing `TIRESIAS_HOST_SPACING_MS` seam can drop the 1 s per-site spacing; `TIRESIAS_ALLOW_PRIVATE` is unset.
These targets cannot run under Node's permission model: Node 22 refuses `fchmod` outright there, and the store calls
it on every write. So they run in a second process with a throwaway store, and the fuzz worker wraps every
file-system call that writes by path and refuses (and reports) one outside the store.

- **mcp**: 1 to 3 tool calls per input over all 18 tools plus unknown names: wrong types, missing and extra fields
  (`__proto__`, `constructor`), strings up to 9 MB, nesting up to 100,000 deep, 1,000+ element arrays and objects,
  odd Unicode, hostile URLs (private and loopback addresses in several spellings, a name resolving to a mixed
  public and private answer, `file:`, `javascript:`, `data:`, credentials, odd ports). Store tools run in full; a
  fetch is stopped at the connection after Tiresias's own checks.
- **formflow**: generated forms (half plain, half hostile: methods, actions, enctypes, field names and types,
  hidden values, option lists up to 5,000, nested, unclosed and doubled forms, CAPTCHA, labels in 14 languages, pay
  and sign-in look-alikes), sometimes byte-mutated, and a page that changes between preview and submit in 40% of
  inputs. Each input: a slip granted as the owner would (for the page's origin, the action's origin, another site,
  another path, or revoked after the preview) or none; `form_preview`; then `form_submit` with the preview's hash
  or a wrong one.

**Invariants, each a failure class with the input saved as JSON for `--replay`:** no crash, unhandled rejection or
uncaught exception (CRASH); a case under 10 s (OVER BUDGET) and an answer before 70 s (HANG); every tools/call
answer one text item holding an envelope with a known status, Tiresias's notice and `untrusted_content` (BAD REPLY
SHAPE); at most 100,000 bytes (OVER SIZE); no write outside the store (WRITE OUTSIDE THE STORE); no fuzz canary in
any top-level field but `untrusted_content` and the caller's own `url` echo, and no hidden value anywhere in a
preview (LEAK); no send from a preview, without a valid slip for the target's origin, or after a revoke (SENT
WITHOUT SLIP); no send with a hash the preview did not give or a request other than the one previewed (SENT CHANGED
FORM); one send at most (SENT TWICE); no connection to a private address (PRIVATE CONNECT); nothing reaching a real
socket (REAL NETWORK); and a control case per target that must reach the fetch or send seam (HARNESS UNREACHABLE).
`--self-test <name>` breaks one on purpose; every class above except HANG and SENT TWICE was broken once and
reported (HANG fired on a real input before the stdio check was added, below).

**Runs** (load average about 4, beside another job's fuzz run): seed 1, 60 s, 2,220 inputs; seed 20261110, 60 s,
2,175 inputs: no findings. Alone, about 36 inputs a second for mcp and 48 for formflow. Per 60 s run, about 1,100
formflow inputs reached the preview, about 100 previews were ok, and 27 and 33 submits reached the send seam with a
valid slip (blocked there, and matching the preview); every other submit was refused before it. The same seed gives
the same inputs (the run prints a fingerprint of the first 100). The parser targets, 20 s at seed 7, 700 inputs: no
findings.

**Observation, not a finding:** through the in-memory pipe, a `tools/call` whose `params` is `null` or an array got
no answer at all, and its id stayed in `guardTransport`'s open-request map (64 such calls would make the server
answer every later call "too many calls open"). Over stdio, the only transport Tiresias serves, the SDK drops such a
line before `guardTransport` sees it, so it is not reachable there; the harness now drops it the same way. Worth a
line if another transport is ever added.

**Codex r1 on the two new targets (6dfb444, 2026-11-10): 0 HIGH, 7 MEDIUM, 1 LOW**, all detection gaps in the harness (report: `docs/reviews/2026-11-10-v11-fuzz-targets-codex-r1.md`). All eight fixed the same night by Codex, reviewed by Banks: the private-address oracle covers normalised and special-purpose ranges; a GET send is recognised without a referer; SENT CHANGED FORM compares the whole previewed request; LEAK scans keys, content beside the envelope and intact hidden values; descriptor writes and outside reads are guarded; saved cases replay with their prefix; a one-use slip is submitted twice (SENT TWICE now has a self-test); `__proto__` keys are real own properties. Codex also confirmed the observation above (LOW over stdio; MEDIUM if another transport ever passes such messages through). Limits Codex named and Banks accepts for now: the fake network is a shim, not a sandbox (`dns.resolve*`, UDP and new workers are not covered), and the fake fails every send before `finish`, so the product's after-send path is not fuzzed.

**Hour-long run of the 20 parser targets** (2026-11-10 00:17 to 01:17, seed 1794287824, the pre-merge harness, machine under load from two other jobs): **156,980 inputs, no crash, no hang, no over-budget input, no out-of-memory worker, no write outside the store.** 28 findings, all `slow_inline diff`. Banks replayed all 28 saved inputs: the largest is 2,864 bytes, each parses in under 2 ms and diffs against itself in under 1 ms. Cause: the diff target timed two parses plus the diff but judged "small" by the first page alone, and the second page (up to 1 MB) was not saved. The product sizes a diff by both sides (`src/pipeline.ts:489`), so it would not run those inline. **A harness false alarm, not a product finding**; the exact slow pairs cannot be replayed because the second page was lost. Fixed in the harness (6aed74b, Codex, reviewed by Banks): each step is timed on its own under the product's size rule, both inputs are saved, and flow targets start fresh every 256 inputs so long runs stay bounded. 26 of 26 self-tests rerun by Banks.

## Final review of the branch (2026-11-10)

Codex r1 on the whole v1.1 branch against the last release (`docs/reviews/2026-11-10-v11-final-codex-r1.md`): **3 HIGH (blocking), 2 MEDIUM, 6 LOW (stale statements)**. All fixed the same night by Codex and reviewed by Banks, who sent the first version of R.2/R.3 back (below). Full suite after the fixes: **1173 of 1173** (Banks, macOS with Chrome).

| # | Severity | Item | Where |
|---|---|---|---|
| R.1 | HIGH | with `get_form_actions=slip`, an encoded spelling of a known GET form action (`/%76ote?choice=yes` for `/vote`) or a trailing-dot host needed no slip, and a rendered page's script could fetch it past the form-action guard: the checks compared raw path strings (FIXED 2026-11-10: one shared canonical comparison, `getActionTarget`, for the read path and both render checks; repeated decoding, case, dot segments, path parameters and trailing dots all fold to the same target, erring toward "same") | `src/getactions.ts`, `src/render.ts` |
| R.2 | HIGH | purchase confirmations ("Confirm order", "Complete order", "Order now") were not refused as payment forms (FIXED 2026-11-10: confirm/complete/submit/finish/finalize + order/purchase/payment, and "order now") | `src/forms.ts` |
| R.3 | HIGH | sign-in and payment forms in other languages ("Iniciar sesión", "Pagar ahora") were not refused: the action vocabulary was English only (FIXED 2026-11-10: vocabulary for the 12 other languages the shield covers. Unambiguous words match anywhere; ambiguous bare words such as "commander", "zahlen", "entrar", "买" count only as the whole text of a submit control) | `src/forms.ts` |
| R.4 | MEDIUM | `keys sign-directory` could publish a directory mixing key generations if a rotation finished between its reads (FIXED 2026-11-10: the pair is re-read until the current key is unchanged, else a plain "try again") | `src/keys.ts` |
| R.5 | MEDIUM | in private mode, observed GET form actions stayed in process memory for later calls (FIXED 2026-11-10: private observations, and the "full" latch, live only for the call) | `src/getactions.ts`, `src/context.ts`, `src/envelope.ts` |
| R.6 | LOW | six stale statements in `docs/SPEC.md` and two in `SECURITY.md` (the render cap falls back to the plain read; `--overlap 0` during an open overlap needs `--finish` first) (FIXED 2026-11-10, minimum factual changes) | docs |

**Banks's review of the first R.2/R.3 fix found a regression and sent it back.** Comparing refusals before and after with the real parser: the first version moved the action-word check onto block-joined text only, so buttons split across inline elements with no space (`<span>Pay</span><span>now</span>`, `<i>Buy</i>now`) went from refused to allowed. It also carried a carve-out ("login help", "comments" texts) that made two previously refused forms sendable; that carve-out came from a mistaken line in Banks's own brief and was removed. And bare foreign words matched anywhere, so an English "Commander name" label and a German "Zahlen und Fakten" label were refused as payment forms. The second version restores every earlier refusal (25 previously refused forms checked by test, plus Banks's own 16-case comparison), keeps the new coverage, and fixes the two false refusals.

**Open, the owner's decision (not applied): the promise at `SECURITY.md:50`.** It says "Sign-in, password, CAPTCHA, payment and purchase forms are never sent, slip or not." Recognition by wording can never be complete, so the sentence is stronger than the code can be. What is guaranteed is that no form is sent without the owner's permission slip covering that site and path. Codex's proposed replacement: "No form is ever sent without the owner's permission slip covering that site and path. Recognising and refusing sign-in, password, CAPTCHA, payment and purchase forms is best-effort in 13 languages: English, Spanish, French, German, Portuguese, Italian, Dutch, Russian, Chinese, Japanese, Korean, Arabic and Hindi." **Update 2026-11-10: Travis said to reword it. Applied in SECURITY.md (the promise bullet and a new bullet under "What Tiresias does not promise") and in the README forms section. The slip is now stated as the guarantee and recognition as best-effort in 13 languages.**

Known remaining false-refusal risks (Codex, accepted by Banks as the safe direction): a form that only mentions login or payment in a label is refused; Chinese, Japanese and Korean action words match inside compounds; an ambiguous word used as a whole button label for something else is refused.

**Codex r2 on the final-review fixes (f1b2116, 2026-11-10; `docs/reviews/2026-11-10-v11-final-codex-r2.md`): R.4 confirmed; 3 HIGH remained, one of them a regression introduced by the R.5 fix that Banks's review had passed.** Fixed the same night by Codex, reviewed by Banks (guard logic read line by line this time, plus a 31-form before/after comparison with the real parser). Full suite after these fixes: **1185 of 1185**.

| # | Severity | Item | Where |
|---|---|---|---|
| R.7 | HIGH | regression from R.5: with `get_form_actions=slip`, a private read skipped GET-action gates that ordinary calls had learned in memory, because the guard looked only at the private call's own (empty) set (FIXED 2026-11-10: the guard in every call enforces the union of this call's observations, shared memory and its full latch, and the disk record; private observations still never leave their call) | `src/getactions.ts` |
| R.8 | HIGH (while `SECURITY.md:50` says "never") | one ordinary word defeated the new phrases: "Confirm your order", "Place your order", "Confirmar mi pedido" (FIXED 2026-11-10 as a bounded rule: up to two filler words from a closed per-language list between the phrase parts) | `src/forms.ts` |
| R.9 | HIGH (same condition) | everyday labels still passed: "Jetzt anmelden", "Accedi con email", "Bestel nu", "Sign me in" and one or two per language (FIXED 2026-11-10: the word for "now" before or after an action word; a short closed-list complement after a whole-button word; the listed labels) | `src/forms.ts` |
| R.10 | MEDIUM | the folding in `getActionTarget` was not idempotent: NFKC could produce a fresh percent escape after decoding (`/%EF%BC%8576ote`) (FIXED 2026-11-10: the whole fold repeats to a fixed point; at 64 rounds it gives up and gates the whole origin; 6,000 idempotence cases and the 14 variant pairs in the suite) | `src/getactions.ts`, `src/render.ts` |
| R.11 | MEDIUM | the new form checks were slow on a heavy page: 20 forms sharing one long description went from 1.9 s to past the 5 s worker budget (it failed safe as `page_too_complex`) (FIXED 2026-11-10: phrases indexed by first word, each distinct text judged once, every text read is charged to the audit budget; 0.41 s) | `src/forms.ts` |

Proof that nothing loosened: a checked-in fixture of the parent commit's refusals over 6,000 generated forms (5,524 refused) is compared in the suite; all are still refused. Known gap, named by Codex: "Confirm the details of your order" is outside the bounded filler rule and still passes.

**The vocabulary loop stops here (Banks).** Two review rounds in a row found new misses in the same mechanism, and a third would too: wording can never recognise every purchase or sign-in button in every language. R.8 and R.9 are HIGH only because `SECURITY.md:50` promises "never sent, slip or not". The fix for that is the wording of the promise, which is the owner's decision (see above), not a longer word list. Until the owner decides, v1.1 is not tagged.

**Fuzzing after the final-review fixes** (2026-11-10, final harness): hour-long run of `mcp` and `formflow` on 97d4f28, seed 1794293473: **131,040 inputs, no crash, no hang, no send without a slip** (1,858 submits reached the send seam with a valid slip, each matching its preview); 5 `leak` flags, all the "hidden value shown" artefact (the page itself showed the text; the field stayed masked), each replayed clean through the location-aware check; 466 attempts by the product to fetch its phishing blocklist were stopped by the fake network, as designed. Diff, search and classify with the corrected timing, 600 s: 18,671 inputs, 0 findings. On 1c2fdd2 (after R.1 to R.6): `mcp` and `formflow` 900 s, 24,836 inputs, 0 findings; `forms`, `html`, `wall` 300 s, 6,182 inputs, 0 findings. Not yet fuzzed: the R.7 to R.11 code.

**Codex r3 on 96ce0a2 (2026-11-10; `docs/reviews/2026-11-10-v11-final-codex-r3.md`): no HIGH or blocking finding remains, setting aside the wording of `SECURITY.md:50`.** R.7 and R.11 confirmed; refusal preservation checked on 12,990 forms (all 11,608 previously refused still refused); no new false refusal on mainstream forms; no other regression. One MEDIUM, non-blocking, deferred to the compute-day sweep:

| # | Severity | Item | Where |
|---|---|---|---|
| R.12 | MEDIUM | FIXED 2026-11-10: after repeated decoding and normalization settle, the shared denial key keeps only Unicode letters and digits in each path segment and drops empty segments, closing the gap for embedded controls, whitespace and punctuation. Tab, line feed and carriage return are removed in every round because a URL parser removes them before it resolves dot segments and escapes. One key cannot model two servers that treat the same odd spelling differently, so the fold follows the URL Standard where they disagree. Segment boundaries, stable normalization and the 64 round origin wildcard remain intact; extra matches require a slip when the owner selects `get_form_actions=slip` or block a rendered script request matching a GET form action on that page. | `src/getactions.ts`, `src/render.ts` |

2026-11-10 after R.12: full suite on macOS with Chrome, 1187 of 1188; the one failure is N.2 above, which also fails on the commit before R.12. Codex wrote R.12 in two passes; Banks's review of the first pass found six spellings it missed (a tab, line feed or carriage return hiding a dot segment or a percent sign), all closed in the second pass. SECURITY.md and README now state the form promise as the code keeps it: the permission slip is the guarantee, recognizing sign-in, payment and purchase forms is best-effort in 13 languages (wording by Banks at Travis's request, 2026-11-10; Travis has the final say before the tag).

2026-11-10: Travis approved the reworded form promise in SECURITY.md and the README ("wording approved", in chat). The v1.1 CHANGELOG entry is drafted under Unreleased by Banks and waits for his read. Left before the tag: the Thursday sweep (N.2 and a fresh round).

## Compute-day sweep (2026-11-10, run early at Travis's word)

Codex round 4 on the branch at c3e2a88, report in `docs/reviews/2026-11-10-v11-sweep-codex-r4.md`: no HIGH, one conditional MEDIUM, one LOW, four LOW document mismatches, and a diagnosis of N.2 that matches what Banks measured on the Mac. R.12 held in every case it tried (54 pairs, 6,000 generated spellings, an 8 KiB nested path in about 1.7 ms, no way to make the wildcard fail open). Nothing new in form refusals, translation scanning or the rotation locks.

| # | Severity | Item | Outcome |
|---|---|---|---|
| S.1 | MEDIUM, conditional | with `get_form_actions=slip`, an address that a server routes to the same handler under a different name is not gated: `/vote.json` on Rails where the form said `/vote`, or `/cgi-bin/vote.cgi/extra` on Apache | DESIGNED AWAY, written down as a limit in SECURITY.md ("matches other spellings of an address, not every address"). Banks's reasons: (1) this is the fifth round on the same fold and the class has no end, since only the server knows its own routes; (2) the two repairs on offer both cost ordinary pages: folding a file extension makes a form to `/search` block that page's own `/search.js`, and matching path prefixes makes a form to `/search` block `/search/suggest`, because the same key is used for the always-on check of a rendered page's script requests; (3) the setting is an opt-in tightening on top of the default, where a GET is an ordinary read. Sending a form still always needs a slip |
| S.2 | LOW | a render could settle while a paused request was still being checked | FIXED with N.2 (Codex wrote it, Banks reviewed and ran it) |
| S.3 | LOW | SECURITY.md said "Tiresias never logs in" with no qualifier | FIXED: the line now adds that recognized sign-in forms are refused, that recognizing is best-effort, and that no session is kept (cookies last one call) |
| S.4 | LOW | README said a submit's answer is checked "once, as received" | FIXED: it is also checked as extracted text before anything is shown or recorded |
| S.5 | LOW | README said every marker word matches anywhere, even run together | FIXED: action words such as "buy" count only as whole words |
| S.6 | LOW | CHANGELOG draft repeated the old overstatement about purchase and sign-in forms, and described the Crawl-delay limit loosely | FIXED: "recognized and refused"; a Crawl-delay over 30 seconds is declined instead of shortened |

N.2 and S.2 (Codex fix, Banks review): measured cause, a main-frame navigation refused before the load event leaves Chrome without a load event, so the render waited its whole limit. Before the fix the hostile-page test failed 6 of 10 runs alone and the two new tests failed 3 of 3; after it, all three passed 36 of 36.

Codex round 5 (confirming, `docs/reviews/2026-11-10-v11-sweep-codex-r5.md`): no HIGH, MEDIUM or LOW finding. It confirmed the render fix, the S.1 limit and its reasons, and each document correction. One regression was caught by the full suite before that round and is fixed: the fix counts load events only after the page's own document is served, and the simulated browser in `v11-get-forms.test.ts` never served one, so that test timed out every time; Banks added the simulated document request (reviewed by Codex in round 5). Full suite on macOS with Chrome after everything: **1190 of 1190**, nothing skipped. The sweep is clean. Open: N.3 (test housekeeping, LOW).


## Release checks on the public repo (2026-11-10)

The release went up as a pull request on the public repo, so its CI and GitHub's code scanning (CodeQL) ran before the tag. Two things came out of that.

**A timing test failed once on the macOS runner (test only, fixed).** "round 78: ... spacing outlives 1,000 other sites" asked for at least 300 ms of wait after a loop over 1,000 other sites, which assumed the loop took under 700 ms. A slow runner left 292 ms. The spacing itself held. The test now measures from before the first request, so the bound does not depend on the loop.

**Code scanning: 44 alerts, read and triaged for the first time.** Scanning was turned on for the public repo on 2026-11-01 (workstream 3), but its alerts had not been read; 40 were open on `main` and this release added 4.

| Where | Count | What | Outcome |
|---|---|---|---|
| `src/test/` | 40 | test fixtures and local test servers: files written into a test's own temp folder (17 file-system-race, 2 insecure-temporary-file), test servers that echo or redirect to what was asked on purpose, and child scripts, markup and patterns built from the test's own values (2 reflected-xss, 1 redirect, 5 bad-code-sanitization, 4 sanitization, 1 URL substring, 1 regexp anchor), and lookups by request path (3 remote-property-injection, 4 unvalidated-dynamic-method-call) | Dismissed as used in tests. One was also tightened: the attack lab's server now looks up routes as own properties only (`src/test/lab/site.ts`). |
| `scripts/fuzz.mjs` | 2 | the fuzzer's self-test, which tries a write outside the store and a second open of `dist` on purpose, to prove its own guards catch them | Dismissed as used in tests. |
| `src/slips.ts` (`confirmTextFor`) | 1 | a slip file is checked with `lstat` and then read by name, so it could be swapped in between | Stated limit, no change: SECURITY.md already says a program running as you can swap a store file between a check and its use. The text read here is only what the owner types back to confirm a revoke. |
| `src/safety.ts` (`requestOnce`) | 1 | "outbound network request depends on file data" | By design, no change: this is the ordinary request path. What it sends from files is what any browser sends from its own store: the cache validators a site gave earlier (ETag, Last-Modified, sent back only to the address they came from), the addresses of cached pages and of bookmarks, the signature made with the signing key, and anchoring hashes. Codex looked for a route by which an MCP caller could pick a local file and have it sent, and found none. (Banks first gave the Web Risk key as the reason; Codex showed that lookup uses another function, and the reason here is the corrected one.) |

Codex checked both product-code calls and the two test changes (2026-11-10): no change needed for either alert, residual risk LOW for both, and both test changes sound. It noted that the reworked spacing test can pass without proving anything on a machine so slow that the 1,000 other sites alone take a second; on an ordinary machine it fails when spacing is forgotten (74 ms against 1,002 ms in its check).

No alert pointed at a way for a page, a file, a site or an agent to do anything. Nothing in the npm package changed because of them.
