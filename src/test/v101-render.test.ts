// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { freshHome, neverAsk, serve, text, html } from "./helper.js";
import { read } from "../engine.js";
import { cachePath, readJson, writeJson, sha256 } from "../store.js";
import type { CacheEntry } from "../pagecache.js";
import { parseHtml } from "../reader.js";

const home = freshHome();
neverAsk(home);
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
const mode = (rendering: string) => fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ rendering }));

test("fresh cache honors current rendering settings and explicit render requests", async () => {
  const s = await serve((req, res) => req.url === "/robots.txt" ? text(res, "", 404) : html(res, '<html><body><script>void 0</script></body></html>', { "cache-control": "max-age=3600", etag: '"shell"' }));
  const oldChrome = process.env.TIRESIAS_CHROME;
  process.env.TIRESIAS_CHROME = path.join(home, "missing-chrome");
  try {
    const url = s.url + "/shell";
    mode("off");
    await read(url);
    mode("auto");
    const auto = await read(url);
    assert.equal(auto.render?.status, "unavailable", JSON.stringify(auto));
    assert.equal(s.count("/shell"), 2);
    assert.equal(s.hits.filter((h) => h.path === "/shell")[1].headers["if-none-match"], undefined);
    const copy = readJson<CacheEntry>(cachePath(url))!;
    copy.rendered = true;
    copy.render_hash = "rendered-hash";
    copy.plain_hash = copy.hash;
    copy.hash = sha256(`${copy.hash}|rendered:${copy.render_hash}`);
    copy.render_inspection = { walls: "rendered", hidden_text: "rendered" };
    copy.parsed = parseHtml("<p>RENDEREDONLY</p>", url);
    writeJson(cachePath(url), copy);
    mode("ask");
    const allowed = await read(url, { render: true, page: 1 });
    assert.equal(allowed.cache, "fresh");
    assert.equal(allowed.render?.status, "cached");
    mode("off");
    const denied = await read(url, { render: true, page: 1 });
    assert.equal(denied.render?.status, "not_allowed");
    assert.doesNotMatch(JSON.stringify(denied.untrusted_content), /RENDEREDONLY/);
    const plain = await read(url, { render: true, page: 1 });
    assert.equal(plain.cache, "fresh");
    assert.equal(plain.render?.status, "not_allowed");
  } finally {
    if (oldChrome === undefined) delete process.env.TIRESIAS_CHROME;
    else process.env.TIRESIAS_CHROME = oldChrome;
    await s.close();
  }
});

test("disabled rendering refetches plain content without rendered validators", async () => {
  const s = await serve((req, res) => {
    if (req.url === "/robots.txt") return text(res, "", 404);
    html(res, "<p>PLAINCONTENT</p>", { "cache-control": "max-age=3600", etag: '"page"' }, req.headers["if-none-match"] ? 304 : 200);
  });
  try {
    mode("off");
    const url = s.url + "/page";
    await read(url);
    const copy = readJson<CacheEntry>(cachePath(url))!;
    copy.rendered = true;
    copy.render_hash = "rendered";
    copy.plain_hash = copy.hash;
    copy.hash = sha256(`${copy.hash}|rendered:${copy.render_hash}`);
    copy.render_inspection = { walls: "rendered", hidden_text: "rendered" };
    copy.parsed = parseHtml("<p>RENDEREDONLY</p>", url);
    writeJson(cachePath(url), copy);
    const reply = await read(url, { fresh: true, page: 1 });
    assert.match(JSON.stringify(reply.untrusted_content), /PLAINCONTENT/);
    assert.doesNotMatch(JSON.stringify(reply.untrusted_content), /RENDEREDONLY/);
    assert.equal(s.hits.filter((h) => h.path === "/page")[1].headers["if-none-match"], undefined);
    assert.equal(reply.render, undefined);
  } finally {
    await s.close();
  }
});

test("markdown twin selection preserves the query while changing the pathname", async () => {
  const { pickSource } = await import("../pipeline.js");
  for (const [page, twin] of [
    ["https://example.com/guide?lang=en", "https://example.com/guide.md?lang=en"],
    ["https://example.com/guide/?lang=en", "https://example.com/guide.md?lang=en"],
    ["https://example.com/guide/?lang=en", "https://example.com/guide/index.html.md?lang=en"],
    ["https://example.com/guide?lang=en#part", "https://example.com/guide.md?lang=en"],
  ]) {
    const result = pickSource(new URL(page), { llms_md: [twin] } as any);
    assert.equal(result.source, twin);
    assert.equal(result.detail, "markdown");
  }
});
