# Architecture decisions

Each record states the decision and the reason it was made. Reversing one needs a
new record, not an edit to the rationale.

| ADR | Decision | Reason |
| --- | --- | --- |
| ADR-01 | Rules, cost calculation, and patch generation are deterministic core code. | Model explanation is separated from judgement so results are reproducible and reviewable. |
| ADR-02 | One package, with a CLI path that survives independently of the plugin UI. | A DSH API change must not take the whole product down. |
| ADR-03 | 7 days, 100 runs, and 400 dispatches by default, with explicit partial results. | Complete collection and resource caps are different concepts; pretending collection is complete corrupts every derived number. |
| ADR-04 | A durable Attestation and a single-use approval are separate records. | An old premise and a new byte change must each be verified on their own terms. |
| ADR-05 | Applying is forbidden until the file backup is durably stored. | Host KV size must not be the precondition for a revert guarantee. |
| ADR-06 | Nonce, digest, and scope checks apply even to the owner principal. | Owner permission is not a statement of human intent for this specific edit. |
| ADR-07 | No telemetry by default; only user-initiated export. | Private workflow data is never shared outward automatically. |
| ADR-08 | After measurement, enable at most three rules by default. | A small number of valid cases beats a long list of rules. |
| ADR-09 | Actual charge, list price, and time are reported as separate fields. | No money or wait-time saving is announced without evidence. |
| ADR-10 | Limit writes on untested prereleases and unknown policy. | A broad compatibility claim does not replace tested compatibility and safety. |
| ADR-11 | The JSON contracts are mirrored into this repository; only prose fields are localized. | The public repo must build without the private Korean design pack, while structure, enums, hashes, and digests stay identical. Localized pointers are declared in `scripts/sync-contracts.mjs`. |
| ADR-12 | Public documentation is English; Korean is a mirrored README. | Three-language UI validation and translation drift cost more than they return at this stage, and domain terms mistranslate easily. Simplified Chinese remains a translation slot. |
| ADR-14 | Every digest is sha256 over CDJ1 canonical JSON, and the TypeScript types are generated from the committed JSON Schema. | One canonical form keeps pricing hashes, dependency hashes, and plan digests reproducible across CLI, plugin, and tests. Generated types are checked in CI so the schema cannot drift from the code that consumes it. |
| ADR-13 | Rule defaults follow the A0a spike: CD001, CD002, and CD008 are on by default; CD005 stays off until job keys resolve; CD003 stays off until its sample is widened. | Only CD001 and CD008 had enough observable targets, and job rows cannot be attributed to YAML job keys, so a timeout patch could otherwise target the wrong job. The measurement is recorded in `docs/spikes/a0a-rules.md`. |

## Notes

- ADR-03 default numbers are fixed by `examples/default-config.json`; changing
  them changes user-visible behaviour and needs a new ADR.
- ADR-08 means an empty enabled-rule list is never treated as success; the
  release scope record freezes what measurement actually validated.
- ADR-11 permits rewording of the four coverage-level descriptions and two sample
  reasons. It does not permit changing enums, required fields, or any hash input.
  Where the private pack is unavailable, `--check` falls back to
  `contracts/contracts.lock.json`; the lock is regenerated only with an
  intentional, reviewed contract change.
- ADR-13 does not lower CD005's 20-sample write requirement and does not remove
  CD005 from the contract's writable rule set. It changes defaults, not write
  safety. Enabling rules is a runtime setting; `allowedRules` still bounds writes.
- ADR-13 also rests on `evidence/a0a/jobkey.json`: best-effort key recovery
  matched 40.7% of sampled jobs, and the only key-level cohort with 20 samples
  already carried a timeout. Per-matrix cohorting makes the gate rarer still.
- The `src/core/workflow` port replays the same sample at 43.9%
  (`evidence/a0a/parser-verify.json`). Honoring `matrix.include` and `exclude`
  explains the gain; computed matrices still resolve to nothing, so the
  key-recovery ceiling is a data property, not an implementation gap.
