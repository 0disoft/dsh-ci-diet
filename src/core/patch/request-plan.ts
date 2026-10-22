import type { Attestation, ByteEdit, Coverage, Finding, PatchPlan, RepositoryBinding } from "../contracts/schema.ts";
import type { HistoryBundle } from "../history/model.ts";
import type { WorkflowDefinition, WorkflowJob } from "../workflow/model.ts";
import { PROPOSED_RETENTION_DAYS } from "../policy/constants.ts";
import type { PatchRule } from "./eligibility.ts";
import type { CoverageLevel } from "../model/domain.ts";
import { evaluatePatchEligibility } from "./eligibility.ts";
import { composeCoverage } from "../analysis/coverage.ts";
import { buildPatchPlan, buildPolicySnapshots, dependencyHashOf } from "./plan.ts";
import { createAttestation } from "./attestation.ts";
import { collectDependencies } from "./dependencies.ts";
import { planConcurrencyEdit, planRetentionEdit, planTimeoutEdit } from "./edits.ts";

/** Why a requested patch plan could not be built. Callers map these to their own surface. */
export type RequestPlanBlocker =
  | "EXISTING_CONCURRENCY"
  | "JOB_REQUIRED"
  | "STEP_REQUIRED"
  | "EDIT_NOT_APPLICABLE"
  | "NOT_ELIGIBLE"
  | "RULE_NOT_ALLOWED"
  | "HISTORY_REQUIRED"
  | "PLAN_REJECTED";

export interface RequestedPlanInput {
  readonly binding: RepositoryBinding;
  readonly workflow: WorkflowDefinition;
  readonly text: string;
  readonly rule: PatchRule;
  /** Rules the caller's configuration permits writing. The plan is refused otherwise. */
  readonly allowedRules: readonly PatchRule[];
  readonly jobKey: string | null;
  readonly stepIndex: number | null;
  readonly minutes: number | null;
  /** Retention days to propose; defaults to the shared CD008 proposal. */
  readonly retentionDays?: number;
  readonly finding: Finding;
  readonly coverage: Coverage;
  readonly claims: Attestation["claims"];
  /** Required to build a plan; omit for an edit-only preview. */
  readonly history: HistoryBundle | null;
  readonly evidenceRef: string;
  readonly issuedBy: Attestation["issuedBy"];
  readonly now: Date;
  readonly policyMaxAgeSeconds?: number;
  readonly attestationTtlSeconds?: number;
}

export type RequestedPlanResult =
  | { readonly ok: true; readonly plan: PatchPlan; readonly attestation: Attestation; readonly edits: readonly ByteEdit[]; readonly coverageLevel: CoverageLevel }
  | {
      readonly ok: false;
      readonly blocker: RequestPlanBlocker;
      readonly reasons: readonly string[];
      /** The edit that was prepared before a later phase refused, when one exists. */
      readonly edits: readonly ByteEdit[];
      /** Present when eligibility ran and produced a level. */
      readonly coverageLevel?: CoverageLevel;
    };

function failed(blocker: RequestPlanBlocker, reasons: readonly string[], edits: readonly ByteEdit[] = []): RequestedPlanResult {
  return { ok: false, blocker, reasons, edits };
}

function findJob(workflow: WorkflowDefinition, jobKey: string | null): WorkflowJob | undefined {
  return jobKey === null ? undefined : workflow.jobs.find((job) => job.key === jobKey);
}

/**
 * Build the single edit a rule request names, or explain why the request cannot
 * be edited. This is the shared input-validation phase for the CLI and DSH tool.
 */
