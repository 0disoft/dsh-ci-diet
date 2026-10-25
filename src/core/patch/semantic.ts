import { bunCacheResultValid } from "../rules/bun-cache.ts";
import { parse } from "yaml";
import type { ByteEdit } from "../contracts/schema.ts";
import type { WorkflowDefinition } from "../workflow/model.ts";
import { parseWorkflow } from "../workflow/parse.ts";
import { TIMEOUT_MINUTES_MAX, TIMEOUT_MINUTES_MIN } from "../policy/constants.ts";

/**
 * Semantic guard for a patch plan.
 *
 * The byte ranges decide what the editor may touch, but ranges only describe
 * the bytes that changed, not the structure those bytes landed in. This module
 * parses both documents into plain YAML values and diffs the whole tree: every
 * leaf difference must sit under a path the plan claims to edit. Nothing is
 * projected away, so an edit that smuggles `permissions` or `env` in beside the
 * claimed key is reported even when the digest matches.
 */

type PathSeg = string | number;

interface Difference {
  readonly path: PathSeg[];
  readonly kind: "missing" | "added" | "changed";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type EqualityCache = WeakMap<object, WeakMap<object, boolean>>;

/** Parsed trees stay immutable during a check; remember both equal and unequal pairs. */
function deepEqual(left: unknown, right: unknown, cache: EqualityCache): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  let pairs = cache.get(left);
  const cached = pairs?.get(right);
  if (cached !== undefined) return cached;
  let equal = false;
  if (Array.isArray(left) && Array.isArray(right)) {
    equal = left.length === right.length && left.every((value, index) => deepEqual(value, right[index], cache));
  } else if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    equal = leftKeys.length === rightKeys.length
      && leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key], cache));
  }
  if (pairs === undefined) {
    pairs = new WeakMap<object, boolean>();
    cache.set(left, pairs);
  }
  pairs.set(right, equal);
  return equal;
}

function isAllowedLeaf(
  path: readonly PathSeg[],
  allowed: readonly (readonly PathSeg[])[],
): boolean {
  return allowed.some((candidate) => isPrefix(candidate, path));
}

function isPrefix(prefix: readonly PathSeg[], path: readonly PathSeg[]): boolean {
  if (prefix.length > path.length) return false;
  return prefix.every((segment, index) => segment === path[index]);
}

function collectDifferences(
  before: unknown,
  after: unknown,
  path: PathSeg[],
  allowed: readonly (readonly PathSeg[])[],
  out: Difference[],
  cache: EqualityCache = new WeakMap(),
): void {
  if (deepEqual(before, after, cache)) return;
  if (isAllowedLeaf(path, allowed)) return;
  const beforeIsObject = isPlainObject(before);
  const afterIsObject = isPlainObject(after);
  if (beforeIsObject && afterIsObject) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      // Missing YAML keys must stay missing, even when Object.prototype has one.
      const beforeValue = Object.hasOwn(before, key) ? before[key] : undefined;
      const afterValue = Object.hasOwn(after, key) ? after[key] : undefined;
      path.push(key);
      collectDifferences(beforeValue, afterValue, path, allowed, out, cache);
      path.pop();
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      path.push(index);
      collectDifferences(before[index], after[index], path, allowed, out, cache);
      path.pop();
    }
    return;
  }
  if (beforeIsObject || afterIsObject) {
    const object = (beforeIsObject ? before : after) as Record<string, unknown>;
    const other = beforeIsObject ? after : before;
    const keys = Object.keys(object);
    if ((other === undefined || other === null) && keys.length > 0) {
      for (const key of keys) {
        path.push(key);
        collectDifferences(
          beforeIsObject ? object[key] : undefined,
          beforeIsObject ? undefined : object[key],
          path,
          allowed,
          out,
          cache,
        );
        path.pop();
      }
      return;
    }
  }
  out.push({
    path: [...path],
    kind: before === undefined ? "added" : after === undefined ? "missing" : "changed",
  });
}

function jobKeyOf(edit: ByteEdit): string | null {
  return /^jobs\.([^.]+)\./.exec(edit.semanticPath)?.[1] ?? null;
}

function stepIndexIn(edit: ByteEdit): number | null {
  const value = /^jobs\.[^.]+\.steps\[(\d+)\]/.exec(edit.semanticPath)?.[1];
  return value === undefined ? null : Number(value);
}

