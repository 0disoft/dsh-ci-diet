import type { Attestation, Coverage, Finding } from "../contracts/schema.ts";
import type { CoverageLevel } from "../model/domain.ts";
import type { HistoryBundle } from "../history/model.ts";
import { composeCoverage } from "../analysis/coverage.ts";
import { CONSUMER_MIN_DAYS_MAX, CONSUMER_MIN_DAYS_MIN, POLICY_MAX_AGE_SECONDS, PROPOSED_RETENTION_DAYS } from "../policy/constants.ts";
import { isStale } from "../support/clock.ts";

export { POLICY_MAX_AGE_SECONDS } from "../policy/constants.ts";

/** Rules whose findings can ever produce a patch plan in v0.1. */
export const PATCH_RULES = ["CD001", "CD005", "CD006", "CD008"] as const;
export type PatchRule = (typeof PATCH_RULES)[number];

export function isPatchRule(value: string): value is PatchRule {
  return (PATCH_RULES as readonly string[]).includes(value);
}

type Claims = Attestation["claims"];

export interface PatchEligibilityInput {
  readonly rule: PatchRule;
  readonly finding: Finding | null;
  readonly coverage: Coverage;
  readonly claims: Claims;
  readonly history: HistoryBundle | null;
  readonly currentDefinitionParsed: boolean;
  readonly editedJobEvidenceComplete: boolean;
  readonly now: Date;
  /** Overrides the shared policy freshness bound; defaults to 600 s. */
  readonly policyMaxAgeSeconds?: number;
}

export interface PatchEligibility {
  readonly allowed: boolean;
  readonly reasons: readonly string[];
  readonly remainingBlockers: readonly string[];
  readonly coverageLevel: CoverageLevel;
}

const CLAIM_LIFTS: Record<PatchRule, Readonly<Record<string, "ci-only" | "replace-safe">>> = {
  CD001: {
    // A trigger list is a fact about the workflow, not something an attestation
    // can repair: patch-model.md requires `on` to be exactly pull_request.
    PROTECTION_RULES_UNAVAILABLE: "replace-safe",
    REQUIRED_CHECK_OWNERSHIP_UNKNOWN: "replace-safe",
  },
  CD005: {},
  CD006: {},
  CD008: {},
};

function retentionMaxDays(history: HistoryBundle | null): number | null {
  if (history === null) return null;
  return history.retention === null ? null : history.retention.maximumAllowedDays;
}

function policyFresh(fetchedAt: string | null, now: Date, maxAgeSeconds = POLICY_MAX_AGE_SECONDS): boolean {
  if (fetchedAt === null) return false;
  const at = Date.parse(fetchedAt);
  if (!Number.isFinite(at)) return false;
  // Same absolute-age boundary as verify.ts: exactly the max age is fresh.
  return !isStale(now.getTime(), at, maxAgeSeconds * 1000);
}

/**
 * Re-check the rule-specific preconditions at plan creation time.
 *
 * Findings are a snapshot of a scan. A plan changes files, so the patch path
 * must not trust the snapshot alone: it re-composes coverage for the rule,
 * verifies that every blocker that prevents an edit is either gone or
 * explicitly attested by a human, and checks the policy snapshot the rule
 * depends on is still fresh.
 */
