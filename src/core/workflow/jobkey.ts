import type { CanonicalJsonValue } from "../../shared/cdj1.ts";
import type { MatrixPlan, WorkflowJob } from "./model.ts";

/** How a job row was tied back to a YAML job key. */
export type JobKeyMatchLevel = "single-job" | "key-equals-name" | "name-literal" | "matrix-expanded";

export interface JobKeyMatch {
  readonly key: string;
  readonly level: JobKeyMatchLevel;
  /** Matrix values that produced the display name, when level is matrix-expanded. */
  readonly matrix: Readonly<Record<string, CanonicalJsonValue>> | null;
}

export const MAX_MATRIX_COMBINATIONS = 256;

const MATRIX_EXPRESSION_ALL = /\$\{\{\s*matrix\.([A-Za-z0-9_.-]+)\s*\}\}/g;

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isRecord(value: CanonicalJsonValue): value is Readonly<Record<string, CanonicalJsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalEqual(left: CanonicalJsonValue, right: CanonicalJsonValue): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => canonicalEqual(item, right[index] as CanonicalJsonValue));
  }
  const leftRecord = left as Readonly<Record<string, CanonicalJsonValue>>;
  const rightRecord = right as Readonly<Record<string, CanonicalJsonValue>>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      key in rightRecord &&
      canonicalEqual(leftRecord[key] as CanonicalJsonValue, rightRecord[key] as CanonicalJsonValue),
  );
}

function lookup(values: Record<string, CanonicalJsonValue>, dotted: string): CanonicalJsonValue | undefined {
  let current: CanonicalJsonValue | undefined = values;
  for (const part of dotted.split(".")) {
    if (current === undefined || !isRecord(current) || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function expand(matrix: MatrixPlan): Readonly<Record<string, CanonicalJsonValue>>[] | null {
  let combinations: Record<string, CanonicalJsonValue>[] = [{}];
  for (const axis of matrix.axes) {
    const next: Record<string, CanonicalJsonValue>[] = [];
    for (const prefix of combinations) {
      for (const value of axis.values) {
        next.push({ ...prefix, [axis.name]: value });
        if (next.length > MAX_MATRIX_COMBINATIONS) return null;
      }
    }
    combinations = next;
  }
  for (const include of matrix.include) {
    let merged = false;
    for (const combination of combinations) {
      const compatible = Object.entries(include).every(([key, value]) => {
        const current = combination[key];
        return current === undefined || canonicalEqual(current, value);
      });
      if (!compatible) continue;
      Object.assign(combination, include);
      merged = true;
    }
    if (!merged) combinations.push({ ...include });
  }
  if (matrix.exclude.length > 0) {
    combinations = combinations.filter(
      (combination) =>
        !matrix.exclude.some((exclude) =>
          Object.entries(exclude).every(([key, value]) => {
            const current = combination[key];
            return current !== undefined && canonicalEqual(current, value);
          }),
        ),
    );
  }
  return combinations;
}

function render(template: string, values: Record<string, CanonicalJsonValue>): string | null {
  let unresolved = false;
  const text = template.replace(MATRIX_EXPRESSION_ALL, (_, axis: string) => {
    const value = lookup(values, axis);
    if (value === undefined || typeof value === "object") {
      unresolved = true;
      return "";
    }
    return String(value);
  });
  return unresolved ? null : normalize(text);
}

function matrixMatch(name: string, job: WorkflowJob): JobKeyMatch | null {
  if (job.displayName === null || job.matrix === null) return null;
  if (!MATRIX_EXPRESSION_ALL.test(job.displayName)) return null;
  MATRIX_EXPRESSION_ALL.lastIndex = 0;
  const combinations = expand(job.matrix);
  if (combinations === null) return null;
  for (const values of combinations) {
    const rendered = render(job.displayName, values);
    if (rendered === name) return { key: job.key, level: "matrix-expanded", matrix: values };
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
  const name = normalize(displayName);
  const first = jobs[0];
  if (!first) return null;
  if (jobs.length === 1) return { key: first.key, level: "single-job", matrix: null };
  for (const job of jobs) {
    if (normalize(job.key) === name) return { key: job.key, level: "key-equals-name", matrix: null };
  }
  for (const job of jobs) {
    if (job.displayName !== null && normalize(job.displayName) === name) {
      return { key: job.key, level: "name-literal", matrix: null };
    }
  }
  for (const job of jobs) {
    const match = matrixMatch(name, job);
    if (match) return match;
  }
  return null;
}
