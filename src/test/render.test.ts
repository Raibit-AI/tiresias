// SPDX-License-Identifier: Apache-2.0
// W-10 (v0.7): JavaScript-only pages, rendered in the installed Google Chrome over a pipe.
// The tests that need Chrome are skipped (by name, with the reason) when it is not installed; the rest always run.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { freshHome, neverAsk, html, logText, serve, text } from "./helper.js";

const home = freshHome();
// W-32 (v0.9): this file writes risky settings by hand; confirmations are tested in confirm.test.ts.
neverAsk(home);
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
process.env.TIRESIAS_RENDER_MS = "8000";
// v0.9 rehearsal: the first render of a file starts Chrome cold (about 3.5 s alone, and past the shortened limit
// under a loaded machine: the recurring "W-10: a JavaScript page renders" flake). That first render runs under the
// real 20-second limit; this test checks what a render does, not how fast it starts. The shortened limit stays
// for the tests that wait for it to run out.
async function coldStart<T>(f: () => Promise<T>): Promise<T> {
  const short = process.env.TIRESIAS_RENDER_MS;
  process.env.TIRESIAS_RENDER_MS = "20000";
  try {
    return await f();
  } finally {
    process.env.TIRESIAS_RENDER_MS = short;
  }
}
delete process.env.TIRESIAS_RENDERING;
// Preserve an explicitly configured Chrome installation when deciding whether to skip.
const engine = await import("../engine.js");
const render = await import("../render.js");
const settings = await import("../settings.js");
const { runPrivate } = await import("../store.js");
const ctx = { agent: "render-test" };
// TIRESIAS_TEST_NO_CHROME=1 runs the suite as on a machine without Chrome (to check the skips).
const CHROME = process.env.TIRESIAS_TEST_NO_CHROME === "1" ? null : render.findChrome();
const needChrome = CHROME ? false : "Google Chrome is not installed: render-only test skipped";
const setMode = (m: string) => fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ rendering: m }));

const SHELL = `<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>`;
const hits: string[] = [];
// A raw listener for the page's WebSocket: any connection at all is counted.
let wsUpgrades = 0;
const wsServer = net.createServer((c) => (wsUpgrades++, c.destroy()));
await new Promise<void>((r) => wsServer.listen(0, "127.0.0.1", r));
const WS_PORT = (wsServer.address() as net.AddressInfo).port;
after(() => wsServer.close());
const s = await serve((req, res) => {
  hits.push(`${req.method} ${req.url}`);
  const u = req.url ?? "";
  if (u === "/robots.txt") return text(res, "User-agent: *\nDisallow: /secret\n");
  if (u === "/app" || u === "/app2") return html(res, SHELL.replace("/app.js", u === "/app" ? "/app.js" : "/app2.js"));
  if (u === "/app.js") {
    res.writeHead(200, { "content-type": "application/javascript" });
    return res.end(`fetch('/data.json').then(r => r.json()).then(d => {
      document.getElementById('root').innerHTML = '<main><h1>' + d.title + '</h1><p>' + d.body + '</p></main>';
    });`);
  }
  if (u === "/app2.js") {
    res.writeHead(200, { "content-type": "application/javascript" });
    return res.end(`document.getElementById('root').innerHTML = '<main><h1>Second app</h1><p>${"Rendered without asking because the owner chose auto. ".repeat(3)}</p></main>';`);
  }
  if (u === "/data.json") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ title: "Quarterly report", body: "Revenue grew by twelve percent across every region this quarter, the board said on Monday." }));
  }
  if (u === "/plain") return html(res, `<html><body><main><h1>Plain</h1><p>${"A page that needs no JavaScript at all to be read. ".repeat(6)}</p></main><script>1</script></body></html>`);
  if (u === "/hostile") {
    return html(res, `<html><body><main><h1>Hostile</h1><p id="p">${"Static words on a hostile page that tries many things. ".repeat(4)}</p></main><script>
      try { fetch('/secret/data'); } catch (e) {}
      try { fetch('/post', { method: 'POST', body: 'x' }); } catch (e) {}
      try { new WebSocket('ws://127.0.0.1:${WS_PORT}/ws'); } catch (e) {}
      try { window.open('/popup'); } catch (e) {}
      try { const f = document.createElement('iframe'); f.src = '/frame'; document.body.appendChild(f); } catch (e) {}
      try { new Image().src = '/img.png'; } catch (e) {}
      try { fetch('/file.exe'); } catch (e) {}
      try { navigator.serviceWorker && navigator.serviceWorker.register('/sw.js'); } catch (e) {}
      try { new Worker('/worker.js'); } catch (e) {}
      alert('hi'); confirm('ok?');
      setTimeout(() => { location.href = '/elsewhere'; }, 50);
    </script></body></html>`);
  }
  if (u === "/navigation-dom-complete") {
    // Insert the sheet from the script so it delays load without blocking the script or DOMContentLoaded.
    return html(res, `<html><head><title>Early navigation</title></head><body><main><p>${"Words from the fully parsed page remain available after its navigation is refused. ".repeat(4)}</p></main><script>
      document.head.insertAdjacentHTML('beforeend', '<link rel="stylesheet" href="/slow.css">');
      setTimeout(() => { location.href = '/elsewhere'; }, 50);
    </script></body></html>`);
  }
  if (u === "/slow.css") {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/css" });
      res.end("body { color: black; }");
    }, 1500);
    return;
  }
  if (u === "/navigation-head") {
    return html(res, `<html><head><script>location.href='/elsewhere'</script></head><body><main><p>${"Words after the head script are still available in the plain read. ".repeat(4)}</p></main></body></html>`);
  }
  if (u === "/file.exe") {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=x.exe" });
    return res.end(Buffer.from("MZ\x90\x00binary"));
  }
  if (u === "/loop") return html(res, `<html><body><p>${"Words before the loop starts. ".repeat(3)}</p><script>while (true) {}</script></body></html>`);
  if (u === "/huge") return html(res, `<html><body><p>start</p><script>for (let i = 0; i < 60000; i++) document.body.appendChild(document.createElement('div'));</script></body></html>`);
  if (u === "/wall") return html(res, `<html><body><div id="r"></div><script>document.getElementById('r').innerHTML = '<form><input type="password" name="pw"><button>Sign in</button></form>';</script></body></html>`);
  if (u === "/elsewhere" || u === "/secret/data" || u === "/popup" || u === "/frame" || u === "/post" || u === "/ws" || u === "/sw.js" || u === "/worker.js" || u === "/img.png") return text(res, "should never be asked for");
  text(res, "", 404);
});
after(() => s.close());

