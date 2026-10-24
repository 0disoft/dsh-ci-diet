import type { Dimension, MissingScope } from "../contracts/schema.ts";
import type { WorkflowDefinition } from "../workflow/model.ts";

export interface HistoryJob {
  readonly jobId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly name: string;
  readonly workflowPath: string;
  readonly conclusion: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly durationMillis: number | null;
  readonly labels: readonly string[];
  readonly runnerName: string | null;
  readonly sku: string | null;
}

export interface HistoryPull {
  readonly number: number;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly files: readonly string[] | null;
}

export interface HistoryRun {
  readonly runId: string;
  readonly workflowPath: string;
  readonly workflowName: string | null;
  readonly headSha: string;
  readonly headBranch: string | null;
  readonly event: string;
  readonly createdAt: string;
  readonly attempt: number;
  readonly conclusion: string | null;
  readonly pullRequestNumbers: readonly number[];
  readonly jobs: readonly HistoryJob[];
  readonly definition: WorkflowDefinition | null;
  readonly definitionResolution: "resolved" | "unresolved";
}

export interface ArtifactRecord {
  readonly artifactId: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly runId: string | null;
}

export interface RetentionSnapshot {
  readonly days: number;
  readonly maximumAllowedDays: number;
  readonly fetchedAt: string;
}

export interface ProtectionSnapshot {
  readonly defaultBranch: string;
  readonly ruleCount: number | null;
  readonly classicProtection: boolean | null;
  readonly fetchedAt: string;
}

export interface HistoryBundle {
  /** GitHub REST API version the sync negotiated, or "unknown" for bundles saved before 0.1.0. */
  readonly apiVersion?: string;
  /** `gh --version` string recorded during sync, or "unknown" when it could not be read. */
  readonly ghVersion?: string;
  readonly repositoryId: string;
  readonly repositoryFullName: string;
  readonly defaultBranch: string;
  readonly requestedFrom: string;
  readonly requestedTo: string;
  readonly runs: readonly HistoryRun[];
  readonly pulls: ReadonlyMap<number, HistoryPull>;
  readonly workflows: readonly { id: number; name: string; path: string; state: string }[];
  readonly artifacts: readonly ArtifactRecord[];
  readonly retention: RetentionSnapshot | null;
  readonly protection: ProtectionSnapshot | null;
  readonly coverage: {
    readonly history: Dimension;
    readonly workflowDefinitions: Dimension;
    readonly changedFiles: Dimension;
    readonly protectionRules: Dimension;
    readonly retentionPolicy: Dimension;
  };
  readonly missingScopes: readonly MissingScope[];
}

const RUNNER_SKU_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/^ubuntu-(?:latest|\d{2}\.\d{2})$/, "actions_linux"],
  [/^ubuntu-(?:latest|\d{2}\.\d{2})-arm$/, "actions_linux_arm"],
  [/^ubuntu-slim$/, "actions_linux_slim"],
  [/^windows-(?:latest|\d{4})$/, "actions_windows"],
  [/^windows-(?:latest|\d{2}|\d{4})-arm$/, "actions_windows_arm"],
  [/^macos-(?:latest|\d{2}(?:\.\d+)?)$/, "actions_macos"],
];

/** Normalize only supported, mutually consistent image labels to a SKU candidate. */
export function skuForLabels(labels: readonly string[]): string | null {
  let sku: string | null = null;
  for (const label of labels) {
    const normalized = label.toLowerCase();
    const match = RUNNER_SKU_PATTERNS.find(([pattern]) => pattern.test(normalized));
    // Unknown/custom labels (including self-hosted and larger runner variants)
    // must not inherit a standard rate from an OS or architecture substring.
    if (match === undefined || (sku !== null && sku !== match[1])) return null;
    sku = match[1];
  }
  return sku;
}

/** Convert an RFC 3339 timestamp pair into a non-negative duration. */
export function durationMillisBetween(startedAt: string, completedAt: string | null): number | null {
  if (completedAt === null) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const delta = end - start;
  return delta < 0 ? null : delta;
}

export function emptyDimension(scope: string): Dimension {
  return { status: "unavailable", scope, fetched: 0, expected: null, reasons: [], missingScopes: [] };
}
