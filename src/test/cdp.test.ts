// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { Cdp, MAX_MESSAGE } from "../cdp.js";

for (const chunks of ["terminated", "final fragment", "unterminated"]) {
  test(`7.14 / 9.13: CDP rejects an oversized ${chunks} message before parsing or dispatching`, async () => {
    const input = new PassThrough();
    const cdp = new Cdp(new PassThrough(), input);
    let events = 0;
    cdp.on(() => events++);
    const rejected = assert.rejects(cdp.send("test"), (e: any) => e.code === "too_large");
    const message = Buffer.alloc(MAX_MESSAGE + 2, 32);
    message.write('{"method":"oversized"}');
    message[message.length - 1] = 0;
    if (chunks === "terminated") input.write(message);
    else {
      input.write(message.subarray(0, MAX_MESSAGE - 8));
      input.write(message.subarray(MAX_MESSAGE - 8, chunks === "unterminated" ? -1 : undefined));
    }
    await rejected;
    assert.equal(events, 0);
    assert.equal(cdp.closed, true);
    input.destroy();
  });
}

test("7.14 / 9.13: CDP accepts exactly MAX_MESSAGE bytes, resets the count at each NUL, and dispatches the next message", () => {
  const input = new PassThrough();
  const cdp = new Cdp(new PassThrough(), input);
  const methods: string[] = [];
  cdp.on((e) => methods.push(e.method));
  const message = Buffer.alloc(MAX_MESSAGE + 1, 32);
  message.write('{"method":"at_cap"}');
  message[MAX_MESSAGE] = 0;
  input.write(message.subarray(0, MAX_MESSAGE - 4));
  input.write(Buffer.concat([message.subarray(MAX_MESSAGE - 4), Buffer.from('{"method":"next"}\0')]));
  assert.deepEqual(methods, ["at_cap", "next"]);
  assert.equal(cdp.closed, false);
  input.destroy();
});
