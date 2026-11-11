// SPDX-License-Identifier: Apache-2.0
import { actionPairs, cappedTarget } from "./getaction-cases.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderHtml, findChrome } from "../render.js";
import { freshHome, html, serve, text } from "./helper.js";

freshHome();
const needChrome = process.env.TIRESIAS_TEST_NO_CHROME === "1" ? "Chrome disabled for this test run" : findChrome() ? false : "Chrome is not installed";
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
test("6.1: a rendered script cannot fetch a GET form action", { skip: needChrome }, async () => {
  const s = await serve((req, res) => req.url === "/robots.txt" ? text(res, "", 404) : html(res, "<p>vote recorded</p>"));
  try {
    const r = await renderHtml(s.url + "/page", `<form method="get" action="/vote"><input name="choice" value="yes"></form><script>fetch('/vote?choice=yes').catch(() => {});</script>`);
    assert.equal(r.top.status, "rendered", JSON.stringify(r.top));
    assert.equal(s.count("/vote?choice=yes"), 0);
  } finally { await s.close(); }
});

test("6.1: intercepted rendered GET form actions never reach the network", async (t) => {
  const dns = (await import("node:dns/promises")).default;
  const https = (await import("node:https")).default;
  let outbound = 0;
  t.mock.method(dns, "lookup", async () => [{ address: "8.8.8.8", family: 4 }]);
  t.mock.method(https, "request", () => { outbound++; throw new Error("unexpected rendered request"); });
  const { Cdp } = await import("../cdp.js");
  const cp = (await import("node:child_process")).default;
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const send = Cdp.prototype.send, on = Cdp.prototype.on, spawn = cp.spawn;
  let event: (e: any) => void = () => {};
  let requestTarget: string;
  let liveActions: string[];
  let liveChecks = 0;
  const child = new EventEmitter() as any;
  child.stdio = [null, null, null, new PassThrough(), new PassThrough()];
  child.kill = () => (child.emit("exit", 0), true);
  cp.spawn = (() => child) as typeof cp.spawn;
  Cdp.prototype.on = function (fn: any) { event = fn; return () => {}; };
  Cdp.prototype.send = (async (method: string, params: any) => {
    if (method === "Target.createBrowserContext") return { browserContextId: "context" };
    if (method === "Target.createTarget") {
      event({ method: "Target.attachedToTarget", params: { sessionId: "page", targetInfo: { type: "page", targetId: "target" } } });
      return { targetId: "target" };
    }
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame" } } };
    if (method === "Page.navigate") {
      // The page's own document comes first, as in Chrome: load events count only after it is served.
      event({ method: "Fetch.requestPaused", sessionId: "page", params: { requestId: "doc", frameId: "frame", resourceType: "Document", request: { method: "GET", url: params.url } } });
      event({ method: "Fetch.requestPaused", sessionId: "page", params: { requestId: "action", frameId: "frame", resourceType: "Fetch", request: { method: "GET", url: requestTarget } } });
      event({ method: "Page.loadEventFired", sessionId: "page", params: {} });
    }
    if (method === "Runtime.evaluate" && params.expression.includes("get_form_actions")) {
      liveChecks++;
      return { result: { value: liveActions } };
    }
    if (method === "Runtime.evaluate") return { result: { value: { n: 1, h: "<p>done</p>" } } };
    return {};
  }) as typeof Cdp.prototype.send;
  const s = await serve((req, res) => req.url === "/robots.txt" ? text(res, "", 404) : html(res, "<p>vote recorded</p>"));
  try {
    requestTarget = s.url + "/vote?choice=yes";
    liveActions = [s.url + "/vote"];
    const r = await renderHtml(s.url + "/page", '<form method="get" action="/vote"><input name="choice"></form>');
    assert.equal(r.top.status, "rendered", JSON.stringify(r.top));
    assert.equal(s.count("/vote?choice=yes"), 0);
    const dynamic = await renderHtml(s.url + "/page", '<p>The script adds a GET form dynamically.</p>');
    assert.equal(dynamic.top.status, "rendered");
    assert.equal(s.count("/vote?choice=yes"), 0, "forms added by scripts are guarded too");
    for (const [action, target] of [...actionPairs, ["https://vote.example/vote", cappedTarget], ["https://vote.example/other", cappedTarget]].flatMap(([a, b]) => [[a, b], [b, a]])) {
      requestTarget = target;
      liveActions = []; // the static guard must stand on its own
      liveChecks = 0;
      const initial = await renderHtml(new URL("/page", action).href, `<form method=get action="${action}"><input name=choice></form>`);
      assert.equal(initial.top.status, "rendered", target);
      assert.equal(initial.top.blocked?.form_action, 1, target);
      assert.equal(initial.top.fetched, 0, target);
      assert.equal(outbound, 0, target);
      assert.equal(liveChecks, 0, "static actions are guarded before querying the DOM");
      liveActions = [action];
      const live = await renderHtml(new URL("/page", action).href, '<p>A form added by the script.</p>');
      assert.equal(live.top.status, "rendered", target);
      assert.equal(live.top.blocked?.form_action, 1, target);
      assert.equal(live.top.fetched, 0, target);
      assert.equal(outbound, 0, target);
      assert.ok(liveChecks > 0, "live DOM actions were checked");
    }
  } finally {
    await s.close(); Cdp.prototype.send = send; Cdp.prototype.on = on; cp.spawn = spawn;
  }
});
