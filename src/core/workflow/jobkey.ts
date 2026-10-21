import type { CanonicalJsonValue } from "../../shared/cdj1.ts";
import { expandMatrix, normalizeName, renderMatrixTemplate } from "./matrix.ts";
import type { WorkflowJob } from "./model.ts";

/** How a job row was tied back to a YAML job key. */
export type JobKeyMatchLevel = "single-job" | "key-equals-name" | "name-literal" | "matrix-expanded";

export interface JobKeyMatch {
  readonly key: string;
  readonly level: JobKeyMatchLevel;
  /** Matrix values that produced the display name, when level is matrix-expanded. */
  readonly matrix: Readonly<Record<string, CanonicalJsonValue>> | null;
}

const MATRIX_EXPRESSION_ALL = /\$\{\{\s*matrix\.([A-Za-z0-9_.-]+)\s*\}\}/;

/**
 * GitHub renders a nameless matrix job as `key (v1, v2)` in matrix order, so
 * replay that default name after the literal `name:` template.
 */
function defaultMatrixName(
  key: string,
  values: Readonly<Record<string, CanonicalJsonValue>>,
): string | null {
  const parts: string[] = [];
  for (const value of Object.values(values)) {
    if (typeof value === "object" && value !== null) return null;
    parts.push(String(value));
  }
  return normalizeName(key + " (" + parts.join(", ") + ")");
}

function matrixMatch(name: string, job: WorkflowJob): JobKeyMatch | null {
  if (job.matrix === null) return null;
  const combinations = expandMatrix(job.matrix);
  if (combinations === null) return null;
  if (job.displayName !== null && MATRIX_EXPRESSION_ALL.test(job.displayName)) {
    for (const values of combinations) {
      const rendered = renderMatrixTemplate(job.displayName, values);
      if (rendered === name) return { key: job.key, level: "matrix-expanded", matrix: values };
    }
  }
  for (const values of combinations) {
    if (defaultMatrixName(job.key, values) === name) {
      return { key: job.key, level: "matrix-expanded", matrix: values };
    }
  }
  return null;
}

/**
 * Recover the YAML job key behind a job row's display name.
 *
 * The GitHub jobs API exposes the rendered `name:` (or the job key when the
 * job has no name), so attribution has to replay GitHub's name rendering for
 * literal matrix expansions. Computed matrices are never guessed.
 */
export function recoverJobKey(displayName: string, jobs: readonly WorkflowJob[]): JobKeyMatch | null {
  const name = normalizeName(displayName);
  const first = jobs[0];
  if (!first) return null;
  // A single job without a matrix has exactly one possible key. A single job
  // with a matrix must still prove the leg, so its distinct values never merge
  // into one cohort (rules.md: samples share the matrix).
  if (jobs.length === 1 && first.matrix === null) return { key: first.key, level: "single-job", matrix: null };
  for (const job of jobs) {
    if (normalizeName(job.key) === name) return { key: job.key, level: "key-equals-name", matrix: null };
  }
  for (const job of jobs) {
    if (job.displayName !== null && normalizeName(job.displayName) === name) {
      return { key: job.key, level: "name-literal", matrix: null };
    }
  }
  for (const job of jobs) {
    const match = matrixMatch(name, job);
    if (match) return match;
  }
  return null;
}
