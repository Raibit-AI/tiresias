# v0.7 Track 1: render (W-10, JavaScript-only pages)

Branch `v0.7`, from main `6bff90c` (v0.6.1, 802 tests passing). Decisions for the coordinator to fold into SPEC.md.

## Progress

- [x] Worktree `~/Code/tiresias-v07`, `npm ci`
- [x] Read SPEC (principles, section 5, W-10, decisions 2026-10-22 and 2026-10-23) and the v0.6 track plans
- [x] SkillSpector scan of `playwright-core@1.64.1`: not green (CRITICAL, 24 HIGH); stopped and reported (see "History of the engine decision")
- [x] Decision: **no new package; Tiresias drives the installed Google Chrome itself** (Travis, 2026-10-31, chat: "2")
- [x] Rebased on track 3 (W-26 translate, `baba3bd`, 811 tests): its shared-file list read first; rendered pages go through its language detection like any page
- [x] `src/cdp.ts`: the DevTools protocol over `--remote-debugging-pipe`, Node built-ins only, bounded messages
- [x] `src/render.ts`: finding Chrome, launch, request interception through the rules, caps, kill and cleanup
- [x] Owner setting `rendering` (config.json, `TIRESIAS_RENDERING`), `TIRESIAS_CHROME`; listed in `tiresias settings`; never from MCP
- [x] Read path (`src/pipeline.ts`): `render` option on MCP `read` and `read --render`; `auto` renders empty JavaScript shells; `check` re-renders a rendered copy
- [x] Reply (`render`), cache entry (`rendered`), history (`rendered`)
- [x] Tests (`src/test/render.test.ts`): 12, of which 8 need Chrome and are skipped by name without it (checked with `TIRESIAS_TEST_NO_CHROME=1`: 4 pass, 8 skipped)
- [x] README, CHANGELOG (unreleased v0.7.0), SPEC W-10 row and section 5 line
- [x] Full suite at the first checkpoint: 823 tests, 822 pass; the one failure (W-29: an MCP parameter may not share a name with a setting) was the setting being called `render` like the read option: renamed `rendering` (`TIRESIAS_RENDERING`)
- [x] Codex review loop (fix HIGH only; MEDIUM and LOW deferred below): stopped after rounds 3, 4 and 5 for Banks's decisions on the byte cap; resumed with the connection count in `safeFetch`; **round 6 clean (HIGH 0, MEDIUM 0, LOW 0): the loop ends**
  - [x] Round 1 (`docs/reviews/2026-10-31-v07-render-round-1.md`): HIGH 2, MEDIUM 4, LOW 2. Fixed both HIGH: (1) the byte cap is now a shared budget reserved before each request (`ByteBudget`: each request may read at most its reservation, 4 MB; unused bytes come back; files and failures are charged in full); (2) besides the process-group kill, every process whose command line names the render's profile folder is killed and waited for before the folder is deleted (`killStrays`; also on Tiresias's exit). Checked by hand on macOS 2026-10-31: with these flags Chrome starts no crash reporter, but the sweep no longer depends on that. Tests for both.
  - [x] Round 2 (`docs/reviews/2026-10-31-v07-render-round-2.md`): HIGH 1, MEDIUM 1, LOW 0. The HIGH is round 1's byte cap again (second fix): a response is now charged what was really received (`RawResponse.size`, after decompression, before charset decoding; a UTF-16 body halves when decoded), or what is handed to the page if larger. Test: three 3.5 MB UTF-16 answers, only two fit (it fails without the fix). If the byte cap comes back HIGH a third time, the loop stops and it goes to Banks.
  - [x] Round 3 (`docs/reviews/2026-10-31-v07-render-round-3.md`): HIGH 1, MEDIUM 0, LOW 0. **The byte cap again, a third time** (robots.txt downloads made by `politeFetch` for each new origin, at most 512 KB each and cached an hour, are not charged to the render's 10 MB budget). Per the rule (the same HIGH survived two fixes), **the loop STOPPED here and this went to Banks unfixed.** Bound as it stands: robots.txt is fetched once per origin, the render allows at most 100 requests, so the extra is at most 100 x 512 KB = 50 MB in the worst case, inside the 20 s limit. Options for the decision: (a) charge robots.txt downloads to the same budget (pass the budget down through `politeFetch`/`checkAllowed`); (b) restate the cap as "10 MB of the page's own resources; robots.txt files, at most 512 KB each and one per site, not counted" and treat it as MEDIUM; (c) also cap the number of distinct sites a render may touch (for example 10), which bounds robots.txt to 5 MB.
  - [x] **Decision (Banks, 2026-10-31, after Codex round 3): option (a). "A cap is only useful if it has no side doors."** The 10 MB render budget counts EVERY byte fetched on the render's behalf, robots.txt included; a robots.txt served from the existing cache costs nothing; if a robots.txt download would push past the budget, the request that needed it is refused like any over-budget request (`byte_cap`). Built: the render puts its budget in the call context (`renderBudget`) for the requests it makes; `fetchRobots` (`src/rules.ts`) takes the whole 512 KB it may read before sending anything (never waiting: the request that needs it already holds its own reservation), refuses with `FetchError` code `budget` when it cannot, charges what was received (`RawResponse.size`) and gives the rest back. A refused robots.txt caches nothing for the site (it is not "robots.txt could not be fetched, assume no"), and another call waiting on that same download fetches its own. Test: refused when 400 KB is left (nothing sent, nothing cached), charged about 100 KB for a 100 KB robots.txt, nothing for a cached one.
  - [x] Round 4 (`docs/reviews/2026-10-31-v07-render-round-4.md`): HIGH 1, MEDIUM 0, LOW 0. Robots.txt fix confirmed; **the byte cap again, a fourth time**: with a Google Web Risk key set, the Safe Browsing gate's lookups for each new URL the page asks for (`src/safebrowsing.ts`, its own response reader) are not charged to the render's budget (Codex measured 256 KB of lookup answers on top of 10 MB). A repeat, so **not fixed; the loop stopped and this went to Banks.** Bound as it stands: only when the owner has set up Web Risk; at most one lookup per new URL (cached verdicts are free), at most 100 requests per render, each answer read through the gate's own small cap. Fix if wanted, same pattern as robots.txt: take a lookup's whole read cap from `renderBudget` before sending, charge what was received, refuse as `byte_cap` (not "Web Risk unavailable") when it cannot. Then the remaining fetches made for a render would be its own requests, robots.txt and Web Risk lookups; the Safe Browsing list download is shared, daily and outside any call (`outsideCall`), so it is not the render's.
  - [x] **Decision (Banks, 2026-10-31, after round 4): Web Risk lookups count, same pattern as robots.txt, refused as `byte_cap`; the daily shared list download stays outside.** Built in `webRisk` (`src/safebrowsing.ts`). Then Banks's sweep (the table "Every path that can read network bytes during a render" below): it found one more uncharged path, response HEADERS (every hop's, up to Node's 16 KB limit each), now counted in `RawResponse.size` and reserved up front (`HEADER_ALLOWANCE`). Tests: Web Risk refused when the budget is short (nothing sent to Google), charged a small answer plus its headers, nothing for a cached verdict.
  - [x] Full suite after these: 828 of 828 passing, 0 skipped.
  - [x] Round 5 (`docs/reviews/2026-10-31-v07-render-round-5.md`), with the sweep table in the prompt: HIGH 2, MEDIUM 1, LOW 0. **The byte cap again, twice; the table is incomplete at the transport level:** (1) informational (1xx) responses are parsed by Node separately (its `information` event) and their headers are neither counted nor capped across responses (Codex measured 12.2 MB read, 98 bytes counted); (2) compressed bodies are capped and counted AFTER decompression, so many compressed bytes that decode to almost nothing are read uncounted (11 MB read, 129 bytes counted). Both live in `safeFetch` and affect every read, not only renders (a plain read is bounded there only by the 15 s timer). **Per Banks's rule (a byte-cap HIGH in round 5), not fixed; the loop stopped and this went to Banks.** Suggested single fix for both, in one place: count raw transport bytes per request at the socket (`socket.bytesRead`, sampled as data arrives, which covers 1xx responses, headers, trailers and compressed bytes alike) and abort the request when it passes the request's cap; charge that number. Then rows 1 to 4 of the table charge transport bytes, and the header allowance becomes unnecessary.
  - [x] **Decision (Banks, 2026-10-31, after round 5): fix it in `safeFetch`, for every read (plain and render), by counting the bytes the connection receives and stopping the request at its cap.** Built (`src/safety.ts`, `Wire`):
    - What is counted: the socket's `bytesRead` change since the socket was handed to the request (each request has its own connection, `agent: false`, and the baseline is taken anyway). On plain http that is the bytes off the wire; **on https it is the bytes after TLS decryption** (Node's TLSSocket counts the plaintext: checked by hand, a gzip body of 1,003 bytes with its headers read as 1,142; the handshake and TLS record framing are not counted). The cap and every charge use this one count. It covers every response's status line and headers, 1xx informational responses, chunk framing, trailers, and the body as sent (still compressed).
    - The cap: `wireBytes` for all hops of one fetch together; by default the body cap plus 1 MB (`WIRE_EXTRA`) for headers, redirects and framing (for a read that hashes a file, the file cap plus 1 MB). It is checked as each chunk arrives, so it can be passed by at most one socket read (64 KB, `READ_SLACK`); past it the connection is cut and the fetch fails `too_large`. The decoded-size caps (`maxBytes`, the file cap) stay as a second check.
    - Charges: `RawResponse.size` is now this count. A render's request reserves its share and passes `wireBytes` = share minus `READ_SLACK` (and `maxBytes` = share for the decoded body), so the charge cannot pass the reservation; `ByteBudget.release` counts a charge in full even if it ever did. robots.txt for a render takes 512 KB + 1 MB and fetches with `wireBytes` = that minus the slack. **The up-front header allowance (`HEADER_ALLOWANCE`, `rawHeaderBytes`) is removed**: the count covers headers.
    - Web Risk lookups now go through `boundedGet` (`src/safety.ts`: plain GET, no redirects, no decompression, the same `Wire` count) instead of the global `fetch` (which decompresses and hides the connection), capped at the 64 KB answer plus 64 KB, charged by the count.
    - The round-5 MEDIUM (a budget refusal turned into a cached "robots.txt says no") is fixed too, as Banks asked: `fetchRobots` rethrows code `budget` with `cancelled`.
    - Test: a server that sends 103 Early Hints responses forever is cut at the cap (`too_large`); a gzip body is counted at its compressed size; a gzip body past `wireBytes` is refused.
    - Full suite: 829 of 829 passing, 0 skipped.
  - [x] Round 6 (`docs/reviews/2026-10-31-v07-render-round-6.md`), with the round-5 findings and this design in the prompt: **HIGH 0, MEDIUM 0, LOW 0.** Codex found no remaining bypass of the connection count and nothing missing from the sweep table (its own probes of HTTP and TLS, redirects, compression, truncation, file hashing, robots.txt and Web Risk passed; Chrome and the process-tree cleanup were not run in its read-only sandbox, they are covered by this suite).
