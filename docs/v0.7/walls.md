# v0.7 Track 2: walls and hidden text, revisited with rendering (N-02, N-05, W-10)

Branch `v0.7`, from `84ef126` (track 1 render and track 3 translate done, 829 tests passing). Decisions for the
coordinator to fold into SPEC.md at release.

## Progress

- [x] Read SPEC (principles, N-02, N-05, N-08, W-10, decisions 2026-10-21, 2026-10-22, 2026-10-23), `render.md`, `translate.md`
- [x] This plan
- [x] `src/inspect.ts`: the in-page inspection (walls and hidden text), run from the isolated world with scripts stopped
- [x] `src/render.ts`: one render serves the HTML, the walls and the hidden text (`renderHtml` runs the inspection first); viewport 1280 x 900
- [x] Reader and shield (`src/shield.ts`, `src/reader.ts`, `src/work.ts`): rendered marks decide hidden text; the HTML heuristics only for what the inspection could not reach
- [x] Pipeline (`src/pipeline.ts`): a marker wall (captcha, login) found in the plain HTML waits for the render's verdict when a render will run; the rendered verdict replaces the HTML heuristics; `render.walls`, `render.hidden_text`, `render.overlay`
- [x] Tests (`src/test/walls-rendered.test.ts`): 6, of which 3 need Chrome and are skipped by name without it (checked with `TIRESIAS_TEST_NO_CHROME=1`: 3 pass, 3 skipped)
- [x] README, CHANGELOG (unreleased v0.7.0), SPEC rows (status only)
- [x] Full suite at the checkpoint: 835 of 835 passing, 0 skipped (829 before; 6 new, 3 of which need Chrome)
- [x] Codex review loop (fix HIGH only; MEDIUM and LOW deferred below)
  - [x] Round 1 (`docs/reviews/2026-10-31-v07-walls-round-1.md`), with the rendered-read scope in the prompt: **HIGH 0, MEDIUM 6, LOW 4.** No HIGH, so the loop ends at round 1; all ten deferred below. Codex did not run the Chrome tests (its sandbox allows no writes); this suite runs them.
- [x] Final full suite; secret scan, push `v0.7`, report to Banks

## Design calls (with reasons)

### One render, three answers

`renderHtml` (track 1) now runs the inspection inside the same `withRenderedPage` call that takes the HTML: walls first,
then hidden text, then the HTML (which carries the hidden-text marks). Chrome is started once per read, as before; a
check or a cached rendered copy starts nothing. Why the order: the wall verdict is the cheapest and the one that stops
a read, so it is never lost to the hidden-text budget.

Everything is read from the isolated world track 1 already uses, after `Page.stopLoading` and
`Emulation.setScriptExecutionDisabled`: the page's scripts can neither run during the inspection nor replace the DOM
methods the inspection calls (an isolated world has its own prototypes). What the page controls is its CSS and its DOM,
which is exactly what is being measured.

**The viewport.** The page loads at 1280 x 900 (set before navigation; headless Chrome's own default is smaller and
not a real screen) and is inspected at that size. Hit tests (`elementsFromPoint`) only reach points inside the
viewport, so the inspection scrolls the window (`behavior: "instant"`, at most 2,000 scrolls) to bring each sample
point into view, the way a person scrolls; a fixed overlay then covers every screen, as it does for a person. Why not
stretch the viewport to the page's height: `100vh` blocks would grow with it and push the rest of the page down.
A point the scroll cannot reach (past the scroll limit) is judged by every test except covering and clipping.

### Hidden text, from what the browser shows

For each text node of the body (not in `script`, `style`, `noscript`, `template`, `title`, `select`, `svg`,
`iframe`, `object`, `canvas`, the same list the reader skips), with at least one letter or digit, the first that applies:

| Code | Test (computed by Chrome, never guessed from source) |
|---|---|
| `not_displayed` | `checkVisibility()` false: `display: none` on it or an ancestor, `content-visibility: hidden`, the `hidden` attribute, and any external style sheet or script that did so |
| `invisible` | `checkVisibility({visibilityProperty: true})` false (`visibility: hidden` or `collapse`) |
| `transparent` | `checkVisibility({opacityProperty: true})` false, or the product of the opacities of it and its ancestors under 0.05 |
| `zero_size` | its text has no box, or every box is under 2 px in width or height (`font-size: 0`, `scale(0)`, a zero box) |
| `off_screen` | every box lies wholly left of or above the page, or right of or below the page's scrollable area |
| `clipped` | its element is in no hit-test list at any sample point (overflow, `clip`, `clip-path`, a screen-reader-only class) |
| `covered` | at every sample point an opaque element that is neither it, its ancestor nor its descendant, and not fixed or sticky, is painted above it |
| `same_color` | its text colour is almost transparent, or its contrast with the first opaque background behind it (walking up, stopping at any background image, which cannot be judged) is under 1.2 |