/** Exactly the leaves a plan is allowed to change, one entry per edit. */
export function allowedPaths(edits: readonly ByteEdit[]): PathSeg[][] {
  const paths: PathSeg[][] = [];
  for (const edit of edits) {
    if (edit.ruleId === "CD001") {
      paths.push(["concurrency", "group"], ["concurrency", "cancel-in-progress"]);
      continue;
    }
    const jobKey = jobKeyOf(edit);
    if (jobKey === null) continue;
    if (edit.ruleId === "CD005") {
      paths.push(["jobs", jobKey, "timeout-minutes"]);
      continue;
    }
    const stepIndex = stepIndexIn(edit);
    if (edit.ruleId === "CD006" && stepIndex !== null) {
      paths.push(["jobs", jobKey, "steps", stepIndex, "with", "cache"], ["jobs", jobKey, "steps", stepIndex, "with", "cache-dependency-path"]);
      continue;
    }
    if (stepIndex !== null)
      paths.push(["jobs", jobKey, "steps", stepIndex, "with", "retention-days"]);
  }
  return paths;
}

function formatPath(path: readonly PathSeg[]): string {
  let text = "";
  for (const segment of path) {
    if (typeof segment === "number") text += "[" + segment + "]";
    else text += text === "" ? segment : "." + segment;
  }
  return text;
}

export interface SemanticInput {
  readonly original: WorkflowDefinition;
  readonly originalText: string;
  readonly resultText: string;
  readonly edits: readonly ByteEdit[];
}

/** Reject unsupported targets and structural differences outside the claimed leaves. */
export function semanticProblems(input: SemanticInput): string[] {
  const reparsed = parseWorkflow(input.original.path, input.resultText);
  if (reparsed.parseError !== null)
    return ["edited workflow does not parse: " + reparsed.parseError.message];
  if (reparsed.unsupported.length > 0)
    return reparsed.unsupported.map((feature) => "edited workflow is unsupported: " + feature.code);

  // Old plans can bypass today's editor, so recheck caller targets at apply.
  const timeoutJobs = new Set(input.edits.filter((edit) => edit.ruleId === "CD005").map(jobKeyOf));
  const invalidTimeouts = input.original.jobs.filter((job) => job.reusableWorkflow !== null && timeoutJobs.has(job.key));
  if (invalidTimeouts.length > 0)
    return invalidTimeouts.map((job) => "timeout-minutes is not supported on a reusable workflow caller: jobs." + job.key);

  // A valid digest and an allowed path do not prove that the new value is
  // supported. Use the parsed result so strings, expressions and mappings
  // cannot masquerade as the integer literal required by the timeout editor.
  const invalidMinutes = reparsed.jobs.filter((job) => timeoutJobs.has(job.key)
    && (job.timeoutMinutes === null || job.timeoutMinutes < TIMEOUT_MINUTES_MIN || job.timeoutMinutes > TIMEOUT_MINUTES_MAX));
  if (invalidMinutes.length > 0)
    return invalidMinutes.map((job) => "timeout-minutes must be an integer between " + TIMEOUT_MINUTES_MIN
      + " and " + TIMEOUT_MINUTES_MAX + ": jobs." + job.key);

  let before: unknown;
  let after: unknown;
  try {
    before = parse(input.originalText);
    after = parse(input.resultText);
  } catch (error) {
    return [
      "edited workflow does not parse as YAML: " +
        (error instanceof Error ? error.message : String(error)),
    ];
  }
  const bun = input.edits.find((e) => e.ruleId === "CD006" && e.semanticPath.endsWith(".bun-cache"));
  if (bun !== undefined) return input.edits.length === 1 && bunCacheResultValid(input.original, input.originalText, input.resultText, bun)
    ? [] : ["Bun cache edit differs from the canonical insertion"];
  const allowed = allowedPaths(input.edits);
  const differences: Difference[] = [];
  collectDifferences(before, after, [], allowed, differences);
  if (differences.length === 0) return [];
  return differences.map(
    (difference) =>
      difference.kind + " outside the allowed edit paths: " + formatPath(difference.path),
  );
}

/** Kept for callers that only need the original definition and its bytes. */
export function semanticProblemsFor(
  original: WorkflowDefinition,
  originalText: string,
  resultText: string,
  edits: readonly ByteEdit[],
): string[] {
  return semanticProblems({ original, originalText, resultText, edits });
}
