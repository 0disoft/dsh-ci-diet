/** Read-only explanation of job attribution and collection coverage. */
import type { Dimension, MissingScope } from "../contracts/schema.ts";
import type { HistoryBundle } from "../history/model.ts";
import { recoverJobKey } from "../workflow/jobkey.ts";
import { expandMatrix } from "../workflow/matrix.ts";
import { isAnalyzable } from "../workflow/model.ts";
import type { WorkflowDefinition, WorkflowJob, WorkflowStep } from "../workflow/model.ts";

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

export type CacheHintCode = "CACHE_MISSING" | "CACHE_KEY_UNPINNED";

export interface CacheHint {
  readonly workflowPath: string;
  readonly code: CacheHintCode;
  readonly jobs: readonly string[];
  readonly steps: readonly string[];
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
  /** Advisory cache checks; the contract has no cache rule id, so these never become findings. */
  readonly cacheHints: readonly CacheHint[];
}

interface WorkflowAccumulator {
  analyzableRuns: number;
  jobs: number;
  matched: number;
  matrixJobs: Map<string, MatrixJobDiagnostics>;
  misses: Map<string, number>;
}

/** The report keeps the first matrix for each job key; later runs need no expansion. */
function collectMatrixJobs(jobs: readonly WorkflowJob[], rows: Map<string, MatrixJobDiagnostics>): void {
  for (const job of jobs) {
    if (job.matrix === null || rows.has(job.key)) continue;
    const combinations = expandMatrix(job.matrix);
    rows.set(job.key, {
      key: job.key,
      template: job.displayName,
      legs: combinations === null ? null : combinations.length,
      dynamic: job.matrix.dynamic,
    });
  }
}

const CACHE_ACTION = /^actions\/cache(?:@|\/)/;
const SETUP_CACHE_ACTION = /^actions\/setup-(?:node|python|java|go|dotnet|ruby)(?:@|$)/;
const INSTALL_COMMAND = /(?:npm\s+(?:ci|install|i)\b|yarn(?:\s|$)|pnpm\s+(?:install|i)\b|pip3?\s+install\b|uv\s+pip\s+install\b|poetry\s+install\b|cargo\s+(?:build|test|check)\b|go\s+(?:mod\s+download|build)\b|mvn\b|gradlew?\b|dotnet\s+restore\b|composer\s+install\b|bundle\s+install\b)/;

function stepLabel(step: WorkflowStep): string {
  if (step.name !== null) return step.name;
  if (step.run !== null) {
    const newline = step.run.indexOf("\n");
    const first = (newline === -1 ? step.run : step.run.slice(0, newline)).trim();
    if (first !== "") return first.length > 60 ? first.slice(0, 57) + "..." : first;
  }
  return "step " + String(step.index + 1);
}

function withEntry(step: WorkflowStep, key: string): WorkflowStep["withEntries"][number] | null {
  return step.withEntries.find((entry) => entry.key === key) ?? null;
}

function hasSetupCache(step: WorkflowStep): boolean {
  if (step.uses === null || !SETUP_CACHE_ACTION.test(step.uses)) return false;
  const cache = withEntry(step, "cache");
  if (cache === null || cache.kind !== "literal") return false;
  const value = (cache.literal ?? "").trim().toLowerCase();
  return value !== "" && value !== "false";
}

/**
 * Advisory cache checks from workflow text.
 *
 * CACHE_MISSING means a job installs dependencies but neither uses actions/cache
 * nor a setup action's built-in cache option. CACHE_KEY_UNPINNED means an
 * actions/cache key is literal and does not mention hashFiles, so a lockfile
 * change cannot invalidate it automatically.
 */
function cacheHintsFor(definition: WorkflowDefinition): CacheHint[] {
  const missing = { jobs: new Set<string>(), steps: new Set<string>() };
  const unpinned = { jobs: new Set<string>(), steps: new Set<string>() };
  for (const job of definition.jobs) {
    const jobLabel = job.displayName ?? job.key;
    const installs = job.steps.filter((step) => step.run !== null && INSTALL_COMMAND.test(step.run));
    const caches = job.steps.filter((step) => step.uses !== null && CACHE_ACTION.test(step.uses));
    const setupCached = job.steps.some(hasSetupCache);
    if (installs.length > 0 && caches.length === 0 && !setupCached) {
      missing.jobs.add(jobLabel);
      for (const step of installs) missing.steps.add(stepLabel(step));
    }
    for (const step of caches) {
      const key = withEntry(step, "key");
      const literal = key !== null && key.kind === "literal" ? (key.literal ?? "") : null;
      const pinned = key !== null && (key.kind === "expression" || (literal !== null && literal.toLowerCase().includes("hashfiles(")));
      if (!pinned) {
        unpinned.jobs.add(jobLabel);
        unpinned.steps.add(stepLabel(step));
      }
    }
  }
  const hints: CacheHint[] = [];
  if (missing.jobs.size > 0) {
    hints.push({ workflowPath: definition.path, code: "CACHE_MISSING", jobs: [...missing.jobs].sort(), steps: [...missing.steps].sort() });
  }
  if (unpinned.jobs.size > 0) {
    hints.push({ workflowPath: definition.path, code: "CACHE_KEY_UNPINNED", jobs: [...unpinned.jobs].sort(), steps: [...unpinned.steps].sort() });
  }
  return hints;
}

/** Summarize why displayed job names did or did not resolve to a YAML job key. */
export function buildDiagnostics(history: HistoryBundle): DiagnosticsReport {
  const byPath = new Map<string, WorkflowAccumulator>();
  const definitions = new Map<string, WorkflowDefinition>();
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
    definitions.set(definition.path, definition);
    let accumulator = byPath.get(definition.path);
    if (accumulator === undefined) {
      accumulator = { analyzableRuns: 0, jobs: 0, matched: 0, matrixJobs: new Map(), misses: new Map() };
      byPath.set(definition.path, accumulator);
    }
    accumulator.analyzableRuns += 1;
    collectMatrixJobs(definition.jobs, accumulator.matrixJobs);
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

  const cacheHints = [...definitions.values()]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .flatMap(cacheHintsFor);

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
    cacheHints,
  };
}

/** True when any coverage axis is incomplete. */
export function diagnosticsIncomplete(report: DiagnosticsReport): boolean {
  return report.coverage.some((axis) => axis.status !== "complete") || report.unresolvedRuns > 0;
}
