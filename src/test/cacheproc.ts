// SPDX-License-Identifier: Apache-2.0
// Not a test file: a child process for the W-03 two-process cache test (handoff-cache.test.ts).
// Writes the same cache entry over and over with the store's own writer, and reads it back
// raw between writes. A read must find either no file or one whole entry from ONE writer.
// Usage: node cacheproc.js <home> <key> <who> <rounds>
const [home, key, who, rounds] = process.argv.slice(2);
process.env.TIRESIAS_HOME = home;
const fs = await import("node:fs");
const store = await import("../store.js");

const file = store.cachePath(key);
const size = who === "a" ? 50_000 : 90_000; // different sizes, so a mixed file cannot parse as either
let bad = 0;
let seen = 0;
for (let i = 0; i < Number(rounds); i++) {
  store.writeJson(file, { who, i, pad: who.repeat(size) });
  for (let r = 0; r < 3; r++) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // a vanished file is tolerated
      throw e;
    }
    seen++;
    try {
      const o = JSON.parse(raw) as { who: string; pad: string };
      if (o.pad !== o.who.repeat(o.who === "a" ? 50_000 : 90_000)) bad++;
    } catch {
      bad++; // a torn or mixed file
    }
  }
}
process.stdout.write(JSON.stringify({ who, bad, seen }));