const uc = (r: any) => r.untrusted_content as any;
const allText = (r: any) => JSON.stringify(uc(r));
const ourChromes = (): number => {
  try {
    return execSync(`ps ax -o command`, { encoding: "utf8" }).split("\n").filter((l) => l.includes(`tiresias-render-${process.pid}-`)).length;
  } catch {
    return 0;
  }
};
const ourProfiles = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(`tiresias-render-${process.pid}-`));

test("7.13: a profile owned by a live process survives the sweep regardless of age", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-profile-sweep-"));
  const dir = fs.mkdtempSync(path.join(tmp, `tiresias-render-${process.pid}-`));
  t.mock.method(os, "tmpdir", () => tmp);
  try {
    fs.writeFileSync(path.join(dir, "owner.pid"), String(process.pid));
    const old = new Date(Date.now() - 7_200_000);
    fs.utimesSync(dir, old, old);
    render.sweepProfiles();
    assert.ok(fs.existsSync(dir));
    // Legacy profiles without an owner file are also protected by the pid in their name.
    fs.unlinkSync(path.join(dir, "owner.pid"));
    fs.utimesSync(dir, old, old);
    render.sweepProfiles();
    assert.ok(fs.existsSync(dir));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("7.13: an abandoned profile is swept once its recorded owner has exited", (t) => {
  const pid = 2147483647;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-profile-sweep-"));
  const dir = fs.mkdtempSync(path.join(tmp, `tiresias-render-${pid}-`));
  t.mock.method(os, "tmpdir", () => tmp);
  fs.writeFileSync(path.join(dir, "owner.pid"), String(pid));
  const kill = process.kill;
  // The sandbox may return EPERM even for a dead pid; model the OS's definitive ESRCH answer here.
  t.mock.method(process, "kill", (target: number, signal: number | NodeJS.Signals = "SIGTERM") => {
    if (target !== pid) return kill(target, signal);
    assert.equal(signal, 0);
    throw Object.assign(new Error("No such process"), { code: "ESRCH" });
  });
  try {
    render.sweepProfiles();
    assert.equal(fs.existsSync(dir), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("7.15: failed folder or proxy setup clears the deadline and removes any created profile", async (t) => {
  const chrome = process.env.TIRESIAS_CHROME;
  process.env.TIRESIAS_CHROME = process.execPath; // setup fails before any browser is spawned
  const originalTimeout = globalThis.setTimeout;
  const timers: NodeJS.Timeout[] = [];
  t.mock.method(globalThis, "setTimeout", (...args: Parameters<typeof setTimeout>) => {
    const timer = originalTimeout(...args);
    timers.push(timer);
    return timer;
  });
  const before = ourProfiles();
  try {
    const mkdir = t.mock.method(fs, "mkdtempSync", () => { throw new Error("folder setup failed"); });
    await assert.rejects(render.withRenderedPage(s.url, "", async () => 1));
    assert.ok(timers.length > 0);
    assert.ok(timers.every((timer: any) => timer._destroyed), "folder failure cleared its timer");
    mkdir.mock.restore();
    t.mock.method(net.Server.prototype, "listen", () => { throw new Error("proxy setup failed"); });
    await assert.rejects(render.withRenderedPage(s.url, "", async () => 1));
    assert.deepEqual(ourProfiles(), before, "proxy failure removed the new profile");
    assert.ok(timers.every((timer: any) => timer._destroyed), "proxy failure cleared its timer");
    assert.equal(render.liveBrowsers(), 0);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    t.mock.restoreAll();
    if (chrome === undefined) delete process.env.TIRESIAS_CHROME;
    else process.env.TIRESIAS_CHROME = chrome;
    for (const dir of ourProfiles()) if (!before.includes(dir)) fs.rmSync(path.join(os.tmpdir(), dir), { recursive: true, force: true });
  }
});

test("7.17: successful evaluations and browser exit clear their losing race timers", { skip: needChrome }, async (t) => {
  const originalTimeout = globalThis.setTimeout;
  const timers: NodeJS.Timeout[] = [];
  t.mock.method(globalThis, "setTimeout", (...args: Parameters<typeof setTimeout>) => {
    const timer = originalTimeout(...args);
    if (args[1] === 12345 || args[1] === 2000) timers.push(timer);
    return timer;
  });
  try {
    const out = await coldStart(() => render.withRenderedPage(s.url + "/timer", "<html><body>Hello</body></html>", (p) => p.evaluate<number>("1 + 1", 12345)));
    assert.equal(out.value, 2);
    assert.ok(timers.some((timer: any) => timer._idleTimeout === -1));
    assert.ok(timers.length >= 2, "evaluation and exit timers were both exercised");
    assert.ok(timers.every((timer: any) => timer._destroyed), "neither losing race leaves a live timer");
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
});

test("W-10 setting: off by default; ask and auto are owner-only (CLI settings), checked by name; TIRESIAS_RENDERING wins", () => {
  assert.equal(render.loadRenderMode(), "off");
  const set = settings.command(["set", "rendering", "ask"], false);
  assert.equal(set.code, 0, set.text);
  assert.equal(render.loadRenderMode(), "ask");
  assert.throws(() => settings.command(["set", "rendering", "always"], false), /"rendering" must be/);
  const row = (settings.view().settings as any[]).find((r) => r.name === "rendering");
  assert.equal(row.value, "ask");
  assert.ok((settings.view().environment as any[]).some((r) => r.name === "TIRESIAS_RENDERING"));
  assert.ok((settings.view().environment as any[]).some((r) => r.name === "TIRESIAS_CHROME"));
  process.env.TIRESIAS_RENDERING = "off";
  assert.equal(render.loadRenderMode(), "off");
  process.env.TIRESIAS_RENDERING = "sometimes";
  assert.throws(() => render.loadRenderMode(), /TIRESIAS_RENDERING/);
  delete process.env.TIRESIAS_RENDERING;
  settings.command(["reset", "rendering"], false);
  assert.equal(render.loadRenderMode(), "off");
});

test("W-10: a read that asks while rendering is off gets the plain read and render.status not_allowed; no browser starts", async () => {
  setMode("off");
  const r = await engine.read(s.url + "/app", { render: true }, ctx);
  assert.equal(r.status, "ok");
  assert.deepEqual(r.render, { status: "not_allowed" });
  assert.match(r.message ?? "", /owner has not allowed it/);
  assert.equal(render.liveBrowsers(), 0);
  assert.ok(!s.hits.some((h) => h.path === "/app.js"), "the page's script was never asked for");
});

test("W-10: rendering allowed but no Chrome: the plain read, render.status unavailable, and how to enable it", async () => {
  setMode("ask");
  const chrome = process.env.TIRESIAS_CHROME;
  process.env.TIRESIAS_CHROME = "/nonexistent/chrome";
  try {
    const r = await engine.read(s.url + "/app", { render: true, fresh: true }, ctx);
    assert.ok(r.status === "ok" || r.status === "unchanged", r.status);
    assert.deepEqual(r.render, { status: "unavailable" });
    assert.match(r.message ?? "", /install Google Chrome/);
    assert.match(r.message ?? "", /never downloads a browser/);
  } finally {
    if (chrome === undefined) delete process.env.TIRESIAS_CHROME;
    else process.env.TIRESIAS_CHROME = chrome;
  }
});

test("W-10: Chrome's own sandbox is never turned off, and the browser talks over a pipe, not a port", () => {
  const args = render.chromeArgs("/tmp/x", 1234);
  assert.ok(!args.some((a) => /no-sandbox|disable-setuid-sandbox|remote-debugging-port/.test(a)), args.join(" "));
  assert.ok(args.includes("--remote-debugging-pipe"));
  assert.ok(args.includes("--proxy-server=http://127.0.0.1:1234"));
  assert.ok(args.includes("--proxy-bypass-list=<-loopback>"));
});

test("W-10: a JavaScript page renders: its text read, quoted, cached as rendered, in history; the browser and its folder are gone", { skip: needChrome }, async () => {
  setMode("ask");
  s.hits.length = 0;
  const r = await coldStart(() => engine.read(s.url + "/app", { render: true, fresh: true }, ctx));
  assert.equal(r.status, "ok", r.message);
  assert.equal(r.render?.status, "rendered", JSON.stringify(r.render));
  assert.equal(r.render?.fetched, 2, JSON.stringify(r.render)); // app.js and data.json
  assert.match(allText(r), /Quarterly report/);
  assert.ok(uc(r).receipts.some((x: any) => /Quarterly report/.test(x.quote)), "receipts quote the rendered text");
  assert.equal(r.language?.code, "en");
  assert.match(r.message ?? "", /^Rendered|Rendered:/);
  // Every request the page made reached the site through Tiresias (its user agent), never Chrome's.
  for (const h of s.hits) assert.match(String(h.headers["user-agent"]), /^Tiresias\//, h.path);
  const q = await engine.read(s.url + "/app", { question: "revenue" }, ctx);
  assert.equal(q.render?.status, "cached");
  assert.ok(uc(q).passages.some((p: any) => /twelve percent/.test(p.text)));
  const cached = fs.readdirSync(path.join(home, "cache")).map((f) => fs.readFileSync(path.join(home, "cache", f), "utf8")).find((t) => t.includes("Quarterly report"));
  assert.ok(cached && JSON.parse(cached).rendered === true);
  assert.match(logText(home, "history"), /"rendered":true/);
  assert.equal(render.liveBrowsers(), 0);
  assert.equal(ourProfiles().length, 0, "the temporary profile folder was deleted");
  assert.equal(ourChromes(), 0, "no Chrome process is left");
});

test("W-10 auto: an empty JavaScript shell renders without being asked; a page with text does not", { skip: needChrome }, async () => {
  setMode("auto");
  const r = await engine.read(s.url + "/app2", {}, ctx);
  assert.equal(r.render?.status, "rendered", JSON.stringify(r));
  assert.match(allText(r), /Second app/);
  const p = await engine.read(s.url + "/plain", {}, ctx);
  assert.equal(p.render, undefined);
  setMode("ask");
  const a = await engine.read(s.url + "/plain", { fresh: true }, ctx);
  assert.equal(a.render, undefined, "ask never renders on its own");
});

test("W-10 hostile page: robots, POST, WebSocket, popups, frames, images, files, workers, navigation and dialogs are all refused", { skip: needChrome }, async () => {
  setMode("ask");
  s.hits.length = 0;
  const r = await engine.read(s.url + "/hostile", { render: true }, ctx);
  if (process.env.DEBUG_RENDER) console.log(JSON.stringify(r.render), JSON.stringify(s.hits.map((h) => h.path)));
  assert.equal(r.status, "ok", r.message);
  assert.equal(r.render?.status, "rendered", JSON.stringify(r.render));
  const b = r.render!.blocked!;
  assert.ok(b.rules! >= 1, "robots.txt says no to /secret: " + JSON.stringify(b));
  assert.ok(b.not_get! >= 1, JSON.stringify(b));
  assert.ok(b.not_needed! >= 1, JSON.stringify(b));
  assert.ok(b.file! >= 1, JSON.stringify(b));
  assert.ok(b.frame! >= 1, JSON.stringify(b));
  assert.ok(r.render!.dialogs! >= 1);
  assert.match(allText(r), /Static words on a hostile page/);
  for (const p of ["/secret/data", "/post", "/ws", "/popup", "/frame", "/img.png", "/sw.js", "/worker.js", "/elsewhere"])
    assert.ok(!s.hits.some((h) => h.path === p), `${p} reached the server: ${JSON.stringify(s.hits.map((h) => h.path))}`);
  assert.equal(wsUpgrades, 0);
  assert.equal(ourChromes(), 0);
});

test("navigation refused before the load event, DOM complete", { skip: needChrome }, async () => {
  setMode("ask");
  s.hits.length = 0;
  const r = await engine.read(s.url + "/navigation-dom-complete", { render: true }, ctx);
  assert.equal(r.status, "ok", r.message);
  assert.equal(r.render?.status, "rendered", JSON.stringify(r.render));
  assert.ok(r.render!.blocked!.navigation! >= 1, JSON.stringify(r.render));
  assert.ok(r.render!.ms! < 5000, JSON.stringify(r.render));
  assert.match(allText(r), /Words from the fully parsed page/);
  assert.ok(s.hits.some((h) => h.path === "/slow.css"), "the stylesheet was requested");
  assert.ok(!s.hits.some((h) => h.path === "/elsewhere"), "/elsewhere reached the server");
  assert.equal(ourChromes(), 0);
});

test("navigation in the head before the DOM is parsed", { skip: needChrome }, async () => {
  setMode("ask");
  s.hits.length = 0;
  const r = await engine.read(s.url + "/navigation-head", { render: true }, ctx);
  assert.equal(r.status, "ok", r.message);
  assert.match(allText(r), /Words after the head script/);
  assert.ok(!s.hits.some((h) => h.path === "/elsewhere"), "/elsewhere reached the server");
  assert.ok(r.render?.status === "rendered" || (r.render?.status === "failed" && r.render.reason === "navigated"), JSON.stringify(r.render));
  assert.notEqual(r.render!.reason, "timeout");
  assert.ok(r.render!.ms! < 5000, JSON.stringify(r.render));
  assert.ok(r.render!.blocked!.navigation! >= 1, JSON.stringify(r.render));
  assert.equal(ourChromes(), 0);
});

test("W-10: a request to a private address from the page is refused by the address rules (test allowance off)", { skip: needChrome }, async () => {
  const other = await serve((_req, res) => text(res, "internal"));
  delete process.env.TIRESIAS_ALLOW_PRIVATE;
  try {
    const page = `<html><body><p>${"Some words. ".repeat(30)}</p><script>fetch('${other.url}/internal')</script></body></html>`;
    const out = await render.renderHtml(s.url + "/given", page);
    assert.equal(out.ok, true, JSON.stringify(out.top));
    assert.ok(out.top.blocked!.unsafe_address! >= 1, JSON.stringify(out.top));
    assert.equal(other.hits.length, 0, "nothing reached the private address");
  } finally {
    process.env.TIRESIAS_ALLOW_PRIVATE = "1";
    await other.close();
  }
});

test("W-10: an endless loop and a huge DOM stop the render; the plain read is returned; nothing is left running", { skip: needChrome }, async () => {
  setMode("ask");
  const t0 = Date.now();
  const loop = await engine.read(s.url + "/loop", { render: true }, ctx);
  assert.equal(loop.status, "ok");
  assert.equal(loop.render?.status, "failed");
  assert.ok(loop.render?.reason === "page_busy" || loop.render?.reason === "timeout", JSON.stringify(loop.render));
  assert.match(allText(loop), /Words before the loop/);
  assert.ok(Date.now() - t0 < 30_000);
  const huge = await engine.read(s.url + "/huge", { render: true }, ctx);
  assert.equal(huge.render?.status, "failed");
  assert.equal(huge.render?.reason, "too_large", JSON.stringify(huge.render));
  assert.equal(render.liveBrowsers(), 0);
  assert.equal(ourChromes(), 0);
  assert.equal(ourProfiles().length, 0);
});

test("W-10: a wall that only appears once rendered is a wall", { skip: needChrome }, async () => {
  setMode("ask");
  const r = await engine.read(s.url + "/wall", { render: true }, ctx);
  assert.equal(r.status, "wall", JSON.stringify(r));
  assert.equal(r.render?.status, "rendered");
});

test("W-10 private mode: a rendered read keeps nothing", { skip: needChrome }, async () => {
  setMode("ask");
  const before = logText(home, "history");
  const r = await engine.read(s.url + "/app2", { render: true }, { ...ctx, private: true });
  assert.equal(r.private, true);
  assert.equal(r.render?.status, "rendered");
  assert.equal(logText(home, "history"), before);
  void runPrivate;
});

test("W-10: a cancelled call kills the browser at once", { skip: needChrome }, async () => {
  setMode("ask");
  const ac = new AbortController();
  const p = engine.read(s.url + "/loop", { render: true, fresh: true }, { ...ctx, signal: ac.signal });
  setTimeout(() => ac.abort(), 1500);
  const r = await p;
  assert.notEqual(r.render?.status, "rendered");
  assert.equal(render.liveBrowsers(), 0);
  assert.equal(ourChromes(), 0);
});

test("W-10 (Codex round 1): the byte budget is reserved before a request starts, so requests at once never exceed it", async () => {
  const b = new render.ByteBudget(10, 4);
  const sig = new AbortController().signal;
  const got = await Promise.all([b.reserve(sig), b.reserve(sig)]);
  assert.deepEqual(got, [4, 4]);
  let third = 0;
  const waiting = b.reserve(sig).then((r) => (third = r));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(third, 0, "the third waits: only 2 are left and two requests are running");
  b.release(4, 4); // the first used all it reserved
  b.release(4, 1); // the second gave 3 back
  await waiting;
  assert.equal(third, 4);
  assert.ok(b.spent <= 10);
  b.release(4, 4); // a file or a failure is charged in full
  assert.equal(b.spent, 9);
  assert.equal(await b.reserve(sig), 1, "nothing running: the last byte is reserved");
  b.release(1, 1);
  assert.equal(await b.reserve(sig), 0, "spent: no more requests");
});

test("W-10 (Codex round 1): a process that escaped the group but names the render's folder is killed", { skip: process.platform === "win32" && "no process groups on Windows" }, async (t) => {
  try {
    execSync("ps -A -o pid=", { stdio: "ignore" });
  } catch {
    t.skip("process inspection is unavailable in this sandbox");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tiresias-render-${process.pid}-`));
  const { spawn } = await import("node:child_process");
  const stray = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", `--database=${dir}/Crashpad`], { detached: true, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 300));
  const exited = new Promise((r) => stray.once("exit", r));
  try {
    assert.equal(render.killStrays(dir), 1);
    await exited;
    assert.equal(render.killStrays(dir), 0);
  } finally {
    stray.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("W-10 (Codex round 2): the byte budget charges what was received, not the smaller decoded text", { skip: needChrome }, async () => {
  setMode("ask");
  // Three UTF-16 answers of 3.5 MB each: about half as many bytes once decoded. Only two fit in the 10 MB budget.
  const big = Buffer.from("\ufeff" + JSON.stringify({ x: "a".repeat(1_750_000 - 20) }), "utf16le");
  const srv = await serve((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    if (req.url?.startsWith("/big")) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-16le" });
      return res.end(big);
    }
    html(res, `<html><body><p>${"Budget words. ".repeat(30)}</p><script>for (const n of [1, 2, 3]) fetch('/big' + n).catch(() => {});</script></body></html>`);
  });
  try {
    const out = await render.renderHtml(srv.url + "/", `<html><body><p>${"Budget words. ".repeat(30)}</p><script>for (const n of [1, 2, 3]) fetch('/big' + n).catch(() => {});</script></body></html>`);
    assert.equal(out.ok, true, JSON.stringify(out.top));
    assert.ok(big.length > 3_400_000);
    assert.equal(out.top.fetched, 2, JSON.stringify(out.top));
    assert.equal((out.top.blocked!.too_large ?? 0) + (out.top.blocked!.byte_cap ?? 0), 1, JSON.stringify(out.top));
  } finally {
    await srv.close();
  }
});

test("W-10 (Banks after Codex round 3): robots.txt fetched for a render is charged to its byte budget; a cached one costs nothing; over budget is refused and caches nothing", async () => {
  const { politeFetch } = await import("../fetcher.js");
  const { callContext } = await import("../context.js");
  const { getRobots } = await import("../rules.js");
  const ROBOTS = "User-agent: *\nDisallow: /secret\n# " + "x".repeat(100_000) + "\n";
  const srv = await serve((req, res) => {
    if (req.url === "/robots.txt") return text(res, ROBOTS);
    text(res, "y".repeat(1000));
  });
  try {
    const sig = new AbortController().signal;
    const run = <T>(b: InstanceType<typeof render.ByteBudget>, fn: () => Promise<T>) => callContext.run({ ...callContext.getStore(), signal: sig, renderBudget: b }, fn);
    // Too little left for a whole robots.txt (512 KB is taken before it is read): refused as over budget.
    const poor = new render.ByteBudget(400_000, 4_000_000);
    await assert.rejects(run(poor, () => politeFetch(srv.url + "/a")), (e: any) => e.code === "budget");
    assert.equal(srv.count("/robots.txt"), 0, "nothing was sent");
    assert.equal(srv.count("/a"), 0);
    // Nothing was cached for the site: an ordinary read later fetches robots.txt and is allowed.
    assert.equal((await getRobots(new URL(srv.url).origin)).mode, "parsed");
    assert.equal(srv.count("/robots.txt"), 1);
    // A fresh site, with budget: robots.txt is charged what was received (about 100 KB), then refunded the rest.
    const srv2 = await serve((req, res) => (req.url === "/robots.txt" ? text(res, ROBOTS) : text(res, "y".repeat(1000))));
    try {
      const b = new render.ByteBudget(10_000_000, 4_000_000);
      const r = await b.reserve(sig);
      await run(b, () => politeFetch(srv2.url + "/b", { maxBytes: r }));
      b.release(r, 1000);
      assert.equal(srv2.count("/robots.txt"), 1);
      assert.ok(b.spent >= ROBOTS.length + 1000 && b.spent < ROBOTS.length + 1000 + 1024, String(b.spent));
      // The same site again: robots.txt comes from the cache and costs nothing.
      const before = b.spent;
      const r2 = await b.reserve(sig);
      await run(b, () => politeFetch(srv2.url + "/c", { maxBytes: r2 }));
      b.release(r2, 1000);
      assert.equal(srv2.count("/robots.txt"), 1);
      assert.equal(b.spent - before, 1000);
    } finally {
      await srv2.close();
    }
  } finally {
    await srv.close();
  }
});

test("W-10 (Banks after Codex round 4): a Web Risk lookup made for a render is charged to its byte budget; over budget is refused as byte_cap, not unavailable; a cached verdict costs nothing", async () => {
  const sb = await import("../safebrowsing.js");
  const { callContext } = await import("../context.js");
  let asked = 0;
  const wr = await serve((_req, res) => {
    asked++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  process.env.TIRESIAS_WEB_RISK_ENDPOINT = wr.url + "/v1/uris:search";
  sb.clearWebRiskCache();
  try {
    const sig = new AbortController().signal;
    const run = <T>(b: InstanceType<typeof render.ByteBudget>, fn: () => Promise<T>) => callContext.run({ ...callContext.getStore(), signal: sig, renderBudget: b }, fn);
    const poor = new render.ByteBudget(50_000, 4_000_000);
    await assert.rejects(run(poor, () => sb.webRiskForTest("https://a.example/", "k", false, sig)), (e: any) => e.code === "budget");
    assert.equal(asked, 0, "nothing was sent to Google");
    const b = new render.ByteBudget(10_000_000, 4_000_000);
    const a = await run(b, () => sb.webRiskForTest("https://a.example/", "k", false, sig));
    assert.equal(a.state, "ok");
    assert.equal(asked, 1);
    const spent = b.spent;
    assert.ok(spent > 0 && spent < 20_000, String(spent)); // the answer and at most the header limit
    await run(b, () => sb.webRiskForTest("https://a.example/", "k", false, sig));
    assert.equal(asked, 1, "served from the verdict cache");
    assert.equal(b.spent, spent, "a cached verdict costs nothing");
  } finally {
    delete process.env.TIRESIAS_WEB_RISK_ENDPOINT;
    sb.clearWebRiskCache();
    await wr.close();
  }
});

test("v0.7 (Codex round 5): every request is capped and counted by the bytes its connection receives: 1xx floods and compressed bodies included", async () => {
  const { safeFetch } = await import("../safety.js");
  const zlib = await import("node:zlib");
  const crypto = await import("node:crypto");
  // A raw server: mode "info" sends informational responses forever before any answer; "gz" sends a gzip body.
  const noise = crypto.randomBytes(600_000);
  const gz = zlib.gzipSync(noise);
  let sentInfo = 0;
  const raw = net.createServer((c) => {
    c.once("data", (d) => {
      const path = /^GET (\S+)/.exec(d.toString())?.[1] ?? "";
      if (path === "/info") {
        const one = "HTTP/1.1 103 Early Hints\r\nLink: </x.css>; rel=preload\r\n" + "X-Pad: " + "p".repeat(8000) + "\r\n\r\n";
        const pump = () => {
          while (!c.destroyed && c.write(one)) sentInfo += one.length;
          if (!c.destroyed) c.once("drain", pump);
        };
        c.on("error", () => {});
        return pump();
      }
      c.on("error", () => {});
      c.end(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-encoding: gzip\r\ncontent-length: ${gz.length}\r\nconnection: close\r\n\r\n`), gz]));
    });
  });
  await new Promise<void>((r) => raw.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(raw.address() as net.AddressInfo).port}`;
  try {
    // 1xx responses are counted: the default cap (body cap plus 1 MB) stops the flood.
    await assert.rejects(safeFetch(base + "/info", { maxBytes: 100_000 }), (e: any) => e.code === "too_large");
    assert.ok(sentInfo < 50_000_000);
    // Compressed bytes are counted as received, before decompression.
    const ok = await safeFetch(base + "/gz", { maxBytes: 1_000_000 });
    assert.ok(ok.size! >= gz.length && ok.size! < gz.length + 2_000, String(ok.size));
    await assert.rejects(safeFetch(base + "/gz", { maxBytes: 1_000_000, wireBytes: 300_000 }), (e: any) => e.code === "too_large");
  } finally {
    raw.close();
  }
});

test("7.11: explicit renders reuse only a fresh rendered copy; revalidated checks and fresh checks re-render scripts and data", { skip: needChrome }, async () => {
  setMode("ask");
  let value = "Alpha report";
  const srv = await serve((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    if (req.url === "/data") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ value })); }
    if (req.url === "/script.js") { res.writeHead(200, { "content-type": "application/javascript" }); return res.end("fetch('/data').then(r => r.json()).then(d => document.querySelector('main').innerHTML = '<h1>' + d.value + '</h1><p>The report has the latest details for the public.</p>')"); }
    if (req.url === "/fresh" || req.url === "/stale") {
      const headers = { etag: '"shell"', ...(req.url === "/fresh" ? { "cache-control": "max-age=60" } : {}) };
      if (req.headers["if-none-match"]) { res.writeHead(304, headers); return res.end(); }
      return html(res, '<html><body><main></main><script src="/script.js"></script></body></html>', headers);
    }
    text(res, "", 404);
  });
  try {
    const first = await coldStart(() => engine.read(srv.url + "/fresh", { render: true }, ctx));
    assert.equal(first.render?.status, "rendered", JSON.stringify(first));
    const before = srv.count("/fresh");
    value = "Bravo report";
    const fresh = await engine.read(srv.url + "/fresh", { render: true, page: 1 }, ctx);
    assert.equal(fresh.render?.status, "cached");
    assert.equal(fresh.cache, "fresh");
    assert.match(allText(fresh), /Alpha report/);
    assert.equal(srv.count("/fresh"), before);
    const explicit = await engine.read(srv.url + "/fresh", { render: true, fresh: true }, ctx);
    assert.equal(explicit.render?.status, "rendered", JSON.stringify(explicit));
    assert.match(allText(explicit), /Bravo report/);
    const stale = await engine.read(srv.url + "/stale", { render: true }, ctx);
    assert.equal(stale.render?.status, "rendered", JSON.stringify(stale));
    value = "Charlie report";
    const rerender = await engine.read(srv.url + "/stale", { render: true }, ctx);
    assert.equal(rerender.render?.status, "rendered", JSON.stringify(rerender));
    assert.match(allText(rerender), /Charlie report/);
    for (const fresh of [false, true]) {
      value = fresh ? "Echo report" : "Delta report";
      const checked = await engine.check(srv.url + "/stale", ctx, { fresh });
      assert.equal(checked.render?.status, "rendered", JSON.stringify(checked));
      assert.ok((checked.counts?.added ?? 0) > 0, JSON.stringify(checked));
      assert.match(allText(checked), new RegExp(value));
    }
    assert.ok(srv.hits.filter((h) => ["/stale", "/fresh"].includes(h.path)).every((h) => !h.headers["if-none-match"]), "a required render never accepts a 304 shortcut");
  } finally {
    await srv.close();
  }
});

test("7.12: a failed rendered read or check returns plain content, preserves the last rendered baseline, and records no removals", { skip: needChrome }, async () => {
  setMode("ask");
  let fail = false;
  let title = "Original rendered report";
  const srv = await serve((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    html(res, `<html><body><main><h1>Plain fallback</h1><p>The page is loading its public report.</p></main><script>${fail ? "for (let i = 0; i < 60000; i++) document.body.appendChild(document.createElement('div'));" : `document.querySelector('main').innerHTML = '<h1>${title}</h1><p>The report is ready for the public to read.</p>'`}</script></body></html>`);
  });
  const { cachePath } = await import("../store.js");
  try {
    const first = await coldStart(() => engine.read(srv.url + "/page", { render: true }, ctx));
    assert.equal(first.render?.status, "rendered", JSON.stringify(first));
    const file = cachePath(srv.url + "/page");
    const kept = fs.readFileSync(file, "utf8");
    fail = true;
    for (const tool of ["read", "check"] as const) {
      const out = tool === "read"
        ? await engine.read(srv.url + "/page", { render: true, changes: true, fresh: true }, ctx)
        : await engine.check(srv.url + "/page", ctx, { fresh: true });
      assert.equal(out.render?.status, "failed", JSON.stringify(out));
      assert.match(allText(out), /Plain fallback/);
      assert.match(out.message!, /plain read/);
      assert.equal(out.counts?.removed, undefined);
      assert.equal(out.counts?.added, undefined);
      assert.equal(uc(out).changes, undefined);
      assert.equal(fs.readFileSync(file, "utf8"), kept, "a failed render must not replace the baseline");
    }
    fail = false;
    title = "Updated rendered report";
    const recovered = await engine.check(srv.url + "/page", ctx, { fresh: true });
    assert.equal(recovered.render?.status, "rendered", JSON.stringify(recovered));
    assert.match(allText(recovered), /Original rendered report/);
    assert.match(allText(recovered), /Updated rendered report/);
    assert.doesNotMatch(allText(recovered), /Plain fallback/);
  } finally {
    await srv.close();
  }
});

test("7.16: redirected modules resolve imports at the final URL, cross-origin redirects enforce CORS, and every hop obeys rules", { skip: needChrome }, async () => {
  const cross = await serve((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    res.writeHead(200, { "content-type": "application/javascript" });
    res.end("document.body.insertAdjacentHTML('beforeend', '<p>CORS bypassed</p>')");
  });
  const srv = await serve((req, res) => {
    if (req.url === "/robots.txt") return text(res, "User-agent: *\nDisallow: /secret\n");
    if (req.url === "/module.js") { res.writeHead(302, { location: "/modules/main.js" }); return res.end(); }
    if (req.url === "/modules/main.js") { res.writeHead(200, { "content-type": "application/javascript" }); return res.end("import './child.js';"); }
    if (req.url === "/modules/child.js") { res.writeHead(200, { "content-type": "application/javascript" }); return res.end("document.body.insertAdjacentHTML('beforeend', '<p>Correct module base</p>')"); }
    if (req.url === "/cross.js") { res.writeHead(302, { location: cross.url + "/cors.js" }); return res.end(); }
    if (req.url === "/blocked.js") { res.writeHead(302, { location: "/secret/script.js" }); return res.end(); }
    if (req.url === "/secret/script.js") { res.writeHead(200, { "content-type": "application/javascript" }); return res.end("document.body.insertAdjacentHTML('beforeend', '<p>Rules bypassed</p>')"); }
    text(res, "", 404);
  });
  try {
    const page = `<html><body><h1>Redirect checks</h1><script type="module" src="/module.js"></script><script type="module" src="/cross.js"></script><script src="/blocked.js"></script></body></html>`;
    const out = await coldStart(() => render.renderHtml(srv.url + "/page", page));
    assert.equal(out.ok, true, JSON.stringify(out.top));
    if (!out.ok) return;
    assert.match(out.html, /Correct module base/);
    assert.doesNotMatch(out.html, /CORS bypassed|Rules bypassed/);
    assert.equal(srv.count("/modules/child.js"), 1);
    assert.equal(srv.count("/child.js"), 0);
    assert.equal(cross.count("/cors.js"), 1, "Tiresias fetched the cross-origin hop, Chrome refused its missing CORS permission");
    assert.equal(srv.count("/secret/script.js"), 0);
    assert.ok(out.top.blocked!.rules! >= 1, JSON.stringify(out.top));
    for (const hit of [...srv.hits, ...cross.hits]) assert.match(String(hit.headers["user-agent"]), /^Tiresias\//);
  } finally {
    await srv.close();
    await cross.close();
  }
});

test("7.11 / 7.12 / 7.23: rendered cache shortcuts, failed setup, and current language are correct without a browser", async (t) => {
  setMode("ask");
  let language = "en";
  const srv = await serve((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    if (req.headers["if-none-match"]) { res.writeHead(304, { "content-language": language }); return res.end(); }
    html(res, '<html><body><h1>Plain fallback</h1><p>Zorbax flinter quolp drimble veskarn.</p></body></html>', { etag: '"unchanged"', "content-language": language });
  });
  const { cachePath, sha256 } = await import("../store.js");
  const { parsePage } = await import("../pipeline.js");
  const url = srv.url + "/cache";
  const chrome = process.env.TIRESIAS_CHROME;
  try {
    await engine.read(url, {}, ctx);
    const file = cachePath(url);
    const cache = JSON.parse(fs.readFileSync(file, "utf8"));
    const rendered = '<html><body><h1>Rendered baseline</h1><p>Zorbax flinter quolp drimble veskarn.</p></body></html>';
    cache.parsed = (await parsePage("html", rendered, undefined, url, [], false, "en")).parsed;
    cache.rendered = true;
    cache.render_inspection = { walls: "rendered", hidden_text: "rendered" }; // a current entry (7.9): older ones are read again
    cache.plain_hash = cache.hash;
    cache.render_hash = sha256(rendered);
    cache.hash = sha256(`${cache.plain_hash}|rendered:${cache.render_hash}`);
    cache.fresh_until = Date.now() + 60_000;
    fs.writeFileSync(file, JSON.stringify(cache));
    const kept = fs.readFileSync(file, "utf8");
    const before = srv.count("/cache");
    const fresh = await engine.read(url, { render: true, page: 1 }, ctx);
    assert.equal(fresh.render?.status, "cached");
    assert.equal(fresh.cache, "fresh");
    assert.match(allText(fresh), /Rendered baseline/);
    assert.equal(srv.count("/cache"), before);
    process.env.TIRESIAS_CHROME = process.execPath;
    t.mock.method(fs, "mkdtempSync", () => { throw new Error("render setup failure"); });
    for (const [tool, fresh] of [["read", true], ["check", true], ["check", false], ["read", false]] as const) {
      // Ordinary checks and explicit renders must also re-render when their copy is stale.
      if (!fresh) {
        cache.fresh_until = 0;
        fs.writeFileSync(file, JSON.stringify(cache));
      }
      const baseline = fresh ? kept : fs.readFileSync(file, "utf8");
      const out = tool === "read"
        ? await engine.read(url, { render: true, fresh, changes: true }, ctx)
        : await engine.check(url, ctx, { fresh });
      assert.equal(out.render?.status, "failed", JSON.stringify(out));
      assert.match(allText(out), /Plain fallback/);
      assert.match(out.message!, /plain read/);
      assert.equal(out.counts?.removed, undefined);
      assert.equal(out.counts?.added, undefined);
      assert.equal(fs.readFileSync(file, "utf8"), baseline);
      assert.equal(srv.hits.filter((h) => h.path === "/cache").at(-1)!.headers["if-none-match"], undefined);
    }
    language = "es";
    const revalidated = await engine.read(url, { page: 1 }, ctx);
    assert.equal(revalidated.cache, "revalidated");
    assert.equal(revalidated.language?.code, "es");
    assert.equal(uc(revalidated).declared_language, "es");
    // The identical-body reuse path also updates the rendered parse, without running Chrome.
    delete cache.etag;
    fs.writeFileSync(file, JSON.stringify(cache));
    language = "fr";
    const reused = await engine.read(url, { page: 1 }, ctx);
    assert.equal(reused.render?.status, "cached");
    assert.match(allText(reused), /Rendered baseline/);
    assert.equal(reused.language?.code, "fr");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).parsed.language.declared_text, "fr");
  } finally {
    t.mock.restoreAll();
    if (chrome === undefined) delete process.env.TIRESIAS_CHROME;
    else process.env.TIRESIAS_CHROME = chrome;
    await srv.close();
  }
});

test("7.16: manual subresource redirects return the hop without fetching its target; the next fetch still obeys robots", async () => {
  const { politeFetch } = await import("../fetcher.js");
  const srv = await serve((req, res) => {
    if (req.url === "/robots.txt") return text(res, "User-agent: *\nDisallow: /secret\n");
    if (req.url === "/start") { res.writeHead(302, { location: "/secret/script.js" }); return res.end(); }
    text(res, "should not be reached");
  });
  try {
    const hop = await politeFetch(srv.url + "/start", { followRedirects: false });
    assert.equal(hop.status, 302);
    assert.equal(hop.url, srv.url + "/start");
    assert.equal(hop.headers.get("location"), "/secret/script.js");
    assert.equal(hop.body, "");
    assert.ok(hop.size! > 0);
    assert.equal(srv.count("/secret/script.js"), 0);
    await assert.rejects(politeFetch(new URL(hop.headers.get("location")!, hop.url).href, { followRedirects: false }), /robots/);
    assert.equal(srv.count("/secret/script.js"), 0);
  } finally {
    await srv.close();
  }
});
