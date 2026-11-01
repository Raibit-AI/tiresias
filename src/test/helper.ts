// SPDX-License-Identifier: Apache-2.0
// Test helpers: a throwaway store and a tiny local web server.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export interface Hit {
  path: string;
  headers: http.IncomingHttpHeaders;
}
export interface TestServer {
  url: string;
  hits: Hit[];
  count(p: string): number;
  close(): Promise<void>;
}

export function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-test-"));
  process.env.TIRESIAS_HOME = dir;
  // W-19: Safe Browsing would download the real list (and read the owner's Web Risk key file).
  // Tests use no real network, so it is off unless a test file turns it on (safebrowsing.test.ts).
  process.env.TIRESIAS_SAFE_BROWSING ??= "0";
  // W-32 (v0.9): turning Safe Browsing off by variable takes its phrase in TIRESIAS_CONFIRM.
  process.env.TIRESIAS_CONFIRM ??= "YES, TURN OFF SAFE BROWSING";
  // N-06 (v0.5.1): the default 1-second spacing per site would make the suite crawl; tests that check it
  // delete this. Honored only under Node's test runner.
  process.env.TIRESIAS_HOST_SPACING_MS ??= "0";
  // W-30 (v0.6): first reads check doors in the background by default; the older tests check door answers on
  // a first read, so they keep v0.5.1's "wait". Honored only under Node's test runner; settings.test.ts unsets it.
  process.env.TIRESIAS_DOORS_DEFAULT ??= "wait";
  return dir;
}

export async function serve(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<TestServer> {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    hits.push({ path: req.url ?? "", headers: req.headers });
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    count: (p) => hits.filter((h) => h.path === p).length,
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}

export const html = (res: http.ServerResponse, body: string, headers: Record<string, string> = {}, status = 200) => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
  res.end(body);
};
export const text = (res: http.ServerResponse, body: string, status = 200, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "text/plain", ...headers });
  res.end(body);
};

// History and receipts live in one file per day (plus a legacy single file from v0.1).
export function logText(home: string, group: "history" | "receipts"): string {
  let out = "";
  const legacy = path.join(home, group + ".jsonl");
  if (fs.existsSync(legacy)) out += fs.readFileSync(legacy, "utf8");
  const dir = path.join(home, group);
  if (fs.existsSync(dir)) for (const n of fs.readdirSync(dir).sort()) out += fs.readFileSync(path.join(dir, n), "utf8");
  return out;
}

// W-05 (v0.5.1): run the CLI the way a PERSON does, on a pseudo-terminal, typing `typed` when it asks.
// Uses python3's pty module (macOS and Linux). Standard output and error come back together, as a
// terminal shows them; `json` is the last line that is a JSON object.
const PTY = `
import os, pty, sys, select, time
typed = sys.argv[1].encode()
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[2], sys.argv[2:])
out = b""
sent = False
deadline = time.time() + 60
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.2)
    if fd in r:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
    if not sent and b"press Return: " in out:
        os.write(fd, typed + b"\\n")
        sent = True
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else (status >> 8))
`;
export function runAsPerson(cli: string, args: string[], typed: string, env: NodeJS.ProcessEnv = {}): Promise<{ out: string; code: number | null; json: any }> {
  return new Promise((resolve) => {
    const c = spawn("python3", ["-I", "-c", PTY, typed, process.execPath, cli, ...args], { env: { ...process.env, ...env } });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => {
      const lines = out.split(/\r?\n/);
      let json: any = null;
      for (let i = lines.length - 1; i >= 0 && json === null; i--) {
        if (!lines[i].trimStart().startsWith("{")) continue;
        try {
          json = JSON.parse(lines.slice(i).join("\n"));
        } catch {
          // not JSON from here
        }
      }
      resolve({ out, code, json });
    });
  });
}

// v0.5.1: an upper bound on how long something took. Shared CI machines are slow and noisy, so these
// bounds are checked locally and skipped on CI (CI=true); the behaviour around them is still tested.
export function timing(ok: boolean, message?: string): void {
  if (process.env.CI) return;
  if (!ok) throw new Error(`timing: ${message ?? "took too long"}`);
}

// W-32 (v0.9): tests that write risky settings into config.json by hand (as an owner editing the file would)
// first turn confirmations off for that store, so their values are in force as written.
export function neverAsk(home: string): void {
  fs.writeFileSync(path.join(home, "confirmations.json"), JSON.stringify({ v: 1, ask: false, confirmed: {}, recent: [] }), { mode: 0o600 });
}
