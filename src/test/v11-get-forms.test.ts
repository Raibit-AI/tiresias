// SPDX-License-Identifier: Apache-2.0
import { actionPairs, cappedTarget } from "./getaction-cases.js";
import assert from "node:assert/strict";
import vm from "node:vm";
import { extractFormActions, extractForms } from "../forms.js";
import { MAX_FORM_ACTIONS, MAX_FORM_ACTION_TARGETS, MAX_FORM_ACTION_CHARS, MAX_FORM_BASES, MAX_LIVE_ACTION, RenderActionCache } from "../renderactions.js";
import { parseDocument } from "../dom.js";
import { handle } from "../work.js";
import { test } from "node:test";
import { renderHtml, findChrome } from "../render.js";
import { freshHome, html, serve, text } from "./helper.js";

freshHome();
const needChrome = process.env.TIRESIAS_TEST_NO_CHROME === "1" ? "Chrome disabled for this test run" : findChrome() ? false : "Chrome is not installed";
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
const formsWithBase = (count: number, base: string) => `<base href="${base}">` +
  Array.from({ length: count }, (_, i) => `<form action="/form${i + 1}"></form>`).join("");

test("6.1: a rendered script cannot fetch a GET form action", { skip: needChrome }, async () => {
  const s = await serve((req, res) => req.url === "/robots.txt" ? text(res, "", 404) : html(res, "<p>vote recorded</p>"));
  try {
    const r = await renderHtml(s.url + "/page", `<form method="get" action="/vote"><input name="choice" value="yes"></form><script>fetch('/vote?choice=yes').catch(() => {});</script>`);
    assert.equal(r.top.status, "rendered", JSON.stringify(r.top));
    assert.equal(s.count("/vote?choice=yes"), 0);
  } finally { await s.close(); }
});

