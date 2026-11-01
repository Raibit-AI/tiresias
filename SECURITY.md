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
| **A program running as you with a shell** (an AI agent with a terminal tool, a script, cron) | Like the owner, with one exception | It can already read and change any file you can, the Tiresias store included. The exception: granting a permission slip needs a person at a terminal who types the slip's site back. Risky settings (saving, rendering, the translator, a scanner that receives files, anchoring, lower site spacing, more ports, turning Safe Browsing or a site ban off) need an all-caps confirmation phrase and are logged and shown in replies; an agent may type the phrase, so this stops a loosening *in passing*, not a determined program. |
| **The MCP client** (the AI app that starts `tiresias mcp` and talks to it: Claude Desktop, Claude Code, Cursor...) | Yes, for resource use | It is a program you installed, running as you. Tiresias trusts it not to flood its own server: thousands of calls at once, huge or malformed messages, or answers it never reads are the client's own behaviour, not something a page or an agent can make it do. Tiresias still caps calls, workers, renders, message size and open requests, pauses reading while answers back up, and runs the server under a memory ceiling (`TIRESIAS_MEMORY_MB`, default 1024 MB) so a flood ends in a clean exit the client can restart. If you do not trust your client, run Tiresias in Docker (see [docs/docker.md](docs/docker.md)), which puts a hard box around it. (SPEC section 9, 2026-10-31, W-33.) |
| **An AI agent over MCP** | No | It may have been fooled by a page it read (prompt injection). It can read pages and its own history, but no MCP tool or parameter changes a setting, grants or extends a slip, reads a local file, or reads a key. |
| **Websites, servers and files** | No | Any byte, header, redirect, timing or size may be hostile. |
| **A page's JavaScript** (only when you turn rendering on) | No | It runs in your installed Chrome, with Chrome's sandbox on, a throwaway profile, and every request it makes fetched by Tiresias under Tiresias's own rules. |

### What Tiresias promises

- **Page content is data.** Everything that came from a site, a page, a file or a server is returned inside
  `untrusted_content`. The top level of a reply holds only Tiresias's own codes, numbers and fixed text.
- **No code from the web runs on your machine** outside Chrome's sandbox. Files (programs, archives, documents) come
  back as a warning with their kind and fingerprint; Tiresias never opens or runs one. PDFs are read in a separate
  child process that may not read your files or the store's keys; zip, Office and calendar files are read as data in
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
- **No money moves**, and no form is sent without a permission slip. Login, password, CAPTCHA and payment forms are
  never sent, slip or not.
- **Tiresias never logs in, never solves or bypasses a CAPTCHA, and never pretends to be a person's browser.**
- **Caps.** Response size, parse time, PDF memory, and render time and requests are capped; a page that runs past
  one of these ends as an error, not a hang. The MCP server's own JavaScript heap is capped too (`TIRESIAS_MEMORY_MB`,
  default 1024 MB): past it the server stops with a clear message on standard error and a line in the daily log,
  and the AI app can start it again. (The store's disk use is a daily target, trimmed once a day, not a
  hard cap.)

### What Tiresias does not promise

- **Walls and hidden-text flags are advice, not a guarantee.** Tiresias tries to notice a CAPTCHA, a login wall,
  hidden text and instructions aimed at an AI, and says so. A site that disguises its own wall, or hides text in a way
  the reader does not recognize, only changes how its own page is reported; the words still arrive inside
  `untrusted_content`. On a rendered page the browser measures a named set of hiding techniques (SPEC section 9,
  2026-10-31); anything outside that set is a known limit.
- **It cannot protect you from an agent that runs as you.** Anything that can run commands as you can edit the store,
  the settings and the confirmation record. Tiresias records changes and shows them in replies; it cannot stop them.
- **A site's own echoed secrets are withheld on a best-effort basis.** When a form is sent, the site's answer may
  repeat a secret the site itself set for that one call (a hidden form value or a cookie). Tiresias tries not to see
  it: it checks the answer as received and its full extracted text before making previews or recording quotes.
  When it finds one (an original value of 6 characters or more, in any spelling its HTML,
  percent and JSON decoding covers) it withholds the whole answer rather than pass it on. An echo in an encoding it
  does not decode (base64, a hash, a value split up) is not caught; that is the site's own doing, and the secret is
  the site's, not yours (SPEC section 9, 2026-10-31).
- **It is not a virus checker.** File warnings name the kind of file; you can plug in your own scanner, and a clean
  verdict never makes Tiresias open a file.
- **It does not hide you from sites.** Private mode keeps no record of the visit on your machine (one exception: a
  Retry-After wait the site asks for is kept, by site, because obeying the site comes first); the site still sees
  the honest Tiresias user agent (and your signature, if you set signing up).
- **Safe Browsing is a list check** (plus Google Web Risk if you add a key). The list is refreshed daily and used
  up to seven days old; past that, or with no list at all, pages are read unchecked and replies say so. A new
  phishing site can be missed.
- **A program running as you can swap a store file between a check and its use** (Node has no `openat`). The store
  refuses links and checks folder identity before each step, which closes this to sites and MCP callers, not to you.
- **Windows is not supported.** It cannot read PDFs there (memory cannot be watched), and your own scanner and
  translator never start there.
- **The PDF child's network is not fenced by Node.** Node's permission model does not limit network use: the child
  is simply given no address and no code that fetches.

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
