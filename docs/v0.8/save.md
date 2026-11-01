# v0.8 Track 1: save page (W-28)

Branch `v0.8`, from main `11588eb` (v0.7.0, 837 tests passing). Decisions for the coordinator to fold into SPEC.md.
Track 2 (W-08, tamper-proof receipts) builds on this: the fingerprints it needs are `snapshotFingerprint` and
`receiptFingerprint` in `src/saved.ts`.

## Progress

- [x] Worktree `~/Code/tiresias-v08` (branch `v0.8`; see "Branch" below), `npm ci`
- [x] Read SPEC (principles, N-03, W-05 and the 2026-10 slip decisions, W-14, W-18, W-15 limits, W-20, W-28, W-08) and the v0.7 plans
- [x] This plan
- [x] `src/saved.ts`: snapshot writing, manifest, signing with the slip key, list, show, verify, delete, cleanup; the two fingerprints
- [x] `safeFetch` keeps the received bytes on request (`keepRaw`); `decode` exported
- [x] Owner settings `saving` (off/ask), `keep_saved_days`, `max_saved_mb` (config.json, `tiresias settings`); never from MCP
- [x] Read path (`src/pipeline.ts`): `save` on MCP `read` and `read --save`; receipts gain `snapshot`; reply `saved`; file warnings save the fingerprint only
- [x] `tiresias saved [list|show|verify|delete]`
- [x] `clear` and the daily trim: expired snapshots, the saved cap, leftovers
- [x] Tests (`src/test/saved.test.ts`): 9 new, 1 of which needs Chrome (skipped by name without it)
- [x] README, CHANGELOG (unreleased v0.8.0), SPEC W-28 row
- [x] Full suite at the checkpoint: 846 tests (837 before), 845 pass; the one failure was the W-15 defaults test, which now knows the two new limits: fixed, 846 of 846
- [x] Codex review loop (fix HIGH only; MEDIUM and LOW deferred below): 4 rounds, 8 HIGH fixed, 5 MEDIUM and 2 LOW deferred (corrected at integration from 6: rounds 1 to 4 had 2, 2, 1 and 0 MEDIUM)
  - [x] Round 1 (`docs/reviews/2026-10-31-v08-save-round-1.md`): HIGH 6, MEDIUM 2, LOW 0. All six HIGH fixed, with a test (`the store fails closed`): (1) the save and the delete re-check that `saved/` and the snapshot folder are the same plain folders of ours (device and inode) before every step, and deletion removes only our three file names and then the empty folder (never recursive; a folder holding anything else is left and reported). Node has no `openat`, so a swap between a check and the next call remains possible for a process running as the owner, the store's stated threat model; (2) the signed manifest is built first and its bytes count toward the cap; (3) folders are read as streams with entry budgets, and anything not measured exactly (a foreign name or file, an unreadable or over-full folder) makes a save fail closed (`failed`, `store`); (4) a snapshot folder that cannot be listed whole never verifies (`folder: "unreadable"`); (5) `saved list` keeps the server's Content-Type inside `untrusted_content`; (6) quotes are replayed only after the id, the signature and every file hash check out, receipts are capped (2,000, 2 MB of quotes), and matching is one substring search over the joined texts
  - [x] Round 2 (`docs/reviews/2026-10-31-v08-save-round-2.md`): HIGH 1, MEDIUM 2, LOW 1. Codex confirmed five of the six round-1 fixes; the HIGH is round-1 #3 again (second fix): a metadata error other than "vanished" (a folder that can be listed but not entered) counted as zero bytes. Now only `ENOENT` means vanished; any other error makes the measurement incomplete and the save fails closed. Test added. MEDIUM and LOW deferred below
  - [x] Round 3 (`docs/reviews/2026-10-31-v08-save-round-3.md`): HIGH 1, MEDIUM 1, LOW 0. Codex confirmed the round-2 fix. New HIGH: temp folders (a save in progress, or one left behind or planted) were measured but not counted toward the cap. Now they count. Test added. MEDIUM deferred below
  - [x] Round 4 (`docs/reviews/2026-10-31-v08-save-round-4.md`): **HIGH 0, MEDIUM 0, LOW 1**: the loop ends. Codex confirmed the round-3 fix. LOW deferred below
