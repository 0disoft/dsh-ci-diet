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
| `contracts/ci-diet.schema.json` | `74f388db…` | differs | added optional `/$defs/Finding/properties/message`, `/$defs/Config/properties/billing`, `REVERTING` in `/$defs/AppliedChange/properties/state/enum`, and CD006 in the rule enums |
| `contracts/pricing-2026-10-20.json` | `7192ea47…` | same | none |
| `contracts/example-validation-map.json` | `1c1a7b08…` | same | none |
| `contracts/coverage-policy.json` | `11748554…` | differs | localized `/levels/{full,subset,degrade,skip}` prose and added `/rules/CD006` |
| `examples/default-config.json` | `47e536dc…` | differs | added `CD006` to `/apply/allowedRules` |
| `examples/finding-evaluation.json` | `fb53333a…` | differs | localized `/reason` |
| `examples/partial-progress.json` | `cd37eb72…` | differs | localized `/budget/wireRequestCount/reason` |
| `examples/README.md` | `7b6de426…` | differs | translated to English |
| other `examples/*.json`, `examples/*.yml` | - | same | none |

## CD006 extension

CD006 is a default static rule that can produce a plan, so every closed rule-id
set that already admits CD001, CD005, and CD008 must also admit it. The v2 schema
adds `CD006` to these enum pointers:

| Pointer |
| --- |
| `/$defs/Config/properties/apply/properties/allowedRules/items/enum` |
| `/$defs/Finding/properties/ruleId/enum` |
| `/$defs/RuleResult/properties/ruleId/enum` |
| `/$defs/ByteEdit/properties/ruleId/enum` |
| `/$defs/PatchPayload/properties/ruleIds/items/enum` |
| `/$defs/ReleaseScope/properties/enabledRules/items/enum` |
| `/$defs/ReleaseScope/properties/patchVerifiedRules/items/enum` |

`examples/default-config.json` adds the same value to `/apply/allowedRules`, so
the shipped default accepts the rule without a separate configuration edit.
The coverage policy gains `/rules/CD006`; only `workflowDefinitions` must be
complete because the rule reads workflow text and the root npm manifests.
History, changed files, protection rules, and retention policy stay `full` at
every axis state and never restrict CD006.

The record shape stays at `schemaVersion: 2`. This change widens existing enum
sets and one shipped default inside the same v2 objects; it adds no required
field, record envelope, or digest input. A new schema version would describe a
different record shape. `EXTENDED_VALUES` in `scripts/sync-contracts.mjs`
removes each added value before comparing the two trees, so the extension stays
explicit and any additional drift still fails the check.

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
4. A schema field that this repository adds on purpose belongs in `EXTENDED`.
   `--check` fails when the repository copy lacks the pointer or when the frozen
   pack already has it, so every extension is visible in review. The current
   extensions are Finding.message, which carries i18n keys and parameters (the
   English `title` and `renderedText` stay canonical), Config.billing, which
   supplies the optional account allowance for the marginal cost estimate, and
   Coverage `/rules/CD006`. Enum values added on purpose belong in
   `EXTENDED_VALUES` and follow the same rule; the current extensions are
   AppliedChange.state `REVERTING`, which records that a revert may have restored
   the file before the journal was finalized, and `CD006` in the rule-id enums
   and the default config's `/apply/allowedRules` array. The rationale for the
   CD006 extension, including why `schemaVersion` stays 2, is above.
5. Deep-copying a file to hide drift is not an extension. Prefer a narrow optional
   field, keep it out of digest inputs, and record the reason in an ADR.
6. Review chapters, evidence records, agent prompts, and internal estimates stay
   in the private pack. They are never copied here.
7. The design pack is not published. When it is absent, `--check` verifies the
   copies against `contracts/contracts.lock.json` (18 files, sha256) and fails
   unless the lock still names the pack above, agrees with the `Archive sha256`
   anchor, and matches the `same`/`differs` rows in this file. After an
   intentional and reviewed change, regenerate the lock with
   `node scripts/sync-contracts.mjs --update-lock` and commit it with the change.
   Regenerating refuses to run without the design pack: the lock may only carry
   the pack's authority, never certify whatever bytes happen to be checked out.
