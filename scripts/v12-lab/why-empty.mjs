// SPDX-License-Identifier: Apache-2.0
// v1.2 deep dive: for a page the reader returns almost empty, which rule dropped the text? Fetches the HTML once
// (only run on URLs Tiresias itself was allowed to read) and parses it four ways.
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { parseHtml } = await import(path.join(root, "dist/reader.js"));
for (const url of process.argv.slice(2)) {
  const res = await fetch(url, { headers: { "user-agent": "Tiresias/1.2-lab (+https://raibit.ai/tiresias/)", accept: "text/html" }, signal: AbortSignal.timeout(30_000) });
  const html = await res.text();
  const n = (h) => { try { return parseHtml(h, url).text_chars; } catch (e) { return "ERR " + e.message.slice(0, 40); } };
  const strip = (h, re) => h.replace(/<(?!script|style)([a-zA-Z][^>]*)>/g, (m) => m.replace(re, ""));
  const noNames = strip(html, /\s(class|id|role)=("[^"]*"|'[^']*'|[^\s>]+)/gi);
  const noHidden = strip(html, /\s(aria-hidden|hidden|style)(=("[^"]*"|'[^']*'|[^\s>]+))?/gi);
  const noStyle = html.replace(/<style[\s\S]*?<\/style>/gi, "");
  console.log(JSON.stringify({ url, status: res.status, kb: Math.round(html.length / 1024), as_is: n(html), without_class_id_role: n(noNames), without_hidden_attrs: n(noHidden), without_style_blocks: n(noStyle), without_all: n(strip(strip(noStyle, /\s(class|id|role)=("[^"]*"|'[^']*'|[^\s>]+)/gi), /\s(aria-hidden|hidden|style)(=("[^"]*"|'[^']*'|[^\s>]+))?/gi)) }));
}
