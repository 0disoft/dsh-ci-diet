import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../../src/core/data/default-config.ts";
import { syncRepositoryHistory } from "../../src/core/history/sync.ts";
import { GitHubError } from "../../src/adapters/github/errors.ts";
import type { GhResponse, GhRunner, GhTransport } from "../../src/adapters/github/transport.ts";
import { DeadlineExceededError } from "../../src/core/support/deadline.ts";
import { composeCoverage, buildCoverage } from "../../src/core/analysis/coverage.ts";

const WORKFLOW = [
  "name: CI",
  "on:",
  "  pull_request:",
  "  push:",
  "    branches: [main]",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v7",
  "      - run: bun test",
  "",
].join("\n");

const NOW = new Date("2026-10-20T00:00:00.000Z");

function response(body: unknown, headers: Readonly<Record<string, string>> = {}): GhResponse {
  return { status: 200, headers, body, etag: null, notified304: false };
}

interface Route {
  readonly match: RegExp;
  readonly handle: () => GhResponse;
}

function routes(): Route[] {
  return [
    { match: /\/actions\/workflows$/, handle: () => response({ total_count: 1, workflows: [{ id: 7, name: "CI", path: ".github/workflows/ci.yml", state: "active" }] }) },
    {
      match: /\/actions\/runs$/,
      handle: () => response({
        total_count: 1,
        workflow_runs: [{
          id: 100,
          name: "CI",
          path: ".github/workflows/ci.yml",
          head_sha: "abc123",
          head_branch: "feature",
          event: "pull_request",
          created_at: "2026-10-19T10:00:00Z",
          run_attempt: 1,
          conclusion: "success",
          pull_requests: [{ number: 5 }],
        }],
      }),
    },
    {
      match: /\/attempts\/\d+\/jobs$/,
      handle: () => response({
        total_count: 1,
        jobs: [{
          id: 11,
          name: "build",
          conclusion: "success",
          started_at: "2026-10-19T10:00:10Z",
          completed_at: "2026-10-19T10:01:10Z",
          labels: ["ubuntu-latest"],
          runner_name: "GitHub Actions 1",
        }],
      }),
    },
    { match: /\/contents\//, handle: () => response({ path: ".github/workflows/ci.yml", sha: "blob", size: WORKFLOW.length, encoding: "base64", content: Buffer.from(WORKFLOW, "utf8").toString("base64") }) },
    { match: /\/pulls\/5$/, handle: () => response({ number: 5, base: { ref: "main" }, head: { ref: "feature" } }) },
    { match: /\/permissions\/artifact-and-log-retention$/, handle: () => response({ days: 90, maximum_allowed_days: 90 }) },
    { match: /\/rules\/branches\//, handle: () => response([]) },
    { match: /\/actions\/artifacts$/, handle: () => response({ total_count: 0, artifacts: [] }) },
    { match: /\/repos\/o\/r$/, handle: () => response({ id: 1, full_name: "o/r", default_branch: "main" }) },
  ];
}

function fakeTransport(overrides: { readonly files?: () => never } = {}): GhTransport {
  const table = routes();
  const transport = {
    async get(request: { readonly path: string }): Promise<GhResponse> {
      if (overrides.files !== undefined && request.path.endsWith("/pulls/5/files")) overrides.files();
      const route = table.find((candidate) => candidate.match.test(request.path));
      if (route === undefined) throw new Error("unexpected request: " + request.path);
      return route.handle();
    },
  };
  return transport as unknown as GhTransport;
}

function config() {
  return { ...DEFAULT_CONFIG, history: { ...DEFAULT_CONFIG.history, lookbackDays: 7, maxRuns: 100 } };
}

for (const resource of ["jobs", "pull-files"]) {
  test("malformed " + resource + " cannot become complete empty evidence", async () => {
    const transport = fakeTransport();
    const original = transport.get.bind(transport);
    transport.get = async (request, family) => {
      if ((resource === "jobs" && /\/attempts\/\d+\/jobs$/.test(request.path))
        || (resource === "pull-files" && request.path.endsWith("/pulls/5/files"))) {
        return response({ message: "unexpected successful response" });
      }
      if (request.path.endsWith("/pulls/5/files")) return response([]);
      return original(request, family);
    };
    const { history } = await syncRepositoryHistory({ owner: "o", repo: "r", config: config(), now: NOW, transport });
    const dimension = resource === "jobs" ? history.coverage.history : history.coverage.changedFiles;
    assert.equal(dimension.status, "partial");
    const missing = history.missingScopes.find((scope) => scope.resource === (resource === "jobs" ? "actions.runs.jobs" : "pulls.files"));
    assert.match(missing?.reason ?? "", /NETWORK_ERROR/);
    if (resource === "pull-files") assert.equal(history.pulls.get(5)?.files, null);
  });
}

for (const kind of ["not-found", "null", "object", "empty"] as const) {
  test("preserves branch protection evidence for a branch-rules " + kind + " response", async () => {
    const transport = fakeTransport();
    const original = transport.get.bind(transport);
    let classicReads = 0;
    transport.get = async (request, family) => {
      if (request.path.includes("/rules/branches/")) {
        if (kind === "not-found") throw new GitHubError("NOT_FOUND", "resource not found", 404);
        return response(kind === "empty" ? [] : kind === "null" ? null : { message: "unexpected response" });
      }
      if (request.path.endsWith("/pulls/5/files")) return response([{ filename: "src/app.ts" }]);
      if (request.path.endsWith("/protection")) {
        classicReads += 1;
        throw new GitHubError("NOT_FOUND", "branch is not protected", 404);
      }
      return original(request, family);
    };
    const { history } = await syncRepositoryHistory({ owner: "o", repo: "r", config: config(), now: NOW, transport });
    const coverage = buildCoverage({ apiVersion: "test", ghVersion: "test",
      requestedFrom: history.requestedFrom, requestedTo: history.requestedTo }, history.coverage);
    assert.equal(history.coverage.changedFiles.status, "complete");
    if (kind === "empty") {
      assert.equal(history.protection?.ruleCount, 0);
      assert.equal(history.protection?.classicProtection, false);
      assert.equal(history.coverage.protectionRules.status, "complete");
      assert.equal(classicReads, 1);
      assert.equal(composeCoverage(coverage, "CD001").writeAllowed, true);
      return;
    }
    assert.equal(history.protection, null);
    assert.equal(history.coverage.protectionRules.status, "unavailable");
    assert.match(history.coverage.protectionRules.reasons.join(" "), kind === "not-found" ? /NOT_FOUND/ : /NETWORK_ERROR/);
    assert.equal(classicReads, 0, "a failed rules lookup cannot establish absence of protection");
    assert.equal(composeCoverage(coverage, "CD001").writeAllowed, false);
  });
}

test("stops a collection that outlives its deadline", async () => {
  const runner: GhRunner = (_argv, _timeoutMs, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  await assert.rejects(
    syncRepositoryHistory({ owner: "o", repo: "r", config: config(), now: NOW, runner, deadlineMs: 50 }),
    (error: unknown) => error instanceof DeadlineExceededError,
  );
});

test("marks changed files partial when pull request files are denied", async () => {
  const result = await syncRepositoryHistory({
    owner: "o",
    repo: "r",
    config: config(),
    now: NOW,
    transport: fakeTransport({ files: () => { throw new GitHubError("PERMISSION_DENIED", "Resource not accessible by integration", 403); } }),
  });
  assert.equal(result.history.coverage.changedFiles.status, "partial");
  assert.deepEqual(result.history.coverage.changedFiles.reasons, ["PULL_FILES_UNAVAILABLE"]);
  assert.equal(result.history.pulls.get(5)?.files, null);
  assert.ok(result.history.missingScopes.some((scope) => scope.resource === "pulls.files"));
  assert.equal(result.history.coverage.history.status, "complete");
  assert.equal(result.history.coverage.workflowDefinitions.status, "complete");
});

test("collects changed files when the pull request is readable", async () => {
  const transport = fakeTransport();
  const original = transport.get.bind(transport);
  (transport as unknown as { get: typeof original }).get = async (request: { readonly path: string }, family: Parameters<typeof original>[1]) => {
    if (request.path.endsWith("/pulls/5/files")) {
      return response([{ filename: "src/app.ts", previous_filename: "src/old.ts" }]);
    }
    return original(request, family);
  };
  const result = await syncRepositoryHistory({ owner: "o", repo: "r", config: config(), now: NOW, transport });
  assert.equal(result.history.coverage.changedFiles.status, "complete");
  assert.deepEqual(result.history.pulls.get(5)?.files, ["src/app.ts", "src/old.ts"]);
});

test("counts fetched jobs per job instead of per page", async () => {
  const transport = fakeTransport();
  const original = transport.get.bind(transport);
  (transport as unknown as { get: typeof original }).get = async (request: { readonly path: string }, family: Parameters<typeof original>[1]) => {
    if (/\/attempts\/\d+\/jobs$/.test(request.path)) {
      const jobs = [11, 12].map((id) => ({
        id,
        name: "build-" + String(id),
        conclusion: "success",
        started_at: "2026-10-19T10:00:10Z",
        completed_at: "2026-10-19T10:01:10Z",
        labels: ["ubuntu-latest"],
        runner_name: "GitHub Actions 1",
      }));
      return response({ total_count: jobs.length, jobs });
    }
    return original(request, family);
  };
  const progress: number[] = [];
  const result = await syncRepositoryHistory({
    owner: "o",
    repo: "r",
    config: config(),
    now: NOW,
    transport,
    onProgress: (snapshot) => progress.push(snapshot.jobsFetched),
  });
  assert.deepEqual(progress, [2]);
  assert.equal(result.history.runs[0]?.jobs.length, 2);
  assert.equal(result.history.coverage.history.status, "complete");
});

test("marks history partial with RUN_LIMIT_REACHED when the run window is truncated", async () => {
  const transport = fakeTransport();
  const original = transport.get.bind(transport);
  (transport as unknown as { get: typeof original }).get = async (request: { readonly path: string }, family: Parameters<typeof original>[1]) => {
    if (request.path.endsWith("/actions/runs")) {
      const base = await original(request, family);
      return { ...base, headers: { link: '<https://api.github.com/repositories/1/actions/runs?page=2>; rel="next"' } };
    }
    return original(request, family);
  };
  const baseConfig = config();
  const truncatedConfig = { ...baseConfig, history: { ...baseConfig.history, maxRuns: 1 } };
  const result = await syncRepositoryHistory({ owner: "o", repo: "r", config: truncatedConfig, now: NOW, transport });
  assert.equal(result.history.coverage.history.status, "partial");
  assert.deepEqual(result.history.coverage.history.reasons, ["RUN_LIMIT_REACHED"]);
});

test("marks history partial when artifacts stop at the page cap", async () => {
  const transport = fakeTransport();
  const original = transport.get.bind(transport);
  (transport as unknown as { get: typeof original }).get = async (request: { readonly path: string }, family: Parameters<typeof original>[1]) => {
    if (request.path.endsWith("/actions/artifacts")) {
      return response(
        {
          total_count: 999,
          artifacts: [{ id: 1, name: "build", size_in_bytes: 10, created_at: "2026-10-19T10:00:00Z", expires_at: "2026-11-19T10:00:00Z" }],
        },
        { link: '<https://api.github.com/repositories/1/actions/artifacts?page=2>; rel="next"' },
      );
    }
    return original(request, family);
  };
  const result = await syncRepositoryHistory({ owner: "o", repo: "r", config: config(), now: NOW, transport });
  assert.equal(result.history.artifacts.length, 3);
  assert.equal(result.history.coverage.history.status, "partial");
  assert.deepEqual(result.history.coverage.history.reasons, ["ARTIFACT_RUN_LIMIT_REACHED"]);
});

test("marks history partial when jobs stop at the page cap", async () => {
  const transport = fakeTransport();
  const original = transport.get.bind(transport);
  (transport as unknown as { get: typeof original }).get = async (request: { readonly path: string }, family: Parameters<typeof original>[1]) => {
    if (/\/attempts\/\d+\/jobs$/.test(request.path)) {
      return response(
        {
          total_count: 999,
          jobs: [{
            id: 11,
            name: "build",
            conclusion: "success",
            started_at: "2026-10-19T10:00:10Z",
            completed_at: "2026-10-19T10:01:10Z",
            labels: ["ubuntu-latest"],
            runner_name: "GitHub Actions 1",
          }],
        },
        { link: '<https://api.github.com/repositories/1/actions/runs/100/attempts/1/jobs?page=2>; rel="next"' },
      );
    }
    return original(request, family);
  };
  const result = await syncRepositoryHistory({ owner: "o", repo: "r", config: config(), now: NOW, transport });
  assert.equal(result.history.runs[0]?.jobs.length, 10);
  assert.equal(result.history.coverage.history.status, "partial");
  assert.deepEqual(result.history.coverage.history.reasons, ["JOB_PAGE_LIMIT_REACHED"]);
  assert.ok(
    result.history.missingScopes.some((scope) => scope.family === "jobs" && scope.reason === "JOB_PAGE_LIMIT_REACHED" && scope.resumable),
  );
});

test("marks changed files partial when pull files stop at the page cap", async () => {
  const transport = fakeTransport();
  const original = transport.get.bind(transport);
  (transport as unknown as { get: typeof original }).get = async (request: { readonly path: string }, family: Parameters<typeof original>[1]) => {
    if (request.path.endsWith("/pulls/5/files")) {
      return response(
        [{ filename: "src/app.ts" }],
        { link: '<https://api.github.com/repositories/1/pulls/5/files?page=2>; rel="next"' },
      );
    }
    return original(request, family);
  };
  const result = await syncRepositoryHistory({ owner: "o", repo: "r", config: config(), now: NOW, transport });
  assert.equal(result.history.pulls.get(5)?.files?.length, 30);
  assert.equal(result.history.coverage.changedFiles.status, "partial");
  assert.deepEqual(result.history.coverage.changedFiles.reasons, ["PULL_FILES_LIMIT_REACHED"]);
  assert.ok(
    result.history.missingScopes.some((scope) => scope.resource === "pulls.files" && scope.reason === "PULL_FILES_LIMIT_REACHED"),
  );
});

test("records a discovery scope when the workflow list stops at the page cap", async () => {
  const transport = fakeTransport();
  const original = transport.get.bind(transport);
  (transport as unknown as { get: typeof original }).get = async (request: { readonly path: string }, family: Parameters<typeof original>[1]) => {
    if (request.path.endsWith("/actions/workflows")) {
      return response(
        { total_count: 999, workflows: [{ id: 7, name: "CI", path: ".github/workflows/ci.yml", state: "active" }] },
        { link: '<https://api.github.com/repositories/1/actions/workflows?page=2>; rel="next"' },
      );
    }
    return original(request, family);
  };
  const result = await syncRepositoryHistory({ owner: "o", repo: "r", config: config(), now: NOW, transport });
  assert.equal(result.history.workflows.length, 10);
  assert.ok(
    result.history.missingScopes.some(
      (scope) => scope.family === "discovery" && scope.resource === "actions.workflows" && scope.reason === "WORKFLOW_LIMIT_REACHED",
    ),
  );
});

test("reports RUN_LIMIT_REACHED when the final page holds more runs than the window", async () => {
  const transport = fakeTransport();
  const original = transport.get.bind(transport);
  const run = (id: number) => ({
    id,
    name: "CI",
    path: ".github/workflows/ci.yml",
    workflow_id: 7,
    head_sha: "sha" + String(id),
    head_branch: "main",
    event: "push",
    created_at: "2026-10-19T10:00:00Z",
    run_attempt: 1,
    conclusion: "success",
    pull_requests: [],
  });
  (transport as unknown as { get: typeof original }).get = async (request: { readonly path: string }, family: Parameters<typeof original>[1]) => {
    if (request.path.endsWith("/actions/runs")) {
      // No link header: these three rows are the entire final page.
      return response({ total_count: 3, workflow_runs: [run(1), run(2), run(3)] });
    }
    return original(request, family);
  };
  const baseConfig = config();
  const truncatedConfig = { ...baseConfig, history: { ...baseConfig.history, maxRuns: 2 } };
  const result = await syncRepositoryHistory({ owner: "o", repo: "r", config: truncatedConfig, now: NOW, transport });
  assert.equal(result.history.runs.length, 2);
  assert.equal(result.history.coverage.history.status, "partial");
  assert.deepEqual(result.history.coverage.history.reasons, ["RUN_LIMIT_REACHED"]);
});

test("resolves run.path ref suffixes through the workflow_id listing", async () => {
  const transport = fakeTransport();
  const original = transport.get.bind(transport);
  const contentsRequests: { path: string; query?: Readonly<Record<string, string>> }[] = [];
  (transport as unknown as { get: typeof original }).get = async (request: { readonly path: string; readonly query?: Readonly<Record<string, string>> }, family: Parameters<typeof original>[1]) => {
    if (request.path.endsWith("/actions/runs")) {
      return response({
        total_count: 1,
        workflow_runs: [{
          id: 100,
          name: "CI",
          path: ".github/workflows/ci.yml@main",
          workflow_id: 7,
          head_sha: "abc123",
          head_branch: "main",
          event: "push",
          created_at: "2026-10-19T10:00:00Z",
          run_attempt: 1,
          conclusion: "success",
          pull_requests: [],
        }],
      });
    }
    if (request.path.includes("/contents/")) contentsRequests.push({ path: request.path, query: request.query });
    return original(request, family);
  };
  const result = await syncRepositoryHistory({ owner: "o", repo: "r", config: config(), now: NOW, transport });
  assert.equal(result.history.runs[0]?.workflowPath, ".github/workflows/ci.yml");
  assert.equal(result.history.runs[0]?.jobs[0]?.workflowPath, ".github/workflows/ci.yml");
  assert.equal(contentsRequests.length, 1);
  assert.equal(contentsRequests[0]?.path, "/repos/o/r/contents/.github/workflows/ci.yml");
  assert.equal(contentsRequests[0]?.query?.ref, "abc123");
});

test("keeps a real @ in a workflow filename and strips a refs suffix without workflow_id", async () => {
  const transport = fakeTransport();
  const original = transport.get.bind(transport);
  const contentsPaths: string[] = [];
  (transport as unknown as { get: typeof original }).get = async (request: { readonly path: string }, family: Parameters<typeof original>[1]) => {
    if (request.path.endsWith("/actions/runs")) {
      return response({
        total_count: 2,
        workflow_runs: [
          {
            id: 100,
            name: "release",
            path: ".github/workflows/release@2.yml",
            head_sha: "sha100",
            head_branch: "feature",
            event: "push",
            created_at: "2026-10-19T10:00:00Z",
            run_attempt: 1,
            conclusion: "success",
            pull_requests: [],
          },
          {
            id: 101,
            name: "CI",
            path: ".github/workflows/ci.yml@refs/heads/main",
            head_sha: "sha101",
            head_branch: "main",
            event: "push",
            created_at: "2026-10-19T10:00:00Z",
            run_attempt: 1,
            conclusion: "success",
            pull_requests: [],
          },
        ],
      });
    }
    if (request.path.includes("/contents/")) contentsPaths.push(request.path);
    return original(request, family);
  };
  const result = await syncRepositoryHistory({ owner: "o", repo: "r", config: config(), now: NOW, transport });
  assert.deepEqual(result.history.runs.map((run) => run.workflowPath), [".github/workflows/release@2.yml", ".github/workflows/ci.yml"]);
  assert.ok(contentsPaths.some((path) => path.includes("release%402.yml")), "a real @ must stay encoded, not become a ref split");
  assert.equal(result.history.coverage.workflowDefinitions.status, "complete");
});

test("hands unused jobs quota to the definitions stage", async () => {
  const transport = fakeTransport();
  const original = transport.get.bind(transport);
  (transport as unknown as { get: typeof original }).get = async (request: { readonly path: string }, family: Parameters<typeof original>[1]) => {
    if (request.path.endsWith("/actions/runs")) {
      const workflowRuns = Array.from({ length: 5 }, (_, index) => ({
        id: 100 + index,
        name: "CI",
        path: ".github/workflows/ci.yml",
        workflow_id: 7,
        head_sha: "sha" + String(index),
        head_branch: "main",
        event: "push",
        created_at: "2026-10-19T10:00:00Z",
        run_attempt: 1,
        conclusion: "success",
        pull_requests: [],
      }));
      return response({ total_count: workflowRuns.length, workflow_runs: workflowRuns });
    }
    return original(request, family);
  };
  const baseConfig = config();
  const tightDefinitions = {
    ...baseConfig,
    history: { ...baseConfig.history, quotas: { discovery: 40, jobs: 220, definitions: 2, policyAndFiles: 80 } },
  };
  const result = await syncRepositoryHistory({ owner: "o", repo: "r", config: tightDefinitions, now: NOW, transport });
  assert.equal(result.history.runs.length, 5);
  assert.ok(result.history.runs.every((run) => run.definitionResolution === "resolved"));
  assert.equal(result.history.coverage.workflowDefinitions.status, "complete");
  assert.ok(result.budget.snapshot().families.definitions.borrowed > 0);
});

test("rejects before collecting anything when the caller already aborted", async () => {
  const transport = fakeTransport();
  const original = transport.get.bind(transport);
  let calls = 0;
  (transport as unknown as { get: typeof original }).get = async (request: { readonly path: string }, family: Parameters<typeof original>[1]) => {
    calls += 1;
    return original(request, family);
  };
  const controller = new AbortController();
  controller.abort(new Error("stop now"));
  await assert.rejects(
    syncRepositoryHistory({ owner: "o", repo: "r", config: config(), now: NOW, transport, signal: controller.signal }),
    /stop now/,
  );
  assert.equal(calls, 0);
});

test("stops collecting when the caller aborts between runs", async () => {
  const transport = fakeTransport();
  const original = transport.get.bind(transport);
  let calls = 0;
  (transport as unknown as { get: typeof original }).get = async (request: { readonly path: string }, family: Parameters<typeof original>[1]) => {
    calls += 1;
    return original(request, family);
  };
  const controller = new AbortController();
  await assert.rejects(
    syncRepositoryHistory({
      owner: "o",
      repo: "r",
      config: config(),
      now: NOW,
      transport,
      signal: controller.signal,
      onProgress: ({ runsProcessed }) => {
        if (runsProcessed === 1) controller.abort(new Error("cancelled by caller"));
      },
    }),
    /cancelled by caller/,
  );
  assert.equal(calls, 5); // repository, workflows, runs, jobs, contents; aborted before the pull request
});

test("a genuinely empty run window is complete, not a partial collection", async () => {
  const transport = fakeTransport();
  const original = transport.get.bind(transport);
  (transport as unknown as { get: typeof original }).get = async (request: { readonly path: string }, family: Parameters<typeof original>[1]) => {
    if (request.path.endsWith("/actions/runs")) return response({ total_count: 0, workflow_runs: [] });
    return original(request, family);
  };
  const result = await syncRepositoryHistory({ owner: "o", repo: "r", config: config(), now: NOW, transport });
  assert.equal(result.history.runs.length, 0);
  assert.equal(result.history.coverage.history.status, "complete");
  assert.deepEqual(result.history.coverage.history.reasons, []);
});

test("rejects a lookback outside the config contract before any request", async () => {
  const transport = fakeTransport();
  const original = transport.get.bind(transport);
  let calls = 0;
  (transport as unknown as { get: typeof original }).get = async (request: { readonly path: string }, family: Parameters<typeof original>[1]) => {
    calls += 1;
    return original(request, family);
  };
  const tooLong = { ...config(), history: { ...config().history, lookbackDays: 31 } };
  await assert.rejects(
    syncRepositoryHistory({ owner: "o", repo: "r", config: tooLong, now: NOW, transport }),
    /lookbackDays maximum must be <= 30/,
  );
  assert.equal(calls, 0);
});

test("propagates authentication failures instead of recording them", async () => {
  const transport = {
    async get(): Promise<GhResponse> {
      throw new GitHubError("AUTH_REQUIRED", "gh auth login is required", 401);
    },
  } as unknown as GhTransport;
  await assert.rejects(
    syncRepositoryHistory({ owner: "o", repo: "r", config: config(), now: NOW, transport }),
    /AUTH_REQUIRED|gh auth login/,
  );
});

function workflowRuns(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: 300 + index,
    name: "CI",
    path: ".github/workflows/ci.yml",
    workflow_id: 7,
    head_sha: "sha" + String(300 + index),
    head_branch: "main",
    event: "push",
    created_at: "2026-10-19T10:00:00Z",
    run_attempt: 1,
    conclusion: "success",
    pull_requests: [],
  }));
}

