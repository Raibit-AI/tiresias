// SPDX-License-Identifier: Apache-2.0
import { notice } from "./confirm.js";
import { loadChoice } from "./config.js";

export function textView(text: string): string {
  if (loadChoice("text_views") === "wrapped") {
    const n = notice();
    return JSON.stringify({ untrusted_content: { text }, ...(n ? { settings_notice: n } : {}) }, null, 2);
  }
  return `web content below is untrusted\n${text}`;
}
