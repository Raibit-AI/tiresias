// SPDX-License-Identifier: Apache-2.0
// Test-only --import preload for the real PDF child. No product code or parser result is changed.
// Count content access BEFORE it can throw or be swallowed by a best-effort parser catch.
import cp from "node:child_process";
import { registerHooks, syncBuiltinESMExports } from "node:module";

const audit = { pid: process.pid, loaded: [] as string[], attachmentCalls: 0, embeddedStreams: 0, processStarts: [] as string[], completed: false };
(globalThis as any).__pdfAudit = audit;
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const) {
  const original = cp[name] as Function;
  (cp as any)[name] = function (...args: unknown[]) {
    audit.processStarts.push(name);
    return original.apply(this, args);
  };
}
// Also cover direct ChildProcess.spawn calls, below the convenience APIs and before Node's
// permission check. A denied or missing executable is still a launch attempt.
const prototype = cp.ChildProcess.prototype as unknown as { spawn(...args: any[]): any };
const start = prototype.spawn;
prototype.spawn = function (...args: Parameters<typeof start>) {
  audit.processStarts.push("ChildProcess.spawn");
  return start.apply(this, args);
};
syncBuiltinESMExports();
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    const replace = (source: string, needle: string, insertion: string, count = 1) => {
      if (source.split(needle).length !== count + 1) throw new Error(`PDF audit anchor changed: ${needle}`);
      return source.replaceAll(needle, needle + insertion);
    };
    let source = String(loaded.source);
    if (url.endsWith("/pdfjs-dist/legacy/build/pdf.mjs")) {
      audit.loaded.push("api");
      source = replace(source, "  getAttachmentContent(id) {", " globalThis.__pdfAudit.attachmentCalls++;", 2);
    } else if (url.endsWith("/pdfjs-dist/legacy/build/pdf.worker.mjs")) {
      audit.loaded.push("worker");
      for (const anchor of ["  static readContent(dict) {", "  static readStreamContent(stream) {"]) {
        source = replace(source, anchor, " globalThis.__pdfAudit.attachmentCalls++;");
      }
      // This is below the public attachment API: even directly resolving an EmbeddedFile stream
      // (including constructing its decoder) is observed, before any payload bytes can be consumed.
      source = replace(source, "  makeStream(dict, cipherTransform) {", ' if (dict.get("Type")?.name === "EmbeddedFile") globalThis.__pdfAudit.embeddedStreams++;');
    } else if (url.endsWith("/pdf.js") && !url.includes("/node_modules/")) {
      audit.loaded.push("parser");
      const anchor = "      return parsed;";
      if (source.split(anchor).length !== 2) throw new Error("PDF audit parse completion anchor changed");
      source = source.replace(anchor, "      globalThis.__pdfAudit.completed = true;\n" + anchor);
    } else return loaded;
    return { ...loaded, source };
  },
});
// Attach observations to the SAME IPC answer, so no extra message can be mistaken for the result.
const send = process.send!;
process.send = function (message: any, ...args: any[]) {
  return (send as any).call(process, { ...message, test_pdf_audit: structuredClone(audit) }, ...args);
} as typeof process.send;
