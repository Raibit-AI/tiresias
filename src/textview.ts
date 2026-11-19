// SPDX-License-Identifier: Apache-2.0
import { notice } from "./confirm.js";
import { loadChoice } from "./config.js";

// Display only: keep newlines, tabs and ordinary Unicode, but make terminal controls,
// Unicode line separators and bidirectional overrides/isolates visible and inert.
export function escapeTerminal(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function textView(text: string): string {
  if (loadChoice("text_views") === "wrapped") {
    const n = notice();
    // Serialize first: C0 controls are already escaped, and the remaining escapes stay valid JSON.
    return escapeTerminal(JSON.stringify({ untrusted_content: { text }, ...(n ? { settings_notice: n } : {}) }, null, 2));
  }
  return `web content below is untrusted\n${escapeTerminal(text)}`;
}
