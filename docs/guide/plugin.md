# CI Diet plugin guide

CI Diet ships as one npm package with two entry points: a command line tool and
a DeepSeek Harness (DSH) plugin. Both read the same contracts and write to the
same local store.

## Install

```
npm install --global dsh-ci-diet   # command line
dsh plugin --profile web add dsh-ci-diet
```

The DSH package declares `dsh.bundle.patch`, so installing it adds one loader
entry, `ciDiet.bootstrap`, with both switches off by default. Nothing runs at
boot until you enable a switch.

The package also ships a Web client half (`exports "./client"`). After install,
open **Settings → CI Diet**. The page edits every engine setting used by the DSH
tools and labels both the scope and the time it takes effect. It has no apply,
approval, or revert controls; those stay in the CLI.

All engine fields are live: the next tool call reads the current value without
reloading the plugin. The page validates numbers against the same contract the
CLI uses, saves the batch atomically, and stages a per-field reset into that same
batch so it is saved under the pinned revision. Duplicate rule ids are
normalized to one entry in contract order, never as a save error. A rejected
write leaves the stored configuration unchanged. The CLI keeps its own
`--config` file and flags; the page does not write them. The host schema itself
enforces the contract bounds (lookback 1–30, concurrency 1–4, at least one
analysis rule) while the form is written, so an out-of-contract save is refused
before any tool reads it. The page remembers the revision it was editing; if
another screen saves first, the page refuses your save and asks you to discard
the draft instead of overwriting the newer values.

| Group | Fields |
| --- | --- |
| Connection | `networkEnabled`, `stateDir` |
| Analysis rules | `rules` list (`CD001`, `CD002`, `CD003`, `CD004`, `CD005`, `CD008`); at least one stays enabled |
| History collection | `historyLookbackDays` (1–30), `historyMaxRuns`, `historyMaxRequests`, `historyConcurrentRequests` (1–4), `historyRequestTimeoutMs` |
| Storage | `storageStoreMaxBytes`, `storageWorkflowMaxBytes`, `storageCacheMaxBytes`, `storageCacheDays`, `storageReportDays`, `storagePlanDays`; 0 disables that cap |
| Cost estimate | `billingEnabled`, `billingIncludedMinutes`, `billingAccountMinutesUsed` |

`localApplyEnabled` stays an ordinary reserved field until the plugin ships an
apply tool, so the page does not offer it. `stateDir` changes do not migrate an
existing store; point it at a new directory only before a fresh sync.

## Languages

The CLI, the HTML report, and the model tool text ship in English, Korean,
Simplified Chinese, Hindi, Spanish, and French. Selection order is `--lang`,
then the DSH locale preference (the `locale` plugin's `preference` in the
profile patch), then `LC_ALL`/`LC_MESSAGES`/`LANG`, then English. An explicit
but unsupported `--lang` falls back to English rather than to the host setting.

Reports are stored in English. Translation happens when text is displayed:
finding titles and descriptions come from message keys, while rule ids, error
codes, enum values, paths, hashes, and numbers are never translated. The HTML
report sets its `lang` attribute accordingly. The Settings page registers its own
client dictionaries in all six languages and contributes any language the host
does not ship, with English as its fallback. Model tool descriptions and render
templates are captured when the plugin loads, so change the DSH language
preference and reload the plugin to see new text.

## Model tools

| Tool | Network | Writes | Purpose |
| --- | --- | --- | --- |
| `ci_diet_scan` | no | report | Static scan of `.github/workflows` in a checkout |
| `ci_diet_sync` | yes | report | Read-only history sync with `gh` |
| `ci_diet_report` | no | nothing | Summarize the latest stored report |
| `ci_diet_prune` | no | deletes expired data | Apply the configured retention days and cache cap to the local store |
| `ci_diet_plan` | no | plan | Evaluate patch eligibility and preview a plan; never approves or applies |

`ci_diet_prune` is the execution path for the storage settings. It deletes
reports, plans, and cache entries older than `storageReportDays`,
`storagePlanDays`, and `storageCacheDays`, evicts cache entries beyond
`storageCacheMaxBytes`, and reports the freed bytes and the current quota state.
It never deletes applied-change backups: the contract keeps
`pruneAppliedBackups` off, and removing a backup needs the listing token from
`ci-diet prune --applied-backups`.

`ci_diet_plan` takes `rule`, `workflow`, `cwd`, optional `job`, `step`, and a
`claims` list. It returns the edits, the plan digest, the coverage level, and
the reasons that still block a write. It has no approval argument on purpose:
approval is a separate, human step. The CLI prints a confirmation derived from
the plan digest, and apply consumes a single-use nonce created by that approval.

## Command line

```
ci-diet scan  --cwd <repo> [--json] [--out <file>] [--rules CD001,CD008]
ci-diet sync  --network --repo <owner/name> [--days 7] [--json]
ci-diet sync  --network --included-minutes N --account-minutes-used M
ci-diet plan  --rule CD008 [--cwd <repo>] --workflow .github/workflows/ci.yml \
              --job build --step upload --claims artifact-purpose:temporary,consumer-min-days:7
ci-diet plan  --rule CD005 --workflow .github/workflows/ci.yml --job build --minutes 20
ci-diet plan  --rule CD001 --workflow .github/workflows/ci.yml --claims ci-only,replace-safe
ci-diet approve --plan <planId> --confirm <digestTail>
ci-diet apply --plan <planId>
ci-diet revert --change <changeId>
ci-diet changes
ci-diet plans [--plan <planId>]
ci-diet report [--report <id>] [--format text|json|html] [--out <file>]
ci-diet diagnose [--json] [--out <file>] [--require-complete]
ci-diet prune
```

