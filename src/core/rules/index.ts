import { RULE_IDS } from "../model/domain.ts";
import type { RuleId } from "../model/domain.ts";
import { cd004 } from "./cd004.ts";
import { cd008 } from "./cd008.ts";
import { evaluateHistoryRules } from "./skipped.ts";
import type { DetectionRule, RuleContext, RuleEvaluation } from "./types.ts";

/**
 * Rules enabled by default.
 *
 * ADR-13 keeps CD005 off until job keys resolve and CD003 off until its
 * sample is widened. CD004 needs no history and has no write path, so it
 * stays on as a review-only candidate.
 */
export const DEFAULT_ENABLED_RULES: readonly RuleId[] = ["CD001", "CD002", "CD004", "CD008"];

/** Static rules implemented in this module. History rules come from sync. */
export const STATIC_RULES: readonly DetectionRule[] = [cd004, cd008];

export function evaluateRules(context: RuleContext, enabledRules: readonly RuleId[] = DEFAULT_ENABLED_RULES): RuleEvaluation[] {
  const enabled = new Set(enabledRules);
  const evaluations = [];
  if (enabled.has("CD004")) evaluations.push(cd004.evaluate(context));
  if (enabled.has("CD008")) evaluations.push(cd008.evaluate(context));
  for (const evaluation of evaluateHistoryRules(context)) {
    const ruleId = evaluation.results[0]?.ruleId;
    if (ruleId === undefined || enabled.has(ruleId)) evaluations.push(evaluation);
  }
  const order = new Map<RuleId, number>(RULE_IDS.map((ruleId, index) => [ruleId, index]));
  evaluations.sort((a, b) => {
    const left = order.get(a.results[0]?.ruleId as RuleId) ?? Number.MAX_SAFE_INTEGER;
    const right = order.get(b.results[0]?.ruleId as RuleId) ?? Number.MAX_SAFE_INTEGER;
    return left - right;
  });
  return evaluations;
}

export { cd004 } from "./cd004.ts";
export { cd008, PROPOSED_RETENTION_DAYS } from "./cd008.ts";
export { MATRIX_REVIEW_MIN_COMBINATIONS } from "./cd004.ts";
export { HISTORY_RULES } from "./skipped.ts";
export { buildFinding, ruleResult } from "./types.ts";
export type { DetectionRule, FindingSpec, RuleContext, RuleEvaluation, RuleIdentity, RuleRemoval } from "./types.ts";
