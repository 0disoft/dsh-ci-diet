# A0a rule viability spike

Status: complete, 2026-10-20. This record measures which detection rules have
observable targets on public repositories before the rule engine is built.

## Question

For each of the six v0.1 rules: does the GitHub REST surface expose the evidence
the rule needs, and does that evidence contain enough cases to justify the rule?

## Sample

Ten public repositories were read once on 2026-10-20: microsoft/vscode,
facebook/react, vercel/next.js, rust-lang/rust, denoland/deno, oven-sh/bun,
vitejs/vite, withastro/astro, tailwindlabs/tailwindcss, microsoft/TypeScript-Website.

- Up to 100 most recent workflow runs per repository (1,000 runs total).
- Job details for 25 runs per repository: up to 18 pull-request runs plus 7 others.
- Workflow definitions from the default branch, pull-request file lists, and
  repository artifacts.
- 535 requests for the main collection and 310 for the docs-only probe, against
  a 1,500 request budget. No caching, retries, or backfill.
- Raw collection output stays out of the repository. The scripts are
  `scripts/spikes/a0a-collect.mjs`, `a0a-analyze.mjs`, and `a0a-pr-probe.mjs`;
  committed summaries are `evidence/a0a/collect-summary.json`,
  `evidence/a0a/metrics.json`, `evidence/a0a/pr-probe.json`, and
  `evidence/a0a/jobkey.json`.

Limitations: one snapshot, no historical definitions, no protection rules, no
cache inventory, no attempt-level separation beyond the latest attempt, and no
billing data. Durations are wall-clock job durations, not billed minutes.

## Evidence coverage

| Item | Value |
| --- | --- |
| Runs collected | 1,000 |
| Runs with job detail | 245 |
| Jobs observed | 1,047 |
| Observed runner hours | 163.88 |
| Registered workflows | 284 |
| Definitions resolved and parsed | 159 (56%) |
| Definitions dynamic or unresolvable without expansion | 48 |
| Definitions missing from the default branch (HTTP 404) | 77 |
| YAML parse errors among resolved definitions | 0 |
| Artifacts listed | 286 |

Two coverage findings matter more than the per-rule counts.

1. **Registered workflow is not the same as a readable definition.** The
   actions/workflows endpoint lists workflows such as vitejs/vite Codespell that
   return HTTP 404 from the default branch. The registry is repository-wide;
   contents are branch-scoped. Definition resolution must degrade coverage and
   record unresolved references instead of treating the scan as complete.
2. **A job row does not identify its YAML job key.** The jobs response `name` is
   the display name. Repositories that set `name:` or expand a matrix produce
   values such as `Compile & Hygiene` or `PR - test-x86_64-gnu-gcc` for keys
   such as `compile`, `job`, or `tests`.

## Results

| Rule | Result | Reading |
| --- | --- | --- |
| CD001 | 253 pull-request runs, 83 superseded (32.8%), 18 with jobs observed | Real and common. |
| CD002 | 28 workflows triggered by both push and pull_request | Real; candidate-only. |
| CD003 | 3 docs-only pull-request runs sampled (1 heavy); probe: 16 of 300 recent PRs (5.3%) | Rare and concentrated; inconclusive. |
| CD004 | 20 workflows use a matrix; largest product 21 | Real; description-only. |
| CD005 | 267 of 1,038 jobs reached a definition; p95 497s, median 21s; 0 workflows reach 20 samples | Not viable at the default budget. |
| CD008 | 276 of 286 artifacts exceed 7 days (96.5%), median 90 days | Strong; needs step resolution. |

CD001's 83 superseded runs are measured against a later run of the same pull
request in the sample window; this is a lower bound because the window truncates
future runs. CD008's artifact list is repository-wide and does not prove each
artifact came from a resolvable upload step, so it is a candidate signal, not a
patch-ready finding.

### CD005 detail

| Threshold | Workflows meeting it |
| --- | --- |
| At least 5 samples | 12 |
| At least 10 samples | 5 |
| At least 20 samples | 0 |

At the 20-sample write threshold no workflow is eligible. The 12 workflows that
reach five samples are large, long-running workflows whose job keys are usually
hidden behind display names. Lowering the threshold would not fix the mapping
problem and would weaken the p95 basis.

