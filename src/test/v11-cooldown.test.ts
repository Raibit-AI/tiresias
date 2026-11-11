// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { cooldownLeft } from "../cooldown.js";
import { Refused } from "../errors.js";
import { freshHome } from "./helper.js";

test("5.6: a fresh process honors a live cooldown before the last 8 MiB", () => {
  const home = freshHome();
  const now = Date.now();
  const origin = "https://early.cooldown.example";
  const early = JSON.stringify({ origin, until: now + 604800_000 }) + "\n";
  const filler = JSON.stringify({ origin: "https://expired.example", until: now - 1000 }) + "\n";
  fs.writeFileSync(path.join(home, "cooldowns.jsonl"), early + filler.repeat(Math.ceil((8 * 1024 * 1024 + 4096) / filler.length)), { mode: 0o600 });
  const code = `import { cooldownLeft } from ${JSON.stringify(new URL("../cooldown.js", import.meta.url).href)}; console.log(cooldownLeft(${JSON.stringify(origin)}));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env }, encoding: "utf8", timeout: 5000 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Number(r.stdout) > 604_700, r.stdout);
});

test("5.6: an unreadable cooldown log fails closed", () => {
  const home = freshHome();
  const target = path.join(home, "other.jsonl");
  fs.writeFileSync(target, JSON.stringify({ origin: "https://unreadable.example", until: Date.now() + 600_000 }));
  fs.symlinkSync(target, path.join(home, "cooldowns.jsonl"));
  assert.throws(() => cooldownLeft("https://unreadable.example"), Refused);
});

test("5.6: a large log is read once, appends read only new bytes, replacement and shrink replay", () => {
  const home = freshHome();
  const file = path.join(home, "cooldowns.jsonl");
  const origin = "https://incremental.cooldown.example";
  const record = (origin: string, seconds: number) => JSON.stringify({ origin, until: Date.now() + seconds * 1000 }) + "\n";
  const early = record(origin, 600);
  const filler = record("https://expired.example", -1000);
  const body = early + filler.repeat(Math.ceil(9 * 1024 * 1024 / filler.length));
  fs.writeFileSync(file, body, { mode: 0o600 });
  const read = fs.readSync;
  let bytes = 0;
  fs.readSync = ((fd: number, buf: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
    const n = read(fd, buf, offset, length, position);
    bytes += n;
    assert.ok(length <= 64 * 1024, "replay uses bounded chunks");
    return n;
  }) as typeof fs.readSync;
  try {
    assert.ok(cooldownLeft(origin) > 500);
    assert.equal(bytes, Buffer.byteLength(body));
    for (let i = 0; i < 3; i++) {
      bytes = 0;
      const append = record(origin, 900 + i * 100);
      fs.appendFileSync(file, append);
      assert.ok(cooldownLeft(origin) > 800 + i * 100);
      assert.equal(bytes, Buffer.byteLength(append), "only the append is read");
      cooldownLeft("https://unrelated.example");
      assert.equal(bytes, Buffer.byteLength(append), "unchanged log is not read");
    }
    bytes = 0;
    fs.utimesSync(file, new Date(), new Date());
    cooldownLeft(origin);
    assert.equal(bytes, 0, "a changed stamp alone does not replay the log");
    const replacement = record("https://replacement.example", 600);
    fs.writeFileSync(file + ".new", replacement);
    fs.renameSync(file + ".new", file);
    assert.ok(cooldownLeft("https://replacement.example") > 500);
    assert.equal(bytes, Buffer.byteLength(replacement), "replacement replays from the start");
    bytes = 0;
    const smaller = record("https://small.example", 600);
    fs.writeFileSync(file, smaller);
    assert.ok(cooldownLeft("https://small.example") > 500);
    assert.equal(bytes, Buffer.byteLength(smaller), "a shrunken log replays from the start");
  } finally { fs.readSync = read; }
});

test("5.6: replay past the old one-second budget does not refuse unrelated sites", () => {
  const home = freshHome();
  const file = path.join(home, "cooldowns.jsonl");
  const origin = "https://slow-replay.example";
  const until = Date.now() + 600_000;
  fs.writeFileSync(file, JSON.stringify({ origin, until }) + "\n" + "\n".repeat(128 * 1024));
  const read = fs.readSync, now = Date.now;
  const start = now();
  let elapsed = 0;
  Date.now = () => start + elapsed;
  fs.readSync = ((fd: number, buf: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
    elapsed += 1100;
    return read(fd, buf, offset, length, position);
  }) as typeof fs.readSync;
  try {
    assert.equal(cooldownLeft("https://unrelated.example"), 0);
    assert.ok(elapsed > 1000, "the replay passed the old deadline");
    assert.ok(cooldownLeft(origin) > 500, "the live deadline was still learned");
  } finally { fs.readSync = read; Date.now = now; }
});

test("5.6: an incomplete record is finished by a later append", () => {
  const home = freshHome();
  const file = path.join(home, "cooldowns.jsonl");
  const origin = "https://partial.cooldown.example";
  const record = JSON.stringify({ origin, until: Date.now() + 600_000 });
  fs.writeFileSync(file, record.slice(0, -3));
  assert.equal(cooldownLeft(origin), 0);
  fs.appendFileSync(file, record.slice(-3));
  assert.ok(cooldownLeft(origin) > 500, "a complete final record needs no newline");
  fs.appendFileSync(file, "\n");
  assert.ok(cooldownLeft(origin) > 500);
});
