# Changelog

All notable changes to this project are recorded here. The format follows
Keep a Changelog, and the project uses semantic versioning.

## 0.3.1 (2026-10-23)

### Added

- A **Settings → CI Diet** page registers through the public `settings.section`
  slot and edits the engine configuration used by the DSH tools. It reads and
  writes the host `ConfigForm` for `ciDiet.bootstrap`, so the host validates the
  complete contract and refuses a stale revision. Edits are staged and saved as
  one atomic batch with a per-field reset, the page labels its scope and when a
  change applies, and it has no apply, approval, or revert controls. All six
  display languages ship complete dictionaries.
- The package exports `./client` and declares `dsh.client`; the lazy-CJS bundle is
  built at pack time into `client/` and requires only `react` from the loader.
- `ci-diet report` without `--report` now shows the latest report for the
  repository at the effective `--cwd`, matching `plan`, instead of the newest
  report anywhere in the store.
- `ci-diet plan` prints the proposed lines as a small diff, and
  `ci-diet plans --plan <planId>` re-shows a saved plan from its byte edits. This
  makes the reviewed change visible before the approval step.
- The `ci_diet_prune` model tool runs cleanup with the live storage settings:
  report, plan, and cache retention days plus the cache byte cap. It reports the
  freed bytes and quota state and never deletes applied-change backups, which
  still require the CLI listing token.

### Security

- The copied `nextCommand` shell-quotes every argument, so a workflow filename
  with spaces, quotes, `$`, or `;` cannot execute when pasted into a shell.
- Applying a plan re-collects the workflow's current dependencies and compares
  the complete set; a symlink swapped after approval is refused. Hashing uses
  raw bytes, so binary files that decode to the same replacement text no longer
  share a hash. Local action directories are capped by file count and bytes.
- One approval authorizes one transaction. The journal, not the nonce, blocks a
  second apply after APPLIED, APPLYING, REVERTING, or REVERTED, including a
  crash between a confirmed replacement and nonce cleanup, and a change left in
  CONFLICT or RECOVERY_REQUIRED cannot be replayed even after its workflow bytes
  are restored by hand.

### Changed

- The `nextCommand` returned by the DSH plan preview now pins `--cwd` and
  `--state-dir`, so a copied command targets the same workspace and state store
  that produced the preview.
- The DSH plugin marks every engine setting as live: network access, state
  directory, the enabled-rule list, history caps, storage limits, and the cost
  estimate. The Plugins page and the new Settings page can edit them without
  reloading the plugin, and every tool call reads the current value.
  `localApplyEnabled` remains an ordinary reserved field until an apply tool
  exists and is not exposed.
- The Settings page follows the host settings layout and resolves the same
  `--dsw-alias-*` tokens as the built-in screens, so light and dark themes need
  no fallback colors. Only the settings body scrolls; the save bar sits below it
  as a separate footer inside the page width, so scrolled content never shows
  underneath the bar and the last field stays reachable. The draft-discard
  action is named "Discard changes" instead of an ambiguous reverse-change
  label.
- The CLI accepts an injected process boundary (`executeCli(argv, context)`):
  cwd, stdout, stderr, environment, clock, and abort signal. Relative `--out`
  and `--state-dir` paths resolve against the effective working directory,
  including a relative `--cwd`, and `scan` stamps the report with the injected
  clock. Production behavior is unchanged because the defaults are the real
  process.
- `--config <file>` loads a partial JSON configuration, merges it over the
  built-in defaults, and validates the result against the frozen contract before
  any command runs. Storage, history, and analysis limits now come from that
  effective configuration instead of hardcoded defaults.
- Applying a plan is split into a read-only inspection phase (target, approval,
  journal, policy, and byte verification) and a commit phase that only records
  intent and replaces the file. The refusal paths and transaction order are
  unchanged.
- The CLI and the DSH plan tool share one requested-plan use case. It builds the
  named edit, dependency snapshot, attestation, eligibility re-check, policy
  snapshots, and plan, while each caller keeps its own storage and error text.
- Dependency collection separates the hash sink, the local-action walk, and the
  per-command interpreter parsing. Each piece is independent of the workflow
  loop, so the traversal rules can be tested without building a repository.
- Patch and analysis limits live in one shared policy module. Plan lifetime, policy
  freshness, approval lifetime, and attestation lifetime accept the configured
  values; CLI lookback and timeout bounds use the same constants as the contract.
