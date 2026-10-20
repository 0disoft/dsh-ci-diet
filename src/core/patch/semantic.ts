import { parse } from "yaml";
import type { ByteEdit } from "../contracts/schema.ts";
import type { WorkflowDefinition } from "../workflow/model.ts";
import { parseWorkflow } from "../workflow/parse.ts";

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

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    return left.every((value, index) => deepEqual(value, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
  }
  return false;
}

function isAllowedLeaf(path: readonly PathSeg[], allowed: readonly (readonly PathSeg[])[]): boolean {
  return allowed.some((candidate) => isPrefix(candidate, path));
}

function isPrefix(prefix: readonly PathSeg[], path: readonly PathSeg[]): boolean {
  if (prefix.length > path.length) return false;
  return prefix.every((segment, index) => segment === path[index]);
}

function isAllowedAncestor(path: readonly PathSeg[], allowed: readonly (readonly PathSeg[])[]): boolean {
  return allowed.some((candidate) => candidate.length > path.length && isPrefix(path, candidate));
}

function collectDifferences(
  before: unknown,
  after: unknown,
  path: PathSeg[],
  allowed: readonly (readonly PathSeg[])[],
  out: Difference[],
): void {
  if (deepEqual(before, after)) return;
  if (isAllowedLeaf(path, allowed)) return;
  const beforeIsObject = isPlainObject(before);
  const afterIsObject = isPlainObject(after);
  if (beforeIsObject && afterIsObject) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      collectDifferences(before[key], after[key], [...path, key], allowed, out);
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      collectDifferences(before[index], after[index], [...path, index], allowed, out);
    }
    return;
  }
  if (afterIsObject && (before === undefined || before === null)) {
    for (const key of Object.keys(after)) collectDifferences(undefined, after[key], [...path, key], allowed, out);
    return;
  }
  if (beforeIsObject && (after === undefined || after === null)) {
    for (const key of Object.keys(before)) collectDifferences(before[key], undefined, [...path, key], allowed, out);
    return;
  }
  if (isAllowedAncestor(path, allowed)) return;
  out.push({ path, kind: before === undefined ? "added" : after === undefined ? "missing" : "changed" });
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
    if (stepIndex !== null) paths.push(["jobs", jobKey, "steps", stepIndex, "with", "retention-days"]);
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

/** Return every structural difference outside the exact leaves the plan claims. */
export function semanticProblems(input: SemanticInput): string[] {
  const reparsed = parseWorkflow(input.original.path, input.resultText);
  if (reparsed.parseError !== null) return ["edited workflow does not parse: " + reparsed.parseError.message];
  if (reparsed.unsupported.length > 0) return reparsed.unsupported.map((feature) => "edited workflow is unsupported: " + feature.code);

  let before: unknown;
  let after: unknown;
  try {
    before = parse(input.originalText);
    after = parse(input.resultText);
  } catch (error) {
    return ["edited workflow does not parse as YAML: " + (error instanceof Error ? error.message : String(error))];
  }
  const allowed = allowedPaths(input.edits);
  const differences: Difference[] = [];
  collectDifferences(before, after, [], allowed, differences);
  if (differences.length === 0) return [];
  return differences.map((difference) => difference.kind + " outside the allowed edit paths: " + formatPath(difference.path));
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