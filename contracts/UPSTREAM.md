# Contract upstream

The JSON Schemas and examples under `contracts/` and `examples/` come from the
frozen design pack.

| Field | Value |
| --- | --- |
| Pack | `ci-diet-design-v0.2.1` (Korean, dated 2026-10-20) |
| Archive | `ci-diet-design-v0.2.1-20261020.zip` |
| Archive sha256 | `3b9e301fe772b7225f1a7e2625151e8129dbc5988fbd316a8d90c3b3e28409ce` |
| Unpacked location | Private design archive, outside this repository |

The unpacked pack is reference material only. It is not edited and not shipped.

## Copied files

| File | Original sha256 | Copy sha256 | Change |
| --- | --- | --- | --- |
| `contracts/ci-diet.schema.json` | `74f388db…` | same | none |
| `contracts/pricing-2026-10-20.json` | `7192ea47…` | same | none |
| `contracts/example-validation-map.json` | `1c1a7b08…` | same | none |
| `contracts/coverage-policy.json` | `11748554…` | differs | localized `/levels/{full,subset,degrade,skip}` prose |
| `examples/finding-evaluation.json` | `fb53333a…` | differs | localized `/reason` |
| `examples/partial-progress.json` | `cd37eb72…` | differs | localized `/budget/wireRequestCount/reason` |
| `examples/README.md` | `7b6de426…` | differs | translated to English |
| other `examples/*.json`, `examples/*.yml` | - | same | none |

## Rules

1. From the import commit onward, the copies in this repository are normative.
   The frozen pack is history and must not be edited in place.
2. `node scripts/sync-contracts.mjs --check` compares the two trees: JSON files
   must match exactly after removing the localized pointers listed above, and
   everything else must match byte for byte. `examples/README.md` is compared
   for existence only because it is translated prose.
3. Adding another localized pointer means editing `LOCALIZED` in the script and
   recording the reason in `docs/spec/decisions.md`. Wording is allowed to differ;
   structure, enums, required fields, hashes, and digests are not.
4. Review chapters, evidence records, agent prompts, and internal estimates stay
   in the private pack. They are never copied here.
