// SPDX-License-Identifier: Apache-2.0
// v0.4 phase C: W-04 forms as permission-gated actions. Every form here is sent to a LOCAL test server
// only: no test submits anything to a real website.
import assert from "node:assert/strict";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { freshHome, html, logText, serve, text, type TestServer } from "./helper.js";

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-forms-home-"));
process.env.HOME = FAKE_HOME; // the owner's real Web Risk key file is never read
freshHome();
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
delete process.env.TIRESIAS_PRIVATE;
delete process.env.TIRESIAS_PROFILE;
delete process.env.TIRESIAS_WEB_RISK_KEY;
// "localhost" answers 127.0.0.1 only (the test server does not listen on ::1). No real DNS query.
const dnsp = (await import("node:dns/promises")).default as any;
const realLookup = dnsp.lookup;
dnsp.lookup = (name: string, opts: unknown) => (name === "localhost" ? Promise.resolve([{ address: "127.0.0.1", family: 4 }]) : realLookup(name, opts));

const engine = await import("../engine.js");
const slips = await import("../slips.js");
const store = await import("../store.js");
const { createServer } = await import("../mcp.js");
const { resetRulesCache } = await import("../rules.js");

const servers: TestServer[] = [];
after(async () => {
  for (const s of servers) await s.close();
  (await import("../sandbox.js")).stopWorker();
});

function newHome(): string {
  const d = path.join(freshHome(), "store");
  process.env.TIRESIAS_HOME = d;
  return d;
}
function tree(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      out.push(path.relative(dir, f));
      if (e.isDirectory()) walk(f);
    }
  };
  walk(dir);
  return out.sort();
}
function allText(dir: string): string {
  let s = "";
  for (const f of tree(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile()) s += fs.readFileSync(p, "utf8");
  }
  return s;
}

const FILLER = "<p>" + "We answer every message within two working days, and we never share what you send us. ".repeat(20) + "</p>";

interface Site {
  s: TestServer;
  posts: { path: string; body: string; cookie?: string; ct?: string; origin?: string; referer?: string }[];
  gets: string[];
  token: () => string; // the hidden CSRF value sent with the latest page
  cookie: () => string;
  page: { extra: string; label: string };
}

// The test site. Every page view sets a new session cookie and a new CSRF token, like a real form.
async function site(): Promise<Site> {
  let n = 0;
  const posts: Site["posts"] = [];
  const gets: string[] = [];
  const page = { extra: "", label: "Your name" };
  const st: Site = {} as Site;
  const s = await serve((req: http.IncomingMessage, res: http.ServerResponse) => {
    const p = req.url ?? "";
    if (p === "/robots.txt") return text(res, "User-agent: *\nDisallow: /blocked\n");
    if (req.method === "POST") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        posts.push({ path: p, body, cookie: req.headers.cookie, ct: req.headers["content-type"], origin: req.headers.origin as string | undefined, referer: req.headers.referer });
        if (p === "/s303") return void (res.writeHead(303, { location: "/thanks" }), res.end());
        if (p === "/s307") return void (res.writeHead(307, { location: "/elsewhere" }), res.end());
        if (p === "/wallanswer") return html(res, `<html><body><form><div class="g-recaptcha" data-sitekey="k"></div></form></body></html>`);
        if (p === "/broken") return html(res, "<p>No</p>", {}, 500);
        html(res, `<html><head><title>Thanks</title></head><body><h1>Thank you</h1><p>Message received.</p></body></html>`);
      });
      return;
    }
    gets.push(p);
    if (p.startsWith("/search")) return html(res, `<html><head><title>Results</title></head><body><h1>Results</h1><p>Found anvils.</p></body></html>`);
    if (p === "/thanks") return html(res, `<html><head><title>Thanks</title></head><body><h1>Thanks after redirect</h1><p>Done.</p></body></html>`);
    if (p === "/elsewhere") return html(res, "<p>should never be fetched</p>");
    if (p === "/contact") {
      n++;
      const port = new URL(s.url).port;
      return html(
        res,
        `<html><head><title>Contact</title></head><body><h1>Contact us</h1>${FILLER}
<form id="f1" method="post" action="/send">
  <input type="hidden" name="csrf" value="TOKEN-${n}">
  <label for="nm">${page.label}</label><input id="nm" name="name" required maxlength="40">
  <label>Email <input type="email" name="email"></label>
  <input name="phone" placeholder="Phone number">
  <textarea name="msg" aria-label="Message"></textarea>
  <select name="topic"><option value="sales">Sales</option><option value="support" selected>Support</option></select>
  <fieldset><legend>Contact by</legend><label><input type="radio" name="via" value="email" checked> Email</label><label><input type="radio" name="via" value="phone"> Phone</label></fieldset>
  <label><input type="checkbox" name="news" value="yes"> Newsletter</label>
  ${page.extra}
  <button type="submit" name="go" value="1">Send</button>
</form>
<form method="get" action="/search"><input name="q" aria-label="Search"></form>
<form method="post" action="/login"><input name="user"><input type="password" name="pw"></form>
<form method="post" action="/up" enctype="multipart/form-data"><input name="a"></form>
<form method="post" action="/pay"><input name="card_number"><input name="cvv"></form>
<form method="post" action="/c"><input name="a"><div class="g-recaptcha" data-sitekey="x"></div></form>
<form method="post" action="javascript:alert(1)"><input name="a"></form>
<form method="dialog"><input name="a"></form>
<form method="post" action="/s303"><input name="a"></form>
<form method="post" action="/s307"><input name="a"></form>
<form method="post" action="/blocked/x"><input name="a"></form>
<form method="post" action="/wallanswer"><input name="a"></form>
<form method="post" action="http://localhost:${port}/other"><input name="a"></form>
<form method="post" action="/s"><input autocomplete="cc-number" name="x"></form>
<form method="post" action="/broken"><input name="a"></form>
<form method="post" action="http://127.0.0.1:${port}/send"><input name="a"></form>
</body></html>`,
        { "set-cookie": `sid=S${n}; Path=/; HttpOnly` },
      );
    }
    html(res, "<p>nothing</p>", {}, 404);
  });
  servers.push(s);
  Object.assign(st, { s, posts, gets, token: () => `TOKEN-${n}`, cookie: () => `sid=S${n}`, page });
  return st;
}

const CONTACT = { name: "Ann", email: "a@b.example", msg: "Hi\nthere" };
const grant = (site: string, o: { uses?: string; path?: string } = {}) => slips.grant({ action: "submit_form", site, ...o });
const ctx = { agent: "form-tester" };

// v0.9 (item B): an answer that repeated a secret the site set comes back as fixed codes only.
function assertWithheld(r: Awaited<ReturnType<typeof engine.formSubmit>>, status: number): void {
  assert.equal(r.status, "ok", r.message);
  assert.equal(r.form?.reason, "secret_withheld", r.message);
  assert.equal(r.form?.sent, true);
  assert.equal(r.form?.http_status, status);
  assert.equal(r.untrusted_content, null);
  assert.equal(r.counts?.receipts ?? 0, 0);
  assert.match(r.message ?? "", /withheld the whole answer/);
}

