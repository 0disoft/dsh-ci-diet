# Patch model

## Allowed edits

One plan targets one existing `.github/workflows/*.yml` or `*.yaml` file. The
original bytes and file mode are captured with the Binding, and every edit is
anchored to the hash of the bytes the human reviewed. A stale offset is never
applied to changed bytes.

| Rule | Allowed edit | Additional preconditions |
| --- | --- | --- |
| CD001 | Add a top-level `concurrency` block | `on` is exactly `pull_request`, no side effects, complete protection data, no required check owned by this workflow |
| CD005 | Insert or reduce a job's integer `timeout-minutes` | Sufficient identical cohort, protection for long successful samples, job Attestation |
| CD006 | Add `cache: npm` and `cache-dependency-path: package-lock.json` to one setup-node step | Root checkout → `actions/setup-node@v3`/`@v4` → exactly `npm ci`, committed valid root manifests, no existing cache inputs |
| CD008 | Reduce `retention-days` on a named upload step | Temporary purpose and consumer period attested, effective maximum confirmed |

`on`, `if`, `needs`, `matrix`, `permissions`, `env`, `uses`, `run`,
`secrets`, and `environment` are never edited. An existing concurrency block is
neither replaced nor extended. CD001 blocks `pull_request_target`, `merge_group`,
and mixed dispatch, schedule, push, or `workflow_call` triggers. A simple "it is
fine" click never replaces an explicit equivalence check.

## Concurrency namespace

The unique part is the first 16 hex characters of the sha256 of the repository
ID and the normalized workflow path. Compare against every current workflow's
group case-insensitively. If an existing group expression cannot be evaluated
and a collision cannot be excluded, the plan is `review-only`.

```yaml
concurrency:
  group: ci-diet-a8f31d2c09b14ea7-pr-${{ github.event.pull_request.number || github.run_id }}
  cancel-in-progress: true
```

The 16-character value is an example; the real value is computed when planning.
The `${{ ... || github.run_id }}` fallback prevents unexpected events with an empty PR
number from collapsing into one group, but it does not replace the event
allowlist check. `queue: max` is never combined with
`cancel-in-progress: true`, and an existing queue policy is not changed.

## YAML support

| Shape | Analysis | v0.1 write |
| --- | --- | --- |
| Single-document block mapping, UTF-8, LF or consistent CRLF | Supported | Supported |
| UTF-8 BOM, missing final newline | Supported | Preserved as-is |
| Mixed LF and CRLF in one file | Supported where possible | Report-only |
| Duplicate keys, multiple documents, custom tags | Error location recorded | Blocked |
| Anchors, aliases, merge key `<<` | Reference structure shown | Report-only |
| Flow mapping or sequence inside the edited ancestor | Shown when analyzable | Report-only |
| Generated workflow or template output | Origin and warning | Report-only |
| Expression timeout or retention | Marked as expression | That field is report-only |
| Upload step without `with` | Supported | `insertParentMapping` adds the parent and leaf together |
| Several upload steps in one job | Each identified | Per-step digest, index, and id |
| Existing timeout or retention at or below recommendation | Current policy shown | No change |

Node positions never mix UTF-16 string offsets with UTF-8 byte offsets; parser
token ranges are converted to original byte ranges, and multibyte characters
and CRLF before the range are covered by fixtures. The file is never fully
stringified. New lines follow the document's existing newline style and
indentation, and comments are preserved.

`ByteEdit` kinds are `insertScalar`, `replaceScalar`, `insertMapping`, and
`insertParentMapping`. Every edit must satisfy: `startByte <= endByte`; no
overlap within one file; original byte ranges only; insertion at a line boundary
or a confirmed offset on the same line. Any violation fails plan creation.
After applying edits, reparse and diff semantically: only allowed semantic paths
may change, and the semantic diff must correspond exactly to `edits`, or the
plan is not applied. A plan identical to the current value ends as a no-op.

The semantic diff covers every field a rule must not touch, including keys that
no rule ever edits: a step's `env`, `if`, `id`, `name`, `uses`, `run`, and each
`with` entry are compared one by one. Adding, changing, or removing any of them
outside the declared edits fails the plan even when the recomputed `planDigest`
is consistent, because a digest proves what was signed, not that the edit stayed
inside its rule.

## Evidence binding

