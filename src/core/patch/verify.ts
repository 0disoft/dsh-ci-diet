import { digestOf, sha256Hex } from "../../shared/cdj1.ts";
import type { Attestation, PatchPlan } from "../contracts/schema.ts";

export type ApplyReasonCode =
  | "PLAN_EXPIRED"
  | "ATTESTATION_MISSING"
  | "ATTESTATION_EXPIRED"
  | "ATTESTATION_REVOKED"
  | "ATTESTATION_HASH_MISMATCH"
  | "ATTESTATION_SCOPE_INSUFFICIENT"
  | "DEPENDENCY_HASH_MISMATCH"
  | "BLOCKERS_PRESENT"
  | "COVERAGE_INSUFFICIENT_FOR_WRITE"
  | "SOURCE_HASH_MISMATCH"
  | "NONCE_INVALID"
  | "POLICY_STALE"
  | "BACKUP_UNAVAILABLE";

export const POLICY_MAX_AGE_MS = 600_000;

export interface ApplyCheckInput {
  readonly plan: PatchPlan;
  readonly now: Date;
  readonly currentText: string;
  readonly currentDependencyHash: string;
  readonly coverageWriteAllowed: boolean;
  readonly nonceValid: boolean;
  readonly backupAvailable: boolean;
}

function isoMillis(value: string): number {
  return Date.parse(value);
}

function scopeCovers(attestation: Attestation, plan: PatchPlan): boolean {
  if (attestation.bindingId !== plan.payload.bindingId) return false;
  if (attestation.workflowPath !== plan.payload.workflowPath) return false;
  for (const edit of plan.payload.edits) {
    if (edit.ruleId === "CD001") {
      if (attestation.scope !== "workflow") return false;
      continue;
    }
    if (attestation.scope === "workflow") return false;
    const jobKey = /^jobs\.([^.]+)\./.exec(edit.semanticPath)?.[1];
    if (jobKey === undefined || attestation.jobKey !== jobKey) return false;
    if (edit.ruleId === "CD008") {
      const stepIndex = /^jobs\.[^.]+\.steps\[(\d+)\]/.exec(edit.semanticPath)?.[1];
      if (stepIndex === undefined) return false;
      const expectedStepKey = "steps[" + stepIndex + "]";
      if (attestation.scope === "step" && attestation.stepKey !== expectedStepKey) return false;
    }
  }
  return true;
}

/** Return the closed list of failed apply invariants, in contract order. */
export function checkApply(input: ApplyCheckInput): ApplyReasonCode[] {
  const reasons: ApplyReasonCode[] = [];
  const now = input.now.getTime();
  const payload = input.plan.payload;
  if (now > isoMillis(payload.expiresAt)) reasons.push("PLAN_EXPIRED");

  const attestations = payload.attestations;
  if (attestations.length === 0) {
    reasons.push("ATTESTATION_MISSING");
  } else {
    let covered = 0;
    let sawExpired = false;
    let sawRevoked = false;
    let sawMismatch = false;
    for (const attestation of attestations) {
      if (attestation.revokedAt !== null) {
        sawRevoked = true;
        continue;
      }
      if (now > isoMillis(attestation.expiresAt)) {
        sawExpired = true;
        continue;
      }
      if (attestation.workflowHash !== payload.sourceHash || attestation.dependencyHash !== payload.dependencyHash) {
        sawMismatch = true;
        continue;
      }
      if (!scopeCovers(attestation, input.plan)) continue;
      covered += 1;
    }
    if (covered === 0) {
      if (sawMismatch) reasons.push("ATTESTATION_HASH_MISMATCH");
      else if (sawRevoked) reasons.push("ATTESTATION_REVOKED");
      else if (sawExpired) reasons.push("ATTESTATION_EXPIRED");
      else if (attestations.some((attestation) => attestation.bindingId === payload.bindingId)) reasons.push("ATTESTATION_SCOPE_INSUFFICIENT");
      else reasons.push("ATTESTATION_MISSING");
    }
  }

  if (digestOf({ dependencies: payload.dependencies }) !== input.currentDependencyHash) reasons.push("DEPENDENCY_HASH_MISMATCH");
  if (payload.blockers.length > 0) reasons.push("BLOCKERS_PRESENT");
  if (!input.coverageWriteAllowed) reasons.push("COVERAGE_INSUFFICIENT_FOR_WRITE");
  const currentHash = "sha256:" + sha256Hex(input.currentText);
  if (currentHash !== payload.sourceHash) reasons.push("SOURCE_HASH_MISMATCH");
  if (!input.nonceValid) reasons.push("NONCE_INVALID");
  if (now > Math.max(...payload.policies.map((policy) => isoMillis(policy.observedAt))) + POLICY_MAX_AGE_MS) reasons.push("POLICY_STALE");
  if (!input.backupAvailable) reasons.push("BACKUP_UNAVAILABLE");
  return reasons;
}
