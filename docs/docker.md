# Running Tiresias in Docker (optional, for advanced users)

> **Not tested yet.** The steps below have not been run end to end by the Tiresias project: the maintainers'
> machine has no Docker runtime (decided 2026-11-01 for v1.1, after a scan of the free runtime came back not
> green). The image and limits follow Docker's documented behavior, but treat this guide as untested until this
> note is removed. Reports of what works and what doesn't are welcome as GitHub issues.

**Most people do not need this.** Tiresias already runs its MCP server under its own memory ceiling
(`TIRESIAS_MEMORY_MB`, default 1024 MB): if the AI app that starts it ever floods it, the server stops cleanly with a
message, the daily log says so, and the app can start it again.

Docker is for owners who want a hard box around Tiresias. Tiresias trusts the MCP client (the AI app that starts it)
not to flood its own server; a client that sends thousands of calls at once, or never reads the answers, can make
the server use a lot of memory before the ceiling stops it (see [SECURITY.md](../SECURITY.md), "Who is trusted").
Docker closes that gap: the container's limits cap memory, CPU and processes for everything together, the root file
system is read-only, and Tiresias runs as an unprivileged user with no extra Linux capabilities.

Nothing in Tiresias changes in a container: the same commands, the same store format (the volume holds exactly what
`~/.tiresias` holds), the same rules for every site.

## What you need

Docker (Docker Desktop on a Mac or Windows; Docker Engine on Linux). Docker Desktop is free for personal use and
small businesses; larger companies need a paid subscription (check Docker's terms). Tiresias does not install it.

## Build the image

From the repository folder:

```sh
docker build -t tiresias:1.0 .
```

The image is built from the official Node.js 22 image (Debian bookworm, slim), pinned by its digest in the
`Dockerfile`, so the base cannot change under you. Install scripts are off (`.npmrc`), as on your machine.

## Run it

```sh
docker run -i --rm --init \
  --memory 2g --memory-swap 2g --cpus 2 --pids-limit 256 \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  -v tiresias-store:/home/node/.tiresias \
  tiresias:1.0 mcp
```

What each part does:

| Option | Why |
|---|---|
| `-i` | Keeps standard input open: MCP talks over standard input and output. |
| `--rm` | Removes the container when the server stops (the store is on the volume, so nothing is lost). |
| `--init` | A tiny init process that passes signals on and cleans up finished child processes (PDF readers). |
| `--memory 2g --memory-swap 2g` | The hard memory cap for everything in the container, swap included. 2 GB leaves room for the server's 1024 MB heap ceiling, the page parsers and the PDF readers, which have their own caps. |
| `--cpus 2` | At most two CPU cores. |
| `--pids-limit 256` | At most 256 processes and threads (Tiresias uses well under 100). |
| `--read-only --tmpfs /tmp` | Nothing in the image can be changed; `/tmp` is a scratch space in memory. |
| `--cap-drop ALL --security-opt no-new-privileges` | No Linux capabilities, and nothing can gain more. |
| `-v tiresias-store:/home/node/.tiresias` | The store, on a named Docker volume, so history, receipts, keys and settings survive. |
| user `node` | Set in the image: Tiresias runs as an unprivileged user (uid 1000), never as root. |

Every other command works the same way; put it after the image name, with the same limits:

```sh
docker run -i --rm --init \
  --memory 2g --memory-swap 2g --cpus 2 --pids-limit 256 \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  -v tiresias-store:/home/node/.tiresias \
  tiresias:1.0 read https://example.com --text
```

(The built-in memory ceiling watches only `mcp`; for every command, the container's limits are the box.)

Commands that need a person at a terminal (`slip grant`, `slip revoke`) need `-t` too (`docker run -it ...`).
Environment variables go in with `-e`, for example `-e TIRESIAS_MEMORY_MB=1024` or `-e TIRESIAS_PROFILE=client-a`.

## Connect your AI app through Docker

Build the image once, then point the app at `docker run` instead of `node` or `npx`.

Claude Code:

```sh
claude mcp add tiresias -- docker run -i --rm --init --memory 2g --memory-swap 2g --cpus 2 --pids-limit 256 --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges -v tiresias-store:/home/node/.tiresias tiresias:1.0 mcp
```

Claude Desktop (`claude_desktop_config.json`; on a Mac, Claude menu, Settings, Developer, Edit Config):

```json
{
  "mcpServers": {
    "tiresias": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm", "--init",
        "--memory", "2g", "--memory-swap", "2g", "--cpus", "2", "--pids-limit", "256",
        "--read-only", "--tmpfs", "/tmp",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "-v", "tiresias-store:/home/node/.tiresias",
        "tiresias:1.0", "mcp"
      ]
    }
  }
}
```

Other apps take the same command and arguments.

## What is different in the container

- **Rendering is off.** No Chrome is installed in the image. Chrome's sandbox needs privileges a hardened container
  takes away, and Tiresias never runs Chrome without its sandbox (SPEC section 9), so loosening the container to fit
  Chrome would undo the point of it. A read that asks to render answers `render.status: "not_allowed"` while
  rendering is off (the default), and `"unavailable"` if you turn rendering on, as on any machine without Chrome. Everything else works: pages, PDFs, files, forms, receipts, signing, Safe Browsing.
- **The store is the volume.** To use your existing `~/.tiresias` instead, mount it:
  `-v "$HOME/.tiresias:/home/node/.tiresias"`. The folder must belong to uid 1000 inside the container (on Linux,
  `sudo chown -R 1000:1000 ~/.tiresias` or run with `--user "$(id -u):$(id -g)"`; Docker Desktop on a Mac maps
  ownership for you).
- **A Google Web Risk key** lives outside the store (`~/.config/tiresias/secrets.env`). Mount that folder read-only
  to use it: `-v "$HOME/.config/tiresias:/home/node/.config/tiresias:ro"`. Do not pass the key with `-e` on the
  command line: it would sit in your app's settings and in the process list.
- **Your own scanner and translator** (`scanner set`, `translator set`) run inside the container, so the program
  must be in the image. Build your own image `FROM tiresias:1.0` that adds it.
- **Private addresses are still refused.** The container's network is the internet as Docker gives it; Tiresias's
  address and port checks apply exactly as on your machine.