- Up to three sample points per text node (the middle of its first box, its last box, and its middle box), and a text
  node is `clipped` or `covered` only when **every** point is, so partly covered text stays readable.
- A textarea's text is judged using the control's box: Chrome paints it inside the native control rather than in
  its child text node's range boxes. Hidden marks go on the textarea itself so raw-text serialization preserves them.
- Any element with a background image or gradient counts as an opaque cover: the inspection does not read image
  pixels, so text under a transparent decorative layer can be flagged `covered` (a false flag, never a missed one).
  v0.9.1 tried twice to judge gradients and images instead; each attempt opened a way to hide text, so this rule
  stays: row 7.7, designed away (Travis, 2026-11-01; SPEC section 9).
- Elements with `pointer-events: none` are left out of hit tests by the browser, so a text node whose element has it is
  not judged `clipped` on a missed hit test (it would be a false flag). Such text cannot be measured for clipping:
  the inspection is marked partial (`hidden_text: "partial"`), the HTML hiding checks also run, and the text does not
  count as proven visible text for wall detection. This can also happen to fully visible text. Text found at its
  sample points, or out of hit-test reach, keeps the existing checks. A covering element with it is not seen
  (a known limit, below).
- **Fixed and sticky elements do not count as covering text** (a cookie bar or a sticky header covers different text as a
  person scrolls). Large ones are overlays (walls, below).
- Text inside a closed `<details>` is read as shown (one click away for a person: a disclosure, not a hiding trick).
- Display-none subtrees are marked once, at the topmost element that hides them, so one hidden block is one flag, as in
  the HTML reader. Other reasons are marked per text node.
- **How the reader gets it:** each hidden element or text node is marked in the live DOM with an attribute whose name is
  random per render (`data-t-` and 16 hex characters from Tiresias, made after the page's scripts stopped, so the page
  cannot write or guess it); a hidden text node is wrapped in a fresh `<thidden>` element (no hyphen, so the page cannot have defined it as a custom element) that carries the mark. The
  serialized HTML then goes through the same reader and shield as any page, told the mark's name. For a rendered page,
  `hiddenReason` (shield.ts) answers from the mark alone: the HTML guesses (inline styles, the page's own `<style>`
  rules, class names) are not used, because the browser already decided, including what external style sheets and
  scripts did, and the guesses can be wrong both ways (`.x{display:none}` overridden by a later external rule).
  The flag is the same `hidden_text` with a fixed `detail` (`rendered: not displayed`, ...), the caps per flag type (30)
  are unchanged, and hidden text stays out of the readable text, as before.
- **Bounded:** at most 20,000 text nodes inspected and 2.5 s of work inside the page (the evaluate call's own limit is
  6 s); 5,000 marks at most. Past any of these the inspection stops and says so: the reader then uses the marks it has
  AND its HTML guesses for everything else (`hidden_text: "partial"`).

### Walls, from what the browser shows

The inspection finds, with the same visibility tests (displayed, visible, not transparent, a box at least 10 x 10 px on
the page, not clipped, not covered), the **visible** password boxes (`input[type=password]`) and the **visible** CAPTCHA
markers (`.g-recaptcha`, `.h-captcha`, `.cf-turnstile`, `[data-sitekey]`, and frames whose address names captcha,
recaptcha, hcaptcha, turnstile or `challenges.cloudflare.com`; frames are refused by the render, but their box is still
laid out where the widget would be).

- **Overlay:** an element that is (or sits in) `position: fixed`, covering at least half of the stretched viewport
  (a backdrop or modal layer painted above page content at a sample point, opaque or not). Fixed backgrounds
  painted behind content are not overlays. When a visible password box or
  CAPTCHA is in a fixed layer and such an overlay exists, that is a **wall** (`login_required`, or `captcha` /
  `bot_challenge` for a Turnstile), whatever text is beneath: a person cannot get past it without signing in or solving.
- **Not in an overlay:** a visible password box or CAPTCHA is a wall when the page's **visible** text outside it is thin:
  under 1,200 letters and digits, not counting the form that holds the marker, hidden or covered text, and site
  furniture (`nav`, `header`, `footer`, `aside`, and the ARIA roles `navigation`, `banner`, `contentinfo`,
  `complementary`). The same 1,200 the HTML rule uses (2026-10-21), now measured on what is actually shown. A forum page
  with a sign-in box in its header, or an article with a captcha'd comment form, is read.