`plan` prints the proposed lines as a small diff. `ci-diet plans --plan <planId>`
re-reads a saved plan and prints the same diff from its byte edits; when the
workspace is gone, it says so and the plan JSON still lists the edits.

Exit codes: `0` success (a partial report is still success), `1` usage or
unexpected error, `2` contract violation, `3` incomplete evidence or refused
write, `4` invariant failure (a revert could not restore matching bytes),
`5` approval refused or nonce invalid, `6` backup unavailable, `130`
cancelled with Ctrl+C.

Pass `--require-complete` to turn a partial coverage report into exit `3`.

## What a plan needs before it can write

A plan is only built when the rule's finding is patch-eligible in the latest
report for this repository. A blocked finding never becomes a plan, and a plan
whose evidence stops matching is refused with exit `3` and a reason code.

| Requirement | CD001 | CD005 | CD008 |
| --- | --- | --- | --- |
| Observed history coverage that allows a write | yes | yes | yes |
| Human claims in the attestation | `ci-only`, `replace-safe` | (none) | artifact purpose, consumer minimum days |
| Fresh policy snapshot | branch protection | (none) | artifact retention |
| Other blockers | PR-only trigger, no existing `concurrency`, no deploy job | a cohort of 20 samples, no existing timeout | literal retention above 7 days |

Claims are recorded on a durable Attestation, not in the plan digest. If a claim
is withdrawn, the plan cannot apply. Policy freshness is checked per rule, so an
unrelated stale snapshot never blocks a timeout edit.

The request must also match the finding it is based on. The finding records the
workflow hash, the job key, the step index, and the measured value; a request
for another job, a value that no cohort produced, or a file that changed after
the report is refused with exit `3` and a reason such as
`WORKFLOW_HASH_MISMATCH` or `MINUTES_NOT_FROM_EVIDENCE`. Re-run `sync` before
retrying against a changed workflow.

## Safety model

- Patches are byte-range edits, one file per plan. The file is never
  re-serialized.
- Apply requires an approved plan, a matching approval nonce, unchanged source
  hashes, unchanged dependency hashes, and a durable backup.
- The semantic guard compares every step field, including `env`, `if`, and each
  `with` entry, and reports empty mappings/sequences and parent type changes.
  An edit that drifts outside its rule is refused even if the plan digest is
  recomputed.
- Dependency hashes cover interpreter scripts such as `node build.js` relative
  to the step `working-directory`, and all files inside a local action
  directory. A reference the scan cannot hash becomes an
  `UNRESOLVED_DEPENDENCY:<path>` blocker, so apply refuses instead of trusting
  an incomplete fingerprint. Boolean flags such as `--enable-source-maps` keep
  the following token as the script, while `--require`, `--loader`, `--import`,
  and `--env-file` consume a value that is hashed when it names a repository
  file. A local action that hits the 500-file limit or an unreadable file or
  directory is also reported as unresolved.
- The working tree is authoritative: uncommitted changes are preserved, and a
  file that changed after the plan was built is refused.
- Backups are never deleted automatically. If the store cannot hold another
  backup, apply refuses with `BACKUP_UNAVAILABLE`.

## State

The CLI uses `%LOCALAPPDATA%\CI-Diet\profiles\default` on Windows and
`~/.local/state/ci-diet/profiles/default` elsewhere. The DSH plugin uses the
same layout under the DSH home. `--state-dir` overrides both.

Bindings, reports, plans, attestations, backups, changes, and an append-only
event log live in separate subdirectories. Report retention is 90 days; plans
expire after 7 days.

## Reports

`ci-diet report` prints the latest stored report for the repository at the
effective `--cwd` (the current directory by default), or the one named by
`--report` regardless of root. Three formats share the same stored record:

| Format | Use |
| --- | --- |
| `text` | Default summary: report id, runner seconds, modeled minutes, list price, findings, and which coverage axes are incomplete |
| `json` | The contract-valid `AnalysisReport`, for another tool |
| `html` | One self-contained file with inline CSS, no scripts, and no external URLs |

`--json` is shorthand for `--format json`. `--out` writes the rendered
document to a file instead of standard output.

`ci-diet prune` deletes reports older than 90 days, plans older than 7 days,
and cache entries older than the configured cache window. It never deletes
backups, and it reports the freed byte count.

## Diagnostics

`ci-diet diagnose` explains the latest stored history without touching the
network. For each workflow it shows how many job names resolved to YAML keys,
which matrix jobs expanded and to how many legs, and the most frequent job
names that did not resolve. It also lists each coverage axis with its status
and reasons, so a cap such as `JOB_PAGE_LIMIT_REACHED` is visible next to the
axis it truncated. The command is read-only; `--json` emits the same data and
`--require-complete` exits `3` when any axis is incomplete or a run has no
resolved definition.

Cache hints are advisory. When a job installs dependencies without a cache, or
an `actions/cache` key is a literal that cannot follow the lockfile, `diagnose`
lists it under cache hygiene. The frozen v0.2.1 contract has no cache rule id,
so these hints never become findings, never change coverage, and never produce a
patch.