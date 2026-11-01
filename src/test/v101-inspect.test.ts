// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "node:test";
import { inspectScript, newMark } from "../inspect.js";

// Exercise the emitted geometry judge with a native Range-shaped list of 60 line boxes.
const judgeLines = (visible: boolean, unavailable: boolean | "all" = false, expired = false) => {
  const script = inspectScript(newMark());
  const start = script.indexOf("  const judge = (t, el) => {");
  const end = script.indexOf("  const walker =", start);
  assert.ok(start >= 0 && end > start);
  const rects = Array.from({ length: 60 }, (_, i) => ({ width: 100, height: 20, left: 10, right: 110, top: 100 + (i - 50) * 20, bottom: 120 + (i - 50) * 20 }));
  return vm.runInNewContext(script.slice(start, end) + "({ reason: judge({}, {}), complete: out.complete });", {
    st: () => ({ display: "block", visibility: "visible", color: "black" }),
    underHidden: () => false, vis: () => true, effOpacity: () => 1,
    range: { selectNodeContents() {}, getClientRects: () => rects }, tag: () => "DIV",
    window: { scrollX: 0, scrollY: 0 }, pageW: 1280, pageH: 2000,
    toView: (x: number, y: number) => unavailable && (unavailable === "all" || y >= 100) ? null : [x, y],
    pointState: (_el: unknown, _x: number, y: number) => visible && y >= 100 && y < 300 ? null : "clipped",
    rgba: () => null, timeUp: () => expired, out: { complete: true },
  });
};

test("inspection keeps visible final lines beyond the first fifty range rectangles", () => {
  assert.equal(judgeLines(true).reason, null);
  assert.equal(judgeLines(false).reason, "clipped");
});

test("unreachable rectangle points are skipped without making inspection partial", () => {
  const result = judgeLines(false, true);
  assert.equal(result.reason, "clipped");
  assert.equal(result.complete, true);
  const unreachable = judgeLines(false, "all");
  assert.equal(unreachable.reason, null);
  assert.equal(unreachable.complete, true);
});

test("exhausting the rectangle geometry budget makes inspection partial", () => {
  const result = judgeLines(false, false, true);
  assert.equal(result.reason, "unmeasured");
  assert.equal(result.complete, false);
});