- **An overlay with no password box or CAPTCHA** (a subscription, consent or newsletter box covering the page) is **not
  a wall**: the read goes on, and the reply says `render.overlay: "other"` with a fixed sentence. Why: such a box asks a
  person for a choice (consent, money) rather than a login, the text under it is in the page and is returned as
  untrusted data like any text, and stopping every consent banner in the EU would make rendering useless there. The
  agent is told a fixed layer covers at least half the viewport and may be transparent. Text under an overlay is not
  flagged as hidden text one node at a time (it would be the whole page).
- `bot_challenge` pages ("Just a moment", `cf-mitigated`) and status walls (401, 403) still stop BEFORE any render: a
  bot check is never run in the browser (running its script is how it is passed, principle 1).
- **Marker walls found in the plain HTML wait for the render.** When a render is going to run for this read (asked and
  allowed, auto on a shell, or a check of a rendered copy), a `captcha` or `login_required` wall from the plain HTML's
  markers is not returned yet: the render decides. If the render stops (a cap, a busy page) or cannot run, the plain
  verdict stands. Why: the HTML rule errs toward walls on purpose (2026-10-22: a login box in a hidden modal is a wall);
  the render can see whether the box is shown. A Cloudflare title, Turnstile or header wall never waits.
- **The rendered verdict replaces the HTML heuristics** on the rendered HTML (the worker's `detectWall` is not run on it)
  whenever the wall inspection completed. If it did not (a cap), the HTML heuristics run on the rendered HTML as in track 1.

### What the reply says

Only for a read that was rendered (unrendered replies are unchanged, byte for byte): inside the existing top-level
`render` object, fixed codes only:

- `walls`: `"rendered"` (decided by the browser) or `"html"` (the HTML heuristics decided: the inspection did not
  finish, or the render stopped and a plain marker wall stood).
- `hidden_text`: `"rendered"`, `"partial"` (some marks plus the HTML guesses), or `"html"`.
- `overlay`: `"login"`, `"captcha"` or `"other"`, when the page was covered by an overlay; with a fixed sentence in the
  message for `"other"`.

A wall reply from a rendered read carries the same `render` object (it already did in track 1). History still records a rendered read. The cache keeps the fixed inspection codes with the rendering and restores
them on fresh, revalidated and refetched reuse; the flags remain in `parsed`. Older rendered entries without those
codes are rebuilt. The rendered fingerprint canonicalizes the private mark name, so a new mark on an unchanged
page does not reset its provenance.

### The decision to revisit (2026-10-23): recommendation

**Agreed, with one boundary drawn tighter.** Walls and hidden-text flags stay advisory: Tiresias's guarantees remain that
it never logs in, solves, pays or submits a refused form, and that every word a page says is returned inside
`untrusted_content`. Neither a wall nor a flag guards any of those; `form_submit`'s own refusals do.

With rendering, the verdicts become measurements rather than guesses, so for a **rendered** read a site hiding its own
wall or hidden text from the inspection becomes a finding again, **when the technique is one the inspection claims to
measure**: the eight hidden-text codes above, visible password boxes and CAPTCHA markers, fixed overlays, and the
boundary that keeps the page's own scripts from answering (isolated world, scripts stopped, the random mark name). A
page that makes the inspection report wrongly through its scripts, its DOM or the mark is a finding of any severity.

Not findings, for rendered reads too, and listed as known limits: text drawn where the DOM has none (canvas, images,
CSS `content:`), shadow DOM (track 1 does not read it), filters and blend modes (`blur()`, `mix-blend-mode`), fonts whose
glyphs draw nothing, text-shadow-only or gradient-clipped text (judged by its colour alone), a cover with
`pointer-events: none`, text with `pointer-events: none` that a hit test cannot find (clipping cannot be measured,
so the inspection is marked partial and the HTML hiding checks also run), `opacity` between 0.05 and 1 judged visible, background images and gradients judged opaque without reading
their pixels, and text past the scroll limit judged without hit tests. Paywall or consent boxes without
a password box or CAPTCHA are overlays, not walls, by design; detected transparent layers get the same overlay note.
Why the line: the visual effects outside the named measurements need a pixel-level renderer comparison (drawing the
page and reading the pixels), which is open-ended in the
same way CSS guessing was before rendering; the named set is what the browser answers exactly.

For **unrendered** reads the 2026-10-23 scope stands unchanged: wall evasion by a site disguising its OWN wall, and CSS
tricks that avoid the hidden-text flag, are not findings.

Every Codex prompt of this track carries this scope.

## Known limits

The list in the recommendation above, plus: a page that changes after it settles is inspected as it was when scripts
stopped (that is the point); `aria-hidden` text that is shown is not flagged on a rendered read (a person sees it); an
element covering at least half of the viewport that is fixed, painted above content and transparent with no marker in a fixed layer is an overlay only for
the `overlay` note, never a wall.

## Files touched outside the new modules (for the merge)

New: `src/inspect.ts` (the in-page script, the verdict, the mark), `src/test/walls-rendered.test.ts`.
- `src/render.ts`: `RenderTop.walls`, `hidden_text`, `overlay`; `OVERLAY_TEXT`; viewport set before navigation;
  `renderHtml` runs the inspection and returns `findings`.
- `src/shield.ts`: `HiddenSheet.rendered`; `hiddenReason` answers from the mark first.
- `src/reader.ts`: `parseHtml(html, url, keep, rendered)`. `src/work.ts`: the parse job's `rendered`; no `detectWall`
  when the browser decided.
- `src/pipeline.ts`: `Rendered`, `parseJob`/`parsePage` take it; in `run`, the plain marker wall waits for a render that
  will decide; the rendered verdict; `renderNote` adds the overlay sentence.

## Deferred to compute-day sweep

| Round | Severity | Summary | File |
|---|---|---|---|
| 1 | MEDIUM | Form controls named `checkVisibility` or `nodeType` shadow those properties on their form (named-property access works in the isolated world too); `vis` catches the failure and says visible, `effOpacity` skips the form, so text directly inside a transparent form can pass as visible. Fix: call native methods and getters captured from the isolated world's prototypes. | `src/inspect.ts` (`inspectScript`: `vis`, `effOpacity`) |
| 1 | MEDIUM | Marker loops stop at 2,000 inputs or CAPTCHA candidates without saying so, so a visible password box after 2,000 hidden inputs gives no marker and a definitive `walls: "rendered"` no-wall verdict. Fix: track marker-scan completion; after truncation, no definitive negative verdict (HTML fallback unless a marker already proves a wall). | `src/inspect.ts` (marker loops, `wallVerdict`) |
| 1 | MEDIUM | Hidden text inside raw-text elements (`xmp`, `plaintext`) is wrapped in `thidden`, which htmlparser2 reparses as literal text, so the mark is lost and (inspection complete) the words are shown unflagged. Fix: mark the raw-text element itself, or carry text-node decisions in a form that survives serialization. | `src/inspect.ts` (mark insertion) |
| 1 | MEDIUM | `display: contents` wrappers fail `checkVisibility()` although their content shows: direct text is marked `not_displayed`, and the ancestor climb can move a hidden child's mark onto a visible wrapper, hiding its siblings. Fix: judge text by its ranges; consolidate only at ancestors that actually hide their contents. | `src/inspect.ts` (`judge`, hidden-root grouping) |
| 1 | MEDIUM | Only `rgb()`/`rgba()` computed colours are parsed; transparent text or an opaque cover written in `color()`/`oklch()` skips the `same_color` and `covered` checks. Fix: normalize computed colours with alpha; an unparsed colour makes the inspection incomplete. | `src/inspect.ts` (`rgba`, `judge`, `opaque`) |
| 1 | MEDIUM | `bgAt` assumes a white canvas; an honest dark-scheme page (`color-scheme: dark`, transparent backgrounds, browser light text) can have all its text flagged `same_color` and removed. Fix: resolve the canvas colour for the used colour scheme. | `src/inspect.ts` (`bgAt`) |
| 1 | LOW | Any `background-image` counts as opaque, including transparent gradients, so a decorative layer above text gives false `covered` flags. Fix: require evidence of opacity. | `src/inspect.ts` (`opaque`) |
| 1 | LOW | The rendered fingerprint hashes HTML containing the random mark name, so re-rendering an unchanged page with hidden text looks changed (provenance reset, empty diff). Fix: canonicalize the mark name before hashing. | `src/pipeline.ts` (`run`) |
| 1 | LOW | A cached rendered reply rebuilds only `{status: "cached"}` and loses `walls`, `hidden_text` and `overlay` (the consent-box sentence too). Fix: keep the fixed inspection codes with the cache entry and restore them. | `src/pipeline.ts` (`run`, `finishPage`) |
| 1 | LOW | A large transparent fixed layer gets no `overlay` note: `"other"` needs opaque coverage of most of the text. Fix: report a detected overlay on its own, with its own fixed sentence (and align the plan's known-limits wording). | `src/inspect.ts` (`wallVerdict`) |
