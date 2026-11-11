# v1.1: security deep dive (scope)

Status: scope approved by Travis, 2026-11-01 (decisions below). Nothing here is built yet.

## Why a deep dive, when v1.0.1 just cleared every known bug

The bug hunts so far read the code area by area and asked "is this line wrong?". A security deep dive asks a
different question: "I am an attacker who controls a web page, a file, a server, or a fooled AI agent; what is the
worst thing I can make Tiresias do?" It works from the promises in `SECURITY.md` (Threat model, "What Tiresias
promises") and tries to break each one end to end, across files, the way a real attacker would. It also covers what
the code reviews never looked at: the packages Tiresias depends on, how a release gets from the repo to npm, and
what happens if a key leaks.

v1.1 comes before payments (v1.3) on purpose: payments will be built on whatever this pass leaves standing
(section 9, 2026-11-01).

## Rules

- Zero-bug rule (section 9, 2026-10-31): every finding is fixed with a test or designed away before v1.1 ships.
- Two vendors: Codex writes fixes, Claude reviews them; Claude-written code (the attack lab) is reviewed by Codex.
- Findings that need a product call come to Travis instead of being decided by the builder.
- No paid service or install without Travis's yes; any third-party tool gets a SkillSpector scan first.

## Workstreams

### 1. Break the promises (the core)

One adversarial pass per promise in `SECURITY.md`, each asked to produce a working attack or a reasoned "holds":

| Promise | Attacks to try |
|---|---|
| Page content is data | Get page-controlled text outside `untrusted_content`: titles, URLs, file names, headers, error messages, wall and hand-off text, translator output, diff output |
| No web code runs outside Chrome's sandbox | PDF child escape, worker escape, Chrome flags or CDP misuse, the scanner and translator hooks fed hostile names or bytes |
| Nothing written outside the store | Path tricks in `--out`, saved pages, quarantine, receipts prove, profile names, symlink and folder swaps (within the documented limit) |
| Private addresses refused | DNS rebinding, IPv6 and IPv4-mapped forms, odd numeric hosts, redirects, rendered subrequests, door probes, OpenTimestamps calendars, Web Risk |
| The site's rules win | Robots edge cases, Crawl-delay and Retry-After abuse, `never_visit` bypass through redirects, wildcards, ports, trailing dots, IDN look-alikes |
| No money moves, no form without a slip | Forms disguised as links, GET forms, rendered-page clicks, slip scope (path, uses, expiry) at its edges, login/password/payment detection evasion |
| Secrets stay secret | The signing key, slip key and Web Risk key: can any reply, log, error, receipt, saved page or the PDF child see them? Echo withholding at its edges |
| Caps hold | Decompression bombs, deep nesting, huge headers, slow-drip servers, many small requests, render loops, a page that spawns endless subrequests |

Plus one cross-cutting exercise: **a prompt-injected agent**. Assume the agent is fully controlled by a page.
Using only the MCP tools, can it change a setting, grant itself a slip, read a local file, leak a key, send a form,
or make Tiresias misbehave toward a site? This is the scenario Tiresias exists to survive.

### 2. The attack lab

A small local website of hostile pages (hidden instructions, fake walls, redirect chains to private addresses,
zip bombs, booby-trapped PDFs and Office files, slow servers, echo pages), run against Tiresias in the test suite so
every attack stays tested forever. It doubles as the source for the "watch an AI get tricked" videos.

### 3. Supply chain and release integrity

- Five runtime packages (`@modelcontextprotocol/sdk`, `htmlparser2`, `pdfjs-dist`, `web-bot-auth`, `zod`): read
  what each can do, pin exact versions (already), check install scripts and what they pull in. `npm audit`: 0 today.
- Free GitHub security tools on the public repo: Dependabot alerts, CodeQL code scanning, secret scanning, and the
  OpenSSF Scorecard. All free for public repositories.
