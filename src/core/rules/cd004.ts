import { digestOf } from "../../shared/cdj1.ts";
import { composeCoverage } from "../analysis/coverage.ts";
import { notApplicableSeconds } from "../savings/metrics.ts";
import { describeMatrix, expandMatrix, isAnalyzable } from "../workflow/index.ts";
import { RULE_VERSION } from "../version.ts";
import { buildFinding, ruleResult } from "./types.ts";
import type { DetectionRule, RuleContext, RuleEvaluation } from "./types.ts";

const RULE_ID = "CD004";

/**
 * Static combination count above which a matrix is worth a human review.
 *
 * A large matrix is not an error by itself; the threshold only keeps the
 * review list small. v0.1 never edits matrices, so this rule has no savings.
 */
export const MATRIX_REVIEW_MIN_COMBINATIONS = 6;

function evaluateCd004(context: RuleContext): RuleEvaluation {
  const composition = composeCoverage(context.coverage, RULE_ID);
  const inputHash = digestOf({
    ruleId: RULE_ID,
    workflows: context.workflows
      .filter(isAnalyzable)
      .map((workflow) => ({ path: workflow.path, sha256: workflow.sha256 }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  });

  if (composition.level === "skip") {
    return {
      results: [ruleResult({ ruleId: RULE_ID, ruleVersion: RULE_VERSION, inputHash, outcome: "skipped", reasons: composition.reasons })],
      findings: [],
      removals: [],
    };
  }

  const findings = [];
  for (const workflow of context.workflows) {
    if (!isAnalyzable(workflow)) continue;
    for (const job of workflow.jobs) {
      const matrix = job.matrix;
      if (!matrix) continue;

      let combinationCount: number | null = null;
      let reason = "";
      if (matrix.dynamic) {
        reason = "DYNAMIC_MATRIX";
      } else {
        const rows = expandMatrix(matrix);
        if (rows === null) {
          reason = "MATRIX_EXPANSION_LIMIT";
        } else {
          combinationCount = rows.length;
          if (combinationCount < MATRIX_REVIEW_MIN_COMBINATIONS) continue;
          reason = "STATIC_MATRIX_CANDIDATE";
        }
      }

      const countText = combinationCount === null ? "an unknown number of" : String(combinationCount);
      const shape = describeMatrix(matrix);
      findings.push(
        buildFinding({
          ruleId: RULE_ID,
          ruleVersion: RULE_VERSION,
          workflowPath: workflow.path,
          workflowHash: workflow.sha256,
          title: "Matrix on job \"" + job.key + "\" has " + countText + " static combinations",
          renderedText:
            "Job \"" +
            job.key +
            "\" expands to " +
            countText +
            " combinations" +
            (shape === "" ? "" : " (" + shape + ")") +
            ". Review whether every combination is needed. A large combination count is not an error by itself, and CI Diet does not edit matrices.",
          message: {
            titleKey: combinationCount === null ? "finding.CD004.title.unknown" : "finding.CD004.title.known",
            textKey:
              combinationCount === null
                ? "finding.CD004.text.unknown"
                : shape === ""
                  ? "finding.CD004.text.knownNoShape"
                  : "finding.CD004.text.known",
            params: {
              job: job.key,
              ...(combinationCount === null ? {} : { count: combinationCount }),
              ...(combinationCount === null || shape === "" ? {} : { shape }),
            },
          },
          evidenceLevel: "static",
          patchability: "review-only",
          evidenceRefs: ["workflow:" + workflow.path, "workflow:" + workflow.path + "#jobs." + job.key + ".strategy.matrix"],
          assumptions: [
            "Static include and exclude are applied; dynamic matrices are not expanded.",
            "A large combination count alone is not a defect.",
          ],
          blockers: ["MATRIX_EDIT_NOT_SUPPORTED"],
          standaloneRunnerSeconds: notApplicableSeconds("matrix edits are not implemented in v0.1"),
          identity: {
            workflowPath: workflow.path,
            jobKey: job.key,
            combinationCount,
            dynamic: matrix.dynamic,
            reason,
          },
        }),
      );
    }
  }

  const reasons = findings.length > 0 ? ["STATIC_MATRIX_CANDIDATE"] : ["NO_MATRIX_CANDIDATE"];
  return {
    results: [
      ruleResult({
        ruleId: RULE_ID,
        ruleVersion: RULE_VERSION,
        inputHash,
        outcome: findings.length > 0 ? "candidate" : "no_finding",
        reasons: [...composition.reasons, ...reasons],
        findings,
      }),
    ],
    findings,
    removals: [],
  };
}

export const cd004: DetectionRule = { id: RULE_ID, version: RULE_VERSION, evaluate: evaluateCd004 };
