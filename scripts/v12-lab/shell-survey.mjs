// SPDX-License-Identifier: Apache-2.0
// v1.2 deep dive, W-36: of pages that read as a JavaScript-only shell, how many carry their content in the HTML
// as data? Reads each URL through Tiresias first (its rules decide whether the page may be fetched at all), and
// only for pages it read does it fetch the HTML once more to look at the script blocks. One request pair per site.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const urls = fs.readFileSync(process.argv[2], "utf8").split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
const prose = (v, out) => {
  if (typeof v === "string") { const t = v.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); if (t.length >= 60 && t.split(" ").length >= 8 && !/^[A-Za-z0-9+/=_-]+$/.test(t)) out.push(t); }
  else if (Array.isArray(v)) for (const x of v) prose(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) prose(x, out);
};
for (const url of urls) {
  const row = { url };
  try {
    let out;
    try { out = execFileSync(process.execPath, [path.join(root, "dist/cli.js"), "read", url], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 90_000 }); } catch (e) { out = e.stderr || e.stdout || "{}"; }
    const e = JSON.parse(out);
    row.status = e.status; row.door = e.door; row.shell = /JavaScript-only shell/.test(e.message ?? "");
    row.outline = e.untrusted_content?.outline?.length ?? 0;
    if (e.status === "ok" || e.status === "unchanged") {
      const res = await fetch(url, { headers: { "user-agent": "Tiresias/1.2-lab (+https://raibit.ai/tiresias/)", accept: "text/html" }, signal: AbortSignal.timeout(30_000) });
      const html = await res.text();
      row.html_kb = Math.round(html.length / 1024);
      const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      row.visible_chars = text.length;
      row.next_data = /id="__NEXT_DATA__"/.test(html);
      row.next_flight = /self\.__next_f\.push/.test(html);
      row.nuxt = /__NUXT__|id="__NUXT_DATA__"/.test(html);
      row.state_var = /window\.__(INITIAL_STATE|PRELOADED_STATE|APOLLO_STATE|DATA)__/.test(html);
      const blocks = [...html.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
      row.json_blocks = blocks.length;
      const found = [];
      for (const b of blocks) { try { prose(JSON.parse(b), found); } catch { /* not JSON */ } }
      row.json_prose_strings = found.length;
      row.json_prose_chars = found.reduce((n, s) => n + s.length, 0);
      row.sample = found[0]?.slice(0, 100);
    }
  } catch (e) { row.error = String(e.message).slice(0, 120); }
  console.log(JSON.stringify(row));
}
