// SPDX-License-Identifier: Apache-2.0
// v1.2: two reader faults found on Wikipedia during the local model deep dive. All requests stay local.
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { after, test } from "node:test";
import { freshHome, neverAsk, serve, text } from "./helper.js";
import { parseHtml } from "../reader.js";

const home = freshHome();
neverAsk(home);
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
const engine = await import("../engine.js");
const ctx = { agent: "v12-reading" };
const uc = (e: { untrusted_content: unknown }) => e.untrusted_content as Record<string, any>;
after(async () => (await import("../sandbox.js")).stopWorker());

const ARTICLE = "<h1>Oedipus</h1><p>Oedipus was a mythical Greek king of Thebes. A tragic hero in Greek mythology, he fulfilled a prophecy that he would end up killing his father and marrying his mother.</p>";

test("v1.2: a boilerplate word on <html> or <body> does not drop the page", () => {
  const url = "https://site.example/wiki/Oedipus";
  for (const root of [
    '<html class="client-nojs vector-feature-main-menu-pinned-disabled"><body>',
    '<html><body class="has-sidebar cookie-consent-shown">',
    '<html id="nav"><body id="menu">',
    '<html role="banner"><body role="navigation">',
  ]) {
    const p = parseHtml(`${root}${ARTICLE}</body></html>`, url);
    assert.ok(p.text_chars > 100, root);
    assert.match(JSON.stringify(p.sections), /mythical Greek king of Thebes/, root);
  }
  // The same words on a part of the page still mark that part as boilerplate.
  const p = parseHtml(`<html><body><div class="main-menu"><p>Donate to the site today and read about our other projects here.</p></div>${ARTICLE}</body></html>`, url);
  assert.match(JSON.stringify(p.sections), /mythical Greek king of Thebes/);
  assert.doesNotMatch(JSON.stringify(p.sections), /Donate to the site/);
});

