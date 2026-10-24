import type { Finding } from "../contracts/schema.ts";
import { composeCoverage } from "../analysis/coverage.ts";
import type { HistoryBundle } from "../history/model.ts";
import { notApplicableSeconds, unknownSeconds } from "../savings/metrics.ts";
import { expandMatrix, isAnalyzable, recoverJobKey } from "../workflow/index.ts";
import type { MatrixPlan, WorkflowDefinition, WorkflowJob } from "../workflow/model.ts";
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
  readonly matrixKey: string;
  readonly declaredMatrix: MatrixPlan | null;
  readonly samples: Sample[];
}

interface JobState {
  readonly timeoutMinutes: number | null;
  readonly timeoutPresent: boolean;
  readonly risky: boolean;
}

/** All cohorts of one job: a matrix or runner split must not be judged by its fastest leg. */
interface JobCohorts {
  readonly workflowPath: string;
  readonly workflowHash: string;
  readonly jobKey: string;
  readonly declaredMatrix: MatrixPlan | null;
  readonly cohorts: Cohort[];
}

interface JobAggregate {
  readonly qualifying: Cohort[];
  readonly totalSamples: number;
  readonly p95Seconds: number;
  readonly recommendedMinutes: number;
  readonly cohortReady: boolean;
  readonly runnerKey: string;
  readonly event: string;
  readonly matrixKeys: string[];
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
    const jobsByKey = new Map(definition.jobs.map((job) => [job.key, job]));
    for (const job of run.jobs) {
      if (job.conclusion !== "success") continue;
      const seconds = jobSeconds(job);
      if (seconds === null || seconds <= 0) continue;
      const match = recoverJobKey(job.name, definition.jobs);
      if (match === null) continue;
      const declaredJob = jobsByKey.get(match.key);
      if (declaredJob === undefined) continue;
      // Knowing the job key is insufficient when its matrix leg is unknown.
      if (declaredJob.matrix !== null && match.matrix === null) continue;
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
          matrixKey,
          declaredMatrix: declaredJob.matrix,
          samples: [sample],
        });
      } else {
        existing.samples.push(sample);
      }
    }
  }
  return cohorts;
}

function uniqueJoined(values: readonly string[], separator: string): string {
  return [...new Set(values)].sort().join(separator);
}

/** Group cohorts by workflow definition and job key; matrix and runner legs stay distinct cohorts. */
function groupByJob(cohorts: Iterable<Cohort>): Map<string, JobCohorts> {
  const groups = new Map<string, JobCohorts>();
  for (const cohort of cohorts) {
    const key = cohort.workflowPath + "|" + cohort.workflowHash + "|" + cohort.jobKey;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        workflowPath: cohort.workflowPath,
        workflowHash: cohort.workflowHash,
        jobKey: cohort.jobKey,
        declaredMatrix: cohort.declaredMatrix,
        cohorts: [cohort],
      });
    } else {
      existing.cohorts.push(cohort);
    }
  }
  return groups;
}

/**
 * Aggregate every cohort of one job into the single recommendation a plan may
 * write. Any measured leg (a matrix axis or runner split) that runs slower
 * raises the recommendation for the whole job; a leg with too few samples
 * makes the job review-only instead of being silently ignored.
 */
function aggregateJob(group: JobCohorts): JobAggregate | null {
  const measured: { readonly cohort: Cohort; readonly p95: number; readonly minutes: number }[] = [];
  for (const cohort of group.cohorts) {
    if (cohort.samples.length < CD005_CANDIDATE_COHORT) continue;
    const p95 = nearestRankP95(cohort.samples.map((sample) => sample.seconds));
    if (p95 === null) continue;
    measured.push({ cohort, p95, minutes: recommendedMinutes(p95) });
  }
  if (measured.length === 0) return null;
  let slowest = measured[0]!;
  for (const entry of measured) {
    if (entry.minutes > slowest.minutes || (entry.minutes === slowest.minutes && entry.p95 > slowest.p95)) slowest = entry;
  }
  const totalSamples = group.cohorts.reduce((total, cohort) => total + cohort.samples.length, 0);
  const matrixKeys = [...new Set(group.cohorts.map((cohort) => cohort.matrixKey))].sort();
  const observedMatrixKeys = new Set(matrixKeys);
  const declaredLegs = group.declaredMatrix === null ? [null] : expandMatrix(group.declaredMatrix);
  // An absent leg has zero successful samples, even when collection was complete.
  const allLegsObserved = declaredLegs !== null && declaredLegs.length > 0
    && declaredLegs.every((values) => observedMatrixKeys.has(values === null ? "" : JSON.stringify(values)));
  const cohortReady = allLegsObserved && group.cohorts.every((cohort) => cohort.samples.length >= CD005_MIN_COHORT);
  return {
    qualifying: measured.map((entry) => entry.cohort),
    totalSamples,
    p95Seconds: slowest.p95,
    recommendedMinutes: slowest.minutes,
    cohortReady,
    runnerKey: uniqueJoined(group.cohorts.map((cohort) => cohort.runnerKey), "+"),
    event: uniqueJoined(group.cohorts.map((cohort) => cohort.event), "+"),
    matrixKeys,
  };
}

