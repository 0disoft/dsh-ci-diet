import { digestOf } from "../../shared/cdj1.ts";
import { composeCoverage } from "../analysis/coverage.ts";
import type { RuleId } from "../model/domain.ts";
import { RULE_VERSION } from "../version.ts";
import { ruleResult } from "./types.ts";
import type { RuleContext, RuleEvaluation } from "./types.ts";

/** Rules whose evidence is GitHub run history rather than workflow text. */
export const HISTORY_RULES: readonly RuleId[] = ["CD001", "CD002", "CD003", "CD005"];

function staticInputHash(context: RuleContext, ruleId: RuleId): string {
  return digestOf({
    ruleId,
    workflows: context.workflows
      .map((workflow) => ({ path: workflow.path, sha256: workflow.sha256 }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    historySynced: context.history !== undefined,
  });
}

/**
 * Placeholder results for history rules until the sync engine lands.
 *
 * A rule reports `skipped` with a reason instead of disappearing, so the
 * report always states why a rule produced nothing.
 */
export function evaluateHistoryRules(context: RuleContext): RuleEvaluation[] {
  return HISTORY_RULES.map((ruleId) => {
    const composition = composeCoverage(context.coverage, ruleId);
    const reasons =
      composition.level === "skip"
        ? [...composition.reasons]
        : context.history === undefined
          ? ["HISTORY_NOT_SYNCED"]
          : ["HISTORY_RULE_NOT_IMPLEMENTED"];
    return {
      results: [
        ruleResult({
          ruleId,
          ruleVersion: RULE_VERSION,
          inputHash: staticInputHash(context, ruleId),
          outcome: "skipped",
          reasons,
        }),
      ],
      findings: [],
      removals: [],
    };
  });
}
