import type { Finding } from "../contracts/schema.ts";
import { composeCoverage } from "../analysis/coverage.ts";
import type { HistoryBundle } from "../history/model.ts";
import { notApplicableSeconds, unknownSeconds } from "../savings/metrics.ts";
import { isAnalyzable, recoverJobKey } from "../workflow/index.ts";
import { RULE_VERSION } from "../version.ts";
import { buildFinding, ruleResult } from "./types.ts";
import type { DetectionRule, RuleContext, RuleEvaluation } from "./types.ts";
import { analyzableRuns, historyInputHash, jobLooksRisky, jobSeconds, nearestRankP95 } from "./history-utils.ts";

const RULE_ID = "CD005";

/** Successful samples required before a cohort may seed a p95 or a plan. */
export const CD005_MIN_COHORT = 20;

/** Cohorts with this many samples are shown as review candidates only. */
export const CD005_CANDIDATE_COHORT = 5;

interface Sample {
  readonly runId: string;
  readonly jobId: string;
  readonly seconds: number;
  readonly labelKey: string;
  readonly matrixKey: string;
  readonly attemptLevel: string;
}

interface Cohort {
  readonly workflowPath: string;
  readonly workflowHash: string;
  readonly jobKey: string;
  readonly runnerKey: string;
  readonly event: string;
  readonly samples: Sample[];
}

interface JobState {
  readonly timeoutMinutes: number | null;
  readonly timeoutPresent: boolean;
  readonly risky: boolean;
}

export function recommendedMinutes(p95Seconds: number): number {
  return Math.ceil(Math.max(2 * p95Seconds, p95Seconds + 300) / 60);
}

/** One p95 cohort of a job, exactly as evaluateCd005 groups it. */
export interface Cd005Evidence {
  readonly sampleCount: number;
  readonly p95Seconds: number;
  readonly recommendedMinutes: number;
  readonly runnerKey: string;
  readonly event: string;
}

function collectCohorts(history: HistoryBundle): Map<string, Cohort> {
  const cohorts = new Map<string, Cohort>();
  for (const { run, definition } of analyzableRuns(history)) {
    for (const job of run.jobs) {
      if (job.conclusion !== "success") continue;
      const seconds = jobSeconds(job);
      if (seconds === null || seconds <= 0) continue;
      const match = recoverJobKey(job.name, definition.jobs);
      if (match === null) continue;
      const runnerKey = [...job.labels].map((label) => label.toLowerCase()).sort().join(",");
      const matrixKey = match.matrix === null ? "" : JSON.stringify(match.matrix);
      const key = run.workflowPath + "|" + definition.sha256 + "|" + match.key + "|" + runnerKey + "|" + run.event + "|" + matrixKey;
      const sample: Sample = {
        runId: run.runId,
        jobId: job.jobId,
        seconds,
        labelKey: runnerKey,
        matrixKey,
        attemptLevel: match.level,
      };
      const existing = cohorts.get(key);
      if (existing === undefined) {
        cohorts.set(key, {
          workflowPath: run.workflowPath,
          workflowHash: definition.sha256,
          jobKey: match.key,
          runnerKey,
          event: run.event,
          samples: [sample],
        });
      } else {
        existing.samples.push(sample);
      }
    }
  }
  return cohorts;
}

/**
 * The recommendations that back any CD005 finding for this job. A plan may
 * only write one of these values: picking a job or a number that no finding
 * measured is exactly the mistake this function exists to prevent.
 */
export function cd005Recommendations(
  history: HistoryBundle,
  workflowPath: string,
  workflowHash: string,
  jobKey: string,
): Cd005Evidence[] {
  const out: Cd005Evidence[] = [];
  for (const cohort of collectCohorts(history).values()) {
    if (cohort.workflowPath !== workflowPath) continue;
    if (cohort.workflowHash !== workflowHash) continue;
    if (cohort.jobKey !== jobKey) continue;
    if (cohort.samples.length < CD005_CANDIDATE_COHORT) continue;
    const p95 = nearestRankP95(cohort.samples.map((sample) => sample.seconds));
    if (p95 === null) continue;
    out.push({
      sampleCount: cohort.samples.length,
      p95Seconds: p95,
      recommendedMinutes: recommendedMinutes(p95),
      runnerKey: cohort.runnerKey,
      event: cohort.event,
    });
  }
  return out;
}

