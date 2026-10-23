# CI Diet plugin guide

CI Diet ships as one npm package with a command-line tool and a DeepSeek Harness (DSH) plugin. They share contracts and the default local state directory, but their first-use flows differ: CLI `scan` prints a report, while CLI `sync` saves one. The plugin's `ci_diet_scan` and `ci_diet_sync` both save reports.

Installing the package does not invoke a scan, edit a workflow, or save runner minutes. A chat request to write or deploy code does not invoke CI Diet tools either. The plugin exposes only explicitly called scan, sync, report, prune, and plan tools. It has no automatic pre-push or deploy hook and no approval, apply, or revert tools. The Settings page changes tool configuration; it does not optimize a workflow.

## Install and update

```
npm install --global dsh-ci-diet@0.3.1
dsh plugin --profile web add dsh-ci-diet@0.3.1
```

The plugin supports DSH `>=0.2.1-rc.2 <0.3.0-0` and `>=0.2.2-rc.1 <0.3.0-0`. Version `0.3.1` was tested against DSH `0.2.1-rc.2`; DSH `0.3.0` is not supported. Installing registers the plugin tools and the **Settings → CI Diet** page. Network access is off by default, and starting DSH does not start a scan or modify a workflow.

To update, run the same installation commands with `@latest`, then restart DSH. Confirm the plugin with `dsh plugin --profile web list` and the CLI with `ci-diet --version` or `npx dsh-ci-diet@latest --version`.

## First use

Run CLI commands from the target repository. `--cwd .` selects that checkout; `--cwd` can take another path. The static command is offline. History collection is a separate network opt-in.

```
ci-diet scan --cwd .
gh auth status
ci-diet sync --cwd . --network
ci-diet report --cwd .
ci-diet report --cwd . --format html --out report.html
```

CLI `scan` prints the static report. Use its `--json` or `--out FILE` option to write that output, but scan does not save a report in the state store. `ci-diet report` needs a saved report, so this CLI sequence uses `sync --network` to create it. `sync` needs `gh` installed, authenticated, and able to read the repository's Actions runs and jobs. It uses read-only access and does not need GitHub write permission.

With DSH, call `ci_diet_scan` with an absolute `cwd` for static analysis. It saves a report, so `ci_diet_report` can follow immediately without network. To collect history, open **Settings → CI Diet**, enable **Allow network access**, and choose **Save changes**. Then call `ci_diet_sync` for the same `cwd`, followed by `ci_diet_report`. The plugin setting applies to plugin tools and does not enable the CLI's `--network` flag.

A useful chat request names the calls and stops before any mutation:

> Run `ci_diet_scan` with cwd `C:\work\my-repo`. If I enable network access in Settings → CI Diet, run `ci_diet_sync` for the same cwd and then `ci_diet_report`. If you preview a patch with `ci_diet_plan`, show the edits only. Do not approve, apply, revert, commit, push, or deploy anything.

## Settings

The Settings page edits the engine configuration read by DSH tools. Every engine field is live: the next tool call reads the current value without reloading the plugin. Saves are validated against the same contract as the CLI and applied as one atomic batch. A save that conflicts with a newer revision is refused. CLI `--config` files and flags remain separate.

| Group | Fields |
| --- | --- |
| Connection | `networkEnabled`, `stateDir` |
| Analysis rules | `rules` (`CD001`, `CD002`, `CD003`, `CD004`, `CD005`, `CD008`); at least one remains enabled |
| History collection | `historyLookbackDays`, `historyMaxRuns`, `historyMaxRequests`, `historyConcurrentRequests`, `historyRequestTimeoutMs` |
| Storage | `storageStoreMaxBytes`, `storageWorkflowMaxBytes`, `storageCacheMaxBytes`, `storageCacheDays`, `storageReportDays`, `storagePlanDays`; zero disables that cap |
| Cost estimate | `billingEnabled`, `billingIncludedMinutes`, `billingAccountMinutesUsed` |

Network access defaults to false. Static scans and reports work offline. History sync requires network access and authenticated `gh` read access. Changing settings does not run a scan or install a hook.