function sampleRefs(cohorts: readonly Cohort[], limit: number): string[] {
  const refs: string[] = [];
  for (const cohort of cohorts) {
    for (const sample of cohort.samples) {
      if (refs.length >= limit) return refs;
      refs.push("run:" + sample.runId + "#job:" + sample.jobId);
    }
  }
  return refs;
}

/**
 * The recommendations that back any CD005 finding for this job. A plan may
 * only write one of these values: picking a job or a number that no finding
 * measured is exactly the mistake this function exists to prevent.
 *
 * Recommendations are a pure function of the history bundle, and target
 * resolution asks for them once per plan, so the aggregate index is cached per
 * bundle. History bundles are immutable by convention.
 */
const RECOMMENDATION_CACHE = new WeakMap<HistoryBundle, Map<string, Cd005Evidence>>();

function recommendationIndex(history: HistoryBundle): Map<string, Cd005Evidence> {
  const cached = RECOMMENDATION_CACHE.get(history);
  if (cached !== undefined) return cached;
  const index = new Map<string, Cd005Evidence>();
  for (const group of groupByJob(collectCohorts(history).values()).values()) {
    const aggregate = aggregateJob(group);
    // Recheck at plan time too: previously stored findings may predate this gate.
    if (aggregate === null || !aggregate.cohortReady) continue;
    index.set(group.workflowPath + "|" + group.workflowHash + "|" + group.jobKey, {
      sampleCount: aggregate.totalSamples,
      p95Seconds: aggregate.p95Seconds,
      recommendedMinutes: aggregate.recommendedMinutes,
      runnerKey: aggregate.runnerKey,
      event: aggregate.event,
    });
  }
  RECOMMENDATION_CACHE.set(history, index);
  return index;
}

export function cd005Recommendations(
  history: HistoryBundle,
  workflowPath: string,
  workflowHash: string,
  jobKey: string,
): Cd005Evidence[] {
  const evidence = recommendationIndex(history).get(workflowPath + "|" + workflowHash + "|" + jobKey);
  return evidence === undefined ? [] : [evidence];
}