test("W-04 read: forms are listed as fields; hidden values are never shown; refused forms carry not_allowed", async () => {
  const home = newHome();
  const t = await site();
  const r = await engine.read(t.s.url + "/contact", {}, ctx);
  assert.equal(r.status, "ok");
  const forms = (r.untrusted_content as any).forms;
  assert.equal(r.counts?.forms, 16);
  assert.equal(forms.length, 16);
  const f = forms[0];
  assert.equal(f.method, "POST");
  assert.equal(f.action, t.s.url + "/send");
  assert.equal(f.not_allowed, undefined);
  const by = (n: string) => f.fields.find((x: any) => x.name === n);
  assert.deepEqual(by("csrf"), { name: "csrf", type: "hidden", value: "set by the site" });
  assert.equal(by("name").label, "Your name"); // <label for>
  assert.equal(by("name").required, true);
  assert.equal(by("name").maxlength, 40);
  assert.equal(by("email").label, "Email"); // wrapping label
  assert.equal(by("email").type, "email");
  assert.equal(by("phone").label, "Phone number"); // placeholder
  assert.equal(by("msg").label, "Message"); // aria-label
  assert.deepEqual(by("topic").options, [{ value: "sales", label: "Sales" }, { value: "support", label: "Support", selected: true }]);
  assert.equal(by("via").label, "Contact by");
  assert.deepEqual(by("via").options.map((o: any) => o.value), ["email", "phone"]);
  assert.equal(by("news").multiple, true);
  assert.equal(by("go"), undefined, "buttons are not fields");
  assert.deepEqual(forms.map((x: any) => x.not_allowed ?? null), [
    null, null, "login_or_password", "file_upload", "payment", "captcha", "bad_action", "bad_method", null, null, null, null, null, "payment", null, null,
  ]);
  assert.equal(forms[6].action, null);
  // The CSRF token is in no reply and nowhere in the store (the cached page keeps the listing only).
  assert.doesNotMatch(JSON.stringify(r), /TOKEN-/);
  assert.doesNotMatch(allText(home), /TOKEN-/);
});

test("W-04 read: at most 20 forms and 100 fields per form, counted when cut; a cut form is never sent", async () => {
  newHome();
  const many = Array.from({ length: 25 }, (_, i) => `<form action="/x${i}"><input name="a"></form>`).join("");
  const wide = `<form method="post" action="/w">${Array.from({ length: 120 }, (_, i) => `<input name="f${i}">`).join("")}</form>`;
  const s = await serve((req, res) => (req.url === "/robots.txt" ? text(res, "") : html(res, `<html><body><h1>Forms</h1>${FILLER}${req.url === "/wide" ? wide : many}</body></html>`)));
  servers.push(s);
  const r = await engine.read(s.url + "/many", {}, ctx);
  const uc = r.untrusted_content as any;
  assert.equal(uc.forms.length, 20);
  assert.equal(uc.forms_omitted, 5);
  assert.equal(r.counts?.forms, 25);
  const w = await engine.read(s.url + "/wide", {}, ctx);
  const f = (w.untrusted_content as any).forms[0];
  assert.equal(f.not_allowed, "too_many_fields");
  assert.equal(f.fields.length, 100);
  assert.equal(f.fields_omitted, 20);
  const p = await engine.formPreview(s.url + "/wide", 1, {}, ctx);
  assert.equal(p.status, "refused");
  assert.equal(p.form?.not_allowed, "too_many_fields");
});

test("W-04 preview: the exact request with hidden values masked, a preview hash, the slip state; nothing is written", async () => {
  const home = newHome();
  const t = await site();
  const p = await engine.formPreview(t.s.url + "/contact", 1, CONTACT, ctx);
  assert.equal(p.status, "ok", p.message);
  assert.equal(p.form?.method, "POST");
  assert.match(p.form!.preview_hash!, /^[0-9a-f]{64}$/);
  assert.deepEqual(p.form?.slip, { covered: false, refused: "no_slip" });
  assert.match(p.message!, /Only the owner can grant one, from the command line/);
  const req = (p.untrusted_content as any).request;
  assert.equal(req.method, "POST");
  assert.equal(req.url, t.s.url + "/send");
  assert.equal(req.content_type, "application/x-www-form-urlencoded");
  assert.equal(req.body, "csrf=[set by the site]&name=Ann&email=a%40b.example&phone=&msg=Hi%0D%0Athere&topic=support&via=email");
  assert.doesNotMatch(JSON.stringify(p), /TOKEN-/);
  assert.equal(t.posts.length, 0, "nothing was sent");
  assert.deepEqual(tree(home), [], "nothing was written: not even the store folder");
  // The hash does not depend on the hidden value (a new token every visit), only on the form and the values.
  const again = await engine.formPreview(t.s.url + "/contact", 1, CONTACT, ctx);
  assert.equal(again.form?.preview_hash, p.form?.preview_hash);
  const other = await engine.formPreview(t.s.url + "/contact", 1, { ...CONTACT, name: "Bob" }, ctx);
  assert.notEqual(other.form?.preview_hash, p.form?.preview_hash);
  // A slip for the target shows up, unclaimed.
  const g = grant(t.s.url, { uses: "2" });
  const covered = await engine.formPreview(t.s.url + "/contact", 1, CONTACT, ctx);
  assert.deepEqual(covered.form?.slip, { covered: true, id: g.id, uses_left: 2, expires_at: g.expires_at });
  assert.equal(slips.list().items[0].uses_left, 2);
  // Private preview works and writes nothing.
  const before = tree(home);
  const priv = await engine.formPreview(t.s.url + "/contact", 1, CONTACT, { ...ctx, private: true });
  assert.equal(priv.status, "ok");
  assert.equal(priv.private, true);
  assert.deepEqual(tree(home), before);
});

test("W-04 preview: values are checked against the form", async () => {
  newHome();
  const t = await site();
  const p = await engine.formPreview(t.s.url + "/contact", 1, { csrf: "mine", nope: "x", topic: "billing", via: ["email", "phone"], name: "x".repeat(41), phone: "1\n2", email: ["a", "b"] }, ctx);
  assert.equal(p.status, "refused");
  assert.equal(p.form?.reason, "invalid_values");
  const probs = Object.fromEntries((p.untrusted_content as any).problems.map((x: any) => [x.field, x.problem]));
  assert.deepEqual(probs, { csrf: "hidden_field", nope: "not_a_field", topic: "not_an_option", via: "not_multiple", name: "too_long", phone: "bad_value", email: "not_multiple" });
  assert.equal(p.counts?.problems, 7);
  const req = await engine.formPreview(t.s.url + "/contact", 1, {}, ctx);
  assert.deepEqual((req.untrusted_content as any).problems, [{ field: "name", problem: "required" }]);
  const refused = await engine.formPreview(t.s.url + "/contact", 3, { user: "me" }, ctx);
  assert.equal(refused.status, "refused");
  assert.equal(refused.form?.not_allowed, "login_or_password");
  assert.equal((await engine.formPreview(t.s.url + "/contact", 17, {}, ctx)).form?.reason, "no_such_form");
  assert.equal((await engine.formPreview(t.s.url + "/contact", 21, {}, ctx)).status, "error");
});

test("W-04 submit: no slip means no request; with a slip, exactly the previewed request goes out once, with fresh hidden values and this call's cookie", async () => {
  const home = newHome();
  const t = await site();
  const url = t.s.url + "/contact";
  const p = await engine.formPreview(url, 1, CONTACT, ctx);
  const hash = p.form!.preview_hash!;
  const none = await engine.formSubmit(url, 1, CONTACT, hash, ctx);
  assert.equal(none.status, "refused");
  assert.equal(none.form?.reason, "no_slip");
  assert.equal(t.posts.length, 0);

  const g = grant(t.s.url, { path: "/send" });
  const r = await engine.formSubmit(url, 1, CONTACT, hash, ctx);
  assert.equal(r.status, "ok", r.message);
  assert.equal(r.form?.http_status, 200);
  assert.deepEqual(r.form?.slip, { covered: true, id: g.id, use: 1 });
  assert.equal(r.form?.sent, true);
  assert.equal(t.posts.length, 1);
  const sent = t.posts[0];
  assert.equal(sent.path, "/send");
  // The real hidden value is the one from THIS call's fetch of the page, never the preview's.
  assert.equal(sent.body, `csrf=${t.token()}&name=Ann&email=a%40b.example&phone=&msg=Hi%0D%0Athere&topic=support&via=email`);
  assert.equal(sent.ct, "application/x-www-form-urlencoded");
  assert.equal(sent.cookie, t.cookie(), "only the cookie the site set during this call");
  assert.equal(sent.origin, t.s.url);
  assert.equal(sent.referer, url);
  assert.match(JSON.stringify((r.untrusted_content as any).outline), /Thank you/);
  assert.ok(r.counts!.receipts > 0);
  assert.doesNotMatch(JSON.stringify(r), /TOKEN-/);
  // Records: a history line with the slip, and what was sent, hidden fields by name only.
  const h = logText(home, "history").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const line = h.find((x) => x.tool === "form_submit" && x.status === "ok");
  assert.equal(line.slip, g.id);
  const rec = logText(home, "receipts").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.sent === "form");
  assert.equal(rec.url, t.s.url + "/send");
  assert.equal(rec.method, "POST");
  assert.equal(rec.slip, g.id);
  assert.equal(rec.use, 1);
  assert.equal(rec.outcome, 200);
  assert.deepEqual(rec.hidden, ["csrf"]);
  assert.deepEqual(rec.fields.find((x: any) => x.name === "name"), { name: "name", value: "Ann" });
  // Neither the token nor the session cookie is anywhere on disk.
  assert.doesNotMatch(allText(home), /TOKEN-|sid=S/);
  // The slip had one use: a second submit is refused and sends nothing.
  const twice = await engine.formSubmit(url, 1, CONTACT, hash, ctx);
  assert.equal(twice.form?.reason, "no_slip");
  assert.equal(t.posts.length, 1);
});

