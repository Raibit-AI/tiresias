// SPDX-License-Identifier: Apache-2.0
// W-10 (v0.7): optional rendering of pages that show nothing without JavaScript.
//
// Tiresias drives the Google Chrome already installed on the machine, directly, over the DevTools protocol on a
// pipe (cdp.ts). No package, no download of any browser, ever. If Chrome is not there, rendering is unavailable
// and the reply says how to enable it.
//
// The page's JavaScript is hostile. The boundary:
// - EVERY request the page makes is paused by Chrome and handed to Tiresias. Tiresias refuses it, or fetches it
//   itself with politeFetch (Safe Browsing, never_visit and hand_off, private addresses checked after DNS, ports,
//   robots.txt, Retry-After, spacing, signing) and hands the answer back. Chrome's own network stack never
//   reaches a site. The top-level page is not fetched twice: the render is fed the body the plain read fetched.
// - Anything interception cannot see (WebSocket, WebRTC, prefetch, Chrome's own background traffic) goes to a
//   proxy Tiresias runs on 127.0.0.1 that drops every connection, so it fails instead of reaching the network.
// - Chrome's own sandbox stays on (no --no-sandbox, ever). One browser per render, in a fresh temporary profile
//   folder deleted afterwards; no downloads, no service workers or other workers (they are attached paused and
//   never started), popups closed, dialogs dismissed, never a click, a key or a submit.
// - Hard caps: time, requests, bytes fetched, and the size of the rendered page. The whole process group is
//   killed on every way out (done, timeout, error, cancel, shutdown, Tiresias exiting); if Tiresias itself is
//   killed, the pipe closes and Chrome exits on its own.
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Cdp, CdpError, type CdpEvent } from "./cdp.js";
import { getActionTarget, getActionTargetsMatch } from "./getactions.js";
import { callContext } from "./context.js";
import { Busy, Slots } from "./slots.js";
import { ConfigError, TiresiasError, type FetchError } from "./errors.js";
import { runUntrusted } from "./sandbox.js";
import type { FullForm } from "./forms.js";
import { politeFetch } from "./fetcher.js";
import { shutdownSignal } from "./lifetime.js";
import { READ_SLACK, fetchCap } from "./safety.js";
import { envMayLoosen, inForceConfig } from "./confirm.js";
import { LIMITS as INSPECT, VIEWPORT, checkInspection, inspectScript, newMark, wallVerdict, type Overlay, type WallVerdict } from "./inspect.js";

// ---- the owner's setting ----

// "off" (the default): never. "ask": an agent may ask for it per read. "auto": also when a plain read is an empty
// JavaScript shell. Set in config.json ("rendering") or TIRESIAS_RENDERING (which wins). Never from MCP.
export type RenderMode = "off" | "ask" | "auto";
export const RENDER_MODES: RenderMode[] = ["off", "ask", "auto"];
export const DEFAULT_RENDER: RenderMode = "off";
export function parseRender(v: unknown): RenderMode {
  if (typeof v === "string" && (RENDER_MODES as string[]).includes(v.toLowerCase())) return v.toLowerCase() as RenderMode;
  throw new ConfigError('"rendering" must be "off", "ask" or "auto". Change it with: tiresias settings set rendering off|ask|auto');
}
// W-32 (v0.9): the variable wins only when it is not looser than the setting in force, or its phrase is in
// TIRESIAS_CONFIRM, or confirmations are off; otherwise it is ignored and replies say so (confirm.ts).
export function loadRenderMode(): RenderMode {
  const o = inForceConfig();
  const cfg = o && Object.hasOwn(o, "rendering") ? parseRender(o.rendering) : DEFAULT_RENDER;
  const env = process.env.TIRESIAS_RENDERING;
  if (env !== undefined && env.trim() !== "") {
    let mode: RenderMode;
    try {
      mode = parseRender(env.trim());
    } catch {
      throw new ConfigError('TIRESIAS_RENDERING must be "off", "ask" or "auto".');
    }
    const order = RENDER_MODES.indexOf(mode) - RENDER_MODES.indexOf(cfg);
    if (order <= 0 || envMayLoosen(mode === "auto" ? "YES, TURN ON AUTOMATIC RENDERING" : "YES, TURN ON RENDERING")) return mode;
  }
  return cfg;
}

// ---- what a reply says (fixed codes and counts only: top level) ----

export type BlockReason =
  | "form_action" | "not_get" | "not_needed" | "frame" | "navigation" | "worker" | "popup" | "scheme" | "request_cap" | "byte_cap"
  | "rules" | "wall" | "site_settings" | "unsafe_address" | "safe_browsing" | "file" | "too_large" | "fetch_failed" | "signing" | "error";
