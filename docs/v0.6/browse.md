# v0.6 Track 2: browse (W-24 tabs and back/forward, W-27 downloads shelf)

Branch `v0.6-browse`, from main `9e34f0d`. Decisions for the coordinator to fold into SPEC.md.

## Progress

- [x] W-24 tabs and back/forward (`src/tabs.ts`, `src/browsetools.ts`, `src/browsecli.ts`, `src/browseclear.ts`, `src/browselock.ts`; tests `src/test/tabs.test.ts`)
- [x] W-27 downloads shelf (`src/shelf.ts`, hooked in `src/filereply.ts`; tests `src/test/shelf.test.ts`)
- [x] README and CHANGELOG lines
- [x] Codex review loop until clean: round 11 found nothing (round 1: 2 HIGH, 5 MEDIUM, 3 LOW; round 2: 2 HIGH, 4 MEDIUM, 2 LOW; round 3: 2 HIGH, 1 MEDIUM, 3 LOW; round 4: 0 HIGH, 2 MEDIUM, 2 LOW; round 5: 1 HIGH, 6 MEDIUM, 1 LOW; round 6: 2 HIGH, 2 MEDIUM, 0 LOW; round 7: 1 HIGH, 3 MEDIUM, 1 LOW; round 8: 1 HIGH, 2 MEDIUM, 1 LOW; round 9: 0 HIGH, 4 MEDIUM, 1 LOW; round 10: 0 HIGH, 2 MEDIUM, 2 LOW; all fixed; round 11: clean)

## W-24: tabs and back/forward

### What it is

Every non-private `read` that answers `ok` or `unchanged` opens a tab for its URL (or moves to the URL's existing tab) and pushes it onto a back/forward stack. An agent can then show tab N, go back or go forward, and gets the page from the shared page cache (W-03) with receipts, with **no request to any site**. `section`, `question` and `page` work as they do for `read`.

"Named working set" is read as: the session's reads, each with a number that never changes and is never reused within the session. Tabs have no free-text names (a name would be one more agent-supplied string to bound and quote back; numbers do the job).

### What a session is

| Door | Session | Where it lives | Ends |
|---|---|---|---|
| MCP | One MCP server process (one client connection). Two agents run two servers, so each has its own tabs. | Memory only. Nothing about MCP tabs is ever written to disk. | When the server stops, or `tab` with `close_all`. |
| CLI | The command line of one profile. Every command is its own process, so the session must live on disk. | `tabs/cli.json` in the profile's folder (mode 0600, atomic write, read with the store's link and owner checks, at most 256 KB). | After 12 hours without use (the next command starts an empty session), `tiresias tabs close --all`, or `clear` (see below). |

Concurrent CLI commands: every change of the file (a read opening a tab, a move, a close) runs as one load-change-save under an exclusive, owned lock file next to it (`tabs/cli.json.lock`, `src/browselock.ts`), so two commands never give one number to two pages. The state also carries a random session `id` and a `rev` that counts every saved change: back and forward choose their destination, build the page, and then move only if the session is still the same `id` and `rev`; if anything changed meanwhile (another read, move, close or a reset), nothing moves, nothing is logged, and the reply is `error` with fixed text saying to try again. Opening a tab by number moves nothing, so it still answers and only skips noting when the tab was used (Codex browse round 2). This holds for MCP sessions too, whose calls can overlap.

