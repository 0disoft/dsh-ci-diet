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
      Object.hasOwn(rightRecord, key) &&
      canonicalEqual(leftRecord[key] as CanonicalJsonValue, rightRecord[key] as CanonicalJsonValue),
  );
}

export function lookupMatrixValue(
  values: Readonly<Record<string, CanonicalJsonValue>>,
  dotted: string,
): CanonicalJsonValue | undefined {
  let current: CanonicalJsonValue | undefined = values;
  for (const part of dotted.split(".")) {
    if (current === undefined || !isCanonicalRecord(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

/** Hard stop on candidates examined while excluding rows from the axis product. */
const MAX_MATRIX_CANDIDATES = MAX_MATRIX_COMBINATIONS * 256;
/** Candidate count alone does not bound the candidates x excludes matching work. */
const MAX_MATRIX_EXCLUDE_CHECKS = MAX_MATRIX_CANDIDATES;

/**
 * Expand a statically resolved matrix into rows.
 *
 * Returns null when the row count or matching work exceeds its cap; callers must
 * treat the matrix as unresolved rather than truncating it. Exclude entries are
 * applied to the axis product before the cap is enforced, because an exclude can
 * shrink a product that is otherwise too large to materialize.
 */
export function expandMatrix(
  matrix: MatrixPlan,
): Readonly<Record<string, CanonicalJsonValue>>[] | null {
  if (matrix.dynamic) return null;
  const axisNames = new Set(matrix.axes.map((axis) => axis.name));
  // Base rows carry axis keys only, so an exclude that names any other key can
  // never match; dropping it here is the same as letting it match nothing.
  const excludes = matrix.exclude
    .filter((exclude) => Object.keys(exclude).every((key) => axisNames.has(key)))
    .map((exclude) => Object.entries(exclude));
  let excludeChecks = 0;
  const isExcluded = (values: Readonly<Record<string, CanonicalJsonValue>>): boolean | null => {
    for (const entries of excludes) {
      if (excludeChecks >= MAX_MATRIX_EXCLUDE_CHECKS) return null;
      excludeChecks += 1;
      if (entries.every(([key, value]) => {
        const current = values[key];
        return current !== undefined && canonicalEqual(current, value);
      })) return true;
    }
    return false;
  };
  const includeOnly = matrix.axes.length === 0 && matrix.include.length > 0;
  let combinations: Record<string, CanonicalJsonValue>[] = includeOnly ? [] : [{}];
  if (!includeOnly) {
    const excluded = isExcluded(combinations[0] as Record<string, CanonicalJsonValue>);
    if (excluded === null) return null;
    if (excluded) combinations = [];
  }

  // Suffix products let a level that is already too large fail without
  // materializing its rows when no pending exclude can shrink it.
  const suffix = Array.from({ length: matrix.axes.length + 1 }, () => 1);
  for (let index = matrix.axes.length - 1; index >= 0; index -= 1) {
    const axis = matrix.axes[index];
    if (axis === undefined) continue;
    suffix[index] = (suffix[index + 1] ?? 1) * axis.values.length;
  }
  const processed = new Set<string>();
  let candidates = 0;
  for (let axisIndex = 0; axisIndex < matrix.axes.length; axisIndex += 1) {
    const axis = matrix.axes[axisIndex];
    if (axis === undefined) continue;
    const pending = excludes.filter(
      (exclude) => !exclude.every(([key]) => processed.has(key)),
    );
    if (
      pending.length === 0 &&
      combinations.length * (suffix[axisIndex] ?? 1) > MAX_MATRIX_COMBINATIONS
    ) {
      return null;
    }
    const next: Record<string, CanonicalJsonValue>[] = [];
    for (const prefix of combinations) {
      for (const value of axis.values) {
        candidates += 1;
        // Overlapping excludes can force a huge walk even when their union is
        // small; stop well before that becomes a denial of service.
        if (candidates > MAX_MATRIX_CANDIDATES) return null;
        const candidate = { ...prefix, [axis.name]: value };
        const excluded = isExcluded(candidate);
        if (excluded === null) return null;
        if (!excluded) next.push(candidate);
      }
    }
    combinations = next;
    processed.add(axis.name);
    if (combinations.length > MAX_MATRIX_COMBINATIONS) {
      const stillPending = excludes.filter(
        (exclude) => !exclude.every(([key]) => processed.has(key)),
      );
      if (stillPending.length === 0) return null;
    }
  }

  // GitHub applies exclude to the axis product before include. Excluding after
  // include would delete rows that an include was meant to add back, and an
  // include must never be merged into a row that another include created: its
  // axis key compatibility is judged against the original combinations only.
  const added: Record<string, CanonicalJsonValue>[] = [];
  for (const include of matrix.include) {
    // A matrix with no axes uses include as the row list, so entries stay
    // separate even when they share keys; only axis products merge includes.
    if (matrix.axes.length === 0) {
      added.push({ ...include });
    } else {
      let merged = false;
      // Include values are immutable: reuse their entries for compatibility
      // checks and merges instead of allocating both arrays for every row.
      const entries = Object.entries(include);
      for (const combination of combinations) {
        const compatible = entries.every(([key, value]) => {
          const current = combination[key];
          if (axisNames.has(key)) return current !== undefined && canonicalEqual(current, value);
          // A non-axis key exists only because an earlier include added it; GitHub
          // lets a later include overwrite such an added value.
          return true;
        });
        if (!compatible) continue;
        for (const [key, value] of entries) {
          if (axisNames.has(key)) continue;
          if (key === "__proto__") {
            Object.defineProperty(combination, key, { value, enumerable: true, writable: true, configurable: true });
          } else {
            combination[key] = value;
          }
        }
        merged = true;
      }
      if (!merged) added.push({ ...include });
    }
    // Excluded combinations are capped above; an include list that keeps adding
    // new rows must hit the same cap instead of materializing unbounded rows for
    // downstream consumers.
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
