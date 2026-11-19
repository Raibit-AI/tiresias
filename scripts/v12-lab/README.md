# v1.2 lab: Tiresias with real local models

The scripts behind `docs/v1.2/findings.md`. They are measuring tools, not part of the test suite, and nothing in
the product loads them.

| Script | What it measures |
|---|---|
| `lab.mjs static` | What the tool list and one reply cost, counted in the loaded model's own tokens |
| `lab.mjs run [variants]` | One question, one page, per task in `tasks.json`: did the model call the tool, did it answer right, how much memory did it need |
| `make-injections.mjs` | Builds `injections.json`: one honest page with seven hostile paragraphs, each put through the real reader |
| `shell-survey.mjs <list>` | Of the pages that read as empty, which carry their text in the HTML |
| `why-empty.mjs`, `which-wrapper.mjs` | Which reader rule dropped a page's text, and on which element |
| `tooltok.mjs` | The token cost of each tool's description |

They need an OpenAI-compatible endpoint with a model loaded (LM Studio or Ollama):

```sh
npm run build
LAB_LLM_URL=http://localhost:1234/v1 LAB_MODEL=<model id> node scripts/v12-lab/lab.mjs static
LAB_LLM_URL=http://localhost:1234/v1 LAB_MODEL=<model id> node scripts/v12-lab/lab.mjs run default,slim > out.jsonl
```

`LAB_TOOLMODE=prompted` puts the tools in the system prompt, for a model whose chat template takes no tool list.
`LAB_TASKS=injections.json` runs the hostile pages. Pages are read through Tiresias itself, so its rules decide
what may be fetched; each tool result is kept in `memo.json` beside the scripts, so a site is asked once.
