import type { Config, Dimension, MissingScope, RepositoryBinding } from "../contracts/schema.ts";
import { parseWorkflow } from "../workflow/parse.ts";
import type { WorkflowDefinition } from "../workflow/model.ts";
import { GitHubError } from "../../adapters/github/errors.ts";
import { RequestBudget } from "../../adapters/github/budget.ts";
import { API_VERSION, GhTransport, readGhVersion } from "../../adapters/github/transport.ts";
import { GitHubClient } from "../../adapters/github/client.ts";
import type { GitHubRun } from "../../adapters/github/client.ts";
import { durationMillisBetween, skuForLabels } from "./model.ts";
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

/** Collect one bounded history window through the read-only transport. */
export async function syncRepositoryHistory(options: {
  readonly owner: string;
  readonly repo: string;
  readonly config: Config;
  readonly now: Date;
  readonly transport?: GhTransport;
  readonly runner?: import("../../adapters/github/transport.ts").GhRunner;
  /** Called after each run is collected, for interactive progress only. */
  readonly onProgress?: (snapshot: { readonly runsProcessed: number; readonly runsTotal: number; readonly jobsFetched: number }) => void;
}): Promise<SyncResult> {
  const { config, now } = options;
  const historyConfig = config.history;
  const budget = new RequestBudget(historyConfig.quotas);
  const ghVersion = options.transport === undefined ? await readGhVersion(options.runner) : null;
  const versionLabel = ghVersion ?? "unknown";
  const transport = options.transport ?? new GhTransport({
    budget,
    timeoutMs: historyConfig.requestTimeoutMs,
    retries: historyConfig.additionalRetries,
    cache: true,
    ...(options.runner === undefined ? {} : { runner: options.runner }),
  });
  const effectiveClient = new GitHubClient(transport, options.owner, options.repo);
  const requestedTo = now;
  const requestedFrom = new Date(requestedTo.getTime() - historyConfig.lookbackDays * 86_400_000);
  const missingScopes: MissingScope[] = [];

  const repository = await effectiveClient.repository();
  const defaultBranch = repository.default_branch;

  const workflows: Array<{ id: number; name: string; path: string; state: string }> = [];
  for (let page = 1; page <= 10; page += 1) {
    const result = await effectiveClient.workflows(page, PAGE_SIZE);
    for (const workflow of result.items) workflows.push({ id: workflow.id, name: workflow.name, path: workflow.path, state: workflow.state });
    if (!result.hasNext) break;
  }

  const runs: GitHubRun[] = [];
  let truncatedByLimit = false;
  let historyError: string | null = null;
  try {
    for (let page = 1; runs.length < historyConfig.maxRuns; page += 1) {
      const result = await effectiveClient.runs({
        page,
        perPage: PAGE_SIZE,
        createdAfter: isoSeconds(requestedFrom),
      });
      for (const run of result.items) {
        if (runs.length >= historyConfig.maxRuns) break;
        runs.push(run);
      }
      if (!result.hasNext) break;
      if (runs.length >= historyConfig.maxRuns) {
        truncatedByLimit = true;
        break;
      }
    }
  } catch (error) {
    if (error instanceof GitHubError && error.code === "AUTH_REQUIRED") throw error;
    historyError = error instanceof Error ? error.message : String(error);
  }

  const historyRuns: HistoryRun[] = [];
  let jobsFetched = 0;
  let jobsExpected = 0;
  const definitions = new Map<string, WorkflowDefinition | null>();
  const pulls = new Map<number, HistoryPull>();
  const pullNumbers = new Set<number>();

  for (const run of runs) {
    const pullRequestNumbers = (run.pull_requests ?? []).map((pull) => pull.number);
    for (const number of pullRequestNumbers) pullNumbers.add(number);
    const jobs: HistoryJob[] = [];
    const attempts = Math.max(1, run.run_attempt);
    let jobsComplete = true;
    for (let attempt = attempts; attempt >= 1; attempt -= 1) {
      jobsExpected += 1;
      try {
        for (let page = 1; page <= 10; page += 1) {
          const result = await effectiveClient.attemptJobs(run.id, attempt, page, JOB_PAGE_SIZE);
          jobsFetched += 1;
          for (const job of result.items) {
            const durationMillis = job.started_at === null ? null : durationMillisBetween(job.started_at, job.completed_at);
            jobs.push({
              jobId: String(job.id),
              runId: String(run.id),
              attempt,
              name: job.name,
              workflowPath: run.path,
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
        }
      } catch (error) {
        if (error instanceof GitHubError && error.code === "AUTH_REQUIRED") throw error;
        jobsComplete = false;
        missingScopes.push(missingScope({ family: "jobs", resource: "actions.runs.jobs", runId: String(run.id), attempt, reason: error instanceof Error ? error.message : "JOBS_UNAVAILABLE", resumable: true }));
      }
    }

    const definitionKey = run.path + "@" + run.head_sha;
    let definition = definitions.get(definitionKey);
    if (definition === undefined) {
      try {
        const content = await effectiveClient.contents(run.path, run.head_sha);
        definition = content === null ? null : parseWorkflow(run.path, content.text);
      } catch (error) {
        if (error instanceof GitHubError && error.code === "AUTH_REQUIRED") throw error;
        definition = null;
        missingScopes.push(missingScope({ family: "definitions", resource: "contents", runId: String(run.id), path: run.path, reason: error instanceof Error ? error.message : "DEFINITION_UNAVAILABLE", resumable: true }));
      }
      definitions.set(definitionKey, definition);
    }

    historyRuns.push({
      runId: String(run.id),
      workflowPath: run.path,
      workflowName: run.name,
      headSha: run.head_sha,
      headBranch: run.head_branch,
      event: run.event,
      createdAt: run.created_at,
      attempt: attempts,
      conclusion: run.conclusion,
      pullRequestNumbers,
      jobs,
      definition,
      definitionResolution: definition === null ? "unresolved" : "resolved",
    });
    options.onProgress?.({ runsProcessed: historyRuns.length, runsTotal: runs.length, jobsFetched });

  }

  for (const number of pullNumbers) {
    try {
      const pull = await effectiveClient.pull(number);
      let files: string[] | null = null;
      try {
        const collected: string[] = [];
        for (let page = 1; page <= 30; page += 1) {
          const result = await effectiveClient.pullFiles(number, page, PAGE_SIZE);
          for (const file of result.items) {
            collected.push(file.filename);
            if (file.previous_filename !== undefined) collected.push(file.previous_filename);
          }
          if (!result.hasNext) break;
        }
        files = collected;
      } catch (error) {
        if (error instanceof GitHubError && error.code === "AUTH_REQUIRED") throw error;
        missingScopes.push(missingScope({ family: "policyAndFiles", resource: "pulls.files", pullRequest: number, reason: error instanceof Error ? error.message : "PULL_FILES_UNAVAILABLE", resumable: true }));
      }
      pulls.set(number, { number, baseBranch: pull.baseBranch, headBranch: pull.headBranch, files });
    } catch (error) {
      if (error instanceof GitHubError && error.code === "AUTH_REQUIRED") throw error;
      missingScopes.push(missingScope({ family: "policyAndFiles", resource: "pulls", pullRequest: number, reason: error instanceof Error ? error.message : "PULL_UNAVAILABLE", resumable: true }));
    }
  }

  let retention: RetentionSnapshot | null = null;
  let retentionStatus: Dimension["status"] = "unavailable";
  const retentionReasons: string[] = [];
  try {
    const policy = await effectiveClient.retentionPolicy();
    retention = { days: policy.days, maximumAllowedDays: policy.maximum_allowed_days, fetchedAt: now.toISOString() };
    retentionStatus = "complete";
  } catch (error) {
    if (error instanceof GitHubError && error.code === "AUTH_REQUIRED") throw error;
    retentionStatus = error instanceof GitHubError && error.code === "PERMISSION_DENIED" ? "partial" : "unavailable";
    retentionReasons.push(error instanceof Error ? error.message : "RETENTION_UNAVAILABLE");
  }

  let protection: ProtectionSnapshot | null = null;
  let protectionStatus: Dimension["status"] = "unavailable";
  const protectionReasons: string[] = [];
  try {
    const rules = await effectiveClient.branchRules(defaultBranch);
    let classic: boolean | null = null;
    try {
      classic = (await effectiveClient.branchProtection(defaultBranch)) !== null;
    } catch (error) {
      if (error instanceof GitHubError && error.code === "AUTH_REQUIRED") throw error;
      protectionReasons.push(error instanceof Error ? error.message : "BRANCH_PROTECTION_UNAVAILABLE");
    }
    protection = { defaultBranch, ruleCount: rules.length, classicProtection: classic, fetchedAt: now.toISOString() };
    protectionStatus = classic === null ? "partial" : "complete";
  } catch (error) {
    if (error instanceof GitHubError && error.code === "AUTH_REQUIRED") throw error;
    protectionStatus = error instanceof GitHubError && error.code === "PERMISSION_DENIED" ? "partial" : "unavailable";
    protectionReasons.push(error instanceof Error ? error.message : "PROTECTION_UNAVAILABLE");
  }

  const artifacts: ArtifactRecord[] = [];
  try {
    for (let page = 1; page <= MAX_ARTIFACT_PAGES; page += 1) {
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
    }
  } catch (error) {
    if (error instanceof GitHubError && error.code === "AUTH_REQUIRED") throw error;
    missingScopes.push(missingScope({ family: "policyAndFiles", resource: "actions.artifacts", reason: error instanceof Error ? error.message : "ARTIFACTS_UNAVAILABLE", resumable: true }));
  }

  const unresolvedDefinitions = historyRuns.filter((run) => run.definitionResolution === "unresolved").length;
  const pullsWithoutFiles = [...pulls.values()].filter((pull) => pull.files === null).length;
  const historyStatus: Dimension["status"] = historyError !== null ? "unavailable" : truncatedByLimit || missingScopes.some((scope) => scope.family === "jobs") || jobsFetched === 0 ? "partial" : "complete";
  const definitionsStatus: Dimension["status"] = historyRuns.length === 0 ? "unavailable" : unresolvedDefinitions > 0 ? "partial" : "complete";
  const changedFilesStatus: Dimension["status"] = pullNumbers.size === 0 ? "unavailable" : pullsWithoutFiles > 0 ? "partial" : "complete";

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
        reasons: coverageReasons(historyStatus, historyError !== null ? [historyError] : truncatedByLimit ? ["RUN_LIMIT_REACHED"] : []),
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
        reasons: coverageReasons(changedFilesStatus, pullsWithoutFiles > 0 ? ["PULL_FILES_UNAVAILABLE"] : ["NO_PULL_REQUESTS"]),
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