export const BLOCK_REASONS: BlockReason[] = [
  "form_action", "not_get", "not_needed", "frame", "navigation", "worker", "popup", "scheme", "request_cap", "byte_cap",
  "rules", "wall", "site_settings", "unsafe_address", "safe_browsing", "file", "too_large", "fetch_failed", "signing", "error",
];
export type RenderStatus = "rendered" | "cached" | "not_allowed" | "not_html" | "unavailable" | "failed";
export type RenderFailure = "timeout" | "page_busy" | "too_large" | "browser_failed" | "cancelled" | "navigated" | "busy"; // busy: v0.9, too many renders at once
export interface RenderTop {
  status: RenderStatus;
  reason?: RenderFailure; // when failed
  requests?: number; // requests the page asked for (the page itself not counted)
  fetched?: number; // of those, fetched by Tiresias under its rules and handed to the page
  blocked?: Partial<Record<BlockReason, number>>;
  dialogs?: number; // alert/confirm/prompt dialogs dismissed
  ms?: number;
  // v0.7 track 2: how the walls and the hidden text of a rendered page were decided (docs/v0.7/walls.md).
  walls?: "rendered" | "html";
  markers_uninspected?: number; // input/CAPTCHA candidate scan entries left by inspection limits
  hidden_text?: "rendered" | "partial" | "html";
  overlay?: Overlay;
}

export const RENDER_TEXT: Record<Exclude<RenderStatus, "rendered">, string> = {
  cached: "This copy was rendered (JavaScript run) when it was read; it is served as kept.",
  not_allowed: "Rendering was asked for, but the owner has not allowed it (setting \"rendering\" is off, or was turned on in config.json and not yet confirmed; tiresias settings shows which). This is the plain read. Only the owner can turn it on, from the command line with a confirmation: tiresias settings set rendering ask (the command prints the phrase it needs).",
  unavailable: "Rendering is allowed but unavailable: Google Chrome was not found on this machine. This is the plain read. To enable it, install Google Chrome (or set TIRESIAS_CHROME to its program path). Tiresias never downloads a browser.",
  not_html: "Rendering is only for HTML pages; this page was read as it is.",
  failed: "Rendering was tried and stopped; this is the plain read. Nothing from the rendering was kept.",
};
export const OVERLAY_TEXT = "A fixed layer covers at least half the viewport (often a consent or subscription prompt); it may be transparent. The page's text is returned as it is in the page.";
export const RENDERED_TEXT = "Rendered: Tiresias ran the page's JavaScript in a sandboxed, throwaway Chrome. Every request the page made went through Tiresias's own rules; what was refused is counted in render.blocked.";

// ---- limits ----

export const LIMITS = {
  ms: 20_000, // the whole render
  quietMs: 500, // no paused request or fetch for this long after loading finishes
  requests: 100,
  bytes: 10 * 1024 * 1024,
  perRequestBytes: 4 * 1024 * 1024, // what one request reserves from the budget (and may read at most)
  elements: 50_000,
  htmlBytes: 5 * 1024 * 1024,
  heapMb: 256,
};
// Under Node's test runner only, the suite may shorten the render's time limit.
const renderMs = (): number => {
  const v = Number(process.env.TIRESIAS_RENDER_MS);
  return process.env.NODE_TEST_CONTEXT && Number.isSafeInteger(v) && v > 0 ? v : LIMITS.ms;
};

// ---- finding Chrome ----

const CHROME_PATHS: Record<string, string[]> = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"],
  win32: [
    path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
    path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData\\Local"), "Google\\Chrome\\Application\\chrome.exe"),
  ],
};
const runnable = (p: string): boolean => {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (process.platform !== "win32") fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
// TIRESIAS_CHROME (a full path, set by the owner in the shell) wins; otherwise the usual places.
export function findChrome(): string | null {
  const own = process.env.TIRESIAS_CHROME;
  if (own !== undefined && own !== "") return path.isAbsolute(own) && runnable(own) ? own : null;
  return (CHROME_PATHS[process.platform] ?? []).find(runnable) ?? null;
}

// ---- the empty JavaScript shell test (auto mode) ----

// A page read as HTML whose text is almost nothing and that carries scripts.
export function looksLikeShell(textChars: number, body: string): boolean {
  return textChars < 200 && /<script\b/i.test(body);
}

// ---- process lifetime ----

const live = new Map<number, () => void>(); // every running Chrome's killer, by process id
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", timeout: 5000 });
    else process.kill(-pid, "SIGKILL"); // its own process group: Chrome and every helper it started
  } catch {
    // already gone
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
}
// Codex round 1 (HIGH): a helper Chrome starts in a new session or process group (on macOS, the crash reporter can)
// escapes the group kill. Every Chrome process of a render names its throwaway profile folder on its command line
// (the browser by --user-data-dir, helpers by it or by a path inside it), so whatever still names that folder is
// killed too. Returns how many such processes were still there.
export function killStrays(dataDir: string): number {
  if (process.platform === "win32") return 0; // taskkill /T already walks the whole tree there
  let out = "";
  try {
    out = execFileSync("ps", ["-A", "-ww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return 0;
  }
  let n = 0;
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || !m[2].includes(dataDir)) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    n++;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  return n;
}

let exitHook = false;
function hookExit(): void {
  if (exitHook) return;
  exitHook = true;
  process.on("exit", () => {
    for (const k of live.values()) k();
  });
}
export const liveBrowsers = (): number => live.size; // for tests

// Temporary profile folders: tiresias-render-<pid>-XXXXXX in the system temp folder. One left by a process that
// died (it could not clean up) is removed by the next render, only when it is a real folder (never a link), owned
// by this user, and its owning process is gone. Age alone never makes a suspended render abandoned.
const PREFIX = "tiresias-render-";
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};
export function sweepProfiles(): void {
  const tmp = os.tmpdir();
  let dir: fs.Dir;
  try {
    dir = fs.opendirSync(tmp);
  } catch {
    return;
  }
  try {
    let n = 0;
    for (let e = dir.readSync(); e && n < 10_000; e = dir.readSync(), n++) {
      const m = new RegExp(`^${PREFIX}(\\d+)-[A-Za-z0-9]+$`).exec(e.name);
      if (!m) continue;
      const p = path.join(tmp, e.name);
      try {
        const st = fs.lstatSync(p);
        if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) continue;
        // Older profiles recorded the pid only in their name. New ones also keep it inside the folder.
        const owner = path.join(p, "owner.pid");
        const pid = fs.existsSync(owner) ? Number(fs.readFileSync(owner, "utf8")) : Number(m[1]);
        if (!Number.isSafeInteger(pid) || pid <= 0) continue;
        if (!alive(pid)) fs.rmSync(p, { recursive: true, force: true });
      } catch {
        // not ours to touch, or already gone
      }
    }
  } finally {
    dir.closeSync();
  }
}