test("W-04 submit: a form that changed since the preview is refused and nothing is sent or used", async () => {
  newHome();
  const t = await site();
  const url = t.s.url + "/contact";
  const g = grant(t.s.url);
  const p = await engine.formPreview(url, 1, CONTACT, ctx);
  t.page.extra = `<input type="text" name="extra" value="added later">`;
  const r = await engine.formSubmit(url, 1, CONTACT, p.form!.preview_hash!, ctx);
  assert.equal(r.status, "refused");
  assert.equal(r.form?.reason, "form_changed");
  assert.equal(t.posts.length, 0);
  assert.equal(slips.list().items.find((x) => x.id === g.id)?.uses_left, 1);
  // Different values than the preview are a different request too.
  t.page.extra = "";
  const p2 = await engine.formPreview(url, 1, CONTACT, ctx);
  assert.equal((await engine.formSubmit(url, 1, { ...CONTACT, name: "Eve" }, p2.form!.preview_hash!, ctx)).form?.reason, "form_changed");
  assert.equal((await engine.formSubmit(url, 1, CONTACT, "not-a-hash", ctx)).form?.reason, "bad_preview_hash");
  assert.equal(t.posts.length, 0);
});

test("W-04 submit: a GET form needs a slip too, and sends its values in the query", async () => {
  newHome();
  const t = await site();
  const url = t.s.url + "/contact";
  const p = await engine.formPreview(url, 2, { q: "anvils & iron" }, ctx);
  assert.equal(p.form?.method, "GET");
  assert.equal((p.untrusted_content as any).request.url, t.s.url + "/search?q=anvils+%26+iron");
  const none = await engine.formSubmit(url, 2, { q: "anvils & iron" }, p.form!.preview_hash!, ctx);
  assert.equal(none.form?.reason, "no_slip");
  assert.equal(t.gets.filter((g) => g.startsWith("/search")).length, 0);
  grant(t.s.url, { path: "/search" });
  const r = await engine.formSubmit(url, 2, { q: "anvils & iron" }, p.form!.preview_hash!, ctx);
  assert.equal(r.status, "ok", r.message);
  assert.deepEqual(t.gets.filter((g) => g.startsWith("/search")), ["/search?q=anvils+%26+iron"]);
});

test("W-04 submit: no redirect is followed after a submit (303 and 307 alike, Codex round 52); each is reported", async () => {
  newHome();
  const t = await site();
  const url = t.s.url + "/contact";
  grant(t.s.url, { uses: "10" });
  const p9 = await engine.formPreview(url, 9, { a: "1" }, ctx);
  const r9 = await engine.formSubmit(url, 9, { a: "1" }, p9.form!.preview_hash!, ctx);
  assert.equal(r9.form?.reason, "redirect_not_followed");
  assert.equal(r9.form?.http_status, 303);
  assert.equal((r9.untrusted_content as any).location, "/thanks");
  assert.deepEqual(t.posts.map((x) => x.path), ["/s303"]);
  assert.ok(!t.gets.includes("/thanks"));
  const p10 = await engine.formPreview(url, 10, { a: "1" }, ctx);
  const r10 = await engine.formSubmit(url, 10, { a: "1" }, p10.form!.preview_hash!, ctx);
  assert.equal(r10.status, "error");
  assert.equal(r10.form?.reason, "redirect_not_followed");
  assert.equal(r10.form?.http_status, 307);
  assert.equal(r10.form?.sent, true);
  assert.equal((r10.untrusted_content as any).location, "/elsewhere");
  assert.deepEqual(t.posts.map((x) => x.path), ["/s303", "/s307"], "one POST each, never resent");
  assert.ok(!t.gets.includes("/elsewhere"));
  // An answer that is not 2xx is an error with the status, and it was still sent.
  const p15 = await engine.formPreview(url, 15, { a: "1" }, ctx);
  const r15 = await engine.formSubmit(url, 15, { a: "1" }, p15.form!.preview_hash!, ctx);
  assert.equal(r15.form?.reason, "http_error");
  assert.equal(r15.form?.http_status, 500);
  assert.equal(t.posts.filter((x) => x.path === "/broken").length, 1, "never retried");
});

test("W-04 submit: the target's robots.txt is checked before a slip is used; a walled answer is handed to a person", async () => {
  newHome();
  const t = await site();
  const url = t.s.url + "/contact";
  const g = grant(t.s.url, { uses: "5" });
  const p = await engine.formPreview(url, 11, { a: "1" }, ctx);
  const r = await engine.formSubmit(url, 11, { a: "1" }, p.form!.preview_hash!, ctx);
  assert.equal(r.status, "refused");
  assert.equal(r.form?.reason, "target_refused");
  assert.equal(t.posts.length, 0);
  assert.equal(slips.list().items.find((x) => x.id === g.id)?.uses_left, 5, "no use spent");
  const pw = await engine.formPreview(url, 12, { a: "1" }, ctx);
  const w = await engine.formSubmit(url, 12, { a: "1" }, pw.form!.preview_hash!, ctx);
  assert.equal(w.status, "wall");
  assert.equal(w.handoff?.reason, "captcha");
  assert.equal(w.form?.sent, true);
  assert.equal(w.form?.http_status, 200);
  assert.match(w.message!, /^The form was sent/);
});

test("W-04 submit: cookies go only to the host that set them", async () => {
  newHome();
  const t = await site();
  const url = t.s.url + "/contact";
  const port = new URL(t.s.url).port;
  grant(`http://localhost:${port}`);
  const p = await engine.formPreview(url, 13, { a: "1" }, ctx);
  const r = await engine.formSubmit(url, 13, { a: "1" }, p.form!.preview_hash!, ctx);
  assert.equal(r.status, "ok", r.message);
  assert.equal(t.posts.length, 1);
  assert.equal(t.posts[0].path, "/other");
  assert.equal(t.posts[0].cookie, undefined, "a cookie from 127.0.0.1 is never sent to localhost");
});

test("W-04 submit: refused in private mode, before anything is fetched or written", async () => {
  const home = newHome();
  const t = await site();
  const r = await engine.formSubmit(t.s.url + "/contact", 1, CONTACT, "a".repeat(64), { ...ctx, private: true });
  assert.equal(r.status, "refused");
  assert.equal(r.form?.reason, "private_mode");
  assert.equal(r.private, true);
  assert.equal(t.gets.length, 0);
  assert.deepEqual(tree(home), []);
  process.env.TIRESIAS_PRIVATE = "1";
  try {
    assert.equal((await engine.formSubmit(t.s.url + "/contact", 1, CONTACT, "a".repeat(64), ctx)).form?.reason, "private_mode");
  } finally {
    delete process.env.TIRESIAS_PRIVATE;
  }
});