- Workflow discovery and the static scan accept a `FileSystem` port and a command
  runner, so an in-memory tree can exercise the size cap, symlink rejection, and
  binding creation without touching the disk. Production defaults to `node:fs`
  and `git`.
- `apply`, `revert`, and `sync` honor an abort signal. Cancellation before the
  transaction commits leaves the target, journal, and approval untouched and
  releases the writer lease; once a replacement starts the journal still reaches
  a consistent state, and a cancelled sync kills its `gh` child and never saves a
  partial snapshot. The first Ctrl-C forwards the signal before scheduling a
  bounded graceful exit; a second one exits at once.
- Writer serialization uses a claim directory plus a lease. A stale claim left
  by a dead process is recovered; a live owner's lease path is never moved, and
  a takeover re-checks ownership under the claim.
- `revert` keeps CONFLICT retryable and converges when the target already holds
  the original bytes.
- CD001 requires complete protection for the pull request's base branch: an
  unknown or different base, classic protection (including rule count 0), or
  unowned required checks block automatic planning. A claim can no longer lift
  the exact-`pull_request` requirement.
- CD005 aggregates every matrix and runner leg into one job-wide recommendation
  and never proposes a timeout below the slowest measured leg; every leg needs
  20 samples.
- Matrix expansion applies `exclude` to the axis product before enforcing the
  256-row cap, so an excluded oversized product is accepted; it still applies
  `exclude` before `include`, lets a later include overwrite a value an earlier
  include added, keeps include-only matrices as separate rows, and caps include
  rows together with the axis product.
- CD008 treats `retention-days: 0` as the repository default and requires a
  temporary artifact purpose before a retention edit.
- GitHub transport keeps the server's `Retry-After` without a 30 s cap, treats a
  secondary-limit 403 as retryable, forwards the configured request timeout, and
  carries abort signals. Run truncation is reported even when the last page has
  no next page; workflow files resolve through `workflow_id`; unused request
  budget is donated across stages.
- POSIX stores create and repair `0700` directories and `0600` records
  regardless of the umask.
- Plan, attestation, and nonce expiry share one boundary rule: a record is
  expired once the clock reaches its timestamp. Policy freshness uses absolute
  age, so a future-dated snapshot 600 s ahead is stale exactly like a back-dated
  one.
- The GitHub transport retries only rate limits, 502/503/504, and network-level
  failures; deterministic 4xx responses such as 400 and 422 surface on the first
  attempt instead of consuming additional quota.
- `sync --days` accepts only 1 through 30 to match the config contract, and the
  sync entry point validates the whole config before making a request.
- The patch layer accepts optional clock and id seams, and workflow binding
  accepts an optional command runner, so lease aging, expiry, and git discovery
  are testable without real time or a spawned process.
- A history sync has one overall deadline (five minutes by default) in addition
  to the per-request timeout. A server-requested Retry-After is honored up to one
  hour; a longer pause fails fast and reports the rate limit instead of leaving
  the process asleep. The configured request timeout now also bounds the gh
  version probe.
- History collection runs jobs, workflow-definition, and pull-request reads with
  at most concurrentRequests gh requests in flight, and maxRequests now caps the
  whole sync instead of only summing the family quotas. Results are merged in
  repository order, so concurrency does not change the report.
- The store keeps an in-process usage snapshot adjusted by its own writes and
  rescans at most once per second, and latest-report lookups read an index pointer
  with a full-scan fallback when the pointer is missing, corrupt, or dangling.
- Rule evaluation indexes the pull-to-run, superseded-run, workflow-definition,
  job, and matrix-name lookups it used to rescan, and dependency collection
  resolves each run script once. Report order, finding order, and duplicate
  semantics are unchanged.
- Job-key attribution treats the key, literal name, and matrix renderings as
  alternative candidates for one run name. A name explained by more than one
  job or leg is unattributed instead of taking the first or the key-priority
  match.

### Fixed

- The release workflow builds workflow paths with the host separator, so the
  unit suite passes on Linux as well as Windows. The previously tagged 0.3.0
  was never published; 0.3.1 is its first public release.
- A history sync deadline stays referenced until the collection finishes, so a
  stalled child process cannot let the runtime exit before the timeout is
  reported.
- The Settings page now translates every visible field label. The state directory
  row and the six rule checkboxes fell back to raw dictionary keys because their
  entries were missing or named differently, which a live DSH check exposed; the
  dictionaries and the label coverage test now cover both.
