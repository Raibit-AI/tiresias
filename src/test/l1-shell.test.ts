// SPDX-License-Identifier: Apache-2.0
// v1.2: frozen shell decisions and real engine reads, without requiring Chrome or external sites.
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";
import type { CacheEntry } from "../pagecache.js";
import { looksLikeShell } from "../render.js";
import { freshHome, html, neverAsk, serve, text } from "./helper.js";

const home = freshHome();
neverAsk(home);
process.env.TIRESIAS_ALLOW_PRIVATE = "1";
process.env.TIRESIAS_RENDERING = "off";
process.env.TIRESIAS_CHROME = "/nonexistent/chrome";
const engine = await import("../engine.js");
const { cachePath, readJson, writeJson } = await import("../store.js");
const fixture = JSON.parse(fs.readFileSync(new URL("../../src/test/fixtures/l1-shell-before.json", import.meta.url), "utf8")) as {
  shell_note: string;
  cases: { id: string; html: string; before: { text_chars: number; links: number; shell: boolean; shell_note: boolean; auto_render: string | null } }[];
};
const changed = new Set(["example-domain", "prose-80", "links-20", "links-100", "wrapper-link-cap"]);
const cases = new Map(fixture.cases.map(c => [`/${c.id}`, c]));
const srv = await serve((req, res) => {
  const c = cases.get(req.url ?? "");
  if (!c) return text(res, "", 404);
  if (req.headers["if-none-match"]) {
    res.writeHead(304, { "cache-control": "max-age=600" });
    return res.end();
  }
  html(res, c.html, { "cache-control": "max-age=600", etag: '"shell-test"' });
});
after(async () => {
  await srv.close();
  (await import("../sandbox.js")).stopWorker();
});

for (const c of fixture.cases) {
  test(`L.1: frozen ${c.id}: ${changed.has(c.id) ? "content, no shell note or automatic render" : "same shell decision"}`, async () => {
    const url = `${srv.url}/${c.id}`;
    const shell = changed.has(c.id) ? false : c.before.shell;
    process.env.TIRESIAS_RENDERING = "off";
    const out = await engine.read(url, { page: 1 });
    assert.equal(out.status, "ok", out.message);
    const entry = readJson<CacheEntry>(cachePath(url))!;
    assert.equal(entry.parsed.text_chars, c.before.text_chars);
    assert.equal(entry.parsed.links.length, c.before.links);
    assert.equal(looksLikeShell(entry.parsed, /<script\b/i.test(c.html)), shell);
    assert.equal(entry.shell === true, shell);
    assert.equal(out.message?.includes(fixture.shell_note) ?? false, shell);
    if (changed.has(c.id)) {
      assert.equal(c.before.shell, true);
      assert.equal(c.before.shell_note, true);
      assert.equal(c.before.auto_render, "unavailable");
    }
    if (c.id === "example-domain") {
      const section = await engine.read(url, { section: 1 });
      assert.match(JSON.stringify(section.untrusted_content), /This domain is for use in documentation examples/);
      assert.doesNotMatch(section.message ?? "", /JavaScript-only shell/);
    }
    process.env.TIRESIAS_RENDERING = "auto";
    const auto = await engine.read(url, { page: 1, fresh: true });
    assert.equal(auto.render?.status ?? null, changed.has(c.id) ? null : c.before.auto_render);
    assert.equal(readJson<CacheEntry>(cachePath(url))!.shell === true, shell);
  });
}

test("L.1: old shell flags obey the new decision on fresh and revalidated cache reads", async () => {
  for (const id of changed) {
    const url = `${srv.url}/${id}`;
    const entry = readJson<CacheEntry>(cachePath(url))!;
    for (const mode of ["off", "auto"]) {
      entry.shell = true; // The flag frozen before L.1, on the same parsed content.
      entry.fresh_until = Date.now() + 600_000;
      writeJson(cachePath(url), entry);
      process.env.TIRESIAS_RENDERING = mode;
      const hits = srv.count(`/${id}`);
      const fresh = await engine.read(url, { page: 1 });
      assert.equal(fresh.cache, "fresh");
      assert.equal(srv.count(`/${id}`), hits);
      assert.equal(fresh.render, undefined);
      assert.equal(fresh.message?.includes(fixture.shell_note) ?? false, false);
      entry.fresh_until = 0;
      writeJson(cachePath(url), entry);
      const revalidated = await engine.read(url, { page: 1 });
      assert.equal(revalidated.cache, "revalidated");
      assert.equal(revalidated.render, undefined);
      assert.equal(revalidated.message?.includes(fixture.shell_note) ?? false, false);
      assert.equal(readJson<CacheEntry>(cachePath(url))!.shell, undefined);
    }
  }
});