- [x] Full suite after the loop: 847 of 847 passing, 0 skipped (837 before; 10 new)
- [x] Secret scan, push `v0.8`, report to Banks

## Branch

The brief says both "create the worktree with `-b v0.8`" and "commit and push on branch `v0.7`". Branch `v0.7`
already exists (merged into main as v0.7.0), so pushing new work to it would rewrite the meaning of a finished
branch. This track commits to `v0.8` and pushes `v0.8`. Flagged to Banks.

## Design calls (with reasons)

### Who may save: the owner's `saving` setting

- `config.json` key `saving`: `"off"` (default) or `"ask"` (a read may ask to save). Set with
  `tiresias settings set saving off|ask`, listed in `tiresias settings`. **No environment variable** overrides it
  (unlike `rendering`): an agent that starts a CLI with its own environment could otherwise turn it on in passing.
- MCP `read` has a `save` boolean and nothing else: no tool or parameter reads or changes the setting (W-29's rule;
  the parameter `save` does not share the setting's name `saving`, so asking is never mistaken for allowing).
- With `saving` off, a read that asks gets its normal reply plus `saved: { status: "not_allowed" }` and fixed text;
  nothing is forced or written.
- An agent with a shell can run `tiresias settings set saving ask` like any other setting: the spec's standing rule
  is that an agent with a shell is trusted like the owner for everything except granting slips. Saving keeps a copy
  of what the agent already read; it grants no new power over the world. If Travis wants the setting person-gated
  (typed confirmation like `slip grant`), it is a small change: flagged to Banks.

### What bytes are kept, precisely

- **`received`**: the body of the final response of the read (the last hop after redirects; redirect bodies are never
  read), exactly as Tiresias read it: after HTTP/1.1 chunked framing is removed (by Node) and after the
  `Content-Encoding` (gzip, deflate, br) is undone, **before** any charset decoding. These are the bytes the reader's
  charset step starts from, so verification can repeat every reader step. Capped like the read itself (the page cap,
  5 MB by default; a page over it is not read, so not saved).
- **`rendered`**: when the read was rendered in this call (W-10), the HTML Chrome produced (UTF-8), which is what the
  reader parsed and what the receipts quote. A rendered copy reused from the cache has no HTML to keep, so a read
  that asks to save renders again (below).
- Files are written with no extension (`received`, `rendered`, `manifest.json`), mode 0600, in a 0700 folder. They are
  never executed, opened in another program, served or rendered: only hashed, and parsed by the reader inside its
  sandbox for verification.

### A save always fetches

The page cache keeps the parsed page, not the bytes. So a read that asks to save (and is allowed to) skips the fresh
copy (W-03), sends no validators (no 304), and does not reuse a cached rendering: the snapshot holds what THIS read
received. Cost: one full request; the owner turned saving on and the agent asked.

### Where snapshots live

`<profile>/saved/<id>/` (W-18: each profile its own, signed with its own slip key; the profile name is in the signed
bytes). Written into `saved/.tmp-<random>/` first, then renamed to `saved/<id>/` in one step, so a reader never sees
half a snapshot. The folder and every file are checked like other store folders (a plain folder of ours, no links).

### The manifest and the snapshot id

`manifest.json` holds: `v`, `id`, `profile`, `saved_at`, `nonce` (16 random bytes), `url` (asked), `source_url`
(llms.txt or a markdown twin when that door was used), `final_url`, `status` (HTTP), `content_type`, `read_as` (how
the reader took it: html, text, json, pdf...), `file_flags`, `language_header` (Content-Language, a parse hint),
`parser` (PARSER_VERSION), `rendered` (`null`, or `{ mark, complete, wall_decided }` the reader needs to parse the
rendered HTML the same way), `files` (`[{ name, size, sha256 }]`), `file` (a file warning's fingerprint, below, or
`null`), `receipts` (the receipts of that read, each carrying `snapshot: <id>`), `sig`.

- **The id** is SHA-256 over the canonical form of everything except `id`, `receipts` and `sig`. Receipts point at
  the snapshot by this hash (`receipt.snapshot`), and the manifest lists them; the id cannot include the receipts,
  since they include the id.
- **The signature** is Ed25519 with the profile's **slip key** (`keys/slips.private.jwk`, the existing key and code:
  `ensureSlipKey`, Node's `crypto.sign`), over `["tiresias-saved-page", <canonical manifest without sig>]`. The fixed
  tag keeps these bytes from ever reading as a permission slip (whose signed array starts
  `"tiresias-permission-slip"`). No new crypto: the same key type, library and storage rules as slips. A save makes
  the slip key if there is none (as the first `slip grant` does); a key that cannot be used (a synced folder, a bad
  file) means no snapshot (`saved.status: "failed"`, reason `key`), never an unsigned one.
- **Canonical form**: JSON with object keys sorted at every level, no spaces. Every value is a string, a whole
  number, a boolean, null, an array or an object, so the form is unambiguous.
- Quotes in the manifest are bounded like the receipts log (8,000 characters, `cut: true`); a cut quote is still an
  exact substring, so it can still be checked.

### Verify

`tiresias saved verify <id>` (or `--all`) checks, and reports each:
1. the manifest is one of ours (shape, sizes, file names from a fixed list);
2. the id: recomputed from the manifest, equal to the folder name;
3. the signature with the profile's slip key (`ok`, `bad`, or `no_key`);
4. every stored file re-hashed: size and SHA-256 equal to the manifest's;
5. every receipt: its `snapshot` is this id, and its quote is found in what the reader gets from the saved bytes:
   the same steps as the read (charset decoding by the stored content type, then the reader for `read_as`, in the
   sandbox; for a rendered snapshot, the rendered HTML with its stored mark). Found means an exact substring of the
   title, a heading or a block. The answer says when the reader's version differs from the one that made the
   snapshot (then a `not_found` may be the reader's change, not tampering).
`ok` is true only when 1 to 4 pass and every quote is found.

### File warnings save only the fingerprint (W-20)

A read with `save` that ends in a file warning writes a snapshot with no files at all: `file: { kind, risk, size,
sha256 }` (Tiresias's own values) and the URLs. Never the file's bytes (W-20: nothing downloaded is written where it
could run). A file with no fingerprint (stopped by the cap or time) saves nothing (`saved.status: "not_saved"`, reason
`no_fingerprint`). Text Tiresias read from inside an Office file is not saved (its bytes are not kept), so those
receipts carry no `snapshot`.

### What is never saved

- **Private mode never saves** (`saved.status: "private"`), and the store's own writers refuse in a private call anyway.
- **`Cache-Control: no-store`**: the site asked that its page not be kept, so it is not saved (`not_saved`, reason
  `no_store`). Principle 2: the site's rules win; a person who needs a copy can use their own browser.
- A wall, a price tag, a refusal, an error: there is no page, so `not_saved`, reason `no_page`.
- `check`, `watch`, `resume`, tabs: only `read` saves.

### Storage caps and cleanup

- `max_saved_mb` (default 100) and at most 1,000 snapshots per profile. A save that would pass either is refused
  (`saved.status: "over_cap"`); a save never evicts older snapshots. Reason: a prompt-injected agent asking to save
  again and again must not be able to push out the evidence of earlier receipts. Two saves at once can pass the cap by
  one snapshot each (checked, not locked; at most 15 MB a snapshot).
- `keep_saved_days` (default 90, like receipts). `clear` and the daily trim remove snapshots older than that (by
  `saved_at`, the folder's time when the manifest is damaged), leftover `.tmp-*` folders older than a day, and, if
  the owner lowered `max_saved_mb`, the oldest snapshots until under it.
- `saved/` is not counted by the store's main disk cap (`max_disk_mb`), which would otherwise evict snapshots to make
  room for cache: it has its own cap. `clear --all` and `--older-than` do not touch snapshots (a deliberate keep, like
  bookmarks); `tiresias saved delete --all` removes them.

### Commands and replies

- CLI: `read --save`; `tiresias saved` (= `saved list [--page N]`), `saved show <id>`, `saved verify <id> | --all`,
  `saved delete <id> | --all`. An id is the 64-character hex id or a unique prefix of at least 8. `saved delete` is
  refused in private mode. Every `saved` command acts on the current profile.
- MCP: `read` with `save: true`. No other saved tool in v0.8 (listing and verifying are the owner's, from the CLI).
- Reply: top-level `saved: { status, id?, files?, bytes?, rendered?, reason? }` (fixed codes, Tiresias's own hash and
  counts) and a fixed sentence in the message; each receipt of that read carries `snapshot`. History notes `saved`.

### For track 2 (W-08)

`snapshotFingerprint(manifest)`: `sha256:<hex>` of the signed bytes (the manifest without `sig`, canonical, with its
tag). `receiptFingerprint(receipt)`: `sha256:<hex>` of the canonical form of one receipt as recorded. Neither
contains page content beyond the hash; W-08 timestamps these.

## Deferred to compute-day sweep

| Round | Severity | Summary | File |
|---|---|---|---|
| 1 | MEDIUM | The manifest keeps only the first 1,000 characters of Content-Type; a charset parameter past that is lost, so verify decodes intact bytes differently and reports `not_found`. Store the decoder the read used (or the whole bounded header). | `src/saved.ts` |
| 4 | LOW | A file warning from a `no-store` response reports `saved.reason: "no_page"` instead of `no_store` (nothing is written either way). Attach `sv.reason` before returning the file warning. | `src/pipeline.ts` |
| 3 | MEDIUM | The writer stores URLs of any length, but the verifier's shape check refuses URLs over 8,192 characters, so a read of a very long URL saves a snapshot that never verifies. Share one URL limit: refuse such a save before writing, or accept the full URL in verify. | `src/saved.ts` |
| 2 | MEDIUM | Quote matching joins the texts with NUL and rejects quotes holding NUL, but a text page can contain NUL after its first bytes, so an authentic quote reports `not_found`. Match per text with a bound instead. | `src/saved.ts` |
| 2 | MEDIUM | Rendered HTML is parsed as a JavaScript string and saved as UTF-8; an unpaired surrogate becomes U+FFFD on disk, so a quote can fail on replay. Round-trip the rendered HTML through UTF-8 before parsing, hashing and saving. | `src/pipeline.ts`, `src/saved.ts` |
| 2 | LOW | `clear` counts every planned snapshot as removed even when its deletion failed. Return real outcomes from `applyCleanup`. | `src/saved.ts`, `src/cleanup.ts` |
| 1 | MEDIUM | `saveSnapshot` does not enforce `MAX_PART` (16 MB), which verify enforces; with a raised `TIRESIAS_MAX_BYTES` a snapshot can be written that never verifies. Refuse such a save before writing (a fixed result). | `src/saved.ts` |

## Files touched outside the new module (for the merge)

New: `src/saved.ts`, `src/test/saved.test.ts`, this plan.

Touched (small, additive):
- `src/safety.ts`: `SafeFetchOptions.keepRaw`, `RawResponse.raw` (the page body as received, before charset decoding).
- `src/config.ts`: `saving` (`parseSaving`, `loadSavingMode`, checked only where used), `keep_saved_days` and `max_saved_mb` in the limits (optional in `Limits`, so older callers and tests stay valid).
- `src/settings.ts`: the `saving`, `keep_saved_days` and `max_saved_mb` rows.
- `src/pipeline.ts`: `fetchSource` takes `keepRaw`; `run` decides `sv` (the read asked and the owner allows), skips the fresh copy, validators and a cached rendering when saving, records `no_store`, saves a file warning's fingerprint, builds the save input; `finishPage` writes the snapshot before recording receipts (`saveNow`) and adds `saved` (`addSaved`, `SaveCtx`).
- `src/engine.ts`: `read` adds `saved` when the pipeline did not (not allowed, private, no page).
- `src/envelope.ts`: `Opts.save`, `Serve.save`, `CallMeta.saved`, history `saved`. `src/history.ts`: `saved` field. `src/types.ts`: `Receipt.snapshot`, `Envelope.saved`.
- `src/cleanup.ts`: `saved` part of the report; `saved/` not counted by the main disk cap.
- `src/mcp.ts`: `save` on `read`. `src/cli.ts`: `read --save`, `tiresias saved ...`, the text summary line.
