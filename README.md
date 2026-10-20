# CI Diet

Find wasted GitHub Actions runner time and propose small, reviewable patches.

Status: **design stage**. The v0.2.1 design pack is complete, but this
repository is still a scaffold. The analysis engine, patch engine, CLI, and
the DSH Web plugin are not implemented yet, so there is nothing to install.

## What it will do

CI Diet reads two things and compares them:

1. Workflow YAML from the current working tree.
2. Optionally, execution history fetched with read-only `gh api` calls.

From that it reports where runner minutes are spent and which findings are
safe to turn into a small YAML edit. Every finding carries an evidence level
(`observed`, `inferred`, `static`) and a coverage state per rule.

| Rule | Finds | Plan in v0.1 |
| --- | --- | --- |
| CD001 | PR runs superseded by a newer commit | patch: `concurrency` |
| CD002 | Overlapping triggers | explanation only |
| CD003 | Heavy checks on docs-only changes | explanation only |
| CD004 | Oversized matrices | explanation only |
| CD005 | Jobs without `timeout-minutes` | patch: `timeout-minutes` |
| CD008 | Long artifact retention | patch: `retention-days` |

The rule set is deliberately small. A rule ships only after it passes a
quality gate measured on real repositories, because a
noisy rule is worse than a missing one.

## What it will never do

- No commits, pushes, pull requests, or merges.
- No workflow runs, no cancelling running jobs, no deleting artifacts or caches.
- No branch protection changes.
- No write permission on GitHub. History access is read-only; a repository
  with no network access still gets the static scan.
- No LLM judging whether a job is wasteful.
- Patches are byte-range edits of the YAML you already have. You review the
  diff, approve it explicitly, and apply it to your working tree.

## Honest numbers

Cost output keeps four separate values and never mixes them:

| Field | Meaning |
| --- | --- |
| `observedRunnerSeconds` | What the run records actually say |
| `modeledRoundedMinutes` | Per-job minutes, rounded up the way billing does |
| `listPriceUsd` | Converted at the snapshot list price |
| `actualBilledUsd` | Always `null` until we can prove otherwise |

Every report embeds the pricing snapshot it used (with a content hash), so a
number can be reproduced later. If the snapshot cannot be verified, the report
is not shipped.

## Requirements

- Node `^22.19.0 || >=24.0.0`
- `gh` CLI, optional, only for execution history
- DeepSeek Harness Web, optional, only for the plugin UI

## Development

```
bun install
node --test "tests/unit/*.test.ts"
bun run typecheck
bun run lint
```

Run the tests with Node so the published entry points stay Node-compatible;
Bun is used for dependency management only.

## Layout

```
src/core        workflow parsing, rules, savings, patch engine
src/adapters    github, git, storage
src/dsh         host and client plugin code
src/cli         command line entry
src/shared      i18n and small shared helpers
contracts       JSON Schemas copied from the design pack
docs/design     versioned design packs (do not edit in place)
tests/unit      fast checks that need no network
```

## Languages

English is the default and the source of truth for message keys. Korean is
fully translated. Simplified Chinese is a translation slot that falls back to
English until someone maintains it.

## Documentation

- Korean: [README.ko.md](README.ko.md)
- Design pack v0.2.1: placed under `docs/design/v0.2.1` when imported.

## License

MIT
