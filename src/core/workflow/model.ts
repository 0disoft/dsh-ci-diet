/** Structural view of one workflow file, anchored to the bytes it came from. */
import type { CanonicalJsonValue } from "../../shared/cdj1.ts";

/** Half-open byte range inside the workflow file, relative to its first byte. */
export interface ByteRange {
  readonly startByte: number;
  readonly endByte: number;
}

export type UnsupportedCode =
  | "multiple-documents"
  | "duplicate-key"
  | "anchor"
  | "alias"
  | "custom-tag"
  | "merge-key"
  | "jobs-not-a-mapping";

export interface UnsupportedFeature {
  readonly code: UnsupportedCode;
  readonly detail: string;
  readonly range: ByteRange | null;
}

export interface MatrixAxis {
  readonly name: string;
  readonly values: readonly CanonicalJsonValue[];
}

export interface MatrixPlan {
  readonly axes: readonly MatrixAxis[];
  readonly include: readonly Readonly<Record<string, CanonicalJsonValue>>[];
  readonly exclude: readonly Readonly<Record<string, CanonicalJsonValue>>[];
  /** True when an axis, include value, or the matrix itself is computed. */
  readonly dynamic: boolean;
}

/** How one `with:` value resolved; only literals are candidates for a patch. */
export type StepValueKind = "literal" | "expression" | "non-scalar";

export interface StepWithEntry {
  readonly key: string;
  readonly keyRange: ByteRange;
  readonly kind: StepValueKind;
  /** Scalar text when kind is literal, otherwise null. */
  readonly literal: string | null;
  readonly valueRange: ByteRange | null;
}

export interface WorkflowStep {
  /** Zero-based position inside the job's `steps:` sequence. */
  readonly index: number;
  readonly name: string | null;
  /** Literal `uses:` reference, null when computed or absent. */
  readonly uses: string | null;
  readonly usesRange: ByteRange | null;
  readonly run: string | null;
  readonly withPresent: boolean;
  readonly withEntries: readonly StepWithEntry[];
  readonly withRange: ByteRange | null;
  /** True when `with:` is a flow mapping, which v0.1 never edits. */
  readonly withFlow: boolean;
  /** True when the step itself is a flow mapping. */
  readonly flow: boolean;
  readonly range: ByteRange | null;
}

export interface WorkflowJob {
  readonly key: string;
  readonly keyRange: ByteRange;
  /** Literal `name:` template, or null when the job has no name. */
  readonly displayName: string | null;
  readonly displayNameRange: ByteRange | null;
  readonly timeoutMinutes: number | null;
  readonly timeoutRange: ByteRange | null;
  readonly matrix: MatrixPlan | null;
  readonly needs: readonly string[];
  /** Literal `runs-on:` scalar, null when it is an expression or a list. */
  readonly runsOn: string | null;
  readonly runsOnRange: ByteRange | null;
  /** Environment name when the job declares an environment. */
  readonly environment: string | null;
  readonly environmentRange: ByteRange | null;
  /** `uses:` of a reusable workflow job, when present. */
  readonly reusableWorkflow: string | null;
  readonly steps: readonly WorkflowStep[];
}

export interface WorkflowConcurrency {
  readonly group: string | null;
  readonly cancelInProgress: boolean | null;
  /** Queue policy when present; v0.1 never writes a queue policy. */
  readonly queue: string | null;
  readonly range: ByteRange;
}

export interface WorkflowParseError {
  readonly message: string;
  readonly line: number | null;
}

export interface WorkflowDefinition {
  readonly path: string;
  /** sha256 of the UTF-8 bytes the parser read. */
  readonly sha256: string;
  readonly bytes: number;
  readonly name: string | null;
  readonly triggers: readonly string[];
  /** Explicit `on.pull_request.types`, or null when the trigger uses defaults. */
  readonly pullRequestTypes: readonly string[] | null;
  readonly concurrency: WorkflowConcurrency | null;
  readonly jobs: readonly WorkflowJob[];
  readonly unsupported: readonly UnsupportedFeature[];
  readonly parseError: WorkflowParseError | null;
}

/** True when the definition can be analyzed without a caveat. */
export function isAnalyzable(workflow: WorkflowDefinition): boolean {
  return workflow.parseError === null && workflow.unsupported.length === 0;
}
