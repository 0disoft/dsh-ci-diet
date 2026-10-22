# CI Diet

Find wasted GitHub Actions runner time and propose small, reviewable patches.

Status: **alpha, published on npm** as `dsh-ci-diet@0.2.0`. The contracts,
specification, analysis engine, patch engine, CLI, DSH plugin tools, and a
self-contained HTML report are implemented and tested. The DSH Web client
screens are still open.

## What it does

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
a missing one. CD003 and CD005 are implemented but disabled by default until
that gate passes (see ADR-13).

## What it never does

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

The plugin adds one disabled loader entry and a **Settings → CI Diet** page.
The page edits every engine setting used by the DSH tools: analysis rules, history
caps, storage limits, the cost estimate, network access, and the state directory.
Values use the same contract validation and defaults as `ci-diet --config`, apply
to the next tool call without a restart, and never rewrite the CLI's own config.
`localApplyEnabled` is not exposed because there is no apply tool yet. Installing
the package globally is optional: `npx dsh-ci-diet` runs the same CLI, and the DSH
plugin only needs the package in the profile. Release tags are on GitHub; the
matching npm version is `0.2.0`.

## Run it

```
ci-diet scan --cwd .                     # static scan, no network
ci-diet sync --network                   # read GitHub Actions history for this checkout
ci-diet plan --rule CD001 --workflow .github/workflows/ci.yml \
             --claims ci-only,replace-safe
ci-diet approve --plan <planId> --confirm <digest tail>
ci-diet apply --plan <planId>            # rewrites only the planned byte range
ci-diet revert --change <changeId>       # restores the backed-up bytes
```

`plan` refuses to write when the finding is not patch-eligible, when coverage
does not allow a write, or when the policy snapshot a rule depends on is stale.
CD005 needs `--job` and `--minutes`; CD008 needs `--job` and `--step`, plus
`--claims artifact-purpose:temporary,consumer-min-days:7`. Nothing is committed,
pushed, or applied without the explicit `approve` step.

`--config <file>` merges a partial JSON configuration over the built-in defaults
for any command, so a repository can lower the workflow size limit or the
storage quota without code changes. The merged document is validated against
the frozen contract before the command runs; an unreadable or invalid file
exits `2`. Relative paths resolve against the effective `--cwd`.

## Read a report

```
ci-diet report                 # text summary of the latest stored report
ci-diet report --format html --out report.html
ci-diet diagnose               # explain job-name attribution and collection coverage
ci-diet prune                  # drop expired reports, plans, and cache entries
```

The HTML file is self-contained: inline CSS, no scripts, no external requests.
It is read-only, so approvals stay in the CLI where the digest and nonce checks
live.

`diagnose` reads the latest stored history and reports how many GitHub job
names resolved to workflow keys, which matrix jobs expanded, and which
collection caps left a coverage axis incomplete. It is read-only and works
offline; `--require-complete` exits `3` when any axis is incomplete.

It also lists advisory cache hygiene hints: a dependency install with no cache,
and a literal cache key that cannot follow the lockfile. The frozen contract has
no cache rule id, so hints never become findings or patches.


## Releasing

Pushing a tag that matches the version in `package.json` triggers
`.github/workflows/publish.yml`:

```
git tag v0.2.0
git push origin v0.2.0
```

The workflow compares the tag with `package.json` (`node
scripts/check-release-tag.mjs`), runs the same checks as CI, refuses to
overwrite an already published version, and then publishes with npm trusted
publishing. It uses GitHub OIDC (`id-token: write`) and no npm token, so the
package's trusted publisher must name `publish.yml` for this repository.

## Requirements

- Node `^22.19.0 || >=24.0.0`
- `gh` CLI, optional, only for execution history
- DSH `>=0.2.1-rc.2 <0.3.0-0 || >=0.2.2-rc.1 <0.3.0-0`, optional, only for
  the plugin tools

## Development

```
bun install
node scripts/test-core.mjs
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

English is the default and the source of truth for message keys. The CLI, the
HTML report, and DSH tool text ship in English, Korean, Simplified Chinese,
Hindi, Spanish, and French; every dictionary is complete, so a missing key is a
type error. Regional tags resolve by language (`hi-IN`, `es-MX`, `fr-CA`), and
Chinese variants that are not Simplified fall back to English.

Language selection is an explicit `--lang`, then the DSH locale preference,
then `LC_ALL`/`LC_MESSAGES`/`LANG`, then English. Reports are stored in
English and translated only when displayed: rule ids, error codes, enum values,
paths, digests, and numbers stay untranslated, and the HTML report sets its
`lang` attribute to the selected locale. DSH tool descriptions are captured at
plugin load, so changing the DSH language preference needs a reload. Public
documentation is English, with a Korean README mirror.

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