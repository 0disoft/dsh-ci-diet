/** Observations from successful Actions jobs, never a claim of causal savings. */
export interface RunObservation {
  readonly id: number;
  readonly attempt: number;
  readonly repository: string;
  readonly workflow: string;
  readonly branch: string;
  readonly event: string;
  readonly sha: string;
  readonly jobs: readonly JobObservation[];
}

export interface JobObservation {
  readonly conclusion?: "success" | "skipped";
  readonly name: string;
  readonly labels: readonly string[];
  readonly seconds: number;
  readonly steps: readonly { readonly name: string; readonly seconds: number }[];
}

/** Null records a duplicate name, which must never yield a step-level saving. */
function indexSteps(steps: JobObservation["steps"]) {
  const index = new Map<string, JobObservation["steps"][number] | null>();
  for (const step of steps) {
    const name = step.name;
    index.set(name, index.has(name) ? null : step);
  }
  return index;
}

/** Null prevents duplicate identities from being attributed to any one job. */
function indexJobs(jobs: readonly JobObservation[], keys: readonly string[]) {
  const index = new Map<string, JobObservation | null>();
  jobs.forEach((job, position) => {
    const identity = keys[position]!;
    index.set(identity, index.has(identity) ? null : job);
  });
  return index;
}

/** Prepare run-local data once, without traversing step details. */
function indexRun(run: RunObservation) {
  const keys = run.jobs.map((job) => JSON.stringify([job.name, [...job.labels].sort(), job.conclusion ?? "success"]));
  return { keys, byKey: indexJobs(run.jobs, keys), signature: JSON.stringify([...keys].sort()),
    seconds: run.jobs.reduce((sum, job) => sum + job.seconds, 0) };
}

/** Shared identity checks and totals; never traverses step details. */
function analyzeRuns(before: RunObservation, after: RunObservation, left = indexRun(before), right = indexRun(after)) {
  const blockers: string[] = [];
  for (const field of ["repository", "workflow", "branch", "event"] as const) {
    if (before[field] !== after[field]) blockers.push("DIFFERENT_" + field.toUpperCase());
  }
  if (before.id === after.id && before.attempt === after.attempt) blockers.push("SAME_RUN_ATTEMPT");
  if (left.byKey.size !== left.keys.length || right.byKey.size !== right.keys.length) blockers.push("AMBIGUOUS_JOB_NAMES");
  if (left.signature !== right.signature) blockers.push("DIFFERENT_JOBS_OR_RUNNERS");
  if (left.keys.length === 0 || right.keys.length === 0) blockers.push("NO_JOBS");
  const beforeSeconds = left.seconds, afterSeconds = right.seconds;
  const warnings = ["SINGLE_PAIR_NOT_CAUSAL_PROOF", "RUNNER_IMAGE_AND_CACHE_STATE_UNVERIFIED"];
  if (before.sha !== after.sha) warnings.push("SOURCE_CHANGED_REVIEW_DIFF_AND_TEST_SCOPE");
  return { beforeKeys: left.keys, beforeByKey: left.byKey, afterByKey: right.byKey, summary: {
    comparable: blockers.length === 0, blockers, warnings,
    beforeRunnerSeconds: beforeSeconds, afterRunnerSeconds: afterSeconds,
    observedReductionSeconds: blockers.length ? null : beforeSeconds - afterSeconds,
    observedReductionPercent: blockers.length || beforeSeconds === 0 ? null : (beforeSeconds - afterSeconds) / beforeSeconds * 100,
    actualBilledUsd: null, verifiedCausalSavings: false,
  } };
}

/** Reuse indexes within one synchronous measurement, never across measurements. */
export function createRunSummaryComparator() {
  const indexes = new WeakMap<RunObservation, ReturnType<typeof indexRun>>();
  const prepared = (run: RunObservation) => {
    let index = indexes.get(run);
    if (index === undefined) { index = indexRun(run); indexes.set(run, index); }
    return index;
  };
  return (before: RunObservation, after: RunObservation) => analyzeRuns(before, after, prepared(before), prepared(after)).summary;
}

export function compareRuns(before: RunObservation, after: RunObservation) {
  const { beforeKeys, beforeByKey, afterByKey, summary } = analyzeRuns(before, after);
  const jobs = before.jobs.map((job, index) => {
    const identity = beforeKeys[index]!;
    const match = beforeByKey.get(identity) === null ? null : afterByKey.get(identity);
    const beforeSteps = indexSteps(job.steps);
    const afterSteps = indexSteps(match?.steps ?? []);
    return { name: job.name, beforeSeconds: job.seconds, afterSeconds: match?.seconds ?? null,
      steps: job.steps.map((step) => {
        const name = step.name;
        const value = beforeSteps.get(name) === null ? null : afterSteps.get(name)?.seconds ?? null;
        return { name, beforeSeconds: step.seconds, afterSeconds: value,
          observedReductionSeconds: value === null ? null : step.seconds - value };
      }),
      addedSteps: match?.steps.filter((step) => !beforeSteps.has(step.name)) ?? [],
    };
  });
  return { schemaVersion: 1, before, after, ...summary, jobs };
}

export type RunComparison = ReturnType<typeof compareRuns>;
