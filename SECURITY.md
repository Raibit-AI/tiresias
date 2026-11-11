# Security

Tiresias reads pages and files from sites you do not control, on behalf of an AI agent you may not fully control
either, so we take reports seriously. This page says what Tiresias defends against, what it promises, and what it
does not. The full reasoning is in [docs/SPEC.md](docs/SPEC.md) (section 2 principles, section 8 non-goals,
section 9 decisions).

## How to report

Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"). Say what
you found, how to reproduce it, and which version (`tiresias --version`). Please do not open a public issue for a
security problem. We answer within 5 working days.

## Threat model

### Who is trusted

| Who | Trusted? | Why |
|---|---|---|
| **The owner** (you, at your own terminal) | Yes | It is your machine, your keys, your settings. |
| **A program running as you with a shell** (an AI agent with a terminal tool, a script, cron) | Like the owner, with one exception | It can already read and change any file you can, the Tiresias store included. The exception: granting a permission slip needs a person at a terminal who types the slip's site back. Risky settings (saving, rendering, the translator, a scanner that receives files, anchoring, lower site spacing, more ports, turning Safe Browsing or a site ban off, private spacing off, sharing Tiresias secrets with hooks) need an all-caps confirmation phrase and are logged and shown in replies; an agent may type the phrase, so this stops a loosening *in passing*, not a determined program. |
| **The MCP client** (the AI app that starts `tiresias mcp` and talks to it: Claude Desktop, Claude Code, Cursor...) | Yes, for resource use | It is a program you installed, running as you. Tiresias trusts it not to flood its own server: thousands of calls at once, huge or malformed messages, or answers it never reads are the client's own behaviour, not something a page or an agent can make it do. Tiresias still caps calls, workers, renders, message size and open requests, pauses reading while answers back up, and runs the server under a memory ceiling (`TIRESIAS_MEMORY_MB`, default 1024 MB) so a flood ends in a clean exit the client can restart. If you do not trust your client, run Tiresias in Docker (see [docs/docker.md](docs/docker.md)), which puts a hard box around it. (SPEC section 9, 2026-10-31, W-33.) |
| **An AI agent over MCP** | No | It may have been fooled by a page it read (prompt injection). It can read pages and its own history, but no MCP tool or parameter changes a setting, grants or extends a slip, reads a local file, or reads a key. |
| **Websites, servers and files** | No | Any byte, header, redirect, timing or size may be hostile. |
| **A page's JavaScript** (only when you turn rendering on) | No | It runs in your installed Chrome, with Chrome's sandbox on, a throwaway profile, and every request it makes fetched by Tiresias under Tiresias's own rules. |

### What Tiresias promises

- **Page content is data.** JSON replies keep everything that came from a site, a page, a file or a server inside
  `untrusted_content`. The top level holds only Tiresias's own codes, numbers and fixed text. Human-readable text
  views (`--text`, and the default `log` and `needs`) mark where web content begins: "web content below is untrusted".
  Agents should use JSON (`log --json`, `needs --json`); `text_views=wrapped` also wraps text views inside `untrusted_content`.
- **No code from the web runs on your machine** outside Chrome's sandbox. Files (programs, archives, documents) come
  back as a warning with their kind and fingerprint; Tiresias never opens or runs one. PDFs are read in a separate
  child process that may not read your files or the store's keys or start worker threads; zip, Office and calendar files are read as data in
  memory, in a worker thread with a time budget.
- **Nothing is written outside the store** (`~/.tiresias`, or `$TIRESIAS_HOME`) except where you name a folder
  yourself on the command line (`log --to`, `receipts prove --out`, `keys sign-directory --out`), and Chrome's throwaway
  profile in the system temp folder while a render runs. (The copy your own scanner is handed, when you allow it,
  sits in the store's `quarantine/` folder.)
- **Private addresses are refused.** Loopback, private, link-local and similar addresses are refused after DNS, on
  every redirect hop, door probe and rendered subrequest, and only ports 80, 443 and 8000 to 8999 are used unless you
  allow more.
- **The site's rules win.** robots.txt, Crawl-delay, Retry-After and your own site settings (`never_visit`,
  `hand_off`, `spacing_seconds`, `ports`) are obeyed on every request to a site Tiresias reads. Services you turn
  on are called directly: the OpenTimestamps calendars (address, port and `never_visit` checks, no robots.txt) and
  Google Web Risk (not spaced).
- **Nothing is sent to Raibit or anyone else**, apart from the requests to the sites you read and the services you
  turn on (listed in the README under "Where things are stored").