- [x] Full suite after round 2's fix: 826 of 826 passing, 0 skipped (811 before; 15 new, 9 of which need Chrome)
- [x] Full suite after the robots.txt change: 827 of 827 passing, 0 skipped
- [x] Secret scan, push `v0.7`, report to Banks

## The engine decision

Travis chose route 2 on 2026-10-31 (chat: "2"): no new package. `playwright-core` failed the SkillSpector scan
(static analysis: score 100/100, CRITICAL, "DO NOT INSTALL"; 216 issues, 24 HIGH, mostly in its browser-installer
scripts and bundled agent tooling) and was never installed. Tiresias drives the Google Chrome already on the machine
directly, over the DevTools protocol, with Node's own modules only. Coordinator's notes adopted as written: a pipe,
not a debugging port (no other local process can connect to the browser); a fresh temporary `--user-data-dir` per
render, deleted afterwards; the whole process tree killed on every way out; no Chrome, no rendering, and no download
of any browser, ever.

## Design calls (with reasons)

### Off by default; only the owner turns it on

The setting is called `rendering`, not `render`: the read's own option is `render`, and an MCP parameter never shares a
name with an owner setting (W-29's test), so a prompt-injected agent cannot mistake asking for allowing.

`rendering` in config.json (`tiresias settings set rendering off|ask|auto`), or `TIRESIAS_RENDERING` for a session (it wins).
- `off` (default): never. A read that asks gets the plain read with `render: {status: "not_allowed"}` and fixed text
  saying only the owner can turn it on. Nothing is launched.
- `ask`: an agent may ask per read (MCP `read` with `render: true`, CLI `read --render`).
- `auto`: also renders on its own when a plain HTML read is an empty JavaScript shell (under 200 characters of text and
  at least one `<script>`). Why a threshold this simple: it is the same "almost no text" line the reader already uses
  for structured-data pages, and a false positive costs only a render, never correctness.
No MCP tool reads or changes it (settings are CLI-only since W-29). A bad value fails the read by name, like `doors`.

### Engine: the installed Google Chrome, over a pipe

- `findChrome()`: `TIRESIAS_CHROME` (a full path, owner's shell) or the usual install places on macOS, Linux and
  Windows. None: `render: {status: "unavailable"}` and fixed text: install Google Chrome or set `TIRESIAS_CHROME`;
  Tiresias never downloads a browser. Why Chrome and not a bundled Chromium: it auto-updates, so it carries the newest
  security fixes, which matters most when running hostile JavaScript.
- `src/cdp.ts`: `--remote-debugging-pipe` (Chrome reads fd 3, writes fd 4, NUL-delimited JSON). Each message from
  Chrome is capped at 64 MB, parsed as data, and every command has a timeout; at most 1,000 outstanding.
- One browser per render. Spawned `detached` (its own process group) with an environment of only `PATH`, `HOME` and
  `TMPDIR` pointing into the throwaway profile folder: no Tiresias key or setting reaches it.
- Killed with `SIGKILL` to the whole process group (Windows: `taskkill /T /F`) in a `finally` that runs on success,
  cap, error, cancel and shutdown; a process `exit` hook kills any still running; if Tiresias itself is killed, the pipe
  closes and Chrome exits on its own (checked by hand on macOS, 2026-10-31).
- Profile folder `tiresias-render-<pid>-XXXXXX` in the system temp folder, deleted after the browser has exited. One
  left by a process that died is removed by the next render (a real folder, owned by this user, whose process is gone
  or that is over an hour old; never a link).

### Safety: the page's JavaScript is hostile

- **Every request goes through Tiresias.** `Fetch.enable` pauses every request of the page. Tiresias either refuses it
  or fetches it itself with `politeFetch` and hands Chrome the answer (`Fetch.fulfillRequest`). So Safe Browsing,
  never_visit and hand_off, the private-address block (checked after DNS, pinned), ports, robots.txt, Retry-After,
  spacing and signing all apply to every subresource, and **subresources are signed like plain reads**. Chrome's own
  network stack never reaches a site.
- Robots.txt is checked for every request, not only the top-level page: stricter than the brief, and it is what
  `politeFetch` already does (principle 2). Spacing applies too, so a page with many same-site scripts renders slowly
  rather than impolitely; the time cap bounds it.
- **The top-level page is not fetched twice**: the render is fed the body the plain read already fetched, under the same
  URL (the final URL after redirects).
- Refused outright, counted by fixed reason in `render.blocked`: anything but GET (`not_get`); images, fonts, media,
  beacons, manifests, prefetch, WebSocket and EventSource (`not_needed`); frames (`frame`); the page navigating itself
  anywhere else (`navigation`); non-http(s) URLs (`scheme`); files and PDFs (`file`); popups (`popup`); workers
  (`worker`); the caps (`request_cap`, `byte_cap`); and what the rules refused (`rules`, `wall`, `site_settings`,
  `unsafe_address`, `safe_browsing`, `signing`, `too_large`, `fetch_failed`, `error`). Fetched kinds: scripts, style
  sheets, XHR and fetch. A CORS preflight for a GET is answered by Tiresias (the page's own headers are never sent; the
  site's own CORS answer on the real GET still decides what the page may read).
- Cookies are never sent and `set-cookie` never reaches the page; only `content-type` and the CORS headers are passed on.
- **Defence in depth for what interception cannot see** (WebSocket, WebRTC, DNS prefetch, Chrome's own background
  traffic): Chrome's proxy is a listener Tiresias opens on 127.0.0.1 that drops every connection, with loopback NOT
  bypassed, plus WebRTC limited to proxied traffic. Anything that escapes interception fails instead of reaching the
  network.
- Chrome's own sandbox stays ON (no `--no-sandbox` ever; a test checks the arguments). A fresh browser context per
  render (`Target.createBrowserContext`), downloads denied, service workers bypassed, the HTTP cache off.
- Every new target (popups, service workers, shared and dedicated workers, out-of-process frames) is auto-attached
  PAUSED and never resumed; popups are closed. Dialogs are dismissed. Tiresias never clicks, types or submits.
- Small conveniences inside the page (`window.open` returns null, no `navigator.serviceWorker`, no `RTCPeerConnection`)
  are not the boundary; the interception and the dead proxy are.
- **Caps:** 20 s for the render (it also ends with the call's 60 s deadline, cancellation or shutdown); 100 requests;
  10 MB fetched; V8 heap 256 MB per renderer; a rendered page of at most 50,000 elements and 5 MB of HTML. The page is
  "settled" after its load event once no request has been pending for 0.5 s.
- **Reading the result:** scripts are switched off (`Emulation.setScriptExecutionDisabled`), then the element count and
  the HTML are taken from an ISOLATED world, where the page's scripts cannot change the DOM's methods. A page that keeps
  the main thread busy (an endless loop) cannot answer: after 3 s that is `failed: page_busy` and the browser is killed.

### Output

- The rendered HTML goes through the same reader and shield (`parsePage`, in the worker, with its wall check and the
  language detection of W-26), so receipts, flags, paging, walls, the cache, tabs and history all work as for any read.
- A render that stops (a cap, a busy page, the browser failing, a cancel) never fails the read: the plain read is
  returned with `render: {status: "failed", reason}` and the counts so far. A wall that appears only once rendered is a
  wall.
- Top level: `render: { status, reason?, requests, fetched, blocked, dialogs, ms }`, fixed codes and counts only.
  Statuses: `rendered`, `cached` (a copy rendered earlier, served from the cache), `not_allowed`, `not_html` (asked,
  but the page is not HTML), `unavailable`, `failed`. A fixed sentence is added to the message.
- Cache: the entry records `rendered: true`, and a rendered copy's fingerprint covers the rendered HTML too, so a plain
  and a rendered copy are never mistaken for one another. A read that asks to render never reuses a plain copy (no
  fresh serve, no validators). `check` re-renders a copy that was rendered, so like is compared with like (when the
  owner has since turned rendering off, the plain read is compared and may show as changed). No cache format bump: the
  field is optional and old entries are plain.
- History: `rendered: true` (checked on read like every field). The needs report already points JavaScript-empty pages
  at W-10 and is unchanged.
- Private mode: a render writes nothing to the store. Chrome's throwaway profile folder lives in the system temp folder
  for the render's duration only, then is deleted.

### For tracks that follow

`withRenderedPage(url, html, fn)` gives `fn` a settled page with `evaluate(expression)` in the isolated world, so the
walls and hidden-text track can ask what is visible (computed styles, layout) without touching the launch or the
rules. `renderHtml` is built on it.

## Every path that can read network bytes during a render (sweep before Codex round 5)

Asked by Banks after round 4 ("to stop the drip"). Found by searching `src/` for every `safeFetch`, `politeFetch`,
`fetch(`, `http(s).request/get`, `net`/`tls` connections, `dns.`, WebSocket, and child processes, then following each
from `render.ts`. "Charged" means counted against the render's 10 MB budget before it is read (`ByteBudget`); headers
count too. Since round 5 every charge is the bytes the connection received (`Wire` in `src/safety.ts`): headers, 1xx
responses and compressed bodies are inside that count.

| # | Path | Where | During a render |
|---|---|---|---|
| 1 | The page's own requests (scripts, style sheets, XHR, fetch) | `render.ts` `fetchFor` -> `politeFetch` -> `safeFetch` | **Charged** (since round 5: by the bytes the connection receives, `Wire`): reserved before sending (`wireBytes` = reservation minus one socket read), charged `RawResponse.size`, the rest given back; a file, PDF or failure is charged in full. |
| 2 | Redirect hops, 1xx responses, headers, chunk framing, trailers, compressed bodies | `safeFetch` | **Charged**: all of it is in the connection count of row 1 (round 5). |
| 3 | robots.txt for each new site the page touches | `politeFetch` -> `policyCheck` -> `checkAllowed` -> `getRobots` -> `fetchRobots` -> `safeFetch` | **Charged** (round 3 decision): 512 KB + 1 MB taken before sending, never waited for, fetched with that as its connection cap less one read; refused as `byte_cap` when it cannot be; charged the connection count. A robots.txt from the cache costs nothing. Another call's download that this render joins (`inFlight`) is that call's, like a cached copy. |
| 4 | Google Web Risk lookups, when the owner has a key | `safeFetch` -> the call's gate -> `checkUrl` -> `webRisk` -> `boundedGet` | **Charged** (round 4 decision; since round 5 by the connection count, no redirects, no decompression): 128 KB + one read taken before sending, never waited for; refused as `byte_cap`, not "unavailable". A cached verdict costs nothing. |
| 5 | The Safe Browsing list download | the gate's `listFor` -> `ensureList` -> `outsideCall(politeFetch)` | **Exempt** (Banks, round 4): shared by every call and profile, at most once a day, run outside any call's context (`outsideCall`, so no render budget is visible to it), and its own 32 MB cap. It would happen on the next read anyway. |
| 6 | DNS lookups (each request's pinned lookup; the address check before a Web Risk lookup) | `safety.ts` `resolvePublic` -> `dns.lookup` | **Exempt**: the system resolver's own small answers, not a response body Tiresias reads; one per host per request, bounded by the request cap. |
| 7 | The plain read that came before the render (the page itself, its robots.txt, door checks with `doors: wait`) | `pipeline.ts` `run`, `fetchSource`, `probeOrigin` | **Not the render's**: they happen whether or not the page is rendered, under the read's own caps; the render is fed the body already fetched (the page is never fetched twice). |
| 8 | W-30 background door checks (llms.txt, llms-full.txt, MCP, OpenAPI, sitemaps) | `afterDeferred` -> `startDoorProbe` | **Not the render's**: started only after the reply is built, outside the call, for the read; a render never starts one. |
| 9 | llms.txt, markdown twins, sitemaps as a source | `pickSource`, `doors.ts` | **Unreachable during a render**: chosen before the fetch; a render is only for a page read as HTML. |
| 10 | Chrome's own network stack (navigation, WebSocket, WebRTC, prefetch, DNS prefetch, service workers, background traffic) | Chrome | **Unreachable**: every request is paused and answered by Tiresias (row 1) or refused; what interception cannot see goes to Tiresias's dead proxy on 127.0.0.1, which accepts and closes every connection without reading; workers and other targets stay paused. |
| 11 | The CDP pipe, the dead proxy, `ps` for stray processes | `cdp.ts`, `render.ts` | **Not network**: local pipes, a loopback listener that reads nothing, a local program. |
| 12 | The owner's scanner hook (W-21) | `filereply.ts` | **Unreachable**: only for a file warning; a render refuses files before any scan (no `files` option is passed). |
| 13 | The owner's translation hook (W-26) | `translate.ts` | **Not the render's**: runs after the reply is built, on the shown text, a local program the owner chose; no network of Tiresias's. |
| 14 | Signing (Web Bot Auth) | `signing.ts` | **Not network**: the key is read locally. |
| 15 | Form submits, PDFs, Office/zip inspection, resume, watch | `formflow.ts`, `pdf*.ts`, `office.ts`, `zipread.ts`, `resume.ts`, `watchflow.ts` | **Unreachable during a render**: a render never submits (non-GET refused) and never hands a file or PDF to the page. |

## Files touched outside the new modules (for the merge)

New: `src/cdp.ts`, `src/render.ts`, `src/test/render.test.ts`.
- `src/pipeline.ts` (`run`): the render setting, `rerender`, the render step after the plain parse, the fingerprint,
  `rendered` on the entry, `render` passed to `finishPage`; `finishPage`'s `withCache` calls `renderNote`; new `renderNote`.
- `src/envelope.ts`: `Opts.render`, `Serve.render`, `CallMeta.rendered`, history gets `rendered`.
- `src/types.ts`: `Envelope.render`. `src/pagecache.ts`: `CacheEntry.rendered`. `src/history.ts`: `rendered` field.
- `src/config.ts`: `rendering` in the keys checked where used. `src/settings.ts`: the `rendering` row, `TIRESIAS_RENDERING` and
  `TIRESIAS_CHROME` rows.
- `src/mcp.ts`: `render` on `read`. `src/cli.ts`: `read --render`, help line, the `--text` summary line.

## Deferred to compute-day sweep

| Round | Severity | Summary | File |
|---|---|---|---|
| 1 | MEDIUM | Cache shortcuts can skip a required re-render: an explicit `render` on an already rendered copy can be served fresh or by a 304, and `check` (even `--fresh`) can reuse the rendered parse via `plain_hash`, missing changes only in scripts or data | `src/pipeline.ts` (run: `rerender`, `reuse`) |
| 1 | MEDIUM | A failed render replaces the last good rendered copy with the plain one, and a check can then report its content as removed | `src/pipeline.ts` (run, render step) |
| 1 | MEDIUM | The profile sweep removes a folder over an hour old even when its owning process is alive (a suspended render) | `src/render.ts` (`sweepProfiles`) |
| 1 | MEDIUM | A NUL-terminated CDP message is assembled and parsed without checking it against `MAX_MESSAGE` (only unterminated tails are checked) | `src/cdp.ts` (`take`) |
| 1 | LOW | Setup before the `try` (timer, temp folder, proxy) is not cleaned up if a later setup step fails | `src/render.ts` (`withRenderedPage`) |
| 5 | MEDIUM (fixed in the round-5 work, at Banks's request) | A Web Risk budget refusal inside a robots.txt download (the gate checks robots.txt's own URL) is turned into "robots.txt could not be fetched, assume no" and cached for 60 s for every call, instead of passing up as `byte_cap` (fix: rethrow code `budget` with `cancelled` in `fetchRobots`'s catch) | `src/rules.ts` (`fetchRobots`) |
| 2 | MEDIUM | A redirected subresource is handed to the page under its original URL (Tiresias follows the redirect itself), so a redirected module resolves relative imports against the wrong base and a cross-origin redirect is invisible to Chrome's CORS checks | `src/render.ts` (`fetchFor`) |
| 1 | LOW | Timers of the losing side of two races (the 3 s evaluate timer, the 2 s exit wait) are not cleared | `src/render.ts` |
