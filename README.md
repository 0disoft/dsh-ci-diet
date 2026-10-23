# CI Diet

[English](README.md) · [한국어](README.ko.md) · [简体中文](README.zh-Hans.md) · [हिन्दी](README.hi.md) · [Español](README.es.md) · [Français](README.fr.md)

**Status:** alpha; `dsh-ci-diet@0.3.1` is on npm. The current source tree adds the **Settings → CI Diet Reports** review screen to the existing contracts, analysis and patch engines, CLI, DSH tools, Settings page, and self-contained HTML report. The review screen passed a real-browser E2E check in an earlier commit. The one-time defaults migration was verified separately in a DSH `0.2.1-rc.2` runtime with configEditor, SettingsForms, and Loader; it was not a new browser render. The DSH plugin now starts with preflight, history network access, and local apply enabled.

**DSH defaults and migration.** New DSH profiles start with `preflightEnabled`, `networkEnabled`, and `localApplyEnabled` set to `true`, and with CD001, CD002, CD004, CD006, and CD008 enabled. On the first start of an existing profile, CI Diet uses DSH's locked config editor to save those switches, add those rules to the existing selection, and record `defaultsRevision: 1` in that profile. State paths, retention, quotas, billing inputs, and an existing explicit CD003 or CD005 enablement are preserved. After that save, a switch you turn off or a rule you exclude survives restarts and updates; CD003 and CD005 stay off unless enabled, and billing estimates remain off by default with explicit activation required, while an existing on setting is preserved.

CI Diet finds GitHub Actions work that is likely wasted, preserves the evidence behind each finding, and previews small workflow edits for a human to review.

**Installation alone does not save runner minutes.** Supported DSH deploy commands are checked automatically for savings candidates before running; workflow changes are applied only after review and approval. The DSH plugin has no approval, apply, or revert tools, and preflight itself never changes files. Its Settings pages store tool configuration and show the host's session-scoped reports and plans; they do not optimize a workflow. Approved local writes are enabled by default, but applying still requires a separate digest approval. There is no guarantee that any finding will reduce cost.

`preflightEnabled` is on by default. Before a literal `git push`, `npm|pnpm|bun publish`, `wrangler deploy`, or `npm|pnpm|bun run deploy` in a supported stateless DSH bash tool (one with a `workdir` argument), CI Diet runs an offline check. It flags npm CD006 candidates, a missing concurrency block in a PR-only workflow, and a Bun frozen install without an explicit download cache for review. When a candidate exists, the first command does not run; after the model reviews the items, retrying the same command is allowed. Preflight itself makes no network request and no automatic file change, and applying a plan still needs human approval. Persistent shells and complex shell wrappers cannot be identified reliably, so preflight skips them. Savings remain unmeasured, so no saving is claimed.

## What it does

The static scan reads workflow YAML in a target checkout. The optional history sync uses read-only `gh api` calls to collect recent runs. Findings carry an evidence level (`observed`, `inferred`, or `static`) and per-axis collection coverage.

| Rule | Finds | Possible plan |
| --- | --- | --- |
| CD001 | PR runs made obsolete by a newer commit | `concurrency` edit |
| CD002 | Overlapping triggers | explanation only |
| CD003 | Heavy checks for docs-only changes | explanation only; off by default |
| CD004 | Oversized matrices | explanation only |
| CD005 | Jobs without `timeout-minutes` | timeout edit; off by default |
| CD006 | `actions/setup-node@v3` or `@v4` jobs that run `npm ci` without npm caching | two setup-node inputs; on by default |
| CD008 | Long artifact retention | retention edit |

CD001 helps overlapping superseded PR runs. CD005 caps abnormal runs; it does not reduce normal job runtime. CD008 changes artifact storage retention, not runner minutes. CD003 and CD005 remain off until their quality gates pass. CD006 is a default static rule for one narrow npm shape: it adds setup-node's download cache while `npm ci` and every test still run. A cache can reduce downloads after it warms up; no time or money saving is claimed until cold and warm runs are compared.

## Install and upgrade

The CLI requires Node `^22.19.0 || >=24.0.0`. The plugin supports DSH `>=0.2.1-rc.2 <0.3.0-0` and `>=0.2.2-rc.1 <0.3.0-0`. Version `0.3.1` was tested against DSH `0.2.1-rc.2`; DSH `0.3.0` is not supported.

```
npm install --global dsh-ci-diet@0.3.1
ci-diet --version
```

Without a global install, replace the `ci-diet` command name with `npx dsh-ci-diet@0.3.1`, for example `npx dsh-ci-diet@0.3.1 report --cwd .`.

```
dsh plugin --profile web add dsh-ci-diet@0.3.1
dsh --profile web
```

Installing registers the plugin tools, the Settings page, and the **Settings → CI Diet Reports** review screen. Preflight, network access, and local apply are on by default for the plugin. Installation and startup do not call `gh`, collect history, run a scan, or modify a workflow.

```
npm install --global dsh-ci-diet@latest
dsh plugin --profile web add dsh-ci-diet@latest
```

