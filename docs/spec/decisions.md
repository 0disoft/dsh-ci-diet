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
| ADR-13 | Rule defaults follow the A0a spike: CD001, CD002, and CD008 are on by default; CD005 stays off until job keys resolve; CD003 stays off until its sample is widened. | Only CD001 and CD008 had enough observable targets, and job rows cannot be attributed to YAML job keys, so a timeout patch could otherwise target the wrong job. The measurement is recorded in `docs/spikes/a0a-rules.md`. |

## Notes

- ADR-03 default numbers are fixed by `examples/default-config.json`; changing
  them changes user-visible behaviour and needs a new ADR.
- ADR-08 means an empty enabled-rule list is never treated as success; the
  release scope record freezes what measurement actually validated.
- ADR-11 permits rewording of the four coverage-level descriptions and two sample
  reasons. It does not permit changing enums, required fields, or any hash input.
- ADR-13 does not lower CD005's 20-sample write requirement and does not remove
  CD005 from the contract's writable rule set. It changes defaults, not write
  safety. Enabling rules is a runtime setting; `allowedRules` still bounds writes.
