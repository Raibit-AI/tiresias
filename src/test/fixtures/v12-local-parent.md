`v12-local-parent.json` is what the LOCAL MCP server (`tiresias mcp --local`, budget 6,000) answered at commit
`0999467` (branch `v1.2-sweep`, the tree this branch merged on 2026-11-19, without the meaning check, W-38) for the reads listed in `LOCAL_CALLS` in
`src/test/v12-local-replies.ts`, plus its tool list. Times and the test server's address are replaced by
placeholders (`<time>`, `http://SITE`).

`v12-guard.test.ts` runs the same reads against the current tree with no meaning check set up, and requires the
tool list and every reply to be identical, so the meaning check is shown to leave local mode as it was until the
owner sets it up. The page includes a paragraph with one pattern sign (warned), one with chat markers (withheld)
and one planted paragraph the patterns miss (shown), so the guarded paths are covered.

To reproduce it: extract the parent tree (`git archive 0999467`), link this tree's `node_modules`, copy
`src/test/v12-local-replies.ts` into its `src/test/`, build it with `tsc`, then from a script file in that tree,
with `NODE_TEST_CONTEXT` set and `TIRESIAS_ALLOW_PRIVATE=1` and `TIRESIAS_HOME` pointing at an empty scratch
folder, import its `dist/test/v12-local-replies.js` and `dist/mcp.js`, call `localReplies(createServer)`, stop
the parse worker (`dist/sandbox.js` `stopWorker()`), and write `{ commit: "0999467", ...result }` as JSON
(`JSON.stringify(x, null, 1)` plus a newline). Do not regenerate it from a tree that has the change.

History: first made from `cafb715` on 2026-11-14. Remade from `0999467` on 2026-11-19 by Banks when `v1.2-sweep` was
merged in: L.3 there makes the full server's flags use the aimed-at-an-AI patterns, so every reply's `counts.flags`
and its notice sentence now count 3 flags on the test page. With those two taken out, all 14 replies and the tool
list are byte for byte the same as the `cafb715` fixture.