test("W-04 submit: a target on the Safe Browsing list is refused with no allow_flagged, before a slip is used", async () => {
  newHome();
  const t = await site();
  const list = await serve((req, res) => (req.url === "/robots.txt" ? text(res, "") : text(res, "127.0.0.1\n")));
  servers.push(list);
  // robots.txt for the target is already known, so only the explicit check of the target can stop it
  // before the slip is used (a robots.txt fetch would meet the Safe Browsing check on its own).
  assert.equal((await (await import("../rules.js")).checkAllowed(new URL(t.s.url + "/send"))).allowed, true);
  process.env.TIRESIAS_SAFE_BROWSING = "1";
  process.env.TIRESIAS_SAFETY_LIST_URL = list.url + "/list.txt";
  try {
    const port = new URL(t.s.url).port;
    const page = `http://localhost:${port}/contact`; // the page's host is not listed; form 16's target (127.0.0.1) is
    const g = grant(t.s.url);
    const p = await engine.formPreview(page, 16, { a: "1" }, { ...ctx, allow_flagged: true });
    assert.equal(p.status, "ok", p.message);
    assert.equal(p.form?.slip?.covered, true);
    const r = await engine.formSubmit(page, 16, { a: "1" }, p.form!.preview_hash!, { ...ctx, allow_flagged: true });
    assert.equal(r.status, "flagged", r.message + JSON.stringify(r.untrusted_content));
    assert.deepEqual(r.flag, ["phishing_list"]);
    assert.equal(t.posts.length, 0);
    assert.equal(slips.list().items.find((x) => x.id === g.id)?.uses_left, 1);
  } finally {
    process.env.TIRESIAS_SAFE_BROWSING = "0";
    delete process.env.TIRESIAS_SAFETY_LIST_URL;
  }
});

test("W-04 MCP: form_preview and form_submit say a slip comes only from the owner, and replies stay in budget", async () => {
  newHome();
  resetRulesCache();
  const t = await site();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  const c = new Client({ name: "mcp-forms", version: "1.0.0" });
  await c.connect(b);
  const tools = (await c.listTools()).tools;
  // v0.5.1: the slip policy is said once, in the server's instructions; the tools name the slip.
  const ins = c.getInstructions() ?? "";
  assert.match(ins, /ONLY the owner/);
  assert.match(ins, /from a terminal/);
  assert.match(ins, /ask your person/);
  for (const name of ["form_preview", "form_submit"]) assert.match(tools.find((x) => x.name === name)!.description!, /permission slip/);
  const prev = await c.callTool({ name: "form_preview", arguments: { url: t.s.url + "/contact", form: 1, values: CONTACT } });
  const txt = (prev.content as any)[0].text as string;
  assert.ok(Buffer.byteLength(txt) < 60_000);
  const p = JSON.parse(txt);
  assert.equal(p.status, "ok");
  assert.doesNotMatch(txt, /TOKEN-/);
  grant(t.s.url);
  const sub = JSON.parse(((await c.callTool({ name: "form_submit", arguments: { url: t.s.url + "/contact", form: 1, values: CONTACT, preview_hash: p.form.preview_hash } })).content as any)[0].text);
  assert.equal(sub.status, "ok", sub.message);
  assert.equal(t.posts.length, 1);
  await c.close();
  assert.equal(store.profileName(), "default");
});

test("W-04 CLI: form preview takes --set and --unset; form submit without --preview is refused", async () => {
  const home = newHome();
  const t = await site();
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
  const run = (args: string[]) =>
    new Promise<{ out: string; code: number | null }>((resolve) => {
      const c = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, TIRESIAS_HOME: home } });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.on("close", (code) => resolve({ out, code }));
    });
  const p = await run(["form", "preview", t.s.url + "/contact", "--form", "1", "--set", "name=Ann", "--set", "news=yes"]);
  assert.equal(p.code, 0, p.out);
  assert.equal(JSON.parse(p.out).untrusted_content.request.body, "csrf=[set by the site]&name=Ann&email=&phone=&msg=&topic=support&via=email&news=yes");
  const u = await run(["form", "preview", t.s.url + "/contact", "--form", "1", "--set", "name=Ann", "--unset", "news"]);
  assert.equal(JSON.parse(u.out).untrusted_content.request.body, "csrf=[set by the site]&name=Ann&email=&phone=&msg=&topic=support&via=email");
  // A radio group cannot be emptied (a person cannot uncheck a radio button either).
  assert.equal(JSON.parse((await run(["form", "preview", t.s.url + "/contact", "--form", "1", "--set", "name=Ann", "--unset", "via"])).out).untrusted_content.problems[0].problem, "not_multiple");
  const s = await run(["form", "submit", t.s.url + "/contact", "--form", "1", "--set", "name=Ann"]);
  assert.equal(s.code, 2, "refused: exit 2 since v0.5.1");
  assert.equal(JSON.parse(s.out).form.reason, "bad_preview_hash");
  assert.equal(t.posts.length, 0);
});

// ---- Codex round 51 ----

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of tree(dir)) {
    const p = path.join(dir, f);
    out[f] = fs.statSync(p).isFile() ? fs.readFileSync(p).toString("base64") : "<dir>";
  }
  return out;
}

async function pageWith(forms: string, extra: (req: http.IncomingMessage, res: http.ServerResponse) => boolean = () => false) {
  let n = 0;
  const hits: string[] = [];
  const s = await serve((req, res) => {
    const p = req.url ?? "";
    if (p === "/robots.txt") return text(res, "");
    if (p.split("?")[0] !== "/page" && !/^\/(llms|\.well-known|openapi)/.test(p)) hits.push(`${req.method} ${p}`); // not the read's door probes
    if (extra(req, res)) return;
    if (p.split("?")[0] === "/page") {
      n++;
      return html(res, `<html><head><title>Forms</title></head><body><h1>Forms</h1>${FILLER}${forms.replaceAll("{N}", String(n))}</body></html>`);
    }
    html(res, `<html><body><h1>Done</h1><p>ok</p></body></html>`);
  });
  servers.push(s);
  return { s, hits };
}

test("Codex round 51: a GET form with a hidden field is refused (hidden_in_url); no hidden value appears in any output or store file", async () => {
  const home = newHome();
  const { s, hits } = await pageWith(`<form action="/search"><input type="hidden" name="csrf" value="SECRET-{N}"><input name="q"></form><form action="/search"><input name="q"></form>`);
  grant(s.url);
  const r = await engine.read(s.url + "/page", {}, ctx);
  const forms = (r.untrusted_content as any).forms;
  assert.equal(forms[0].not_allowed, "hidden_in_url");
  assert.equal(forms[1].not_allowed, undefined, "a GET form without hidden fields stays allowed");
  const p = await engine.formPreview(s.url + "/page", 1, { q: "x" }, ctx);
  assert.equal(p.form?.not_allowed, "hidden_in_url");
  const sub = await engine.formSubmit(s.url + "/page", 1, { q: "x" }, "a".repeat(64), ctx);
  assert.equal(sub.status, "refused");
  assert.deepEqual(hits, [], "nothing was sent to the target");
  assert.doesNotMatch(JSON.stringify([r, p, sub]), /SECRET-/);
  assert.doesNotMatch(allText(home), /SECRET-/);
});

test("Codex round 51: a GET submit follows no redirect; a 302 to itself sends exactly one request", async () => {
  newHome();
  const { s, hits } = await pageWith(`<form action="/loop"><input name="q"></form>`, (req, res) => {
    if (!(req.url ?? "").startsWith("/loop")) return false;
    res.writeHead(302, { location: req.url! });
    res.end();
    return true;
  });
  grant(s.url);
  const p = await engine.formPreview(s.url + "/page", 1, { q: "x" }, ctx);
  const r = await engine.formSubmit(s.url + "/page", 1, { q: "x" }, p.form!.preview_hash!, ctx);
  assert.equal(r.form?.reason, "redirect_not_followed");
  assert.equal(r.form?.http_status, 302);
  assert.equal((r.untrusted_content as any).location, "/loop?q=x");
  assert.deepEqual(hits, ["GET /loop?q=x"], "exactly one request for one slip use");
});

