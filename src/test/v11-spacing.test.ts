// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { freshHome } from "./helper.js";

test("5.2: private calls and previews reserve shared spacing across processes", () => {
  for (const context of [{ private: true }, { readOnly: true }]) {
    freshHome();
    const script = `import { callContext } from './dist/context.js'; import { reserve } from './dist/hosts.js'; callContext.run(${JSON.stringify(context)}, () => console.log(reserve('https://spacing.example', 30000, 0)));`;
    const run = () => {
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: process.env });
      assert.ifError(r.error);
      assert.equal(r.status, 0, r.stderr);
      return Number(r.stdout.trim());
    };
    const first = run();
    assert.ok(run() >= first + 30000, JSON.stringify(context));
  }
});

test("5.2: shared private spacing keeps the local slot when its reservation cannot be stored", async () => {
  const fs = (await import("node:fs")).default;
  const { reserve } = await import("../hosts.js");
  const { callContext } = await import("../context.js");
  const write = fs.writeSync;
  freshHome();
  fs.writeSync = (() => { throw new Error("disk unavailable"); }) as typeof fs.writeSync;
  try {
    const earliest = Date.now() + 1000;
    assert.equal(callContext.run({ private: true }, () => reserve("https://spacing.example", 1000, earliest)), earliest);
  } finally { fs.writeSync = write; }
});