## Model tools

| Tool | Network | Writes | Purpose |
| --- | --- | --- | --- |
| `ci_diet_scan` | no | saves a report | Static scan of `.github/workflows` in a checkout |
| `ci_diet_sync` | yes | saves history and a report | Read-only GitHub Actions history sync with `gh` |
| `ci_diet_report` | no | nothing | Summarize the latest saved report |
| `ci_diet_prune` | no | deletes expired data | Apply configured report, plan, and cache retention to the local store |
| `ci_diet_plan` | no | nothing | Preview patch eligibility and edits; does not save or approve a plan |

`ci_diet_scan` accepts `cwd` and an optional `rules` list. Use an absolute repository path so the binding and saved report target the intended checkout. It never fetches history.

`ci_diet_sync` accepts `cwd`, optional `repo`, and `days`. Without `repo`, it uses the checkout's GitHub origin. It requires the Settings network switch. A partial collection still saves a report and marks incomplete coverage.

`ci_diet_report` reads the latest saved report. Run scan or sync first. It does not update evidence.

`ci_diet_prune` removes reports, plans, and cache entries according to live storage settings, then reports freed bytes and quota state. It never deletes applied-change backups. Removing those requires the listing token from the CLI.

`ci_diet_plan` takes `rule`, `workflow`, `cwd`, optional `job`, numeric `step`, `minutes`, and `claims`. Numeric `step` is the zero-based index in the workflow's step array, not a label such as `upload`. The tool returns edits, coverage, blockers, a plan digest, and `nextCommand`; it does not create or save a durable plan and never approves or applies anything. `nextCommand` reruns CLI `ci-diet plan` with the same absolute cwd and state directory so a human can inspect and save the plan there. `ci-only` and `replace-safe` are human attestations for eligible PR-only CD001 changes, not bypass switches.

## Command line

```
ci-diet scan --cwd .
ci-diet scan --cwd . --json --out static-report.json
ci-diet sync --cwd . --network --repo OWNER/REPO --days 7
ci-diet plan --cwd . --rule CD001 --workflow .github/workflows/ci.yml --claims ci-only,replace-safe
ci-diet plan --cwd . --rule CD005 --workflow .github/workflows/ci.yml --job build --minutes 20
ci-diet plan --cwd . --rule CD008 --workflow .github/workflows/ci.yml --job build --step 0 --claims artifact-purpose:temporary,consumer-min-days:7
ci-diet plans --cwd . --plan PLAN_ID
ci-diet approve --cwd . --plan PLAN_ID --confirm CONFIRMATION
ci-diet apply --cwd . --plan PLAN_ID
ci-diet revert --cwd . --change CHANGE_ID
ci-diet changes --cwd .
ci-diet report --cwd .
ci-diet report --cwd . --format json
ci-diet report --cwd . --format html --out report.html
ci-diet diagnose --cwd .
ci-diet prune
ci-diet report --cwd . --lang ko
```

Replace `PLAN_ID` with the id printed by `plan`, `CONFIRMATION` with the final 12 characters of the plan digest, and `CHANGE_ID` with the id printed by `apply`. `OWNER/REPO` is a literal argument shape, not a shell redirection. The CD008 `--step 0` command is valid only when the target retention step is actually step index zero; use the correct zero-based numeric index for another step.

CLI `scan` prints a report or writes it to `--out`; it does not add the report to the state store. CLI `sync` stores history and a report. `report`, `plan`, approve, apply, revert, list, and prune operations rely on the state store.

`plan` requires a matching saved report and eligibility. Missing workflow or argument errors can exit `1`; stale evidence, incomplete coverage, a changed source, and other refused writes exit `3`. It prints a real plan id and confirmation and saves the plan. `plans --plan` reopens it. If the workspace or workflow has disappeared, or workflow bytes no longer match the saved source hash, the saved-plan view hides the diff, preserves the plan JSON, asks for a replan, and exits `3`.

`approve` consumes the 12-character confirmation tail and creates a one-use approval. `apply` verifies the digest, approval nonce, policies, dependencies, source bytes, command, backup, and lock before rewriting one file's planned byte range. `revert` restores the backup for the printed change id. None of these commands commits, pushes, deploys, runs a workflow, changes branch protection, or deletes artifacts.

