# v0.9 Track 1: risky settings need confirmation (W-32)

Branch `v0.9`, worktree `~/Code/tiresias-v09`, from main `e0ae6b1` (v0.8.0 plus a README fix, 859 tests).
Builds exactly the W-32 decision (SPEC section 9, 2026-10-31). Decisions for the coordinator to fold into SPEC.md.

## Progress

- [x] Worktree `~/Code/tiresias-v09` (branch `v0.9`), `npm ci`
- [x] Read SPEC (principles, W-32 row and decision, W-29, the slip person-at-a-terminal check, history and daily log) and docs/v0.8
- [x] This plan
- [x] `src/confirm.ts`: the risky list, phrases, the confirmation record, the in-force clamp, environment variables, the reply notice
- [x] Loaders use the in-force values (saving, rendering, translator, scanner, anchoring, anchor_calendars, safe_browsing, sites, `TIRESIAS_ALLOW_PORTS`)
- [x] Commands: `--confirm` on `settings set|reset`, `scanner set|off`, `translator set|off`; `settings confirm <name> [<site>]`; `settings confirmations off|on`; the listing shows the state
- [x] History and daily log: who made each change; the notice on CLI and MCP replies for 24 hours
- [x] Tests (`src/test/confirm.test.ts`, 9 new) and the older tests that hand-write risky settings (they turn confirmations off for their store with `neverAsk`, or pass the phrase)
- [x] README, CHANGELOG (Unreleased v0.9.0), SPEC W-32 row
- [x] Full suite at the checkpoint: 868 of 868 (859 before, 9 new), 0 skipped
- [x] Codex review loop (fix HIGH only; MEDIUM and LOW deferred below): 6 rounds, 15 HIGH fixed (7, 3, 2, 1, 2, 0), 7 MEDIUM and 1 LOW found, of which 1 MEDIUM was closed by a HIGH fix; 6 MEDIUM and 1 LOW deferred below
  - [x] Round 1 (`docs/reviews/2026-10-31-v09-confirm-round-1.md`): HIGH 7, MEDIUM 4, LOW 1. All seven HIGH fixed, with a test (`Codex v0.9 round 1`): (1) the ratchet no longer adopts what config.json holds when it is "stricter" one way and looser another (another translator program, other calendars or ports): the record becomes what is IN FORCE, which the clamp already holds back; (2) no config.json while asking is on is an empty one, so confirmed site restrictions stay in force; (3) site settings are compared by their effect for each site key (the entry, then the closest wildcard above it, as the readers resolve them), so removing an exact `ports` entry that a wildcard with other ports replaces is looser; (4) and (5) site entries are held back only when `sites` parses exactly as the readers parse it (otherwise every request fails by name), and only written-form site names from the record are used, so odd names or `__proto__` never reach the clamp or a notice (the first part of this was already in the commit after the one reviewed); (6) every settings command, a setting that is not risky included, brings the record up to what is in force; (7) new site restrictions made by hand are taken in by that too. MEDIUM and LOW deferred below
  - [x] Round 2 (`docs/reviews/2026-10-31-v09-confirm-round-2.md`): HIGH 3, MEDIUM 1, LOW 0. Codex confirmed the seven round-1 fixes. The three HIGH fixed, with a test (`Codex v0.9 round 2`): (1) while `sites` does not parse, no site setting is changed, reset or confirmed, and no risky value that does not validate is confirmed (a comparison that cannot be made is never taken as "stricter"); (2) the record is written compact, read with a 4 MB limit (its confirmed part is never more than the risky part of a readable config.json, 1 MB), and the writer refuses anything over it, so Tiresias never writes a record it would then call damaged; (3) a site name must be made of DNS or IP characters only (the URL parser let a few others through), and every command Tiresias suggests single-quotes the phrase, the site and the value it repeats. MEDIUM deferred below
  - [x] Round 3 (`docs/reviews/2026-10-31-v09-confirm-round-3.md`): HIGH 2, MEDIUM 1, LOW 0. Codex confirmed the three round-2 fixes. Both HIGH fixed, with a test (`Codex v0.9 round 3`): (1) a command now builds the new record from the ORIGINAL one (what is in force under it, then the target's own value) before anything is written, and counts as looser, needing its phrase, when its target is held back or when the new record would let through anything the original held back (a confirmed wildcard ban dropped from under an exception); the new record is also checked to be one Tiresias would read back before config.json is written; (2) asking again adopts only values the readers accept (others keep their confirmed value), and a record holding any value the readers refuse counts as damaged (this also closes the round-1 MEDIUM about the record parser). MEDIUM deferred below
  - [x] Round 4 (`docs/reviews/2026-10-31-v09-confirm-round-4.md`): HIGH 1, MEDIUM 1, LOW 0. Codex confirmed both round-3 fixes. The HIGH fixed, with a test (`Codex v0.9 round 4`): with no `sites` in force, the ratchet takes that as none (every confirmed restriction still needed is put back by the clamp first), so giving up a confirmed `ports` entry by removing `sites` is taken in, and putting it back by hand later is held back. MEDIUM deferred below. (Full suite run during this round, alongside Codex: 870 of 871; the one failure was a Chrome render that timed out under the load, `render.test` alone passes 18 of 18.)
  - [x] Round 5 (`docs/reviews/2026-10-31-v09-confirm-round-5.md`): HIGH 2, MEDIUM 0, LOW 0. Codex confirmed the round-4 fix. Both HIGH fixed, with a test (`Codex v0.9 round 5`): (1) the change goes into the record (and so the notice) and the record is written BEFORE config.json, under the same lock; history is appended last, and if it fails the command says the change was made and kept but history was not written. So a failure part way never leaves an old, looser confirmation in place after a tightening; (2) the retry commands a scanner or translator refusal suggests single-quote every program path and argument that is not plain, so nothing in them can expand in a shell.
  - [x] Round 6 (`docs/reviews/2026-10-31-v09-confirm-round-6.md`): **HIGH 0, MEDIUM 0, LOW 0**: the loop ends. Codex confirmed both round-5 fixes.
- [x] Full suite after the loop: 873 tests (859 before, 14 new), 871 pass, 0 skipped; the 2 failures are Chrome renders that ran out of time inside the full run (`render.test` W-10 "a JavaScript page renders", `walls-rendered.test` hidden text) and pass alone at the same commit (18 of 18, 6 of 6). The config and record lookups added to the read path cost under 0.1 ms each (measured), so this is the machine's load, not this change; worth one more full run on a quiet machine
- [x] Secret scan (0 matches for all five patterns), push `v0.9`, report to Banks

## Design calls (with reasons)

### What counts as risky (turning it ON or LOOSER needs the phrase)

Risky means: the change gives a page, an agent or a server more reach than the default does, or switches off a
check that protects the owner. Each phrase names exactly what it allows. Turning a risky setting off, back to its
default, or stricter never needs a phrase.

| Setting | Looser when | Phrase | Why it is risky |
|---|---|---|---|
| `saving` | `off` to `ask` | `YES, TURN ON SAVING` | keeps copies of what pages sent, on disk |
| `rendering` | `off` to `ask` | `YES, TURN ON RENDERING` | runs a page's JavaScript in Chrome |
| `rendering` | to `auto` (from `off` or `ask`) | `YES, TURN ON AUTOMATIC RENDERING` | runs JavaScript without the agent asking |
| `translator` | set, or its program or arguments changed | `YES, TURN ON THE TRANSLATOR` | runs a program on page text |
| `scanner` | `send_file` turned on, or its program changed while sending files | `YES, SEND FILES TO THE SCANNER` | hands a dangerous file to a program |
| `anchoring` | `off` to `on` | `YES, TURN ON ANCHORING` | sends hashes and the owner's IP address to outside servers |
| `anchor_calendars` | any calendar added (not already confirmed) | `YES, CHANGE THE ANCHOR CALENDARS` | a new server learns the owner's IP address |
| `safe_browsing` | `true` to `false` | `YES, TURN OFF SAFE BROWSING` | removes the phishing check |
| site `ports` | a port allowed that the confirmed entry did not allow | `YES, ALLOW MORE PORTS FOR <SITE>` | reaches services that are not websites |
| site `spacing_seconds` | lowered or removed below what is confirmed for the site (its own entry or a wildcard above it) | `YES, LOWER THE SPACING FOR <SITE>` | undoes a politeness rule the owner chose |
| site `never_visit` | a `true` removed or set false, or an explicit `false` added (it overrides a wildcard) | `YES, TURN OFF NEVER_VISIT FOR <SITE>` | sends requests to a site the owner banned |
| site `hand_off` | the same | `YES, TURN OFF HAND_OFF FOR <SITE>` | reads a site the owner wanted handed to a person |

`<SITE>` is the site as written in config.json, upper-cased (`EXAMPLE.COM`, `*.EXAMPLE.ORG`).

Not risky, argued:
- `scanner` without `send_file`: the program gets the fingerprint, size and URL only; adding a check never loosens one.
  Changing its program is not gated (an agent with a shell can already run any program it likes; the gate is about
  handing it a dangerous file).
- `doors` (background or wait), `keep_*_days`, `max_disk_mb`, `max_saved_mb`: timing and housekeeping, no new reach.
- `signature_agent`, `signature_agent_style`: signing tells sites who is calling; it is honesty, not reach.
- `web_risk_key_file`: which file holds the Web Risk key; pointing it elsewhere can only make Web Risk unavailable,
  which the reply already reports (`safety: web_risk_unavailable`).
- Private mode has no stored "off" default to loosen (it is a flag or `TIRESIAS_PRIVATE` per session, and being
  private is the stricter state), so there is nothing to gate.

### How it is asked

- The phrase is an explicit argument: `--confirm "YES, TURN ON SAVING"` on `settings set`, `settings reset`,
  `settings confirm`, `scanner set`, `translator set`. It is compared exactly (case, comma, spaces).
- A wrong or missing phrase refuses (exit 1, nothing written) and the message gives the exact phrase and the
  command to repeat, and offers "never ask again" with its own phrase.
- One command changes one setting, so it needs at most one phrase.
- Anyone may type the phrase, an agent included (Travis, 2026-10-31). The phrase is not a password: it stops a
  setting being loosened by accident or in passing (a page's text saying "run tiresias settings set saving ask"),
  and the change is logged and shown in replies. A fully fooled agent can type it; the log makes that visible.

### Never ask again, and asking again

- `tiresias settings confirmations off --confirm "YES, NEVER ASK AGAIN FOR RISKY SETTINGS"`: from then on no phrase
  is asked, hand edits and environment variables apply as written. Changes are still recorded and still shown in
  replies.
- `tiresias settings confirmations on --confirm "YES, ASK AGAIN FOR RISKY SETTINGS"`: asking resumes, and the risky
  values config.json holds at that moment become the confirmed ones (the owner lived with them; reverting
  everything silently would surprise them more). The message lists them.
- A refusal message offers the first; `tiresias settings` shows which is in force.

### The record of the last confirmed state; hand edits

- `confirmations.json` in the profile's folder (written only by Tiresias's commands, atomically, mode 0600, under
  the config lock, right after config.json): `ask` (true or false), `confirmed` (the last confirmed value of each
  risky key and each site's risky entries), `recent` (the last 20 changes: time, what, looser or stricter, who).
- Every reader of a risky setting uses the value **in force**: the config.json value when it is not looser than the
  confirmed one, else the confirmed one (absent = the safe default). So a hand edit that turns saving on is noticed
  and does nothing until it is confirmed: `tiresias settings confirm saving --confirm "YES, TURN ON SAVING"`
  confirms whatever config.json now holds. Replies say so (below). Hand edits that tighten apply at once.
- No record (a fresh store, an upgrade from v0.8, or a deleted record) means the defaults are the confirmed state:
  fail closed. An owner upgrading from v0.8 with saving or rendering on confirms once. A record that cannot be read
  or does not parse is treated the same way, and replies say so.
- Every settings command that writes (any setting) makes the record what is IN FORCE: config.json with every
  unconfirmed loosening held back. That takes in every tightening made by hand (so undoing it later by hand is held
  back) and never adopts a replacement that is looser in any way (Codex round 1).
- Site settings are compared by their effect: for each site key, what the readers would apply (the entry itself,
  then the closest wildcard above it that sets the setting). An explicit `false` under a wildcard `true` is looser;
  one where nothing was on is not. No config.json while asking is on counts as an empty one.
- **Limits, stated plainly.** The record is a plain file in the owner's folder: anything that can write there (an
  agent with a shell, as the owner) can edit both files. Hand edits are noticed when settings are read, not when the
  file changes, and are not written to history (a read never writes the log for them); they appear in replies and
  in `tiresias settings` until confirmed or undone. A value that was confirmed once and is edited back by hand,
  before any settings command has run, is accepted.

### Environment variables

Same rule: `TIRESIAS_RENDERING` (ask or auto beyond the confirmed rendering), `TIRESIAS_SAFE_BROWSING=0` (while
safe_browsing is confirmed on) and `TIRESIAS_ALLOW_PORTS` (any extra port) apply only with their phrase in
`TIRESIAS_CONFIRM` (several separated by `;`): `YES, TURN ON RENDERING` / `YES, TURN ON AUTOMATIC RENDERING`,
`YES, TURN OFF SAFE BROWSING`, `YES, ALLOW MORE PORTS`. Without it the variable is ignored (the stricter value stays
in force) and every reply of that session says so with the phrase. With it, it applies quietly (the owner set both
on purpose). Under never-ask-again they apply as written. A stricter value (`TIRESIAS_RENDERING=off`)
always applies. Not recorded in history: they change nothing stored, and last for one process. `saving` and
`anchoring` have no variable. Resource variables (`TIRESIAS_MAX_*`, budgets, heap) are not gated: they change how
much is read, not who is reached (honest gap: a raised cap uses more memory).

### Who made it

Best effort, stated honestly: a change made while standard input is a terminal is recorded `by: "terminal"`
(likely a person), otherwise `by: "not_terminal"` (an agent, a script or cron). A program that builds its own
pseudo-terminal is recorded as a terminal, the same limit as permission slips. History gets one record per change
(`tool: "settings"`, the setting, the site, `change: looser|stricter`, `by`, `confirmed: phrase|never_ask|not_needed`);
the daily log shows it in its own section, in plain words.

### The notice in replies

For **24 hours** after a looser change, or a change to asking itself, every CLI JSON reply and every MCP reply
carries top-level `settings_notice` (fixed text, at most 5 lines, newest first, plus a count of more). A hand edit
waiting for confirmation, an environment variable ignored for want of its phrase, and a damaged record are in the
notice for as long as they last. `--text` replies end with the same lines. 24 hours covers a working day and the next morning's first
reply, without nagging for a week.

### MCP

Unchanged: no MCP tool or parameter reads or changes a setting or a confirmation; a test lists every tool's
parameters to keep it so. MCP replies only carry the notice.

## Deferred to compute-day sweep

| Round | Severity | Summary | File |
|---|---|---|---|
| 1 | MEDIUM | Spacing compared with the largest wildcard above, not the closest one the readers use (largely addressed by the round-1 effect-based comparison; to be re-checked) | src/confirm.ts |
| 1 | MEDIUM | (Fixed in round 3 with HIGH 2: every confirmed value is now checked with the reader's parser.) The record parser checks its shape but not each confirmed value | src/confirm.ts |
| 1 | MEDIUM | Twenty later changes push a loosening out of `recent` and end its 24-hour notice early; keep notice-relevant events for their full 24 hours | src/confirm.ts |
| 1 | MEDIUM | Some reply paths carry no `settings_notice`: CLI error replies and thrown errors, `profile` JSON, MCP's too-large fallback | src/cli.ts, src/mcp.ts |
| 2 | MEDIUM | Comparisons ignore what is always allowed: a `ports` list of only 443, or resetting a 1-second spacing, asks for a phrase though nothing changes in force | src/confirm.ts |
| 3 | MEDIUM | With config.json removed or emptied, restoring a confirmed wildcard ban leaves out its confirmed exact-host `false` exception, so that host is blocked though it was allowed (too strict, not too loose) | src/confirm.ts |
| 4 | MEDIUM | While `sites` does not parse, `scanner off` and `translator off` are refused too (they only remove a hook); allow removals of top-level hooks, keep refusing site changes | src/confirm.ts |
| 1 | LOW | The command a scanner or translator refusal suggests puts `--confirm` after `--`, where it becomes a program argument; put it before | src/scanner.ts, src/translate.ts |
