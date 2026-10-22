# Storage, configuration, and errors

## Where state lives

CI Diet does not assume a per-plugin data directory service exists; the
installed DSH exposes none. Both entry points default to the same user-level
root: `%LOCALAPPDATA%\CI-Diet\profiles\default` on Windows and
`~/.local/state/ci-diet/profiles/default` elsewhere. The DSH plugin config
`stateDir` and the CLI flag `--state-dir` override it, and an explicit value is
the only way to point the CLI at a store the plugin created under a different
root. A browser-supplied name or the literal `web` never merges several hosts
into one store.

| Path | Content |
| --- | --- |
| `bindings/` | Immutable identity and allowed scope per Binding |
| `attestations/` | Human premise revisions and revocations |
| `snapshots/` | Workflow source and normalized collected data |
| `reports/` | Self-contained analysis reports |
| `plans/` | Immutable patch plans and plan status metadata |
| `changes/` | Transaction manifests and before/after backups |
| `events/` | Local evaluation and usage summaries |
| `cache/` | Re-fetchable responses and ETags |

Continuing a DSH store from the CLI requires an explicit `--state-dir` and a
verified Binding. Only host configuration or a human CLI can override the root;
model tool input never carries it. First use displays the actual path, account,
and write status.

Every report and plan belongs to a Binding, and a Binding records the workspace
realpath it was created for. A plan never falls back to "the newest report in
the store": it resolves the binding for the current root, then the latest report
for that binding only. If another repository has a report and this one does not,
the command stops and asks for `sync` instead of planning against foreign
evidence.

Only one writer may hold a file transaction at a time. Apply and revert hold a
directory lease under the store's `locks/` directory, and a short-lived claim
serializes every mutation of that lease path. A second concurrent apply, or a
foreign lock left by another process, fails with `WRITE_CONFLICT` before any byte
is written. Plan and approval records use their own per-record claim instead of
the writer lease.

The store belongs to one user. On POSIX the store root and every managed
directory are `0700`, and every file, including temp files and backups, is
`0600`; the modes are set explicitly rather than inherited from the umask, and
an existing directory or record with wider modes is tightened on the next open
or write. Windows ACLs and inheritance are confirmed in the Windows spike, and
POSIX modes are skipped there. No strong isolation between plugins of the same OS account and no
encrypted-at-rest storage is claimed. A synced shared folder is never selected
as the default backup location. Relative paths, junctions, and symlinks that
escape the configured root are rejected.

## KV versus files

`ctx.storage` is a backend and form hub. Unverified methods such as
`ctx.storage.get()` are not invented. The adapter uses confirmed domain forms and
`ctx.storageDomain`-style APIs; exact signatures and backend choice are pinned by
the installed combination in the A1 spike.

KV may hold small configuration, rebuildable indexes, and progress summaries.
The product-level cap for one record is 16 KiB of UTF-8 JSON; this is not a DSH
guarantee. If the backend is smaller or the service is absent, the file adapter
is used and a failed KV mirror is reported. Workflow source, before/after
backups, attestations, and transaction records live in the file store from the
start. KV write success never decides recoverability.

## Size and retention

| Setting | Default | Over-limit handling |
| --- | ---: | --- |
| Whole store | 256 MiB | Warn at 80%; block writes that exceed remaining space |
| One workflow input | 512 KiB | Mark over the analysis limit; no apply |
| Cache | 64 MiB, 30 days | Only rebuildable cache may be pruned |
| Report | 90 days | Data referenced by recovery records is excluded |
| Unapplied plan | 7 days | Expired plans cannot apply and are cleanup candidates |
| Applied backup | No automatic TTL | Deleted only after a human confirms revert is impossible; `ci-diet prune --applied-backups` lists targets and a deletion token, and `--confirm <token>` deletes exactly that listing; at quota, block new applies; silent deletion forbidden |
| KV mirror record | 16 KiB | Fall back to the file adapter; no silent truncation |

An apply reserves space for before, after, manifest, and target temp file. The
store quota and the target volume's free space are separate checks: a write can
fail below quota when the OS disk is full, and the project stays untouched. A
quota reservation does not replace a durable write. A write that would exceed
the store quota fails with `STORAGE_QUOTA_EXCEEDED` before any file is created,
so a refused backup or record leaves no partial directory behind. Quota
admission re-reads usage after taking the store write lock; the cached usage
used for display is never trusted for admission. Automatic cache or report
cleanup never reclaims space by deleting recovery backups; only an explicit
`--applied-backups --confirm` procedure deletes a backup, after the listing
shows the targets and confirms that revert will be lost.

