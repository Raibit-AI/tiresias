// SPDX-License-Identifier: Apache-2.0
// v0.9 client trust (Travis approved 2026-10-31): the fixed-size cooldown store (cooldown.ts).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { freshHome } from "./helper.js";

test("v0.9 client trust (Travis approved): many distinct hostile hosts never grow memory past the bound; an active wait is never forgotten or shortened", async () => {
  freshHome();
  const cd = await import("../cooldown.js");
  cd.setMemMaxForTests(200); // the same code path as 10,000, reached quickly
  const MAX = 200;
  const N = MAX * 10; // 2,000 distinct sites, each answering 503 with a long wait
  const set: { origin: string; secs: number }[] = [];
  for (let i = 0; i < N; i++) {
    const origin = `https://h${i}.flood.example`;
    const secs = 600 + (i % 5000);
    cd.setCooldown(origin, 503, String(secs));
    set.push({ origin, secs });
  }
  // A very long origin name goes straight to the fixed-size store.
  const longName = `https://${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(60)}.${"f".repeat(60)}.${"g".repeat(60)}.example`;
  cd.setCooldown(longName, 503, "900");
  assert.ok(cd.cooldownMemSize() <= MAX, `in-process list ${cd.cooldownMemSize()}`);
  assert.equal(cd.cooldownStoreBytes(), cd.SLOTS * 8, "the fixed-size store is 8 MiB and does not grow");
  // Codex client-trust round 3 (LOW): the shared file would answer for every site, so it is taken away here; what
  // this process holds (the list and the fixed-size store) must answer alone.
  fs.rmSync(path.join(process.env.TIRESIAS_HOME!, cd.CUR), { force: true });
  // Every wait is still there, never shorter than asked (a second or two of slack for the time the loop took).
  for (const { origin, secs } of set) {
    const left = cd.cooldownLeft(origin);
    assert.ok(left >= secs - 60, `${origin}: ${left} s left, asked ${secs}`);
  }
  assert.ok(cd.cooldownLeft(longName) >= 840);
  // A shorter wait later never shortens a longer one, in either store.
  cd.setCooldown("https://h1.flood.example", 503, "5");
  cd.setCooldown(`https://h${N - 1}.flood.example`, 503, "5");
  assert.ok(cd.cooldownLeft("https://h1.flood.example") >= 600 - 60);
  assert.ok(cd.cooldownLeft(`https://h${N - 1}.flood.example`) >= 600 - 60);
  // A later, longer wait extends it.
  cd.setCooldown(`https://h${N - 2}.flood.example`, 503, "86000");
  assert.ok(cd.cooldownLeft(`https://h${N - 2}.flood.example`) >= 85_000);
  // Errs toward waiting longer only on a collision: almost every site never set reads as free.
  let blocked = 0;
  for (let i = 0; i < 2000; i++) if (cd.cooldownLeft(`https://other${i}.example`) > 0) blocked++;
  assert.ok(blocked < 20, `${blocked} of 2000 unrelated sites read as waiting`);
  // Many more hosts still do not grow memory: same sizes.
  for (let i = N; i < N + 1000; i++) cd.setCooldown(`https://h${i}.flood.example`, 503, "600");
  assert.ok(cd.cooldownMemSize() <= MAX);
  assert.equal(cd.cooldownStoreBytes(), cd.SLOTS * 8);
});
