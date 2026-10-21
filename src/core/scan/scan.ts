import { sha256Hex } from "../../shared/cdj1.ts";
import { buildCoverage } from "../analysis/coverage.ts";
import { assertValidDocument } from "../contracts/validate.ts";
import type { AnalysisReport, Coverage, RepositoryBinding } from "../contracts/schema.ts";
import { DEFAULT_CONFIG } from "../data/default-config.ts";
import { PRICING_SNAPSHOT } from "../data/index.ts";
import type { RuleId } from "../model/domain.ts";
import { evaluateRules } from "../rules/index.ts";
import type { RuleIdentity } from "../rules/index.ts";
import { computeReportMetrics } from "../savings/report-metrics.ts";
import { ENGINE_VERSION } from "../version.ts";
import { parseWorkflow } from "../workflow/index.ts";
import type { WorkflowDefinition } from "../workflow/index.ts";
import { createLocalBinding } from "./binding.ts";
import { discoverWorkflows } from "./discover.ts";
import type { SkippedWorkflow } from "./discover.ts";

export interface StaticScanOptions {
  readonly workspaceRoot: string;
  readonly generatedAt?: string;
  readonly enabledRules?: readonly RuleId[];
  readonly maxWorkflowBytes?: number;
}

export interface StaticScanResult {
  readonly binding: RepositoryBinding;
  readonly report: AnalysisReport;
  readonly workflows: readonly WorkflowDefinition[];
  readonly skipped: readonly SkippedWorkflow[];
  readonly warnings: readonly string[];
}

function reportIdFor(binding: RepositoryBinding, generatedAt: string, hashes: readonly string[]): string {
  const seed = [binding.bindingId, generatedAt, ...hashes].join("\n");
  return "r_" + sha256Hex(seed).slice(0, 24);
}

function coverageFor(
  generatedAt: string,
  expected: number,
  parsed: number,
  failures: readonly SkippedWorkflow[],
): Coverage {
  const failed = parsed < expected;
  return buildCoverage(
    {
      apiVersion: "none",
      ghVersion: "none",
      requestedFrom: generatedAt,
      requestedTo: generatedAt,
    },
    {
      history: {
        status: "unavailable",
        scope: "no run history requested",
        reasons: ["NETWORK_DISABLED"],
      },
      workflowDefinitions: {
        status: failed ? "partial" : "complete",
        scope: ".github/workflows (repository root)",
        fetched: parsed,
        expected,
        reasons: failed ? ["WORKFLOW_PARSE_FAILURES"] : [],
        missingScopes: [...failures].map((failure) => ({
          family: "definitions" as const,
          resource: failure.path,
          runId: null,
          attempt: null,
          path: failure.path,
          pullRequest: null,
          branch: null,
          from: null,
          to: null,
          reason: failure.reason,
          resumable: false,
        })),
      },
      changedFiles: { status: "unavailable", scope: "no pull requests requested", reasons: ["NETWORK_DISABLED"] },
      protectionRules: { status: "unavailable", scope: "no rules requested", reasons: ["NETWORK_DISABLED"] },
      retentionPolicy: { status: "unavailable", scope: "no artifacts requested", reasons: ["NETWORK_DISABLED"] },
    },
  );
}

/** Run the offline scan: workflow text only, no network, no writes. */
export function runStaticScan(options: StaticScanOptions): StaticScanResult {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const discovery = discoverWorkflows(options.workspaceRoot, { maxBytes: options.maxWorkflowBytes });
  const bindingResult = createLocalBinding(discovery.root, generatedAt);

  const workflows: WorkflowDefinition[] = [];
  const failures: SkippedWorkflow[] = [...discovery.skipped];
  for (const file of discovery.workflows) {
    const definition = parseWorkflow(file.path, file.text);
    workflows.push(definition);
    if (definition.parseError !== null) {
      failures.push({ path: file.path, reason: "WORKFLOW_PARSE_ERROR" });
    } else if (definition.unsupported.length > 0) {
      failures.push({ path: file.path, reason: "WORKFLOW_UNSUPPORTED" });
    }
  }
  const parsedCount = workflows.filter((workflow) => workflow.parseError === null && workflow.unsupported.length === 0).length;
  const coverage = coverageFor(generatedAt, discovery.workflows.length + discovery.skipped.length, parsedCount, failures);

  const identity: RuleIdentity = {
    bindingId: bindingResult.binding.bindingId,
    repositoryId: bindingResult.binding.repositoryId,
    repositoryFullName: bindingResult.binding.repositoryFullName,
    rootIdentityHash: bindingResult.binding.rootIdentityHash,
  };

  const ruleEvaluations = evaluateRules(
    {
      identity,
      coverage,
      workflows,
      generatedAt,
      mode: "static",
      config: DEFAULT_CONFIG,
    },
    options.enabledRules,
  );

  const findings = ruleEvaluations.flatMap((evaluation) => evaluation.findings);
  const ruleResults = ruleEvaluations.flatMap((evaluation) => evaluation.results);
  const { metrics } = computeReportMetrics([], { unavailableReason: "NO_HISTORY", billing: null });

  const inputHashes = workflows
    .map((workflow) => workflow.sha256)
    .sort();
  const sourceRefs = workflows
    .map((workflow) => "workflow:" + workflow.path + "@" + workflow.sha256)
    .sort();

  const report: AnalysisReport = {
    schemaVersion: 2,
    provenance: "observed",
    reportId: reportIdFor(bindingResult.binding, generatedAt, inputHashes),
    bindingId: bindingResult.binding.bindingId,
    engineVersion: ENGINE_VERSION,
    generatedAt,
    coverage,
    inputHashes,
    findings,
    ruleResults,
    normalizedInputs: { jobs: [], sourceRefs },
    metrics,
    parentReportId: null,
    pricingSnapshot: PRICING_SNAPSHOT,
  };

  assertValidDocument("AnalysisReport", report);
  return {
    binding: bindingResult.binding,
    report,
    workflows,
    skipped: failures,
    warnings: bindingResult.warnings,
  };
}
