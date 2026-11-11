`form-refusals-parent.json` is a frozen real-parser baseline from commit
`8776fa4` (HEAD before the r2 fixes). It records the index and original
`not_allowed` code of all 5,524 refused cases among the 6,000 HTML strings
returned by `preservationCases()` in `src/test/form-review-cases.ts`.

The SHA-256 covers `JSON.stringify(preservationCases())`, in UTF-8, to prevent
changes to the generator from silently reinterpreting the frozen indices.
The preservation test parses every generated case and requires every previously
refused form to remain refused. A stronger reason may replace the original code.
The separate 25-case regression table still checks exact reasons.

To reproduce the baseline, compile the parent tree, run its `parseHtml` on each
case with `https://forms.example/contact` as the page URL and a `keep` object,
and record `[index, keep.forms[0].not_allowed]` for each refused form. Do not
regenerate the fixture using the modified guard.
