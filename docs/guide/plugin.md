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

| Config key | Default | Effect |
| --- | --- | --- |
| `networkEnabled` | `false` | Allows `ci_diet_sync` to call the read-only GitHub API |
| `localApplyEnabled` | `false` | Reserved for applying plans from the Web UI |
| `stateDir` | empty | Overrides the per-user state directory |

## Model tools

| Tool | Network | Writes | Purpose |
| --- | --- | --- | --- |
| `ci_diet_scan` | no | report | Static scan of `.github/workflows` in a checkout |
| `ci_diet_sync` | yes | report | Read-only history sync with `gh` |
| `ci_diet_report` | no | nothing | Summarize the latest stored report |
| `ci_diet_plan` | no | plan | Build a patch plan; never approves or applies |

`ci_diet_plan` has no approval argument on purpose. Approval is a separate,
human step: the CLI prints a confirmation derived from the plan digest, and
apply consumes a single-use nonce created by that approval.

## Command line

```
ci-diet scan  --cwd <repo> [--json] [--out <file>] [--rules CD001,CD008]
ci-diet sync  --network --repo <owner/name> [--days 7] [--json]
ci-diet plan  --rule CD008 --workflow .github/workflows/ci.yml --job build --step upload
ci-diet approve --plan <planId> --confirm <digestTail>
ci-diet apply --plan <planId>
ci-diet revert --change <changeId>
ci-diet changes
ci-diet plans
```

Exit codes: `0` success (a partial report is still success), `1` usage or
unexpected error, `2` contract violation, `3` incomplete evidence or refused
write, `4` invariant failure, `5` approval refused or nonce invalid, `6`
backup unavailable, `130` cancelled.

Pass `--require-complete` to turn a partial coverage report into exit `3`.

## Safety model

- Patches are byte-range edits, one file per plan. The file is never
  re-serialized.
- Apply requires an approved plan, a matching approval nonce, unchanged source
  hashes, unchanged dependency hashes, and a durable backup.
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
