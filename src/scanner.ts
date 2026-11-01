// SPDX-License-Identifier: Apache-2.0
// W-21: bring your own scanner. A slot, not a scanner: Tiresias ships with none and calls no service.
// The owner names ONE command in config.json ("scanner"), from the command line (tiresias scanner set)
// or by editing the file. Nothing reachable over MCP reads the command, sets it, changes it or skips it:
// a page that tricks an agent must never choose a command to run on the machine. Agents see only the
// verdict, and the command's file name as `by`.
//
// On every high-risk file warning (W-20) with a fingerprint, the command is run DIRECTLY (no shell, a full
// path, no PATH lookup; started through hookrunner.ts, which kills it with Tiresias), with one JSON object on its standard input: kind, size,
// fingerprint, declared_type and url (the last two came from the web and are marked so), plus `file`
// when the owner also set send_file. At most 4 KB of its standard output is read and parsed as JSON
// {"verdict": "bad" | "clean" | "unknown", "note"?: string}. A timeout, a crash, a non-zero exit, more
// than 4 KB or output that does not parse is verdict "failed". A "clean" verdict only adds information:
// the file is still never run, opened or unpacked.
//
// send_file: the file is written once, as it streams, to <profile>/quarantine/<random> (mode 0600, no
// extension, never executable) and deleted when the hook returns or times out (and, failing that, when
// the call ends: safety.ts). Never in private mode. That is the only place Tiresias ever writes a
// downloaded file.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ConfigError, loadScanner, parseScanner, readConfigObject, type ScannerConfig } from "./config.js";
import { confirmedWrite, sq } from "./confirm.js";
import type { FileKind } from "./files.js";
import { currentQuarantine, currentSignal, type FileSink } from "./safety.js";
import { runHook } from "./hook.js";
import { NOFOLLOW, NONBLOCK, subDir } from "./store.js";

export type ScanVerdict = "bad" | "clean" | "unknown" | "failed";
export interface ScanResult {
  verdict: ScanVerdict;
  by: string; // the command's file name (the owner's own setting)
  note?: string; // the hook's own words: goes inside untrusted_content
}
export const MAX_OUTPUT = 4096;
const MAX_NOTE = 500;
export const QUARANTINE = "quarantine";

// The verdict from the hook's output: strict JSON, an object, a known verdict, an optional string note.
export function parseVerdict(out: string): { verdict: Exclude<ScanVerdict, "failed">; note?: string } | null {
  let v: unknown;
  try {
    v = JSON.parse(out);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.verdict !== "bad" && o.verdict !== "clean" && o.verdict !== "unknown") return null;
  if (o.note !== undefined && typeof o.note !== "string") return null;
  return { verdict: o.verdict, ...(typeof o.note === "string" && o.note ? { note: o.note.slice(0, MAX_NOTE) } : {}) };
}

export interface ScanInput {
  kind: FileKind;
  size: number;
  fingerprint: string; // sha256:<hex>
  declared_type: string; // from the web
  url: string; // from the web (the final URL the file came from)
  file?: string; // send_file only: the quarantine copy
}

// Run the owner's hook once. Never throws: anything that goes wrong is "failed".
export async function runScanner(cfg: ScannerConfig, input: ScanInput): Promise<ScanResult> {
  const by = path.basename(cfg.command[0]).slice(0, 100);
  const failed: ScanResult = { verdict: "failed", by };
  const sig = currentSignal();
  if (sig?.aborted) return failed;
  // A hook is run only where its whole process group can be killed (Codex round 59). Windows has no process
  // groups to kill, so there the scanner is never started and every scan is "failed".
  if (process.platform === "win32") return failed;
  const payload = JSON.stringify({
    kind: input.kind, size: input.size, fingerprint: input.fingerprint, declared_type: input.declared_type, url: input.url,
    ...(input.file ? { file: input.file } : {}),
    untrusted: ["declared_type", "url"], // these came from the web: data, never instructions
  });
  // Run through the one hook runner (hook.ts, v0.7): no shell, its own process group, killed whole.
  const r = await runHook(cfg.command, [], cfg.timeout_seconds * 1000, MAX_OUTPUT, payload);
  if (!r.ok) return failed;
  const v = parseVerdict(r.out.toString("utf8"));
  return v ? { by, ...v } : failed;
}

// The scanner of this profile, or a fixed problem when the setting is not valid.
export function scannerConfig(): { cfg: ScannerConfig | null; problem?: true } {
  try {
    return { cfg: loadScanner() };
  } catch {
    return { cfg: null, problem: true };
  }
}