function evaluateCd005(context: RuleContext): RuleEvaluation {
  const inputHash = historyInputHash(context, RULE_ID);
  if (context.history === undefined || context.mode !== "history") {
    return skipped(inputHash, ["HISTORY_NOT_SYNCED"]);
  }
  const composition = composeCoverage(context.coverage, RULE_ID);
  if (composition.level === "skip") return skipped(inputHash, composition.reasons);

  const cohorts = collectCohorts(context.history);

  // The current definition and job are looked up by their cohort key once per
  // evaluation instead of scanning context.workflows for every cohort.
  const definitions = new Map<string, WorkflowDefinition | null>();
  const definitionJobs = new Map<string, WorkflowJob>();
  for (const workflow of context.workflows) {
    const definitionKey = workflow.path + "|" + workflow.sha256;
    if (definitions.has(definitionKey)) continue;
    const analyzable = isAnalyzable(workflow) ? workflow : null;
    definitions.set(definitionKey, analyzable);
    if (analyzable === null) continue;
    for (const job of analyzable.jobs) {
      const jobKey = definitionKey + "|" + job.key;
      if (!definitionJobs.has(jobKey)) definitionJobs.set(jobKey, job);
    }
  }

  const findings: Finding[] = [];
  for (const group of groupByJob(cohorts.values()).values()) {
    const aggregate = aggregateJob(group);
    if (aggregate === null) continue;
    const definitionKey = group.workflowPath + "|" + group.workflowHash;
    const definition = definitions.get(definitionKey) ?? null;
    if (definition === null) continue;
    const job = definitionJobs.get(definitionKey + "|" + group.jobKey);
    if (job === undefined) continue;
    const state: JobState = {
      timeoutMinutes: job.timeoutMinutes,
      timeoutPresent: job.timeoutRange !== null,
      risky: jobLooksRisky(job),
    };
    const n = aggregate.totalSamples;
    const p95 = aggregate.p95Seconds;
    const recommendation = aggregate.recommendedMinutes;
    const existingMinutes = state.timeoutMinutes;
    // Never raise a literal: keep an equal or smaller value, and propose only a
    // reduction when the existing literal is above the recommendation. A literal
    // below 1 is invalid, so it is left alone rather than raised (rules.md:170-172).
    if (existingMinutes !== null && (existingMinutes < 1 || existingMinutes <= recommendation)) continue;
    const reductionMinutes = existingMinutes !== null ? existingMinutes : null;

    const cohortReady = aggregate.cohortReady;
    const excess = group.cohorts.some((cohort) =>
      cohort.samples.some((sample) => sample.seconds > recommendation * 60));

    const blockers: string[] = [];
    if (!cohortReady) blockers.push("COHORT_BELOW_20");
    if (state.timeoutPresent && state.timeoutMinutes === null) blockers.push("EXPRESSION_TIMEOUT_REPORT_ONLY");
    if (state.risky) blockers.push("DEPLOY_OR_MIGRATION_JOB");
    if (excess) blockers.push("RECOMMENDATION_BELOW_SAMPLE");
    if (composition.level !== "full") blockers.push("COVERAGE_" + composition.level.toUpperCase());
    const writeComposition = composeCoverage(context.coverage, RULE_ID, { editedJobEvidenceComplete: cohortReady });
    const eligible = cohortReady && blockers.length === 0 && writeComposition.writeAllowed && !state.timeoutPresent;

    const sampleIds = sampleRefs(group.cohorts, 10);
    const title =
      reductionMinutes !== null
        ? "Job " + group.jobKey + " caps at " + reductionMinutes + " minutes; p95 is " + p95.toFixed(1) + " s"
        : state.timeoutPresent
          ? "Job " + group.jobKey + " has an expression timeout; p95 is " + p95.toFixed(1) + " s"
          : "Job " + group.jobKey + " has no timeout; p95 is " + p95.toFixed(1) + " s";
    const proposal =
      reductionMinutes !== null
        ? "The existing timeout-minutes: " + reductionMinutes + " would be reduced to " + recommendation + " minutes."
        : state.timeoutPresent
          ? "The timeout is an expression, so CI Diet reports only and proposes no literal."
          : "A timeout of " + recommendation + " minutes is the proposal from ceil(max(2 * p95, p95 + 300) / 60).";
    const evidencePhrase =
      group.cohorts.length === 1
        ? "ran successfully " + n + " times with a nearest-rank p95 of "
        : "ran successfully " + n + " times across " + group.cohorts.length + " matrix/runner cohorts with a slowest-cohort nearest-rank p95 of ";
    const cohortFacts =
      group.cohorts.length === 1
        ? "The cohort is definition " + group.workflowHash.slice(0, 19) + ", runner labels " + (aggregate.runnerKey === "" ? "(none)" : aggregate.runnerKey) + ", event " + aggregate.event + "."
        : "The cohorts share definition " + group.workflowHash.slice(0, 19) + "; runner labels " + (aggregate.runnerKey === "" ? "(none)" : aggregate.runnerKey) +
          ", matrix " + (aggregate.matrixKeys.join(" | ") === "" ? "(none)" : aggregate.matrixKeys.join(" | ")) + ", event " + aggregate.event + ".";
    findings.push(
      buildFinding({
        ruleId: RULE_ID,
        ruleVersion: RULE_VERSION,
        workflowPath: group.workflowPath,
        workflowHash: group.workflowHash,
        title,
        renderedText:
          "Job " + group.jobKey + " on " + group.workflowPath + " " + evidencePhrase +
          p95.toFixed(1) + " s. " + proposal + " " + cohortFacts,
        // The localized text describes one cohort, so an aggregated job, a
        // reduction, or an expression timeout keeps the canonical English text.
        ...(state.timeoutPresent || group.cohorts.length > 1
          ? {}
          : {
              message: {
                titleKey: "finding.CD005.title",
                textKey: "finding.CD005.text",
                params: {
                  job: group.jobKey,
                  p95: p95.toFixed(1),
                  workflow: group.workflowPath,
                  samples: n,
                  minutes: recommendation,
                  hash: group.workflowHash.slice(0, 19),
                  runner: aggregate.runnerKey === "" ? "(none)" : aggregate.runnerKey,
                  event: aggregate.event,
                },
              },
            }),
        evidenceLevel: cohortReady ? "observed" : "inferred",
        patchability: eligible ? "eligible" : "review-only",
        evidenceRefs: ["workflow:" + group.workflowPath + "#jobs." + group.jobKey + ".timeout-minutes", ...sampleIds],
        assumptions: [
          "Only successful samples in the same workflow definition hash, job key, runner labels, matrix, and event share a cohort.",
          "Display names are mapped back to the YAML job key; unresolved jobs never seed a cohort.",
          "Normal successful runtime is unchanged; a timeout only caps abnormal runs.",
        ],
        blockers,
        standaloneRunnerSeconds: cohortReady
          ? notApplicableSeconds("timeouts cap abnormal runs; normal runtime is unchanged")
          : unknownSeconds("a cohort of this job has fewer than 20 successful samples", "COHORT_BELOW_20"),
        identity: {
          workflowPath: group.workflowPath,
          workflowHash: group.workflowHash,
          jobKey: group.jobKey,
          runnerKey: aggregate.runnerKey,
          event: aggregate.event,
          sampleCount: n,
          matrix: aggregate.matrixKeys.length === 1 && aggregate.matrixKeys[0] === "" ? null : aggregate.matrixKeys,
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

function skipped(inputHash: string, reasons: readonly string[]): RuleEvaluation {
  return {
    results: [ruleResult({ ruleId: RULE_ID, ruleVersion: RULE_VERSION, inputHash, outcome: "skipped", reasons })],
    findings: [],
    removals: [],
  };
}

export const cd005: DetectionRule = { id: RULE_ID, version: RULE_VERSION, evaluate: evaluateCd005 };
