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
  const includeOnly = matrix.axes.length === 0 && matrix.include.length > 0;
  let base: Record<string, CanonicalJsonValue>[] = includeOnly ? [] : [{}];
  for (const axis of matrix.axes) {
    const next: Record<string, CanonicalJsonValue>[] = [];
    for (const prefix of base) {
      for (const value of axis.values) {
        next.push({ ...prefix, [axis.name]: value });
        if (next.length > MAX_MATRIX_COMBINATIONS) return null;
      }
    }
    base = next;
  }

  // GitHub applies exclude to the axis product before include. Excluding after
  // include would delete rows that an include was meant to add back, and an
  // include must never be merged into a row that another include created: its
  // axis key compatibility is judged against the original combinations only.
  const axisNames = new Set(matrix.axes.map((axis) => axis.name));
  const combinations =
    matrix.exclude.length === 0
      ? base
      : base.filter(
          (combination) =>
            !matrix.exclude.some((exclude) =>
              Object.entries(exclude).every(([key, value]) => {
                const current = combination[key];
                return current !== undefined && canonicalEqual(current, value);
              }),
            ),
        );
  const added: Record<string, CanonicalJsonValue>[] = [];
  for (const include of matrix.include) {
    // A matrix with no axes uses include as the row list, so entries stay
    // separate even when they share keys; only axis products merge includes.
    if (matrix.axes.length === 0) {
      added.push({ ...include });
    } else {
      let merged = false;
      for (const combination of combinations) {
        const compatible = Object.entries(include).every(([key, value]) => {
          const current = combination[key];
          if (axisNames.has(key)) return current !== undefined && canonicalEqual(current, value);
          // A non-axis key exists only because an earlier include added it; GitHub
          // lets a later include overwrite such an added value.
          return true;
        });
        if (!compatible) continue;
        for (const [key, value] of Object.entries(include)) {
          if (axisNames.has(key)) continue;
          combination[key] = value;
        }
        merged = true;
      }
      if (!merged) added.push({ ...include });
    }
    // The axis product is capped while it is built; an include list that keeps
    // adding new rows must hit the same cap instead of materializing unbounded
    // rows for downstream consumers.
    if (combinations.length + added.length > MAX_MATRIX_COMBINATIONS) return null;
  }
  return [...combinations, ...added];
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
