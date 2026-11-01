# v0.6 track 3: settings (W-30, W-25, W-29)

Branch `v0.6-settings`, from main 9e34f0d. Decisions for the coordinator to fold into docs/SPEC.md.

## Progress

- [x] W-30 fast first read (door checks in the background)
- [x] W-25 site settings per site
- [x] W-29 `tiresias settings` (list, set, reset)
- [x] Codex rounds until clean (round 12 clean, 2026-10-25)
  - [x] round 1: HIGH 0, MEDIUM 6, LOW 4, all fixed
  - [x] round 2: HIGH 1, MEDIUM 4, LOW 2, all fixed
  - [x] round 3: HIGH 0, MEDIUM 5, LOW 0. Stopped under the guard; the coordinator approved three structural options; all five fixed
  - [x] round 4: HIGH 0, MEDIUM 3, LOW 1, all fixed
  - [x] round 5: HIGH 0, MEDIUM 1, LOW 1, all fixed
  - [x] round 6: HIGH 0, MEDIUM 3, LOW 1, all fixed
  - [x] round 7: HIGH 0, MEDIUM 2, LOW 0, all fixed
  - [x] round 8: HIGH 0, MEDIUM 3, LOW 0. Stopped under the guard; the coordinator approved three options; all fixed
  - [x] round 9: HIGH 0, MEDIUM 4, LOW 0, all fixed
  - [x] round 10: HIGH 0, MEDIUM 3, LOW 0, all fixed
  - [x] round 11: HIGH 0, MEDIUM 4, LOW 0. Stopped under the guard; fixed by the coordinator's decisions
  - [x] round 12: CLEAN (HIGH 0, MEDIUM 0, LOW 0)

## Decisions

### The timing rule for settings (coordinator, 2026-10-25, after Codex round 11)

**Each call reads the settings once, when it starts, and keeps that snapshot for the whole call.** A settings change
applies to calls that start after it is saved; calls already running finish under the settings they started with
(browsers work the same way). This covers the site settings (`sites`: never_visit, hand_off, ports, spacing) and
`doors`. A background door-check job is its own call and reads them when it starts. Work outside any call (the shared
Safe Browsing list download) reads the file as it is at each request. `tiresias settings set` and `reset` say so:
"Applies to new requests; requests already running finish under the settings they started with." A change racing a
call already in flight is therefore not a finding. The mid-call re-checks added in rounds 1, 3, 4 and 9 (the queue's
second look at never_visit, hand_off and ports after the wait, re-queueing when the spacing rose, refusing when it
kept rising, and the second look before a cached copy is served) are removed as redundant under this rule.

### W-30: fast first read

- **Order.** A first read of a site with no fresh door answers fetches robots.txt, then the page, and replies. The six door
  checks (llms.txt, llms-full.txt, two MCP addresses, two OpenAPI addresses) start only after the page was read
  successfully (`ok` or `unchanged`); a wall, a price tag, a refusal, an error or a file warning starts nothing.
  The reply carries top-level `doors_pending: true` and a fixed sentence at the end of `message`.
- **Measured (local test server, real 1-second spacing, `settings.test.ts`):** first read **1,028 ms** in the
  background mode against **7,037 ms** with `doors: "wait"` (v0.5.1 behaviour).
- **Politeness is unchanged.** Background checks go through the same per-site queue, shared spacing file, leases,
  Crawl-delay, Retry-After and Safe Browsing checks as any request (`politeFetch`). They run **one at a time**
  (`probeOrigin(origin, { sequential: true })`): each is queued only after the one before it is done, so a read of
  the same site that arrives meanwhile waits behind at most one probe, never all six. The first wall, price tag or
  failure stops the rest: in the background a probe that FAILED (no answer, a timeout, a 5xx or a 429) is not "no
  door" but a stop, and nothing is cached (Codex round 1). In the "wait" mode the probes are queued together as
  before, and a failed probe still counts as no door, as in v0.5.1.
- **Caching.** Answers are cached exactly as before (an hour, `doors:<origin>`). New: a door answer learned while the
  site has a Retry-After wait running is used for that call but not kept (a refused probe says nothing about the
  door). This applies to both modes.
- **Next read.** Uses the cached doors (`cachedDoors`), no probes, no `doors_pending`. While a job for that site
  is still running, a read neither waits for it nor starts a second one; it reads without the doors and says
  `doors_pending` again.
- **No source flip.** Without fresh door answers a read goes back to where its kept copy came from (a markdown
  twin, llms.txt), as `check` always has, so the source does not switch between the twin and the page every time
  the hour-long door cache expires (that would reset `changes`).
