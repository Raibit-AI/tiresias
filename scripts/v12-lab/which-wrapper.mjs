// SPDX-License-Identifier: Apache-2.0
// v1.2 deep dive: which element's class, id or role made the reader treat most of a page as boilerplate?
import { parseDocument } from "htmlparser2";
const QUIET_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search", "menubar", "toolbar"]);
const WORDS = new Set(["cookie", "cookies", "consent", "gdpr", "related", "recommended", "share", "sharing", "social", "newsletter", "subscribe", "subscription", "sidebar", "breadcrumb", "breadcrumbs", "advert", "advertisement", "ads", "ad", "sponsored", "promo", "popup", "modal", "banner", "masthead", "footer", "nav", "navbar", "menu", "comments", "disqus"]);
const why = (a) => { if (QUIET_ROLES.has((a.role ?? "").toLowerCase())) return `role=${a.role}`; for (const w of `${a.class ?? ""} ${a.id ?? ""}`.slice(0, 500).toLowerCase().split(/[\s_-]+/)) if (WORDS.has(w)) return `word "${w}"`; return null; };
const textLen = (n) => n.type === "text" ? n.data.replace(/\s+/g, " ").trim().length : (n.name === "script" || n.name === "style" || n.name === "noscript" || n.name === "template") ? 0 : (n.children ?? []).reduce((s, c) => s + textLen(c), 0);
for (const url of process.argv.slice(2)) {
  const html = await (await fetch(url, { headers: { "user-agent": "Tiresias/1.2-lab (+https://raibit.ai/tiresias/)", accept: "text/html" }, signal: AbortSignal.timeout(30_000) })).text();
  const doc = parseDocument(html);
  const total = textLen(doc);
  const hits = [];
  const walk = (n, depth) => { for (const c of n.children ?? []) { if (c.type !== "tag") continue; const w = c.name !== "html" && c.name !== "body" ? why(c.attribs ?? {}) : null; if (w) { hits.push({ tag: c.name, depth, share: Math.round((100 * textLen(c)) / total), why: w, class: (c.attribs.class ?? "").slice(0, 70), id: c.attribs.id }); continue; } walk(c, depth + 1); } };
  walk(doc, 0);
  console.log(url, "total text", total);
  for (const h of hits.sort((a, b) => b.share - a.share).slice(0, 3)) console.log("   ", JSON.stringify(h));
}