test("Codex round 51: encoded traversal in a form's action or a slip-matched URL is refused (unusual_path)", async () => {
  newHome();
  // "panel", not "admin": since round 94 "%2fadmin" also reads as the marker "2fa" (a login refusal first)
  const bad = ["/contact/..%2fpanel", "/contact/%2e%2e/admin", "/contact%5c..%5cadmin"];
  const { s, hits } = await pageWith(bad.map((a) => `<form method="post" action="${a}"><input name="a"></form>`).join(""));
  grant(s.url, { path: "/contact", uses: "5" });
  const r = await engine.read(s.url + "/page", {}, ctx);
  assert.deepEqual((r.untrusted_content as any).forms.map((f: any) => f.not_allowed), ["unusual_path", "unusual_path", "unusual_path"]);
  for (let i = 1; i <= 3; i++) assert.equal((await engine.formSubmit(s.url + "/page", i, { a: "1" }, "a".repeat(64), ctx)).form?.not_allowed, "unusual_path");
  assert.deepEqual(hits, []);
  for (const b of [...bad, "/contact/x\\..\\admin", "/contact/.%2E/admin"]) {
    assert.equal((slips.checkSlip("submit_form", s.url + b) as any).refused, "unusual_path", b);
    assert.equal((slips.claimSlip("submit_form", s.url + b, "form_submit") as any).refused, "unusual_path", b);
  }
  assert.equal(slips.list().items[0].uses_left, 5, "no use claimed");
  assert.ok("slip_id" in slips.checkSlip("submit_form", s.url + "/contact/send"));
});

test("Codex round 51: payment detection covers hidden fields and card-number values", async () => {
  newHome();
  const { s } = await pageWith(
    `<form method="post" action="/pay"><input type="hidden" name="card_number" value="1"><input type="hidden" name="cvv" value="2"><input name="a"></form>` +
      `<form method="post" action="/pay"><input type="hidden" name="ref" value="4111-1111-1111-1111"><input name="a"></form>` +
      `<form method="post" action="/pay"><input type="hidden" name="ref" value="4111-1111-1111-1112"><input name="a"></form>` +
      `<form method="post" action="/pay"><textarea name="t">4111111111111111</textarea></form>`,
  );
  const r = await engine.read(s.url + "/page", {}, ctx);
  assert.deepEqual((r.untrusted_content as any).forms.map((f: any) => f.not_allowed ?? null), ["payment", "payment", null, "payment"]);
});

test("Codex round 51: preview writes nothing even with Safe Browsing on and a missing or stale list", async () => {
  const home = newHome();
  const t = await site();
  let listHits = 0;
  const list = await serve((req, res) => (req.url === "/robots.txt" ? text(res, "") : (listHits++, text(res, "phish.example\n"))));
  servers.push(list);
  process.env.TIRESIAS_SAFE_BROWSING = "1";
  process.env.TIRESIAS_SAFETY_LIST_URL = list.url + "/list.txt";
  try {
    grant(t.s.url); // the store exists, with something in it
    const before = snapshot(home);
    const p = await engine.formPreview(t.s.url + "/contact", 1, CONTACT, ctx);
    assert.equal(p.status, "ok", p.message);
    assert.equal(listHits, 0, "no list download");
    assert.deepEqual(snapshot(home), before, "byte-identical: missing list");
    // A stale list: confirmed two days ago, so a normal call would download it again.
    const sb = await import("../safebrowsing.js");
    assert.equal((await sb.update()).status, "ok");
    assert.equal(listHits, 1);
    const file = path.join(home, "safety", "phishing-domains.txt");
    const raw = fs.readFileSync(file, "utf8");
    const nl = raw.indexOf("\n");
    const header = JSON.parse(raw.slice(0, nl));
    header.verified_at = new Date(Date.now() - 2 * 86_400_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(header) + raw.slice(nl));
    fs.rmSync(path.join(home, "safety", "attempt.json"), { force: true });
    const before2 = snapshot(home);
    const p2 = await engine.formPreview(t.s.url + "/contact", 1, CONTACT, ctx);
    assert.equal(p2.status, "ok", p2.message);
    assert.equal(p2.safety, "list_stale");
    assert.equal(listHits, 1, "no list download");
    assert.deepEqual(snapshot(home), before2, "byte-identical: stale list");
  } finally {
    process.env.TIRESIAS_SAFE_BROWSING = "0";
    delete process.env.TIRESIAS_SAFETY_LIST_URL;
  }
});

// ---- Codex round 52 ----

test("Codex round 52: a POST answered with a 302 loop sends exactly one request", async () => {
  newHome();
  const { s, hits } = await pageWith(`<form method="post" action="/loop"><input name="q"></form>`, (req, res) => {
    if (!(req.url ?? "").startsWith("/loop")) return false;
    req.resume();
    res.writeHead(302, { location: "/loop" });
    res.end();
    return true;
  });
  grant(s.url);
  const p = await engine.formPreview(s.url + "/page", 1, { q: "x" }, ctx);
  const r = await engine.formSubmit(s.url + "/page", 1, { q: "x" }, p.form!.preview_hash!, ctx);
  assert.equal(r.form?.reason, "redirect_not_followed");
  assert.deepEqual(hits, ["POST /loop"]);
});

test("Codex round 52: no '%' in a submit target's path or a slip-matched path (unusual_path); the query is free", async () => {
  newHome();
  // The last two have no "%" as written; the URL parser adds it (a space, a non-ASCII letter).
  const bad = ["/contact/%252e%252e%252fpanel", "/contact/%2e", "/contact/a%20b", "/contact/a b", "/contact/café"];
  const { s, hits } = await pageWith(bad.map((a) => `<form method="post" action="${a}"><input name="a"></form>`).join("") + `<form action="/contact/search"><input name="q"></form>`);
  grant(s.url, { path: "/contact", uses: "5" });
  const r = await engine.read(s.url + "/page", {}, ctx);
  assert.deepEqual((r.untrusted_content as any).forms.map((f: any) => f.not_allowed ?? null), ["unusual_path", "unusual_path", "unusual_path", "unusual_path", "unusual_path", null]);
  for (const b of bad) {
    assert.equal((slips.checkSlip("submit_form", s.url + b) as any).refused, "unusual_path", b);
    assert.equal((slips.claimSlip("submit_form", s.url + b, "form_submit") as any).refused, "unusual_path", b);
  }
  assert.equal(slips.list().items[0].uses_left, 5);
  // A query with % (an encoded value) is fine.
  const p = await engine.formPreview(s.url + "/page", 6, { q: "50% off" }, ctx);
  assert.equal(p.form?.slip?.covered, true, p.message);
  const sub = await engine.formSubmit(s.url + "/page", 6, { q: "50% off" }, p.form!.preview_hash!, ctx);
  assert.equal(sub.status, "ok", sub.message);
  assert.deepEqual(hits, ["GET /contact/search?q=50%25+off"]);
});

