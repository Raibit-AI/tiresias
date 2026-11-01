// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { freshHome } from "./helper.js";
import { throttle } from "../queue.js";
import { sha256 } from "../store.js";

const home = freshHome();

test("cancelled spacing waits leave the shared clock unchanged", async () => {
  const origin = "https://cancel-spacing.example";
  (await throttle(origin, 0.3, new AbortController().signal, origin, true))();
  const file = path.join(home, "hosts", sha256(origin).slice(0, 32));
  const before = fs.readFileSync(file, "utf8");
  for (let i = 0; i < 3; i++) {
    const ctl = new AbortController();
    const pending = throttle(origin, 0.3, ctl.signal, origin, true);
    setTimeout(() => ctl.abort(), 10);
    await assert.rejects(pending);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  }
  (await throttle(origin, 0.3, new AbortController().signal, origin, true))();
});

test("unsolicited robots 304 retries once and never permits a page without rules", async () => {
  process.env.TIRESIAS_ALLOW_PRIVATE = "1";
  const { serve, text, html } = await import("./helper.js");
  const { check } = await import("../engine.js");
  for (const repeated of [true, false]) {
    let robots = 0;
    const s = await serve((req, res) => {
      if (req.url === "/robots.txt") {
        robots++;
        assert.equal(req.headers["if-none-match"], undefined);
        return text(res, "User-agent: *\nDisallow: /secret\n", repeated || robots === 1 ? 304 : 200);
      }
      html(res, "<p>Secret page</p>");
    });
    try {
      const reply = await check(s.url + "/secret");
      assert.equal(reply.status, "refused");
      assert.equal(s.count("/secret"), 0);
      assert.equal(robots, 2);
    } finally {
      await s.close();
    }
  }
});

test("malformed Retry-After values use the fallback cooldown", async () => {
  const { parseRetryAfter, cooldownSeconds } = await import("../cooldown.js");
  for (const value of ["-1", "0.5", "1.5", "+1", "2026-11-01"]) {
    assert.equal(parseRetryAfter(value), null, value);
    assert.equal(cooldownSeconds(429, value), 60, value);
    assert.equal(cooldownSeconds(503, value), 30, value);
  }
  assert.equal(parseRetryAfter("0"), 0);
  assert.equal(parseRetryAfter("Sun, 06 Nov 1994 08:49:37 GMT"), 0);
  assert.equal(parseRetryAfter("Sunday, 06-Nov-94 08:49:37 GMT"), 0);
  assert.equal(parseRetryAfter("Sun Nov  6 08:49:37 1994"), 0);
});