- **Private mode: the checks run in the foreground, never in the background.** A private call keeps nothing, so
  background answers could be neither cached nor used; and background work would have to carry the private flag
  past the end of the call. A private read (per call, or the whole session with `TIRESIAS_PRIVATE=1`) therefore
  checks the doors inside the call as v0.5.1 did (slower, nothing kept). `startDoorProbe` also refuses in a
  private context, as a second lock.
- **A job is its own call** (`background.ts`): its own 60-second deadline, its own Safe Browsing gate (the asking
  call's `allow_flagged` never carries over), its own request counter, outside the asking call's context
  (`callContext.exit`). One job per site per profile at a time in a process, at most 32 at once; past that no job
  starts and the reply does not say `doors_pending` (the next read tries again).
- **No orphaned work.** The CLI prints its reply, then waits for every job (`drainForExit`) before `process.exit`;
  each job ends by its own deadline at the latest. Ctrl-C or SIGTERM during that wait cancels every job (each
  gives back its turn and lease and writes nothing) and the CLI exits with 130. In the MCP server a job simply runs
  after the reply has been sent; the server process ends when its jobs do.
- **`doors` setting** (`config.json` key `doors`, `"background"` default or `"wait"`): read on every read call; a
  bad value fails the read with an error naming `"doors"`. Like `scanner`, it is checked where it is used, so a bad
  value never stops `clear` or the daily trim. The test suite keeps v0.5.1's "wait" as its default through
  `TIRESIAS_DOORS_DEFAULT`, honoured only under Node's test runner (like `TIRESIAS_HOST_SPACING_MS`); the v0.6 tests
  unset it.

### W-25: site settings

- **Where:** `config.json` key `sites`, an object from a site to its settings (`src/sites.ts`). Set from the command
  line (`tiresias settings set <name> <site> <value>`, W-29) or by editing the file. Never through MCP.
- **A site is named by its host, not an origin** (spacing is still kept per origin, see below). "Allowed ports" cannot be keyed by an origin (the origin already names
  a port), so a site is a host: `example.com` covers every scheme and port of exactly that host; `*.example.com`
  covers that host and every name under it (like Chrome's `[*.]example.com`). Hosts are compared in the URL
  parser's own form (lower case, IDNA/punycode) with a trailing dot removed, so `EXAMPLE.com.` and `bücher.example`
  match their entries. A wildcard on an IP address is refused. In `config.json` a key must already be in its written
  form (`Example.com` is refused, naming the form to use), so one site is never two entries; the CLI accepts
  capitals, a trailing dot or a whole URL and writes the form. At most 500 sites.
- **Precedence: per setting, the most specific entry that sets it** (the exact host, then the closest wildcard).
  `docs.example.com: {hand_off: true}` with `*.example.com: {never_visit: true}` gives docs both, and
  `never_visit` beats `hand_off`.
- **Settings:**
  - `spacing_seconds` (1 to 30, decimals allowed): the least time between two requests to the site. It can only
    raise the spacing: the request waits the larger of this, the default 1 second and the robots.txt Crawl-delay.
    Values under 1 are refused (the floor is the default), over 30 refused (Tiresias already declines a
    Crawl-delay over 30). Applies to robots.txt, the page, every redirect hop and every door check. Per origin
    (scheme, host, port), like every spacing (coordinator's decision after round 3).
  - `ports` (`"8443,9000-9100"`, the `TIRESIAS_ALLOW_PORTS` format): extra ports allowed for that site only, on top
    of 80, 443, 8000 to 8999 and `TIRESIAS_ALLOW_PORTS`. Private addresses stay refused whatever the port.
  - `hand_off` (true/false): never read the site; the reply is `status: "wall"` with
    `handoff.reason: "owner_hand_off"`, fixed text, and the link in `untrusted_content.handoff.open_this`. **No
    handoff ticket** is kept (resuming would only hand it off again; `handoff.resume` says so). A fresh copy in
    the shared cache is **not** served. A `resume` with a page the person saved still works: that is the handoff.
  - `never_visit` (true/false): send the site nothing; `status: "refused"` with fixed text and the refused URL in
    `untrusted_content.refused_url`.
- **Enforced at four points:** (1) `guarded()` checks the asked URL first, before Safe Browsing, robots.txt or the
  cache (not for a page a person provided, which requests nothing); (2) `safeFetch` checks every hop, so a redirect,
  a robots.txt fetch (which bypasses `politeFetch`) or a door probe to such a site is stopped before anything is
  sent; (3) `policyCheck`, so a form's target is refused before a permission slip use is claimed; (4) the queue,
  right before a request is sent, so a setting changed while a request waited its turn still applies (round 1). The
  error is a `SiteRefused`, a subclass of `Refused`, so every existing path treats it as a "no" (a probe: no door;
  robots.txt: the read fails closed; a form: not sent).
- **The reply says so:** top-level `site_settings`, a sorted list of fixed codes (`spacing`, `ports`, `hand_off`,
  `never_visit`) for the settings that actually applied in this call: `spacing` only when the site's own spacing was
  larger than the default and the Crawl-delay; `ports` only when the port was allowed by the site's setting and not
  the default list. Background door checks are their own call and never mark the asking call's reply.
- **A bad `sites` value fails every call that sends a request**, with an error naming the site and the setting
  (`config.json: "sites" → "example.com": "spacing_seconds" must be ...`), and nothing is sent: a broken entry might
  be a `never_visit`, so it fails closed. Like `scanner` and `doors`, `clear` and the daily trim never read it.
- **History:** `owner_hand_off` is a known wall reason in the history log (needs report and daily log count it like
  any wall).
- **Not isolable by a test:** none; each enforcement point has a test that fails without it (16 mutations checked).

### W-29: the settings command

- **Shape:** `tiresias settings` (also `settings show`/`list`), `settings set <name> [<site>] <value>`,
  `settings reset <name> [<site>]` (`src/settings.ts`; `cli.ts` only hands it the words after `settings`).
  JSON by default, `--text` for a readable page. Exit 1 when `config.json` has a problem (the listing still comes,
  on standard error, with each bad key's `problem`).
- **What is listed:** every `config.json` key (`doors`, the five storage limits, `signature_agent`,
  `signature_agent_style`, `safe_browsing`, `web_risk_key_file`, `scanner`), each site setting (one row per site
  and setting set, and a row with the default for each setting no site sets), any unknown key in the file (as a
  problem), and the owner's environment variables (read only here: `TIRESIAS_HOME`, `TIRESIAS_PROFILE`,
  `TIRESIAS_PRIVATE`, `TIRESIAS_SAFE_BROWSING`, `TIRESIAS_ALLOW_PORTS`, `TIRESIAS_MAX_BYTES`,
  `TIRESIAS_MAX_FILE_BYTES`, `TIRESIAS_PARSE_BUDGET_MS`, `TIRESIAS_WORKER_HEAP_MB`, `TIRESIAS_PDF_MEMORY_MB`,
  `TIRESIAS_WEB_RISK_KEY`). Each row: `name`, `value`, `default`, `description`, `stored` (the full path of the
  profile's `config.json`, or "environment variable"), `is_set`, and `problem` when the stored value does not
  validate. Test-only variables are not listed. **The Web Risk key is shown only as "set" or "not set"**; the key
  file is named, never read.
- **Values:** whole numbers for the limits; `on`/`off` (or `true`/`false`) for booleans; `background`/`wait`;
  `signature_agent` is stored the way the reader reads it (`https://Example.com` becomes `https://example.com`);
  `spacing_seconds` takes up to two digits and three decimals; `ports` the `TIRESIAS_ALLOW_PORTS` format; a site may
  be given with capitals, a trailing dot or as a whole URL and is stored in its written form. `hand_off off` and
  `never_visit off` store `false` (it overrides a wildcard); `reset` removes the entry so a wildcard applies again.
  An emptied site, and an emptied `sites`, are removed.
- **`scanner` is not set here** (it takes a command line with `--`); `settings set scanner` points to
  `tiresias scanner set`. `settings reset scanner` removes it (like `scanner off`).
- **Validation and writing** (`writeConfig` in `config.ts`, which this track owns): under a lock beside the file
  (`config.json.lock`, the slips and spacing lock helper: taken within 1 second or the change is refused with fixed
  text, and another command's lock is never removed), the file is read, changed, and the WHOLE result is checked
  with the reader's own parsers before anything is written; then an exclusive temp file (0600, no link followed),
  fsync, rename. A refused change says `Not changed.` and names the key; the file is untouched. A change that writes
  nothing (resetting what is not set) creates no file. A broken key elsewhere in the file blocks every change until
  it is reset (or fixed by hand), so a set never writes over a file the reader would refuse; a broken `sites` is
  never overwritten by a site setting.
- **Private mode** (`--private` or `TIRESIAS_PRIVATE=1`): `set` and `reset` are refused; the listing works.
- **CLI only, as the scanner hook:** no MCP tool or parameter reads or changes a setting. A test checks that no
  MCP tool is named like a setting or takes a parameter named after one, and that the MCP server does not load the
  settings code.
- **No typed confirmation** (unlike `slip grant`): the threat the slip gate meets is an agent granting itself
  permission to act on the web. A setting only narrows or slows what Tiresias does, or loosens a rule an agent with
  a shell could already loosen by editing `config.json` (the same trust as `scanner set`, which also has none).
  `ports` is the one setting that widens reach; private addresses stay refused whatever the port.
- **`CHANGELOG.md` is not edited:** it is generated from docs/SPEC.md section 10 (`scripts/changelog.mjs`), which the
  coordinator writes.

## Codex rounds

### Round 1 (`docs/reviews/2026-10-24-v06-settings-round-1.md`: HIGH 0, MEDIUM 6, LOW 4), all fixed

Each with a test that fails without it (18 mutations checked).

1. **One site, one clock** (M). A trailing dot made a second, independent queue, spacing file and Retry-After entry
   for the same host. New `sitekey.ts`: `hostKey` and `canonOrigin` (lower case, no trailing dot); the queue
   (`throttle`, `noteDelay`) and the cooldown log (set, check and load) use it. And a site's own spacing is per
   HOST across schemes and ports: when one applies, the request also takes a slot on the host's own clock
   (`host:<name>`, its own shared spacing file and in-memory entry), so two ports of one site cannot each run at
   full speed. (The default 1-second spacing stays per origin, as v0.5.1 decided.)
2. **Checked again right before sending** (M). Site settings are now applied inside the queue (`queue.ts`), after the
   wait for the turn and the spacing: a site the owner set to `never_visit` or `hand_off` meanwhile is refused there,
   and a spacing the owner raised meanwhile is waited out (up to 3 rounds). The site spacing is no longer passed in by
   `fetcher.ts` and `rules.ts`; the queue reads it itself, for pages, robots.txt and door checks alike.
3. **One config writer** (M). `scanner set` and `scanner off` now write through `config.ts` `writeConfig` (the same
   lock and atomic write as `tiresias settings`); scanner.ts's own copy is gone. (`scanner set` keeps its v0.5
   behaviour of not checking other keys.)
4. **An owned lock for config.json** (M). New `ownedlock.ts`: the lock file holds the owner's pid and a random token;
   it is broken only when that process is gone (round 2: never for its age); it is released only while it
   still holds our token; and `writeConfig` checks it still holds the lock right before the rename, so a writer
   suspended past 60 seconds writes nothing. (`lockfile.ts` is unchanged for the spacing file and slips.)
5. **Background cancellation reaches every wait** (M). Waiting on another call's robots.txt fetch now ends with this
   call's own cancellation or deadline (`rules.ts` `untilCancelled`), and the discovery answers are not cached once
   the call is cancelled (`throwIfCancelled` before the write; not isolable by a test, as no await separates the
   last step from the write).
6. **The MCP server cleans up on a signal** (M). `tiresias mcp` installs SIGINT/SIGTERM handlers
   (`installShutdown`): background jobs are cancelled, each gives back its turn and lease, and the server exits 130
   or 143.
7. **A failed probe stops the background checks** (L), see W-30 above.
8. **A copy served from the cache starts or reports the checks** (L): with no door answers, a `cache: "fresh"` read
   starts the background checks (or reports the running job) with `doors_pending`, so a cancelled or refused job is
   retried. It costs the site the door checks only, never the page.
9. **A pending read lists the page's own doors** (L): feeds, an API description and structured data from the page
   are summarized against an empty origin answer, so `available_doors` is there while the origin checks run.
10. **Reset says what is in force** (L): `settings reset <site setting> <site>` reports the value now in force (a
    wider wildcard's, naming it, or the default) and returns it as `value`.

### Round 2 (`docs/reviews/2026-10-24-v06-settings-round-2.md`: HIGH 1, MEDIUM 4, LOW 2), all fixed

Each with a test that fails without it (9 mutations checked).

1. **A huge host name** (H). `candidates()` built every suffix of the host, synchronously, before any deadline. A host
   name over 253 characters (DNS's limit; a little more allowed for a trailing dot or IPv6 brackets) is now refused
   at once (`SafetyError`, fixed text), before any work on it; that check runs on the asked URL first and on every hop.
2. **Concurrent private calls on two ports** (M). A site spacing's slot on the host clock is now claimed in memory
   BEFORE the wait, so concurrent calls, private ones included (which write no shared file), each get a later slot.
3. **A spacing turned on later counts earlier requests** (M). Every request now leaves its time on the host's clock
   (in memory, and on the host's shared spacing file when not private), so a site spacing turned on afterwards, or
   one that another profile or process has, counts requests already made on any port. A request with no site
   spacing only reads spacing DEBT from the host clock (a start plus a site spacing), never a bare start time, so
   origins stay as independent as in v0.5.1.
4. **The config lock never expires a live owner** (M). A lock is broken only when its owner's process is gone; a lock
   whose owner cannot be told (empty or damaged) only after 60 seconds. A stale lock is moved away with one atomic
   rename and the moved file's token checked; if it was a live lock after all (another recoverer replaced the stale
   one meanwhile), it is put back with `link()`, which never overwrites, and an owner whose lock was lost anyway
   writes nothing (`stillOwned`). The busy message says to delete `config.json.lock` when no Tiresias command is
   running (a reused process id would otherwise hold it). *The two-recoverer interleaving is not isolable by a
   test* (it needs two processes paused between two system calls); the live-owner and unknown-owner rules are tested.
5. **Shutdown waits for running calls too** (M). Every foreground call registers (`enterCall`) and listens to a
   process-wide `shutdownSignal`. On SIGINT/SIGTERM the MCP server admits nothing new (calls fail at once, no job
   starts), cancels every call and job, and exits only once each has finished its cleanup (turns, leases,
   quarantine copies).
6. **A bad `doors` fails every read** (L), private reads and reads served from the cache included: the setting is read
   once at the top of every read.
7. **`settings reset web_risk_key_file`** (L) reports the key file the reader falls back to (the default profile's
   `~/.config/tiresias/secrets.env`), the same default the listing shows.

### Round 3 (`docs/reviews/2026-10-24-v06-settings-round-3.md`: HIGH 0, MEDIUM 5, LOW 0): stopped, then fixed by decision

Three findings are the same ones fixed in rounds 1 and 2, back for a third time, which is the guard for stopping:

- **The config lock** (rounds 1 #4, 2 #4, 3 #4): any automatic recovery of a stale lock file can, in a rare
  interleaving of three processes, let two writers commit. Option that ends the class: **never recover
  automatically**. A lock left by a process that is gone is reported ("delete config.json.lock in the store
  folder"), and the owner deletes it. Cost: after a crash in the middle of `settings set`, the owner deletes one file.
  (Node has no built-in OS file lock; a native module is the other option.)
- **Cross-port host spacing** (rounds 1 #1, 2 #2/#3, 3 #2/#3): every fix of the host clock left another case (the
  origin file not moved forward when the host clock pushed a request later; a profile with no site spacing reading
  debt without claiming a slot). Option that ends the class: **make a site spacing per origin, like every other
  spacing** (drop the host clock), and document that `spacing_seconds` applies to each scheme and port of the host
  separately. Cost: a site on several ports can get one request per spacing on EACH port. Other option: when a
  host has spacing debt or a site spacing, make the host the queue's identity (one queue, one lease, one file),
  a larger change to queue.ts.
- **Signal shutdown** (rounds 1 #6, 2 #5, 3 #5): each fix covered one more kind of work (jobs, then calls; now the
  shared Safe Browsing list download). Option that ends the class: one process-wide registry that every piece of
  work holding a lease joins (the lease itself registers in `acquireActive`), so shutdown waits for every lease
  whatever started it.

The two others are new and small: **#1** a site's `ports` is not checked again in the queue after the wait (same
fix as the never_visit recheck); **#2** belongs to the host-clock class above.

**Coordinator's decisions (2026-10-24, after round 3), all applied, each with tests (5 mutations checked, plus the
lease-list test):**

1. **The config lock is never cleared automatically** (`ownedlock.ts`). No age rule, no dead-owner rule, no rename
   recovery: a lock is removed only by the command that took it (and only while it holds that command's token) or by
   a person. When a lock is held, `settings set|reset` and `scanner set|off` wait up to a second, then refuse with a
   message naming the lock file and the exact command to delete it (`rm "<store>/config.json.lock"`). This is an
   owner-only command-line path, so a person is always there. Cost: after a crash in the middle of a config write,
   the owner deletes one file. This replaces round 2's recovery rules (round 1 #4, round 2 #4 and round 3 #4 are closed).
2. **A site's spacing is per origin** (scheme, host and port), the same as every spacing since v0.5.1. The host clock
   from rounds 1 and 2 is removed (`queue.ts`, `hosts.ts` helpers gone). `spacing_seconds` on `example.com` applies to
   each scheme and port of that host separately; a site served on several ports can get one request per spacing on
   each. One name per site stays (a trailing dot is the same origin, `sitekey.ts`). This closes round 1 #1, round 2
   #2/#3 and round 3 #2/#3.
3. **One process-wide list of work, one bounded shutdown** (new `lifetime.ts`). Every foreground call and background
   job registers its promise (`work`, `enterCall`); every lease (the `.active` file saying a request to a site is in
   progress) registers its file when it is taken (`hosts.ts` `acquireActive`), whatever took it: a page, robots.txt,
   a door check, the shared Safe Browsing list download. `shutdownSignal` aborts every request (`safeFetch` listens
   to it), every call (`guarded`) and every job, and stops new work. On SIGINT/SIGTERM (the MCP server, and the CLI
   while it waits for background checks) `shutdown()` cancels everything, waits up to **10 seconds**
   (`SHUTDOWN_MS`) for the work to finish its own cleanup, then removes any lease file still registered (each is
   this process's own) and exits 130 or 143. This closes round 1 #6, round 2 #5 and round 3 #5. (A job's own signal
   also listens to the shutdown; that is redundant with `safeFetch` listening to it and is not isolable by a test.)
4. **Ports are checked again in the queue** (round 3 #1): right before sending, after the wait, the queue checks the
   port again with `assertPort` (the default list, `TIRESIAS_ALLOW_PORTS`, and the site's `ports`), as it does
   `never_visit` and `hand_off`.

### Round 4 (`docs/reviews/2026-10-24-v06-settings-round-4.md`: HIGH 0, MEDIUM 3, LOW 1), all fixed

Each with a test that fails without it (5 mutations checked).

1. **Listeners on the shutdown signal** (M): every `safeFetch` now removes the abort listeners it added (on the call's
   signal, the caller's and the process-wide shutdown signal) when the request ends, so a long-running MCP server
   does not collect one per request.
2. **Lease-only shutdown** (M): when only leases are left, each turn of the shutdown loop waits on a real timer
   (50 ms, cleared when the work finishes first), so the cleanup that gives a lease back can run instead of the loop
   spinning to the 10-second bound.
3. **A spacing that keeps rising** (M): a request whose site spacing is raised while it waits is re-queued up to 3
   times; if the spacing is still higher after that, the request is not sent (`refused`, fixed text: try again).
   It never leaves under a smaller spacing than the one now set.
4. **One job and one answer per site, whatever its spelling** (L): the background job's key and the discovery
   cache's key use `canonOrigin`, as the queue and the cooldown log do.
5. *(Found while testing round 4's fixes.)* After a Ctrl-C, the CLI's own "exit 0 once the background checks are
   done" could win against the shutdown's exit code; the CLI now leaves the exit to the shutdown (130 or 143).

### Round 5 (`docs/reviews/2026-10-24-v06-settings-round-5.md`: HIGH 0, MEDIUM 1, LOW 1), all fixed

Each with a test that fails without it (4 mutations checked).

1. **The CLI's normal end waits for all registered work** (M). The shared Safe Browsing list download now registers
   as process work (`lifetime.work`), and the CLI's last step (`drainForExit`) waits for EVERY registered piece of
   work and lease (`lifetime.finish`), not only door checks, up to the job deadline plus 30 seconds; anything still
   running then is cancelled and cleaned up as in a shutdown.
2. **Room for slow sites** (L). A background job's deadline is now a call's 60 seconds plus six times the largest
   spacing Tiresias keeps (30 s): 240 seconds, so six spaced door checks can finish on a site with a 30-second
   Crawl-delay or site spacing. The CLI may wait that long after printing on such a site (Ctrl-C cancels cleanly).

### Round 6 (`docs/reviews/2026-10-24-v06-settings-round-6.md`: HIGH 0, MEDIUM 3, LOW 1), all fixed

Each with a test that fails without it (5 mutations checked).

1. **A form's target meets the site settings first** (M): `form_submit` checks `never_visit` and `hand_off` on the
   target before the Safe Browsing gate or the DNS check learn it.
2. **The Web Risk endpoint obeys the site settings** (M; reworked in round 7): before the key-bearing request is built, the endpoint's own
   site settings apply: `never_visit` or `hand_off` refuses the call (the owner said no; it is not reported as
   "unavailable"), and a site spacing for the endpoint is waited for through the queue (only the endpoint's address
   without the query goes to the queue, never the key). The default 1-second spacing does not apply to it (an API
   call, not a visit).
3. **The CLI installs the shutdown handlers before any work** (M): Ctrl-C or SIGTERM during any command, a foreground
   read included, runs the bounded cleanup (leases, quarantine copies) and exits 130 or 143.
4. **Markdown twins for a trailing-dot URL** (L): the candidates are built from the site's one name, like the door
   answers they are looked up in.

### Round 7 (`docs/reviews/2026-10-24-v06-settings-round-7.md`: HIGH 0, MEDIUM 2, LOW 0), all fixed

Each with a test that fails without it (4 mutations checked).

1. **A long spacing on the Web Risk endpoint** (M). The endpoint's site settings and spacing (`webRiskTurn`) now run
   BEFORE the lookup's own 5-second timer starts, on the call's deadline. And the whole Safe Browsing check is a
   policy wait inside `safeFetch`: the site's request timer is paused while it runs, as for robots.txt and the
   queue. *The wiring inside the gate (turn first, timer after) is not isolable by a test*: the gate only asks Web
   Risk about a public, resolvable host name, which the offline suite cannot provide; `webRiskTurn` itself and the
   paused timer are tested.
2. **Leases have owners and outlive their holders' work** (M). A lease file now carries a random token and is removed
   only while it still holds its taker's token (on release and in the shutdown cleanup, which calls the lease's own
   owner-checked remover, never removes by name). A lease is stale when its process is gone, or after 300 seconds
   (was 75), longer than any holder can live (a background job: 240 seconds), so a live holder's lease is never
   taken for its age.

### Round 8 (`docs/reviews/2026-10-24-v06-settings-round-8.md`: HIGH 0, MEDIUM 3, LOW 0): stopped, then fixed by decision

1. **The Web Risk endpoint and site settings** (rounds 6 #2, 7 #1, 8 #1): the endpoint's turn is released before the
   target's DNS check (up to 5 s), so concurrent lookups can go out together despite a site spacing, and a
   `never_visit` set during that DNS wait is not checked again before the request. This is the third report of the
   same finding after two fixes: the guard. **Option that ends the class:** site spacing does not apply to the Web
   Risk endpoint (it is an API call governed by Google's own quota, not a visit, and the default spacing already
   does not apply to it); only `never_visit` and `hand_off` apply, checked synchronously immediately before the
   request is sent (no await between the check and the send), and either one makes the Web Risk step refuse the
   call as now. Cost: an owner cannot slow Web Risk calls with `spacing_seconds`.
2. **The CLI's drain bound** (new): when the normal drain runs past its bound, `finish()` cancels everything through
   the shutdown signal, and `drainForExit` then waits for an exit that no signal started. Fix: `finish()` cancels
   through its own path and reports it, and the CLI exits with the command's own code afterwards. Small and clear.
3. **Lease release racing a recovery** (round 7 #2, round 8 #3; one fix so far): a holder suspended between reading its
   token and deleting the file can delete a lease another process took after the 300-second age rule. **Option that
   ends the class (same as the config lock decision):** a lease is never taken from a live process for its age; it is
   recovered only when its process is gone (under the existing per-site lock), so no live holder's lease is ever
   replaced and the race cannot happen. Cost: a process id reused by an unrelated live process keeps the site's lease
   until that process ends or the daily sweep removes day-old files.

**Coordinator's decisions (2026-10-24, after round 8), all applied, each with a test that fails without it
(4 mutations checked):**

1. **Web Risk is an API call, not a site visit.** A site's `spacing_seconds` does not apply to the Web Risk endpoint
   (`webRiskTurn` is gone). Only `never_visit` and `hand_off` apply, checked in `webRisk()` at send time, with nothing
   awaited between the check and the request; either one refuses the call (not "unavailable"). **Cost, accepted:** an
   owner cannot slow Web Risk calls with a spacing setting. (Round 6 #2 and round 7 #1's endpoint part are replaced.)
2. **Drain bound.** When the CLI's wait for leftover work (`drainForExit`) runs past its bound with no signal,
   `finish()` cancels and cleans up the leftover work and the CLI exits with the command's own exit code. Only a
   real signal (`lifetime.signalled()`) hands the exit to the shutdown (130 or 143).
3. **Leases are never taken from a live process,** however old (`hosts.ts`): a lease is stale only when its process
   is gone; one with no readable process id is judged by age (300 s). A request waiting on a live process's lease
   gives up after 50 seconds (`leaseWaitMs`; test-only override `TIRESIAS_LEASE_WAIT_MS` under Node's test runner)
   with a `refused` reply whose message names the holder's process number, **the residual** ("if no Tiresias process
   with that number is running, another program has reused the number: the site stays blocked until that program
   ends or the daily cleanup clears the lease file") and the exact lease file to delete to unblock it now. With no
   live holder ever replaced, the release race of rounds 7 and 8 cannot happen (round 7 #2 / round 8 #3 closed).

### Round 9 (`docs/reviews/2026-10-24-v06-settings-round-9.md`: HIGH 0, MEDIUM 4, LOW 0), all fixed

Each with a test that fails without it (7 mutations checked).

1. **Spacing counts from completion** (M). A held turn (page, robots.txt, door check) ends when its answer has been
   read; at that moment, before the lease is given back, the site's clocks move on: this process's own (private calls
   included) and the shared spacing file (other processes). Time spent signing, resolving and connecting therefore
   never eats the next request's spacing, Crawl-delay or site spacing. This is more conservative than v0.5.1
   (spacing from the START): a slow answer now delays the next request by the full spacing after it.
2. **A copy served from the cache meets the site settings again** (M): right before a fresh cached copy is served
   (after the Safe Browsing and robots.txt waits), `never_visit` and `hand_off` are checked again.
3. **Lease recovery takes an owned guard** (M): recovering a stale lease now takes `<lease>.lock` through
   `ownedlock.ts` (one attempt per poll, never broken for its age, released only by its taker) instead of the
   5-second spacing lock, so a recoverer paused between its check and its delete cannot have its guard taken and a
   replacement lease deleted. A wait that gives up names the guard file too, when one is there.
4. **The daily sweep takes part in the lease protocol** (M): `sweepHosts` removes a day-old lease only when it is
   stale (its process gone), checked again under its recovery guard, and a day-old guard only when its process is
   gone; guards are looked at first. A live process's lease or guard is never swept, however old. Spacing files
   and the spacing lock are swept by age as before.

### Round 10 (`docs/reviews/2026-10-24-v06-settings-round-10.md`: HIGH 0, MEDIUM 3, LOW 0), all fixed

Each with a test that fails without it (5 mutations checked).

1. **The full delay from completion** (M; second report of round 9 #1). At completion both clocks move on by the
   LARGEST delay the site asked for: the request's own admitted spacing, or a Crawl-delay learned from robots.txt
   while the turn was held (`delayOf` in `queue.ts`). This process's own clock (`nextOk`, which private calls rely
   on, as they write no shared file) and the shared file both get it.
2. **Recovery guards are never swept** (M; second report of round 9 #4). Deleting a guard whose process looked gone
   could not be made atomic, so a guard (`<lease>.lock`) is now never removed automatically, the same rule as the
   config lock: only its taker or a person removes it. A stale lease is still swept or recovered under its guard. A
   guard left by a crashed process keeps its site's lease; a wait that gives up names both files to delete.
3. **Bounded lease metadata reads** (M). One reader, `readLeaseMeta`, for every lease and guard: no links followed,
   no blocking on a FIFO, a regular file of ours, at most 256 bytes.

### Round 11 (`docs/reviews/2026-10-25-v06-settings-round-11.md`: HIGH 0, MEDIUM 4, LOW 0): stopped, then fixed by decision

1. **Completion spacing across processes** (rounds 9 #1, 10 #1, 11 #1: the guard). Completion moves the shared file's
   `next` but leaves `last` at the admission time, so another process that needs a LARGER spacing measures it from
   admission. **Option that ends the class:** every clock always records the latest completion as a whole: at
   completion, under the spacing lock, the shared file becomes `{last: completion, next: max(next, completion +
   delay)}` (and this process's `lastHit`/`nextOk` the same), so every reader, whatever spacing it needs, measures
   from the last completion. Plus a cross-process test with a larger later spacing.
2. **`delayOf` can grow without bound** (new, small): prune it with the other clocks on every admission and
   completion (entries whose `lastHit` has expired), and add it to the map-size test.
3. **Settings changed during signing** (new form of the queue recheck of rounds 1 #2 and 3 #1). The queue checks
   `never_visit`, `hand_off` and ports, then `safeFetch` awaits signing before it sends. **Option:** one final
   synchronous `never_visit`/`hand_off`/port check in `safeFetch` immediately before the request is started, with
   nothing awaited between; a spacing raised during signing (milliseconds) is accepted by design, not re-admitted.
4. **A cached copy and `hand_off` during content preparation** (round 9 #2, second report): the recheck runs before
   `finishPage`, whose question search can await a worker. **Option:** recheck after the content is prepared, right
   before receipts are recorded and the cached copy is returned.

**Coordinator's decisions (2026-10-25, after round 11), all applied, each with a test that fails without it
(6 mutations checked):**

1. **A completion is recorded whole** (`hosts.ts` `noteCompletion`): at completion, under the spacing lock, the
   shared file becomes `{last: max(last, completion), next: max(next, completion + delay)}`, and this process's own
   clocks the same, so every reader, whatever spacing it needs, measures from the last completion.
2. **The per-site delay map is pruned** with the clocks it belongs to (on every admission), and is part of the
   map-size test.
3. and 4. **The timing rule** above: the call's snapshot of the settings (`CallContext.sites`, read in `guarded()`
   and at the start of a background job; `ruleFor` uses it), with the mid-call re-checks removed. Tests: a never_visit
   saved while a call waits its turn does not stop that call and stops the next; a hand_off saved during a call
   served from the cache does not stop it and stops the next; ports come from the snapshot; `settings set` and
   `reset` print the rule.

### Round 12 (`docs/reviews/2026-10-25-v06-settings-round-12.md`): CLEAN

HIGH 0, MEDIUM 0, LOW 0. The track is ready for the coordinator's merge into `v0.6` and the integrated Codex loop.
