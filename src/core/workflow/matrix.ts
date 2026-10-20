import type { CanonicalJsonValue } from "../../shared/cdj1.ts";
import type { MatrixPlan } from "./model.ts";

/** Upper bound on rows we are willing to materialize for one job matrix. */
export const MAX_MATRIX_COMBINATIONS = 256;

const MATRIX_EXPRESSION_ALL = /\$\{\{\s*matrix\.([A-Za-z0-9_.-]+)\s*\}\}/g;

export function normalizeName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function isCanonicalRecord(
  value: CanonicalJsonValue,
): value is Readonly<Record<string, CanonicalJsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function canonicalEqual(left: CanonicalJsonValue, right: CanonicalJsonValue): boolean {
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

export function lookupMatrixValue(
  values: Readonly<Record<string, CanonicalJsonValue>>,
  dotted: string,
): CanonicalJsonValue | undefined {
  let current: CanonicalJsonValue | undefined = values;
  for (const part of dotted.split(".")) {
    if (current === undefined || !isCanonicalRecord(current) || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Expand a statically resolved matrix into rows.
 *
 * Returns null when the row count would exceed the cap; callers must then
 * treat the matrix as unresolved rather than truncating it.
 */
export function expandMatrix(
  matrix: MatrixPlan,
): Readonly<Record<string, CanonicalJsonValue>>[] | null {
  if (matrix.dynamic) return null;
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

export function renderMatrixTemplate(
  template: string,
  values: Readonly<Record<string, CanonicalJsonValue>>,
): string | null {
  let unresolved = false;
  const text = template.replace(MATRIX_EXPRESSION_ALL, (_, axis: string) => {
    const value = lookupMatrixValue(values, axis);
    if (value === undefined || typeof value === "object") {
      unresolved = true;
      return "";
    }
    return String(value);
  });
  return unresolved ? null : normalizeName(text);
}

/** Human-readable axis summary such as "os (3 values), node (2 values)". */
export function describeMatrix(matrix: MatrixPlan): string {
  if (matrix.axes.length === 0) return "no axes";
  return matrix.axes
    .map((axis) => axis.name + " (" + String(axis.values.length) + " values)")
    .join(", ");
}