Restart DSH after updating the plugin. Use `dsh plugin --profile web list`, `ci-diet --version`, or `npx dsh-ci-diet@latest --version` to verify the installed versions.

## First scan and history report

Run these commands from the repository you want to inspect. `--cwd .` means that repository; `--cwd` accepts another path, and relative paths resolve from the effective working directory. The first command is offline. History collection is a separate, explicit network opt-in.

```
ci-diet scan --cwd .
gh auth status
ci-diet sync --cwd . --network
ci-diet report --cwd .
ci-diet report --cwd . --format html --out report.html
```

`scan` prints a static report without network access; `--json` or `--out FILE` writes that output, but CLI scan does not save a report in the state store. `report` needs a saved report from CLI `sync`, plugin `ci_diet_scan`, or plugin `ci_diet_sync`. In this CLI-only sequence, sync stores the report; the HTML option then writes one self-contained file. History sync needs `gh` installed, authenticated, and able to read the repository’s Actions runs and jobs. `sync --network` is the CLI opt-in. It never needs GitHub write permission. A partial history still produces and stores a report, marking incomplete coverage. The plugin’s offline `ci_diet_scan` does save its report, so `ci_diet_report` can follow it directly.

For the DSH plugin, network access is enabled by default, so `ci_diet_sync` can run once `gh` is installed and authenticated. The switch only permits that tool to call `gh`; installation, startup, and Settings saves do not collect history by themselves. To block plugin network use, turn off **Allow network access** in **Settings → CI Diet** and choose **Save changes**. The page setting applies to plugin tools; it does not enable the CLI’s `--network` flag. Static scan and report work without network. The Settings page does not run an optimization by itself.

A useful chat request makes the sequence and review boundary explicit. Replace the example absolute path with your own repository:

> Run `ci_diet_scan` with cwd `C:\work\my-repo`, then `ci_diet_sync` for that same cwd and `ci_diet_report`. If `gh` is not authenticated or I turn off network access, stop after the scan. If you preview a patch with `ci_diet_plan`, show the edits only. Do not approve, apply, revert, commit, push, or deploy anything.

The plugin preview does not save a plan. Its `nextCommand` re-creates the plan through the CLI so that the plan is durable and can enter the human approval flow.

## Offline npm cache plan (CD006)

CD006 needs no run history. It matches a job at the repository root where `actions/checkout` has no user `with` options, exactly one `actions/setup-node@v3` or `@v4` step follows it without caching, and the next step's `run` is exactly `npm ci`. The root `package.json` and `package-lock.json` must be committed, regular JSON files. The plan adds only `cache: npm` and `cache-dependency-path: package-lock.json` to setup-node; it does not change Node, action versions, `npm ci`, tests, or local caching.

```
ci-diet plan --cwd . --rule CD006 --workflow .github/workflows/ci.yml --job test --step 1
ci-diet plans --cwd . --plan PLAN_ID
```

`--step` is the zero-based index of the setup-node step; this example assumes checkout is step 0 and setup-node is step 1. CLI `plan` performs this static scan in memory and saves the plan without a prior `sync`; it leaves the latest saved report untouched. The plugin `ci_diet_plan` still needs a saved report, so run `ci_diet_scan` first. Approve and apply through the existing commands below. The plan and its attestation are saved during planning; no workflow file changes until a person approves the plan and runs apply.

## CLI command reference

```
ci-diet scan --cwd .
ci-diet sync --cwd . --network
ci-diet sync --cwd . --network --repo OWNER/REPO --days 7
ci-diet report --cwd .
ci-diet report --cwd . --format json
ci-diet report --cwd . --format html --out report.html
ci-diet diagnose --cwd .
ci-diet prune
ci-diet changes --cwd .
ci-diet plans --cwd . --plan PLAN_ID
ci-diet report --cwd . --lang ko
```

`scan` checks workflow files. `sync` reads history only after `--network`; `--repo` selects `OWNER/REPO` explicitly and `--days` adjusts the lookback within its configured bounds. `report` renders text, JSON, or HTML and writes `--out` relative to `--cwd`. `diagnose` explains job-name matching and coverage from stored history; add `--require-complete` to exit `3` for incomplete data. `prune` removes expired reports, plans, and cache entries under the state store settings. `changes` lists applied changes; `plans` reopens a saved plan. `--config FILE` merges a partial JSON configuration for any command.

## Review, approve, apply, and revert

A successful CLI `plan` prints the proposed diff, a real plan id such as `p_...`, and a confirmation made from the last 12 characters of the plan digest. Plan creation refuses stale evidence and other unsafe writes; a missing workflow can be a usage error with exit `1`. If a saved plan is viewed after its workspace or workflow disappears, `plans --plan` hides the diff, preserves the plan JSON, asks for a replan, and exits `3`. The same occurs when the workflow bytes no longer match the saved source hash. Inspect the diff and the plan again before approving.

```
ci-diet plan --cwd . --rule CD001 --workflow .github/workflows/ci.yml --claims ci-only,replace-safe
ci-diet plans --cwd . --plan PLAN_ID
ci-diet approve --cwd . --plan PLAN_ID --confirm CONFIRMATION
ci-diet apply --cwd . --plan PLAN_ID
ci-diet revert --cwd . --change CHANGE_ID
```

