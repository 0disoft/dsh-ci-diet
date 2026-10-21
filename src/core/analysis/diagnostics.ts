/** Read-only explanation of job attribution and collection coverage. */
import type { Dimension, MissingScope } from "../contracts/schema.ts";
import type { HistoryBundle } from "../history/model.ts";
import { recoverJobKey } from "../workflow/jobkey.ts";
import { expandMatrix } from "../workflow/matrix.ts";
import { isAnalyzable } from "../workflow/model.ts";
import type { WorkflowJob } from "../workflow/model.ts";

const COVERAGE_AXES = ["history", "workflowDefinitions", "changedFiles", "protectionRules", "retentionPolicy"] as const;

export interface AxisDiagnostics {
  readonly axis: (typeof COVERAGE_AXES)[number];
  readonly status: Dimension["status"];
  readonly reasons: readonly string[];
}

export interface MatrixJobDiagnostics {
  readonly key: string;
  readonly template: string | null;
  /** Expanded leg count, or null when the matrix is computed or unsupported. */
  readonly legs: number | null;
  readonly dynamic: boolean;
}

export interface JobKeyMiss {
  readonly workflowPath: string;
  readonly jobName: string;
  readonly occurrences: number;
}

export interface WorkflowDiagnostics {
  readonly path: string;
  readonly analyzableRuns: number;
  readonly jobs: number;
  readonly matched: number;
  readonly unmatched: number;
  readonly matrixJobs: readonly MatrixJobDiagnostics[];
  readonly misses: readonly JobKeyMiss[];
}

export interface DiagnosticsReport {
  readonly runs: number;
  readonly jobs: number;
  readonly matchedJobs: number;
  readonly unmatchedJobs: number;
  /** Jobs on runs whose definition could not be resolved; they cannot be attributed. */
  readonly unattributableJobs: number;
  readonly unresolvedRuns: number;
  readonly matchPercent: number | null;
  readonly coverage: readonly AxisDiagnostics[];
  readonly missingScopes: readonly MissingScope[];
  readonly workflows: readonly WorkflowDiagnostics[];
}

interface WorkflowAccumulator {
  analyzableRuns: number;
  jobs: number;
  matched: number;
  matrixJobs: Map<string, MatrixJobDiagnostics>;
  misses: Map<string, number>;
}

function matrixJobsOf(jobs: readonly WorkflowJob[]): MatrixJobDiagnostics[] {
  const rows: MatrixJobDiagnostics[] = [];
  for (const job of jobs) {
    if (job.matrix === null) continue;
    const combinations = expandMatrix(job.matrix);
    rows.push({
      key: job.key,
      template: job.displayName,
      legs: combinations === null ? null : combinations.length,
      dynamic: job.matrix.dynamic,
    });
  }
  return rows;
}

/** Summarize why displayed job names did or did not resolve to a YAML job key. */
export function buildDiagnostics(history: HistoryBundle): DiagnosticsReport {
  const byPath = new Map<string, WorkflowAccumulator>();
  let jobs = 0;
  let matchedJobs = 0;
  let unattributableJobs = 0;
  let unresolvedRuns = 0;

  for (const run of history.runs) {
    if (run.definition === null || !isAnalyzable(run.definition)) {
      unresolvedRuns += 1;
      unattributableJobs += run.jobs.length;
      continue;
    }
    const definition = run.definition;
    let accumulator = byPath.get(definition.path);
    if (accumulator === undefined) {
      accumulator = { analyzableRuns: 0, jobs: 0, matched: 0, matrixJobs: new Map(), misses: new Map() };
      byPath.set(definition.path, accumulator);
    }
    accumulator.analyzableRuns += 1;
    for (const matrix of matrixJobsOf(definition.jobs)) {
      if (!accumulator.matrixJobs.has(matrix.key)) accumulator.matrixJobs.set(matrix.key, matrix);
    }
    for (const job of run.jobs) {
      jobs += 1;
      accumulator.jobs += 1;
      const match = recoverJobKey(job.name, definition.jobs);
      if (match === null) {
        accumulator.misses.set(job.name, (accumulator.misses.get(job.name) ?? 0) + 1);
      } else {
        matchedJobs += 1;
        accumulator.matched += 1;
      }
    }
  }

  const workflows: WorkflowDiagnostics[] = [];
  for (const [path, accumulator] of [...byPath.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const misses = [...accumulator.misses.entries()]
      .map(([jobName, occurrences]) => ({ workflowPath: path, jobName, occurrences }))
      .sort((a, b) => (b.occurrences - a.occurrences) || (a.jobName < b.jobName ? -1 : a.jobName > b.jobName ? 1 : 0));
    workflows.push({
      path,
      analyzableRuns: accumulator.analyzableRuns,
      jobs: accumulator.jobs,
      matched: accumulator.matched,
      unmatched: accumulator.jobs - accumulator.matched,
      matrixJobs: [...accumulator.matrixJobs.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
      misses,
    });
  }

  const coverage: AxisDiagnostics[] = COVERAGE_AXES.map((axis) => ({
    axis,
    status: history.coverage[axis].status,
    reasons: history.coverage[axis].reasons,
  }));

  return {
    runs: history.runs.length,
    jobs,
    matchedJobs,
    unmatchedJobs: jobs - matchedJobs,
    unattributableJobs,
    unresolvedRuns,
    matchPercent: jobs === 0 ? null : Math.round((matchedJobs / jobs) * 1000) / 10,
    coverage,
    missingScopes: history.missingScopes,
    workflows,
  };
}

/** True when any coverage axis is incomplete. */
export function diagnosticsIncomplete(report: DiagnosticsReport): boolean {
  return report.coverage.some((axis) => axis.status !== "complete") || report.unresolvedRuns > 0;
}
