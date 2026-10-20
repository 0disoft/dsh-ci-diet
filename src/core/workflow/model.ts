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

export interface WorkflowJob {
  readonly key: string;
  readonly keyRange: ByteRange;
  /** Literal `name:` template, or null when the job has no name. */
  readonly displayName: string | null;
  readonly displayNameRange: ByteRange | null;
  readonly timeoutMinutes: number | null;
  readonly timeoutRange: ByteRange | null;
  readonly matrix: MatrixPlan | null;
}

export interface WorkflowConcurrency {
  readonly group: string | null;
  readonly cancelInProgress: boolean | null;
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
  readonly concurrency: WorkflowConcurrency | null;
  readonly jobs: readonly WorkflowJob[];
  readonly unsupported: readonly UnsupportedFeature[];
  readonly parseError: WorkflowParseError | null;
}
