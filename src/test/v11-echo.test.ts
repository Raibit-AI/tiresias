// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { afterSubmit } from "../formflow.js";
import { secretsOf } from "../echo.js";
import { sha256 } from "../store.js";
import { freshHome, logText } from "./helper.js";
import { makeZip } from "./zipmaker.js";
import type { FormTop } from "../types.js";

const url = "https://forms.example/answer";
const top: FormTop = { index: 1, method: "POST", sent: true };
test("7.2: Office answers check full extracted text before shortening or recording", async () => {
  const home = freshHome();
  const token = "SecretToken-" + "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".repeat(66).slice(0, 4084);
  const b = makeZip([
    { name: "[Content_Types].xml", method: 8, data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: "_rels/.rels", method: 8, data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: "word/document.xml", method: 8, data: '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' + "ordinary ".repeat(3450) + token + " ending ".repeat(1900) + '</w:t></w:r></w:p></w:body></w:document>' },
  ]);
  const r = await afterSubmit(url, top, { url, status: 200, redirected: false, truncated: false, headers: new Headers(), body: "", file: { kind: "office", risk: "high", flags: [], size: b.length, sha256: sha256(b), declared_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", body: b } }, secretsOf([token]), {}, "test");
  assert.equal(r.form?.reason, "secret_withheld");
  assert.equal(logText(home, "receipts"), "");
});

function pdfTitle(title: string): Buffer {
  const content = 'BT /F1 12 Tf 20 100 Td (Ordinary page text) Tj ET';
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[4 0 R]/Count 1>>', '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 5 0 R/Resources<</Font<</F1 3 0 R>>>>>>',
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`, `<</Title <${Buffer.from(title).toString("hex")}>>>`,
  ];
  return Buffer.from('%PDF-1.4\n' + objects.map((s, i) => `${i + 1} 0 obj\n${s}\nendobj\n`).join('') + 'trailer\n<</Root 1 0 R/Info 6 0 R/Size 7>>\n%%EOF\n');
}
test("7.3: a PDF answer checks its full decoded title before shortening", async () => {
  const home = freshHome();
  const token = "SecretToken-" + "AbcDef".repeat(50);
  const { hooks } = await import("../pdfproc.js");
  const probe = hooks.probe;
  hooks.probe = () => 1;
  try {
    const r = await afterSubmit(url, top, { url, status: 200, redirected: false, truncated: false, headers: new Headers(), body: "", read: "pdf", bytes: pdfTitle(token) }, secretsOf([token]), {}, "test");
    assert.equal(r.form?.reason, "secret_withheld");
  } finally { hooks.probe = probe; }
  assert.equal(logText(home, "receipts"), "");
});
