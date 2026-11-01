// SPDX-License-Identifier: Apache-2.0
// v0.6 Track 2 ("browse"): the MCP tools for tabs and back/forward (W-24) and the downloads shelf (W-27),
// kept out of mcp.ts so the shared file only gains one call.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorEnv, errorEnvelope } from "./envelope.js";
import { tabAction, tabList, type TabAction, type TabStore } from "./tabs.js";
import * as shelf from "./shelf.js";

type Pack = (v: unknown, isError?: boolean) => { content: { type: "text"; text: string }[]; isError?: boolean };

const PAGE = z.number().int().positive().optional().describe("Page number, when a result says it has more pages");

export function registerBrowseTools(server: McpServer, tabs: TabStore, pack: Pack): void {
  // W-27: the downloads shelf. Read only; the records' URLs, names and types came from the web.
  server.registerTool(
    "files",
    {
      title: "Downloads shelf",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description:
        "List every file warning (links that led to a file Tiresias did not open, run or save), newest first: kind, risk, size, SHA-256 fingerprint, URL, the owner's scanner verdict, and when. Filter by site and date. A page at a time.",
      inputSchema: {
        site: z.string().optional().describe("Only this site, e.g. example.com (its subdomains too)"),
        since: z.string().optional().describe("From: a date like 2026-10-01, a full time, or 7d / 24h"),
        until: z.string().optional().describe("Up to: a date (through the end of that UTC day), a full time, or 7d / 24h"),
        page: PAGE,
      },
    },
    async ({ site, since, until, page }, extra) => {
      try {
        return pack(await shelf.query({ site, since, until, page }, extra.signal));
      } catch (e) {
        // Fixed text for a bad filter; anything else (a store problem) keeps its detail inside untrusted_content.
        return pack(e instanceof shelf.ShelfError ? errorEnvelope("", e.message) : errorEnv("", e), true);
      }
    },
  );
  server.registerTool(
    "tabs",
    {
      title: "Tabs",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description:
        "List this session's tabs: every page read in this session (not in private mode), numbered, most recently used first, with the current tab and how far back and forward you can go. Nothing is sent to any site.",
      inputSchema: { page: PAGE },
    },
    async ({ page }) => {
      try {
        return pack(tabList(tabs, page ?? 1));
      } catch (e) {
        return pack(errorEnv("", e), true);
      }
    },
  );
  server.registerTool(
    "tab",
    {
      title: "Open a tab, back, forward",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      description:
        "Show a page read earlier in this session from the local cache, with receipts and NO request to the site: open (a tab by number), back or forward (along the pages read), or close (one tab) and close_all. The reply says how old the copy is; it is not checked against the site, so read the URL again for the current page. section, question and page work as for read. Refused in private mode.",
      inputSchema: {
        action: z.enum(["open", "back", "forward", "close", "close_all"]),
        number: z.number().int().positive().optional().describe("For open and close: the tab number from tabs"),
        section: z.number().int().positive().optional().describe("Section number from the outline to read in full"),
        question: z.string().optional().describe("What you are looking for. Returns the best matching quoted passages."),
        page: PAGE,
        private: z.boolean().optional().describe("Private mode: refused (a tab reads the cache and changes the session)."),
      },
    },
    async ({ action, number, section, question, page, private: priv }, extra) => {
      try {
        if ((action === "open" || action === "close") && number === undefined)
          return pack(errorEnvelope("", `${action} needs number: the tab number from tabs.`), true);
        const a: TabAction = action === "open" || action === "close" ? { action, number: number! } : { action };
        const r = await tabAction(tabs, a, { section, question, page }, !!priv, Date.now(), extra.signal);
        return pack(r, r.status === "error");
      } catch (e) {
        return pack(errorEnv("", e), true);
      }
    },
  );
}
