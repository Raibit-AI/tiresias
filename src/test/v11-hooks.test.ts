// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { runHook } from "../hook.js";
import { freshHome } from "./helper.js";

test("7.1: scanner and translator hooks inherit owner variables without Tiresias secrets", async () => {
  freshHome();
  const vars = { TIRESIAS_WEB_RISK_KEY: "SYNTHETIC_WEB_RISK_SECRET", TIRESIAS_SIGNING_KEY: "SYNTHETIC_SIGNING_SECRET", TIRESIAS_NEW_SECRET: "SYNTHETIC_FUTURE_SECRET", OWNER_HOOK_TOKEN: "owner-value" };
  Object.assign(process.env, vars);
  try {
    for (const cap of [4096, 1024 * 1024]) {
      const r = await runHook([process.execPath, "-e", `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(vars))}.map(k => [k, process.env[k]]))))`], [], 5000, cap, "");
      assert.ok(r.ok, JSON.stringify(r));
      const env = JSON.parse(r.out.toString());
      assert.deepEqual(env, { OWNER_HOOK_TOKEN: "owner-value" });
    }
  } finally { for (const k of Object.keys(vars)) delete process.env[k]; }
});
