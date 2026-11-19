// SPDX-License-Identifier: Apache-2.0
// v1.2 deep dive: how often does the wider "aimed at an AI" check fire on ordinary pages? Reads each URL through
// Tiresias (five questions' worth of passages plus the first sections), then counts passages each pattern marks.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const GUARD = {
  addressed: /\b(attention|notice|note|message|instructions?)\b[^.\n]{0,40}\b(to|for)\b[^.\n]{0,20}\b(ai|a\.i\.|llm|language model|chatbot)s?\b/i,
  ai_must: /\b(ai|a\.i\.|llm|language model|chatbot)s? ?(assistants?|agents?|models?|systems?)?\b[^.\n]{0,30}\b(must|should|are required to|have to|need to)\b[^.\n]{0,40}\b(ignore|reply|respond|answer|say|tell|include|read|visit|output|end)\b/i,
  assistant_must: /\b(the )?assistant (must|should|will|has to)\b/i,
  system_message: /\bsystem (message|prompt|instructions?)\b\s*[:\-]|^\s*system\s*:/im,
  chat_tokens: /<\|[a-z_]+\|>/i,
  role_tags: /<\/?(tool_response|tool_call|tool_result|system|assistant|user)>/i,
  reply_only: /\b(reply|respond|answer) (only )?with (only )?(the )?(single )?(words?|sentence|phrase)\b/i,
  ignore_user: /\bignore (the |all |any )?(user|users|user's|above|previous|prior|earlier)\b/i,
  your_tool: /\b(use|with|call) your (read|browser|search|fetch|web) tool\b/i,
  role_line: /^\s*(user|assistant)\s*:/im,
  envelope_keys: /"(status|notice|untrusted_content)"\s*:/i,
};
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const urls = fs.readFileSync(process.argv[2], "utf8").split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
  const hits = {}; let passages = 0, marked = 0, strong = 0;
  for (const url of urls) {
    const texts = [];
    for (const args of [["--section", "1"], ["--section", "2"], ["--section", "3"], ["--question", "instructions for AI assistants and agents system prompt ignore"]]) {
      try {
        let out; try { out = execFileSync(process.execPath, [path.join(root, "dist/cli.js"), "read", url, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 90_000 }); } catch (e) { out = e.stdout || "{}"; }
        const uc = JSON.parse(out).untrusted_content ?? {};
        if (uc.section?.text) texts.push(...String(uc.section.text).split("\n\n"));
        for (const p of uc.passages ?? []) texts.push(p.text);
      } catch { /* skip */ }
    }
    const seen = new Set();
    for (const t of texts) {
      if (seen.has(t) || t.length < 20) continue; seen.add(t); passages++;
      const which = Object.entries(GUARD).filter(([, re]) => re.test(t)).map(([k]) => k);
      if (which.length) { marked++; if (which.length >= 2) strong++; for (const k of which) hits[k] = (hits[k] ?? 0) + 1; console.log(JSON.stringify({ url, which, text: t.slice(0, 160) })); }
    }
  }
  console.error(JSON.stringify({ urls: urls.length, passages, marked, strong, hits }));
}
