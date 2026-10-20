# Changelog

All notable changes to this project are recorded here. The format follows
Keep a Changelog, and the project uses semantic versioning.

## 0.1.0 (unreleased)

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
- CLI commands `scan`, `sync`, `plan`, `approve`, `apply`, `revert`,
  `changes`, and `plans`.
- DSH bundle plugin with `ci_diet_scan`, `ci_diet_sync`, `ci_diet_report`,
  and `ci_diet_plan`.
- English and Korean message catalogs; Simplified Chinese is a slot.

### Known gaps

- The DSH Web client screens are not implemented yet.
- The package is not published to npm.
- CD003 and CD005 are disabled by default pending real-history measurement.