- Re-showing a saved plan verifies that the workflow bytes still match the
  plan's source hash. Missing workspace or workflow bytes, or changed bytes, hide
  the diff, keep the plan JSON, explain the state, and exit 3 instead of
  reporting success or rendering a misleading diff against the new file.
- Saving the DSH settings now validates the whole engine contract in the host
  schema: the enabled rules are one field that rejects an empty list or an unknown
  id, and every numeric field carries its contract bounds. An out-of-contract
  lookback or an all-off rule set is refused at save time instead of failing on
  the next tool call. The page also pins the revision it started editing, so a
  save made after another screen changed the configuration is refused instead of
  overwriting the newer values.
- A per-field reset on the Settings page now joins the staged batch and saves
  with the pinned revision. Resetting a field while a draft is open no longer
  clears the revision guard, so the reset cannot overwrite a change another
  screen saved first. Duplicate rule ids are canonicalized to one entry in
  contract order instead of failing the next tool call.
- A permission 403 is no longer mistaken for a secondary rate limit just
  because it carries a quota reset timestamp. Only `Retry-After` or the response
  body marks a secondary limit, so an unreadable resource fails at once instead
  of waiting for the rest of the primary quota window.
- Degraded coverage no longer turns historical scenarios into known savings.
  CD001 keeps its candidate and `COVERAGE_DEGRADE` blocker, but reports the
  standalone seconds as unknown and emits no removal rows, so a partial history
  window cannot inflate the report's saved total.
- A job display name that two jobs or two matrix legs render identically is now
  unattributed instead of silently picking the first match, so one leg's
  samples cannot stand in for another leg's cohort.
- Planning and applying now enforce `apply.allowedRules`. `plan` refuses a
  requested rule outside the configured list instead of producing a plan the
  engine would never apply, and `apply` refuses a plan whose rules are no longer
  allowed before it writes a backup or the workflow.
- The retention and cache settings edited on the Settings page now have an
  execution path: the `ci_diet_prune` model tool applies them to the same store
  the other DSH tools use, instead of cleanup existing only in the CLI whose
  configuration is separate.
- A failing git origin lookup is no longer reported as a missing remote: the
  CLI and the DSH tool show the git explanation, and coverage reasons keep the
  GitHub error code alongside its message. A gh response with no HTTP block but
  auth guidance is classified as a credential problem rather than HTTP 0.
- Binding, history, and report are committed as one generation. The three files
  are written into a new directory and only then does the current-snapshot
  pointer switch, so a quota or I/O failure while writing the report leaves the
  previous generation visible instead of a new binding and history without a
  report. When an older overlapping sync finishes last, it writes nothing and
  says so. A report kept by an earlier generation stays addressable by its id,
  and `prune` applies report retention to generation reports and removes an
  expired generation together with its pointer. The binding is preserved before
  the generation is deleted, so revert keeps working after report retention has
  expired, and sync no longer deletes older generations by count.
- A valid report index answers latest-report lookups without parsing every stored
  report, so unrelated or corrupt older records no longer slow the common path.
- Coverage documents, merged configs, and attestations copy the arrays and
  objects they receive, so mutating a result or an input can no longer change
  the other object. Job parsing returns its unsupported-feature list instead of
  appending to a caller-owned array.
- A crash between replacing a workflow and journaling APPLIED converges on the
  next apply instead of leaving a PREPARED record that cannot be reverted. A
  failed replacement classifies by the target hash and keeps the approval
  usable when the target is untouched.
- A revert crash after restoring bytes converges to REVERTED on retry, including
  from a CONFLICT record.
- A repository with genuinely zero runs in the lookback window reports a
  complete history instead of a partial collection.
- A known runner SKU with no removable minutes reports a known `$0.000000`
  marginal estimate instead of an unknown SKU.
- A file-permission test skips when the process can bypass directory permissions
  instead of failing the suite under root.
- A failed replacement or journal write leaves no temporary workflow file and no
  backup that no journal record can reference. The store removes a partly written
  backup only when it created that backup directory.
- Store writes reserve quota and write their bytes under one filesystem lock, so
  two processes can no longer pass the same free-space check and together exceed
  the store limit. The backup reservation and its three files share that lock.
  Quota admission re-scans after taking the lock instead of trusting this
  process's display cache, so a second process cannot spend bytes the first one
  already wrote.
- Confirmed backup cleanup re-lists under a maintenance lock that revert also
  holds, and its token now binds each change's state, update time, size, and
  backup manifest. A concurrent revert or a backup changed after the listing is
  refused instead of deleted.