- **npm provenance (needs Travis):** publish from GitHub Actions with npm's trusted publishing, so every release
  carries a public, verifiable link from the npm package back to the exact GitHub commit it was built from. No npm
  token is stored anywhere. npm shows a "provenance" badge. Travis would approve each release in GitHub instead of
  on the npm page.
- A software bill of materials (SBOM) attached to each GitHub release.

### 4. Keys

- What happens if the signing key leaks: today there is no documented rotation. Add `keys rotate` (new key, both in
  the directory for an overlap window, old one removed) and a short "if your key leaks" section in `SECURITY.md`.
- Same question for the slip key: what does rotating it do to existing slips and saved pages?

### 5. Deeper fuzzing

Hour-long fuzz runs on compute day (today's longest is 300 s), new targets for the MCP request layer and form
handling, and the open question from v0.9: whether pages of 8 KB or less keep being parsed on the main thread
without a time budget (recommendation stands: keep, with the fuzz tripwire).

### 6. The Docker box (optional)

`docs/docker.md` has never been run, because Docker isn't installed on the Mac. Build and run it once, attack it,
and fix the doc. Needs a free Docker runtime (Colima, open source, through Homebrew; scan first).

## Out of scope

- Windows support. Touch ID for slips (post-v1.0 want, its own version). Payments (v1.3). Compliance (v1.2).
- Protecting against a program that already runs as the owner (documented limit, `SECURITY.md`).

## Decisions (Travis, 2026-11-01, all four as recommended)

1. **Outside security audit:** a paid professional audit typically costs thousands of dollars. **Decided: not now**;
   reconsider before payments (v1.3), when money is at stake.
2. **npm provenance (publishing from GitHub):** **decided: yes.** Travis does a one-time setting on npmjs.com
   (package settings, "trusted publisher": the repo and workflow name) and then approves releases in GitHub.
3. **Docker check:** install Colima (free) to test the Docker box, or leave Docker untested and say so in its doc.
   **Decided: install it** (SkillSpector scan first). **Reversed the same day:** the static scan rated Colima and Lima CRITICAL/DO_NOT_INSTALL (keyword hits on sudo in VM tooling), so under the scan-before-install rule Travis chose to skip Docker testing; `docs/docker.md` gets a plain "not tested yet" note.
4. **Publish the results:** a public "v1.1 security review" write-up after the fixes ship (what was attacked, what
   held, what was fixed). **Decided: yes**: it is credibility on display, and a video. Voice primer first; Travis approves before posting.

## Done means

Every workstream finished or explicitly cut by Travis; every finding fixed with a test; the attack lab in the suite;
`SECURITY.md` updated; CI green on Linux and macOS; Codex final round clean; released as 1.1.0.

## Progress notes

- 2026-11-06: `docs/docker.md` carries the "not tested yet" note (workstream 6 closed as skipped). SBOM check: npm's built-in `npm sbom --sbom-format cyclonedx --omit dev` (no new tool) produces a CycloneDX 1.5 file listing 107 runtime components; the release workflow will attach it to each GitHub release when provenance publishing is built.
- 2026-11-09: provenance publishing set up (decision 2 above). Travis configured npm's trusted publisher for @raibitsi/tiresias: GitHub Actions, Raibit-AI/tiresias, workflow `release.yml`, environment `release`, **stage publish only** (neither "npm publish" nor "dist-tag" allowed), and publishing access "require 2FA and disallow bypass tokens". Banks created the GitHub `release` environment on the public repo, limited to `v*` tags, and wrote `.github/workflows/release.yml`: tag must equal package.json and be a stable version, full test suite, CycloneDX SBOM attached to the GitHub release, then `npm stage publish --provenance`. Nothing is installable until Travis approves the staged version on npmjs.com with 2FA. Codex r1: 3 MEDIUM (rerun after SBOM failure, prerelease tags, concurrency group cancelling pending tags), all fixed. First real run: the 1.1.0 release.
