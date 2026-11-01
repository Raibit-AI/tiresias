# v1.0.0: launch prep

Branch `v1.0`, worktree `~/Code/tiresias-v10`, from main `ac55ee6` (v0.9.1, 1015 of 1015 tests, 0 open deferred
findings). Travis gave the go for v1.0 on 2026-11-01. This branch prepares everything up to the line; two steps
are not taken here and wait for Travis: making anything public, and publishing to npm. The launch-day steps are in
`docs/v1.0/runbook.md` (kept out of the public copy).

v1.0's definition (SPEC section 7): public launch quality: docs, demo, tests, Codex-reviewed, verified on
Cloudflare; macOS and Linux; the review logs stay private; no known bug at the tag.

## Progress

- [x] Read SPEC (header, sections 7 to 9, open questions), README, QUICKSTART, SECURITY, CHANGELOG, the v0.9 records
- [x] This plan
- [x] Version 1.0.0 everywhere (types.ts, package.json, package-lock.json, README, SPEC, Docker tag); user agent link decision
- [x] Cloudflare verification (2026-11-01) and the live-signed key directory (2026-10-27) recorded in SPEC and README
- [x] Docs pass for strangers: README top to bottom, QUICKSTART, SECURITY.md, CHANGELOG v1.0.0
- [x] docs/DEMO.md with real output from this build in a fresh temporary HOME
- [x] `scripts/export-public.sh`, run into `~/Code/tiresias-public-export`, verified
- [x] `docs/v1.0/runbook.md`
- [x] Two Linux-only test failures that CI showed on v0.9.1 (Ubuntu; macOS passed), fixed with a regression test (below)
- [x] Codex read-only rounds over the v1.0 diff and the export script, every finding fixed, until clean (5 rounds, below)
- [x] Full suite twice (0 fail, 0 skip): 1017 of 1017 both times (1015 before, 2 new anchor tests); CI on the branch green on Ubuntu and macOS
- [x] `npm pack --dry-run`: 96 files, 443.6 kB (1.5 MB unpacked): `dist/` without `dist/test`, `stubs/no-canvas`, README, QUICKSTART, DEMO, LICENSE, NOTICE, package.json
- [ ] Secret scan of the diff, push `v1.0`, merge to main, suite on main, tag `v1.0.0` (private repo only)

## Decisions on this branch

- **User agent link stays `https://raibit.ai/tiresias/` in v1.0.0.** SPEC row 2026-10-16 says the link goes back
  to GitHub at v1.0, and its reason is that a private repo link shows site owners a 404. The v1.0.0 tag is made
  while the repo is still private, and Raibit's own signed copy runs from the private main checkout, so a GitHub
  link in this build would 404 for every site it reads until launch day. Launch prep first planned to turn
  `raibit.ai/tiresias/` into a redirect and switch the string to GitHub in v1.0.1; Travis decided instead
  (2026-11-01) to keep the raibit.ai page and add a prominent link to the repo ("raibit page building is good"),
  so the string stays as it is.
  `package.json`'s `homepage` points at the GitHub repo now, since npm shows it only after launch.
- **Public repo: a fresh single-commit history, not a visibility flip** (reasons in the runbook).
- **No code changes beyond the version, the user agent comment and user-visible text that would be false at v1.0**
  ("v0.x never pays" becomes "this version of Tiresias never pays"; `keys sign-directory` help names its use).
- **The demo uses a local page for the bot wall** (with the test suite's private-address switch, said so in the
  demo), not a real site's bot check, under the bot-wall rule. The two public reads (example.com, RFC 9309 on
  rfc-editor.org) were made once each.
- **Export left out / scrubbed:** `docs/reviews/`, `docs/v1.0/runbook.md`, `scripts/export-public.sh`; adds
  `docs/reviews/` to the public `.gitignore`. Kept: `docs/v0.6` to `docs/v0.9`, `docs/v0.9.1-sweep.md` and this file
  (no local user name or home path in any of them; they mention worktree folders like `~/Code/tiresias-v09`, which
  name no one). The tracked tree held no macOS home path or local user name outside `docs/reviews/`. The one place
  the local user name would leak is git metadata (this repo's commits carry the Mac's own login and host name), so the
  export commits under Raibit-AI's GitHub no-reply address and checks the commit for the user name.

## Linux CI failures found at v0.9.1, fixed here

CI on GitHub (Ubuntu and macOS) failed on Ubuntu for the v0.9.1 sweep, the v0.9.1 tag and main (1013 of 1015):

- **anchor 8.15** (a real bug, Linux only): the receipt cursor identified its file by device, inode and size, and
  Linux hands a new file the inode number of one just deleted, so a receipts file deleted and written again was
  taken for the old one and its first records were skipped. Fixed in `src/anchor.ts`: the cursor also keeps the
  SHA-256 of every byte before its offset and resumes only when the file still hashes the same there (first the
  last 32 bytes; Codex round 1 showed a same-length rewrite could keep those, so a second test covers it); a cursor without them restarts at
  zero, which is safe because anchored records are skipped by fingerprint. New test rewrites a file in place (same
  inode on every system), failed before the fix on macOS, passes after.
- **hardening round 6c** (a test timing bug): 120-second waits were set before a loop that took 111 s on macOS and
  191 s on Ubuntu runners, so they had ended by the assertion. The test uses hour-long waits.

## Codex rounds (`docs/reviews/2026-11-01-v10-launch-round-N.md`, private)

Zero-bug release: every finding of any severity fixed, then reviewed again. Claude fixed docs and scripts and the
one code change (anchor); Codex reviewed every round read-only.

| Round | HIGH | MEDIUM | LOW | What, and the fix |
|---|---|---|---|---|
| 1 | 3 | 4 | 1 | Public annotated tag would carry the local git identity; binary files skipped by `grep -I`; `secrets.env` not refused; anchor tail of 32 bytes can match after a same-length rewrite (now a SHA-256 of the whole prefix, second test); grep errors read as clean; `git archive` pipe failure unseen; npm smoke test could reach `TIRESIAS_HOME`; npm unpublish policy understated |
| 2 | 2 | 3 | 1 | Symlinked export target skipped by grep and find (real path now); tag signing setting could still make an annotated tag (round-1 item, second fix: `tag.gpgSign=false` plus a lightweight-tag check before push); global ignores could drop files (`add -f`, staged list must equal disk); user name in file names; sole-version unpublish needs `--force`; README said `.npmrc` covers `npm install -g` |
| 3 | 0 | 2 | 0 | Git filters or hooks could change content after the checks (empty template, no hooks or attributes, every committed blob compared unfiltered); upper-case key extensions and private JWKs under other names |
| 4 | 0 | 2 | 0 | A JWK split across lines (whole-file search plus a JSON walk in Node, second fix of the JWK item); a failed `ls-tree` or name scan read as clean |
| 5 | 0 | 0 | 0 | Clean: every earlier finding CLOSED; anchor, docs, demo, package, runbook, export all without findings |

No finding survived two fixes.