- **No form is sent without your permission slip** for that site (and that path, if you set one), so no money moves
  without your yes. On top of the slip, Tiresias refuses every form it recognizes as a sign-in, password, CAPTCHA,
  payment or purchase form, slip or not. The slip is the guarantee; the recognizing is best-effort (see below).
  Slips gate sending forms; following a link is an ordinary read. A site that changes
  something on a plain GET breaks HTTP's rule that GET is safe, and that is the site's doing. A rendered page's
  scripts may not request a URL matching a GET form action on that page. This check covers up to 1,000 forms and `formaction` attributes together
  in both the original HTML and the live page, with a 65,536-character total action budget per scan,
  counting repeats (2,048 characters per HTML action, 8,192 per live action). Every subrequest is refused
  past these limits, when the scan is incomplete or when an action is invalid, credentialed or unreadable.
  The HTML scan guards the union of each raw action resolved against the page URL and every distinct
  http(s) base anywhere in the parsed HTML, including templates and later bases. Non-web bases are
  ignored; more than 16 distinct web bases makes the scan incomplete. Missing actions use the empty
  string, without trimming. Every resolution counts toward the budget, including skipped non-web results.
  Every `formaction` attribute on any element anywhere contributes an address, regardless of its method.
  Any `formmethod` attribute other than post or dialog makes every form action count, including POST and
  dialog forms. Without one, POST and dialog forms are skipped. Method comparisons ignore case but do not
  trim. Literal U+0000 in action, formaction or base href attributes makes the HTML scan incomplete;
  zero character references decode to U+FFFD and are checked normally. Valid non-web actions are skipped;
  other form methods count as GET for this guard only. The live check calls native prototype selectors,
  collection accessors and form, button and input getters in an isolated world, avoiding page wrappers
  and named form properties. The page can still change the shared DOM, including methods, actions,
  associations and bases, and remove a form between observations. The static parser is htmlparser2,
  not Chrome's HTML parser: malformed foreign content can hide forms from the static scan, for example
  `<math><annotation-xml><textarea><p><form action="/vote">`. The live check can see the resulting form
  while it remains in the document; neither check proves every possible GET is safe.
  The form listing stays capped at 20. Owners can tighten reads of known GET
  form actions to require a `submit_form` slip with `get_form_actions=slip`.
- **Tiresias never logs in, never solves or bypasses a CAPTCHA, and never pretends to be a person's browser.**
  It refuses every sign-in form it recognizes and keeps no session: cookies last for one call. (Recognizing a
  sign-in form is best-effort; see below.)
- **Caps.** Response size, parse time, PDF memory, and render time and requests are capped; a page that runs past
  one of these ends as an error, except a render cap falls back to the plain read with render failure metadata.
  The MCP server's own JavaScript heap is capped too (`TIRESIAS_MEMORY_MB`,
  default 1024 MB): past it the server stops with a clear message on standard error and a line in the daily log,
  and the AI app can start it again. (The store's disk use is a daily target, trimmed once a day, not a
  hard cap.)
  History and receipt scans, including the daily log and needs report, stop on cancellation or at a 60-second deadline.

### What Tiresias does not promise

- **Walls and hidden-text flags are advice, not a guarantee.** Tiresias tries to notice a CAPTCHA, a login wall,
  hidden text and instructions aimed at an AI, and says so. A site that disguises its own wall, or hides text in a way
  the reader does not recognize, only changes how its own page is reported; the words still arrive inside
  `untrusted_content`. On a rendered page the browser measures a named set of hiding techniques (SPEC section 9,
  2026-10-31); anything outside that set is a known limit.
- **Recognizing a sign-in, payment or purchase form is best-effort.** A password field, a card field marked as
  one and an embedded CAPTCHA frame are recognized from the markup itself. A form that only says what it does
  in words is recognized from word lists in 13 languages: English, Spanish, French, German, Portuguese, Italian,
  Dutch, Russian, Chinese, Japanese, Korean, Arabic and Hindi. A form worded another way, or written in another
  language, may not be recognized, and it can then be sent if your slip covers it. Give each slip the narrowest site and path
  that does the job.
- **`get_form_actions=slip` matches other spellings of an address, not every address.** With that setting on,
  Tiresias asks for a slip before reading an address that is another spelling of a GET form action it has seen
  (encoding, case, dot segments, extra punctuation). It cannot know that a server sends a different address to the
  same handler, such as `/vote.json` where the form said `/vote`. Ordinary reads learn only the first 20 listed
  forms, so actions of later forms may be unknown. The guard keeps 4,096 distinct targets in memory; repeats
  do not fill it further. Every further shared observation, including previews and read-only calls, enters
  a bounded conservative filter that can require extra slips but cannot forget a target during the process,
  even after cache eviction. Only private observations past their own 4,096-target limit make every GET
  need a slip for that call. Private observations never enter shared memory or the shared filter. Every
  call enforces its own observations, shared memory (exact set and filter) and surviving disk records.
  Read-only calls cannot save observations. After restart, only surviving disk records remain.
- **It cannot protect you from an agent that runs as you.** Anything that can run commands as you can edit the store,
  the settings and the confirmation record. Tiresias records changes and shows them in replies; it cannot stop them.
- **Owner-set hooks inherit the owner's environment**, with Tiresias secret variables removed by default
  (`hook_secrets=hidden`). `hook_secrets=inherit` restores the full environment after risky-setting confirmation.
