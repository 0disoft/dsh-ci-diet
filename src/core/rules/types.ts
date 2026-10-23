import type { Config, Coverage, Dimension, Finding, Removal, RuleResult, SecondsMetric } from "../contracts/schema.ts";
import type { RuleId } from "../model/domain.ts";
import type { HistoryBundle } from "../history/model.ts";
import type { WorkflowDefinition } from "../workflow/index.ts";
import { findingFingerprint, findingIdFromFingerprint } from "../analysis/fingerprint.ts";

export interface RuleIdentity {
  readonly bindingId: string;
  readonly repositoryId: string;
  readonly repositoryFullName: string;
  readonly rootIdentityHash: string;
}

/** Evidence collected from GitHub run history; absent during a static scan. */
export type HistoryEvidence = HistoryBundle;

/** Dimensions of a coverage object keyed by axis name. */
export type CoverageAxes = Pick<Coverage, "history" | "workflowDefinitions" | "changedFiles" | "protectionRules" | "retentionPolicy">;

export function axisOf(coverage: Coverage, axis: keyof CoverageAxes): Dimension {
  return coverage[axis];
}

export interface RuleContext {
  readonly workspaceRoot?: string;
  readonly identity: RuleIdentity;
  readonly coverage: Coverage;
  readonly workflows: readonly WorkflowDefinition[];
  readonly generatedAt: string;
  readonly mode: "static" | "history";
  readonly config: Config;
  readonly history?: HistoryEvidence;
}

/** A removal proposed by a finding, attributed to the job it shortens. */
export interface RuleRemoval extends Removal {
  readonly jobId: string;
}

export interface RuleEvaluation {
  readonly results: readonly RuleResult[];
  readonly findings: readonly Finding[];
  readonly removals: readonly RuleRemoval[];
}

export interface DetectionRule {
  readonly id: RuleId;
  readonly version: string;
  evaluate(context: RuleContext): RuleEvaluation;
}

export interface FindingSpec {
  readonly ruleId: RuleId;
  readonly ruleVersion: string;
  readonly workflowPath: string;
  readonly workflowHash: string;
  readonly title: string;
  readonly renderedText: string;
  /** Display message keys; the stored English text stays canonical. */
  readonly message?: {
    readonly titleKey: string;
    readonly textKey: string;
    readonly params?: Readonly<Record<string, string | number>>;
  };
  readonly evidenceLevel: Finding["evidenceLevel"];
  readonly patchability: Finding["patchability"];
  readonly evidenceRefs: readonly string[];
  readonly assumptions: readonly string[];
  readonly blockers: readonly string[];
  readonly standaloneRunnerSeconds: SecondsMetric;
  readonly identity: unknown;
}

export function buildFinding(spec: FindingSpec): Finding {
  const fingerprint = findingFingerprint({
    ruleId: spec.ruleId,
    ruleVersion: spec.ruleVersion,
    workflowPath: spec.workflowPath,
    workflowHash: spec.workflowHash,
    identity: spec.identity,
  });
  return {
    findingId: findingIdFromFingerprint(fingerprint),
    fingerprint,
    ruleId: spec.ruleId,
    ruleVersion: spec.ruleVersion,
    title: spec.title,
    renderedText: spec.renderedText,
    ...(spec.message
      ? {
          message: {
            titleKey: spec.message.titleKey,
            textKey: spec.message.textKey,
            ...(spec.message.params ? { params: { ...spec.message.params } } : {}),
          },
        }
      : {}),
    workflowPath: spec.workflowPath,
    workflowHash: spec.workflowHash,
    evidenceLevel: spec.evidenceLevel,
    patchability: spec.patchability,
    evidenceRefs: [...spec.evidenceRefs],
    assumptions: [...spec.assumptions],
    blockers: [...spec.blockers],
    standaloneRunnerSeconds: spec.standaloneRunnerSeconds,
  };
}

export function ruleResult(input: {
  readonly ruleId: RuleId;
  readonly ruleVersion: string;
  readonly inputHash: string;
  readonly outcome: RuleResult["outcome"];
  readonly reasons: readonly string[];
  readonly findings?: readonly Finding[];
}): RuleResult {
  return {
    ruleId: input.ruleId,
    ruleVersion: input.ruleVersion,
    inputHash: input.inputHash,
    outcome: input.outcome,
    reasons: [...input.reasons],
    findingIds: (input.findings ?? []).map((finding) => finding.findingId),
  };
}


