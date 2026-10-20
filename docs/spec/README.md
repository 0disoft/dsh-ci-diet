# Specification

CI Diet is a DeepSeek Harness (DSH) Web plugin that reads GitHub Actions run
history and workflow definitions, then reports wasted runner time and proposes
YAML edits that a human reviews and applies locally. This directory is the
normative product specification. It describes behaviour, not the delivery plan.

Status: design stage. There is no installable build yet. The machine-readable
contracts in `contracts/` are ahead of the implementation and are the authority
where prose and schema disagree.

## Scope (v0.1)

- GitHub.com only, one repository per Binding.
- History comes from the read-only GitHub REST API through the `gh` CLI.
  No OAuth application, no write token, no server component.
- Six deterministic rules: CD001, CD002, CD003, CD004, CD005, CD008.
- Three rules may produce a patchable edit: CD001 (concurrency), CD005
  (timeout-minutes), CD008 (retention-days). CD002, CD003, and CD004 are
  explanation-only in v0.1.
- One plan edits one existing `.github/workflows/*.yml` or `*.yaml` file. The
  patch is applied to the working tree by the local CLI or the Web UI after an
  explicit human approval; CI Diet never commits, pushes, opens a PR, or merges.
- All durable state is local. Nothing is uploaded, and there is no telemetry.
- UI languages: English (default) and Korean. Simplified Chinese is a translation
  slot only and falls back to English.

## Non-goals (v0.1)

- Cancelling, restarting, or dispatching workflow runs.
- Deleting artifacts, caches, workflow runs, or branches.
- Changing branch protection, repository settings, environments, or secrets.
- Editing `on`, `permissions`, `if`, `needs`, `matrix`, action versions, or job
  identity.
- Automatic patch generation without a human Attestation and approval.
- LLM judgement of findings. Rules are deterministic; text generation may only
  render a finding, never decide one.
- Billing API access. `actualBilledUsd` stays `unknown` in v0.1.
- Multi-repository analysis, organization roll-ups, and team dashboards.

## Terms

| Term | Meaning |
| --- | --- |
| Binding | The canonical repository ID plus the allowed local workspace root and host profile. Every record is scoped to one Binding. |
| Attestation | A durable human claim about a workflow, job, or step (for example "this workflow only runs checks"), with definition and dependency hashes and an expiry. |
| ApprovalChallenge | A single-use, in-memory nonce bound to a plan digest and purpose. It authorizes one apply or revert, not a class of edits. |
| Coverage | Which evidence axes are complete for a rule: history, workflowDefinitions, changedFiles, protectionRules, retentionPolicy. Each axis is complete, partial, or unavailable. |
| Coverage level | The composed rule outcome for missing evidence: `full`, `subset`, `degrade`, `skip`. `full` adds no restriction for that axis but waives nothing else. |
| evidenceLevel | `observed` (collected), `inferred` (derived with a stated model), `static` (definition-only). |
| patchability | `eligible` (may become a plan), `review-only` (shown, never applied), `blocked` (a precondition failed). `eligible` still requires human approval. |
| Finding | A rule outcome that describes a waste hypothesis with evidence and, where allowed, a patch candidate. |
| Metric | A value that is either `known` (value plus basis), `unknown` (no data, with a reason), or `not_applicable`. Missing data is never written as 0. |
| CDJ1 | The canonical JSON encoding used for every digest: ASCII-sorted keys, preserved array order, finite safe integers only, no Unicode normalization. |
| synthetic | Sample data. `provenance=synthetic` records can never authorize an apply. |

## Document map

| Document | Content |
| --- | --- |
| [rules.md](rules.md) | Rule outcomes, coverage composition, and each rule's evidence and guards. |
| [cost-model.md](cost-model.md) | Metric semantics, minute rounding, overlap removal, wait metrics, SKUs and pricing snapshot. |
| [patch-model.md](patch-model.md) | Allowed edits, ByteEdit invariants, plan state, attestations, apply transactions, recovery. |
| [storage.md](storage.md) | File store layout, KV role, size and retention limits, configuration, error and exit codes. |
| [decisions.md](decisions.md) | Architecture decision records and their rationale. |
| [../../contracts/UPSTREAM.md](../../contracts/UPSTREAM.md) | Where the JSON Schemas came from and which prose was localized. |
| [../../examples/README.md](../../examples/README.md) | What the sample records are and are not. |

## Change policy

The JSON Schemas and examples are imported from the frozen design pack. Any
structural change to them is a specification change and needs an ADR in
`decisions.md`. Localized prose (`/levels/*` in the coverage policy and two sample
reasons) may be reworded without an ADR, but `scripts/sync-contracts.mjs` must keep
passing. Review notes, internal estimates, market plans, and agent prompts stay
in the private design pack and are never copied here.