- Plan status writes compare the revision they read, and approval removes its
  nonce when that write loses, so a prune or a second writer cannot leave an
  approved nonce pointing at a stale or missing plan. Plan pruning skips a plan
  while its approval claim is held.
- History snapshots keep the newest requested window, and sync publishes a
  report only when its snapshot was stored. An overlapping older sync can no
  longer shrink the stored history or attach a stale report to it.

## 0.2.0 (2026-10-21)

### Added

- Display languages: English, Korean, Simplified Chinese, Hindi, Spanish, and
  French. Every dictionary is complete, and a missing key fails the type check.
  Regional tags resolve by language; unsupported tags fall back to English.
- Locale selection for the CLI and the DSH host: an explicit `--lang`, then the
  DSH locale preference, then `LC_ALL`/`LC_MESSAGES`/`LANG`, then English.
- `Finding.message` (optional `titleKey`, `textKey`, `params`) so a stored
  English finding can be rendered in another language without changing its
  identity. The field is a tracked contract extension outside digests.
- `ci-diet diagnose` reports job-name attribution, matrix legs, unresolved
  definitions, and every incomplete coverage axis from the latest stored
  history. `--require-complete` exits `3`; the command is offline and read-only.
- Advisory cache hygiene hints for dependency installs without a cache and
  literal cache keys that cannot follow a lockfile. They never become findings
  or patches because the frozen contract has no cache rule id.
- Billing estimate configuration (`billing.includedMinutes` and
  `billing.accountMinutesUsed`, or the matching `sync` flags).
  `estimatedMarginalUsd` now prices only minutes already above the account
  allowance and stays `unknown` when the SKU is unknown.
- Storage quota enforcement: writes that would cross `storage.storeMaxBytes` fail
  before any file is created, warnings appear near `warningPercent`, the cache is
  capped by `cacheMaxBytes`, and applied backups are deleted only after
  `prune --applied-backups` lists them and the exact listing token is confirmed.
- Coverage reasons for every collection page cap: workflow discovery, job pages
  per attempt, pull-request file pages, and artifact pages are reported instead
  of silently truncating.
- A recorded `REVERTING` journal state, so a revert that restores bytes but
  cannot finish its record converges on retry instead of looking applied.

### Changed

- The HTML report, CLI finding lines, and DSH tool descriptions, parameter
  descriptions, and render text are localized; the HTML report sets its `lang`
  attribute. Rule ids, error codes, enum values, paths, hashes, and numbers stay
  untranslated.
- GitHub transport honors `Retry-After`, retries network failures and request
  timeouts, and uses the configured `requestTimeoutMs` instead of a hard-coded
  20 s timeout.
- CD005 keeps an existing timeout that is at or below the recommendation,
  reports a reduction for a larger literal, and reads the job definition whose
  hash matches the cohort instead of the current working tree.
- CD008 treats `retention-days: 0` as the repository default, and its retention
  edit aligns with the step mapping indentation for both `uses`-first and
  `name`-first step layouts.
- Matrix replay keeps every leg of a single-job matrix, and coverage composition
  fails closed on an unmapped rule, axis, or status cell.
- Apply saves `APPLYING` before replacing and consumes the approval nonce only
  after a confirmed replacement; revert saves `REVERTING` before restoring. A
  failed replacement leaves the change retryable, and an expired or
  subject-mismatched approval is refused.
- The writer lease records the owner process id: a stale lease is taken over only
  after that process is gone, and a live owner is never moved out of the lease
  path. Release never moves a lease owned by another writer.
- CLI expiry failures exit `3`, `--minutes` accepts `1..360` to match the timeout
  edit, and `apply`/`revert` finish their journal before a SIGINT exit.
- Packaging builds `dist` in `prepack`, the test runner fails on zero collected
  tests, CI provisions the Node floor, and the contracts check validates the
  design-pack lock instead of approving itself.
- `ci-diet --version`, report `engineVersion`, and plan `engineVersion` report
  `0.2.0`.

### Fixed

- Reports resolve the binding for the current workspace, compare timestamps
  chronologically, and reject corrupt stored documents instead of trusting them.
- Stored approvals and patch metadata are validated before use, and a workflow
  path that resolves outside the workspace is refused.
- A committed apply, revert, or approval keeps its result when summary event
  logging fails.
- Release artifacts include `dist` in a clean checkout, and the release tag check
  rejects a tag that does not match `package.json`.

## 0.1.1 (2026-10-21)

### Added

