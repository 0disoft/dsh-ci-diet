import { digestOf, sha256Hex } from "../../shared/cdj1.ts";
import type { Attestation, ByteEdit, PatchPlan, PatchPayload, PolicySnapshot, RepositoryBinding } from "../contracts/schema.ts";
import type { ProtectionSnapshot, RetentionSnapshot } from "../history/model.ts";
import type { WorkflowDefinition } from "../workflow/model.ts";
import { ENGINE_VERSION } from "../version.ts";
import { applyEdits, semanticCheck } from "./edits.ts";
import { semanticProblems } from "./semantic.ts";
import { PLAN_TTL_SECONDS } from "../policy/constants.ts";

export { PLAN_TTL_SECONDS, POLICY_MAX_AGE_SECONDS } from "../policy/constants.ts";

export interface PlanInput {
  readonly binding: RepositoryBinding;
  readonly workflow: WorkflowDefinition;
  /** Current bytes on disk, exactly the bytes the workflow hash came from. */
  readonly text: string;
  readonly edits: readonly ByteEdit[];
  readonly attestations: readonly Attestation[];
  readonly policies: readonly PolicySnapshot[];
  readonly blockers: readonly string[];
  readonly coverageWriteAllowed: boolean;
  readonly now: Date;
  readonly provenance?: "synthetic" | "observed";
  readonly dependencies?: readonly { readonly ref: string; readonly sha256: string }[];
  /** Expected values for the edit kinds, overriding what the edits themselves imply. */
  readonly expected?: { readonly group?: string; readonly minutes?: number; readonly days?: number };
}

export interface BuiltPlan {
  readonly plan: PatchPlan;
  readonly resultText: string;
  readonly sourceHash: string;
  readonly resultHash: string;
}

function iso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function sourceHashOf(text: string): string {
  return "sha256:" + sha256Hex(text);
}

export function dependencyHashOf(dependencies: readonly { readonly ref: string; readonly sha256: string }[]): string {
  return digestOf({ dependencies });
}

/** Compute the edited bytes and verify that only the intended semantic paths changed. */
export function previewEdits(
  workflow: WorkflowDefinition,
  text: string,
  edits: readonly ByteEdit[],
  expected: { readonly group?: string; readonly minutes?: number; readonly days?: number },
): { readonly resultText: string; readonly sourceHash: string; readonly resultHash: string } {
  const sourceHash = sourceHashOf(text);
  if (sourceHash !== workflow.sha256) {
    throw new Error("SOURCE_HASH_MISMATCH: the workflow definition is not from these bytes");
  }
  const applied = applyEdits(text, edits);
  if (applied.hash === sourceHash) throw new Error("NO_OP_PLAN: edits do not change the bytes");
  const problems = semanticProblems({ original: workflow, originalText: text, resultText: applied.text, edits });
  if (problems.length > 0) throw new Error("EDIT_OUT_OF_SCOPE: " + problems.join("; "));
  for (const edit of edits) {
    const problem = semanticCheck(workflow, applied.text, edit, expected);
    if (problem !== null) throw new Error(problem);
  }
  return { resultText: applied.text, sourceHash, resultHash: applied.hash };
}