All commands accept `--config FILE`, which merges a partial JSON configuration over defaults and validates the result before running. `--lang` selects display language. Relative `--out` and `--state-dir` paths resolve against the effective `--cwd`.

## Plan requirements and blockers

A plan requires a patch-eligible finding in the latest saved report for the same binding. It refuses when evidence no longer matches, coverage does not permit a write, or a required policy snapshot is stale.

| Rule | Human claims | Other evidence |
| --- | --- | --- |
| CD001 | `ci-only`, `replace-safe` | PR-only trigger, no existing concurrency, no deploy job, fresh branch-protection policy |
| CD005 | none | A qualifying cohort, measured timeout recommendation, no existing timeout |
| CD008 | artifact purpose and consumer minimum days | Artifact retention evidence above the proposed value and a fresh retention policy |

CD005 caps abnormal runs and does not reduce normal job runtime. CD008 changes artifact storage retention, not runner minutes. CD003 and CD005 are disabled by default until their quality gates pass. Cache hints are advisory only because the frozen contract has no cache rule.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success; a partial report can still succeed |
| `1` | Usage or unexpected error |
| `2` | Contract violation |
| `3` | Incomplete evidence or refused write |
| `4` | Invariant failure, including a revert that cannot restore matching bytes |
| `5` | Approval refused or nonce invalid |
| `6` | Backup unavailable |
| `130` | Cancelled with Ctrl+C |

## State

The CLI and plugin use the same default store by default: `%LOCALAPPDATA%\CI-Diet\profiles\default` on Windows, otherwise `~/.local/state/ci-diet/profiles/default`.

The plugin's `stateDir` override points at a separate store. When it is set, use the same absolute directory with CLI `--state-dir` for scan when needed, sync, plan, plans view, approve, apply, and revert. Relative CLI state paths resolve against the effective `--cwd`, but the plugin override should be treated as an absolute path. Existing state is never migrated automatically.

Bindings, reports, plans, attestations, backups, changes, and the event log live in separate subdirectories. Default report retention is 90 days and plan retention is 7 days. Applied-change backups are not removed by automatic prune.

## Reports and diagnostics

The text report shows the report id, observed runner time, modeled minutes, list price, findings, and incomplete coverage axes. JSON emits the stored `AnalysisReport`. HTML is one self-contained file with inline CSS, no scripts, and no external URLs.

Reports keep four cost values separate: `observedRunnerSeconds`, `modeledRoundedMinutes`, `listPriceUsd`, and `actualBilledUsd`. The actual billed value remains `null` until it can be proven. Each report embeds the pricing snapshot and content hash used for reproduction. A finding or plan is not a claim that CI time was saved.

`ci-diet diagnose` is read-only and works from stored history. It explains job-name attribution, matrix expansion, incomplete collection axes, and advisory cache hygiene. `--require-complete` exits `3` when an axis is incomplete or a run has no resolved definition.

## Languages

The DSH Settings UI, CLI messages, HTML reports, and the six READMEs support English, Korean, Simplified Chinese, Hindi, Spanish, and French. Detailed specification documents remain English.

Selection order is `--lang`, the DSH locale preference, `LC_ALL`/`LC_MESSAGES`/`LANG`, then English. The CLI language codes are `en`, `ko`, `zh-Hans`, `hi`, `es`, and `fr`; replace `ko` in the example command with the desired code. Regional tags resolve by language. An explicit unsupported `--lang` falls back to English.

Reports are stored in English and translated when displayed. Rule ids, error codes, enum values, paths, hashes, and numbers stay literal. HTML sets `lang` to the selected locale. Model tool descriptions are captured when the plugin loads, so reload after changing the DSH language preference.

The detailed specs and decisions remain English: [specification index](../spec/README.md), [rules](../spec/rules.md), [cost model](../spec/cost-model.md), [patch model](../spec/patch-model.md), [storage and errors](../spec/storage.md), and [decisions](../spec/decisions.md).