A sync publishes its binding, history window, and report as one generation: the
three files are written into `snapshots/generations/<binding>/<generation>` and
the last step switches `snapshots/current/<binding>.json`. If writing any of
them fails, the generation is removed and the previous pointer still names a
complete snapshot. Readers resolve the pointer first, retry once if a
concurrent save removed that generation, and fall back to the legacy
`bindings/`, `snapshots/history/`, and `reports/` records for stores written by
an older version.

A retained generation keeps its report, so `readReport(<id>)` resolves reports
from earlier generations until cleanup removes them. `prune` applies
`reportDays` to each generation report and deletes the whole generation as one
unit; when the removed generation is current, its pointer is removed too. A valid
report index is trusted without rescanning unrelated reports.

## Configuration

`examples/default-config.json` is the authority for exact defaults. Network access
is off until the first connection approval, and local apply is off by default.
Default history is `lookbackDays=7`, `maxRuns=100`, `maxRequests=400`, and
`concurrentRequests=4`. Extending to 14 days and 200 runs keeps the request
budget independent; it is not silently increased.

`concurrentRequests` is the maximum number of GitHub requests in flight at once;
it bounds the parallel jobs, workflow-definition, and pull-request reads without
changing the sequential discovery and policy stages. `maxRequests` caps the total
dispatches for one sync even when the per-family quota sum is larger: once the cap
is reached, remaining reads are recorded as missing scopes instead of being
attempted. Concurrency never affects output order; runs, jobs, definitions, and
pull files are merged in repository order, so the report is deterministic no
matter which response arrived first. Requests are not batched through GraphQL.

## Error and exit codes

| Error | User meaning | CLI exit |
| --- | --- | ---: |
| `AUTH_REQUIRED` | `gh` credentials are missing or rejected | 3 |
| `BUDGET_EXHAUSTED` | The local request budget ran out before a required call | 3 |
| `PERMISSION_DENIED` / `RATE_LIMITED` / `NOT_FOUND` / `NETWORK_ERROR` / `GH_NOT_INSTALLED` / `INVALID_ENDPOINT` | Collection could not start; a failure during collection is recorded as a missing scope instead and keeps the partial report | 1 |
| `SCHEMA_INVALID` | A stored or produced record violates the frozen contract | 2 |
| `PLAN_EXPIRED` / `POLICY_STALE` | The plan basis aged out | 3 |
| `ATTESTATION_MISSING` / `ATTESTATION_EXPIRED` / `ATTESTATION_REVOKED` / `ATTESTATION_HASH_MISMATCH` / `ATTESTATION_SCOPE_INSUFFICIENT` | The premise is missing or does not cover the current bytes | 3 |
| `DEPENDENCY_HASH_MISMATCH` / `SOURCE_HASH_MISMATCH` / `BLOCKERS_PRESENT` / `COVERAGE_INSUFFICIENT_FOR_WRITE` | An apply invariant failed | 3 |
| `NONCE_INVALID` | The approval challenge is absent, already consumed, or the plan was never approved | 5 |
| `BACKUP_UNAVAILABLE` | The backup could not be stored; nothing was applied | 6 |
| `STORAGE_QUOTA_EXCEEDED` | The local state store is full; prune expired data or remove confirmed backups | 7 |
| `CURRENT_BYTES_CHANGED` | Revert refused because the file no longer equals the applied result | 3 |
| `BACKUP_HASH_MISMATCH` / `RESTORE_HASH_MISMATCH` / `RECOVERY_REQUIRED` | The journal and the bytes on disk need human review | 4 |
| `WRITE_CONFLICT` | The path escapes the workspace, is a symlink, or the replacement failed | 3 |
| `UNKNOWN_COMMAND` / `UNKNOWN_FLAG` / `MISSING_VALUE` / `INVALID_VALUE` / `UNKNOWN_RULE` | Usage error | 1 |

Exit 0 means the command completed; it does not mean no findings. A run that
stops early because the window was truncated or a dimension is missing still
exits 0 and records the cause in coverage: a successful partial analysis must
include completeness and a cause in its JSON. Only `--require-complete` turns an
incomplete collection into exit 3. Cancellation is 130, and if a file
replacement already started, the actual transaction state is recorded in the
receipt first. `AppliedChange` records `planId`, `planDigest`, the before and
after hashes and byte counts, and the approval reference, so a revert can be
matched to the exact bytes it must restore. The reason codes here, the apply
invariant table in `patch-model.md`, and `ApplyReasonCode` in
`src/core/patch/verify.ts` are maintained together.

Synthetic records (`provenance=synthetic`) are rejected by every production
writer: they can never become an Attestation, plan, or apply source.