import type { Finding } from "../contracts/schema.ts";
import type { HistoryBundle } from "../history/model.ts";
import { cd005Recommendations } from "../rules/cd005.ts";
import { PROPOSED_RETENTION_DAYS } from "../rules/cd008.ts";
import { sourceHashOf } from "./plan.ts";
import type { PatchRule } from "./eligibility.ts";
import type { WorkflowDefinition } from "../workflow/model.ts";

const UPLOAD_ARTIFACT = /^actions\/upload-artifact@/i;
const TIMEOUT_REF = /^workflow:(.+)#jobs\.([^.]+)\.timeout-minutes$/;
const RETENTION_REF = /^workflow:(.+)#jobs\.([^.]+)\.steps\[(\d+)\]$/;

/** The job and step a finding actually measured. CD001 targets runs, not a job. */
export interface FindingTarget {
  readonly jobKey: string | null;
  readonly stepIndex: number | null;
}

/** What the operator asked the planner to write. */
export interface PlanRequest {
  readonly rule: PatchRule;
  readonly jobKey: string | null;
  readonly stepIndex: number | null;
  readonly minutes: number | null;
  readonly retentionDays: number;
}

function workflowPathOf(ref: string): string | null {
  const hash = ref.lastIndexOf("#");
  if (hash <= 0) return null;
  return ref.slice("workflow:".length, hash);
}

/** Read the measured target back out of the finding evidence references. */
export function findingTarget(finding: Finding): FindingTarget | null {
  for (const ref of finding.evidenceRefs) {
    if (!ref.startsWith("workflow:")) continue;
    if (workflowPathOf(ref) !== finding.workflowPath) continue;
    const timeout = TIMEOUT_REF.exec(ref);
    if (timeout !== null && timeout[2] !== undefined) return { jobKey: timeout[2], stepIndex: null };
    const retention = RETENTION_REF.exec(ref);
    if (retention !== null && retention[2] !== undefined && retention[3] !== undefined) {
      return { jobKey: retention[2], stepIndex: Number(retention[3]) };
    }
  }
  if (finding.ruleId === "CD001") return { jobKey: null, stepIndex: null };
  return null;
}

/** A candidate finding whose measured target equals the requested job and step. */
export function findFindingForRequest(
  findings: readonly Finding[],
  request: PlanRequest,
): Finding | null {
  for (const finding of findings) {
    if (finding.ruleId !== request.rule) continue;
    const target = findingTarget(finding);
    if (target === null) continue;
    if (target.jobKey !== request.jobKey) continue;
    if ((target.stepIndex ?? null) !== (request.stepIndex ?? null)) continue;
    return finding;
  }
  return null;
}

export interface TargetInput {
  readonly finding: Finding;
  readonly request: PlanRequest;
  readonly history: HistoryBundle | null;
  readonly workflowText: string;
  readonly workflow: WorkflowDefinition;
}

/**
 * Reasons the requested edit cannot be justified by this finding. An empty
 * list means the value came from the evidence the finding was built from.
 */
export function targetReasons(input: TargetInput): string[] {
  const reasons: string[] = [];
  const { finding, request } = input;
  if (finding.workflowHash !== sourceHashOf(input.workflowText)) reasons.push("WORKFLOW_HASH_MISMATCH");
  const target = findingTarget(finding);
  if (target === null) return ["TARGET_NOT_RECORDED", ...reasons];

  if (request.rule === "CD001") {
    if (request.jobKey !== null || request.stepIndex !== null) reasons.push("TARGET_NOT_APPLICABLE");
    return reasons;
  }

  if (target.jobKey !== request.jobKey) reasons.push("TARGET_NOT_ON_FINDING");

  if (request.rule === "CD005") {
    if (request.jobKey === null) return [...reasons, "TARGET_REQUIRED"];
    if (request.minutes === null) return [...reasons, "MINUTES_REQUIRED"];
    if (input.history === null) return [...reasons, "HISTORY_NOT_SYNCED"];
    const evidence = cd005Recommendations(input.history, finding.workflowPath, finding.workflowHash, request.jobKey);
    if (evidence.length === 0) return [...reasons, "EVIDENCE_NOT_FOUND"];
    if (!evidence.some((entry) => entry.recommendedMinutes === request.minutes)) reasons.push("MINUTES_NOT_FROM_EVIDENCE");
    return reasons;
  }

  if (request.stepIndex === null) return [...reasons, "TARGET_REQUIRED"];
  if (request.retentionDays !== PROPOSED_RETENTION_DAYS) return [...reasons, "RETENTION_NOT_FROM_EVIDENCE"];
  const job = input.workflow.jobs.find((candidate) => candidate.key === request.jobKey);
  const step = job?.steps[request.stepIndex];
  if (job === undefined || step === undefined) return [...reasons, "STEP_NOT_FOUND"];
  if (step.uses === null || !UPLOAD_ARTIFACT.test(step.uses)) reasons.push("STEP_NOT_UPLOAD_ARTIFACT");
  return reasons;
}