- CD004 is on by default although ADR-13 names three history-dependent rules: it
  reads workflow text only, is review-only, and has no write path, so the
  write-safety gate does not apply to it.
- CD005 is revisited only with real history, not with a lowered threshold: after
  five or more users sync 90 days of history, if at least half of those
  repositories produce one or more candidates with no timeout, a cohort of five
  or more samples, and removable minutes above zero, a new ADR may propose the
  5-sample threshold and the larger margin. Otherwise CD005 is removed from the
  v0.1 UI and kept as a v0.2 candidate. The code path stays behind
  `rules.CD005.enabled=false` so re-enabling is a setting, not a rewrite.
- ADR-14 covers `src/shared/cdj1.ts`: object keys sort in ASCII order, arrays keep
  their order, only safe integers are allowed, and keys must be printable ASCII.
  The implementation reproduces the three committed vectors (pricing
  `sha256:acc8d110...`, empty dependency `sha256:81059fe6...`, example plan
  `sha256:d8984479...`). `src/core/contracts/schema.ts` is a structural mirror;
  pattern, length, range, format, and if/then/else constraints are enforced by
  Ajv, not by the types.

## ADR-15: Packaging is one bundle with a single loader entry

- Scope: how the DSH plugin is installed and what it registers.
- Decision: one npm package named `dsh-ci-diet`. `dsh.bundle.patch` points at
  `cordis.patch.yml`, which inserts exactly one entry, `ciDiet.bootstrap`,
  with `networkEnabled` and `localApplyEnabled` both false. The plugin
  registers four tools and no client bundle yet.
- Config is a Schemastery schema. `@deepseek-ai/cordis`,
  `@deepseek-ai/dsh-tools`, and `@deepseek-ai/schemastery` stay peers plus
  dev dependencies, so the host owns their instances; `ajv`, `ajv-formats`,
  and `yaml` are regular dependencies.
- Tool output schemas use the value DSL that `defineTool` accepts. Coverage
  and metric rows are flattened to arrays of strings instead of nested
  contract objects, because the model reads them, not the contract validator;
  the full report stays on disk where Ajv validates it.
- The package ships `dist/` only. There is no install-time build and no
  postinstall script.
- Rationale: a single insert entry keeps `dsh --dump-config` honest and makes
  removal a one-line patch revert. Keeping the host packages as peers avoids
  two Cordis or DSH runtime copies in one process.
- Consequence: a peer resolution failure is a host installation problem, not a
  silent fallback. The documentation names the required DSH range.

## ADR-16: v0.1 ships a static HTML report instead of DSH Web screens

- Scope: how a report leaves the machine and is read by a person.
- Decision: `ci-diet report --format html` renders one self-contained HTML file
  from a stored report: inline CSS, no scripts, no external URLs, all dynamic
  text escaped. `ci-diet prune` removes reports, plans, and cache entries past
  their retention windows; backups are never pruned automatically.
- The DSH client screens are deferred. A client plugin can only reach host data
  through `ctx.remote.<namespace>`, and a namespace exists only when a
  host-compiled Typert contribution is mounted with `ctx.remote.$mount`
  (`@deepseek-ai/dsh-api-remotes/lib/client.js` mounts 25 contributions, and
  `dsh-api-gateway/lib/types/client/index.js:88-199` validates strict descriptors
  with a zod codec). Hand-writing that descriptor would depend on a private
  shape, and there is no browser harness in this repository to verify the
  rendering.
- Rationale: a file that opens in any browser delivers the same review and
  sharing value for the v0.1 scope (one repository, one person) without a
  dependency that can break on a DSH patch release. The HTML output is tested
  for escaping and for lacking external references.
- Consequence: the report is read-only and carries no interactive approval.
  Approvals stay in the CLI, which keeps the nonce and digest checks in one
  place. When the client contribution format stabilizes, the screens can render
  the same stored report; no core change is needed.
- Reversal: replacing HTML with Web screens is additive, not a contract change,
  because both read `AnalysisReport` from the local store.

