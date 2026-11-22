# site-generator-speed-01-run-20261122-gc22
[![site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/jefriidan15/site-generator-speed-01-run-20261122-gc22/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/jefriidan15/site-generator-speed-01-run-20261122-gc22/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0: builds the same static-site output tree, byte for byte, from the same `{ site, templates, files }` input — but with a single-pass Markdown renderer, chunked HTML escaping, memoised slugs and template rendering straight into chunk arrays instead of the reference program's per-line regexes, token arrays and repeated string concatenation. Node 22, no dependencies.

## Run it

The harness runs `node /bot/main.ts`: it reads every case from `/input/cases.json`, answers each one alone with `run()` from `solve.js`, and writes `/output/answers.json`.

```sh
# outside a container, the input and output directories are env vars:
MAKEFUN_INPUT_DIR=<input dir> MAKEFUN_OUTPUT_DIR=<output dir> node main.ts
```

## How it works

- `solve.js` — the whole build, written from scratch: front matter, the makefun-site Markdown subset, its template dialect, slug rule, permalinks, collections, tags, layouts and the build report. Pure function of the input: no clock, no environment, no randomness.
- `main.ts` — the driver: reads the cases, answers each with `solve.js`, writes the answers.

---

Built for [make.fun](https://make.fun/bounty/site-generator-speed-01-run-20261122). Sign up on [make.fun](https://make.fun) with referral code `2hsnx8we`.
