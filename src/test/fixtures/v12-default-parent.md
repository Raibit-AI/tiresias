`v12-default-parent.json` is what the default MCP server answered at commit
`d4db1ce` (HEAD before local model mode, W-34) for the reads listed in `CALLS`
in `src/test/v12-default-replies.ts`, plus its instructions, tool list, history and receipt records.
Times, the test server's address and handoff ticket ids are replaced by
placeholders (`<time>`, `http://SITE`, `<ticket>`).

`v12-local.test.ts` runs the same reads against the current tree and requires
every reply, the instructions, the tool list and the normalized records to be identical, so local mode
is shown to leave default mode as it was.

To reproduce it: extract the parent tree (`git archive d4db1ce`), link this
tree's `node_modules`, copy `src/test/v12-default-replies.ts` into its
`src/test/`, build it with `tsc`, then with `NODE_TEST_CONTEXT=1` and
`TIRESIAS_ALLOW_PRIVATE=1`, first call `freshHome()` from its test helper, then import its `dist/mcp.js` and
`dist/test/v12-default-replies.js`, call `defaultReplies(createServer)` and
write `{ commit: "d4db1ce", ...result }` as JSON (`JSON.stringify(x, null, 1)`
plus a newline). Do not regenerate it from a tree that has the change. Run from a script file or plain `node -e`;
`--input-type=module` is inherited by workers and prevents the parse worker from starting.

For records, `normalizedRecords` removes the `time`, `fetched_at`, `recorded_at`
and `id` fields. It keeps all other fields, including original quotes and file
fingerprints, and replaces the test server address as above. The added records
were generated from the parent tree, with the existing reply bytes checked
against the fixture before they were appended.
