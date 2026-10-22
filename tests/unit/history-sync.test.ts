import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../../src/core/data/default-config.ts";
import { syncRepositoryHistory } from "../../src/core/history/sync.ts";
import { GitHubError } from "../../src/adapters/github/errors.ts";
import type { GhResponse, GhTransport } from "../../src/adapters/github/transport.ts";

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