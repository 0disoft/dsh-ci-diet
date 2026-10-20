/** Build an observed report from GitHub run history and the local workflows. */
import { digestOf, sha256Hex } from "../../shared/cdj1.ts";
import { buildCoverage } from "./coverage.ts";
import { assertValidDocument } from "../contracts/validate.ts";
import type { AnalysisReport, Config, JobInput, RepositoryBinding, RuleResult } from "../contracts/schema.ts";
import { PRICING_SNAPSHOT } from "../data/index.ts";
import type { HistoryBundle } from "../history/model.ts";
import type { RuleId } from "../model/domain.ts";
import { evaluateRules } from "../rules/index.ts";
import type { RuleEvaluation, RuleIdentity, RuleRemoval } from "../rules/index.ts";
import { computeReportMetrics } from "../savings/report-metrics.ts";
import { knownString, unknownString } from "../savings/metrics.ts";
import { ENGINE_VERSION } from "../version.ts";
import type { WorkflowDefinition } from "../workflow/index.ts";

export interface HistoryReportInput {
  readonly binding: RepositoryBinding;
  readonly workflows: readonly WorkflowDefinition[];
  readonly history: HistoryBundle;
  readonly config: Config;
  readonly generatedAt: string;
  readonly enabledRules?: readonly RuleId[];
}

export interface HistoryReportResult {
  readonly report: AnalysisReport;
  readonly evaluations: readonly RuleEvaluation[];
}

function reportIdFor(bindingId: string, generatedAt: string, hashes: readonly string[]): string {
  return "r_" + sha256Hex([bindingId, generatedAt, ...hashes].join("\n")).slice(0, 24);
}

function jobsFrom(history: HistoryBundle, removals: readonly RuleRemoval[]): JobInput[] {
  const byId = new Map<string, { durationMillis: number; attempt: number; sku: string | null }>();
  for (const run of history.runs) {
    for (const job of run.jobs) {
      if (job.durationMillis === null || job.durationMillis < 0) continue;
      const existing = byId.get(job.jobId);
      if (existing !== undefined && existing.durationMillis >= job.durationMillis) continue;
      byId.set(job.jobId, { durationMillis: job.durationMillis, attempt: job.attempt, sku: job.sku });
    }
  }
  const removalsByJob = new Map<string, RuleRemoval[]>();
  for (const removal of removals) {
    const bucket = removalsByJob.get(removal.jobId);
    if (bucket === undefined) removalsByJob.set(removal.jobId, [removal]);
    else bucket.push(removal);
  }
  const jobs: JobInput[] = [];
  for (const [jobId, record] of byId) {
    jobs.push({
      jobId,
      durationMillis: record.durationMillis,
      sku: record.sku === null ? unknownString("runner labels did not resolve to a SKU", "UNKNOWN_SKU") : knownString(record.sku, "runner label to SKU candidate"),
      removals: (removalsByJob.get(jobId) ?? []).map((removal) => ({
        findingId: removal.findingId,
        startMillis: removal.startMillis,
        endMillis: removal.endMillis,
      })),
    });
  }
  jobs.sort((a, b) => (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0));
  return jobs;
}

/** Compose the observed report shared by the CLI and the DSH tools. */
export function buildHistoryReport(input: HistoryReportInput): HistoryReportResult {
  const coverage = buildCoverage(
    {
      apiVersion: input.history.apiVersion ?? "unknown",
      ghVersion: input.history.ghVersion ?? "unknown",
      requestedFrom: input.history.requestedFrom,
      requestedTo: input.history.requestedTo,
    },
    input.history.coverage,
  );
  const identity: RuleIdentity = {
    bindingId: input.binding.bindingId,
    repositoryId: input.binding.repositoryId,
    repositoryFullName: input.binding.repositoryFullName,
    rootIdentityHash: input.binding.rootIdentityHash,
  };
  const evaluations = evaluateRules(
    {
      identity,
      coverage,
      workflows: input.workflows,
      generatedAt: input.generatedAt,
      mode: "history",
      config: input.config,
      history: input.history,
    },
    input.enabledRules,
  );
  const findings = evaluations.flatMap((evaluation) => evaluation.findings);
  const ruleResults: RuleResult[] = evaluations.flatMap((evaluation) => evaluation.results);
  const removals = evaluations.flatMap((evaluation) => evaluation.removals);
  const jobs = jobsFrom(input.history, removals);
  const { metrics } = computeReportMetrics(jobs, { unavailableReason: "HISTORY_EMPTY" });
  const inputHashes = input.workflows
    .map((workflow) => workflow.sha256)
    .concat(digestOf({ history: input.history.runs.map((run) => run.runId).sort() }))
    .sort();
  const sourceRefs = input.workflows
    .map((workflow) => "workflow:" + workflow.path + "@" + workflow.sha256)
    .concat("history:" + input.history.repositoryFullName + "@" + input.history.requestedFrom + ".." + input.history.requestedTo)
    .sort();
  const report: AnalysisReport = {
    schemaVersion: 2,
    provenance: "observed",
    reportId: reportIdFor(input.binding.bindingId, input.generatedAt, inputHashes),
    bindingId: input.binding.bindingId,
    engineVersion: ENGINE_VERSION,
    generatedAt: input.generatedAt,
    coverage,
    inputHashes,
    findings,
    ruleResults,
    normalizedInputs: { jobs, sourceRefs },
    metrics,
    parentReportId: null,
    pricingSnapshot: PRICING_SNAPSHOT,
  };
  assertValidDocument("AnalysisReport", report);
  return { report, evaluations };
}
