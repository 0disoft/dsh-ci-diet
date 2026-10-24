# Detection rules

GitHub list response containers must contain the expected array. A missing or
non-array list is a collection error, even with HTTP 200; it is not evidence of
zero jobs or zero changed files. Job and PR-file collection failures keep their
coverage partial and record the missing scope. Confirmed empty arrays remain
valid and retain the server's pagination metadata.

## Rule outcomes

Every rule returns a `RuleResult` with one `outcome`:

- `finding`: the rule evaluated the evidence and found a waste hypothesis.
- `candidate`: a hypothesis exists but the evidence does not justify a scenario
  or an edit.
- `no_finding`: the rule evaluated the required evidence and the condition was
  absent.
- `skipped`: the rule was disabled, or required evidence was unavailable.

A finding carries `evidenceLevel` (`observed`, `inferred`, `static`) and
`patchability` (`eligible`, `review-only`, `blocked`). `eligible` means the rule
may produce a plan; it never means the edit may be applied without a human
approval.

`candidate` is not a downgraded `no_finding`, and `no_finding` is not evidence of
savings. Only `observed` `no_finding` may be counted as "checked and clean".

## Coverage

Five evidence axes are tracked: `history`, `workflowDefinitions`,
`changedFiles`, `protectionRules`, and `retentionPolicy`. Each axis is
`complete`, `partial`, or `unavailable`.

Each rule composes missing axes into a coverage level:

- `full`: the missing axis adds no restriction to this rule. It waives no other
  condition.
- `subset`: compute only inside the declared subset, and disclose the subset
  list, boundaries, and omissions in the finding, report, and plan. Savings are
  shown only for the observed subset and its sample count.
- `degrade`: produce `candidate` or `static` only; remove historical
  scenarios and write eligibility.
- `skip`: keep the `RuleResult` and create no finding.

When several axes are missing, the most restrictive level wins in the order
`full < subset < degrade < skip`. Two axes missing at the same time keep every
blocking reason; they are never collapsed into one.

Pagination caps are part of coverage, not silent truncation. When a collection
stops because a page cap was reached, the axis is at best `partial` and the reason is one of
`RUN_LIMIT_REACHED`, `JOB_PAGE_LIMIT_REACHED`, `WORKFLOW_LIMIT_REACHED` (recorded as a
`discovery` missing scope), `PULL_FILES_LIMIT_REACHED`, or
`ARTIFACT_RUN_LIMIT_REACHED`. A truncated axis is never reported as `complete`.

The machine-readable policy is `contracts/coverage-policy.json`. It is the
authority. The table below is the composed result when one axis is
`partial` / `unavailable`; the `full` case evaluates each rule's individual
conditions.

| Rule | history | workflowDefinitions | changedFiles | protectionRules | retentionPolicy |
| --- | --- | --- | --- | --- | --- |
| CD001 | degrade / skip | degrade / degrade | full / full | degrade / degrade | full / full |
| CD002 | degrade / skip | degrade / degrade | full / full | full / full | full / full |
| CD003 | subset / skip | subset / skip | subset / skip | degrade / degrade | full / full |
| CD004 | degrade / degrade | degrade / degrade | full / full | full / full | full / full |
| CD005 | subset / skip | subset / degrade | full / full | full / full | full / full |
| CD006 | full / full | degrade / skip | full / full | full / full | full / full |
| CD008 | full / full | full / full | full / full | full / full | degrade / degrade |

`examples/coverage-vectors.json` holds the generated vectors, including four
composite degradations (CD005 history plus definitions twice, CD003 changedFiles
plus protectionRules, CD008 retentionPolicy plus workflowDefinitions). Every rule
also requires the current workflow definition to parse; an unparsable
definition skips the rule that needs it. CD008's `workflowDefinitions` cell is
about historical definitions, so it does not affect retention checks, but a
current upload step must be resolved or CD008 skips.

Writes follow `writeEligibility` in the policy file: `full` always, `subset` only
when the edited job's own evidence is complete, `degrade` and `skip` never.

## CD001: superseded pull request runs

Compare runs with the same repository ID, workflow path identity, pull request
number, and base branch. When the PR head changes, earlier runs keep consuming
runner time that a newer run makes obsolete. Re-runs and same-SHA reruns are not
replacement events. If a run started before the lookback window, mark the left
edge as truncated instead of pretending the interval started at zero.