A plan is built from one finding, and the finding must still describe the bytes
in the checkout. Every finding stores `workflowHash`, the target job key, and,
for step-scoped rules, the step index in `evidenceRefs`. Plan creation reparses
the current file and refuses the request when any of these no longer match:

| Mismatch | Code | Recovery |
| --- | --- | --- |
| Current file bytes differ from `workflowHash` | `WORKFLOW_HASH_MISMATCH` | Run `sync` again and make a new plan |
| Finding measured another job or step | `FINDING_NOT_FOUND` | Choose the job the finding actually measured |
| Finding did not record a target | `TARGET_NOT_RECORDED` | Reanalyze before planning |
| CD005 minutes are absent or not a cohort recommendation | `MINUTES_REQUIRED` / `MINUTES_NOT_FROM_EVIDENCE` | Use a value the cohort produced |
| CD006 job or step is not the setup-node step in the required order | `STEP_NOT_FOUND` / `NPM_CACHE_PREREQUISITES_MISSING` | Choose the job and setup-node step the finding measured |
| CD008 step is missing or does not upload an artifact | `STEP_NOT_FOUND` / `STEP_NOT_UPLOAD_ARTIFACT` | Pick the upload step |
| CD008 retention is not the proposed 7 days | `RETENTION_NOT_FROM_EVIDENCE` | Use the proposed value |
| History needed for the evidence is absent | `HISTORY_NOT_SYNCED` | Sync, then plan |

A CD005 recommendation belongs to one job. Reusing a 20-sample cohort from a
`build` job to add a timeout to a `deploy` job is impossible because the target
job is part of the finding identity; an untested job has no recommendation at
all. The same selection runs in the CLI and in `ci_diet_plan`.

CD006 is the one plan that needs no run history. The CLI `plan --rule CD006`
runs a fresh static scan in memory and saves the binding, attestation, and plan;
it does not replace the latest saved report, so an earlier `sync` report stays
intact. Its `--step` is the zero-based index of the setup-node step, with
checkout immediately before it and `npm ci` immediately after it. The root
`package.json` and `package-lock.json` are part of the finding identity and are
hashed again when planning, so the plan pins the manifest bytes current at that
moment. If either manifest changes after planning or approval, apply refuses
with `DEPENDENCY_HASH_MISMATCH`. The only allowed edit adds the two `with`
inputs. Node and action versions, `npm ci`, tests, and a separate or local cache
step are not edited, and the rule never proposes them. The cache benefit
remains unmeasured until comparable cold and warm runs exist, so the plan
carries no time or money saving claim. Approval, apply, and revert use the same
transaction and human approval rules as the other rules.

## Plan state and dependencies

`PatchPlan.status` is a separate record with `state`, `revision`,
`previewedAt`, `approvedAt`, and `approvalNonceId`. States move forward
only: `draft → preview → approved`. Going back means a new plan with a new
digest. Status changes are stored outside `planDigest`; a changed digest never
inherits an earlier state.

| Transition | Condition | Recorded |
| --- | --- | --- |
| draft → preview | Preview surface re-reads current bytes and source hash | `previewedAt`, `revision + 1` |
| preview → approved | Single-use nonce consumed atomically, or a separate terminal purpose and digest confirmation | `approvedAt`, `approvalNonceId`, `revision + 1` |
| Post-approval recheck mismatch | File, policy, or premise changed | State kept, reason code added |

`dependencies` is the sorted list `{ref, sha256}` of local files that the
edited bytes depend on (local actions, scripts, reusable workflows,
configuration). The scan resolves a local action to every file in its directory
(except `.git` and `node_modules`), and resolves scripts named by common
interpreters (`node build.js`, `bash scripts/check.sh`), `./` and `../`
executables, and slash-containing arguments relative to the step
`working-directory` or the job/top-level `defaults.run.working-directory`.
Local `uses: ./...` references resolve from the repository root. Interpreter
flags are classified by kind: boolean flags such as `--enable-source-maps` do
not consume the script path, while `--require`, `--loader`, `--import`, and
`--env-file` do and their values are hashed when they name a repository file.
A reference that names a file but cannot be hashed inside the repository
becomes an `UNRESOLVED_DEPENDENCY:<path>` blocker instead of being dropped
silently. Collection that hits the 500-file local-action limit, or cannot read
a file or directory, is recorded the same way with `(file limit reached)`,
`(unreadable file)`, or `(unreadable directory)`, so a partial fingerprint
never looks complete.
`dependencyHash` is the sha256 of the CDJ1 encoding of
`{dependencies}`; an empty list has a defined hash too. If any dependency hash
changes, both the premise and the plan are void. Any non-empty `blockers` list
blocks apply even from `approved`.

