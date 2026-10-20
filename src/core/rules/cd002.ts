import { composeCoverage } from "../analysis/coverage.ts";
import { notApplicableSeconds } from "../savings/metrics.ts";
import { isAnalyzable } from "../workflow/index.ts";
import { RULE_VERSION } from "../version.ts";
import { buildFinding, ruleResult } from "./types.ts";
import type { DetectionRule, RuleContext, RuleEvaluation } from "./types.ts";
import { historyInputHash } from "./history-utils.ts";

const RULE_ID = "CD002";

function evaluateCd002(context: RuleContext): RuleEvaluation {
  const inputHash = historyInputHash(context, RULE_ID);
  if (context.history === undefined || context.mode !== "history") {
    return skipped(inputHash, ["HISTORY_NOT_SYNCED"]);
  }
  const composition = composeCoverage(context.coverage, RULE_ID);
  if (composition.level === "skip") return skipped(inputHash, composition.reasons);

  const findings = [];
  for (const workflow of context.workflows) {
    if (!isAnalyzable(workflow)) continue;
    const triggers = new Set(workflow.triggers);
    if (!triggers.has("push") || !triggers.has("pull_request")) continue;
    findings.push(
      buildFinding({
        ruleId: RULE_ID,
        ruleVersion: RULE_VERSION,
        workflowPath: workflow.path,
        workflowHash: workflow.sha256,
        title: "Workflow " + workflow.path + " runs on both push and pull_request",
        renderedText:
          "Workflow " + workflow.path + " is triggered by both push and pull_request. That is not waste by itself: " +
          "runs are equivalent only when the event, verified tree, permissions, inputs, job definitions, and checkout ref match. " +
          "CI Diet shows the two trigger clusters on a time axis and does not offer a trigger removal or a combined savings scenario in v0.1.",
        message: {
          titleKey: "finding.CD002.title",
          textKey: "finding.CD002.text",
          params: { workflow: workflow.path },
        },
        evidenceLevel: "inferred",
        patchability: "review-only",
        evidenceRefs: ["workflow:" + workflow.path],
        assumptions: [
          "A shared trigger is a hypothesis, not a proven duplicate.",
          "Run equivalence needs the verified tree and permissions, which are not compared in v0.1.",
        ],
        blockers: ["TRIGGER_REMOVAL_NOT_SUPPORTED", "RUN_EQUIVALENCE_UNVERIFIED"],
        standaloneRunnerSeconds: notApplicableSeconds("no combined savings scenario in v0.1"),
        identity: { workflowPath: workflow.path, triggers: [...workflow.triggers].sort() },
      }),
    );
  }

  return {
    results: [
      ruleResult({
        ruleId: RULE_ID,
        ruleVersion: RULE_VERSION,
        inputHash,
        outcome: findings.length > 0 ? "candidate" : "no_finding",
        reasons: [...composition.reasons, ...(findings.length > 0 ? ["DUPLICATE_TRIGGER_CANDIDATE"] : ["NO_DUPLICATE_TRIGGER"])],
        findings,
      }),
    ],
    findings,
    removals: [],
  };
}

function skipped(inputHash: string, reasons: readonly string[]): RuleEvaluation {
  return {
    results: [ruleResult({ ruleId: RULE_ID, ruleVersion: RULE_VERSION, inputHash, outcome: "skipped", reasons })],
    findings: [],
    removals: [],
  };
}

export const cd002: DetectionRule = { id: RULE_ID, version: RULE_VERSION, evaluate: evaluateCd002 };
