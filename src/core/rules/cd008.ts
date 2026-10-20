import { digestOf } from "../../shared/cdj1.ts";
import type { Finding } from "../contracts/schema.ts";
import { composeCoverage } from "../analysis/coverage.ts";
import { notApplicableSeconds } from "../savings/metrics.ts";
import { isAnalyzable } from "../workflow/index.ts";
import { RULE_VERSION } from "../version.ts";
import { buildFinding, ruleResult } from "./types.ts";
import type { DetectionRule, RuleContext, RuleEvaluation } from "./types.ts";

const RULE_ID = "CD008";

const UPLOAD_ARTIFACT = /^actions\/upload-artifact@/i;

/** Proposal only; never applied without a confirmed effective maximum. */
export const PROPOSED_RETENTION_DAYS = 7;

type RetentionState =
  | { readonly kind: "absent" }
  | { readonly kind: "literal"; readonly days: number }
  | { readonly kind: "expression" }
  | { readonly kind: "other" };

function retentionState(entries: readonly { key: string; kind: string; literal: string | null }[]): RetentionState {
  const entry = entries.find((candidate) => candidate.key === "retention-days");
  if (!entry) return { kind: "absent" };
  if (entry.kind === "expression") return { kind: "expression" };
  if (entry.kind === "literal" && entry.literal !== null && /^[0-9]+$/.test(entry.literal)) {
    return { kind: "literal", days: Number.parseInt(entry.literal, 10) };
  }
  return { kind: "other" };
}

function evaluateCd008(context: RuleContext): RuleEvaluation {
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

  const maximumAllowedDays = context.history?.retention?.maximumAllowedDays ?? null;
  const findings: Finding[] = [];
  for (const workflow of context.workflows) {
    if (!isAnalyzable(workflow)) continue;
    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        if (step.uses === null || !UPLOAD_ARTIFACT.test(step.uses)) continue;
        const state = retentionState(step.withEntries);
        if (state.kind === "literal" && state.days <= PROPOSED_RETENTION_DAYS) continue;
        if (state.kind === "other") continue;

        const current =
          state.kind === "literal"
            ? state.days + " days"
            : state.kind === "expression"
              ? "an expression"
              : "the repository default (no retention-days input)";

        const blockers = ["ARTIFACT_PURPOSE_UNATTESTED"];
        if (maximumAllowedDays === null) blockers.push("EFFECTIVE_RETENTION_MAX_UNKNOWN");
        else if (maximumAllowedDays < PROPOSED_RETENTION_DAYS) blockers.push("RETENTION_MAX_BELOW_PROPOSAL");
        if (state.kind === "expression") blockers.push("EXPRESSION_RETENTION_REPORT_ONLY");
        const patchable = state.kind !== "expression" && (maximumAllowedDays === null || maximumAllowedDays >= PROPOSED_RETENTION_DAYS);

        findings.push(
          buildFinding({
            ruleId: RULE_ID,
            ruleVersion: RULE_VERSION,
            workflowPath: workflow.path,
            workflowHash: workflow.sha256,
            title: "Upload step in job \"" + job.key + "\" keeps artifacts for " + current,
            renderedText:
              "Step \"" +
              (step.name ?? "step " + (step.index + 1)) +
              "\" in job \"" +
              job.key +
              "\" uploads an artifact and keeps it for " +
              current +
              ". A 7-day retention is a proposal, not a default; it applies only below the confirmed repository maximum and above the consumer minimum. Current artifacts are never deleted.",
            evidenceLevel: "static",
            patchability: patchable ? "review-only" : "blocked",
            evidenceRefs: [
              "workflow:" + workflow.path,
              "workflow:" + workflow.path + "#jobs." + job.key + ".steps[" + step.index + "]",
            ],
            assumptions: [
              "Retention 0 means the repository default, not zero days.",
              "Only future uploads change; existing artifacts are untouched.",
              "The action version is never changed.",
            ],
            blockers,
            standaloneRunnerSeconds: notApplicableSeconds("retention affects storage, not runner time"),
            identity: {
              workflowPath: workflow.path,
              jobKey: job.key,
              stepIndex: step.index,
              action: step.uses,
              retention: state.kind === "literal" ? state.days : state.kind,
            },
          }),
        );
      }
    }
  }

  const reasons = findings.length > 0 ? ["STATIC_RETENTION_CANDIDATE"] : ["NO_RETENTION_CANDIDATE"];
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

export const cd008: DetectionRule = { id: RULE_ID, version: RULE_VERSION, evaluate: evaluateCd008 };
