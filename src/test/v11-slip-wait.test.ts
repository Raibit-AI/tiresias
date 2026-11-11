// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { formPreview, formSubmit } from "../engine.js";
import { grant, revoke, list } from "../slips.js";
import { throttle } from "../queue.js";
import { freshHome, html, serve, text } from "./helper.js";

process.env.TIRESIAS_ALLOW_PRIVATE = "1";
test("6.4: a queued submission rechecks expiry and revocation before sending", async () => {
  for (const change of ["expired", "revoked"]) {
    freshHome();
    const s = await serve((req, res) => req.url === "/robots.txt" ? text(res, "", 404) : html(res, '<form method="post" action="/send"><input name="message"></form>'));
    const write = fs.writeSync, now = Date.now;
    let offset = 0, held: Promise<void> | undefined;
    Date.now = () => now() + offset;
    try {
      const slip = grant({ action: "submit_form", site: s.url, for: "1h" });
      const p = await formPreview(s.url + "/page", 1, { message: "Hello" });
      assert.equal(p.status, "ok");
      fs.writeSync = ((fd: number, data: any, ...args: any[]) => {
        const result = (write as any)(fd, data, ...args);
        if (typeof data === "string" && data.includes('"label":"form_submit"') && !held) {
          held = throttle(s.url, 0, new AbortController().signal, s.url, true).then((release) => new Promise<void>((resolve) => setTimeout(() => {
            if (change === "expired") offset = 3_600_001;
            else revoke(slip.id);
            release(); resolve();
          }, 30)));
        }
        return result;
      }) as typeof fs.writeSync;
      const r = await formSubmit(s.url + "/page", 1, { message: "Hello" }, p.form!.preview_hash!);
      await held;
      assert.ok(held, "submission waited behind another admitted request");
      assert.equal(s.count("/send"), 0, change);
      assert.equal(r.form?.sent, false);
      if (change === "expired") {
        offset = 0;
        assert.equal(list().counts.used_up, 1);
      }
    } finally { fs.writeSync = write; Date.now = now; await s.close(); }
  }
});
