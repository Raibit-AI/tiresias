// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import https from "node:https";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { boundedGet, SafetyError, Wire } from "../safety.js";
import { makeGate } from "../safebrowsing.js";
import { freshHome } from "./helper.js";

freshHome();
delete process.env.TIRESIAS_ALLOW_PRIVATE;

test("4.1: bounded Web Risk requests refuse private literals and disallowed ports", async () => {
  for (const url of ["https://127.0.0.1/", "https://[::1]/", "https://[::ffff:127.0.0.1]/", "https://8.8.8.8:22/"]) {
    await assert.rejects(boundedGet(url, {}, 1000, new Wire(2000), AbortSignal.timeout(1000)), SafetyError, url);
  }
});

test("4.1: Web Risk refuses every private DNS answer and propagates the refusal", async () => {
  const lookup = dns.lookup, request = https.request;
  process.env.TIRESIAS_SAFE_BROWSING = "1";
  process.env.TIRESIAS_WEB_RISK_KEY = "test-key-for-webrisk";
  try {
    // Exercise the connection-time lookup without opening a socket or sending the key.
    https.request = ((opts: any) => {
      const req = new EventEmitter() as any;
      req.end = () => queueMicrotask(() => {
        if (!opts.lookup) return req.emit("error", new Error("unguarded connection"));
        opts.lookup(opts.hostname, { all: true }, (err: Error | null) => req.emit("error", err ?? new Error("unexpected public connection")));
      });
      return req;
    }) as typeof request;
    for (const answers of [
      [{ address: "127.0.0.1", family: 4 }],
      [{ address: "fd00::1", family: 6 }],
      [{ address: "::ffff:127.0.0.1", family: 6 }],
      [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }],
    ]) {
      dns.lookup = (async (host: string) => host === "webrisk.googleapis.com" ? answers : [{ address: "8.8.8.8", family: 4 }]) as unknown as typeof lookup;
      await assert.rejects(makeGate({ allowFlagged: false, priv: true }).check(new URL("https://assessed.example/page")), SafetyError);
    }
  } finally {
    dns.lookup = lookup;
    https.request = request;
    delete process.env.TIRESIAS_WEB_RISK_KEY;
    process.env.TIRESIAS_SAFE_BROWSING = "0";
  }
});