## Premises versus final approval

An Attestation is a durable human claim such as "this workflow runs checks only".
An `ApprovalChallenge` authorizes one specific byte change right now. They are
separate records and are never merged. `planDigest` binds the full premise
snapshot, revision, dependency fingerprint, policy snapshot, and edit content.

The scope level matters: workflow, job, or step. A job is never automatically
included because its workflow is attested, and a step is never carried over
because an index happens to match. Even when the workflow file hash is
unchanged, a changed local action or script changes the dependency fingerprint
and voids the plan. Apply re-collects the workflow's dependencies instead of
trusting the refs recorded in the plan, so repointing a symlink at different
bytes is a mismatch even when the recorded target is untouched. Fingerprints
hash the bytes on disk, not their UTF-8 decoding, and a file inside a local
action is capped like a script: an oversized or unreadable file becomes
unresolved instead of being pinned. Mutable action refs stay opaque until a
resolved revision is approved.

Immediately before the final approval, recheck plan expiry, premise expiry and
revocation, Binding identity, current bytes, and policy freshness. A policy
value that changed requires a new plan and preview; never silently rewrite the
digest to a newer value. Relevant policy must be at most 600 seconds old, and a
write stops if fresh data cannot be obtained.

Freshness is per rule, not "the newest snapshot wins". CD001 needs a branch
protection snapshot, CD008 needs the artifact retention policy, and CD005 needs
neither: a timeout edit does not depend on account policy, so an unrelated stale
snapshot must not block it. A rule with no required snapshot still fails on a
missing attestation or incomplete coverage.

## Apply invariants

An approved plan is not applied if any invariant fails. The reason code list is
closed and is exactly this table.

| Invariant | Reason code |
| --- | --- |
| Unapplied plan TTL (7 days) still valid | `PLAN_EXPIRED` |
| Attestation exists and is valid for the edited job or step | `ATTESTATION_MISSING` / `ATTESTATION_EXPIRED` / `ATTESTATION_REVOKED` |
| Attestation `workflowHash` and `dependencyHash` match current bytes | `ATTESTATION_HASH_MISMATCH` |
| Attestation scope covers the edit | `ATTESTATION_SCOPE_INSUFFICIENT` |
| Plan `dependencies` hash matches current values | `DEPENDENCY_HASH_MISMATCH` |
| `blockers` is empty | `BLOCKERS_PRESENT` |
| Coverage allows writes (`full`, or `subset` plus complete edit evidence) | `COVERAGE_INSUFFICIENT_FOR_WRITE` |
| Current bytes hash equals `sourceHash` | `SOURCE_HASH_MISMATCH` |
| Nonce is valid, unused, from the same peer, and younger than the approval TTL (600 s by default) | `NONCE_INVALID` |
| Policy snapshot is at most 600 seconds old | `POLICY_STALE` |
| Backup is durably stored | `BACKUP_UNAVAILABLE` |

`inputHashes` is the sorted sha256 list recorded on both the plan and the
premise: `workflowSource`, `workflowDefinition`, `policySnapshot`, and
`dependencyHash`. Comparison uses hashes, never path strings alone.

## Apply transaction

The file store and the target writer share one service path. There is one writer
in `src/core/patch`; the CLI uses it today, and a future Web write surface must
reuse it rather than reimplement the transaction.

| Step | Check and record | On failure |
| --- | --- | --- |
| prepare | Current bytes, Binding, premise, policy, allowed paths | Project file untouched |
| reserve | Reserve backup before/after/manifest and temp space | `BACKUP_UNAVAILABLE` or storage error, untouched |
| durable prepare | Write before and after as immutable files, re-read hashes, flush, journal PREPARED | Untouched; a completed orphan backup is diagnosable |
| approve | Confirm purpose and digest in a separate terminal; the nonce stays pending until confirm | Untouched; no approval reuse |
| recheck | File hash, identity, premise, quota | `SOURCE_HASH_MISMATCH`, apply cancelled |
| in doubt | Journal APPLYING before touching the target | Untouched; recovery reads it as in-doubt |
| replace | Write the result to a temp file on the same volume, replace atomically, preserve mode | Re-hash the target: unchanged marks NOT_APPLIED with the nonce intact; the planned bytes converge to APPLIED; anything else is `RECOVERY_REQUIRED` |
| confirm | Verify target after-hash, journal APPLIED, then consume the nonce | `RECOVERY_REQUIRED`; never a normal success response |