function requestedEdit(input: RequestedPlanInput): { edits: readonly ByteEdit[]; scope: "workflow" | "job" | "step"; jobKey: string | null; stepKey: string | null; expected: { group?: string; minutes?: number; days?: number } } | RequestedPlanResult {
  if (input.rule === "CD001") {
    if (input.workflow.concurrency !== null) return failed("EXISTING_CONCURRENCY", ["EXISTING_CONCURRENCY"]);
    const result = planConcurrencyEdit(input.text, input.workflow, input.binding.repositoryId);
    if (result.edit === null) return failed("EDIT_NOT_APPLICABLE", [result.error?.detail ?? "EDIT_NOT_APPLICABLE"]);
    const group = result.edit.replacementUtf8.split("group: ")[1]?.trim() ?? "";
    return { edits: [result.edit], scope: "workflow", jobKey: null, stepKey: null, expected: { group } };
  }
  const job = findJob(input.workflow, input.jobKey);
  if (input.rule === "CD005") {
    if (job === undefined || input.minutes === null) return failed("JOB_REQUIRED", ["JOB_AND_MINUTES_REQUIRED"]);
    const result = planTimeoutEdit(input.text, input.workflow, job, input.minutes);
    if (result.edit === null) return failed("EDIT_NOT_APPLICABLE", [result.error?.detail ?? "EDIT_NOT_APPLICABLE"]);
    return { edits: [result.edit], scope: "job", jobKey: job.key, stepKey: null, expected: { minutes: input.minutes } };
  }
  if (job === undefined || input.stepIndex === null) return failed("STEP_REQUIRED", ["JOB_AND_STEP_REQUIRED"]);
  const step = job.steps[input.stepIndex];
  if (step === undefined) return failed("STEP_REQUIRED", ["STEP_NOT_FOUND"]);
  const days = input.retentionDays ?? PROPOSED_RETENTION_DAYS;
  const result = planRetentionEdit(input.text, job, step, days);
  if (result.edit === null) return failed("EDIT_NOT_APPLICABLE", [result.error?.detail ?? "EDIT_NOT_APPLICABLE"]);
  return { edits: [result.edit], scope: "step", jobKey: job.key, stepKey: "steps[" + input.stepIndex + "]", expected: { days } };
}

/**
 * Shared plan-creation use case: one named edit, its human attestation, the
 * eligibility re-check, policies, and the final plan. It does not persist
 * anything; each caller decides whether to save the attestation and plan.
 */
export function buildRequestedPlan(input: RequestedPlanInput): RequestedPlanResult {
  if (!input.allowedRules.includes(input.rule)) {
    return failed("RULE_NOT_ALLOWED", ["RULE_NOT_ALLOWED: " + input.rule]);
  }
  const edit = requestedEdit(input);
  if ("ok" in edit) return edit;
  if (input.history === null) {
    const composition = composeCoverage(input.coverage, input.rule, { currentDefinitionParsed: true, editedJobEvidenceComplete: true });
    return failed("HISTORY_REQUIRED", ["HISTORY_REQUIRED", "COVERAGE_" + composition.level.toUpperCase()], edit.edits);
  }

  const dependencyReport = collectDependencies(input.binding.workspaceRoot, input.workflow);
  const attestation = createAttestation({
    bindingId: input.binding.bindingId,
    workflowPath: input.workflow.path,
    workflowHash: input.workflow.sha256,
    dependencyHash: dependencyHashOf(dependencyReport.dependencies),
    scope: edit.scope,
    jobKey: edit.jobKey,
    stepKey: edit.stepKey,
    claims: input.claims,
    evidenceRefs: [input.evidenceRef],
    issuedBy: input.issuedBy,
    ...(input.attestationTtlSeconds !== undefined ? { ttlSeconds: input.attestationTtlSeconds } : {}),
    now: input.now,
  });

  const eligibility = evaluatePatchEligibility({
    rule: input.rule,
    finding: input.finding,
    coverage: input.coverage,
    claims: attestation.claims,
    history: input.history,
    currentDefinitionParsed: true,
    editedJobEvidenceComplete: true,
    ...(input.policyMaxAgeSeconds !== undefined ? { policyMaxAgeSeconds: input.policyMaxAgeSeconds } : {}),
    now: input.now,
  });
  if (!eligibility.allowed) {
    return { ...failed("NOT_ELIGIBLE", eligibility.reasons, edit.edits), coverageLevel: eligibility.coverageLevel };
  }

  const policies = buildPolicySnapshots({
    binding: input.binding,
    protection: input.history.protection,
    retention: input.history.retention,
    now: input.now,
  });
  try {
    const built = buildPatchPlan({
      binding: input.binding,
      workflow: input.workflow,
      text: input.text,
      edits: [...edit.edits],
      attestations: [attestation],
      policies,
      blockers: [
        ...eligibility.remainingBlockers,
        ...dependencyReport.unresolved.map((ref) => "UNRESOLVED_DEPENDENCY:" + ref),
      ],
      coverageWriteAllowed: true,
      now: input.now,
      dependencies: dependencyReport.dependencies,
      expected: edit.expected,
    });
    return { ok: true, plan: built.plan, attestation, edits: edit.edits, coverageLevel: eligibility.coverageLevel };
  } catch (error) {
    return failed("PLAN_REJECTED", [error instanceof Error ? error.message : "PLAN_REJECTED"], edit.edits);
  }
}