// ---- the dead proxy ----

async function deadProxy(): Promise<{ port: number; close: () => void }> {
  const server = net.createServer((s) => s.destroy());
  server.on("error", () => {});
  try {
    await new Promise<void>((r, j) => {
      server.once("error", j);
      server.listen(0, "127.0.0.1", () => r());
    });
  } catch (e) {
    server.close();
    throw e;
  }
  const port = (server.address() as net.AddressInfo).port;
  return { port, close: () => server.close() };
}

// ---- launching ----

export function chromeArgs(dataDir: string, proxyPort: number): string[] {
  return [
    "--headless",
    "--remote-debugging-pipe",
    "--no-startup-window",
    `--user-data-dir=${dataDir}`,
    `--proxy-server=http://127.0.0.1:${proxyPort}`,
    "--proxy-bypass-list=<-loopback>", // loopback goes to the dead proxy too
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--dns-prefetch-disable",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-pings",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-extensions",
    "--disable-default-apps",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
    "--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,AutofillServerCommunication,InterestFeedContentSuggestions,CertificateTransparencyComponentUpdater,NetworkPrediction",
    "--disable-gpu",
    "--mute-audio",
    "--password-store=basic",
    "--use-mock-keychain",
    `--js-flags=--max-old-space-size=${LIMITS.heapMb}`,
  ];
}