test("v1.2: a layout word on the wrapper around the content does not drop the content", () => {
  const url = "https://site.example/guide";
  const body = "<h1>Introduction</h1>" + "<p>Vue is a JavaScript framework for building user interfaces. It builds on top of standard HTML, CSS, and JavaScript.</p>".repeat(4);
  const side = '<aside class="sidebar"><p>Sponsors: become a sponsor of the project today and get your logo here.</p></aside>';
  // The wrappers seen in the v1.2 survey (vuejs.org, usa.gov, craigslist.org, zillow.com, substack.com, kayak.com).
  for (const open of [
    '<div class="VPContent has-sidebar" id="VPContent">',
    '<main class="main-content usa-layout-docs no-footer-gap" id="main-content">',
    '<section class="page-container flexed-footer">',
    '<div class="with-product-nav__wrapper">',
    '<div class="reader-nav-root reader2-font-base">',
    '<div class="JjjA-main JjjA-new-nav-breakpoints" id="main">',
  ]) {
    const close = `</${/^<(\w+)/.exec(open)![1]}>`;
    const p = parseHtml(`<html><body>${open}${side}${body}${close}</body></html>`, url);
    const shownText = JSON.stringify(p.sections);
    assert.match(shownText, /Vue is a JavaScript framework/, open);
    assert.doesNotMatch(shownText, /become a sponsor/, open); // the real sidebar inside the wrapper is still boilerplate
  }
  // A region that is what its name says stays boilerplate: a small nav, and a cookie box however large.
  const nav = parseHtml(`<html><body><div class="site-nav"><p>Home, Docs, Blog, About, Pricing, Careers, Contact</p></div>${body}</body></html>`, url);
  assert.doesNotMatch(JSON.stringify(nav.sections), /Pricing, Careers/);
  const cookie = parseHtml(`<html><body><div class="cookie-banner"><p>${"We use cookies to improve your experience on this site. ".repeat(10)}</p></div><p>Loading.</p><script src="/app.js"></script></body></html>`, url);
  assert.doesNotMatch(JSON.stringify(cookie.sections), /We use cookies/);
  assert.ok(cookie.text_chars < 200); // so a script-only page behind a consent box still reads as a shell
  // A wrapper that also carries a non-layout word is not rescued.
  const mixed = parseHtml(`<html><body><div class="modal has-sidebar">${body}</div></body></html>`, url);
  assert.doesNotMatch(JSON.stringify(mixed.sections), /Vue is a JavaScript framework/);
  // Codex round 1, MEDIUM: a menu that is most of a script-only page is still the menu, and the page is still a shell.
  const menuShell = parseHtml(`<html><body><div class="nav"><a href="/">${"Home ".repeat(50)}</a></div><div id="app">Loading.</div><script src="/app.js"></script></body></html>`, url);
  assert.ok(menuShell.text_chars < 200, String(menuShell.text_chars));
  // Codex round 1, LOW: a long <nav> beside the article does not keep the article's wrapper under half.
  const beside = parseHtml(`<html><body><div class="has-sidebar"><p>${"Article ".repeat(60)}</p></div><nav>${"Navigation ".repeat(100)}</nav></body></html>`, url);
  assert.ok(beside.text_chars > 400, String(beside.text_chars));
  assert.doesNotMatch(JSON.stringify(beside.sections), /Navigation Navigation/);
  // Codex round 3: an article inside one big link is still the article, with or without an href on the link.
  const story = "Article text about the history of Thebes. ".repeat(15);
  for (const a of ['<a href="/story">', '<a id="story">']) {
    const linked = parseHtml(`<html><body><div class="has-sidebar">${a}<article><p>${story}</p></article></a></div><script src="/app.js"></script></body></html>`, url);
    assert.ok(linked.text_chars > 600, `${a} ${linked.text_chars}`);
  }
  const anchored = parseHtml(`<html><body><div class="has-sidebar"><a id="story"><p>${story}</p></a></div></body></html>`, url);
  assert.ok(anchored.text_chars > 600, String(anchored.text_chars)); // a named anchor is not link text
  // Codex round 3: a cookie box inside the menu does not dilute the menu's share of links, so the page is still a shell.
  const diluted = parseHtml(`<html><body><div class="nav"><a href="/">${"Home ".repeat(50)}</a><div class="cookie-banner">${"We use cookies. ".repeat(100)}</div></div><div id="app">Loading.</div><script src="/app.js"></script></body></html>`, url);
  assert.ok(diluted.text_chars < 200, String(diluted.text_chars));
  // A teaser written as an <article> inside a real sidebar does not rescue the sidebar.
  const teaser = parseHtml(`<html><body><div class="sidebar"><article><p>Related: ten more stories you might like to read after this one.</p></article></div>${body}</body></html>`, url);
  assert.match(JSON.stringify(teaser.sections), /Vue is a JavaScript framework/);
  assert.doesNotMatch(JSON.stringify(teaser.sections), /ten more stories/);
  // A role is the page's own statement about the element and is always believed.
  const role = parseHtml(`<html><body><div role="navigation" class="has-sidebar">${body}</div></body></html>`, url);
  assert.doesNotMatch(JSON.stringify(role.sections), /Vue is a JavaScript framework/);
});

test("v1.2: a 304 that repeats Content-Encoding has no body to decompress", async () => {
  const page = zlib.gzipSync(`<html><body>${ARTICLE}</body></html>`);
  let conditional = 0;
  const srv = await serve((req, res) => {
    if (req.url !== "/wiki/Oedipus") return text(res, "", 404);
    if (req.headers["if-none-match"]) {
      conditional++;
      res.writeHead(304, { "content-encoding": "gzip", etag: '"v1"', "cache-control": "max-age=0, must-revalidate" });
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip", etag: '"v1"', "cache-control": "max-age=0, must-revalidate" });
    res.end(page);
  });
  try {
    const first = await engine.read(srv.url + "/wiki/Oedipus", { section: 1 }, ctx);
    assert.equal(first.status, "ok");
    const again = await engine.read(srv.url + "/wiki/Oedipus", { section: 1 }, ctx);
    assert.equal(again.status, "unchanged", again.message); // before the fix: error, "could not be read"
    assert.equal(conditional, 1);
    assert.match(JSON.stringify(uc(again)), /mythical Greek king of Thebes/);
  } finally {
    await srv.close();
  }
});