export function evaluatePatchEligibility(input: PatchEligibilityInput): PatchEligibility {
  const reasons: string[] = [];
  const composition = composeCoverage(input.coverage, input.rule, {
    currentDefinitionParsed: input.currentDefinitionParsed,
    editedJobEvidenceComplete: input.editedJobEvidenceComplete,
  });
  const finding = input.finding;
  if (finding === null) {
    return { allowed: false, reasons: ["FINDING_NOT_FOUND"], remainingBlockers: [], coverageLevel: composition.level };
  }

  if (finding.patchability === "blocked") reasons.push("FINDING_BLOCKED");

  const remaining: string[] = [];
  const lifts = CLAIM_LIFTS[input.rule];
  for (const blocker of finding.blockers) {
    if (blocker === "EFFECTIVE_RETENTION_MAX_UNKNOWN") {
      const max = retentionMaxDays(input.history);
      if (max === null) remaining.push(blocker);
      else if (max < PROPOSED_RETENTION_DAYS) reasons.push("RETENTION_MAX_BELOW_PROPOSAL");
      continue;
    }
    const lift = lifts[blocker];
    if (lift === "ci-only" && input.claims.ciOnly) continue;
    if (lift === "replace-safe" && input.claims.replaceSafe) continue;
    // rules.md:189 allows retention edits only for a temporary artifact, so a
    // release upload never clears this blocker.
    if (blocker === "ARTIFACT_PURPOSE_UNATTESTED" && input.claims.artifactPurpose === "temporary") continue;
    remaining.push(blocker);
  }
  for (const blocker of remaining) reasons.push(blocker);

  if (input.rule === "CD001") {
    if (!input.claims.ciOnly) reasons.push("CLAIM_CI_ONLY_MISSING");
    if (!input.claims.replaceSafe) reasons.push("CLAIM_REPLACE_SAFE_MISSING");
    if (!policyFresh(input.history?.protection?.fetchedAt ?? null, input.now, input.policyMaxAgeSeconds)) reasons.push("POLICY_STALE");
  } else if (input.rule === "CD008") {
    if (input.claims.artifactPurpose === "unknown") reasons.push("CLAIM_ARTIFACT_PURPOSE_UNKNOWN");
    else if (input.claims.artifactPurpose !== "temporary") reasons.push("CLAIM_ARTIFACT_PURPOSE_NOT_TEMPORARY");
    const consumerDays = input.claims.consumerMinDays;
    if (consumerDays === null || !Number.isSafeInteger(consumerDays) || consumerDays < CONSUMER_MIN_DAYS_MIN || consumerDays > CONSUMER_MIN_DAYS_MAX) {
      reasons.push("CLAIM_CONSUMER_DAYS_INVALID");
    }
    if (!policyFresh(input.history?.retention?.fetchedAt ?? null, input.now, input.policyMaxAgeSeconds)) reasons.push("POLICY_STALE");
    if (retentionMaxDays(input.history) === null) reasons.push("RETENTION_MAX_UNKNOWN");
    else if ((retentionMaxDays(input.history) ?? 0) < PROPOSED_RETENTION_DAYS) reasons.push("RETENTION_MAX_BELOW_PROPOSAL");
  }

  if (!composition.writeAllowed) {
    reasons.push("COVERAGE_" + composition.level.toUpperCase());
    for (const reason of composition.reasons) reasons.push(reason);
  }

  return {
    allowed: reasons.length === 0,
    reasons: [...new Set(reasons)].sort(),
    remainingBlockers: [...new Set(remaining)].sort(),
    coverageLevel: composition.level,
  };
}

/** Parse the claim vocabulary shared by --claims and the DSH plan tool. */
export function claimsFromTokens(tokens: readonly string[]): Attestation["claims"] {
  const set = new Set(tokens);
  const artifactPurpose = set.has("artifact-purpose:release")
    ? "release"
    : set.has("artifact-purpose:temporary")
      ? "temporary"
      : "unknown";
  const days = Number((tokens.find((token) => token.startsWith("consumer-min-days:")) ?? "consumer-min-days:0").split(":")[1]);
  return {
    ciOnly: set.has("ci-only"),
    replaceSafe: set.has("replace-safe"),
    artifactPurpose,
    consumerMinDays: Number.isSafeInteger(days) ? days : 0,
    reviewedOpaqueNodes: set.has("reviewed-opaque-nodes") ? ["workflow"] : [],
  };
}

/** Apply-side re-check: the same claim requirements, against a stored attestation. */
export function attestationSatisfiesRule(rule: PatchRule, claims: Claims): boolean {
  if (rule === "CD001") return claims.ciOnly && claims.replaceSafe;
  if (rule === "CD008") {
    const days = claims.consumerMinDays;
    return claims.artifactPurpose === "temporary"
      && days !== null
      && Number.isSafeInteger(days)
      && days >= CONSUMER_MIN_DAYS_MIN
      && days <= CONSUMER_MIN_DAYS_MAX;
  }
  return true;
}
