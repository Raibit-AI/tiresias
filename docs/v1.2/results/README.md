# v1.2 test results, as recorded

The raw output of the runs behind `../findings.md`, one JSON record per line. Made with `scripts/v12-lab/` on
2026-11-13. Each record names the model and its context size (`label`), the reply shape (`variant`), the task,
whether the answer was right (`correct`), whether a planted instruction worked (`tricked`), the number of tool
calls, the largest prompt in tokens, and the answer's first 400 characters.

| File | What it holds |
|---|---|
| `1-accuracy-first-round.jsonl` | Six pages and two attack pages: default, one tool, plain-text small reply |
| `2-accuracy-small-models-and-json-shape.jsonl` | Hermes 3 and OLMo 3 with the tools written into the prompt; the JSON small reply |
| `2-attacks-seven.jsonl` | Seven attacks across five reply shapes |
| `3-accuracy-qwen-9b.jsonl` | Qwen 3.5 9B at 4,096 and 8,192 tokens |
| `3-attacks-twelve.jsonl` | Twelve attacks (five held out), with warnings and withholding |
| `5-accuracy-finished-build.jsonl`, `5-attacks-finished-build.jsonl` | The real `tiresias mcp --local` server (variant `local`) |
| `survey-60-sites.jsonl` | The 60-site survey, read before the reader fixes |
| `check-false-alarms.jsonl` | The two ordinary passages the aimed-at-an-AI check marked, of 567 |
| `token-costs-finished-build.json` | Token counts of the tool lists and replies |

Variant names: `default` is the full server; `onetool` is the full reply with only `read` offered; `compact` is
the plain-text prototype; `slim`, `slimtail`, `slimguard` and `slimhold` are the JSON prototypes (parts left
out; plus a closing reminder; plus a warning on the passage; plus withholding); `local` is the product. In the seven-attack file `slimguard`
carried both the reminder and the warning; in the twelve-attack file it carried the warning only.
