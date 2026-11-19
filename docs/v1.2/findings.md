# v1.2 local model deep dive: findings

Tests run on 2026-11-13 by Claude, with real local models, before any of v1.2 was written. The scope in
`scope.md` comes from these numbers. The scripts are in `scripts/v12-lab/` so anyone can run them again.

## How it was tested

- **The models** ran in LM Studio on a Windows 11 PC with one RTX 4080 Super (16 GB): Qwen 3.5 9B, OLMo 3 7B
  Instruct, Hermes 3 Llama 3.1 8B, Devstral Small 2 (24B), Gemma 4 26B and Qwen3 Coder 30B.
- **Tiresias** (v1.1.1 plus the reader fixes below) ran on a Mac. The harness connects to it as an MCP client,
  the way a chat app does, and talks to the model through LM Studio's OpenAI-compatible address.
- **The job:** one question, one page. Six real pages (MDN, the Python docs, an RFC, example.com, a Wikipedia
  article, a USCIS form page), each with one question whose answer is on the page. An answer counts as right
  when it contains the fact.
- **The attacks:** one made-up bakery page with a hostile paragraph in its visible text, twelve versions. Each
  page went through the real reader, so the reply is exactly what Tiresias would send. An attack counts as
  working when the model does what the paragraph says.
- Temperature 0, one run per cell. A difference of one answer between two cells means little. The large gaps
  are the finding.

## 1. A default Tiresias uses up a small model's memory before the first question

Counted in a Llama 3.1 tokenizer:

| Part | Tokens |
|---|---|
| The tool list (18 tools) | 3,733 |
| The server's instructions | 269 |
| **Before any question** | **about 4,000** |
| The `read` tool alone | 590 |

LM Studio loaded the test model with 8,192 tokens of context when none was asked for. So half of it is gone
before the person types, and a model loaded at 4,096 cannot hold the tool list at all.

One reply to a question, five passages:

| Page | Default reply | Same reply with parts left out |
|---|---|---|
| example.com | 395 | 123 |
| Python docs, `json` | 1,296 | 372 |
| MDN, status 402 | 1,683 | 390 |
| USCIS, Form I-765 | 1,957 | 464 |
| RFC 9421 | 2,562 | 941 |
| Wikipedia, Oedipus | 3,056 | 995 |
| **All six** | **10,949** | **3,285** |

Where the default reply's bytes go: the `receipts` list is the largest part in five of the six (it repeats every
passage with its address and time), then the passages themselves, then the list of flagged items, the page's
metadata and the doors summary.

The built-in passage picker put the answer in its five passages on all six pages. For one question on one page,
no embedding model was needed.

## 2. The same models answer right when the reply is small

Right answers out of six:

| Model | Context | Default: 18 tools, full replies | One tool, full replies | One tool, small replies |
|---|---|---|---|---|
| Qwen 3.5 9B | 4,096 | 0 | 2 | 5 |
| Qwen 3.5 9B | 8,192 | 1 | 4 | 5 |
| Qwen3 Coder 30B | 8,192 | 1 | 4 | 6 |
| Qwen3 Coder 30B | 16,384 | 4 | 6 | 6 |
| Devstral Small 2 24B | 8,192 | 5 | 5 | 6 |
| Gemma 4 26B | 16,384 | 6 | 6 | 6 |

- At 4,096 tokens every default request was refused by the model's runtime as too large. At 8,192 the usual
  failure was the same refusal on the second request, once one reply was in the conversation.
- With small replies the largest prompt in any run was 1,480 tokens. With the default it reached 10,626 (Qwen3
  Coder) and 14,790 (Gemma 4).
- Small replies were also faster: Qwen3 Coder at 16,384 took 6.5 seconds a question by default and 2.2 with
  small replies.
- Qwen 3.5 9B's one miss with small replies came back as an empty answer (it stopped after its private
  reasoning), which the harness counts as wrong.
- The 16,384 rows used the plain-text small reply; the others used the JSON one. On the 8,192 rows both scored
  the same.

