# Example boundaries

Values and workflows in this directory are synthetic design examples. They are
not real repository history, user approvals, successful runs, or realized
savings. `provenance=synthetic` cannot authorize a production Attestation, plan,
or apply, and writers must reject it explicitly.

`patch-plan.json` shows how before/after bytes connect to a CDJ1 digest. Its
blockers include SYNTHETIC_INPUT and RELEASE_SCOPE_UNVERIFIED, so it is not an
applicable approval. `prepared-change.json` is likewise a synthetic PREPARED
record, not evidence that a file replacement ran. `finding-evaluation.json` shows
the shape of a separate external evaluation record; it is not a real evaluation
linked to the empty-findings sample report.

`analysis-report.json` keeps all six rules skipped because ReleaseScope is still
empty. It does not turn an uncollected history into 0 seconds, 0 dollars, or a
normal verdict. `partial-progress.json` covers a case where all 400 requests were
used yet the jobs for the selected 200 runs were not all obtained.

`savings-vectors.json` is for checking rounding, overlap, clipping, zero seconds,
and the DAG lower bound. `coverage-vectors.json` has 48 partial/unavailable cells,
2 retention cells, and 1 composite degradation. `a0-measurement-template.json`
has null numbers because no human evaluation exists yet.

`contracts/example-validation-map.json` declares which `$defs` validates each major
JSON file. Structural validation can run with Python jsonschema or Ajv2020.
`tools/check-pack.mjs` does not pretend to be a structural validator; it checks
links, hashes, numbers, and cross-contract invariants only.