// The render's shared byte budget (Codex round 1). `reserve` waits while the budget is short and other requests are
// still running (they may give some back); it returns 0 only when nothing is running and nothing is left.
export class ByteBudget {
  private used = 0; // charged plus reserved
  private running = 0;
  private waiters = new Set<() => void>();
  constructor(readonly total: number, readonly perRequest: number) {}
  async reserve(signal: AbortSignal): Promise<number> {
    for (;;) {
      if (signal.aborted) return 0;
      const left = this.total - this.used;
      if (left >= this.perRequest || (this.running === 0 && left > 0)) {
        const r = Math.min(this.perRequest, left);
        this.used += r;
        this.running++;
        return r;
      }
      if (this.running === 0) return 0;
      await new Promise<void>((resolve) => {
        const done = () => (this.waiters.delete(done), signal.removeEventListener("abort", done), resolve());
        this.waiters.add(done);
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }
  // Exactly `bytes`, now or never (W-10: a robots.txt download made for a render; it never waits, since the request that
  // needs it already holds its own reservation).
  take(bytes: number): boolean {
    if (this.total - this.used < bytes) return false;
    this.used += bytes;
    this.running++;
    return true;
  }
  release(reserved: number, charged: number): void {
    this.used += charged - reserved; // a charge past its reservation (it cannot be, see READ_SLACK) still counts in full
    this.running--;
    for (const w of [...this.waiters]) w();
  }
  get spent(): number {
    return this.used;
  }
}

class Stop extends Error {
  top?: RenderTop; // what the render had counted when it stopped
  constructor(readonly reason: RenderFailure) {
    super(reason);
  }
}

export class RenderUnavailable extends Error {}

// What a render hands to its caller: a way to look at the settled page from an isolated world (the page's own
// scripts cannot see or change what runs there), used to take the HTML and, by later tracks, to ask what is visible.
export interface SettledPage {
  evaluate<T>(expression: string, timeoutMs?: number): Promise<T>;
}

const blockOf = (e: unknown): BlockReason => {
  if (!(e instanceof TiresiasError)) return "error";
  switch (e.kind) {
    case "refused":
      return e.constructor.name === "SiteRefused" ? "site_settings" : "rules";
    case "wall":
    case "payment":
      return "wall";
    case "safety":
      return "unsafe_address";
    case "flagged":
    case "safe_browsing":
      return "safe_browsing";
    case "signing":
      return "signing";
    case "fetch":
      return (e as FetchError).code === "too_large" ? "too_large" : (e as FetchError).code === "budget" ? "byte_cap" : "fetch_failed";
    default:
      return "error";
  }
};

const TYPES_FETCHED = new Set(["Script", "Stylesheet", "XHR", "Fetch"]);
const KEEP_HEADERS = new Set(["content-type", "access-control-allow-origin", "access-control-expose-headers"]);
const utf8Type = (ct: string | null): string => {
  if (!ct) return "application/octet-stream";
  const base = ct.split(";")[0].trim();
  return `${base}; charset=utf-8`;
};
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const noFragment = (u: string) => u.split("#")[0];

// Runs `fn` on the page `pageUrl` rendered from `body` (the HTML the plain read fetched). Throws RenderUnavailable
// when Chrome is not installed, Stop (as a RenderFailure) when a cap or the browser stopped it.
// v0.9 hardening (Codex round 4c, HIGH): at most RENDER_MAX browsers at once in this process, RENDER_QUEUE waiting
// (slots.ts); a render past both fails at once as `busy`, and the plain read stands.
export const RENDER_MAX = 2;
export const RENDER_QUEUE = 8;
const renderSlots = new Slots(RENDER_MAX, RENDER_QUEUE);

export async function withRenderedPage<T>(pageUrl: string, body: string, fn: (p: SettledPage) => Promise<T>): Promise<{ value: T; top: RenderTop }> {
  if (!findChrome()) throw new RenderUnavailable();
  let release: () => void;
  try {
    release = await renderSlots.take(callContext.getStore()?.signal);
  } catch (e) {
    const stop = new Stop(e instanceof Busy ? "busy" : "cancelled");
    stop.top = { status: "failed", reason: stop.reason };
    throw stop;
  }
  try {
    return await renderNow(pageUrl, body, fn);
  } finally {
    release();
  }
}

async function renderNow<T>(pageUrl: string, body: string, fn: (p: SettledPage) => Promise<T>): Promise<{ value: T; top: RenderTop }> {
  const chrome = findChrome();
  if (!chrome) throw new RenderUnavailable();
  const forms = await runUntrusted<{ forms: FullForm[]; omitted: number }>({ op: "forms", body, url: pageUrl }, body.length);
  const actions = forms.forms.filter((f) => f.method === "GET" && f.action).map((f) => getActionTarget(new URL(f.action!)));
  hookExit();
  sweepProfiles();
  const started = Date.now();
  const top: RenderTop = { status: "rendered", requests: 0, fetched: 0, blocked: {}, dialogs: 0 };
  const block = (r: BlockReason) => (top.blocked![r] = (top.blocked![r] ?? 0) + 1);
  const ctl = new AbortController();
  const outer = callContext.getStore()?.signal;
  const signals = [ctl.signal, shutdownSignal, ...(outer ? [outer] : [])];
  const signal = AbortSignal.any(signals);
  const timer = setTimeout(() => ctl.abort(new Stop("timeout")), renderMs());
  let navigationTimer: NodeJS.Timeout | undefined;
  let settleTimer: NodeJS.Timeout | undefined;
  let dataDir: string | undefined;
  let proxy: Awaited<ReturnType<typeof deadProxy>> | undefined;
  let child: ChildProcess | undefined;
  let exited: Promise<void> = Promise.resolve();
  try {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${PREFIX}${process.pid}-`));
    fs.writeFileSync(path.join(dataDir, "owner.pid"), String(process.pid), { flag: "wx", mode: 0o600 });
    proxy = await deadProxy();
    const profile = dataDir;
    child = spawn(chrome, chromeArgs(dataDir, proxy.port), {
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      detached: process.platform !== "win32", // its own process group, so the whole tree is killed at once
      // Nothing of Tiresias's environment (keys, settings) reaches the browser.
      env: { PATH: process.env.PATH ?? "", HOME: dataDir, TMPDIR: dataDir, ...(process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT ?? "" } : {}) },
    });
    const c = child;
    exited = new Promise<void>((r) => (c.once("exit", () => r()), c.once("error", () => r())));
    if (c.pid) live.set(c.pid, () => (killTree(c), killStrays(profile)));
    const spawnFailed = new Promise<never>((_, j) => c.once("error", () => j(new Stop("browser_failed"))));
    spawnFailed.catch(() => {});
    const cdp = new Cdp(c.stdio[3] as any, c.stdio[4] as any);
    const stopped = new Promise<never>((_, j) => {
      const fail = () => j(signal.reason instanceof Stop ? signal.reason : new Stop(shutdownSignal.aborted || outer?.aborted ? "cancelled" : "timeout"));
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
    stopped.catch(() => {});
    const race = <X>(p: Promise<X>): Promise<X> => Promise.race([p, stopped, spawnFailed]);
    const cmd = <X = any>(method: string, params: Record<string, unknown> = {}, session?: string) => race(cdp.send<X>(method, params, session));

    // Every target but our page (popups, service workers, shared workers, workers, out-of-process frames) is
    // attached PAUSED and never resumed; pages other than ours are closed.
    let pageTarget = "";
    let pageSession = "";
    let contextId = "";
    const early = new Map<string, string>(); // pages attached before createTarget answered: targetId -> sessionId
    let gotPage: (sid: string) => void = () => {};
    const mainFrame = { id: "" };
    let docServed = false;
    let pending = 0;
    let outstanding = 0; // bounded metadata for paused requests, including local replies and refusals
    let lastActivity = Date.now();
    let loaded = false;
    let domComplete = false;
    let refusedNavigation = false;
    const budget = new ByteBudget(LIMITS.bytes, Math.min(fetchCap(), LIMITS.perRequestBytes));

    const fetchFor = async (e: CdpEvent): Promise<void> => {
      const p = e.params;
      const id: string = p.requestId;
      // "Aborted", not "BlockedByClient": a refused navigation then leaves the page as it was instead of committing
      // Chrome's own error page in its place (which would be read as the page).
      const fail = (r: BlockReason) => (block(r), cmd("Fetch.failRequest", { requestId: id, errorReason: "Aborted" }, e.sessionId).catch(() => {}));
      const url: string = String(p.request?.url ?? "");
      const type: string = String(p.resourceType ?? "");
      const method: string = String(p.request?.method ?? "");
      // The page itself: served from the body the plain read already fetched, exactly once, in the main frame.
      if (type === "Document" && e.sessionId === pageSession && p.frameId === mainFrame.id && !docServed && noFragment(url) === noFragment(pageUrl)) {
        docServed = true;
        await cmd("Fetch.fulfillRequest", { requestId: id, responseCode: 200, responseHeaders: [{ name: "content-type", value: "text/html; charset=utf-8" }], body: b64(body) }, e.sessionId).catch(() => {});
        return;
      }
      top.requests!++;
      if (e.sessionId !== pageSession) return await fail("worker");
      if (type === "Document") {
        if (p.frameId !== mainFrame.id) return await fail("frame");
        if (!loaded) {
          // Chrome aborts the old document's load before this refusal, so its load event may never arrive.
          refusedNavigation = true;
          if (domComplete) {
            loaded = true;
            lastActivity = Date.now();
          } else if (!navigationTimer) {
            // Give parsing a chance to finish, but return the plain read promptly if it was aborted too.
            navigationTimer = setTimeout(() => {
              navigationTimer = undefined;
              if (!domComplete && !loaded) ctl.abort(new Stop("navigated"));
            }, LIMITS.quietMs);
          }
        }
        return await fail("navigation");
      }
      if (!/^https?:/i.test(url)) return await fail("scheme");
      if (type === "Preflight") {
        // A CORS check before a GET with extra headers. The page's own headers are never sent (Tiresias sends
        // its own), so it is answered here and the real request still goes through the rules.
        const want = String(p.request?.headers?.["Access-Control-Request-Method"] ?? p.request?.headers?.["access-control-request-method"] ?? "");
        if (want.toUpperCase() !== "GET") return await fail("not_get");
        const origin = String(p.request?.headers?.Origin ?? p.request?.headers?.origin ?? "*");
        const asked = String(p.request?.headers?.["Access-Control-Request-Headers"] ?? p.request?.headers?.["access-control-request-headers"] ?? "");
        await cmd("Fetch.fulfillRequest", {
          requestId: id, responseCode: 204,
          responseHeaders: [{ name: "access-control-allow-origin", value: origin.slice(0, 2048) }, { name: "access-control-allow-methods", value: "GET" }, ...(asked ? [{ name: "access-control-allow-headers", value: asked.slice(0, 2048) }] : [])],
        }, e.sessionId).catch(() => {});
        top.requests!--; // not a request to any site
        return;
      }
      if (method !== "GET") return await fail("not_get");
      const target = new URL(url);
      const actionTarget = getActionTarget(target);
      if (forms.omitted || actions.some((a) => getActionTargetsMatch(a, actionTarget))) return await fail("form_action");
      if (!TYPES_FETCHED.has(type)) return await fail("not_needed");
      // Check live forms too: scripts may have added a form or changed its action since the HTML arrived.
      try {
        const world = await cmd<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: mainFrame.id, worldName: "tiresias", grantUniveralAccess: false }, pageSession);
        const r = await cmd<{ result?: { value?: unknown } }>("Runtime.evaluate", {
          contextId: world.executionContextId, returnByValue: true, timeout: 1000,
          expression: `(() => { /* get_form_actions */
            const forms = Object.getOwnPropertyDescriptor(Document.prototype, 'forms').get.call(document);
            if (forms.length > 20) return null;
            const method = Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'method').get;
            const action = Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'action').get;
            const out = [];
            for (let i = 0; i < forms.length; i++) if (method.call(forms[i]).toLowerCase() === 'get') out.push(action.call(forms[i]));
            return out;
          })()`,
        }, pageSession);
        const live = r.result?.value;
        if (!Array.isArray(live) || live.length > 20 || live.some((a) => typeof a !== "string" || a.length > 8192)) return await fail("form_action");
        if (live.some((a: string) => { const u = new URL(a, pageUrl); return getActionTargetsMatch(getActionTarget(u), actionTarget); })) return await fail("form_action");
      } catch { return await fail("form_action"); }

      if (top.requests! > LIMITS.requests) return await fail("request_cap");
      pending++;
      // Codex round 1 (HIGH): the byte cap is a shared budget, RESERVED before a request starts (each request may read
      // at most what it reserved), so requests running at once can never together exceed it. What a request did not
      // use goes back when it ends; a file, a PDF or a failure is charged its whole reservation (bytes may have
      // arrived before it was refused).
      let reserved = 0;
      let charge = -1; // -1: charge the whole reservation
      try {
        reserved = await budget.reserve(signal);
        // The reservation bounds what the connection may receive (headers, 1xx, compressed bytes: safety.ts Wire), less
        // one socket read of slack, so the charge never passes it; the decoded body is held to it too.
        if (reserved <= READ_SLACK) return await fail("byte_cap");
        const res = await callContext.run({ ...callContext.getStore(), signal, renderBudget: budget }, () => politeFetch(url, { maxBytes: reserved, wireBytes: reserved - READ_SLACK, followRedirects: false }));
        // Chrome must see the redirect itself: module bases and cross-origin checks depend on every URL.
        // safeFetch validated the target (including https downgrades); the next paused request goes through
        // all of Tiresias's rules again, with its own request count and byte reservation.
        const location = res.headers.get("location");
        if ([301, 302, 303, 307, 308].includes(res.status) && location) {
          charge = res.size ?? reserved;
          const headers = [{ name: "location", value: new URL(location, res.url).href }];
          for (const [k, v] of res.headers) if (KEEP_HEADERS.has(k)) headers.push({ name: k, value: v.slice(0, 2048) });
          top.fetched!++;
          await cmd("Fetch.fulfillRequest", { requestId: id, responseCode: res.status, responseHeaders: headers, body: "" }, e.sessionId).catch(() => {});
          return;
        }
        // A file (a program, an archive, any binary the file plan names) or a PDF is never handed to the page: without a
        // read kind, the fetcher found a file in its first bytes.
        if (res.file || !res.read || res.read === "pdf") return await fail("file");
        const buf = Buffer.from(res.body, "utf8");
        // Charged what was really received (after decompression, before charset decoding: Codex round 2, a UTF-16
        // body shrinks when decoded) or what is handed to the page, whichever is larger; never less than it fetched.
        charge = Math.max(res.size ?? reserved, buf.length);
        if (charge > reserved) return await fail("byte_cap"); // re-encoding made it larger than what was reserved
        const headers: { name: string; value: string }[] = [];
        for (const [k, v] of res.headers) if (KEEP_HEADERS.has(k) && k !== "content-type") headers.push({ name: k, value: v.slice(0, 2048) });
        headers.push({ name: "content-type", value: utf8Type(res.headers.get("content-type")) });
        top.fetched!++;
        await cmd("Fetch.fulfillRequest", { requestId: id, responseCode: res.status || 200, responseHeaders: headers, body: buf.toString("base64") }, e.sessionId).catch(() => {});
      } catch (err) {
        await fail(signal.aborted ? "fetch_failed" : blockOf(err));
      } finally {
        if (reserved > 0) budget.release(reserved, charge < 0 ? reserved : charge);
        pending--;
        lastActivity = Date.now();
      }
    };

    cdp.on((e) => {
      if (signal.aborted) return;
      const p = e.params;
      if (e.method === "Target.attachedToTarget") {
        const t = p.targetInfo ?? {};
        const sid: string = p.sessionId;
        if (t.type === "page" && !pageSession) {
          if (!pageTarget) return void early.set(t.targetId, sid); // decided when createTarget answers
          if (t.targetId === pageTarget) return void gotPage(sid);
        }
        // Counted only when it is the page's own (Chrome's internal targets are paused and left uncounted).
        if (e.sessionId === pageSession || t.browserContextId === contextId) block(t.type === "page" ? "popup" : "worker");
        if (t.type === "page") cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
        // never resumed: it stays paused until the browser is killed
        return;
      }
      if (e.method === "Fetch.requestPaused") {
        lastActivity = Date.now();
        if (outstanding >= LIMITS.requests + 1) return ctl.abort(new Stop("too_large"));
        outstanding++;
        void fetchFor(e).catch(() => {
          ctl.abort(new Stop("browser_failed"));
        }).finally(() => {
          outstanding--;
          lastActivity = Date.now();
        });
        return;
      }
      if (e.method === "Page.javascriptDialogOpening" && e.sessionId === pageSession) {
        top.dialogs!++;
        cdp.send("Page.handleJavaScriptDialog", { accept: false }, pageSession).catch(() => {});
        return;
      }
      if (e.method === "Page.domContentEventFired" && e.sessionId === pageSession && docServed) {
        domComplete = true;
        if (refusedNavigation) {
          loaded = true;
          lastActivity = Date.now();
          clearTimeout(navigationTimer);
          navigationTimer = undefined;
        }
      }
      if (e.method === "Page.loadEventFired" && e.sessionId === pageSession && docServed) {
        loaded = true;
        lastActivity = Date.now();
        clearTimeout(navigationTimer);
        navigationTimer = undefined;
      }
    });

    // The browser, a throwaway context with downloads refused, and everything new attached paused.
    await cmd("Browser.getVersion");
    const { browserContextId } = await cmd<{ browserContextId: string }>("Target.createBrowserContext", { disposeOnDetach: true });
    contextId = browserContextId;
    await cmd("Browser.setDownloadBehavior", { behavior: "deny", browserContextId }).catch(() => {});
    await cmd("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const gotSession = new Promise<string>((r) => (gotPage = r));
    const { targetId } = await cmd<{ targetId: string }>("Target.createTarget", { url: "about:blank", browserContextId });
    pageTarget = targetId;
    for (const [tid] of early) {
      if (tid === targetId) continue;
      block("popup");
      cdp.send("Target.closeTarget", { targetId: tid }).catch(() => {});
    }
    pageSession = early.get(targetId) ?? (await race(gotSession));
    const s = pageSession;
    // Every request of the page is paused for Tiresias; its own workers and frames attach paused too.
    await cmd("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, s);
    await cmd("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, s);
    await cmd("Page.enable", {}, s);
    await cmd("Network.setBypassServiceWorker", { bypass: true }, s).catch(() => {});
    await cmd("Network.setCacheDisabled", { cacheDisabled: true }, s).catch(() => {});
    // Conveniences inside the page (the boundary is the interception and the dead proxy, not these).
    await cmd("Page.addScriptToEvaluateOnNewDocument", {
      source: "(()=>{try{window.open=()=>null;}catch(e){}try{Object.defineProperty(navigator,'serviceWorker',{get:()=>undefined});}catch(e){}for(const k of['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel']){try{delete window[k];}catch(e){}}})();",
    }, s);
    const tree = await cmd<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree", {}, s);
    mainFrame.id = tree.frameTree.frame.id;
    // A real screen's size (v0.7 track 2: what is visible, covered or off-screen is judged at this size).
    await cmd("Emulation.setDeviceMetricsOverride", { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false }, s).catch(() => {});
    await cmd("Runtime.runIfWaitingForDebugger", {}, s);
    await cmd("Page.navigate", { url: pageUrl }, s);

    // Settled: loading finished and every paused handler and fetch has finished, then quietMs elapsed.
    await race(new Promise<void>((resolve) => {
      const tick = () => {
        if (signal.aborted) return; // the race has already ended; stop polling
        if (loaded && pending === 0 && outstanding === 0 && Date.now() - lastActivity >= LIMITS.quietMs) return resolve();
        settleTimer = setTimeout(tick, 100);
      };
      tick();
    }));

    // Stop the page's scripts from starting anything new, then look from an isolated world.
    await cmd("Page.stopLoading", {}, s).catch(() => {});
    await cmd("Emulation.setScriptExecutionDisabled", { value: true }, s).catch(() => {});
    const world = await cmd<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: mainFrame.id, worldName: "tiresias", grantUniveralAccess: false }, s);
    const page: SettledPage = {
      evaluate: async <X>(expression: string, timeoutMs = 3_000): Promise<X> => {
        let busyTimer: NodeJS.Timeout;
        const busy = new Promise<never>((_, j) => (busyTimer = setTimeout(() => j(new Stop("page_busy")), timeoutMs)));
        busy.catch(() => {});
        try {
          const r = await Promise.race([
            cmd<{ result?: { value?: X }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, contextId: world.executionContextId, returnByValue: true, timeout: timeoutMs }, s),
            busy,
          ]);
          if (r.exceptionDetails) throw new Stop("browser_failed");
          return r.result?.value as X;
        } finally {
          clearTimeout(busyTimer!);
        }
      },
    };
    const value = await race(fn(page));
    top.ms = Date.now() - started;
    return { value, top };
  } catch (e) {
    const why = (): RenderFailure => (signal.aborted ? (signal.reason instanceof Stop ? signal.reason.reason : "cancelled") : "browser_failed");
    const stop = e instanceof Stop ? e : new Stop(e instanceof CdpError && e.code === "too_large" ? "too_large" : why());
    stop.top = { ...top, status: "failed", reason: stop.reason, ms: Date.now() - started };
    throw stop;
  } finally {
    clearTimeout(timer);
    clearTimeout(navigationTimer);
    clearTimeout(settleTimer);
    ctl.abort(new Stop("cancelled"));
    if (child) {
      killTree(child);
      if (child.pid) live.delete(child.pid);
      let exitTimer: NodeJS.Timeout;
      try {
        await Promise.race([exited, new Promise((r) => (exitTimer = setTimeout(r, 2_000)))]);
      } finally {
        clearTimeout(exitTimer!);
      }
    }
    // Anything that escaped the group, killed and waited for (at most 2 s) before its folder is deleted.
    if (dataDir) for (let i = 0; i < 20 && killStrays(dataDir) > 0; i++) await new Promise((r) => setTimeout(r, 100));
    proxy?.close();
    try {
      if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // swept by a later render
    }
  }
}

// The rendered HTML, within the caps. Counted and read from the isolated world, so the page's scripts cannot
// change what the count or the HTML return.
const takeHtml = (pageUrl: string) => `(() => {
  if (location.href.split('#')[0] !== ${JSON.stringify(noFragment(pageUrl))}) return { moved: true };
  // Named elements can override Document's built-ins even in the isolated world.
  const n = Document.prototype.getElementsByTagName.call(document, '*').length;
  if (n > ${LIMITS.elements}) return { n };
  const de = Object.getOwnPropertyDescriptor(Document.prototype, 'documentElement').get.call(document);
  const h = de ? de.outerHTML : '';
  return h.length > ${LIMITS.htmlBytes} ? { n, over: true } : { n, h };
})()`;

// What the inspection (inspect.ts) found, for the reader and the wall check: the mark's name, whether every hidden text
// node was marked, and the wall verdict (decided false: the HTML heuristics decide).
export interface RenderFindings {
  mark: string;
  hiddenComplete: boolean;
  verdict: WallVerdict;
  markersUninspected: number;
}
export type RenderResult = { ok: true; html: string; top: RenderTop; findings?: RenderFindings } | { ok: false; top: RenderTop };

// Renders a page and returns its HTML, or a fixed outcome. Never throws for a render problem: the caller keeps
// the plain read and says why. ONE render serves the HTML, the walls and the hidden text (v0.7 track 2): the inspection
// runs first, in the same isolated world with the page's scripts stopped, and marks what is hidden in the DOM the HTML
// is then taken from. An inspection that fails (an exception, a malformed answer) leaves the HTML heuristics to decide;
// one the page keeps busy stops the render like any busy page.
export async function renderHtml(pageUrl: string, body: string): Promise<RenderResult> {
  try {
    const { value, top } = await withRenderedPage(pageUrl, body, async (p) => {
      const mark = newMark();
      let findings: RenderFindings | undefined;
      try {
        const i = checkInspection(await p.evaluate<unknown>(inspectScript(mark), INSPECT.evaluateMs));
        if (i) findings = { mark, hiddenComplete: i.complete && i.clickThrough === 0, verdict: wallVerdict(i), markersUninspected: i.markersUninspected };
      } catch (e) {
        if (e instanceof Stop && e.reason === "page_busy") throw e;
        // an exception inside the page: no findings, the HTML heuristics decide
      }
      const r = await p.evaluate<{ n: number; h?: string; over?: true; moved?: true }>(takeHtml(pageUrl));
      if (r?.moved) throw new Stop("navigated"); // not the page asked for (a navigation got through, or an error page)
      if (!r || typeof r !== "object" || typeof r.h !== "string") throw new Stop("too_large");
      if (Buffer.byteLength(r.h, "utf8") > LIMITS.htmlBytes) throw new Stop("too_large");
      return { html: "<!doctype html>\n" + r.h, findings };
    });
    if (value.findings) {
      top.walls = value.findings.verdict.decided ? "rendered" : "html";
      if (value.findings.markersUninspected) top.markers_uninspected = value.findings.markersUninspected;
      top.hidden_text = value.findings.hiddenComplete ? "rendered" : "partial";
      if (value.findings.verdict.overlay) top.overlay = value.findings.verdict.overlay;
    } else {
      top.walls = "html";
      top.hidden_text = "html";
    }
    return { ok: true, html: value.html, top, findings: value.findings };
  } catch (e) {
    if (e instanceof RenderUnavailable) return { ok: false, top: { status: "unavailable" } };
    if (e instanceof Stop && e.top) return { ok: false, top: e.top };
    return { ok: false, top: { status: "failed", reason: e instanceof Stop ? e.reason : "browser_failed" } };
  }
}
