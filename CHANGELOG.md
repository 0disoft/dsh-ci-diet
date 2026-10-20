# Changelog

All notable changes to this project are recorded here. The format follows
Keep a Changelog, and the project uses semantic versioning.

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