### Job key recovery

The mapping prototype refetched the 159 resolved definitions, parsed job `name:`
templates and literal matrix values, and tried four rules against the 1,298 jobs
with job detail:

| Rule | Jobs |
| --- | --- |
| Single-job workflow | 122 |
| Display name equals key | 78 |
| Display name equals `name:` literal | 213 |
| Matrix-expanded `name:` match | 115 |
| Unmatched | 770 |
| Match rate | 40.7% (53.5% excluding rust-lang/rust) |

rust-lang/rust accounts for 325 of the 770 unmatched jobs: its matrix values
arrive through `fromJSON`, so no static expansion can predict the display name.
vscode and next.js build names from expressions for the same effect. tailwindcss,
whose names are literal matrix templates, reached 84%.

Collapsing matrix variants into one key yields 162 cohorts: 14 reach at least 5
samples and one reaches at least 20 (tailwindcss integration tests, which already
carry a timeout). CD005 cohorts are per matrix value, so those 84 samples are
roughly four per variant. **At the default 100-run budget the 20-sample write gate
is effectively unreachable for matrix workflows, and no cohort both reached 20
samples and lacked a timeout.**

### Production port

`src/core/workflow` now implements the same two pieces: a yaml CST parse that
keeps UTF-8 byte ranges and reports unsupported shapes, and the four-step recovery
above. `scripts/spikes/a0a-parser-verify.mjs` replays it over the same 1,298 job
rows (evidence in `evidence/a0a/parser-verify.json`):

| Rule | Jobs |
| --- | --- |
| Single-job workflow | 122 |
| Display name equals key | 78 |
| Display name equals `name:` literal | 213 |
| Matrix-expanded `name:` match | 157 |
| Unmatched | 728 |
| Match rate | 43.9% |

The 3.2 point gain over the prototype comes from honoring `matrix.include` and
`matrix.exclude`, which adds combinations the prototype dropped. Cohorts: 165
total, 17 reach five samples, three reach twenty. None of the sampled definitions
needed an unsupported-shape fallback. The parser is still the gate: when a
definition is unparsable or its shape is unsupported, the rule that needs it skips
instead of guessing.

## Gate decisions

| Rule | Gate | Decision |
| --- | --- | --- |
| CD001 | Pass | Keep. Default on. |
| CD002 | Pass (candidate) | Keep as a candidate-only rule. Default on. |
| CD003 | Inconclusive | Do not enable by default; expand the PR-file sample in A0b and make it opt-in for documentation-heavy repositories. |
| CD004 | Pass (description) | Keep as description-only. Default off. |
| CD005 | Fail at default budget | Keep the 20-sample requirement. Resolve job keys before any cohort or plan; until then the rule stays silent and is off by default. |
| CD008 | Pass | Keep. Default on. |

The v0.1 default enabled set is CD001, CD002, and CD008, which also satisfies
ADR-08. CD005 remains implemented and write-eligible in the contract, but off by
default until job-key resolution lands.

## Job key resolution

Before CD005 can form a cohort, the job key must be recovered from the parsed
definition, in this order:

1. A workflow with exactly one job maps to that key.
2. A display name equal to a job key maps directly.
3. A display name equal to the definition's literal `name:` value maps to that
   job.
4. A matrix display name whose base matches a job `name:` template maps only when
   the expanded values match the observed job name.

Anything else is review-only. The jobs API does not expose the key, so an
implementation that skips this step will silently lose most jobs, and one that
guesses will attribute a timeout recommendation to the wrong job.

## What this does not prove

- That the savings numbers are accurate; no billing data was read.
- That a patch produced from these findings applies cleanly; no patch was made.
- That the sample represents small repositories. All ten are high-volume projects
  whose display names and matrices are the hard case, which biases the mapping
  result downward and the CD001 result upward.

## Reproduce

```sh
node scripts/spikes/a0a-collect.mjs
node scripts/spikes/a0a-analyze.mjs
node scripts/spikes/a0a-pr-probe.mjs
```

Each script needs an authenticated `gh` CLI and writes only under
`evidence/a0a/`.
