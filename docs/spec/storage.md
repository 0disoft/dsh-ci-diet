# Storage, configuration, and errors

## Where state lives

CI Diet does not assume a per-plugin data directory service exists. The default
file root is the confirmed DSH helper `dshHomePath('ci-diet')` plus
`profiles/<profileKey>`. `profileKey` is a hash of the real host profile
root's canonical identity. If the profile root cannot be confirmed through a
public API, the operator must supply an explicit `stateScope` and path. A
browser-supplied name or the literal `web` never merges several hosts into one
store.

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

The CLI proposes `%LOCALAPPDATA%\CI-Diet` on Windows,
`~/Library/Application Support/CI-Diet` on macOS, and `ci-diet` under the
XDG data root on Linux. Continuing a DSH store from the CLI requires a
human-specified `--state-dir` and a verified Binding. Only host configuration or
a human CLI can override the root; model tool input never carries it. First use
displays the actual path, account, and write status.

The store belongs to one user. Defaults are POSIX `0700` directories and
`0600` backups; Windows ACLs and inheritance are confirmed in the Windows
spike. No strong isolation between plugins of the same OS account and no
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
| Applied backup | No automatic TTL | Deleted only after a human confirms revert is impossible; at quota, block new applies; silent deletion forbidden; export and cleanup procedure required |
| KV mirror record | 16 KiB | Fall back to the file adapter; no silent truncation |

An apply reserves space for before, after, manifest, and target temp file. The
store quota and the target volume's free space are separate checks: a write can
fail below quota when the OS disk is full, and the project stays untouched. A
quota reservation does not replace a durable write. Automatic cache or report
cleanup never reclaims space by deleting recovery backups; at 256 MiB the
product offers only a human-approved procedure that lists targets, shows the
export path, and confirms that revert will be lost.

## Configuration

`examples/default-config.json` is the authority for exact defaults. Network access
is off until the first connection approval, and local apply is off by default.
Default history is `lookbackDays=7`, `maxRuns=100`, `maxRequests=400`, and
`concurrentRequests=4`. Extending to 14 days and 200 runs keeps the request
budget independent; it is not silently increased.

## Error and exit codes

| Error | User meaning | CLI exit |
| --- | --- | ---: |
| `AUTH_REQUIRED` / `API_FORBIDDEN` | Authentication or read permission needed | 3 |
| `API_RATE_LIMITED` / `REQUEST_BUDGET_EXHAUSTED` | Stop collecting and keep a partial report (default 0; 3 with `--require-complete`) | 0 |
| `API_VERSION_UNSUPPORTED` | Requested API version unsupported; no silent fallback | 3 |
| `SCHEMA_INVALID` / `SCHEMA_VERSION_UNSUPPORTED` | Contract violation or unsupported stored record | 2 |
| `SNAPSHOT_BINDING_MISMATCH` / `BINDING_MISMATCH` | Data belongs to another repository or profile | 4 |
| `PLAN_STALE` / `PLAN_EXPIRED` / `POLICY_STALE` | Plan basis changed or expired | 4 |
| `ATTESTATION_MISSING` / `ATTESTATION_EXPIRED` / `ATTESTATION_REVOKED` / `ATTESTATION_HASH_MISMATCH` / `ATTESTATION_SCOPE_INSUFFICIENT` | Premise missing or not covering current bytes | 4 |
| `DEPENDENCY_HASH_MISMATCH` / `SOURCE_HASH_MISMATCH` / `BLOCKERS_PRESENT` / `COVERAGE_INSUFFICIENT_FOR_WRITE` | Apply invariant violated | 4 |
| `NONCE_INVALID` | Approval challenge absent or already consumed | 5 |
| `BACKUP_UNAVAILABLE` | Backup could not be stored; apply stopped | 6 |
| `NON_INTERACTIVE_APPROVAL_DENIED` | A separate interactive terminal is required | 5 |
| `APPROVAL_REQUIRED` / `APPROVAL_EXPIRED` / `APPROVAL_REPLAYED` | Final approval missing, expired, or reused | 5 |
| `REMOTE_ACCESS_DENIED` / `CAPABILITY_UNAVAILABLE` | Not available from this host or principal | 5 |
| `BACKUP_QUOTA_EXCEEDED` / `BACKUP_IO_FAILED` | Could not store revert bytes; nothing applied | 6 |
| `UNSUPPORTED_YAML` / `PATCH_SCOPE_VIOLATION` | Edit outside the supported scope | 4 |
| `WRITE_CONFLICT` / `RECOVERY_REQUIRED` | Current file and journal need human review | 6 |

Exit 0 means the command completed; it does not mean no findings. A successful
partial analysis must include completeness and a cause in its JSON and exits 0.
Only `--require-complete` turns an incomplete collection into exit 3. Cancellation
is 130, and if a file replacement already started, the actual transaction state
is recorded in the receipt first. `AppliedChange` records
`(planId, planDigest, statusRevision)` so the applied approval revision can be
recovered. The reason code table here and the apply invariant table in
`patch-model.md` are maintained together.

Synthetic records (`provenance=synthetic`) are rejected by every production
writer: they can never become an Attestation, plan, or apply source.
