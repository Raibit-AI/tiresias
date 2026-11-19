`v12-label-parent.json` is what the LOCAL MCP server (`tiresias mcp --local`, budget 6,000) answered at commit
`9396d8a` (branch `v1.2-guard`, the tree this branch merged on 2026-11-19, without the written_by label, W-39) for the reads listed in `LABEL_CALLS` in
`src/test/v12-label-replies.ts`. Times and the test server's address are replaced by placeholders (`<time>`,
`http://SITE`).

`v12-label.test.ts` runs the same reads against the current tree. Pages with no visitor text in the read must
answer identically. Pages with visitor text must answer identically once each `written_by` is taken out, and
identically with nothing taken out when the owner has turned the label off. So the label is shown to add one
field and change nothing else: no warning, no withheld passage, no other passage.

To reproduce it: extract the parent tree (`git archive 9396d8a`), link this tree's `node_modules`, copy
`src/test/v12-label-replies.ts` into its `src/test/`, build it with `tsc`, then from a script file in that tree,
with `NODE_TEST_CONTEXT` set and `TIRESIAS_ALLOW_PRIVATE=1` and `TIRESIAS_HOME` pointing at an empty scratch
folder, import its `dist/test/v12-label-replies.js` and `dist/mcp.js`, call `labelReplies(createServer)`, stop
the parse worker (`dist/sandbox.js` `stopWorker()`), and write `{ commit: "9396d8a", ...result }` as JSON
(`JSON.stringify(x, null, 1)` plus a newline). Do not regenerate it from a tree that has the change.

History: first made from `5baaba4` on 2026-11-18. Remade from `9396d8a` on 2026-11-19 by Banks when `v1.2-guard`
(with the sweep) was merged in. Three of the 16 replies changed, each for a reason in the sweep: two count 3 flags
where they counted 0 (L.3: the full server's flags use the aimed-at-an-AI patterns), and the recipe page no longer
carries the "needs JavaScript" message (L.1: a page with a real paragraph is not a JavaScript-only shell). The
other 13 are byte for byte the same as the `5baaba4` fixture.
