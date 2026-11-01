// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { classify } from "../files.js";

test("known non-ZIP archive signatures cannot be renamed into Office or programs", () => {
  const archives = [
    Buffer.from("Rar!\x1a\x07\x00", "latin1"),
    Buffer.from([0x1f, 0x8b, 0, 0]),
    Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
    Buffer.from("BZh9", "latin1"),
    Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0]),
  ];
  for (const head of archives) for (const name of ["report.docx", "app.apk", "addon.xpi"]) {
    const result = classify(head, "application/octet-stream", { disposition: name });
    assert.ok("file" in result);
    assert.equal(result.file, "archive", name);
  }
  const zip = Buffer.from("PK\x03\x04", "latin1");
  assert.deepEqual(classify(zip, "application/octet-stream", { disposition: "report.docx" }), { file: "office", flags: [] });
  assert.deepEqual(classify(zip, "application/octet-stream", { disposition: "app.apk" }), { file: "program", flags: [] });
});
