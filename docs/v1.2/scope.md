# v1.2: local model mode (scope)

Status: written by Claude on 2026-11-13 from the tests in `findings.md`, on Travis's word to build ("lets build
it"). The decisions marked **for Travis** below are Claude's recommendations and can be changed before release.

## What a local model owner gets

One line in their chat app's MCP settings:

```json
{ "mcpServers": { "tiresias": { "command": "tiresias", "args": ["mcp", "--local"] } } }
```

and a model with 8,192 tokens of memory, or even 4,096, can read a web page and answer from it. In the tests a
9B model at 4,096 tokens got 0 answers right out of 6 with the default server and 6 with this one.

## In v1.2.0

### 1. Local model mode (W-34)

- **`tiresias mcp --local`.** One tool, `read`, with a url, a question, a section and a page. A short set of
  instructions. Everything else Tiresias can do (forms, tabs, files, bookmarks, history) is left off this
  server, so a form cannot be sent from it at all. The full server is unchanged and can run beside it.
- **The same envelope with parts left out.** Top-level fields are still Tiresias's own and web text still sits
  inside `untrusted_content`. The reply leaves out the receipts list, the flag list, the doors summary, the
  metadata and the scores. Nothing is added except fixed sentences and counts. Plain text was tested and
  rejected: it was the easiest shape to fool (findings, section 3).
- **Receipts are still written** to the store for every quote, as before. The reply says how many, and the
  person reads them with `tiresias receipts --url <address>`.
- **A budget.** A reply carries at most about 6,000 characters of page text (about 1,500 tokens): the best
  passages that fit, or one page of a section. The owner can set it from 1,000 to 20,000 with
  `--local-budget`.
- **Fewer round trips.** A read with no question returns the outline straight away, also on a revisit. When a
  page shows nothing without JavaScript and the owner has allowed rendering, local mode asks for the render
  itself.
- **A search phrase instead of an address** gets one fixed answer: Tiresias reads pages, it needs a full
  address, and the owner can add a search tool beside it.
- **`tiresias read <address> --local`** prints the same reply on the command line, so an owner can see exactly
  what their model is given.

### 2. A wider check for text aimed at an AI, in local mode

A passage that looks written for an AI gets a warning on the passage itself. One that shows two signs, or
carries chat-template markers, is withheld and counted, and the reply says the person can read it on the page.
Every local reply with page text ends with a one-line reminder. This cut working attacks from 7 in 48 to 3 in
48 in the tests, and the three were all marker blocks, now withheld. The finished build let none of 36 through
on the same twelve attacks. It is a pattern list and will miss new
wording: SECURITY.md says so in plain words.

### 3. Three reader fixes (R.1 to R.3)

Wikipedia articles, vuejs.org, usa.gov, substack.com and others read as empty pages. Fixed for every mode,
with tests. PARSER_VERSION 18.

### 4. Setup notes: `docs/LOCAL-MODELS.md`

What the owner has to supply, said first: a search tool (Tiresias reads, it does not find), Tiresias, a model
that can call tools in their app and how to check that, enough context (with measured numbers), and a browser
on the Chrome engine only for pages that show nothing without JavaScript. Then the one-line setup for LM Studio, and
what was measured.

### 5. SECURITY.md

Two additions: what local mode leaves out and why none of the promises change, and an honest paragraph that a
small model can be talked into things by page text, with the test numbers.

## Not in v1.2.0, and why

| Item | Decision | Why |
|---|---|---|
| W-36, reading embedded page data | Not built; stays a want with no version | Recovered nothing on the four real script-only pages in the survey (findings, section 5) |
| W-35, rendering in Edge | Moves to the Windows work | Its user is a Windows owner, and Tiresias does not run on Windows yet. `TIRESIAS_CHROME` already covers other Chrome-engine browsers on macOS and Linux |
| A search hook or bundled search | Not built | The owner's app combines tools; hooks do not run on Windows; Tiresias stays the reader (section 9, 2026-11-13) |
| An embedding hook for picking passages | Not built | The built-in picker found the answer on six of six pages |
| The wider check in the default reply's flags | Left for the sweep (L.3) | It changes what every user's replies flag, so it gets its own false-alarm count first |

## For Travis

1. **Withholding.** Local mode withholds a passage when two signs say it is aimed at an AI, or when it carries
   chat-template markers, instead of only warning. Recommended: yes. A small model that is fooled acts on it; a
   withheld passage is a visible gap the person can read around. The other choice is warn only.
2. **Windows (W-37) as the next version, ahead of compliance.** Local models live on Windows and Tiresias does
   not start there. Recommended: v1.3 becomes Windows support (store safety for Windows, the test suite on
   Windows, Edge rendering), compliance v1.4, payments v1.5. Untested stopgap for now: WSL.
3. **Release.** v1.2.0 goes out the usual way once the Codex review is clean: private repo, public pull
   request, your approval on npm.

## Rules for this version

- Two vendors: Claude builds, Codex reviews; anything Codex writes, Claude reviews.
- No change to what the default server sends. A test compares it byte for byte with v1.1.1's.
- No safety promise changes. Tests check that web text never leaves `untrusted_content` in local mode.
- No new package, no paid service.