- Release workflow: pushing a `v*` tag runs the CI checks in
  `.github/workflows/publish.yml`, verifies the tag against `package.json`,
  refuses to overwrite an already published version, and publishes with npm
  trusted publishing (GitHub OIDC) and provenance. No npm token is used.

### Changed

- The README, Korean mirror, and specification describe the published package
  and the tag-driven release process.
- `ci-diet --version` and report `engineVersion` now track the package version.

## 0.1.0 (2026-10-21)

### Added

- Frozen contracts imported from design pack v0.2.1, with Ajv validation and a
  deterministic TypeScript mirror (`scripts/gen-types.mjs --check`).
- YAML workflow parser with unsupported-node detection and job key recovery.
- Rules CD001, CD002, CD003, CD004, CD005, and CD008 with coverage composition.
- Cost model: per-job rounding, interval unions, pricing snapshot verification.
- Read-only GitHub transport restricted to an endpoint allowlist, with request
  budgets, retries, and ETag caching.
- Patch engine: byte-range edits, plan lifecycle, attestation nonces, durable
  backups, apply, and revert.
- Plan eligibility gate shared by the CLI and the DSH tool: a finding must be
  patch-eligible, coverage must allow a write, and the rule's policy snapshot
  must be fresh. Refusals return the remaining reason codes.
- Attestation claims for CD001 (`ci-only`, `replace-safe`) and CD008 (artifact
  purpose, consumer minimum days), passed with `--claims` and stored before a
  plan is built.
- CLI commands `scan`, `sync`, `plan`, `approve`, `apply`, `revert`,
  `changes`, `plans`, `report`, and `prune`.
- Self-contained HTML report with inline CSS, escaped text, and no external
  references; text and JSON formats share the same stored record.
- Sync progress line on interactive terminals, and coverage that records the
  negotiated GitHub API version and the `gh --version` used for an observed
  report.
- DSH bundle plugin with `ci_diet_scan`, `ci_diet_sync`, `ci_diet_report`,
  and `ci_diet_plan`.
- English and Korean message catalogs; Simplified Chinese is a slot.

### Fixed

- The semantic guard now parses the whole YAML tree and rejects any path outside
  the declared edits, not only a hand-picked list of keys. Adding
  `permissions.contents`, changing a step `env` value, or attaching
  `environment` to a job fails the plan even when the digest still matches.
- A plan refuses a finding whose `workflowHash` no longer matches the file.
  Editing a workflow after a report now requires a fresh `sync` instead of
  producing a plan from stale evidence.
- A plan must target the job and step the finding measured, and the requested
  value must come from the collected evidence: CD005 minutes must be one of the
  cohort recommendations for that job, and CD008 must name an actual
  `actions/upload-artifact` step. The CLI and `ci_diet_plan` share this check.
- Dependency hashes are filled from the local scripts, composite actions, and
  files the edited workflow references, so changing one after approval fails
  apply with `DEPENDENCY_HASH_MISMATCH`. The scan resolves interpreter
  arguments such as `node build.js`, honors step and job
  `working-directory`, hashes a local action directory as a whole, and reports
  references it cannot resolve as `UNRESOLVED_DEPENDENCY:<path>` blockers.
  Boolean interpreter flags such as `--enable-source-maps` no longer consume
  the script path, and flags that take a value (`--require`, `--loader`,
  `--import`, `--env-file`) hash that value when it names a repository file. A
  local action that hits the 500-file limit or contains an unreadable file or
  directory now reports an unresolved entry instead of looking complete.
- The semantic guard now reports added or removed empty mappings and sequences
  plus parent node type changes, so deleting `permissions: {}` or replacing
  `steps` with `null` can no longer ride along with a plan.
- CI now builds and runs the packaged entry point (`smoke:node`) in addition to
  typecheck, lint, and the test suites.
- The semantic guard also compares every step key, including `env`, `if`, and
  each `with` entry. A digest-consistent payload that drifted outside its rule
  can no longer be applied.
- A plan resolves the binding for the current workspace root before choosing a
  report, so a second repository in the same store never supplies evidence.
- Policy freshness is checked per rule: an unrelated stale snapshot no longer
  blocks a timeout plan.
- Apply holds a writer lease; a concurrent apply fails with `WRITE_CONFLICT`
  before touching the target.

### Known gaps

- The DSH Web client screens are not implemented yet; the HTML report covers
  reading and sharing a report until the client contribution format settles
  (see ADR-16).
- The package is not published to npm.
- CD003 and CD005 are disabled by default pending real-history measurement.