function evaluateCd005(context: RuleContext): RuleEvaluation {
  const inputHash = historyInputHash(context, RULE_ID);
  if (context.history === undefined || context.mode !== "history") {
    return skipped(inputHash, ["HISTORY_NOT_SYNCED"]);
  }
  const composition = composeCoverage(context.coverage, RULE_ID);
  if (composition.level === "skip") return skipped(inputHash, composition.reasons);

  const cohorts = collectCohorts(context.history);

  const findings: Finding[] = [];
  for (const cohort of cohorts.values()) {
    const n = cohort.samples.length;
    if (n < CD005_CANDIDATE_COHORT) continue;
    const definition = definitionFor(context, cohort.workflowPath, cohort.workflowHash);
    if (definition === null) continue;
    const job = definition.jobs.find((candidate) => candidate.key === cohort.jobKey);
    if (job === undefined) continue;
    const state: JobState = {
      timeoutMinutes: job.timeoutMinutes,
      timeoutPresent: job.timeoutRange !== null,
      risky: jobLooksRisky(job),
    };
    const p95 = nearestRankP95(cohort.samples.map((sample) => sample.seconds));
    if (p95 === null) continue;
    const recommendation = recommendedMinutes(p95);
    if (state.timeoutMinutes !== null && state.timeoutMinutes >= 1 && state.timeoutMinutes >= recommendation) continue;

    const cohortReady = n >= CD005_MIN_COHORT;
    const excess = cohort.samples.some((sample) => sample.seconds > recommendation * 60);

    const blockers: string[] = [];
    if (!cohortReady) blockers.push("COHORT_BELOW_20");
    if (state.timeoutPresent && state.timeoutMinutes === null) blockers.push("EXPRESSION_TIMEOUT_REPORT_ONLY");
    if (state.risky) blockers.push("DEPLOY_OR_MIGRATION_JOB");
    if (excess) blockers.push("RECOMMENDATION_BELOW_SAMPLE");
    if (composition.level !== "full") blockers.push("COVERAGE_" + composition.level.toUpperCase());
    const writeComposition = composeCoverage(context.coverage, RULE_ID, { editedJobEvidenceComplete: cohortReady });
    const eligible = cohortReady && blockers.length === 0 && writeComposition.writeAllowed && !state.timeoutPresent;

    const sampleIds = cohort.samples.slice(0, 10).map((sample) => "run:" + sample.runId + "#job:" + sample.jobId);
    findings.push(
      buildFinding({
        ruleId: RULE_ID,
        ruleVersion: RULE_VERSION,
        workflowPath: cohort.workflowPath,
        workflowHash: cohort.workflowHash,
        title: "Job " + cohort.jobKey + " has no timeout; p95 is " + p95.toFixed(1) + " s",
        renderedText:
          "Job " + cohort.jobKey + " on " + cohort.workflowPath + " ran successfully " + n + " times with a nearest-rank p95 of " +
          p95.toFixed(1) + " s. A timeout of " + recommendation + " minutes is the proposal from ceil(max(2 * p95, p95 + 300) / 60). " +
          "The cohort is definition " + cohort.workflowHash.slice(0, 19) + ", runner labels " + (cohort.runnerKey === "" ? "(none)" : cohort.runnerKey) + ", event " + cohort.event + ".",
        evidenceLevel: cohortReady ? "observed" : "inferred",
        patchability: eligible ? "eligible" : "review-only",
        evidenceRefs: ["workflow:" + cohort.workflowPath + "#jobs." + cohort.jobKey + ".timeout-minutes", ...sampleIds],
        assumptions: [
          "Only successful samples in the same workflow definition hash, job key, runner labels, matrix, and event share a cohort.",
          "Display names are mapped back to the YAML job key; unresolved jobs never seed a cohort.",
          "Normal successful runtime is unchanged; a timeout only caps abnormal runs.",
        ],
        blockers,
        standaloneRunnerSeconds: cohortReady
          ? notApplicableSeconds("timeouts cap abnormal runs; normal runtime is unchanged")
          : unknownSeconds("the cohort has fewer than 20 successful samples", "COHORT_BELOW_20"),
        identity: {
          workflowPath: cohort.workflowPath,
          workflowHash: cohort.workflowHash,
          jobKey: cohort.jobKey,
          runnerKey: cohort.runnerKey,
          event: cohort.event,
          sampleCount: n,
        },
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
        reasons: [...composition.reasons, ...(findings.length > 0 ? ["TIMEOUT_CANDIDATE"] : ["NO_TIMEOUT_CANDIDATE"])],
        findings,
      }),
    ],
    findings,
    removals: [],
  };
}

function definitionFor(context: RuleContext, workflowPath: string, workflowHash: string) {
  for (const workflow of context.workflows) {
    if (workflow.path === workflowPath) return isAnalyzable(workflow) ? workflow : null;
  }
  for (const run of context.history?.runs ?? []) {
    if (run.workflowPath !== workflowPath) continue;
    if (run.definition === null) continue;
    if (run.definition.sha256 === workflowHash && isAnalyzable(run.definition)) return run.definition;
  }
  return null;
}

function skipped(inputHash: string, reasons: readonly string[]): RuleEvaluation {
  return {
    results: [ruleResult({ ruleId: RULE_ID, ruleVersion: RULE_VERSION, inputHash, outcome: "skipped", reasons })],
    findings: [],
    removals: [],
  };
}

export const cd005: DetectionRule = { id: RULE_ID, version: RULE_VERSION, evaluate: evaluateCd005 };