One approval authorizes one apply transaction. A change journaled APPLIED,
APPLYING, REVERTING, or REVERTED refuses a new apply with `NONCE_INVALID`, even
when its nonce file survived a failed cleanup; a crash inside the transaction is
handled by convergence before that guard runs. Approvals and lease takeovers are
serialized per plan and per repository by a short-lived claim directory that is
only broken when its owner process is gone, so two approvers cannot leave a plan
and its nonce disagreeing.

There is no mode that warns and continues when the backup cannot be written: the
user must choose a new durable location and create a new plan. CI Diet uses a
single-writer lease per repository and path to serialize its own CLI and Web
applies. The owner token records the writer process id, and a stale lease is
taken over only after that process is confirmed gone; an owner that is still
running is never moved out of the lease path, even when its mtime exceeds the
staleness threshold, so a third writer cannot start beside it. A takeover first
claims the writer claim directory; only the claim holder inspects and clears the
lease, and it swaps in a fully written candidate directory instead of moving a
live one, so a writer that filled the path in the meantime loses with
`WRITE_CONFLICT` rather than sharing the file. A token without a recognizable
process id fails closed and must be removed by hand after confirming that no
writer is running. Release verifies the token and moves only its own lease, so
neither path deletes a token it does not own. External editors are not part of
that lease; POSIX rename
and Node filesystem calls do not provide atomic compare-and-swap against other
writers, so the product promises detection through pre/post rechecks, not
lossless concurrent editing.

On Windows, a replacement blocked by an open handle, antivirus, or permissions
fails after limited retries. Deleting the target and renaming over it is
forbidden. Platform replacement, ACL, and flush behaviour must pass the Windows
A1 spike before writes are enabled. Where directory fsync is unavailable, no
equivalent power-loss durability is claimed.

## Recovery

| Journal and target | Next action |
| --- | --- |
| PREPARED and target equals before | Mark as not applied; the unconsumed approval nonce stays valid for a retry |
| APPLYING/PREPARED and target equals after | Recover the receipt from the stored result; write no extra bytes |
| REVERTING and target equals after | Retry the restore from the reserved backup |
| REVERTING and target equals before | The restore landed before the journal was finalized; mark REVERTED without writing |
| APPLIED/RECOVERY_REQUIRED and target equals before | The revert objective already holds; mark REVERTED without writing |
| APPLIED and target equals after | Revert is available |
| Any state, target differs from both before and after | `CONFLICT`; never overwrite the current file. Once the user restores the original bytes by hand, a revert retry converges to REVERTED |
| CONFLICT and target equals before | Mark REVERTED without writing; the conflict was only local bytes |
| APPLIED and the nonce file survived | Do not re-apply; converge on the recorded receipt and report the cleanup gap |
| Required backup missing or hash mismatch | `RECOVERY_REQUIRED`; never restore corrupted bytes |

Revert also needs a separate approval and quota/target recheck, and changes the
file only when `current == after`. It journals REVERTING before replacing the
target, so a crash or a journal write failure after the restore leaves a state
that a retry can finish rather than a CONFLICT the user cannot resolve. If the
user edited the file afterwards, record CONFLICT and offer the preserved
original for comparison; restoring the before bytes makes the retry converge. `git reset --hard`,
`git checkout --`, and forced overwrite are never recovery mechanisms.

Backups are stored verbatim for exact revert; masking happens only in exports,
logs, and error messages. Deleting an applied backup is a separate human action
that confirms revert is no longer possible and is not tied to report TTL.
Because nothing is auto-pruned, reaching the 256 MiB store quota blocks new
applies with `BACKUP_UNAVAILABLE`; space is freed only through a cleanup
procedure that lists targets, shows the export path, and asks for explicit
confirmation. Old backups are never silently deleted. If the process stops or
an update is requested before the journal state is settled, the work is not
discarded silently; it remains for the recovery check on the next start.
