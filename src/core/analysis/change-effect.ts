import type { AppliedChange } from "../contracts/schema.ts";
import { createRunSummaryComparator, type RunObservation } from "./run-comparison.ts";

export interface ChangeEffectRun {
  readonly id: number;
  readonly attempt: number;
  readonly conclusion: string;
  readonly workflowHash: string;
  readonly definitionRefs?: readonly string[];
  readonly observation: RunObservation | null;
}

/** User-selected samples, not a causal experiment or account billing data. */
export function measureChangeEffect(change: AppliedChange, before: readonly ChangeEffectRun[], after: readonly ChangeEffectRun[]) {
  const blockers: string[] = [];
  if (change.state !== "APPLIED") blockers.push("CHANGE_NOT_APPLIED");
  const seen = new Set<number>();
  for (const [samples, hash] of [[before, change.before.hash], [after, change.after.hash]] as const) {
    for (const run of samples) {
      if (seen.has(run.id)) blockers.push("DUPLICATE_RUN");
      seen.add(run.id);
      if (run.workflowHash !== hash) blockers.push("WORKFLOW_HASH_MISMATCH");
      if (run.observation !== null && (run.observation.workflow !== change.workflowPath
        || run.observation.id !== run.id || run.observation.attempt !== run.attempt)) blockers.push("RUN_IDENTITY_MISMATCH");
      if ((run.conclusion === "success") !== (run.observation !== null)) blockers.push("INCOMPLETE_RUN_OBSERVATION");
    }
  }
  const successes = (samples: readonly ChangeEffectRun[]) => samples.flatMap((run) => run.observation === null ? [] : [run.observation]);
  const left = successes(before), right = successes(after);
  if (left.length === 0 || right.length === 0) blockers.push("SUCCESSFUL_SAMPLES_REQUIRED");
  // Raw observations live once in each phase. Pairs refer to them by identity
  // and contain totals only, avoiding B*A copies of all jobs and step diffs.
  const compareSummary = createRunSummaryComparator();
  const comparisons = left.flatMap((a) => right.map((b) => ({
    beforeRunId: a.id, beforeAttempt: a.attempt, afterRunId: b.id, afterAttempt: b.attempt,
    ...compareSummary(a, b),
  })));
  for (const pair of comparisons) blockers.push(...pair.blockers);
  const comparable = blockers.length === 0;
  const summarize = (samples: readonly ChangeEffectRun[], observations: readonly RunObservation[]) => ({
    selectedRuns: samples.length,
    successes: samples.filter((run) => run.conclusion === "success").length,
    failures: samples.filter((run) => run.conclusion === "failure").length,
    otherConclusions: samples.filter((run) => !["success", "failure"].includes(run.conclusion)).length,
    successRate: samples.length ? samples.filter((run) => run.conclusion === "success").length / samples.length : null,
    rerunRate: samples.length ? samples.filter((run) => run.attempt > 1).length / samples.length : null,
    rerunAttempts: samples.reduce((sum, run) => sum + Math.max(0, run.attempt - 1), 0),
    meanSuccessfulRunnerSeconds: comparable ? observations.reduce((sum, run) => sum + run.jobs.reduce((n, job) => n + job.seconds, 0), 0) / observations.length : null,
  });
  const beforeSummary = summarize(before, left), afterSummary = summarize(after, right);
  return { schemaVersion: 2, changeId: change.changeId, planId: change.planId, planDigest: change.planDigest,
    workflowPath: change.workflowPath, comparable, blockers: [...new Set(blockers)],
    before: { ...beforeSummary, runs: before }, after: { ...afterSummary, runs: after },
    observedReductionSeconds: comparable ? beforeSummary.meanSuccessfulRunnerSeconds! - afterSummary.meanSuccessfulRunnerSeconds! : null,
    actualBilledUsd: null, verifiedCausalSavings: false,
    warnings: [...new Set(["USER_SELECTED_SAMPLES_MAY_BE_BIASED", "SUCCESSFUL_RUN_TIMES_ONLY",
      "ALL_JOB_TIME_INCLUDES_CACHE_RESTORE_AND_SAVE", "PRIOR_ATTEMPT_RUNNER_TIME_NOT_COLLECTED", "STEP_RETRIES_NOT_OBSERVABLE",
      ...comparisons.flatMap((pair) => pair.warnings)])], comparisons };
}

export type ChangeEffect = ReturnType<typeof measureChangeEffect>;
