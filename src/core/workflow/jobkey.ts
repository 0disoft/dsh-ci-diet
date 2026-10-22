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

interface JobKeyIndex {
  /** Present only for a single job without a matrix. */
  readonly singleJob: JobKeyMatch | null;
  readonly byKey: ReadonlyMap<string, JobKeyMatch>;
  readonly byName: ReadonlyMap<string, JobKeyMatch>;
  readonly byMatrixName: ReadonlyMap<string, JobKeyMatch>;
}

/** Workflow job arrays are immutable after parsing, so each array is indexed once. */
const JOB_KEY_INDEX = new WeakMap<readonly WorkflowJob[], JobKeyIndex>();

function buildJobKeyIndex(jobs: readonly WorkflowJob[]): JobKeyIndex {
  const first = jobs[0];
  // A single job without a matrix has exactly one possible key. A single job
  // with a matrix must still prove the leg, so its distinct values never merge
  // into one cohort (rules.md: samples share the matrix).
  const singleJob =
    jobs.length === 1 && first !== undefined && first.matrix === null
      ? { key: first.key, level: "single-job" as const, matrix: null }
      : null;
  const byKey = new Map<string, JobKeyMatch>();
  const byName = new Map<string, JobKeyMatch>();
  const byMatrixName = new Map<string, JobKeyMatch>();
  for (const job of jobs) {
    const keyName = normalizeName(job.key);
    if (!byKey.has(keyName)) byKey.set(keyName, { key: job.key, level: "key-equals-name", matrix: null });
    if (job.displayName !== null) {
      const literal = normalizeName(job.displayName);
      if (!byName.has(literal)) byName.set(literal, { key: job.key, level: "name-literal", matrix: null });
    }
  }
  // Matrix names are lowest precedence, and jobs are indexed in YAML order.
  // Within one job a name-template match beats a default rendered name, which
  // is the per-job order matrixMatch used before.
  for (const job of jobs) {
    if (job.matrix === null) continue;
    const combinations = expandMatrix(job.matrix);
    if (combinations === null) continue;
    if (job.displayName !== null && MATRIX_EXPRESSION_ALL.test(job.displayName)) {
      for (const values of combinations) {
        const rendered = renderMatrixTemplate(job.displayName, values);
        if (rendered === null) continue;
        if (!byMatrixName.has(rendered)) {
          byMatrixName.set(rendered, { key: job.key, level: "matrix-expanded", matrix: values });
        }
      }
    }
    for (const values of combinations) {
      const rendered = defaultMatrixName(job.key, values);
      if (rendered === null) continue;
      if (!byMatrixName.has(rendered)) {
        byMatrixName.set(rendered, { key: job.key, level: "matrix-expanded", matrix: values });
      }
    }
  }
  return { singleJob, byKey, byName, byMatrixName };
}

/**
 * Recover the YAML job key behind a job row's display name.
 *
 * The GitHub jobs API exposes the rendered `name:` (or the job key when the
 * job has no name), so attribution has to replay GitHub's name rendering for
 * literal matrix expansions. Computed matrices are never guessed.
 */
export function recoverJobKey(displayName: string, jobs: readonly WorkflowJob[]): JobKeyMatch | null {
  if (jobs.length === 0) return null;
  let index = JOB_KEY_INDEX.get(jobs);
  if (index === undefined) {
    index = buildJobKeyIndex(jobs);
    JOB_KEY_INDEX.set(jobs, index);
  }
  if (index.singleJob !== null) return index.singleJob;
  const name = normalizeName(displayName);
  return index.byKey.get(name) ?? index.byName.get(name) ?? index.byMatrixName.get(name) ?? null;
}
