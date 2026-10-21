# Changelog

All notable changes to this project are recorded here. The format follows
Keep a Changelog, and the project uses semantic versioning.

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