test("Codex round 52: a card number anywhere in the final request is refused as payment, whatever its source", async () => {
  newHome();
  const { s, hits } = await pageWith(
    `<form method="post" action="/a"><select name="ref"><option selected value="4111111111111111">Saved card</option></select></form>` +
      `<form method="post" action="/b"><input name="note"></form>`,
  );
  grant(s.url, { uses: "5" });
  const r = await engine.read(s.url + "/page", {}, ctx);
  const sel = await engine.formPreview(s.url + "/page", 1, {}, ctx);
  assert.equal(sel.form?.not_allowed, "payment", JSON.stringify((r.untrusted_content as any).forms[0]));
  for (const v of ["4111 1111 1111 1111", "pay 4111-1111-1111-1111 now"]) {
    const p = await engine.formPreview(s.url + "/page", 2, { note: v }, ctx);
    assert.equal(p.form?.not_allowed, "payment", v);
    assert.equal((await engine.formSubmit(s.url + "/page", 2, { note: v }, "a".repeat(64), ctx)).form?.not_allowed, "payment");
  }
  assert.equal((await engine.formPreview(s.url + "/page", 2, { note: "4111 1111 1111 1112" }, ctx)).status, "ok");
  assert.deepEqual(hits, []);
  assert.equal(slips.list().items[0].uses_left, 5);
});

test("Codex round 52: a visible field with a hidden field's name is refused (duplicate_names)", async () => {
  newHome();
  const { s } = await pageWith(
    `<form method="post" action="/x"><input type="hidden" name="role" value="user"><input name="role"></form>` +
      `<form method="post" action="/x"><input name="role"><input type="hidden" name="role" value="user"></form>`,
  );
  const r = await engine.read(s.url + "/page", {}, ctx);
  assert.deepEqual((r.untrusted_content as any).forms.map((f: any) => f.not_allowed), ["duplicate_names", "duplicate_names"]);
});

// ---- Codex round 53: allow-lists ----

test("Codex round 53: paths are allow-listed (form actions, slip matching and slip grants); /contact/..;/admin is refused", async () => {
  newHome();
  // "/contact/x/../y" fails only as written (the parser removes the dots).
  const bad = ["/contact/..;/admin", "/contact/a;b", "/contact//x", "/contact/a..b/x", "/contact/x!", "/contact/x/../y"];
  const good = ["send.php", "/contact/send-1_~x.v2/"];
  const { s, hits } = await pageWith([...bad, ...good].map((a) => `<form method="post" action="${a}"><input name="a"></form>`).join(""));
  grant(s.url, { path: "/contact", uses: "5" });
  const r = await engine.read(s.url + "/page", {}, ctx);
  assert.deepEqual((r.untrusted_content as any).forms.map((f: any) => f.not_allowed ?? null), [...bad.map(() => "unusual_path"), null, null]);
  for (let i = 1; i <= bad.length; i++) assert.equal((await engine.formSubmit(s.url + "/page", i, { a: "1" }, "a".repeat(64), ctx)).form?.not_allowed, "unusual_path");
  for (const b of bad) {
    assert.equal((slips.checkSlip("submit_form", s.url + b) as any).refused, "unusual_path", b);
    assert.equal((slips.claimSlip("submit_form", s.url + b, "form_submit") as any).refused, "unusual_path", b);
  }
  assert.deepEqual(hits, []);
  assert.equal(slips.list().items[0].uses_left, 5);
  for (const p of ["/contact;x", "/a!b", "/a$b"]) assert.throws(() => grant(s.url, { path: p }), /--path/, p);
  // A plain action that resolves, through <base href>, to a path that is not plain fails only after parsing.
  const based = await pageWith(`<base href="/a;b/"><form method="post" action="send"><input name="a"></form>`);
  assert.equal(((await engine.read(based.s.url + "/page", {}, ctx)).untrusted_content as any).forms[0].not_allowed, "unusual_path");
  // A plain path still works end to end.
  const p = await engine.formPreview(s.url + "/page", bad.length + 2, { a: "1" }, ctx);
  const sub = await engine.formSubmit(s.url + "/page", bad.length + 2, { a: "1" }, p.form!.preview_hash!, ctx);
  assert.equal(sub.status, "ok", sub.message);
});

test("Codex round 53: field names are allow-listed; a hidden role&#10;x and a visible role&#13;x make the form bad_field_name", async () => {
  newHome();
  const { s } = await pageWith(
    `<form method="post" action="/x"><input type="hidden" name="role&#10;x" value="user"><input name="role&#13;x"></form>` +
      `<form method="post" action="/x"><input name="a b"></form>` +
      `<form method="post" action="/x"><input type="hidden" name="t&amp;k" value="1"><input name="a"></form>` +
      `<form method="post" action="/x"><input name="user[name]"><input name="ns:x.y-z_1"></form>`,
  );
  const r = await engine.read(s.url + "/page", {}, ctx);
  assert.deepEqual((r.untrusted_content as any).forms.map((f: any) => f.not_allowed ?? null), ["bad_field_name", "bad_field_name", "bad_field_name", null]);
});

test("Codex round 53: the payment check covers the whole request, the action's query of a POST included", async () => {
  newHome();
  const { s, hits } = await pageWith(`<form method="post" action="/contact/pay?ref=4111111111111111"><input name="a"></form><form method="post" action="/contact/pay?ref=4111111111111112"><input name="a"></form>`);
  grant(s.url, { uses: "5" });
  const p = await engine.formPreview(s.url + "/page", 1, { a: "1" }, ctx);
  assert.equal(p.form?.not_allowed, "payment");
  assert.equal((await engine.formSubmit(s.url + "/page", 1, { a: "1" }, "a".repeat(64), ctx)).form?.not_allowed, "payment");
  assert.deepEqual(hits, []);
  assert.equal(slips.list().items[0].uses_left, 5);
  assert.equal((await engine.formPreview(s.url + "/page", 2, { a: "1" }, ctx)).status, "ok", "a number failing Luhn is fine");
});

// ---- Codex round 54 ----

test("Codex round 54: names that collide the way servers rename them are duplicate_names (fields, and a POST target's query)", async () => {
  newHome();
  const { s } = await pageWith(
    `<form method="post" action="/x"><input type="hidden" name="role_flag" value="user"><input name="role.flag"></form>` +
      `<form method="post" action="/x"><input name="Role"><input type="hidden" name="role" value="u"></form>` +
      `<form method="post" action="/x"><input name="user[name]"><input name="user_name_"></form>` +
      `<form method="post" action="/x?Role=admin"><input type="hidden" name="role" value="user"><input name="a"></form>` +
      `<form method="post" action="/x?other=1"><input type="hidden" name="role" value="user"><input name="a"></form>`,
  );
  const r = await engine.read(s.url + "/page", {}, ctx);
  assert.deepEqual((r.untrusted_content as any).forms.map((f: any) => f.not_allowed ?? null), ["duplicate_names", "duplicate_names", "duplicate_names", "duplicate_names", null]);
});

test("Codex round 54: a POST form with no action of its own is refused when the page address has a query (query_on_page)", async () => {
  newHome();
  const { s, hits } = await pageWith(`<form method="post"><input type="hidden" name="role" value="user"><input name="a"></form><form method="post" action="#f"><input name="a"></form>`);
  grant(s.url, { uses: "5" });
  const q = await engine.read(s.url + "/page?%72ole=admin", {}, ctx);
  assert.deepEqual((q.untrusted_content as any).forms.map((f: any) => f.not_allowed ?? null), ["query_on_page", "query_on_page"]);
  assert.equal((await engine.formSubmit(s.url + "/page?%72ole=admin", 1, { a: "1" }, "a".repeat(64), ctx)).form?.not_allowed, "query_on_page");
  assert.deepEqual(hits, []);
  // Without a query the same form works.
  const p = await engine.formPreview(s.url + "/page", 1, { a: "1" }, ctx);
  assert.equal(p.status, "ok", p.message);
  assert.equal((await engine.formSubmit(s.url + "/page", 1, { a: "1" }, p.form!.preview_hash!, ctx)).status, "ok");
});

