import type { Config, Dimension, MissingScope } from "../contracts/schema.ts";
import { assertValidDocument } from "../contracts/validate.ts";
import { parseWorkflow } from "../workflow/parse.ts";
import type { WorkflowDefinition } from "../workflow/model.ts";
import { GitHubError } from "../../adapters/github/errors.ts";
import { RequestBudget } from "../../adapters/github/budget.ts";
import { API_VERSION, GhTransport, readGhVersion } from "../../adapters/github/transport.ts";
import { GitHubClient } from "../../adapters/github/client.ts";
import type { GitHubRun } from "../../adapters/github/client.ts";
import { durationMillisBetween, skuForLabels } from "./model.ts";
import { DEFAULT_SYNC_DEADLINE_MS } from "../policy/constants.ts";
import { withDeadline } from "../support/deadline.ts";
import { mapWithConcurrency } from "../support/concurrency.ts";
import type { ArtifactRecord, HistoryBundle, HistoryJob, HistoryPull, HistoryRun, ProtectionSnapshot, RetentionSnapshot } from "./model.ts";

const PAGE_SIZE = 100;
const JOB_PAGE_SIZE = 100;
const MAX_ARTIFACT_PAGES = 3;

export interface SyncResult {
  readonly history: HistoryBundle;
  readonly budget: RequestBudget;
  readonly ghVersion: string;
}

function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Keep the machine code with the human message when a collection step degrades. */
function failureReason(error: unknown, fallback: string): string {
  if (error instanceof GitHubError) return error.code + ": " + error.message;
  return error instanceof Error ? error.message : fallback;
}

function missingScope(partial: Omit<MissingScope, "runId" | "attempt" | "path" | "pullRequest" | "branch" | "from" | "to"> & Partial<MissingScope>): MissingScope {
  return {
    family: partial.family,
    resource: partial.resource,
    runId: partial.runId ?? null,
    attempt: partial.attempt ?? null,
    path: partial.path ?? null,
    pullRequest: partial.pullRequest ?? null,
    branch: partial.branch ?? null,
    from: partial.from ?? null,
    to: partial.to ?? null,
    reason: partial.reason,
    resumable: partial.resumable,
  };
}

/**
 * Strip a ref suffix GitHub appends to run.path (for example ".github/workflows/ci.yml@main").
 * A trailing "@x" that names a branch/ref is a suffix, not part of the filename, but a real
 * "@" inside a filename must survive.
 */
function splitWorkflowRef(path: string, headBranch: string | null): string {
  const at = path.lastIndexOf("@");
  if (at <= 0) return path;
  const suffix = path.slice(at + 1);
  const looksLikeRef = suffix.startsWith("refs/") || suffix === headBranch || /^[0-9a-f]{40}$/.test(suffix);
  return looksLikeRef ? path.slice(0, at) : path;
}

/** Resolve the repository-relative workflow file a run executed. */
function workflowFilePath(run: GitHubRun, knownPaths: ReadonlyMap<number, string>): string {
  // The workflows listing maps workflow_id to the canonical path; prefer it so a
  // filename that genuinely contains "@" (or a path with no ref suffix) is not mangled.
  const listed = run.workflow_id === undefined ? undefined : knownPaths.get(run.workflow_id);
  return listed ?? splitWorkflowRef(run.path, run.head_branch);
}

export interface SyncOptions {
  readonly owner: string;
  readonly repo: string;
  readonly config: Config;
  readonly now: Date;
  readonly transport?: GhTransport;
  readonly runner?: import("../../adapters/github/transport.ts").GhRunner;
  /** Cancels collection between requests, waits, and stages. */
  readonly signal?: AbortSignal;
  /** Overall bound for the whole collection; defaults to five minutes. */
  readonly deadlineMs?: number;
  /** Called after each run is collected, for interactive progress only. */
  readonly onProgress?: (snapshot: { readonly runsProcessed: number; readonly runsTotal: number; readonly jobsFetched: number }) => void;
}

