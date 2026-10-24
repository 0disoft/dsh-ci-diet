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

export function compareRuns(before: RunObservation, after: RunObservation) {
  const blockers: string[] = [];
  for (const field of ["repository", "workflow", "branch", "event"] as const) {
    if (before[field] !== after[field]) blockers.push("DIFFERENT_" + field.toUpperCase());
  }
  if (before.id === after.id && before.attempt === after.attempt) blockers.push("SAME_RUN_ATTEMPT");
  const key = (job: JobObservation) => JSON.stringify([job.name, [...job.labels].sort()]);
  const beforeKeys = before.jobs.map(key);
  const afterKeys = after.jobs.map(key);
  const beforeByKey = indexJobs(before.jobs, beforeKeys);
  const afterByKey = indexJobs(after.jobs, afterKeys);
  if (beforeByKey.size !== beforeKeys.length || afterByKey.size !== afterKeys.length) blockers.push("AMBIGUOUS_JOB_NAMES");
  if (JSON.stringify([...beforeKeys].sort()) !== JSON.stringify([...afterKeys].sort())) blockers.push("DIFFERENT_JOBS_OR_RUNNERS");
  if (before.jobs.length === 0 || after.jobs.length === 0) blockers.push("NO_JOBS");
  const total = (run: RunObservation) => run.jobs.reduce((sum, job) => sum + job.seconds, 0);
  const beforeSeconds = total(before), afterSeconds = total(after);
  const warnings = ["SINGLE_PAIR_NOT_CAUSAL_PROOF", "RUNNER_IMAGE_AND_CACHE_STATE_UNVERIFIED"];
  if (before.sha !== after.sha) warnings.push("SOURCE_CHANGED_REVIEW_DIFF_AND_TEST_SCOPE");
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
  return { schemaVersion: 1, before, after, comparable: blockers.length === 0, blockers, warnings,
    beforeRunnerSeconds: beforeSeconds, afterRunnerSeconds: afterSeconds,
    observedReductionSeconds: blockers.length ? null : beforeSeconds - afterSeconds,
    observedReductionPercent: blockers.length || beforeSeconds === 0 ? null : (beforeSeconds - afterSeconds) / beforeSeconds * 100,
    actualBilledUsd: null, verifiedCausalSavings: false, jobs };
}

export type RunComparison = ReturnType<typeof compareRuns>;