test("Codex round 54 (v0.9: withheld, not masked): a hidden value the site echoes back (in a Location or in the page) withholds the whole answer", async () => {
  const home = newHome();
  const tokenOf = (body: string) => new URLSearchParams(body).get("csrf") ?? "";
  const { s } = await pageWith(
    `<form method="post" action="/loc"><input type="hidden" name="csrf" value="tok-{N}-abcdefgh"><input name="a"></form>` +
      `<form method="post" action="/echo"><input type="hidden" name="csrf" value="tok-{N}-abcdefgh"><input name="a"></form>`,
    (req, res) => {
      const p = req.url ?? "";
      if (req.method !== "POST" || (p !== "/loc" && p !== "/echo")) return false;
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const t = tokenOf(body);
        if (p === "/loc") return void (res.writeHead(302, { location: `/done?t=${encodeURIComponent(t)}` }), res.end());
        html(res, `<html><head><title>Saved</title></head><body><h1>Saved</h1><p>Your token was ${t} and it worked.</p><p>Thank you for writing.</p></body></html>`);
      });
      return true;
    },
  );
  grant(s.url, { uses: "5" });
  const p1 = await engine.formPreview(s.url + "/page", 1, { a: "1" }, ctx);
  const r1 = await engine.formSubmit(s.url + "/page", 1, { a: "1" }, p1.form!.preview_hash!, ctx);
  assertWithheld(r1, 302);
  const p2 = await engine.formPreview(s.url + "/page", 2, { a: "1" }, ctx);
  const r2 = await engine.formSubmit(s.url + "/page", 2, { a: "1" }, p2.form!.preview_hash!, ctx);
  assertWithheld(r2, 200);
  const txt = JSON.stringify([r1, r2]);
  assert.doesNotMatch(txt, /abcdefgh/);
  assert.doesNotMatch(allText(home), /abcdefgh/, "nothing stored holds the token");
});

test("Codex rounds 55 and 56: a hidden value that is not plain printable ASCII is refused (bad_hidden_value); nothing is sent", async () => {
  newHome();
  const { s, hits } = await pageWith(
    `<form method="post" action="/loc"><input type="hidden" name="csrf" value="secret&#10;abcdef"><input name="a"></form>` +
      `<form method="post" action="/loc"><input type="hidden" name="csrf" value="secret abcdef"><input name="a"></form>` +
      `<form method="post" action="/loc"><input type="hidden" name="csrf" value="sécret"><input name="a"></form>` +
      `<form method="post" action="/loc"><input type="hidden" name="csrf" value="a+b/c=xyz!~"><input name="a"></form>`,
  );
  grant(s.url, { uses: "5" });
  const r = await engine.read(s.url + "/page", {}, ctx);
  assert.deepEqual((r.untrusted_content as any).forms.map((f: any) => f.not_allowed ?? null), ["bad_hidden_value", "bad_hidden_value", "bad_hidden_value", null]);
  assert.equal((await engine.formSubmit(s.url + "/page", 1, { a: "1" }, "a".repeat(64), ctx)).form?.not_allowed, "bad_hidden_value");
  assert.deepEqual(hits, []);
});

test("Codex round 56 (v0.9: withheld): a token with symbols echoed in a Location, in HTML text and in quotes withholds the answer and is never stored", async () => {
  const home = newHome();
  const TOKEN = "a+b/c=xyz&q<1>~!(x)"; // ~ ! ( ) make the form-urlencoded and percent-encoded spellings differ
  const esc = TOKEN.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const { s } = await pageWith(
    `<form method="post" action="/loc"><input type="hidden" name="csrf" value="${esc}"><input name="a"></form>` +
      `<form method="post" action="/echo"><input type="hidden" name="csrf" value="${esc}"><input name="a"></form>`,
    (req, res) => {
      if (req.method !== "POST" || (req.url !== "/loc" && req.url !== "/echo")) return false;
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const t = new URLSearchParams(body).get("csrf")!;
        if (req.url === "/loc") return void (res.writeHead(302, { location: `/done?a=${encodeURIComponent(t)}&b=${new URLSearchParams({ x: t }).toString().slice(2)}` }), res.end());
        const h = t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        html(res, `<html><head><title>Saved</title></head><body><h1>Saved</h1><p>Your token was ${h} and it worked.</p><p>Thank you for writing.</p></body></html>`);
      });
      return true;
    },
  );
  grant(s.url, { uses: "5" });
  const p1 = await engine.formPreview(s.url + "/page", 1, { a: "1" }, ctx);
  assert.equal(p1.status, "ok", p1.message);
  const r1 = await engine.formSubmit(s.url + "/page", 1, { a: "1" }, p1.form!.preview_hash!, ctx);
  assertWithheld(r1, 302);
  const p2 = await engine.formPreview(s.url + "/page", 2, { a: "1" }, ctx);
  const r2 = await engine.formSubmit(s.url + "/page", 2, { a: "1" }, p2.form!.preview_hash!, ctx);
  assertWithheld(r2, 200);
  const all = JSON.stringify([r1, r2]) + allText(home);
  for (const form of [TOKEN, encodeURIComponent(TOKEN), new URLSearchParams({ x: TOKEN }).toString().slice(2), esc]) assert.ok(!all.includes(form), form);
});

for (const [label, SET, SID] of [["", "sess-COOKIEVALUE-12345", "sess-COOKIEVALUE-12345"], [" (round 3c: quoted)", '"sess-COOKIEVALUE-12345"', "sess-COOKIEVALUE-12345"]] as const)
test(`Codex v0.9 hardening round 2c (HIGH; v0.9 item B: withheld): a cookie the site set while the form was fetched withholds the answer that echoes it${label}`, async () => {
  const home = newHome();
  const { s } = await pageWith(
    `<form method="post" action="/loc"><input name="a"></form><form method="post" action="/echo"><input name="a"></form>`,
    (req, res) => {
      const p = req.url ?? "";
      if (req.method === "GET" && p.split("?")[0] === "/page") {
        res.setHeader("set-cookie", `sid=${SET}; Path=/`);
        return false; // the page itself is served as usual, with the cookie
      }
      if (req.method !== "POST" || (p !== "/loc" && p !== "/echo")) return false;
      const sid = (/sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "none").replace(/^"|"$/g, ""); // the token, as a site would echo it
      req.resume();
      req.on("end", () => {
        if (p === "/loc") return void (res.writeHead(302, { location: `/done?s=${encodeURIComponent(sid)}` }), res.end());
        html(res, `<html><head><title>Saved</title></head><body><h1>Saved</h1><p>Your session was ${sid} and it worked.</p><p>Thank you for writing.</p></body></html>`);
      });
      return true;
    },
  );
  grant(s.url, { uses: "5" });
  const p1 = await engine.formPreview(s.url + "/page", 1, { a: "1" }, ctx);
  const r1 = await engine.formSubmit(s.url + "/page", 1, { a: "1" }, p1.form!.preview_hash!, ctx);
  assertWithheld(r1, 302);
  const p2 = await engine.formPreview(s.url + "/page", 2, { a: "1" }, ctx);
  const r2 = await engine.formSubmit(s.url + "/page", 2, { a: "1" }, p2.form!.preview_hash!, ctx);
  assertWithheld(r2, 200);
  assert.doesNotMatch(JSON.stringify([r1, r2]), /COOKIEVALUE/);
  assert.doesNotMatch(allText(home), /COOKIEVALUE/, "nothing stored holds the cookie");
});

