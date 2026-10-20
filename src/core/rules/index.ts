import { RULE_IDS } from "../model/domain.ts";
import type { RuleId } from "../model/domain.ts";
import { cd001 } from "./cd001.ts";
import { cd002 } from "./cd002.ts";
import { cd003 } from "./cd003.ts";
import { cd004 } from "./cd004.ts";
import { cd005 } from "./cd005.ts";
import { cd008 } from "./cd008.ts";
import type { DetectionRule, RuleContext, RuleEvaluation } from "./types.ts";

/**
 * Rules enabled by default.
 *
 * ADR-13 keeps CD005 off until job keys resolve and CD003 off until its
 * sample is widened. CD004 needs no history and has no write path, so it
 * stays on as a review-only candidate.
 */
export const DEFAULT_ENABLED_RULES: readonly RuleId[] = ["CD001", "CD002", "CD004", "CD008"];

/** Rules whose evidence is GitHub run history rather than workflow text. */
export const HISTORY_RULES: readonly RuleId[] = ["CD001", "CD002", "CD003", "CD005"];

/** Every implemented rule, keyed by its contract id. */
export const RULES: readonly DetectionRule[] = [cd001, cd002, cd003, cd004, cd005, cd008];

export function evaluateRules(context: RuleContext, enabledRules: readonly RuleId[] = DEFAULT_ENABLED_RULES): RuleEvaluation[] {
  const enabled = new Set(enabledRules);
  const order = new Map<RuleId, number>(RULE_IDS.map((ruleId, index) => [ruleId, index]));
  const evaluations: RuleEvaluation[] = [];
  for (const rule of RULES) {
    if (!enabled.has(rule.id)) continue;
    evaluations.push(rule.evaluate(context));
  }
  evaluations.sort((a, b) => {
    const left = order.get(a.results[0]?.ruleId as RuleId) ?? Number.MAX_SAFE_INTEGER;
    const right = order.get(b.results[0]?.ruleId as RuleId) ?? Number.MAX_SAFE_INTEGER;
    return left - right;
  });
  return evaluations;
}

export { cd001, CD001_LAGS_SECONDS } from "./cd001.ts";
export { cd002 } from "./cd002.ts";
export { cd003, CD003_HEAVY_SECONDS } from "./cd003.ts";
export { cd004, MATRIX_REVIEW_MIN_COMBINATIONS } from "./cd004.ts";
export { cd005, CD005_CANDIDATE_COHORT, CD005_MIN_COHORT } from "./cd005.ts";
export { cd008, PROPOSED_RETENTION_DAYS } from "./cd008.ts";
export { buildFinding, ruleResult } from "./types.ts";
export type { DetectionRule, FindingSpec, RuleContext, RuleEvaluation, RuleIdentity, RuleRemoval } from "./types.ts";