// Real browser: what the mocked checks below assert, seen end to end (Claude's review of the T.2 fix).
test("T.2, T.3, T.5: a real page with 25 forms and non-web actions gets its data; form 25 and a button's formaction stay refused", { skip: needChrome }, async () => {
  const s = await serve((req, res) => req.url === "/robots.txt" ? text(res, "", 404) : req.url === "/data.json" ? text(res, "loaded-by-script") : html(res, "<p>form target</p>"));
  try {
    const forms = Array.from({ length: 25 }, (_, i) => `<form action="/form${i + 1}"><input name="x"></form>`).join("");
    const body = `${forms}<form action="javascript:void(0)"></form><form action="mailto:someone@example.com"></form><form method="post" action="/post"><button formaction="/by-button" formmethod="get">Go</button></form><p id="out">waiting</p>` +
      `<script>fetch('/form25?x=1').catch(() => {}); fetch('/by-button?x=1').catch(() => {}); fetch('/data.json').then(r => r.text()).then(t => { document.getElementById('out').textContent = t; });</script>`;
    const r = await renderHtml(s.url + "/page", body);
    assert.equal(r.top.status, "rendered", JSON.stringify(r.top));
    assert.equal(s.count("/data.json"), 1, "an ordinary data request is fetched: " + JSON.stringify(r.top));
    assert.equal(s.count("/form25?x=1"), 0, "the action of form 25 is never requested");
    assert.equal(s.count("/by-button?x=1"), 0, "a button's formaction is never requested (T.5)");
    assert.ok((r.top.blocked?.form_action ?? 0) >= 2, JSON.stringify(r.top));
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
  let liveMethod = "get";
  let liveChecks = 0;
  let livePosts = 0;
  let liveThrows = false;
  let liveSubmitters: { tag: string; attrs: Record<string, string> }[] = [];
  let submitterActionReads = 0, submitterMethodReads = 0;
  let submitterThrows = false;
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
      if (liveThrows) throw new Error("unreadable live action");
      // Execute the actual page expression, including its total-form cap and native getters.
      class Node {
        get baseURI() { return s.url + '/page'; }
      }
      class Element extends Node {
        constructor(private tag: string, private attrs: Record<string, string> = {}) { super(); }
        get localName() { return this.tag; }
        get namespaceURI() { return 'http://www.w3.org/1999/xhtml'; }
        getAttribute(name: string) { return this.attrs[name] ?? null; }
      }
      class HTMLFormElement extends Element {
        constructor(private target: string, private verb: string) { super('form'); }
        get action() { return this.target; }
        get method() { return this.verb; }
      }
      const nativeAttr = Element.prototype.getAttribute;
      class HTMLButtonElement extends Element {
        get formAction() {
          submitterActionReads++;
          if (submitterThrows) throw new Error('unreadable submitter');
          return new URL(nativeAttr.call(this, 'formaction') || s.url + '/page', s.url + '/page').href;
        }
        get formMethod() { submitterMethodReads++; return nativeAttr.call(this, 'formmethod')?.toLowerCase() ?? ''; }
      }
      class HTMLInputElement extends Element {
        get formAction() { return Object.getOwnPropertyDescriptor(HTMLButtonElement.prototype, 'formAction')!.get!.call(this); }
        get formMethod() { return Object.getOwnPropertyDescriptor(HTMLButtonElement.prototype, 'formMethod')!.get!.call(this); }
      }
      class NodeList {
        constructor(private nodes: Element[]) {}
        get length() { return this.nodes.length; }
        item(i: number) { return this.nodes[i]; }
      }
      class HTMLCollection extends NodeList {
        get length() { return super.length; }
        item(i: number) { return super.item(i); }
      }
      class Document extends Node {
        get URL() { return s.url + '/page'; }
        get forms() { return new HTMLCollection([...liveActions.map(a => new HTMLFormElement(a, liveMethod)), ...Array.from({ length: livePosts }, () => new HTMLFormElement(s.url + '/post', 'post'))]); }
        querySelectorAll(selector: string) {
          assert.equal(selector, '[formaction], [formmethod]');
          return new NodeList(liveSubmitters.map(({ tag, attrs }) => {
            const C = tag === 'button' ? HTMLButtonElement : tag === 'input' ? HTMLInputElement : Element;
            const n = new C(tag, attrs);
            // Page-owned wrappers, including named form properties, must never be called.
            for (const key of ['getAttribute', 'formAction', 'formMethod', 'localName', 'namespaceURI', 'baseURI'])
              Object.defineProperty(n, key, { get() { throw new Error('page wrapper called: ' + key); } });
            return n;
          }));
        }
      }
      return { result: { value: vm.runInNewContext(params.expression, {
        Node, Element, NodeList, HTMLCollection, Document, HTMLFormElement, HTMLButtonElement, HTMLInputElement, URL, document: new Document(),
      }) } };
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
    const manyForms = (n: number) => Array.from({ length: n }, (_, i) => `<form action="/form${i + 1}"></form>`).join("");
    await t.test("T.2: 21 forms allow ordinary subrequests and guard form 21 in HTML and the live page", async () => {
      requestTarget = s.url + "/ordinary";
      liveActions = Array.from({ length: 21 }, (_, i) => s.url + `/form${i + 1}`);
      const allowed = await renderHtml(s.url + "/page", manyForms(21));
      assert.equal(allowed.top.status, "rendered");
      assert.equal(allowed.top.fetched, 1);
      assert.equal(s.count("/ordinary"), 1);
      assert.equal(allowed.top.blocked?.form_action ?? 0, 0);
      requestTarget = s.url + "/form21?choice=yes";
      liveActions = [];
      liveChecks = 0;
      const initial = await renderHtml(s.url + "/page", manyForms(21));
      assert.equal(initial.top.blocked?.form_action, 1);
      assert.equal(liveChecks, 0, "HTML check alone blocks form 21");
      liveActions = Array.from({ length: 21 }, (_, i) => s.url + `/form${i + 1}`);
      const live = await renderHtml(s.url + "/page", "<p>Dynamic forms.</p>");
      assert.equal(live.top.blocked?.form_action, 1);
      assert.ok(liveChecks > 0);
      assert.equal(s.count("/form21?choice=yes"), 0);
    });
    await t.test("T.6: 600 forms with a web base allow ordinary requests and guard form 600 at either address", async () => {
      const base = 'https://base.example/';
      const body = formsWithBase(600, base);
      liveActions = [];
      liveChecks = 0;
      for (const address of [s.url, new URL(base).origin]) {
        requestTarget = address + '/form600?choice=yes';
        const refused = await renderHtml(s.url + '/page', body);
        assert.equal(refused.top.status, 'rendered');
        assert.equal(refused.top.blocked?.form_action, 1);
        assert.equal(refused.top.fetched, 0);
      }
      assert.equal(liveChecks, 0, 'static targets alone guard both addresses');
      requestTarget = s.url + '/ordinary-based';
      const allowed = await renderHtml(s.url + '/page', body);
      assert.equal(allowed.top.status, 'rendered');
      assert.equal(allowed.top.fetched, 1);
      assert.equal(allowed.top.blocked?.form_action ?? 0, 0);
      assert.equal(s.count('/ordinary-based'), 1);
      assert.equal(s.count('/form600?choice=yes'), 0);
      assert.equal(outbound, 0, 'the base address never reaches the network');
    });
    await t.test("T.5: 21 forms and a submitter address allow ordinary requests and refuse the override", async () => {
      const body = manyForms(21) + '<button form="outside" formaction="/submitter">Send</button>';
      for (const initial of [true, false]) {
        liveActions = initial ? [] : Array.from({ length: 21 }, (_, i) => s.url + `/form${i + 1}`);
        liveSubmitters = initial ? [] : [{ tag: 'button', attrs: { form: 'outside', formaction: '/submitter' } }];
        requestTarget = s.url + '/ordinary-submitter';
        const allowed = await renderHtml(s.url + '/page', initial ? body : '<p>Dynamic submitter.</p>');
        assert.equal(allowed.top.fetched, 1, JSON.stringify(allowed.top));
        requestTarget = s.url + '/submitter?choice=yes';
        const refused = await renderHtml(s.url + '/page', initial ? body : '<p>Dynamic submitter.</p>');
        assert.equal(refused.top.blocked?.form_action, 1);
      }
      assert.ok(submitterActionReads > 0);
      assert.equal(s.count('/ordinary-submitter'), 2);
      assert.equal(s.count('/submitter?choice=yes'), 0);
      liveSubmitters = [];
    });
    await t.test("T.5: document-wide method overrides guard POST and dialog actions through native getters", async () => {
      requestTarget = s.url + '/post-method';
      for (const tag of ['button', 'input', 'div']) for (const method of ['get', '', 'PUT', ' post ']) {
        liveActions = [requestTarget];
        liveMethod = 'post';
        liveSubmitters = [{ tag, attrs: { formmethod: method } }];
        const r = await renderHtml(s.url + '/page', '<p>Dynamic method override.</p>');
        assert.equal(r.top.blocked?.form_action, 1, tag + ':' + method);
      }
      for (const method of ['post', 'dialog']) {
        liveMethod = method;
        liveSubmitters = [{ tag: 'button', attrs: { formmethod: 'PoSt' } }, { tag: 'input', attrs: { formmethod: 'DIALOG' } }];
        assert.equal((await renderHtml(s.url + '/page', '<p>No GET override.</p>')).top.fetched, 1);
        liveSubmitters = [{ tag: 'input', attrs: { formmethod: 'GET' } }];
        assert.equal((await renderHtml(s.url + '/page', '<p>GET override.</p>')).top.blocked?.form_action, 1);
      }
      liveActions = []; liveSubmitters = [];
      for (const method of ['post', 'dialog']) {
        const body = `<form method="${method}" action="/post-method"></form><input type="image" formmethod="get">`;
        assert.equal((await renderHtml(s.url + '/page', body)).top.blocked?.form_action, 1);
      }
      assert.ok(submitterMethodReads > 0);
      liveMethod = 'get'; liveActions = []; liveSubmitters = [];
    });
    await t.test("T.5: every formaction attribute counts, including input images and non-controls", async () => {
      requestTarget = s.url + '/all-submitters'; liveActions = [];
      for (const tag of ['button', 'input', 'div']) {
        liveSubmitters = [{ tag, attrs: { formaction: '/all-submitters', formmethod: 'post', type: 'image' } }];
        assert.equal((await renderHtml(s.url + '/page', '<p>Dynamic overrides.</p>')).top.blocked?.form_action, 1);
      }
      requestTarget = s.url + '/submitter-cap';
      liveSubmitters = Array.from({ length: MAX_FORM_ACTIONS }, () => ({ tag: 'button', attrs: { formaction: '/submit' } }));
      assert.equal((await renderHtml(s.url + '/page', '<p>At cap.</p>')).top.fetched, 1);
      livePosts = 1;
      assert.equal((await renderHtml(s.url + '/page', '<p>Combined cap.</p>')).top.blocked?.form_action, 1);
      livePosts = 0;
      const long = s.url + '/' + 'x'.repeat(MAX_LIVE_ACTION - s.url.length - 1);
      liveSubmitters = Array.from({ length: MAX_FORM_ACTION_CHARS / MAX_LIVE_ACTION }, () => ({ tag: 'input', attrs: { formaction: long } }));
      assert.equal((await renderHtml(s.url + '/page', '<p>At char cap.</p>')).top.fetched, 1);
      liveSubmitters.push({ tag: 'button', attrs: { formaction: '/extra' } });
      assert.equal((await renderHtml(s.url + '/page', '<p>Past char cap.</p>')).top.blocked?.form_action, 1);
      for (const a of ['x'.repeat(MAX_LIVE_ACTION + 1), 'http://[invalid', 'https://user:secret@site.example/', 'custom://user:secret@host/', '/a\0b']) {
        liveSubmitters = [{ tag: 'button', attrs: { formaction: a } }];
        assert.equal((await renderHtml(s.url + '/page', '<p>Unsafe override.</p>')).top.blocked?.form_action, 1);
      }
      liveSubmitters = [{ tag: 'button', attrs: { formaction: '/submit' } }];
      submitterThrows = true;
      assert.equal((await renderHtml(s.url + '/page', '<p>Unreadable native getter.</p>')).top.blocked?.form_action, 1);
      submitterThrows = false;
      liveSubmitters = [];
    });
    await t.test("T.2: the cap accepts 1000 forms and refuses everything past it in HTML and the live page", async () => {
      requestTarget = s.url + "/at-cap";
      liveActions = [];
      livePosts = MAX_FORM_ACTIONS;
      const allowed = await renderHtml(s.url + "/page", manyForms(MAX_FORM_ACTIONS));
      assert.equal(allowed.top.fetched, 1);
      liveActions = Array.from({ length: MAX_FORM_ACTIONS + 1 }, (_, i) => s.url + `/live${i + 1}`);
      livePosts = 0;
      const liveGet = await renderHtml(s.url + "/page", "<p>Dynamic GET forms.</p>");
      assert.equal(liveGet.top.blocked?.form_action, 1);
      assert.equal(liveGet.top.fetched, 0);
      liveActions = [];
      livePosts = MAX_FORM_ACTIONS;
      livePosts++;
      const live = await renderHtml(s.url + "/page", "<p>Dynamic POST forms count too.</p>");
      assert.equal(live.top.blocked?.form_action, 1);
      livePosts = 0;
      liveChecks = 0;
      const initial = await renderHtml(s.url + "/page", manyForms(MAX_FORM_ACTIONS + 1));
      assert.equal(initial.top.blocked?.form_action, 1);
      assert.equal(liveChecks, 0);
      assert.equal(s.count("/at-cap"), 1);
    });
    await t.test("T.2: unreadable and oversized live actions still fail closed", async () => {
      requestTarget = s.url + "/unreadable";
      for (const action of ["x".repeat(8193), "javascript:" + "x".repeat(8193), "http://[invalid", "relative", "https://owner:secret@forms.example/vote", "custom://owner:secret@host/path", "throws"]) {
        liveActions = [action];
        liveThrows = action === "throws";
        const r = await renderHtml(s.url + "/page", "<p>Dynamic form.</p>");
        assert.equal(r.top.blocked?.form_action, 1);
        assert.equal(r.top.fetched, 0);
      }
      liveThrows = false;
      assert.equal(s.count("/unreadable"), 0);
    });
    await t.test("T.3: non-web actions allow ordinary requests and keep the real GET target guarded", async () => {
      const nonWeb = ["javascript:void(0)", "mailto:owner@example.com", "data:text/plain,x", "about:blank"];
      const body = [...nonWeb, "/real-get"].map(a => `<form action="${a}"></form>`).join("");
      for (const initial of [true, false]) {
        liveActions = initial ? [] : [...nonWeb, s.url + "/real-get"];
        requestTarget = s.url + "/ordinary-non-web";
        const allowed = await renderHtml(s.url + "/page", initial ? body : "<p>Dynamic forms.</p>");
        assert.equal(allowed.top.fetched, 1);
        assert.equal(allowed.top.blocked?.form_action ?? 0, 0);
        requestTarget = s.url + "/real-get?choice=yes";
        const refused = await renderHtml(s.url + "/page", initial ? body : "<p>Dynamic forms.</p>");
        assert.equal(refused.top.blocked?.form_action, 1);
        assert.equal(refused.top.fetched, 0);
      }
      assert.equal(s.count("/ordinary-non-web"), 2);
      assert.equal(s.count("/real-get?choice=yes"), 0);
    });
    await t.test("T.2: unknown methods are GET only for the render guard", async () => {
      requestTarget = s.url + "/unknown-method";
      liveActions = [];
      const body = '<form method="put" action="/unknown-method"></form>';
      const initial = await renderHtml(s.url + "/page", body);
      assert.equal(initial.top.blocked?.form_action, 1);
      assert.equal(extractForms(parseDocument(body).doc, s.url).forms[0].not_allowed, "bad_method");
      liveMethod = "put";
      liveActions = [requestTarget];
      const live = await renderHtml(s.url + "/page", "<p>Dynamic form.</p>");
      assert.equal(live.top.blocked?.form_action, 1);
      for (const method of ["post", "dialog"]) {
        liveMethod = method;
        const allowed = await renderHtml(s.url + "/page", `<form method="${method}" action="/unknown-method"></form>`);
        assert.equal(allowed.top.fetched, 1);
      }
      liveMethod = "get";
      assert.equal(s.count("/unknown-method"), 2);
    });
    await t.test("T.2: the character budget allows 1000 shop forms and fails closed past the limit", async () => {
      requestTarget = s.url + "/budget-request";
      const short = s.url + "/cart/add";
      liveActions = Array(MAX_FORM_ACTIONS).fill(short);
      const shop = `<form action="${short}"></form>`.repeat(MAX_FORM_ACTIONS);
      assert.equal((await renderHtml(s.url + "/page", shop)).top.fetched, 1);
      const liveLong = s.url + "/" + "a".repeat(MAX_LIVE_ACTION - s.url.length - 1);
      liveActions = Array(MAX_FORM_ACTION_CHARS / MAX_LIVE_ACTION).fill(liveLong);
      assert.equal((await renderHtml(s.url + "/page", "<p>At budget.</p>")).top.fetched, 1);
      liveActions.push(short);
      const live = await renderHtml(s.url + "/page", "<p>Past budget.</p>");
      assert.equal(live.top.blocked?.form_action, 1);
      liveActions = [];
      const staticLong = s.url + "/" + "a".repeat(2048 - s.url.length - 1);
      const atBudget = `<form action="${staticLong}"></form>`.repeat(MAX_FORM_ACTION_CHARS / 2048);
      assert.equal((await renderHtml(s.url + "/page", atBudget)).top.fetched, 1);
      const initial = await renderHtml(s.url + "/page", atBudget + '<form action="/extra"></form>');
      assert.equal(initial.top.blocked?.form_action, 1);
      assert.equal(s.count("/budget-request"), 3);
    });
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

test("T.2: action-only scans union page and base targets without changing the 20-form listing", () => {
  const page = "https://forms.example/page?original=yes";
  const body = '<base href="https://base.example/dir/">' +
    '<form><button formaction="/ignored">Send</button></form><form action=""></form>' +
    '<form action="next#fragment"></form><form method="post" action="/post"></form>' +
    Array.from({ length: 18 }, (_, i) => `<form action="/extra${i}"></form>`).join("");
  const doc = parseDocument(body).doc;
  const listing = extractForms(doc, page);
  const scan = extractFormActions(doc, page);
  assert.equal(listing.forms.length, 20);
  assert.equal(listing.omitted, 2);
  assert.equal(scan.incomplete, false);
  assert.deepEqual(listing.forms.slice(0, 4).map(f => f.action), [page, page, "https://base.example/dir/next", "https://base.example/post"]);
  assert.deepEqual(scan.actions, [page, "https://base.example/dir/", "https://forms.example/next", "https://base.example/dir/next",
    ...Array.from({ length: 18 }, (_, i) => [`https://forms.example/extra${i}`, `https://base.example/extra${i}`]).flat(),
    "https://forms.example/ignored", "https://base.example/ignored"]);
  for (const invalid of ['<form action="http://[invalid"></form>', '<form action="https://owner:secret@forms.example/vote"></form>', `<form action="/${"x".repeat(8193)}"></form>`]) {
    assert.equal(extractFormActions(parseDocument(invalid).doc, page).incomplete, true);
  }
  const spacedMethod = '<form method=" post " action="/vote"></form>';
  assert.deepEqual(extractFormActions(parseDocument(spacedMethod).doc, page), { actions: ["https://forms.example/vote"], incomplete: false });
  const deep = "<div>".repeat(260) + "<form action=/vote></form>" + "</div>".repeat(260);
  assert.deepEqual(handle({ op: "form_actions", body: deep, url: page }), { result: { actions: [], incomplete: true } });
});

test("T.3: non-web bases are ignored without changing action safety checks", () => {
  const page = "https://shop.example/page";
  const scan = (base: string, action: string) => extractFormActions(parseDocument(`<base href="${base}"><form action="${action}"></form>`).doc, page);
  for (const base of ["javascript:void(0)", "data:text/plain,x", "mailto:owner@example.com", "about:blank", "custom://host/dir/"]) {
    assert.deepEqual(scan(base, "/vote"), { actions: ["https://shop.example/vote"], incomplete: false });
    assert.deepEqual(scan(base, "relative"), { actions: ["https://shop.example/relative"], incomplete: false });
    assert.deepEqual(scan(base, "javascript:void(0)"), { actions: [], incomplete: false });
    assert.deepEqual(scan(base, "https://shop.example/vote"), { actions: ["https://shop.example/vote"], incomplete: false });
    assert.deepEqual(scan(base, ""), { actions: [page], incomplete: false }, "empty actions still target the page");
  }
  for (const action of ["javascript:" + "x".repeat(2048), "custom://owner:secret@host/path", "http://[invalid"]) {
    assert.equal(scan("https://shop.example/", action).incomplete, true);
  }
});

test("T.3: an inert non-web template base cannot hide a page-origin GET action", () => {
  const body = '<template><base href="custom://host/dir/"></template><form action="/vote"></form>';
  assert.deepEqual(extractFormActions(parseDocument(body).doc, "https://shop.example/page"), {
    actions: ["https://shop.example/vote"], incomplete: false,
  });
});

test("T.3: whitespace-only, empty and missing actions guard both page and base URLs", () => {
  const page = "https://shop.example/page?original=yes#fragment";
  for (const attribute of ['action=" "', 'action="\t"', 'action="\n"', 'action=" &#9;&#10;&#13; "', 'action=""', ""]) {
    const body = `<base href="https://base.example/dir/?base=yes#fragment"><form ${attribute}></form>`;
    assert.deepEqual(extractFormActions(parseDocument(body).doc, page), {
      actions: ["https://shop.example/page?original=yes", "https://base.example/dir/?base=yes"], incomplete: false,
    });
    const expected = attribute === 'action=""' || attribute === "" ? "https://shop.example/page?original=yes" : "https://base.example/dir/?base=yes";
    assert.equal(extractForms(parseDocument(body).doc, page).forms[0].action, expected, "only missing and exactly empty actions use the page URL");
  }
});

test("T.3: every web base is a candidate, including templates and the real second base", () => {
  const page = "https://shop.example/page";
  const form = '<form action="next#fragment"></form>';
  for (const body of [
    `<template><base href="https://inert.example/dir/"></template><base href="https://real.example/dir/">${form}`,
    `${form}<template><base href="https://inert.example/dir/"></template><base href="https://real.example/dir/">`,
    `<base href="https://inert.example/dir/"><base href="https://real.example/dir/">${form}`,
  ]) {
    assert.deepEqual(extractFormActions(parseDocument(body).doc, page), {
      actions: ["https://shop.example/next", "https://inert.example/dir/next", "https://real.example/dir/next"], incomplete: false,
    });
  }
});

test("T.3: distinct web bases are bounded; duplicates, invalid and non-web bases do not consume the cap", () => {
  const page = "https://shop.example/page";
  const scan = (body: string) => extractFormActions(parseDocument(body + '<form action="/vote"></form>').doc, page);
  const atCap = Array.from({ length: MAX_FORM_BASES }, (_, i) => `<base href="https://base${i}.example/">`).join("");
  assert.equal(scan(atCap).incomplete, false);
  assert.equal(scan(atCap + '<base href="https://base0.example/"><base href="custom://host/"><base href="http://[invalid">').incomplete, false);
  assert.deepEqual(scan(atCap + '<template><base href="https://extra.example/"></template>'), { actions: [], incomplete: true });
});

test("T.3: skipped non-web actions consume their full resolved length before deduplication", () => {
  const action = "mailto:" + "é".repeat(300);
  const resolvedLength = new URL(action).href.length;
  assert.ok(resolvedLength > action.length);
  const count = Math.floor(MAX_FORM_ACTION_CHARS / resolvedLength);
  const atCap = `<form action="${action}"></form>`.repeat(count);
  const scan = (body: string) => extractFormActions(parseDocument(body).doc, "https://shop.example/page");
  assert.deepEqual(scan(atCap), { actions: [], incomplete: false });
  assert.deepEqual(scan(atCap + `<form action="${action}"></form>`), { actions: [], incomplete: true });
});

test("T.3: pages without a base keep exactly their previous static targets", () => {
  const page = "https://shop.example/dir/page?original=yes#fragment";
  const body = '<form></form><form action=""></form><form action=" &#9; "></form>' +
    '<form action="next#part"></form><form action="/vote"></form><form action="/vote#again"></form>' +
    '<form action="https://other.example/path#part"></form><form action="//cdn.example/send"></form>' +
    '<form action="?new=yes"></form><form action="#part"></form>' +
    '<form method="put" action="/unknown"></form><form method="POST" action="/post"></form>' +
    '<form method="dialog" action="/dialog"></form><form action="mailto:owner@example.com"></form>';
  assert.deepEqual(extractFormActions(parseDocument(body).doc, page), {
    actions: ["https://shop.example/dir/page?original=yes", "https://shop.example/dir/next", "https://shop.example/vote",
      "https://other.example/path", "https://cdn.example/send", "https://shop.example/dir/page?new=yes", "https://shop.example/unknown"],
    incomplete: false,
  });
});

test("T.6: a complete 600-form static union passes the cache despite entry eviction", t => {
  const scan = extractFormActions(parseDocument(formsWithBase(600, 'https://base.example/')).doc, 'https://shop.example/page');
  assert.equal(scan.incomplete, false);
  assert.equal(scan.actions.length, 1200);
  const cache = new RenderActionCache();
  assert.deepEqual(cache.scan(scan.actions), scan.actions, 'all targets survive FIFO eviction');
  const normalize = String.prototype.normalize;
  let folds = 0;
  t.mock.method(String.prototype, 'normalize', function (this: string, form?: string) {
    folds++;
    return normalize.call(this, form);
  });
  for (const address of ['https://shop.example', 'https://base.example']) {
    const target = address + '/form600';
    assert.deepEqual(cache.scan([target]), [target]);
  }
  assert.equal(folds, 0, 'the last form at both addresses remains cached');
  assert.deepEqual(cache.scan([scan.actions[0]]), [scan.actions[0]]);
  assert.ok(folds > 0, 'the first entry was evicted and is safely recomputed');
  assert.deepEqual(cache.scan(scan.actions), scan.actions, 'a repeated large scan still terminates with all targets');
});

test("T.6: expanded targets have a separate finite bound, with the character budget still enforced", () => {
  assert.equal(MAX_FORM_ACTION_TARGETS, MAX_FORM_ACTIONS * (MAX_FORM_BASES + 1));
  const cache = new RenderActionCache();
  // Short valid non-web URLs isolate the count limit from the character limit.
  assert.deepEqual(cache.scan(Array(MAX_FORM_ACTION_TARGETS).fill('a:')), []);
  assert.equal(cache.scan(Array(MAX_FORM_ACTION_TARGETS + 1).fill('a:')), null);
  assert.equal(cache.scan(Array(MAX_FORM_ACTION_TARGETS).fill('about:blank')), null);
});

test("T.6: a static union at the full character budget fits the cache's budget", () => {
  const origin = 'https://a.example';
  const body = '<base href="https://b.example/">' + Array.from({ length: 16 }, (_, i) =>
    `<form action="/${i}${'x'.repeat(2048 - origin.length - 1 - String(i).length)}"></form>`).join('');
  const scan = extractFormActions(parseDocument(body).doc, origin + '/page');
  assert.equal(scan.incomplete, false);
  assert.equal(scan.actions.reduce((total, a) => total + a.length, 0), MAX_FORM_ACTION_CHARS);
  const cache = new RenderActionCache();
  assert.deepEqual(cache.scan(scan.actions), scan.actions);
  assert.equal(cache.scan([...scan.actions, origin + '/extra']), null);
  assert.deepEqual(cache.scan([origin + '/extra']), [origin + '/extra'], 'character eviction admits a new entry');
  assert.deepEqual(cache.scan(scan.actions), scan.actions, 'the full result survives character eviction');
});

test("T.2: action folds are deduplicated, reused across scans, and bounded", t => {
  const normalize = String.prototype.normalize;
  let folds = 0;
  t.mock.method(String.prototype, "normalize", function (this: string, form?: string) {
    folds++;
    return normalize.call(this, form);
  });
  const cache = new RenderActionCache();
  const action = "https://shop.example/%2576ote";
  const one = cache.scan([action]);
  assert.deepEqual(one, ["https://shop.example/vote"]);
  const singleCost = folds;
  assert.ok(singleCost > 0);
  const duplicateCache = new RenderActionCache();
  folds = 0;
  assert.deepEqual(duplicateCache.scan(Array(MAX_FORM_ACTIONS).fill(action)), one);
  assert.equal(folds, singleCost, "1000 copies fold once");
  for (let i = 0; i < 100; i++) assert.deepEqual(duplicateCache.scan([action, "javascript:void(0)", "mailto:owner@example.com"]), one);
  assert.equal(folds, singleCost, "unchanged pages do no further folding");
  const changed = duplicateCache.scan(["https://shop.example/changed"]);
  assert.deepEqual(changed, ["https://shop.example/changed"]);
  assert.ok(folds > singleCost, "new actions are checked immediately");
  const long = "https://shop.example/" + "a".repeat(MAX_LIVE_ACTION - "https://shop.example/".length);
  assert.notEqual(cache.scan(Array(MAX_FORM_ACTION_CHARS / MAX_LIVE_ACTION).fill(long)), null);
  folds = 0;
  assert.equal(cache.scan([...Array(MAX_FORM_ACTION_CHARS / MAX_LIVE_ACTION).fill(long), action]), null);
  assert.equal(folds, 0, "reject the whole over-budget scan before folding");
  for (let i = 0; i < 3; i++) {
    const batch = Array.from({ length: MAX_FORM_ACTIONS }, (_, n) => `https://shop.example/batch${i}/${n}`);
    assert.notEqual(cache.scan(batch), null);
    const cost: number = folds;
    assert.notEqual(cache.scan(batch), null);
    assert.equal(folds, cost, "a full scan still fits after eviction");
  }
  const charCache = new RenderActionCache();
  const longActions = Array.from({ length: 10 }, (_, i) => `https://shop.example/${i}` + "x".repeat(MAX_LIVE_ACTION - "https://shop.example/0".length));
  for (const a of longActions) assert.notEqual(charCache.scan([a]), null);
  const charCost: number = folds;
  assert.notEqual(charCache.scan(longActions.slice(2)), null);
  assert.equal(folds, charCost, "the last 65536 source characters fit");
  assert.notEqual(charCache.scan([longActions[0]]), null);
  assert.ok(folds > charCost, "source characters bound retention even with fewer than 1000 entries");
  assert.equal(cache.scan(["relative"]), null, "native getters return raw relative text only when URL resolution failed");
  const before: number = folds;
  assert.deepEqual(cache.scan([action]), one);
  assert.ok(folds > before, "old entries were evicted instead of accumulating across page changes");
});

test("T.5: 21 forms with a formaction button guard the override without losing ordinary targets", () => {
  const body = '<form action="/ordinary"><button formaction="/vote">Vote</button></form>' + '<form action="/other"></form>'.repeat(20);
  const doc = parseDocument(body).doc;
  assert.deepEqual(extractFormActions(doc, 'https://forms.example/page'), {
    actions: ['https://forms.example/ordinary', 'https://forms.example/other', 'https://forms.example/vote'], incomplete: false,
  });
  assert.equal(extractForms(doc, 'https://forms.example/page').omitted, 1);
});

test("T.5: every formaction uses the page and every web base, regardless of element, owner or method", () => {
  const body = '<template><base href="https://base.example/dir/"></template><base href="https://later.example/next/">' +
    '<form id="f" method="post" action="/post"></form>' +
    '<button form="f" formaction="vote" formmethod="post">Send</button>' +
    '<input form="f" type="image" formaction="image" formmethod="dialog">' +
    '<div formaction="arbitrary"></div><script formaction="script"></script><style formaction="style"></style>';
  assert.deepEqual(extractFormActions(parseDocument(body).doc, 'https://forms.example/page'), {
    actions: ['vote', 'image', 'arbitrary', 'script', 'style'].flatMap(a => [
      `https://forms.example/${a}`, `https://base.example/dir/${a}`, `https://later.example/next/${a}`,
    ]), incomplete: false,
  });
  for (const a of ['', ' &#9;&#10;&#13; ']) {
    assert.deepEqual(extractFormActions(parseDocument(`<base href="https://base.example/"><button formaction="${a}"></button>`).doc, 'https://forms.example/page'), {
      actions: ['https://forms.example/page', 'https://base.example/'], incomplete: false,
    });
  }
});

test("T.5: any possible GET method override guards all forms; POST and dialog alone stay skipped", () => {
  const forms = '<form method="POST" action="/post"></form><form method="dialog" action="/dialog"></form>';
  const scan = (body: string) => extractFormActions(parseDocument(body).doc, 'https://forms.example/page');
  for (const method of ['get', 'GET', '', 'put', ' post ', '&#9;dialog']) for (const tag of ['button', 'input', 'div', 'script', 'style']) {
    assert.deepEqual(scan(`${forms}<${tag} formmethod="${method}"></${tag}>`), {
      actions: ['https://forms.example/post', 'https://forms.example/dialog'], incomplete: false,
    }, `${tag}:${method}`);
  }
  for (const method of ['post', 'POST', 'dialog', 'DiAlOg']) assert.deepEqual(scan(`${forms}<button formmethod="${method}">Send</button>`), { actions: [], incomplete: false });
  assert.deepEqual(scan(forms), { actions: [], incomplete: false });
});

test("T.5: literal NUL survives htmlparser2 and makes action, formaction and base scans incomplete", () => {
  const scan = (body: string) => extractFormActions(parseDocument(body).doc, 'https://forms.example/page');
  const body = '<form action="/ordinary"></form>'.repeat(20) + '<form action="/vo\0te"></form>';
  const doc = parseDocument(body).doc;
  assert.equal((doc.children[20] as any).attribs.action, '/vo\0te');
  assert.deepEqual(scan(body), { actions: [], incomplete: true }, 'round 5: 21 forms with a literal NUL action');
  for (const attribute of ['action', 'formaction']) for (const tag of ['form', 'button', 'div', 'script', 'style'])
    assert.deepEqual(scan(`<${tag} method="post" ${attribute}="/a\0b"></${tag}>`), { actions: [], incomplete: true });
  assert.deepEqual(scan('<template><base href="custom://host/a\0b"></template>'), { actions: [], incomplete: true });
  // A literal NUL in unrelated text or attributes is outside this URL rule.
  assert.deepEqual(scan('<p title="a\0b">a\0b</p>'), { actions: [], incomplete: false });
});

test("T.5: zero character references decode to U+FFFD, not NUL, and their URL is guarded", () => {
  for (const zero of ['&#0;', '&#x0;', '&#X0000;', '\uFFFD']) {
    const doc = parseDocument(`<form action="/a${zero}b"></form><button formaction="/c${zero}d"></button><base href="https://base.example/a${zero}b/">`).doc;
    assert.equal((doc.children[0] as any).attribs.action, '/a\uFFFDb');
    assert.equal((doc.children[1] as any).attribs.formaction, '/c\uFFFDd');
    assert.equal((doc.children[2] as any).attribs.href, 'https://base.example/a\uFFFDb/');
    assert.deepEqual(extractFormActions(doc, 'https://forms.example/page'), {
      actions: ['https://forms.example/a%EF%BF%BDb', 'https://base.example/a%EF%BF%BDb', 'https://forms.example/c%EF%BF%BDd', 'https://base.example/c%EF%BF%BDd'], incomplete: false,
    });
  }
});

test("T.5: submitter addresses share the form count and character caps, before deduplication", () => {
  const scan = (body: string) => extractFormActions(parseDocument(body).doc, 'https://forms.example/page');
  const button = '<button formaction="/vote"></button>';
  assert.equal(scan(button.repeat(MAX_FORM_ACTIONS)).incomplete, false);
  assert.equal(scan(button.repeat(MAX_FORM_ACTIONS) + '<form method="post"></form>').incomplete, true);
  assert.equal(scan(button.repeat(MAX_FORM_ACTIONS + 1)).incomplete, true);
  assert.equal(scan('<form formaction="/vote"></form>' + button.repeat(MAX_FORM_ACTIONS - 2)).incomplete, false);
  assert.equal(scan('<form formaction="/vote"></form>' + button.repeat(MAX_FORM_ACTIONS - 1)).incomplete, true);
  const long = 'https://forms.example/' + 'x'.repeat(2048 - 'https://forms.example/'.length);
  const atChars = `<input type="image" formaction="${long}">`.repeat(MAX_FORM_ACTION_CHARS / 2048);
  assert.equal(scan(atChars).incomplete, false);
  assert.equal(scan(atChars + '<form action="/vote"></form>').incomplete, true);
  assert.equal(scan('<base href="https://other.example/">' + atChars).incomplete, true, 'every base resolution counts');
  for (const action of ['http://[invalid', 'https://user:secret@forms.example/vote', 'custom://user:secret@host/', '/' + 'x'.repeat(2048), 'javascript:' + 'x'.repeat(2048)])
    assert.equal(scan(`<button formaction="${action}" formmethod="post"></button>`).incomplete, true, action);
  assert.deepEqual(scan('<button formaction="javascript:void(0)"></button><input formaction="mailto:owner@example.com">'), { actions: [], incomplete: false });
});

test("T.5: foreign forms and integration points contribute conservative static targets", () => {
  const body = '<svg><form action="/svg"></form><foreignObject><form action="/html-svg"><button formaction="/button"></button></form></foreignObject></svg>' +
    '<math><form action="/math"></form><annotation-xml encoding="text/html"><form action="/html-math"><input type="image" formaction="/image"></form></annotation-xml></math>';
  const scan = extractFormActions(parseDocument(body).doc, 'https://forms.example/page');
  assert.equal(scan.incomplete, false);
  for (const path of ['/svg', '/html-svg', '/button', '/math', '/html-math', '/image']) assert.ok(scan.actions.includes('https://forms.example' + path), path);
});