- **A site's own echoed secrets are withheld on a best-effort basis.** When a form is sent, the site's answer may
  repeat a secret the site itself set for that one call (a hidden form value or a cookie). Tiresias tries not to see
  it: it checks the answer as received and its full extracted text before making previews or recording quotes.
  When it finds one (an original value of 6 characters or more, in any spelling its HTML,
  percent and JSON decoding covers) it withholds the whole answer rather than pass it on. An echo in an encoding it
  does not decode (base64, a hash, a value split up) is not caught; that is the site's own doing, and the secret is
  the site's, not yours (SPEC section 9, 2026-10-31).
- **It is not a virus checker.** File warnings name the kind of file; you can plug in your own scanner, and a clean
  verdict never makes Tiresias open a file.
- **It does not hide you from sites.** Private mode keeps no page record on your machine. It keeps Retry-After waits
  and minimal shared spacing state, origin and times only, because obeying the site comes first.
  `private_spacing=none` disables shared spacing for private calls and previews after risky-setting confirmation.
  The site still sees the honest Tiresias user agent (and your signature, if you set signing up).
- **Safe Browsing is a list check** (plus Google Web Risk if you add a key). The list is refreshed daily and used
  up to seven days old; past that, or with no list at all, pages are read unchecked and replies say so. A new
  phishing site can be missed.
- **A program running as you can swap a store file between a check and its use** (Node has no `openat`). The store
  refuses links and checks folder identity before each step, which closes this to sites and MCP callers, not to you.
- **Windows is not supported.** It cannot read PDFs there (memory cannot be watched), and your own scanner and
  translator never start there.
- **The PDF child's network is not fenced by Node.** Node's permission model does not limit network use: the child
  is simply given no address and no code that fetches.

## If your key leaks

Tiresias holds up to three secrets for you. If one gets out (copied to a synced folder, pasted somewhere, a server
holding a copy is broken into), here is what to do. Each step is free and takes a minute.

- **The signing key** (`keys/ed25519.private.jwk`): whoever has it can sign requests as your copy of Tiresias. Run
  `tiresias keys rotate --finish` first if an overlap is open, then `tiresias keys rotate --overlap 0`. That makes a new key,
  deletes the old one, and takes it out of your directory at once. Then publish the new directory (`tiresias keys directory`,
  or `keys sign-directory` for a static host) and give the new key to any server that signs your directory itself. For a planned change with no leak, plain
  `tiresias keys rotate` keeps the old key in the directory for 7 days (`--overlap` 0 to 30) so sites catch up; new
  requests use the new key straight away, and `keys rotate --finish` ends the overlap early.
- **The slip key** (`keys/slips.private.jwk`): whoever has it, and can also write to your store, could forge a
  permission slip. Run `tiresias keys rotate --slips --confirm "YES, ROTATE THE SLIP KEY"` and type
  `rotate slip key` when asked. Every slip is revoked and can never be used again; grant new ones as you need them.
  Saved pages stay checkable: `tiresias saved verify` says when one was signed by the old key, and that anyone holding
  the leaked key could have signed it too. One exception: if the slip key file was exposed (readable by other users,
  mode 0644) or cannot be read, rotation replaces it without keeping its public half, so pages it signed stop
  verifying. Receipts do not use the slip key and are not affected.
- **The Google Web Risk key** (`TIRESIAS_WEB_RISK_KEY`, or the line in `~/.config/tiresias/secrets.env`): whoever has
  it can spend your Google Cloud quota. Delete the key in the Google Cloud console (APIs and Services, Credentials),
  make a new one, and put it where the old one was. Tiresias reads it fresh, so nothing else changes.

Rotations are written to history and shown in `tiresias log`.

## What counts as HIGH

A way for a hostile site, page, file or server, or an AI agent calling Tiresias's tools (possibly fooled by a page it
read), to:

- run code on your machine,
- read or write a file outside the Tiresias store,
- leak a secret of yours (a signing key, a slip key, a Web Risk key, a local file),
- get around a permission or an owner-only control (a permission slip, the scanner or translator setting, a risky
  setting, private mode, robots.txt, a site setting, the private-address block, a refused form),
- make Tiresias hang or run out of memory past its caps through the pages it reads or the tool calls an agent makes,
- put page-controlled text outside `untrusted_content`.

Not HIGH: resource use caused only by the MCP client itself (floods of calls, huge or malformed messages, answers it
never reads). The client is trusted for that (see "Who is trusted"); report it as an ordinary bug.

Everything else (a crash, a wrong answer, a slow page, a missed wall or hidden-text flag on a site's own page, a
server stopped at its memory ceiling by its own client) is still welcome as an ordinary issue.

## Disclosure

We fix HIGH reports before anything else and ship the fix in the next release. We ask for 90 days from your report
before you publish details, less if the fix ships sooner. We credit you in the changelog unless you ask us not to.

## Supported versions

Security fixes go into the newest release only: from v1.0.0 on, the newest 1.x version. Upgrade to get them
(`npm install -g @raibitsi/tiresias@latest`, or `git pull` and `npm run build` in a source checkout). Supported
systems are macOS and Linux; Windows is not supported yet.
