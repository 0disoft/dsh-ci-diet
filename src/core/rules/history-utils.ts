/** Shared helpers for rules that read GitHub run history. */
import { digestOf } from "../../shared/cdj1.ts";
import type { Coverage } from "../contracts/schema.ts";
import type { HistoryBundle, HistoryJob, HistoryRun } from "../history/model.ts";
import type { WorkflowDefinition, WorkflowJob } from "../workflow/model.ts";
import { isAnalyzable } from "../workflow/index.ts";
import type { RuleContext } from "./types.ts";

/** Parse an ISO timestamp, returning null when it is not finite. */
export function millis(iso: string): number | null {
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : null;
}

/** Seconds a job occupied a runner, or null when GitHub did not report both ends. */
export function jobSeconds(job: HistoryJob): number | null {
  if (job.durationMillis !== null && job.durationMillis >= 0) return job.durationMillis / 1000;
  const start = millis(job.startedAt);
  if (start === null || job.completedAt === null) return null;
  const end = millis(job.completedAt);
  if (end === null || end < start) return null;
  return (end - start) / 1000;
}

/** Nearest-rank p95 over seconds; values are not required to be sorted. */
export function nearestRankP95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[Math.max(0, rank - 1)] ?? null;
}

/** Runs with a parsed definition, which history rules need for attribution. */
export function analyzableRuns(history: HistoryBundle): { run: HistoryRun; definition: WorkflowDefinition }[] {
  const rows: { run: HistoryRun; definition: WorkflowDefinition }[] = [];
  for (const run of history.runs) {
    if (run.definition === null || !isAnalyzable(run.definition)) continue;
    rows.push({ run, definition: run.definition });
  }
  return rows;
}

const RISKY_JOB_TEXT = /deploy|release|publish|migrat|sign|notari|credential|secret|permission/i;

/** True when a job likely has side effects a cancellation would interrupt. */
export function jobLooksRisky(job: WorkflowJob): boolean {
  const text = [job.key, job.displayName ?? "", job.environment ?? ""].join(" ");
  if (RISKY_JOB_TEXT.test(text)) return true;
  for (const step of job.steps) {
    if (step.name !== null && RISKY_JOB_TEXT.test(step.name)) return true;
    if (step.uses !== null && RISKY_JOB_TEXT.test(step.uses)) return true;
    if (step.run !== null && RISKY_JOB_TEXT.test(step.run)) return true;
  }
  return false;
}

/** Rule input hash: workflow hashes plus the observed run set. */
export function historyInputHash(context: RuleContext, ruleId: string): string {
  return digestOf({
    ruleId,
    workflows: context.workflows
      .filter(isAnalyzable)
      .map((workflow) => ({ path: workflow.path, sha256: workflow.sha256 }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    runs: (context.history?.runs ?? [])
      .map((run) => ({ runId: run.runId, headSha: run.headSha, attempt: run.attempt }))
      .sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0)),
  });
}

/** True when every dimension needed for a write is complete. */
export function completeForWrite(coverage: Coverage): boolean {
  return coverage.history.status === "complete" && coverage.workflowDefinitions.status === "complete";
}

export function knownSecondsOrNull(value: number): number {
  return value;
}
