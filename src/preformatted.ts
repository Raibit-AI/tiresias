// SPDX-License-Identifier: Apache-2.0
// v1.2: recognize the reader's fenced presentation, including list indentation and a local warning.
export function fencedText(text: string): { open: string; body: string; close: string } | undefined {
  const head = /^((?:\[[^\n]*\]\n)?[ \t]*(?:(?:[-*+]|\d+[.)]) )?)(`{3,})\n/.exec(text);
  if (!head) return undefined;
  const end = text.lastIndexOf("\n");
  const close = text.slice(end + 1);
  if (end < head[0].length || close.trimStart() !== head[2]) return undefined;
  return { open: head[0].slice(0, -1), body: text.slice(head[0].length, end), close };
}