export function buildPatchPlan(input: PlanInput): BuiltPlan {
  if (input.edits.length === 0) throw new Error("PLAN_EMPTY: at least one edit is required");
  if (input.attestations.length === 0) throw new Error("ATTESTATION_MISSING: a plan needs at least one human attestation");
  if (input.policies.length === 0) throw new Error("POLICY_STALE: a plan needs at least one policy snapshot");
  if (!input.coverageWriteAllowed) throw new Error("COVERAGE_INSUFFICIENT_FOR_WRITE: this finding is not writable");
  const dependencies = [...(input.dependencies ?? [])].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const concurrencyReplacement = input.edits.find((edit) => edit.ruleId === "CD001")?.replacementUtf8;
  const group = concurrencyReplacement === undefined ? undefined : /group: (.*)/.exec(concurrencyReplacement)?.[1];
  const expected: { group?: string; minutes?: number; days?: number } = { ...input.expected };
  if (group !== undefined) expected.group = group;
  const timeoutEdit = input.edits.find((edit) => edit.ruleId === "CD005");
  if (timeoutEdit !== undefined) {
    const parsed = /timeout-minutes:\s*(\d+)/.exec(timeoutEdit.replacementUtf8);
    if (parsed?.[1] !== undefined) expected.minutes = Number(parsed[1]);
  }
  const retentionEdit = input.edits.find((edit) => edit.ruleId === "CD008");
  if (retentionEdit !== undefined && expected.days === undefined) {
    const parsed = /retention-days:\s*(\d+)/.exec(retentionEdit.replacementUtf8) ?? /^(\d+)$/.exec(retentionEdit.replacementUtf8.trim());
    if (parsed?.[1] !== undefined) expected.days = Number(parsed[1]);
  }
  const preview = previewEdits(input.workflow, input.text, input.edits, expected);
  const createdAt = iso(input.now);
  const expiresAt = iso(new Date(input.now.getTime() + PLAN_TTL_SECONDS * 1000));
  const ruleIds = [...new Set(input.edits.map((edit) => edit.ruleId))].sort();
  const payload: PatchPayload = {
    bindingId: input.binding.bindingId,
    rootIdentityHash: input.binding.rootIdentityHash,
    workflowPath: input.workflow.path,
    engineVersion: ENGINE_VERSION,
    ruleIds: ruleIds as PatchPayload["ruleIds"],
    sourceHash: preview.sourceHash,
    resultHash: preview.resultHash,
    dependencyHash: dependencyHashOf(dependencies),
    dependencies: [...dependencies],
    edits: [...input.edits],
    attestations: [...input.attestations],
    policies: [...input.policies],
    blockers: [...input.blockers],
    createdAt,
    expiresAt,
  };
  const planDigest = digestOf(payload);
  const plan: PatchPlan = {
    schemaVersion: 2,
    provenance: input.provenance ?? "observed",
    planId: "p_" + planDigest.slice("sha256:".length, "sha256:".length + 24),
    planDigest,
    status: { state: "draft", revision: 1, previewedAt: null, approvedAt: null, approvalNonceId: null },
    payload,
  };
  return { plan, resultText: preview.resultText, sourceHash: preview.sourceHash, resultHash: preview.resultHash };
}

export function buildPolicySnapshots(options: {
  readonly binding: RepositoryBinding;
  readonly protection: ProtectionSnapshot | null;
  readonly retention: RetentionSnapshot | null;
  readonly now: Date;
}): PolicySnapshot[] {
  const observedAt = iso(options.now);
  const policies: PolicySnapshot[] = [];
  const protection = options.protection;
  const protectionStatus = protection !== null && protection.ruleCount !== null ? "known" : "unknown";
  policies.push({
    kind: "protection",
    bindingId: options.binding.bindingId,
    status: protectionStatus,
    observedAt: protection === null ? observedAt : iso(new Date(protection.fetchedAt)),
    policyHash: digestOf({ kind: "protection", status: protectionStatus, ruleCount: protection?.ruleCount ?? null, classic: protection?.classicProtection ?? null }),
    effectiveMaxDays: null,
    requiredCheckNames: [],
    sourceRef: "github:branches/" + (protection?.defaultBranch ?? "unknown") + "/protection",
  });
  const retention = options.retention;
  const retentionStatus = retention !== null ? "known" : "unknown";
  policies.push({
    kind: "retention",
    bindingId: options.binding.bindingId,
    status: retentionStatus,
    observedAt: retention === null ? observedAt : iso(new Date(retention.fetchedAt)),
    policyHash: digestOf({ kind: "retention", status: retentionStatus, days: retention?.days ?? null, max: retention?.maximumAllowedDays ?? null }),
    effectiveMaxDays: retention === null ? null : retention.maximumAllowedDays,
    requiredCheckNames: [],
    sourceRef: "github:repositories/actions/permissions/artifact-and-log-retention",
  });
  return policies;
}