/** Collect one bounded history window through the read-only transport. */
export async function syncRepositoryHistory(options: SyncOptions): Promise<SyncResult> {
  const deadline = withDeadline(options.signal, options.deadlineMs ?? DEFAULT_SYNC_DEADLINE_MS, "history sync");
  try {
    return await collectHistory(options, deadline.signal);
  } finally {
    deadline.dispose();
  }
}

async function collectHistory(options: SyncOptions, signal: AbortSignal): Promise<SyncResult> {
  const { config, now } = options;
  signal.throwIfAborted();
  assertValidDocument("Config", config);
  const historyConfig = config.history;
  const budget = new RequestBudget(historyConfig.quotas, historyConfig.maxRequests);
  const concurrency = Math.max(1, Math.min(4, Math.floor(historyConfig.concurrentRequests)));
  const ghVersion = options.transport === undefined ? await readGhVersion(options.runner, signal, historyConfig.requestTimeoutMs) : null;
  const versionLabel = ghVersion ?? "unknown";
  const transport = options.transport ?? new GhTransport({
    budget,
    timeoutMs: historyConfig.requestTimeoutMs,
    retries: historyConfig.additionalRetries,
    cache: true,
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    ...(signal === undefined ? {} : { signal }),
  });
  const effectiveClient = new GitHubClient(transport, options.owner, options.repo);
  const requestedTo = now;
  const requestedFrom = new Date(requestedTo.getTime() - historyConfig.lookbackDays * 86_400_000);
  const missingScopes: MissingScope[] = [];
  let jobsPageTruncated = false;
  let pullFilesTruncated = false;

  const repository = await effectiveClient.repository();
  const defaultBranch = repository.default_branch;

  const workflows: Array<{ id: number; name: string; path: string; state: string }> = [];
  for (let page = 1; page <= 10; page += 1) {
    signal?.throwIfAborted();
    const result = await effectiveClient.workflows(page, PAGE_SIZE);
    for (const workflow of result.items) workflows.push({ id: workflow.id, name: workflow.name, path: workflow.path, state: workflow.state });
    if (!result.hasNext) break;
    if (page === 10) {
      missingScopes.push(missingScope({ family: "discovery", resource: "actions.workflows", reason: "WORKFLOW_LIMIT_REACHED", resumable: true }));
    }
  }

  const runs: GitHubRun[] = [];
  const runIds = new Set<number>();
  let runPaginationChanged = false;
  let truncatedByLimit = false;
  let historyError: string | null = null;
  try {
    for (let page = 1; runs.length < historyConfig.maxRuns; page += 1) {
      signal?.throwIfAborted();
      const result = await effectiveClient.runs({
        page,
        perPage: PAGE_SIZE,
        createdAfter: isoSeconds(requestedFrom),
      });
      // Count rows this window refused so dropping the tail is reported even when
      // GitHub served the final page (hasNext is false).
      const previousCount = runs.length;
      let dropped = 0;
      for (const run of result.items) {
        // Offset pages can overlap while new runs arrive. Keep the first
        // observation, never spend a sample slot or job request on its repeat.
        if (runIds.has(run.id)) {
          runPaginationChanged = true;
          continue;
        }
        if (runs.length >= historyConfig.maxRuns) {
          dropped += 1;
          continue;
        }
        runIds.add(run.id);
        runs.push(run);
      }
      if (dropped > 0 || (runs.length >= historyConfig.maxRuns && result.hasNext)) truncatedByLimit = true;
      if (runs.length >= historyConfig.maxRuns) break;
      if (!result.hasNext) break;
      // Deduplication must not turn repeating/empty next pages into an endless
      // walk. Keep the collected evidence and disclose the unstable listing.
      if (runs.length === previousCount) {
        runPaginationChanged = true;
        break;
      }
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof GitHubError && error.code === "AUTH_REQUIRED") throw error;
    historyError = failureReason(error, "HISTORY_UNAVAILABLE");
  }
  // Discovery is finished; unused discovery quota may fund the jobs stage.
  budget.finish("discovery");

  const historyRuns: HistoryRun[] = [];
  let jobsFetched = 0;
  const definitions = new Map<string, WorkflowDefinition | null>();
  const pulls = new Map<number, HistoryPull>();
  const pullNumbers = new Set<number>();
  const workflowPaths = new Map<number, string>();
  for (const workflow of workflows) workflowPaths.set(workflow.id, workflow.path);

  interface CollectedRun {
    readonly run: GitHubRun;
    readonly workflowPath: string;
    readonly attempts: number;
    readonly jobs: HistoryJob[];
    readonly pullRequestNumbers: readonly number[];
    readonly jobsFetched: number;
    readonly jobsPageTruncated: boolean;
    readonly runMissingScopes: readonly MissingScope[];
  }

  const collectedRuns = await mapWithConcurrency(runs, concurrency, async (run): Promise<CollectedRun> => {
    signal?.throwIfAborted();
    const workflowPath = workflowFilePath(run, workflowPaths);
    const pullRequestNumbers = (run.pull_requests ?? []).map((pull) => pull.number);
    const jobs: HistoryJob[] = [];
    const runMissingScopes: MissingScope[] = [];
    let fetched = 0;
    let pageTruncated = false;
    const attempts = Math.max(1, run.run_attempt);
    for (let attempt = attempts; attempt >= 1; attempt -= 1) {
      signal?.throwIfAborted();
      const jobIds = new Set<number>();
      let paginationChanged = false;
      try {
        for (let page = 1; page <= 10; page += 1) {
          const result = await effectiveClient.attemptJobs(run.id, attempt, page, JOB_PAGE_SIZE);
          const previousCount = jobIds.size;
          for (const job of result.items) {
            // Keep one observation per attempt/job, so overlapping pages cannot
            // inflate timeout cohorts or scenario evidence.
            if (jobIds.has(job.id)) {
              paginationChanged = true;
              continue;
            }
            jobIds.add(job.id);
            fetched += 1;
            const durationMillis = job.started_at === null ? null : durationMillisBetween(job.started_at, job.completed_at);
            jobs.push({
              jobId: String(job.id),
              runId: String(run.id),
              attempt,
              name: job.name,
              workflowPath,
              conclusion: job.conclusion,
              startedAt: job.started_at ?? "",
              completedAt: job.completed_at,
              durationMillis,
              labels: job.labels ?? [],
              runnerName: job.runner_name ?? null,
              sku: skuForLabels(job.labels ?? []),
            });
          }
          if (!result.hasNext) break;
          if (jobIds.size === previousCount) {
            paginationChanged = true;
            break;
          }
          if (page === 10) {
            pageTruncated = true;
            runMissingScopes.push(missingScope({ family: "jobs", resource: "actions.runs.jobs", runId: String(run.id), attempt, reason: "JOB_PAGE_LIMIT_REACHED", resumable: true }));
          }
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof GitHubError && error.code === "AUTH_REQUIRED") throw error;
        runMissingScopes.push(missingScope({ family: "jobs", resource: "actions.runs.jobs", runId: String(run.id), attempt, reason: failureReason(error, "JOBS_UNAVAILABLE"), resumable: true }));
      }
      if (paginationChanged) {
        runMissingScopes.push(missingScope({ family: "jobs", resource: "actions.runs.jobs", runId: String(run.id), attempt, reason: "JOB_PAGINATION_CHANGED", resumable: true }));
      }
    }
    return { run, workflowPath, attempts, jobs, pullRequestNumbers, jobsFetched: fetched, jobsPageTruncated: pageTruncated, runMissingScopes };
  }, { signal });

  // Merge per-run results in the repository order the listing returned.
  for (const entry of collectedRuns) {
    for (const number of entry.pullRequestNumbers) pullNumbers.add(number);
    jobsFetched += entry.jobsFetched;
    if (entry.jobsPageTruncated) jobsPageTruncated = true;
    for (const scope of entry.runMissingScopes) missingScopes.push(scope);
  }
  // Jobs are finished; quota this stage never used can fund the definitions stage.
  budget.finish("jobs");

  interface PendingDefinition {
    readonly key: string;
    readonly path: string;
    readonly sha: string;
    readonly firstRun: GitHubRun;
  }

  // Deduplicate identical path@sha reads in run order before launching them.
  const pendingDefinitions = new Map<string, PendingDefinition>();
  for (const entry of collectedRuns) {
    const key = entry.workflowPath + "@" + entry.run.head_sha;
    if (!pendingDefinitions.has(key)) {
      pendingDefinitions.set(key, { key, path: entry.workflowPath, sha: entry.run.head_sha, firstRun: entry.run });
    }
  }
  const resolvedDefinitions = await mapWithConcurrency([...pendingDefinitions.values()], concurrency, async (work) => {
    signal?.throwIfAborted();
    try {
      const content = await effectiveClient.contents(work.path, work.sha);
      return { key: work.key, definition: content === null ? null : parseWorkflow(work.path, content.text), scope: null };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof GitHubError && error.code === "AUTH_REQUIRED") throw error;
      return {
        key: work.key,
        definition: null,
        scope: missingScope({ family: "definitions", resource: "contents", runId: String(work.firstRun.id), path: work.path, reason: failureReason(error, "DEFINITION_UNAVAILABLE"), resumable: true }),
      };
    }
  }, { signal });
  for (const item of resolvedDefinitions) {
    definitions.set(item.key, item.definition);
    if (item.scope !== null) missingScopes.push(item.scope);
  }

  // Build the report in repository order even though reads finished out of order.
  for (const entry of collectedRuns) {
    signal?.throwIfAborted();
    const { run, workflowPath } = entry;
    const definition = definitions.get(workflowPath + "@" + run.head_sha) ?? null;
    historyRuns.push({
      runId: String(run.id),
      workflowPath,
      workflowName: run.name,
      headSha: run.head_sha,
      headBranch: run.head_branch,
      event: run.event,
      createdAt: run.created_at,
      attempt: entry.attempts,
      conclusion: run.conclusion,
      pullRequestNumbers: entry.pullRequestNumbers,
      jobs: entry.jobs,
      definition,
      definitionResolution: definition === null ? "unresolved" : "resolved",
    });
    options.onProgress?.({ runsProcessed: historyRuns.length, runsTotal: runs.length, jobsFetched });
  }
  // Definitions are finished; the policy/files stage inherits the remainder.
  budget.finish("definitions");

  interface CollectedPull {
    readonly number: number;
    readonly pull: HistoryPull | null;
    readonly scopes: readonly MissingScope[];
  }

  const collectedPulls = await mapWithConcurrency([...pullNumbers], concurrency, async (number): Promise<CollectedPull> => {
    signal?.throwIfAborted();
    const scopes: MissingScope[] = [];
    try {
      const pull = await effectiveClient.pull(number);
      let files: string[] | null = null;
      try {
        const collected: string[] = [];
        for (let page = 1; page <= 30; page += 1) {
          signal?.throwIfAborted();
          const result = await effectiveClient.pullFiles(number, page, PAGE_SIZE);
          for (const file of result.items) {
            collected.push(file.filename);
            if (file.previous_filename !== undefined) collected.push(file.previous_filename);
          }
          if (!result.hasNext) break;
          if (page === 30) {
            pullFilesTruncated = true;
            scopes.push(missingScope({ family: "policyAndFiles", resource: "pulls.files", pullRequest: number, reason: "PULL_FILES_LIMIT_REACHED", resumable: true }));
          }
        }
        files = collected;
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof GitHubError && error.code === "AUTH_REQUIRED") throw error;
        scopes.push(missingScope({ family: "policyAndFiles", resource: "pulls.files", pullRequest: number, reason: failureReason(error, "PULL_FILES_UNAVAILABLE"), resumable: true }));
      }
      return { number, pull: { number, baseBranch: pull.baseBranch, headBranch: pull.headBranch, files }, scopes };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof GitHubError && error.code === "AUTH_REQUIRED") throw error;
      scopes.push(missingScope({ family: "policyAndFiles", resource: "pulls", pullRequest: number, reason: failureReason(error, "PULL_UNAVAILABLE"), resumable: true }));
      return { number, pull: null, scopes };
    }
  }, { signal });

  // Insert in pull-number order so the Map iterates deterministically.
  for (const item of collectedPulls) {
    if (item.pull !== null) pulls.set(item.number, item.pull);
    for (const scope of item.scopes) missingScopes.push(scope);
  }

  let retention: RetentionSnapshot | null = null;
  let retentionStatus: Dimension["status"] = "unavailable";
  const retentionReasons: string[] = [];
  signal?.throwIfAborted();
  try {
    const policy = await effectiveClient.retentionPolicy();
    retention = { days: policy.days, maximumAllowedDays: policy.maximum_allowed_days, fetchedAt: now.toISOString() };
    retentionStatus = "complete";
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof GitHubError && error.code === "AUTH_REQUIRED") throw error;
    retentionStatus = error instanceof GitHubError && error.code === "PERMISSION_DENIED" ? "partial" : "unavailable";
    retentionReasons.push(failureReason(error, "RETENTION_UNAVAILABLE"));
  }

  let protection: ProtectionSnapshot | null = null;
  let protectionStatus: Dimension["status"] = "unavailable";
  const protectionReasons: string[] = [];
  signal?.throwIfAborted();
  try {
    const rules = await effectiveClient.branchRules(defaultBranch);
    let classic: boolean | null = null;
    try {
      classic = (await effectiveClient.branchProtection(defaultBranch)) !== null;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof GitHubError && error.code === "AUTH_REQUIRED") throw error;
      protectionReasons.push(failureReason(error, "BRANCH_PROTECTION_UNAVAILABLE"));
    }
    protection = { defaultBranch, ruleCount: rules.length, classicProtection: classic, fetchedAt: now.toISOString() };
    protectionStatus = classic === null ? "partial" : "complete";
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof GitHubError && error.code === "AUTH_REQUIRED") throw error;
    protectionStatus = error instanceof GitHubError && error.code === "PERMISSION_DENIED" ? "partial" : "unavailable";
    protectionReasons.push(failureReason(error, "PROTECTION_UNAVAILABLE"));
  }

  const artifacts: ArtifactRecord[] = [];
  let artifactsTruncated = false;
  signal?.throwIfAborted();
  try {
    for (let page = 1; page <= MAX_ARTIFACT_PAGES; page += 1) {
      signal?.throwIfAborted();
      const result = await effectiveClient.artifacts(page, PAGE_SIZE);
      for (const artifact of result.items) {
        artifacts.push({
          artifactId: String(artifact.id),
          name: artifact.name,
          sizeBytes: artifact.size_in_bytes,
          createdAt: artifact.created_at,
          expiresAt: artifact.expires_at,
          runId: null,
        });
      }
      if (!result.hasNext) break;
      if (page === MAX_ARTIFACT_PAGES) artifactsTruncated = true;
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof GitHubError && error.code === "AUTH_REQUIRED") throw error;
    missingScopes.push(missingScope({ family: "policyAndFiles", resource: "actions.artifacts", reason: failureReason(error, "ARTIFACTS_UNAVAILABLE"), resumable: true }));
  }

  const unresolvedDefinitions = historyRuns.filter((run) => run.definitionResolution === "unresolved").length;
  const pullsWithoutFiles = [...pulls.values()].filter((pull) => pull.files === null).length;
  const pullsMissing = pullNumbers.size - pulls.size;
  const historyReasons: string[] = [];
  if (historyError !== null) historyReasons.push(historyError);
  if (truncatedByLimit) historyReasons.push("RUN_LIMIT_REACHED");
  if (runPaginationChanged) historyReasons.push("RUN_PAGINATION_CHANGED");
  if (jobsPageTruncated) historyReasons.push("JOB_PAGE_LIMIT_REACHED");
  if (missingScopes.some((scope) => scope.reason === "JOB_PAGINATION_CHANGED")) historyReasons.push("JOB_PAGINATION_CHANGED");
  if (artifactsTruncated) historyReasons.push("ARTIFACT_RUN_LIMIT_REACHED");
  const historyStatus: Dimension["status"] =
    historyError !== null
      ? "unavailable"
      : truncatedByLimit || runPaginationChanged || jobsPageTruncated || artifactsTruncated || missingScopes.some((scope) => scope.family === "jobs")
        ? "partial"
        : "complete";
  const definitionsStatus: Dimension["status"] = historyRuns.length === 0 ? "unavailable" : unresolvedDefinitions > 0 ? "partial" : "complete";
  const changedFilesStatus: Dimension["status"] =
    pullNumbers.size === 0 ? "unavailable" : pullsMissing > 0 || pullsWithoutFiles > 0 || pullFilesTruncated ? "partial" : "complete";

  const coverageReasons = (status: Dimension["status"], reasons: readonly string[]): string[] =>
    status === "complete" ? [] : reasons.length === 0 ? [status === "partial" ? "PARTIAL_COLLECTION" : "UNAVAILABLE"] : [...reasons];

  const history: HistoryBundle = {
    apiVersion: API_VERSION,
    ghVersion: versionLabel,
    repositoryId: String(repository.id),
    repositoryFullName: repository.full_name,
    defaultBranch,
    requestedFrom: requestedFrom.toISOString(),
    requestedTo: requestedTo.toISOString(),
    runs: historyRuns,
    pulls,
    workflows,
    artifacts,
    retention,
    protection,
    coverage: {
      history: {
        status: historyStatus,
        scope: historyConfig.lookbackDays + "d recent runs",
        fetched: historyRuns.length,
        expected: null,
        reasons: coverageReasons(historyStatus, historyReasons),
        missingScopes: missingScopes.filter((scope) => scope.family === "jobs"),
      },
      workflowDefinitions: {
        status: definitionsStatus,
        scope: "definitions referenced by selected runs",
        fetched: historyRuns.length - unresolvedDefinitions,
        expected: historyRuns.length,
        reasons: coverageReasons(definitionsStatus, unresolvedDefinitions > 0 ? ["UNRESOLVED_WORKFLOW_REF"] : []),
        missingScopes: missingScopes.filter((scope) => scope.family === "definitions"),
      },
      changedFiles: {
        status: changedFilesStatus,
        scope: "pull request files for pull_request runs",
        fetched: pulls.size - pullsWithoutFiles,
        expected: pullNumbers.size,
        reasons: coverageReasons(
          changedFilesStatus,
          pullsMissing > 0
            ? ["PULL_UNAVAILABLE"]
            : pullsWithoutFiles > 0
              ? ["PULL_FILES_UNAVAILABLE"]
              : pullFilesTruncated
                ? ["PULL_FILES_LIMIT_REACHED"]
                : ["NO_PULL_REQUESTS"],
        ),
        missingScopes: missingScopes.filter((scope) => scope.family === "policyAndFiles" && scope.pullRequest !== null),
      },
      protectionRules: {
        status: protectionStatus,
        scope: "rules and classic protection for " + defaultBranch,
        fetched: protection === null ? 0 : 1,
        expected: 1,
        reasons: coverageReasons(protectionStatus, protectionReasons),
        missingScopes: [],
      },
      retentionPolicy: {
        status: retentionStatus,
        scope: "repository artifact retention",
        fetched: retention === null ? 0 : 1,
        expected: 1,
        reasons: coverageReasons(retentionStatus, retentionReasons),
        missingScopes: [],
      },
    },
    missingScopes,
  };

  return { history, budget, ghVersion: versionLabel };
}
