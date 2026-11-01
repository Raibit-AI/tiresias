# v0.8 Track 2: tamper-proof receipts (W-08)

Branch `v0.8`, after track 1 (`6c353b5`, save page, 847 tests passing). Decisions for the coordinator to fold into
SPEC.md. Builds on track 1's `snapshotFingerprint` and `receiptFingerprint` (`src/saved.ts`).

## Progress

- [x] Read SPEC (principles, N-03, W-08, W-28, W-14 private mode, W-18 profiles), `docs/v0.8/save.md`, the v0.7 plans
- [x] This plan
- [x] `src/ots.ts`: the OpenTimestamps format (read, write, merge, walk), only the operations calendars use
- [x] `src/anchor.ts`: Merkle batch with salted leaves, calendars (submit, upgrade) through `safeFetch`, batch store, status, prove, verify
- [x] Owner settings `anchoring` (off/on) and `anchor_calendars` (config.json, `tiresias settings`); never from MCP
- [x] `tiresias receipts` items carry `record_fingerprint` (the receipt's id for `receipts prove`; renamed from `fingerprint` at integration so a file-warning record keeps its own)
- [x] CLI: `anchor`, `anchor status`, `anchor upgrade`, `receipts prove <id> [--out <folder>]`, `receipts verify <bundle>`
- [x] `anchors/` not counted by the main disk cap, never removed by `clear`
- [x] Tests (`src/test/anchor.test.ts`) with local fake calendars: 8 new
- [x] Compatibility checked by hand (2026-10-31): a random 32-byte digest submitted to two real calendars (`a.pool.opentimestamps.org`, `ots.btc.catallaxy.com`) parsed and re-serialized byte for byte; the GET upgrade answered 404 (pending) as expected; the official client's `examples/hello-world.txt.ots` parses (its digest is the SHA-256 of `hello-world.txt`, Bitcoin block 358391) and re-serializes byte for byte. That example uses `ripemd160`, so the reader also computes it (never written). Not vendored into the repo (third-party file)
- [x] README, CHANGELOG (unreleased v0.8.0), SPEC W-08 row
- [x] Full suite at the checkpoint: 855 of 855 passing, 0 skipped (847 before; 8 new)
- [x] Codex review loop (fix HIGH only; MEDIUM and LOW deferred below): 2 rounds, 2 HIGH fixed, 5 MEDIUM deferred
  - [x] Round 1 (`docs/reviews/2026-10-31-v08-anchor-round-1.md`): HIGH 2, MEDIUM 3, LOW 0. Both HIGH fixed, with tests: (1) `receipts verify` said `ok: true` for a bundle whose every value came from the bundle itself, so a made-up bundle passed. Now the reply has `offline_ok` (the bundle is consistent and something below its root attests a time) and `proven: false` always, the message starts "NOT proven", and the CLI exits 2 (never 0) when the offline checks pass, 1 when one fails; (2) attestations were collected from the whole timestamp tree, so a genuine Bitcoin branch for the fingerprint could be shown next to an invented salt, path and root. Now only attestations below a node equal to the claimed root count. MEDIUM deferred below
  - [x] Round 2 (`docs/reviews/2026-10-31-v08-anchor-round-2.md`): **HIGH 0**, MEDIUM 2, LOW 0: the loop ends. Codex confirmed both round-1 fixes. MEDIUM deferred below
- [x] Full suite after the loop: 855 of 855 passing, 0 skipped (847 before; 8 new)
- [x] Secret scan (no matches), push `v0.8`, report to Banks
- [x] Integration (Banks's call, 2026-10-31): the round-1 MEDIUM on `fingerprint` in the receipts listing was fixed instead of deferred (`record_fingerprint`, with a test), so 4 MEDIUM remain deferred

## Design calls (with reasons)

### Who may anchor: the owner's `anchoring` setting

- `config.json` key `anchoring`: `"off"` (default) or `"on"`. Set with `tiresias settings set anchoring on`, listed
  in `tiresias settings`. Same pattern as track 1's `saving`: **no environment variable** overrides it, and nothing
  reachable over MCP reads or changes it (W-29). There is no MCP tool for anchoring at all; anchoring is a command
  the owner (or the owner's cron) runs.
- `tiresias anchor` and `anchor upgrade` refuse while the setting is off, and say how to turn it on. `anchor status`,
  `receipts prove` and `receipts verify` work either way (they send nothing).
- As with every setting (track 1 flagged the same for `saving`): an agent with a shell can run `tiresias settings
  set` like the owner. Anchoring publishes only a hash that reveals nothing, and sends only to the owner's calendar
  list, so it gets the same treatment as the other settings; no new confirmation step. Open question for Travis,
  across all settings.
- `anchor_calendars`: the calendars to submit to, 1 to 8 `https://` addresses (comma-separated on the command line).
  Default: the four public OpenTimestamps calendars the official client uses (`a.pool.opentimestamps.org`,
  `b.pool.opentimestamps.org`, `a.pool.eternitywall.com`, `ots.btc.catallaxy.com`). Plain `http://` only for a
  loopback address under Node's test runner (the fake calendars in the tests).

### What is anchored: fingerprints only

- Every record line of this profile's receipts log (quotes, sent forms, file warnings): its fingerprint is
  `receiptFingerprint(line)`, SHA-256 of the canonical form of the line exactly as recorded (track 1).
- Every saved snapshot (W-28) whose manifest is whole and whose id checks: `snapshotFingerprint(manifest)`, SHA-256 of
  exactly the bytes its signature covers.
- Never content, never URLs, never the fingerprints themselves: only the Merkle root of a batch leaves the machine.

### One batch, one root, salted leaves

- `tiresias anchor` gathers every fingerprint not yet in a recent batch (below), up to 20,000 per batch (more: the
  reply says so; the next run takes the rest), puts them in a **random order**, and builds a Merkle tree:
  - leaf = SHA-256(`0x00` || salt || fingerprint), with a fresh **32-byte random salt per leaf**;
  - node = SHA-256(`0x01` || left || right) (the `0x00`/`0x01` prefixes keep a leaf from ever reading as a node);
  - an odd node at the end of a level moves up unchanged.
- Only the root is submitted. Reasons: one public timestamp covers the whole batch (free calendars, one request
  each); the public record holds one random-looking hash per batch, so no receipt can be linked to its neighbours
  from it; the salt means a guessed receipt (a guessed quote on a known page at a known time) cannot be confirmed
  against the root or against the sibling hashes in someone else's proof; the random order means a proof's left and
  right steps say nothing about when its neighbours were recorded.
- A proof for one receipt reveals that receipt, its salt, and the sibling hashes on its path (salted, so they reveal
  nothing about the other receipts) and the path length (about log2 of the batch size).
- "Not yet anchored": a fingerprint is skipped when it is in a batch made within the last `max(keep_receipts_days,
  keep_saved_days) + 2` days, so the set held in memory follows the store's own retention. A receipt still in the log
  after that (the trim did not run) is anchored again, which is harmless. Two `anchor` runs at the same moment may
  anchor the same receipts twice (checked, not locked): also harmless.

### OpenTimestamps, implemented in-house (no new npm package)

- **Why OpenTimestamps**: free, no wallet, no account, public calendar servers, and Bitcoin-backed, so the proof
  does not depend on trusting Tiresias or any one company. No npm package: `src/ots.ts` implements only what is
  needed (the binary timestamp format, the operations calendars use (`sha256`, `append`, `prepend`, and `ripemd160` in older Bitcoin proofs, read only), the
  pending and Bitcoin attestations; any other attestation kept opaque). An answer with any other operation is
  refused (fail closed), so nothing is stored that Tiresias cannot check.
- **Submit**: `POST <calendar>/digest` with the 32-byte root as the body (the official client's request), through
  Tiresias's own `safeFetch`: its address and port checks, the owner's `never_visit`, byte counting (answer at most
  10,000 bytes, as the official client; at most 64 KB on the wire), a 15-second timeout, no redirect followed.
  Each calendar answers with a pending timestamp. All calendars are asked at once; the batch is kept when at least
  one answered; when none did, nothing is written and the same receipts go in the next run.
- **What the calendars learn**: the root (a hash that reveals nothing), the time, and the requester's IP address and
  Tiresias's User-Agent; if the owner set `signature_agent` (N-07), requests are signed like every Tiresias request,
  so the calendars also learn the owner's signing domain. Nothing else. A calendar later publishes (in a Bitcoin
  transaction) a hash that commits to many roots, ours among them.
- **Upgrade**: `GET <calendar>/timestamp/<hex>` for each pending attestation, until a calendar answers with the path
  to a Bitcoin block (usually a few hours later). The address comes from the pending attestation, which the calendar
  wrote, so it is contacted only when it is on the list: the owner's `anchor_calendars` plus the calendars the
  default pools hand out (`*.calendar.opentimestamps.org`, `*.calendar.eternitywall.com`, `*.calendar.catallaxy.com`,
  as the official client allows), `https` only. A 404 means still pending. An answer is merged into the stored proof
  only after it parses whole and every operation is computed.
- **Export**: `receipts prove` writes a standard detached `.ots` file whose file digest is the receipt's fingerprint
  (SHA-256 of the canonical receipt bytes, written next to it), so the official tool checks it:
  `ots verify receipt-<id>.json.ots` (the `.json` next to it). The Merkle path is written in OpenTimestamps
  operations (`prepend 00||salt`, `sha256`, then per level `append`/`prepend` sibling, `prepend 01`, `sha256`), so
  the official tool follows it from the fingerprint to the root to the calendar's Bitcoin attestation.

### Commands and replies

- `tiresias anchor`: upgrade any pending batch first, then build and submit a new batch. One command for cron.
  Refused in private mode and while `anchoring` is off. Exit 0 when it did its job (including "nothing new"), 1
  when no calendar accepted the batch.
- `tiresias anchor status`: the setting, the calendars, the number of fingerprints not yet anchored, the batches
  (newest first: id, time, leaves, pending or complete, Bitcoin block heights).
- `tiresias anchor upgrade`: only the upgrade step.
- `tiresias receipts prove <id> [--out <folder>]`: `<id>` is a receipt's fingerprint (shown as `record_fingerprint` by
  `tiresias receipts`, with or without `sha256:`, or a unique prefix of at least 8 hex characters) or a saved
  snapshot's id. Without `--out` the bundle is printed (the receipt inside `untrusted_content`: it holds web text);
  with `--out` three files are made (never overwriting): `<name>.proof.json` (the bundle), `<name>.json` (the exact
  bytes whose SHA-256 is the fingerprint) and `<name>.json.ots`. A receipt trimmed from the log can still be proven
  by fingerprint (the bundle says the record is not there; whoever holds the receipt can check it).
- `tiresias receipts verify <bundle>`: offline, and never says "proven" (Codex round 1: everything it checks comes
  from the bundle, so anyone can make a bundle that passes): `offline_ok`, `proven: false`, exit 2 when the offline
  checks pass, 1 when one fails. Checks (1) the record's fingerprint, (2) salt and Merkle path to the
  root, (3) the `.ots`: its digest is the fingerprint and its operations reach the root, and lists the attestations.
  It says plainly what it cannot do offline: a Bitcoin attestation needs that block's header (the reply gives the
  block height and the Merkle root to compare, in both byte orders; `ots verify` or any block explorer can do it);
  a pending one needs `tiresias anchor upgrade` and a fresh `prove`.
- No background daemon. Cron, for the owner who wants it (`crontab -e`, one line):
  `17 3 * * * /full/path/to/tiresias anchor --text >> ~/.tiresias/anchor-cron.log 2>&1`
  (a second profile: add `--profile <name>`, one line each).

### Private mode, profiles, failures

- **Private mode is never anchored**: a private call records no receipts and saves no snapshot, so there is nothing
  of it to anchor; and `anchor`/`anchor upgrade` refuse in a private session (they write the store and contact the
  network).
- **Profiles anchor separately**: each profile has its own `anchors/` folder, gathers only its own receipts and
  snapshots, and its batches name the profile.
- **Calendars never fail a read**: anchoring is not on the read path at all; it runs only when the owner runs it.
  A calendar that fails is reported by a fixed code (`network`, `timeout`, `too_large`, `refused`, `bad_answer`,
  `http_<status>`); its text is never shown.

### Storage

`<profile>/anchors/<root>.json`, one per batch (written atomically, 0600, under the store's usual checks): the root,
the time, the leaves (fingerprint, kind, salt, the day file for a receipt or the id for a snapshot) in tree order, the
proof from the root (OpenTimestamps bytes, base64), per calendar the outcome, the status and the Bitcoin heights.
No content, no URLs. Not counted by `max_disk_mb` and not removed by `clear` (the salts are what make old proofs
provable; a batch holds no browsing data); the owner can delete the folder.

## Deferred to compute-day sweep

| Round | Severity | Summary | File |
|---|---|---|---|
| 1 | MEDIUM | A calendar answer may use the full nesting depth (256); the exported .ots then prefixes the Merkle path and cannot be written, so one hostile calendar can stop every export from a batch another calendar served well. Reserve depth for the path when accepting answers, use the official bound (under 256), and drop a bad branch while keeping good ones. | `src/anchor.ts`, `src/ots.ts` |
| 2 | MEDIUM | Merged proofs are checked only for size, not for the parser's 20,000-node limit; several answers or upgrades together can pass it, and the batch then reads as damaged (upgrade and prove refuse it) while its fingerprints count as anchored. Check the node count on every merge (with room for the Merkle path) and keep the previous proof when an addition would pass it. | `src/anchor.ts`, `src/ots.ts` |
| 2 | MEDIUM | Litecoin and Ethereum attestations are kept as opaque payloads without checking them; the official reader parses those tags, so a malformed one from a hostile calendar makes the whole exported .ots unreadable to it. Check their payloads, or refuse those tags before merging. | `src/ots.ts` |
| 1 | MEDIUM | Bitcoin attestation heights are not range-checked; the official reader refuses heights over 2^32-1. Refuse them when parsing. | `src/ots.ts` |

## Files touched outside the new modules (for the merge)

New: `src/ots.ts`, `src/anchor.ts`, `src/test/anchor.test.ts`, this plan.

Touched (small, additive):
- `src/config.ts`: `anchoring` (`parseAnchoring`, `loadAnchoringMode`) and `anchor_calendars` (`DEFAULT_CALENDARS`, `parseCalendars`, `loadCalendars`), both checked only where used.
- `src/settings.ts`: the two rows.
- `src/saved.ts`: `snapshotSignedBytes`, `anchorable()`.
- `src/receipts.ts`: query items carry `record_fingerprint` (computed before the log cut; a file warning's own `fingerprint` is untouched).
- `src/cleanup.ts`: `anchors/` not counted by the main disk cap.
- `src/cli.ts`: `anchor [status|upgrade]`, `receipts prove|verify`, help lines.
- README, CHANGELOG, SPEC W-08 row.