The lock (`src/browselock.ts`, Codex browse rounds 3 and 4) holds a random token and its owner's process id, and is NEVER broken while its owner is alive, whatever its age, so an owner that has checked the lock is still its own right before writing cannot lose it before the write. A lock is published already filled in (round 8): the token and process id are written to a private temp file, which is then hard-linked to the lock's name (a link fails if the name exists, so it is as exclusive as an exclusive create), so no process ever sees one of our locks without its owner in it. A lock is broken only when its owner process no longer exists, or when it holds no owner at all (never one of ours, so it is broken at once), and only when it is a plain file: a link or a folder at the lock's path is never treated as breakable, so the lock stays busy until the owner removes it, and taking a lock always gives up at its one-second deadline (round 6: such a path used to make `acquire` loop forever). Breaking counts only once the lock is confirmed gone. Breaking takes a second exclusive file, `<lock>.break`, so only one process breaks a given lock; it re-reads the lock under `.break` and removes it only if it still names the same dead owner, and nobody can create a new lock while the dead one is still there, so a live lock is never removed by mistake. A `.break` left by a breaker that died is broken the same way. The release deletes only the owner's own lock, and `clear` removes a dead lock through the same breaking rule, so a lock another process took over after `clear` planned its removal is left alone (round 5). The one case it cannot handle: a dead owner's process id reused by an unrelated running program keeps that lock looking alive, so the lock stays busy; the busy message then tells the owner which file to delete. The shelf uses the same lock. `clear` removes only locks whose owner is gone, and only for the lock names Tiresias makes (`tabs/cli.json.lock`, and in `shelf/` the lock of any day file, `YYYY-MM-DD.jsonl.lock`, each with its `.break` files); anything else shaped like a lock is junk and removed (round 5). Round 9 widened the shelf rule from today's and yesterday's day to every day: a paused writer or a clock change can leave a live lock on an older day, and a live owner's lock is never removed whatever its date.

### Caps

- 50 tabs per session. Past it the least recently used tab closes (never the one just read). Its number is not reused.
- 100 entries in the back/forward stack. Past it the oldest entry goes.
- A URL over 2,048 bytes gets no tab (URLs are never shortened).
- A tab's title (web text) is kept cut at 200 characters.
- The tab list is paged at 40 KB, like history.
- The CLI file is at most 256 KB; anything larger, damaged, not matching the exact shape (numbers, stack pointing at real tabs, http(s) URLs, ISO times, no duplicates), a link, or someone else's file is ignored and a fresh session starts. It is never an error.

### How the stack moves

Like a browser: a read while the pointer is back in the stack drops everything forward of it, then pushes the new page. Re-reading the page you are on does not push it again. Opening a tab by number does not change the stack (like switching tabs); back and forward move the pointer. Closing a tab removes it from the stack too, and neighbours that become equal collapse into one entry.

### What a tab reply says

- Like every other non-private call, a tab call first runs the once-a-day trim, and it runs under the same 60-second deadline and MCP cancellation. The page is built first; the session moves and the receipts are logged only once the call is known not to be cancelled, so a cancelled call changes nothing (Codex browse round 1). An already-cancelled call, `close` and `close_all` included, does nothing at all, not even the trim (Codex browse round 2). A cancel that arrives while the trim is running cannot undo the trim's own deletions, so the cancel reply promises only what it controls: "No tab moved and nothing was logged" (round 10).
- `status: "ok"`, the page content as `read` builds it, receipts quoting the copy (with its own `fetched_at`), and the receipts are also written to the receipts log (N-03). No history line: no visit happened.
- `url` is `""` at the top level, and the tab's URL is in `untrusted_content.tab_url`: the URL may have come from a link on a page, so it is treated like the URLs in history.
- Top-level `tab: { number, tabs, position, stack, copy, age_seconds }`, all numbers or fixed codes. `position` (the 1-based place in the back/forward stack) is present only on back and forward replies: opening a tab by number does not move that position, so its reply has none (Codex browse round 3). `copy` is `too_large` (see below), `same` (the copy this session read), `newer` (the page was read again since, by this or another agent; that later copy is shown and the message says so), `older` (the kept copy is EARLIER than the one this session saw: a slower read finished last, or the cache was put back; the message says so) or `gone`.
- The message always says the copy's time and age, that nothing was sent, (since round 8 also on an error about the copy, such as a section that does not exist, which also keeps the copy's `fetched_at`, `cached_at` and `cached_by`), and that the copy was NOT checked against the site and may be out of date. `untrusted_content` also has `cached_at` and `cached_by`, as for a W-03 fresh serve. There is no `cache` field: its codes describe a read that asked (or could have asked) the site, and a tab never does.
- The read reply that opened the tab carries top-level `tab: { number, tabs }`.