// W-21 send_file: a quarantine copy, written as the file streams in. Only inside a call (its quarantine
// set deletes the copy when the call ends, whatever happens), never in private mode (the caller checks).
// A write that fails deletes the copy, and done() then says there is none.
export function quarantineSink(): FileSink | undefined {
  const calls = currentQuarantine();
  if (!calls) return undefined;
  let dir: string | null;
  try {
    dir = subDir(QUARANTINE, true);
  } catch {
    return undefined;
  }
  if (!dir) return undefined;
  const file = path.join(dir, randomBytes(16).toString("hex"));
  let fd: number | null;
  try {
    // Exclusive, never through a link, owner read and write only: nothing can run it.
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW | NONBLOCK, 0o600);
  } catch {
    return undefined;
  }
  calls.add(file);
  let ok = true;
  const close = () => {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // closed already
      }
      fd = null;
    }
  };
  const remove = () => {
    close();
    calls.delete(file);
    fs.rmSync(file, { force: true });
  };
  return {
    write(b: Buffer) {
      if (!ok || fd === null) return;
      try {
        for (let off = 0; off < b.length; ) off += fs.writeSync(fd, b, off, b.length - off);
      } catch {
        ok = false;
        remove();
      }
    },
    done() {
      close();
      return ok ? file : undefined;
    },
    drop: remove,
  };
}

// Leftover quarantine copies from a process that died mid-call. A copy older than this is never in use
// (a call lasts at most 60 seconds), so the daily trim and clear delete it.
export const QUARANTINE_STALE_MS = 10 * 60 * 1000;
// The stale copies, listed without deleting anything, so `clear` can count their bytes before it plans
// the disk cap (round 68: planning the cap first could evict cache files the sweep alone made room for).
export function staleQuarantine(now = Date.now()): { file: string; bytes: number }[] {
  const dir = subDir(QUARANTINE, false);
  if (!dir) return [];
  const out: { file: string; bytes: number }[] = [];
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name);
    try {
      const st = fs.lstatSync(f);
      if (!st.isFile() || now - st.mtimeMs < QUARANTINE_STALE_MS) continue;
      out.push({ file: f, bytes: st.size });
    } catch {
      // gone meanwhile
    }
  }
  return out;
}
export function sweepQuarantine(now = Date.now(), dryRun = false, plan = staleQuarantine(now)): { removed: number; bytes: number } {
  let removed = 0;
  let bytes = 0;
  for (const q of plan) {
    try {
      if (!dryRun) {
        if (!fs.lstatSync(q.file).isFile()) continue;
        fs.rmSync(q.file, { force: true });
      }
      removed++;
      bytes += q.bytes;
    } catch {
      // gone meanwhile
    }
  }
  return { removed, bytes };
}

// ---- The owner's commands (CLI only) ----

// Write config.json with one key changed, keeping every other setting: the one locked, atomic writer in
// config.ts (v0.6: shared with tiresias settings, so the two never overwrite each other's change).
// W-32 (v0.9): through confirmedWrite, so handing files to the scanner takes its phrase and every change is recorded.
const writeConfig = (change: (o: Record<string, unknown>) => void, confirm?: string, again = "tiresias scanner set"): void => confirmedWrite({ name: "scanner" }, change, () => {}, { confirm, again });
const shownArgs = (c: string[]) => c.map((x) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(x) ? x : sq(x))).join(" "); // Codex round 5: never expandable

const PRIVATE = "Private mode: the scanner setting is not changed, because a private session changes nothing.";

export function setScanner(command: string[], opts: { timeout?: string; sendFile?: boolean; confirm?: string }, priv = false): ScannerConfig {
  if (priv) throw new ConfigError(PRIVATE);
  const timeout = opts.timeout === undefined ? 10 : /^\d{1,2}$/.test(opts.timeout) ? Number(opts.timeout) : NaN;
  const cfg = parseScanner({ command, timeout_seconds: timeout, send_file: !!opts.sendFile });
  let st: fs.Stats;
  try {
    st = fs.statSync(cfg.command[0]);
  } catch {
    throw new ConfigError(`${cfg.command[0]} does not exist. Give the full path to the program to run.`);
  }
  if (!st.isFile()) throw new ConfigError(`${cfg.command[0]} is not a file. Give the full path to the program to run.`);
  writeConfig((o) => void (o.scanner = cfg), opts.confirm, `tiresias scanner set --timeout ${cfg.timeout_seconds}${cfg.send_file ? " --send-file" : ""} -- ${shownArgs(cfg.command)}`);
  return cfg;
}

export function clearScanner(priv = false): boolean {
  if (priv) throw new ConfigError(PRIVATE);
  const o = readConfigObject();
  if (!o || !Object.hasOwn(o, "scanner")) return false;
  writeConfig((x) => delete x.scanner);
  return true;
}