Replace `PLAN_ID` with the id printed by the plan, `CONFIRMATION` with its 12-character digest tail, and `CHANGE_ID` with the id printed by apply. Every value is a literal argument; do not type angle brackets. `approve` creates a single-use approval, `apply` rewrites only the planned byte range in one workflow file, and `revert` restores that change’s backup. Review the resulting diff and run the repository’s checks as needed. CI Diet does not commit, push, deploy, run workflows, change branch protection, or delete artifacts.

For eligible PR-only CI, the CD001 example uses `ci-only` and `replace-safe` as human attestations. They state the operator’s review of cancellation semantics; they are not bypass switches. CD005 needs a measured `--job` and `--minutes`, and CD008 needs `--job`, a zero-based numeric `--step` array index for the target step, and artifact claims. CD006 needs `--job` and the zero-based `--step` index of the setup-node step; it has no claims. In both step rules, the numeric step is an array index, not a step-name token.

## State and limitations

The CLI and plugin share the default state directory: `%LOCALAPPDATA%\CI-Diet\profiles\default` on Windows, otherwise `~/.local/state/ci-diet/profiles/default`. A plugin `stateDir` override is a separate store; pass the same absolute path to the CLI with `--state-dir` on `plan`, `approve`, `apply`, and `revert`. Relative CLI `--state-dir` paths resolve against the effective `--cwd`. Existing state is never migrated automatically between directories.

The Web client has Settings and the **CI Diet Reports** review screen. Report, approve, apply, and revert controls passed a real-browser E2E check in an earlier commit. The defaults migration was verified separately in a DSH `0.2.1-rc.2` runtime with configEditor, SettingsForms, and Loader in a temporary profile: legacy `false` values were saved as `true`, and a later explicit `false` survived restart. That runtime check was not a new browser render. Approval and apply reach the host from that screen, and `localApplyEnabled` is on by default. No plugin tool performs approval or application. A plan edits one existing workflow file at byte ranges and refuses unsupported structures. Findings can be wrong or incomplete when history or workflow attribution is partial, and another system may have more accurate billing data. Use the report as review evidence, then verify the effect in GitHub.

## Cost and evidence

| Field | Meaning |
| --- | --- |
| `observedRunnerSeconds` | Runner time recorded by collected runs |
| `modeledRoundedMinutes` | Per-job minutes rounded up for modeling |
| `listPriceUsd` | Cost at the embedded list-price snapshot |
| `actualBilledUsd` | Always `null` until the actual bill can be proven |

Reports embed the pricing snapshot and a content hash so numbers can be reproduced. They do not claim automatic savings. The HTML report has inline CSS, no scripts, and no external requests.

## Languages

The DSH Settings UI, CLI messages, HTML reports, and these six READMEs support English, Korean, Simplified Chinese, Hindi, Spanish, and French. The detailed specifications remain English. Selection order is `--lang`, the DSH locale, `LC_ALL`/`LC_MESSAGES`/`LANG`, then English. The CLI language codes are `en`, `ko`, `zh-Hans`, `hi`, `es`, and `fr`; replace `ko` in the example command with the desired code. Regional tags resolve by language. Reports are stored in English and localized when displayed. Rule ids, error codes, enum values, paths, hashes, and numbers stay literal. The HTML `lang` attribute follows the selected locale. DSH tool descriptions are captured at plugin load, so reload after changing the DSH language preference.

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

Run tests with Node so published entry points stay Node-compatible. Bun is used for dependency management.

## Release

Pushing a tag that matches `package.json` starts `.github/workflows/publish.yml`. In the following commands, replace the literal `VERSION` in both arguments with a new version; version `0.3.1` is already published, so do not create that tag again.

```
git tag vVERSION
git push origin vVERSION
```

The workflow compares the tag with `package.json`, runs the release checks, refuses an existing npm version, and publishes with npm trusted publishing through GitHub OIDC. The trusted publisher must name `publish.yml`.

## Layout

```
src/core        workflow parsing, rules, savings, patch engine
src/adapters    GitHub, git, storage
src/client      Web Settings and review UI
src/dsh         host plugin and bundle code
src/cli         command-line entry
src/shared      i18n and shared helpers
contracts       JSON Schemas from the frozen design pack
examples        sample records and evaluation vectors
docs/spec       normative specification
scripts         contract and documentation checks
tests/unit      fast checks that need no network
```

## Documentation

The detailed specification, rule, cost, patch, storage, and decision documents are English. The specification index is [docs/spec/README.md](docs/spec/README.md). Also available: [rules](docs/spec/rules.md), [cost model](docs/spec/cost-model.md), [patch model](docs/spec/patch-model.md), [storage and errors](docs/spec/storage.md), [decisions](docs/spec/decisions.md), [measurement](docs/spikes/a0a-rules.md), the [plugin and CLI guide](docs/guide/plugin.md), and [contract provenance](contracts/UPSTREAM.md).

## License

MIT