### When the cached copy is gone

The kept copy can be gone (cleared, trimmed, evicted by the disk cap), never kept (the site sent `no-store`), replaced by a file warning, or made by an older reader version (its parse would be wrong). A cache file over 64 MB is never loaded at all (`MAX_JSON_READ`, now applied by `store.readJson` to every store JSON file, and since round 7 counted by the bytes really read, in chunks, so a file that grows while it is read, or claims a false size, still stops at the cap; `readOwnedFile`, which reads the CLI session file, does the same, so a planted giant file reads as "no cache" for `read` too). And since the cache folder could be edited, an entry is shown only when every value that reaches the top level of the reply is one of Tiresias's own codes: `door` and `door_detail` from their fixed lists, every flag type and `flags_dropped` key from the fixed flag list, and whole-number counts (Codex browse round 1); otherwise it is unusable. Since round 2 the whole cached page is checked before any work is done on it, in two ways (rounds 2, 4 and 5). Its shape (every section, block, link marker and link of the right types, whole-number counts) must be right, or the copy counts as gone. Its size must fit what a tab is willing to build on the main thread, or the reply is `copy: "too_large"` with fixed text saying the page is larger than a tab shows and to read it again, never that it is gone: at most 20,000 sections, 200,000 blocks, 10,000 links, 32 M characters, blocks of 1 MB with at most 100,000 link markers, headings, titles and link texts of 4,096, URLs of 8,192, side parts (forms, metadata, structured-data types, feeds) of 4 MB, and a receipt workload (sections times the length of the URL each receipt repeats) of 64 M. Those bound the outline work, which builds a receipt for every section, before it starts (round 5). A test reads real pages of the awkward kinds (a long `<pre>` in nested lists whose block outgrows the reader's block size, thousands of headings, markdown) and opens their tabs. The tab then answers `status: "error", `tab.copy: "gone"`, fixed text saying so and that nothing was sent, and the URL in `untrusted_content.tab_url` so the agent can read it again; reading it again keeps the tab's number. Tiresias never fetches on the agent's behalf from a tab call: fetching is `read`'s job, with all its rules.

### Rules and requests

A tab call sends nothing, so robots.txt, Retry-After, spacing and Safe Browsing do not run for it. It only re-shows a copy that was read under those rules, the way scrolling back in a browser does. The coordinator's note on W-03 (serving from the cache without robots is acceptable since nothing is sent) applies even more here, since the agent already saw the copy.

### Private mode

- A private read opens no tab, not even in an MCP server's memory: a private call neither reads nor writes memory shared between calls (section 9, 2026-10-16), and the CLI's file is not touched.
- Showing a tab, back, forward, close and close_all are refused in private mode (`status: "refused"`, `private: true`, fixed text). They would read the page cache, which a private call never reads, or change the session.
- Listing tabs (`tabs`) reads only and works in private mode, like the history tool.
- In a private session (`TIRESIAS_PRIVATE=1`) every read is private, so no tab is ever opened.

### Cleanup

`clear` and the daily trim treat `tabs/cli.json` (and a leftover temp file of it) as one whole file: removed by `clear --all`, removed when it is older than `keep_history_days` (anything else in `tabs/` is removed by any clear, as for `shelf/` below), except that a temp file younger than a day is never removed (it may be another process's write in progress; the existing rule for every temp file in the store) and one older than a day is removed whatever the retention setting (it holds URLs read, like history), counted by the disk cap with the logs. `ClearReport` gains `tabs` (removed, kept, bytes_freed). A `tabs/` folder that is a link or someone else's stops `clear` before anything is deleted, as for the other folders.

### Interface

MCP:

| Tool | Input | Returns |
|---|---|---|
| `tabs` | optional `page` | This session's tabs, most recently used first: top-level `session` (`memory`), `counts` (`tabs`, `stack`, `back`, `forward`), `current`, `page`, `pages`; the tabs (`n`, `url`, `title`, `fetched_at`, `opened_at`, `used_at`, `current`) inside `untrusted_content.tabs`. Read only. |
| `tab` | `action` (`open`, `back`, `forward`, `close`, `close_all`), `number` (for open and close), optional `section`, `question`, `page`, `private` | A page from the cache as described above, or a fixed message for close. Annotations: not read only (it changes the session), not destructive, not open world. Refused in private mode. |

CLI (exit codes as everywhere: 0 ok, 1 error such as "no such tab" or "gone", 2 refused):

```
tiresias tabs [--page 2]
tiresias tabs close <n> | tabs close --all
tiresias tab <n> [--section 3] [--question "..."] [--page 2]
tiresias back [--section 3] [--question "..."] [--page 2]
tiresias forward [...]
```

`--text` prints a short summary; titles and URLs are marked as data from the web.

## W-27: the downloads shelf

### What it is

Every file warning (W-20) is put on the shelf as it is given: `time`, `file_kind`, `risk`, `size`, `fingerprint` (or `no_fingerprint`: `too_large`, `not_downloaded`, `timeout`), `flags`, `scan` and `scan_by` (the owner's scanner, W-21), `url` (asked), `final_url` (where the file came from), `declared_type`, `declared_name`, `agent`, and `source: "provided_by_person"` for a file a person saved. `tiresias files` and the MCP `files` tool list it newest first, searchable by site and by date.

### The store

- One file per UTC day, append only: `shelf/YYYY-MM-DD.jsonl` in the profile's folder, written with the store's `appendLine` (owner-only, never through a symbolic link, and since round 2 never into a file with more than one hard link, which could be a file outside the store linked in: `appendLine` refuses it for every log, history and receipts included, a leading newline so a torn line cannot swallow a record), like the history files the daily log is built from.
- Capped: a day file stops taking records at 2 MB. The size check counts the new record's own bytes and runs with the append under the day file's lock (`YYYY-MM-DD.jsonl.lock`), so concurrent writers cannot push a day past the cap (round 2). A record that is not put on the shelf for any reason (the day is full, the lock stayed busy for a second, a write failed) marks its day incomplete with an empty `YYYY-MM-DD.incomplete` file, which `clear` ages and removes with its day, and the file warning reply itself carries top-level `shelf: "not_recorded"` (a fixed code) (round 5). 2 MB is about 400 records of the largest size, thousands of normal ones. The warning itself is unchanged and the receipts log still has the record; only the shelf copy is skipped.
- `clear` walks `tabs/` and `shelf/` as a stream (never loading a folder whole), top level only, with a budget of 20,000 entries each per run. It removes every file or link Tiresias does not make there (a link is unlinked itself, never followed; it is a direct child of a folder the store has checked). A FOLDER Tiresias did not make is never entered, removed or counted toward the store's size: deleting inside one safely would mean trusting every path component under it, so `clear` only reports how many there are (`foreign_folders`, and a sentence in the summary) for the owner to remove (round 6, replacing round 5's walk into junk folders). Each run looks at a folder's entries from the start, so if what it keeps there (data within its retention, live locks, folders it did not make) fills its budget, later runs cannot reach the rest. There is no continuation between runs; instead, whenever a run hits its budget in `tabs/` or `shelf/`, the summary says so and that the owner must remove what is not needed there (rounds 7 and 9). Tiresias's own data files (the tab session, a shelf day file and its marker) are removed under the same lock their writers take, taken without waiting (one attempt, plus breaking a dead owner's lock on the spot and trying again, at most three times; a live writer means "not this run", reported as not removed, so a run is never held up by locks; rounds 8 and 10), and only if the file is still the one that was planned (same inode, modification time and size); one that changed since the plan (a session saved or a record added meanwhile) is kept, not an error (round 7). A day and its `.incomplete` marker are one unit, planned as ONE item (the day's, with the marker's bytes added, so the disk cap can never pick a marker that cannot go while its day stays; a marker whose day is gone is its own item, aged by its date; round 10): removing a day removes its marker under the same lock, and a marker alone is removed only once its day is gone, so a kept day never loses its incompleteness warning (round 9). Only "it does not exist" counts as gone: an entry that cannot be looked at while planning stops `clear` before anything is removed, and one that cannot be looked at when removing is a failure (round 9). Only what is really gone is counted as removed: anything `clear` could not remove is counted as kept, reported as `not_removed` with a sentence in the summary, and `tiresias clear` then exits 1 (round 6). A run that ran out of budget says so in `scan_incomplete`. A `tabs/` or `shelf/` folder that exists but cannot be read stops `clear` while it is still planning, before anything is removed, with an error naming the folder (round 8), instead of being treated as empty. The plan is the same for `--dry-run` and a real run. Every step of a run is bounded (entry budgets, no lock waits), so the daily trim a tab call runs first cannot hold the call up for long.
- The store-size count that drives the disk cap has a budget too (1,000,000 entries, 64 levels deep), and does not enter folders inside `tabs/` and `shelf/` (none are Tiresias's). A count that did not finish is a lower bound: the disk cap is still applied with it (it can only remove less than a full count would, never more), and `scan_incomplete` includes `store size` with a sentence in the summary (round 6; round 5 skipped the cap instead, which left it off for good on a store that could never be measured whole).
- Trimmed: `clear` and the daily trim delete whole shelf day files older than `keep_receipts_days` (file warnings were kept with the receipts before v0.6, so they keep the same age limit and no new setting is added, which keeps config.json out of this track), `clear --all` deletes them all, and the disk cap evicts them with the history and receipts files, oldest first. `ClearReport` gains `shelf`.
- The receipts log keeps its `file: "warning"` records as before, so the daily log and the needs report are unchanged. The shelf is a second, small, newest-first copy made for listing: reading it never walks the receipts.
- Warnings from before v0.6 are not copied onto the shelf; the empty-shelf message says they are in the receipts log.

### Reading it back

- Day files are read newest first, one at a time, each at most 4 MB (a bigger file is read from its last 4 MB, starting at a full line). One listing reads at most 64 MB in all, charged from what is really read from each opened file, not from the size its path showed when listed (round 7): past that it stops, says `partial: true` at the top level, and the message says older warnings were not counted and how to narrow the listing. A day that was marked incomplete (even one with no records on the shelf at all), whose file was read only from its end, or that holds a damaged line or a record that does not check out (round 10), is still listed, but the reply says `partial: true` and `days_incomplete: N` at the top level, and the message says some warnings from those days are not listed and are still in the receipts log (Codex browse round 2). A day file that cannot be read at all (someone else's file, no permission), and a link or folder with a day file's name (counted only when its date is within the dates asked, round 7), are reported the same way, as `days_unreadable: N` with `partial: true`, never shown as an empty day (Codex browse rounds 3 and 6). One listing looks at no more than 20,000 entries of `shelf/`; a folder holding more is listed from what was seen with `partial: true`, `entries_unscanned: true` and a fixed sentence saying some days may be missing and that `clear` removes files Tiresias did not make there (round 6: it is never refused, since a folder Tiresias did not make is never removed by `clear`, so a refusal could not be recovered from). The listing yields between day files, so it never blocks the MCP server for long, and it stops when the MCP call is cancelled (Codex browse round 1). A `shelf/` folder that is a link or someone else's is an error, never a quiet empty answer.
- Every record is checked and cut again on the way out: a known kind and risk, a whole-number size, an ISO time, fingerprints only as `sha256:<64 hex>`, verdicts and flags only from their fixed lists, URLs cut at 4,096, the declared type at 200, the name at 255, the agent at 200, `scan_by` at 100 (`cut: true` when anything was cut). Unknown fields are dropped and lines that are not records are skipped.
- Paged at 40 KB of records, like history. Top level: `status`, fixed `message`, `notice`, `counts` (`files`, `high`, `low`, `scanned_bad`), `page`, `pages`, `total`. The records themselves, URLs and names included, are only inside `untrusted_content.files`.

### Filters

- `site`: the record's `url` or `final_url` host is the site or one of its subdomains (`www.` ignored), as in history. `notb.example` does not match `b.example`.
- `since`: a date (`2026-10-01`, from the start of that UTC day), a full time, or `7d` / `24h`.
- `until`: a date (through the END of that UTC day), a full time, or `7d` / `24h`.

### Private mode

A private call puts nothing on the shelf (checked in `shelf.record`, at the call site, and by the store's own private refusal). Listing reads only and works in private mode; it creates nothing.

### Interface

| Tool | Input | Returns |
|---|---|---|
| `files` | optional `site`, `since`, `until`, `page` | The shelf as above. Read only. |

```
tiresias files [--site example.com] [--since 7d] [--until 2026-10-24] [--page 2] [--text]
```

Exit 0 on a listing, 1 on a bad option or date. `read --text` prints a fixed sentence when the warning could not be put on the shelf (round 9). A bad `since`, `until` or `site` gets fixed text that never repeats what the caller passed; any other error keeps its detail inside `untrusted_content`, over MCP (Codex browse round 1) and on the command line (one JSON line on standard error, exit 1; Codex browse round 2).

## Files touched outside the new modules (for the merge)

- `src/mcp.ts`: imports; a `MemoryTabs` per server and `withTab` around the read tool's reply; one `registerBrowseTools(...)` call.
- `src/cli.ts`: one import; `${BROWSE_HELP}` in HELP; `...BROWSE_TAKES` in TAKES; one `runBrowseCommand(...)` call before the other commands; `noteCliRead(...)` around the read call.
- `src/cleanup.ts`: `tabs` and `shelf` parts in `ClearReport`, two item kinds, `browseItems()` in gather, their age limits, totals and summary.
- `src/store.ts`: `readJson` refuses a file over `MAX_JSON_READ` (64 MB) and returns null, as for a damaged file (Codex browse round 1); `appendLine` refuses a file with more than one hard link (Codex browse round 2).
- `src/cleanup.ts` (round 3): `storeBytes` walks folders with `opendirSync` instead of `readdirSync`; (round 4) browse items are removed with `removeBrowseItem` (never follows a link) and `ClearReport` gains `scan_incomplete`.
- `src/filereply.ts`: one `shelf.record(...)` call in the existing non-private block of `fileWarning`, setting `shelf: "not_recorded"` on the reply when it did not record, and its import.
- `src/types.ts`: `Envelope` gains the optional `shelf?: "not_recorded"` (round 5).
- `src/cleanup.ts` (rounds 5 and 6): `storeBytes` has an entry and depth budget (`MEASURE`) and skips folders inside `tabs/` and `shelf/`; an unfinished count is used as a lower bound; `scanIncomplete` and `foreignFolders` are reset each run; a browse item that could not be removed is counted as kept (`not_removed`); `ClearReport` gains `not_removed` and `foreign_folders`.
- `src/cli.ts` (round 6): `tiresias clear` exits 1 when `not_removed` is set; (round 9) the `--text` summary prints a sentence for `shelf: "not_recorded"`.
- `src/store.ts` (round 7): `readBounded` (chunked, stops past the limit) used by `readJson` and `readOwnedFile`.
- `src/cleanup.ts` (round 7): browse items are removed through `removeBrowseItem(item)` with a three-way result (removed, kept, failed).
- `src/test/mcp.test.ts`: the tool list and the every-tool test know `files`, `tab`, `tabs`.
- `README.md`, `CHANGELOG.md`: one short section each.