// v0.9 (Travis, item B, option (b)): one check of the raw answer, not a list of spellings. Every spelling the
// hardening rounds found (2c cookies, 3c quoted cookies, 4b lowercase escapes, 4c truncation and parser
// whitespace) and more come back withheld; an answer without the secret, or with only a short value, is shown.
test("v0.9 item B: every spelling of an echoed secret withholds the whole answer; a clean answer and a short value are shown", async () => {
  const home = newHome();
  const T = "Tok-Abc123/xyz+QRS=~!";
  const BIG = "fj" + "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(3).slice(0, 174); // 176 characters, past the 120-character preview
  const COOKIE = "Sess Value  With   Spaces-99";
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const pct = (v: string) => [...Buffer.from(v)].map((b) => "%" + b.toString(16).padStart(2, "0")).join("");
  const mixed = (v: string) => pct(v).replace(/%([0-9a-f])([0-9a-f])/g, (_m, a: string, b: string) => `%${a.toUpperCase()}${b}`);
  let mode = "none";
  const page = (body: string) => `<html><head><title>Saved</title></head><body><h1>Saved</h1><p>${body}</p><p>Thank you for writing to us today.</p></body></html>`;
  const answers: Record<string, (res: http.ServerResponse) => void> = {
    raw: (res) => html(res, page(`Your token was ${T} and it worked.`)),
    lower_percent: (res) => html(res, page(`See /done?t=${encodeURIComponent(T).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())}`)),
    mixed_percent: (res) => html(res, page(`See /done?t=${mixed(T)}`)),
    double_percent: (res) => html(res, page(`See /done?t=${encodeURIComponent(encodeURIComponent(T))}`)),
    form_encoded: (res) => html(res, page(`See /done?${new URLSearchParams({ t: T })}`)),
    decimal_entities: (res) => html(res, page([...T].map((c) => `&#${c.codePointAt(0)}`).join(""))),
    hex_entities: (res) => html(res, page([...T].map((c) => `&#X${c.codePointAt(0)!.toString(16).toUpperCase()};`).join(""))),
    named_entities: (res) => html(res, page(esc(T).replace(/\//g, "&sol;").replace(/=/g, "&equals;"))),
    json_escapes: (res) => (res.writeHead(200, { "content-type": "application/json" }), res.end(`{"token":"${[...T].map((c) => "\\u" + c.codePointAt(0)!.toString(16).padStart(4, "0")).join("")}","ok":true}`)),
    upper_case: (res) => html(res, page(`TOKEN ${T.toUpperCase()}`)),
    header_only: (res) => html(res, page("Saved, thank you."), { "x-echo": T }),
    split_by_tags: (res) => html(res, page(`<b>${esc(T.slice(0, 7))}</b><i>${esc(T.slice(7))}</i>`)),
    zero_width: (res) => html(res, page([...T].join("​"))),
    long_truncated: (res) => html(res, page(`Your long token was ${BIG}`)),
    long_decimal_zeroes: (res) => html(res, page([...BIG].map((c) => `&#${String(c.codePointAt(0)).padStart(20, "0")};`).join(""))),
    long_hex_zeroes: (res) => html(res, page([...BIG].map((c) => `&#x${c.codePointAt(0)!.toString(16).padStart(20, "0")};`).join(""))),
    long_named_entity: (res) => html(res, page("&fjlig;" + BIG.slice(2))),
    long_split_by_tags: (res) => html(res, page(`<b>${BIG.slice(0, 50)}</b><i>${BIG.slice(50)}</i>`)),
    cookie_whitespace: (res) => html(res, page(`Session: ${COOKIE.replace(/ +/g, "\n\t ")}`)),
    cookie_quoted: (res) => html(res, page(`Session: "${COOKIE}"`)),
    plain_text: (res) => text(res, `token=${T}`),
    big_page: (res) => html(res, page("Lots of ordinary words here. ".repeat(2000) + T)), // past 8 KB: checked in the worker
    location_lower: (res) => (res.writeHead(302, { location: `/done?t=${pct(T)}` }), res.end()),
    short_value: (res) => html(res, page("Your code abc12 was saved.")),
    none: (res) => html(res, page("Your message was saved.")),
  };
  const { s } = await pageWith(
    `<form method="post" action="/echo"><input type="hidden" name="csrf" value="${esc(T)}"><input type="hidden" name="big" value="${BIG}"><input name="a"></form>` +
      `<form method="post" action="/echo"><input type="hidden" name="code" value="abc12"><input name="a"></form>`,
    (req, res) => {
      const p = req.url ?? "";
      if (req.method === "GET" && p.split("?")[0] === "/page" && mode !== "short_value") {
        res.setHeader("set-cookie", `sid=${COOKIE}; Path=/`);
        return false;
      }
      if (req.method !== "POST" || p !== "/echo") return false;
      req.resume();
      req.on("end", () => answers[mode](res));
      return true;
    },
  );
  grant(s.url, { uses: "50" });
  const submit = async (form: number) => {
    const p = await engine.formPreview(s.url + "/page", form, { a: "1" }, ctx);
    assert.equal(p.status, "ok", p.message);
    return engine.formSubmit(s.url + "/page", form, { a: "1" }, p.form!.preview_hash!, ctx);
  };
  for (const m of Object.keys(answers).filter((k) => k !== "none" && k !== "short_value")) {
    mode = m;
    const r = await submit(1);
    try {
      assertWithheld(r, m === "location_lower" ? 302 : 200);
    } catch (e) {
      throw new Error(`${m}: ${(e as Error).message}\n${JSON.stringify(r).slice(0, 600)}`);
    }
  }
  mode = "none";
  const clean = await submit(1);
  assert.equal(clean.status, "ok", clean.message);
  assert.equal(clean.form?.reason, undefined);
  assert.ok(clean.counts!.receipts > 0);
  assert.match(JSON.stringify(clean.untrusted_content), /Your message was saved/);
  mode = "short_value";
  const short = await submit(2);
  assert.equal(short.form?.reason, undefined, "a value under 6 characters is not checked");
  assert.match(JSON.stringify(short.untrusted_content), /abc12/);
  const stored = allText(home);
  for (const v of [T, BIG.slice(0, 40), "Sess Value", encodeURIComponent(T)]) assert.ok(!stored.includes(v), `nothing stored holds ${v}`);
});

test("9.24: the minimum secret length applies before canonicalization, including symbols-only values", async () => {
  const { holdsSecret, secretsOf } = await import("../echo.js");
  for (const [value, encoded] of [
    ['ab"\\+c', "&#97;&#98;&#99;"],
    ['"""""a', "%61"],
  ]) {
    const secrets = secretsOf([value]);
    assert.ok(secrets.canon.length > 0);
    assert.equal(holdsSecret([encoded], secrets), true);
  }
  assert.deepEqual(secretsOf(['"\\+"\'`']).canon, [], "an empty canonical form is never a universal match");
  assert.equal(holdsSecret(["abc12"], secretsOf(["abc12"])), false, "short original values stay exempt");
});

test("9.25: echo decoding agrees with the reader for numeric and named HTML references", async () => {
  const { canonical, holdsSecret, secretsOf } = await import("../echo.js");
  const { Parser } = await import("htmlparser2");
  for (const encoded of [
    "&#00000000000000000097;bcdef", "&#x000000000000000061;bcdef", "&#00000000000000000097bcdef",
    "&Omega;bcdef", "&fjlig;bcdef", "&CounterClockwiseContourIntegral;bcdef", "&NotEqualTilde;bcdef", "&Afr;bcdef",
    "&#128;bcdef", "&#xD800;bcdef", "&copybcdef",
  ]) {
    let decoded = "";
    new Parser({ ontext: (s) => { decoded += s; } }).end(encoded);
    assert.notEqual(decoded, encoded, encoded);
    assert.equal(canonical(encoded), canonical(decoded), encoded);
    assert.equal(holdsSecret([encoded], secretsOf([decoded])), true, encoded);
  }
});

test("v0.9 item B (Codex client-trust round 1): the echo matcher stays linear on hostile text; no Unicode normalization", async () => {
  const { holdsSecret, secretsOf, canonical } = await import("../echo.js");
  assert.equal(canonical("ＴＯＫＥＮ"), "ｔｏｋｅｎ", "no NFKC: fullwidth letters are not folded");
  const hostile = "a" + "\u0301\u0300\u0327\u0328".repeat(500_000) + "%25".repeat(200_000) + "&#x".repeat(200_000) + "&#" + "0".repeat(500_000) + "97;";
  const t0 = Date.now();
  assert.equal(holdsSecret([hostile], secretsOf(["Tok-Abc123/xyz"])), false);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});