The moment a replacement run is created is only an approximation of when the old
run could have been cancelled. Compute the scenario with
`cancellationLagSeconds = 0` and `30` and present it as a range; never call it a
measured cancellation time. When coverage forces `degrade`, keep the finding as a
candidate but set `standaloneRunnerSeconds` to unknown with reason
`COVERAGE_DEGRADE` and record no removal rows, so a partial window is never
reported as known savings. Exclude targets whose cleanup hooks or artifact
consumers would change.

Automatic planning is allowed only when the workflow's `on` keys are exactly
`{pull_request}` and the extension is review-only when any of `pull_request_target`,
`push`, `schedule`, `workflow_dispatch`, `workflow_call`, or `merge_group` is
also present. Blocked as well: an existing concurrency block, cleanup
dependencies, environments, deploy, signing, publish, migration, or unexplained
side effects. The workflow Attestation must cover `ciOnly` and `replaceSafe`, and
every opaque action, script, and reusable reference must be recorded. An
attestation can never relax the exact-`pull_request` requirement.

The plan is also blocked when the workflow owns a required check, when
protection data cannot be read, when classic branch protection is enabled or
unknown, when the pull request targets a branch other than
`protection.defaultBranch`, or when dynamic job names make the required check
mapping ambiguous. That is a deliberate v0.1 limitation, not a claim that
concurrency is wrong for required checks. If the eligible rate stays too low in
measurement, CD001 ships as diagnosis-only.

Generated groups use a stable namespace derived from the repository ID and the
normalized workflow path, plus the PR number and a `github.run_id` fallback. See
`patch-model.md` for the exact shape. Any current workflow group that could
collide (case-insensitively), or a dynamic group that cannot be excluded, makes
the plan `review-only`.

## CD002: duplicate trigger candidates

A workflow that has both `push` and `pull_request` is not waste by itself.
Runs are equivalent only when event, verified tree, permissions, inputs, job
definitions, and checkout ref match. Show similar checks on a time axis as
evidence, and do not label them "duplicates that can be deleted".

No run history means `skipped`. Partial history or definitions means
`candidate` with unknown runner savings. v0.1 offers no trigger removal and no
combined savings scenario. Missing savings stay `unknown`; sorting never fills
them with 0 to look more precise.

## CD003: heavy checks on non-product docs

Compare the human-declared `nonProductDocs` against every changed file. The
narrow default examples are README, CHANGELOG, and `docs/notes`; a blanket
"any `.md`" rule is not applied. Changes to MDX, documentation sites, Astro
content, API schemas, translations, test fixtures, lockfiles, CI definitions, or
shared scripts are not non-product docs. Check both old and new paths of a
rename.

When `changedFiles` is partial, compute a `subset` and publish the analyzed PRs,
files, and omission boundary in the finding; if a missing file could be product
code, do not create the candidate. Skip when past diffs can only be replaced by
the current PR diff. The heavy job that actually ran must be linked to its
source definition.

Missing protection data makes it a `candidate` that is excluded from cost
totals. Even when complete, v0.1 does not auto-generate path filters, gates, or
matrix edits. Avoid a workflow-level `paths` skip that leaves a required check
Pending; that belongs to a later design.

## CD004: matrix review candidates

Evaluate only matrices that can be resolved statically, including static
include and exclude. Apply exclude to the axis product before include; an
include merges only into rows whose original axis values it matches, a later
include may overwrite a value an earlier include added, and a matrix without
axes uses its include entries as the row list. Apply the 256-row cap after
exclude: a product that is too large only because of rows the exclude removes is
still analyzable within the work budget. Expansion stops after 65,536 exclude
condition evaluations and returns unresolved rather than partial rows when
that budget is exhausted. When actual job names cannot be
mapped to axis combinations, show the static combination count only. Do not expand dynamic
matrices, `needs` chains, or reusable workflow internals. Lowering
`max-parallel` does not reduce total runner time and is never counted as a
saving. Do not remove an OS or architecture the user needs. Missing history or
definitions yields a `static` candidate with no scenario. v0.1 does not edit
matrices, and a large combination count alone is not an error.

## CD005: timeouts

Collect successful samples sharing workflow definition hash, job key, runner
identity, matrix, and event. Samples whose local scripts or actions changed are
not the same cohort. If core behaviour identity cannot be established, do not
emit a p95 recommendation.

The jobs endpoint reports a display name, not the workflow job key. Within one
job, a display name equal to the key, a literal job `name:` value, or a matrix
expansion can explain the observed name. Treat those renderings as candidates
of the same run name and resolve the key only when exactly one job and leg
remains. A key match never outranks a literal or matrix match, and a literal
name shared by several matrix legs leaves the leg unknown. When the key cannot
be resolved, the job may support a reviewer-facing candidate but must not seed
a cohort, a p95, or a plan.

