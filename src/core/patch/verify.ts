import { digestOf, sha256Hex } from "../../shared/cdj1.ts";
import type { Attestation, PatchPlan, PolicySnapshot } from "../contracts/schema.ts";
import { attestationSatisfiesRule, isPatchRule } from "./eligibility.ts";
import { isExpired, isStale } from "../support/clock.ts";
import type { PatchRule } from "./eligibility.ts";
import { POLICY_MAX_AGE_MS } from "../policy/constants.ts";

export { POLICY_MAX_AGE_MS } from "../policy/constants.ts";

export type ApplyReasonCode =
  | "PLAN_DIGEST_MISMATCH"
  | "SYNTHETIC_PLAN"
  | "PLAN_EXPIRED"
  | "ATTESTATION_MISSING"
  | "ATTESTATION_EXPIRED"
  | "ATTESTATION_REVOKED"
  | "ATTESTATION_HASH_MISMATCH"
  | "ATTESTATION_SCOPE_INSUFFICIENT"
  | "ATTESTATION_CLAIMS_INSUFFICIENT"
  | "EDIT_OUT_OF_SCOPE"
  | "DEPENDENCY_HASH_MISMATCH"
  | "BLOCKERS_PRESENT"
  | "RULE_NOT_ALLOWED"
  | "COVERAGE_INSUFFICIENT_FOR_WRITE"
  | "SOURCE_HASH_MISMATCH"
  | "NONCE_INVALID"
  | "POLICY_STALE"
  | "BACKUP_UNAVAILABLE";

export interface ApplyCheckInput {
  readonly plan: PatchPlan;
  readonly now: Date;
  readonly currentText: string;
  readonly currentDependencyHash: string;
  readonly coverageWriteAllowed: boolean;
  readonly nonceValid: boolean;
  readonly backupAvailable: boolean;
  /** Attestations re-read from the store, so a revocation after approval is visible. */
  readonly attestations?: readonly Attestation[];
  /** Policy snapshots rebuilt from the current history cache. */
  readonly currentPolicies?: readonly PolicySnapshot[];
  /** Overrides the shared policy freshness bound; defaults to 600 000 ms. */
  readonly policyMaxAgeMs?: number;
}

type PolicyKind = PolicySnapshot["kind"];

/** Policy kinds a plan must carry for the rules it edits. */
export function requiredPolicyKinds(ruleIds: readonly string[]): PolicyKind[] {
  const kinds = new Set<PolicyKind>();
  for (const ruleId of ruleIds) {
    if (ruleId === "CD001") kinds.add("protection");
    if (ruleId === "CD008") kinds.add("retention");
  }
  return [...kinds].sort();
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
    if (edit.ruleId === "CD008" || edit.ruleId === "CD006") {
      const stepIndex = /^jobs\.[^.]+\.steps\[(\d+)\]/.exec(edit.semanticPath)?.[1];
      if (stepIndex === undefined) return false;
      const expectedStepKey = "steps[" + stepIndex + "]";
      if (attestation.scope === "step" && attestation.stepKey !== expectedStepKey) return false;
    }
  }
  return true;
}

function validAttestations(input: ApplyCheckInput): { readonly valid: Attestation[]; readonly reasons: ApplyReasonCode[] } {
  const reasons: ApplyReasonCode[] = [];
  const payload = input.plan.payload;
  const now = input.now.getTime();
  const attestations = input.attestations ?? payload.attestations;
  if (attestations.length === 0) return { valid: [], reasons: ["ATTESTATION_MISSING"] };
  const valid: Attestation[] = [];
  let sawExpired = false;
  let sawRevoked = false;
  let sawMismatch = false;
  for (const attestation of attestations) {
    if (attestation.revokedAt !== null) {
      sawRevoked = true;
      continue;
    }
    if (isExpired(now, isoMillis(attestation.expiresAt))) {
      sawExpired = true;
      continue;
    }
    if (attestation.workflowHash !== payload.sourceHash || attestation.dependencyHash !== payload.dependencyHash) {
      sawMismatch = true;
      continue;
    }
    if (!scopeCovers(attestation, input.plan)) continue;
    valid.push(attestation);
  }
  if (valid.length === 0) {
    if (sawMismatch) reasons.push("ATTESTATION_HASH_MISMATCH");
    else if (sawRevoked) reasons.push("ATTESTATION_REVOKED");
    else if (sawExpired) reasons.push("ATTESTATION_EXPIRED");
    else if (attestations.some((attestation) => attestation.bindingId === payload.bindingId)) reasons.push("ATTESTATION_SCOPE_INSUFFICIENT");
    else reasons.push("ATTESTATION_MISSING");
  }
  return { valid, reasons };
}

/** Return the closed list of failed apply invariants, in contract order. */
export function checkApply(input: ApplyCheckInput): ApplyReasonCode[] {
  const reasons: ApplyReasonCode[] = [];
  const now = input.now.getTime();
  const payload = input.plan.payload;

  if (digestOf(payload) !== input.plan.planDigest) reasons.push("PLAN_DIGEST_MISMATCH");
  if (input.plan.provenance !== "observed") reasons.push("SYNTHETIC_PLAN");
  if (isExpired(now, isoMillis(payload.expiresAt))) reasons.push("PLAN_EXPIRED");

  const attestationCheck = validAttestations(input);
  reasons.push(...attestationCheck.reasons);
  if (attestationCheck.valid.length > 0) {
    for (const edit of payload.edits) {
      if (!isPatchRule(edit.ruleId)) continue;
      const rule: PatchRule = edit.ruleId;
      if (!attestationCheck.valid.some((attestation) => attestationSatisfiesRule(rule, attestation.claims))) {
        reasons.push("ATTESTATION_CLAIMS_INSUFFICIENT");
        break;
      }
    }
  }

  if (digestOf({ dependencies: payload.dependencies }) !== input.currentDependencyHash) reasons.push("DEPENDENCY_HASH_MISMATCH");
  if (payload.blockers.length > 0) reasons.push("BLOCKERS_PRESENT");
  if (!input.coverageWriteAllowed) reasons.push("COVERAGE_INSUFFICIENT_FOR_WRITE");
  const currentHash = "sha256:" + sha256Hex(input.currentText);
  if (currentHash !== payload.sourceHash) reasons.push("SOURCE_HASH_MISMATCH");
  if (!input.nonceValid) reasons.push("NONCE_INVALID");

  for (const kind of requiredPolicyKinds(payload.ruleIds)) {
    const planPolicy = payload.policies.find((policy) => policy.kind === kind);
    if (planPolicy === undefined || planPolicy.status !== "known" || isStale(now, isoMillis(planPolicy.observedAt), input.policyMaxAgeMs ?? POLICY_MAX_AGE_MS)) {
      reasons.push("POLICY_STALE");
      continue;
    }
    if (input.currentPolicies !== undefined) {
      const current = input.currentPolicies.find((policy) => policy.kind === kind);
      if (current === undefined || current.status !== "known" || current.policyHash !== planPolicy.policyHash
        || isStale(now, isoMillis(current.observedAt), input.policyMaxAgeMs ?? POLICY_MAX_AGE_MS)) {
        reasons.push("POLICY_STALE");
      }
    }
  }

  if (!input.backupAvailable) reasons.push("BACKUP_UNAVAILABLE");
  return [...new Set(reasons)];
}