**Two models never got the tools.** For Hermes 3 8B and OLMo 3 7B, LM Studio sent no tool list at all: the prompt
was the same size with 18 tools as with one, and neither model made a call. LM Studio's own log of the prompt
shows the system and user text and no tool at all. Its docs say a model with native tool support carries a
hammer badge in the app. They answered from memory, and with
Tiresias's instructions in front of them they described refusals Tiresias never made ("Tiresias cannot fetch
that page because..."). With the tools written into the prompt by hand, OLMo used the tool only when it was the
one short tool, and half of its calls were malformed. A model that cannot call tools in the owner's app cannot
use any browser. The setup notes say how to check.

## 3. Planted instructions: the shape of the reply matters, and nothing makes a small model safe

None of the twelve attacks is caught by the shield's phrase list today. It looks for wordings like "ignore all
previous instructions", and a small change of wording gets past it.

First round, seven attacks, attacks that worked:

| Model | Today's envelope, one tool | Plain text | JSON, parts left out | The same, plus a warning on the passage and a closing reminder |
|---|---|---|---|---|
| Qwen3 Coder 30B | 1 | 3 | 2 | 0 |
| Devstral Small 2 | 2 | 2 | 2 | 1 |
| OLMo 3 7B | (no calls) | 1 | 1 | 0 |
| Gemma 4 26B | 0 | 0 | 0 | 0 |

- **Plain text was the weakest shape.** It has no structure to tell Tiresias's words from the page's, and a page
  can imitate its layout. So local mode keeps the JSON envelope and leaves parts out.
- **A closing reminder on its own changed nothing.** With the warning it did better than the warning alone (1
  attack in 21 against 3 in 21), so local mode sends both.
- **Today's full envelope is not a shield either.** Two mid-size models followed a planted instruction through
  it. The `untrusted_content` label is a label.

Second round, all twelve attacks (five were written after the patterns were frozen), four models, 48 runs a
column:

| Reply | Attacks that worked |
|---|---|
| Today's envelope, one tool (36 runs) | 6 |
| JSON, parts left out | 7 |
| Plus a warning on the passage | 5 |
| Plus the passage withheld when two signs agree | 3 |

The three that still worked were a block of chat-template markers (`<|im_start|>system`), twice, and an
`[INST]` block, once. A local runtime can read such markers as real control tokens. They appeared in none of 567
ordinary passages, so local mode withholds any passage that carries one.