function jobResponse(runId: number, page = 1): GhResponse {
  return response({
    total_count: 1,
    jobs: [{
      id: runId * 10 + page,
      name: "build",
      conclusion: "success",
      started_at: "2026-10-19T10:00:10Z",
      completed_at: "2026-10-19T10:01:10Z",
      labels: ["ubuntu-latest"],
      runner_name: "GitHub Actions 1",
    }],
  });
}

for (const scenario of [
  { name: "overlapping pages", pages: [[0, 1], [1, 2]], maxRuns: 3, expected: [300, 301, 302], nextOnLast: false },
  { name: "duplicates inside a page", pages: [[0, 0, 1]], maxRuns: 4, expected: [300, 301], nextOnLast: false },
  { name: "duplicate tail at the limit", pages: [[0, 1, 1]], maxRuns: 2, expected: [300, 301], nextOnLast: false },
  { name: "a non-progressing next page", pages: [[0, 1], [0, 1]], maxRuns: 10, expected: [300, 301], nextOnLast: true },
  { name: "an empty page with a next link", pages: [[0, 1], []], maxRuns: 10, expected: [300, 301], nextOnLast: true },
]) {
  test("counts unique runs and degrades coverage for " + scenario.name, async () => {
    const transport = fakeTransport();
    const original = transport.get.bind(transport);
    const runs = workflowRuns(3);
    const jobReads: number[] = [];
    let runReads = 0;
    transport.get = async (request, family) => {
      if (request.path.endsWith("/actions/runs")) {
        const page = scenario.pages[runReads++];
        assert.ok(page, "a page with no new runs must stop pagination");
        const hasNext = runReads < scenario.pages.length || scenario.nextOnLast;
        return response({ total_count: 3, workflow_runs: page.map((index) => runs[index]) },
          hasNext ? { link: '<https://api.github.com/next>; rel="next"' } : {});
      }
      if (request.path.endsWith("/attempts/1/jobs")) {
        const id = Number(/\/actions\/runs\/(\d+)\//.exec(request.path)?.[1]);
        jobReads.push(id);
        return jobResponse(id);
      }
      return original(request, family);
    };
    const base = config();
    const result = await syncRepositoryHistory({ owner: "o", repo: "r", now: NOW, transport,
      config: { ...base, history: { ...base.history, maxRuns: scenario.maxRuns } } });
    assert.deepEqual(result.history.runs.map((run) => Number(run.runId)), scenario.expected);
    assert.deepEqual(jobReads.sort(), [...scenario.expected].sort(), "one job collection per unique run");
    assert.equal(runReads, scenario.pages.length);
    assert.equal(result.history.coverage.history.status, "partial");
    assert.ok(result.history.coverage.history.reasons.includes("RUN_PAGINATION_CHANGED"));
    assert.ok(!result.history.coverage.history.reasons.includes("RUN_LIMIT_REACHED"));
  });
}

test("collects jobs with bounded concurrency while keeping repository order", async () => {
  const transport = fakeTransport();
  const original = transport.get.bind(transport);
  const runs = workflowRuns(4);
  let active = 0;
  let maxActive = 0;
  (transport as unknown as { get: typeof original }).get = async (request: { readonly path: string }, family: Parameters<typeof original>[1]) => {
    if (request.path.endsWith("/actions/runs")) return response({ total_count: runs.length, workflow_runs: runs });
    if (request.path.endsWith("/attempts/1/jobs")) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      const runId = Number(/\/actions\/runs\/(\d+)\//.exec(request.path)?.[1]);
      return jobResponse(runId);
    }
    return original(request, family);
  };
  const base = config();
  const concurrent = { ...base, history: { ...base.history, concurrentRequests: 2 } };
  const result = await syncRepositoryHistory({ owner: "o", repo: "r", config: concurrent, now: NOW, transport });
  assert.equal(maxActive, 2, "no more than concurrentRequests job reads may be in flight");
  assert.deepEqual(result.history.runs.map((run) => run.runId), ["300", "301", "302", "303"]);
  assert.ok(result.history.runs.every((run) => run.jobs.length === 1));
});

test("records a jobs failure for only the affected run and completes the sync", async () => {
  const transport = fakeTransport();
  const original = transport.get.bind(transport);
  const runs = workflowRuns(2);
  (transport as unknown as { get: typeof original }).get = async (request: { readonly path: string }, family: Parameters<typeof original>[1]) => {
    if (request.path.endsWith("/actions/runs")) return response({ total_count: runs.length, workflow_runs: runs });
    if (request.path.includes("/actions/runs/301/")) {
      throw new GitHubError("PERMISSION_DENIED", "Resource not accessible by integration", 403);
    }
    if (request.path.endsWith("/attempts/1/jobs")) {
      const runId = Number(/\/actions\/runs\/(\d+)\//.exec(request.path)?.[1]);
      return jobResponse(runId);
    }
    return original(request, family);
  };
  const base = config();
  const concurrent = { ...base, history: { ...base.history, concurrentRequests: 2 } };
  const result = await syncRepositoryHistory({ owner: "o", repo: "r", config: concurrent, now: NOW, transport });
  assert.deepEqual(result.history.runs.map((run) => run.runId), ["300", "301"]);
  assert.equal(result.history.runs[0]?.jobs.length, 1);
  assert.equal(result.history.runs[1]?.jobs.length, 0);
  const jobScopes = result.history.missingScopes.filter((scope) => scope.family === "jobs");
  assert.equal(jobScopes.length, 1);
  assert.equal(jobScopes[0]?.runId, "301");
  assert.equal(result.history.coverage.history.status, "partial");
});

test("aborts the whole sync when one concurrent job read needs authentication", async () => {
  const transport = fakeTransport();
  const original = transport.get.bind(transport);
  const runs = workflowRuns(2);
  (transport as unknown as { get: typeof original }).get = async (request: { readonly path: string }, family: Parameters<typeof original>[1]) => {
    if (request.path.endsWith("/actions/runs")) return response({ total_count: runs.length, workflow_runs: runs });
    if (request.path.includes("/actions/runs/301/")) {
      throw new GitHubError("AUTH_REQUIRED", "gh auth login is required", 401);
    }
    return original(request, family);
  };
  const base = config();
  const concurrent = { ...base, history: { ...base.history, concurrentRequests: 2 } };
  await assert.rejects(
    syncRepositoryHistory({ owner: "o", repo: "r", config: concurrent, now: NOW, transport }),
    /gh auth login/,
  );
});

test("records a jobs page cap once while collecting runs concurrently", async () => {
  const transport = fakeTransport();
  const original = transport.get.bind(transport);
  const runs = workflowRuns(2);
  (transport as unknown as { get: typeof original }).get = async (request: { readonly path: string }, family: Parameters<typeof original>[1]) => {
    if (request.path.endsWith("/actions/runs")) return response({ total_count: runs.length, workflow_runs: runs });
    if (/\/attempts\/\d+\/jobs$/.test(request.path)) {
      const runId = Number(/\/actions\/runs\/(\d+)\//.exec(request.path)?.[1]);
      return response(
        { total_count: 999, jobs: [{
          id: runId * 10,
          name: "build",
          conclusion: "success",
          started_at: "2026-10-19T10:00:10Z",
          completed_at: "2026-10-19T10:01:10Z",
          labels: ["ubuntu-latest"],
          runner_name: "GitHub Actions 1",
        }] },
        { link: '<https://api.github.com/repositories/1/actions/runs/' + String(runId) + '/attempts/1/jobs?page=2>; rel="next"' },
      );
    }
    return original(request, family);
  };
  const base = config();
  const concurrent = { ...base, history: { ...base.history, concurrentRequests: 2 } };
  const result = await syncRepositoryHistory({ owner: "o", repo: "r", config: concurrent, now: NOW, transport });
  assert.equal(result.history.runs[0]?.jobs.length, 10);
  assert.equal(result.history.runs[1]?.jobs.length, 10);
  assert.deepEqual(result.history.coverage.history.reasons, ["JOB_PAGE_LIMIT_REACHED"]);
  assert.equal(result.history.missingScopes.filter((scope) => scope.family === "jobs").length, 2);
});

test("caps the total request budget with maxRequests", async () => {
  const base = config();
  const capped = { ...base, history: { ...base.history, maxRequests: 250 } };
  const result = await syncRepositoryHistory({ owner: "o", repo: "r", config: capped, now: NOW, transport: fakeTransport() });
  assert.equal(result.budget.limit, 250);
  assert.equal(result.budget.remaining, 250);
});
