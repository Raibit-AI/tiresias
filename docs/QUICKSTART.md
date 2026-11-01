# Tiresias quickstart

The short version of [README.md](../README.md): install, first read, connect an agent, and the few settings you may
want. Everything else (what each reply field means, limits, how fetching is kept safe) is in the README.

## 1. Install

Needs Node 22.13 or newer (`node --version`), on macOS or Linux. Windows is not supported yet.
A walkthrough with real output is in [DEMO.md](DEMO.md).

```sh
npm install -g @raibitsi/tiresias
tiresias --version
```

From source instead (to read or change the code):

```sh
git clone https://github.com/Raibit-AI/tiresias.git
cd tiresias
npm install --ignore-scripts
npm run build
```

and run it from that folder as `node dist/cli.js` (below, `tiresias` means either).

## 2. First read

```sh
tiresias read https://example.com --text          # a short summary: the outline, numbered
tiresias read https://example.com --section 1     # one section in full, with receipts (JSON)
tiresias read https://example.com --question "what is this domain for"   # the best quoted passages
```

- The first read of a site takes a few seconds (the phishing list download, about 11 MB once a day, and the checks
  for better doors such as `llms.txt`).
- Reading the same page again says `unchanged` and shows no outline: you already have it. Add `--page 1`, a
  `--section` or a `--question` to see it again.
- Give the whole address, with `https://`. Tiresias reads public sites only: `localhost` and your own network are
  refused on purpose, so a web page can never use it to reach your devices.
- Output is JSON; `--text` gives a short summary. Exit code 0 is done, 2 is "stopped on purpose" (a wall, a
  refusal, a flag), 1 is an error.

## 3. Connect your agent

Claude Code (`--scope user` makes it available in every folder):

```sh
claude mcp add --scope user tiresias -- tiresias mcp
claude mcp list                                     # tiresias: ... Connected
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.tiresias]
command = "tiresias"
args = ["mcp"]
```

From a source checkout, the command is `node /full/path/to/tiresias/dist/cli.js mcp` (for Claude Code, run
`claude mcp add --scope user tiresias -- node "$PWD/dist/cli.js" mcp` inside the tiresias folder).

The agent gets 18 tools (`read`, `doors`, `check`, `receipts`, ...). It cannot change any setting: settings are
yours, from the command line.

## 4. What you will use most

```sh
tiresias history --since 7d          # what was looked up, by which agent
tiresias log                         # today's log, as a readable page
tiresias receipts --url https://example.com
tiresias check https://example.com   # changed since last time?
tiresias handoffs                    # reads that stopped at a CAPTCHA or a login, waiting for you
tiresias settings                    # every setting, its value and default
```

## 5. Turning things on (each takes a confirmation phrase)

Risky settings stay off until you turn them on, and turning one on takes an exact phrase, so nothing is loosened by
accident. Without the phrase, the command changes nothing and prints it.

```sh
tiresias settings set rendering ask --confirm "YES, TURN ON RENDERING"    # JavaScript pages, in your installed Google Chrome
tiresias settings set saving ask --confirm "YES, TURN ON SAVING"          # signed snapshots: read --save
tiresias settings set anchoring on --confirm "YES, TURN ON ANCHORING"     # Bitcoin timestamps of receipts: tiresias anchor
```

Every change is recorded in history with who made it, and replies mention it for 24 hours.

## 6. Letting an agent send a form

Nothing is ever sent without a permission slip, and only you can grant one, at a terminal (it asks you to type
the site back):

```sh
tiresias slip grant --action submit_form --site https://example.com --path /contact --uses 1
tiresias form preview https://example.com/contact --form 1 --set name=Ann     # the exact request, nothing sent
tiresias form submit https://example.com/contact --form 1 --set name=Ann --preview <hash>
```

## 7. Upgrading from v0.8

If you had turned on saving, rendering or anchoring, they are held off until you confirm each once. The first reply
after the upgrade lists them with the exact command to type, for example:

```sh
tiresias settings confirm saving --confirm "YES, TURN ON SAVING"
```

`tiresias settings` shows anything still waiting. Your store, history and receipts need no change.

## 8. When something goes wrong

| You see | What it means |
|---|---|
| `Tiresias needs Node 22.13 or newer` | Install a current Node from nodejs.org (or your version manager) |
| `Refused: the address is private or internal` | Tiresias reads public sites only; `localhost` and your network are refused on purpose |
| `Not a valid URL` | Give the whole address, starting with `https://` |
| `robots.txt could not be fetched ... assumes the site says no` | The site did not answer, or you are offline |
| `Tiresias cannot write to its store folder` | Your home folder is not writable: set `TIRESIAS_HOME` to a folder you can write, or add `--private` |
| `render: unavailable` | Rendering is on but Google Chrome was not found: install it, or set `TIRESIAS_CHROME` to its program |
| `saved: not_allowed`, `render: not_allowed` | That setting is off, or waiting for your confirmation (`tiresias settings`) |
| `Unknown option` | `tiresias <command> --help` lists the options each command takes |