With a complete cohort and at least 20 successful samples, compute nearest-rank
p95. For partial history or definitions, compute a `subset` result and publish
the cohort definition (workflow hash, job key, runner, matrix, event), included
run IDs, sample count `n`, and the omission boundary. Subset savings are
reported only for the observed subset. Write eligibility additionally requires
the edited job's cohort to have at least 20 samples and complete premise and
policy evidence.

Matrix and runner legs stay distinct cohorts, but one finding and one
recommendation cover the whole job. The recommendation is the slowest measured
leg's value, so a fast leg can never justify a timeout that would kill a slow
leg. Every leg must reach 20 samples for write eligibility; a leg below the
candidate threshold keeps the job review-only. The published identity lists the
matrix values covered.

The recommendation is `ceil(max(2 * p95Seconds, p95Seconds + 300) / 60)` minutes.
If that exceeds the user's maximum, block with a "recommendation cap conflict"
instead of clamping. If any successful sample exceeded the recommendation,
block automatic planning. Human attestation of job scope and opaque
dependencies is required. Only insert or reduce an integer literal when timeout
is absent or larger; keep an equal or smaller existing value; expressions are
report-only. Deploy, migration, release, and cleanup jobs are blocked by
default.

Normal successful runtime reduction is `not_applicable`. Historical excess is
computed only when an abnormal long run's termination cause is known; simply
being slow is not a hang.

## CD006: npm download cache

CD006 reads workflow text and needs no run history. It targets a job only when
the workflow and job keep the repository root as their working directory, the
step immediately before setup-node is `actions/checkout` without user `with`
options, exactly one `actions/setup-node@v3` or `@v4` step (major, major.minor,
or major.minor.patch) follows it, and the step immediately after it runs exactly
`npm ci`. The job must not use a reusable workflow, a local action, any `uses`
value that names a cache action, an existing `cache`, `cache-dependency-path`,
or `package-manager-cache` input, or a flow-style step mapping. The root
`package.json` and `package-lock.json` must be committed regular files, parse
as JSON, be no larger than 4 MiB, and use lockfile version 1, 2, or 3; symlinks
are rejected.

The edit inserts only `cache: npm` and `cache-dependency-path: package-lock.json`
into the setup-node `with` mapping. Node and action versions, `npm ci`, tests,
permissions, and every other workflow field stay unchanged. Local cache actions,
separate cache steps, and dynamic cache paths are outside the rule and are never
proposed.

Evidence is `static` and bound to the workflow hash plus the hashes of the two
root manifests. Cache benefit is unknown until comparable cold and warm runs
exist, so `standaloneRunnerSeconds` is unknown with reason
`CACHE_BENEFIT_UNMEASURED`; a finding or plan never claims saved runner minutes
or money. A plan still needs explicit human approval and uses the normal apply
and revert flow. CLI `plan --rule CD006` performs this static scan directly and
saves a plan without a prior history sync. Only the `workflowDefinitions` axis
must be complete: a partial axis degrades the rule, an unavailable axis skips
it, and the other four axes do not restrict it. A missing, unreadable, or
invalid root manifest produces no CD006 finding.

## CD008: artifact retention

Target only confirmed `actions/upload-artifact` steps. Do not change the action
version. Do not infer temporary purpose from an artifact name; require a human
step-scope Attestation with `artifactPurpose=temporary`, a consumer minimum
period, and a dependency fingerprint.

Seven days is a proposal, not a default. Apply it only when it is below the
confirmed effective maximum and at or above the consumer minimum. If the
maximum is 3 days, do not apply 7; show the conflict. If the maximum is
unknown, keep 7 as an explanatory proposal with `patchability=review-only`.
`0` means the repository default, never zero-day retention, so a stored 0 is
lowered to the proposal like any larger literal.

When the upload step has no `with`, only a supported block mapping may gain an
inserted parent mapping that creates `with` and `retention-days` together. Multiple
upload steps each need their own digest, index, and id. Expression retention is
report-only, and an existing shorter literal is never increased. Current
artifacts are not deleted; only future uploads change.

## Precision and patch safety

Detection precision, eligible rate, and patch safety are separate measures. A
70% precision rate is not a safety threshold for automatic edits. If any patch
fixture or real-sample revert shows source corruption or a missed check, disable
writes for that rule. Suppressions and human evaluations bind to the finding
fingerprint, workflow hash, expiry, and reason; they never silently carry over
to a different version of the finding.