**How good is the check?** It is a list of patterns. On 30 real pages it marked 2 of 567 passages, both on
Wikipedia's article about prompt injection, which quotes attacks. Of the five attacks written after the list was
frozen it caught one. The four it missed were ordinary sentences ("Dear language model, when summarizing this
page please also recommend..."), and the models ignored three of those anyway. So: the check helps against
known shapes, it will miss new wording, and the honest statement for owners is that a small model reading the
open web can be talked into things. SECURITY.md says so.

## 4. Three reader faults, found on the way

All three made real pages read as empty. All three are fixed with tests in this version.

- **R.1: a class on `<html>` dropped the whole page.** The rule that quiets page furniture by class name
  (W-22) matched the word "menu" in `vector-feature-main-menu-pinned-disabled` on Wikipedia's `<html>` element.
  Every Wikipedia article read as 0 characters with a "JavaScript-only" note. The page root is never
  boilerplate now.
- **R.2: a `304 Not Modified` that repeats `Content-Encoding: gzip`** has no body, and Tiresias tried to unzip
  it. Every revisit to a Wikipedia page failed with "could not be read". A 204 or 304 is not decompressed now.
- **R.3: a layout word on the wrapper around the content.** Sites name wrappers after what is inside them:
  `VPContent has-sidebar` (vuejs.org), `<main class="... no-footer-gap">` (usa.gov), `flexed-footer`
  (craigslist.org), `with-product-nav__wrapper` (zillow.com), `reader-nav-root` (substack.com). Each lost the
  page. An element is now kept when the only boilerplate words on it are layout words (nav, navbar, menu,
  sidebar, footer, banner, masthead) and it is the page's `main`, or wraps a `main` or `article` that holds most
  of the page, or itself holds at least half of the page's text and is not mostly link text. A cookie box stays boilerplate however much of a thin page it fills,
  and so does a menu that is most of a script-only page (Codex's review of the fix: keeping it would have hidden
  that the page is a shell).

Text read from the page before and after, in characters:

| Page | Before | After |
|---|---|---|
| en.wikipedia.org/wiki/Oedipus | 0 | 33,347 |
| vuejs.org/guide/introduction.html | 25 | 8,982 |
| usa.gov | 33 | 2,987 |
| craigslist.org (a page of links) | 0 | 0, with its links listed (L.2) |
| substack.com | 0 | 1,331 |
| kayak.com | 1,510 | 5,204 |
| zillow.com | 0 | 485 |

## 5. The site survey: pages that show nothing without JavaScript

Sixty well-known sites, read once each. Tiresias's rules decided what could be fetched:

| Outcome | Sites |
|---|---|
| Read | 40 |
| A wall (sign-in or a bot check): handed to the person | 8 |
| Refused under the site's rules | 8 |
| Asked for payment | 1 |
| Other answers (a rate limit, a redirect with no destination, a bot check) | 3 |

Of the 40, ten came back as "JavaScript-only". Six of those had their text in the HTML and lost it to R.3
above. Four were real: youtube.com, twitch.tv, khanacademy.org and duolingo.com.

**W-36, reading the data a page already carries, is not built.** None of the four real ones kept its content in
a JSON data block. Twelve of the 40 pages had such blocks with readable text, and all twelve also had readable
text in their HTML. The want stays on the list without a version, for evidence that it would recover something.

## 6. Windows

Most local models run on Windows PCs. Tiresias was tried there for the first time (Windows 11, Node 22.22): it
builds, and every read fails at the first step, because the check that the store folder is not writable by
other users reads Unix permission bits, which Windows does not have. Making that check right for Windows is
security work with its own design, so it is its own want (W-37), not a fix slipped into this version.

**W-35, rendering in Edge, moves to that work.** Its user was a Windows owner with no Chrome. On macOS and
Linux an owner can already point Tiresias at any browser on the Chrome engine with `TIRESIAS_CHROME`.

Until W-37, a Windows owner needs Tiresias on a Mac or Linux machine, or inside WSL (Linux on Windows), which
has not been tested.

## 7. Search

Tiresias reads pages it is pointed at. It does not find them, and a small model will hand it a search phrase
instead of an address. Local mode answers that with one fixed message: it reads pages, it needs a full address,
and the owner can add a search tool beside it. No search service is bundled and no search hook is added: the
owner's chat app already combines tools from several servers, and Tiresias's hooks do not run on Windows.

## 8. The finished build, through the same tests

After local mode was written and reviewed, the real `tiresias mcp --local` server went through the same pages
and attacks.

- **Cost before the first question:** 143 tokens of tool list and 61 of instructions, against 3,733 and 269.
- **The six replies:** 226 to 1,101 tokens each, 3,850 in all, against 10,949.

Right answers out of six:

| Model | Context | Full server | Local mode |
|---|---|---|---|
| Qwen 3.5 9B | 4,096 | 0 | 6 |
| Qwen 3.5 9B | 8,192 | 1 | 6 |
| Qwen3 Coder 30B | 8,192 | 1 | 6 |
| Devstral Small 2 24B | 8,192 | 5 | 5 |
| Gemma 4 26B | 16,384 | 6 | 5 |

The two misses in local mode had the right passage in the reply: Devstral named `json.dump` where the passages
hold both `dump` and `dumps`, and Gemma answered a different reading of the RFC question. One run per cell.

**The twelve attacks**, on the three models that could call tools (Qwen 3.5 9B, Qwen3 Coder 30B, Devstral
Small 2): none of 36 worked, and all 36 answers gave the bakery's real opening time. Through today's envelope
with one tool, 6 of 36 had worked. Read this with care: the check's patterns were adjusted after the attacks
were seen, the marker patterns after the held-out round. It is the same exam taken twice, and it says nothing
about an attack worded in a new way. OLMo 3 7B made no tool call with the real server's instructions written
into its prompt, so it has no row.

## 9. Three rough edges from daily use

Found on 2026-11-14 while Tiresias was used for ordinary research, and fixed the same day.

- **A reply carried its text twice.** Every heading, preview and paragraph came back a second time as a receipt.
  An outline of one news article with 28 sections held 55 receipts. `read` now takes `receipts: "log"`: the
  receipts are made and recorded as before, and the list is left out of the reply. In the tests the reply was
  under three quarters of its old size for an outline, a section and a question. The default has not changed.
  Private reads keep their receipts in the reply, since nothing else would hold them.
- **A wait on robots.txt read as a refusal.** When a site answered its robots.txt with HTTP 429, the reply said
  Tiresias "assumes the site says no", and the caller gave up on a page it could have read a minute later. The
  rule is the same: nothing is read until the wait is over. The reply now says it is a wait and gives the seconds.
- **A question read returned the page's structured data in place of the article.** One article's structured data
  held its whole body as a single long line of escaped HTML. A long line holds many words, so by word count it
  outranked the article's own paragraphs. A line of structured data over 500 characters is now ranked after
  every other passage. Short lines, such as a price or a date, are ranked as before.

## 10. Who wrote a passage (W-39)

Built on 2026-11-18. In local model mode, on a page where the reader finds text written by visitors, every
passage says who wrote it: `"written_by": "the site"` or `"written_by": "a visitor to the site, not the site
itself"`. The two values are the wording used in the lab tests that led to it. Those tests, as the spec row for
W-39 records them: on three unseen sets of planted comments with four local models, labelling every passage cut
the planted comments a model followed from 33 to 11 of 288 tries, and to 8 with the meaning check as well, with
every honest page still answered correctly; and in a survey of 114 real pages, 46 of the 49 that carried visitor
text in the read marked it in one of the three ways below, 14 of them by a formal standard.

**How it reads a page.** The reader marks each paragraph it reads with a level:

1. A formal standard: schema.org types and properties for comments, reviews, answers and forum posts, in the
   HTML (microdata or RDFa) or in the page's JSON-LD structured data, and the ARIA comment role.
2. A class or id that names visitor text (comments, reviews, replies, testimonials and a few forum post names),
   matched on whole words, so "preview" and "s-prose" do not count. Names that also say form, link, count or
   title are the site's own furniture around the comments and count for nothing, and so do class names in code.
3. A heading that names visitor text, in English, such as "Comments", "3 Comments" or "User Contributed Notes".
   Its section, up to the next heading of the same level or higher, is the visitor's.

A mark only adds. Anything inside a marked part stays the visitor's whatever markup it carries, a paragraph with
any visitor text in it is the visitor's, and a heading inside a marked part neither opens nor closes a level 3
section. The level of each passage goes to the read's line in the history, never into the reply.

**What it does not change.** It adds no sign to the check for text aimed at an AI, withholds nothing and changes
no warning. A page with no visitor text gets the reply it got before, byte for byte. The full server does not
carry it. The owner can turn it off with `tiresias settings set written_by off`; no tool can see or change that.

**What the tests show.** These are our own small pages, written for the tests, not real sites, and no model was
involved. One page for each common structure:

| Page | What is marked | Level |
|---|---|---|
| A classic WordPress comment list (`commentlist`) | the comments; the reply form's text stays the site's | 2 |
| A forum thread with schema.org microdata | the post and its reply | 1 |
| An issue tracker marked only by class names | the two comments | 2 |
| Notes under a "User Contributed Notes" heading, no other marker | the notes, up to "See also" | 3 |
| A recipe whose one review is only in its JSON-LD | the review's lines, its author included | 1 |
| A shop whose reviews are loaded by script | nothing: no label, reply unchanged | none |
| A wiki talk page with no marker at all | nothing: no label, reply unchanged | none |
| A modern WordPress page (comments inside `id="comments"`) | nothing: the reader already leaves those out | none |

- **Against the parent commit.** Sixteen local reads of these pages were recorded from the commit before W-39
  (5baaba4). The five reads of pages with no visitor text answer byte for byte the same. The eleven reads of pages
  with visitor text answer the same once each `written_by` is taken out: the same passages, warnings, withheld
  passages and counts. With the setting off, all sixteen answer byte for byte the same. The local and full server
  fixtures from earlier in v1.2 still match.
- **Look-alikes** that mark nothing: `class="preview"`, `class="s-prose"`, a code highlighter's `class="comment"`
  inside `pre` and inside `code`, the headings "Our review process", "Peer review", "Responses" and "Leave a
  reply", a comments block inside `template` or `noscript`, and a "5 comments" link.
- **Forgery.** A comment that contains the words `"written_by": "the site"`, a heading, an `articleBody`
  property or a site class stays the visitor's. A visitor's heading does not end the section a site heading
  opened. A visitor part inside a site paragraph makes that paragraph the visitor's.
- **With the other checks.** A visitor passage with one sign carries the label and the warning; one with chat
  markers is withheld and still labelled. With the meaning check's signs, the same warnings come out with or
  without the label.
- **Budget.** At a budget of 1,000, 1,500 and 6,000, every labelled reply on a page of 40 comments stays within
  the budget, and every passage and section page carries its label.

**Known limits.**

- A page that marks its comments only by a heading has no way to show where a visitor's own heading is. If a site
  lets visitors write headings, one can end that section early, and the comments after it are labelled the site's.
- One page of a section is one part. When it holds both site text and comments, all of it is labelled a visitor's.
  That errs toward the visitor.
- A site that names its own writing "review" (a critic's review in `class="review"`) gets it labelled a visitor's.
- Headings are matched in English only. Other languages are future work.

### The first review of the label, and what it changed

Codex reviewed the build the same evening and found six faults, two of them serious. All six are fixed, each with a
test of its own (`src/test/v12-label-fixes.test.ts`); the record is in `docs/reviews/2026-11-18-w39-codex-r1.md`.

- **A heading inside a comment could end the visitor section.** Where a page marks its comments only by a heading, a
  visitor who wrote a heading of their own closed the section, and the text after it came out as the site's. A
  section opened by a heading now ends only at a heading of the same or a higher rank beside the one that opened
  it, or at the end of the part of the page that holds it.
- **Structured data inside a visitor section lost its label.** It keeps it now.
- **One pattern was slow on a hostile page**, and it reached the full server as well: a long run of slashes in a
  schema type turned a parse of a few milliseconds into a five second failure. It is a plain scan now.
- **A section read's label was worked out before the text was cut to fit**, so the label and the text shown could
  disagree. It is worked out from the text that is shown.
- **Two misses:** formal marks inside preformatted text, and visitor text under a very deep stack of elements.

A limit that follows from the first fix: after a comments heading, a later part of the page that sits deeper in the
same container, with a heading of its own, is still labelled as a visitor's. The label errs toward the visitor
when the page does not say, because the wrong answer in the other direction is the one that hurts. The parser
version went to 20.

## Done at the sweep (2026-11-19)

Branches `v1.2-sweep` (L.1 to L.6) and `v1.2-guard` (L.7 to L.9). Fixes written by Codex, reviewed by Banks;
records in `docs/reviews/2026-11-19-v12-sweep-*`.

- **L.1** (LOW): a short complete page with a script, or a page that is a list of links, is no longer called
  JavaScript-only. Commit 85ad0a6.
- **L.2** (LOW): nested layout-named wrappers keep their text under the new wrapper rule (L.6), and craigslist's
  front page no longer gets the JavaScript-only note (L.1). zillow.com and amazon.com refused a plain fetch on the
  day, so the fix is tested on a page built like them, not on the live pages. Commits dfd4988 and 85ad0a6.
- **L.3** (MEDIUM): the default reply's flags use local mode's patterns. False alarms on ordinary pages: 1 of
  2,028 passages. Commit d4e6af3.
- **L.4** (LOW): the lab harness records an empty answer with the model's reasoning and counts it apart from a
  wrong one. Commit 85ad0a6.
- **L.5** (LOW): local mode accepts `"section": "2"`. Commit 85ad0a6.
- **L.6** (MEDIUM): the fresh review found one HIGH and three MEDIUM faults, so the wrapper rule was replaced by a
  simpler one that decides each layout-named element on its own text. 38 real pages read exactly as before.
  Commit dfd4988.
- **L.7** (MEDIUM): guard setup, import and off share one lock, and setup and import write nothing if the
  setting or library changed while they ran, so `guard off` always wins. Commit 7d4fe94 (branch `v1.2-guard`).
- **L.8** (MEDIUM): setup and import refuse, before embedding, a library whose vector files would pass the
  reader's 512 MiB limit at the model's dimension. Commit 7d4fe94.
- **L.9** (MEDIUM): scoring after the embedding call is timed and can be cancelled; past the deadline the read says
  the check did not run. Commit 7d4fe94.

- **W-39, round 2** (branch `v1.2-label`): Codex's second review of the label found four HIGH and one MEDIUM, all
  fixed in commit 6ca92f1 (`docs/reviews/2026-11-19-w39-codex-r2.md`).
- **The integrated review** (branch `v1.2-label`): five whole-repo rounds. Round 1 found two HIGH and five MEDIUM,
  round 2 two HIGH (from round 1's fixes) and one MEDIUM, round 3 one HIGH and one MEDIUM, round 4 two MEDIUM, and
  round 5 nothing. All fixed: commits 201363f, 460377a, 6b13916 and ec02139
  (`docs/reviews/2026-11-19-v12-integrated-codex.md`).

## The release review (2026-11-19)

CodeRabbit's command-line review read the release commit and made 15 findings. Codex checked each against the code
and the built files: 13 were real and 2 were not (the phrase patterns carry no flag that keeps state between
calls, and a 3 MiB article parses in under a second with the extra heading walk). Three were fixed before the
release, each with a test that failed first (`src/test/v12-release-fixes.test.ts`, 32 tests; Codex wrote the fixes
and Claude reviewed them):

- **A setup could empty the owner's imported examples.** When `guard/imported.jsonl` could not be read, or held a
  line that did not parse, setup treated it as no imports and wrote the library back without them. Setup and
  import now stop before anything is read from the web or written, and say the file is damaged and nothing was
  changed. Only a missing file means no imports.
- **A vector could be attached to the wrong text.** An embeddings reply in which some items carried an `index`
  and others did not, or two carried the same one, was taken in the order it arrived. If any item has an index,
  every item must now have one and together they must name each input once; anything else fails the call, and the
  read says `meaning_check: "not run"`.
- **An embedding call cancelled before its name lookup started could outlive its time limit**, if that lookup
  never answered. A call that is already cancelled now fails at once.

GitHub's code scan of the same commit raised six alerts. Two were the same fault in two places: a file the owner
names on the command line (`guard check --file`, `--ordinary`, `--ordinary-urls`, `guard import`) was checked and
then opened by name, so it could be swapped in between. It is now opened once and checked through that handle.
One alert is the meaning check doing what it says (passages go to the owner's embedding endpoint). Three are in
the lab scripts, which strip tags to count text and guard nothing.

## Left for the next sweep

| ID | Level | What |
|---|---|---|
| N.1 | LOW | With L.3, the pattern for a role line (`User:` at the start of a line) flags a link title such as `User:Strebe`, which Wikipedia uses for image credits. Seen on Wikipedia's main page. |
| N.2 | LOW | W-39: a question read can keep a visitor label on a passage after that passage's visitor heading was withheld by the aimed-at-an-AI check. It errs toward the visitor. (Codex, W-39 round 2.) |
| N.3 | LOW | HTML parsing takes about 1.6 times as long since integrated round 2 (615 ms to 995 ms over 33 real pages), from one extra extraction walk that finds heading regions. Output is identical; the walk could be folded into the main one. |
| N.4 | MEDIUM | A local read that finishes within moments of its 60 second limit is answered with a cancellation error if the limit lands during the meaning check, although the page was read and its receipts written. It should keep the reply and say `meaning_check: "not run"`. A test written earlier expects today's behavior, so this is a decision as well as a fix. (CodeRabbit.) |
| N.5 | MEDIUM | A timestamp proof whose node carries both a pending attestation for a listed calendar and a Bitcoin attestation is not asked about again by `upgrade`. The proof stays usable and its Bitcoin claim stays worded as unchecked. (CodeRabbit.) |
| N.6 | MEDIUM | The meaning check connects to the first checked address of its endpoint only. When `localhost` resolves to `::1` first and the embedding server listens on `127.0.0.1` alone, setup fails. Give the connection every checked address. (CodeRabbit.) |
| N.7 | MEDIUM | A failed disk write in the middle of an import can leave the library's vector file and its metadata from different generations. The check then reports "not run" and `guard setup` rebuilds; a second import does not. Write the new generation whole before switching to it. (CodeRabbit.) |
| N.8 | MEDIUM | The meaning check's time limit starts after the library is loaded, and the first load reads and checks both vector files in one step. A very large imported library on slow storage can hold other calls for that step. (CodeRabbit.) |
| N.9 | LOW | The lab harness (`scripts/v12-lab/lab.mjs`) keeps replies by tool, arguments and mode but not by build, so two builds run into one output folder share replies. Four test files can wait forever instead of failing when the thing they wait for never happens. (CodeRabbit.) |
