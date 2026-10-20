# CI Diet

Find wasted GitHub Actions runner time and propose small, reviewable patches.

Status: **alpha, not published**. The contracts, specification, analysis
engine, patch engine, CLI, and DSH plugin tools are implemented and tested.
The Web UI screens and the npm release are still open.

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
quality gate measured on real repositories, because a noisy rule is worse than
a missing one.

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

## Install

```
npm install --global dsh-ci-diet
dsh plugin --profile web add dsh-ci-diet
```

The plugin adds one disabled loader entry; enable `networkEnabled` only if you
want history sync. Until the first npm release, install from a packed tarball:
`bun pm pack` then `dsh plugin --profile web add ./dsh-ci-diet-0.1.0.tgz`.

## Requirements

- Node `^22.19.0 || >=24.0.0`
- `gh` CLI, optional, only for execution history
- DSH `>=0.2.1-rc.2 <0.3.0`, optional, only for the plugin tools

## Development

```
bun install
node --test "tests/unit/*.test.ts"
node scripts/gen-types.mjs --check
node scripts/sync-contracts.mjs --check
bun run typecheck
bun run lint
bun run test:docs
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
contracts       JSON Schemas, imported from the frozen design pack
examples        sample records and evaluation vectors
docs/spec       normative product specification
scripts         contract and documentation checks
tests/unit      fast checks that need no network
```

## Languages

English is the default and the source of truth for message keys. Korean is
fully translated. Simplified Chinese is a translation slot that falls back to
English until someone maintains it. Public documentation is English, with a
Korean README mirror.

## Documentation

- Specification: [docs/spec/README.md](docs/spec/README.md)
- Rules: [docs/spec/rules.md](docs/spec/rules.md)
- Cost model: [docs/spec/cost-model.md](docs/spec/cost-model.md)
- Patch model: [docs/spec/patch-model.md](docs/spec/patch-model.md)
- Storage and errors: [docs/spec/storage.md](docs/spec/storage.md)
- Decisions: [docs/spec/decisions.md](docs/spec/decisions.md)
- Measurement: [docs/spikes/a0a-rules.md](docs/spikes/a0a-rules.md)
- Plugin and CLI guide: [docs/guide/plugin.md](docs/guide/plugin.md)
- Contract provenance: [contracts/UPSTREAM.md](contracts/UPSTREAM.md)
- Korean: [README.ko.md](README.ko.md)

## License

MIT