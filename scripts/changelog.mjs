// SPDX-License-Identifier: Apache-2.0
// Builds CHANGELOG.md from the version history in docs/SPEC.md (section 10): one heading per released
// version with its first paragraph. Run: node scripts/changelog.mjs
import fs from "node:fs";
const spec = fs.readFileSync(new URL("../docs/SPEC.md", import.meta.url), "utf8");
const history = spec.slice(spec.indexOf("## 10. Version history"), spec.indexOf("## Credits and prior art"));
const out = ["# Changelog", "", "Built from docs/SPEC.md, section 10, which has the full detail of every version.", ""];
for (const part of history.split("\n### ").slice(1)) {
  const [head, ...rest] = part.split("\n");
  if (!/^v\d/.test(head) || /planned/.test(head)) continue;
  const para = rest.join("\n").trim().split("\n\n")[0];
  out.push(`## ${head}`, "", para, "");
}
fs.writeFileSync(new URL("../CHANGELOG.md", import.meta.url), out.join("\n"));
