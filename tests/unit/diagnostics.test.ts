import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCoverage } from "../../src/core/analysis/coverage.ts";
import { buildDiagnostics, diagnosticsIncomplete } from "../../src/core/analysis/diagnostics.ts";
import type { HistoryBundle, HistoryJob, HistoryRun } from "../../src/core/history/model.ts";
import { parseWorkflow } from "../../src/core/workflow/index.ts";
import type { WorkflowDefinition } from "../../src/core/workflow/model.ts";

const NOW = "2026-10-20T00:00:00.000Z";
const PATH = ".github/workflows/ci.yml";

const MATRIX_WORKFLOW = [
  "name: ci",
  "on: [push, pull_request]",
  "jobs:",
  "  test:",
  "    name: test",
  "    runs-on: ubuntu-latest",
  "    strategy:",
  "      matrix:",
  "        os: [ubuntu-latest, windows-2022]",
  "    steps:",
  "      - run: echo hi",
  "  lint:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: echo lint",
  "",
].join("\n");

const DEFINITION = parseWorkflow(PATH, MATRIX_WORKFLOW);

function job(name: string, runId: string): HistoryJob {
  return {
    jobId: "j_" + name + "_" + runId,
    runId,
    attempt: 1,
    name,
    workflowPath: PATH,
    conclusion: "success",
    startedAt: "2026-10-19T00:00:00.000Z",
    completedAt: "2026-10-19T00:01:00.000Z",
    durationMillis: 60000,
    labels: ["ubuntu-latest"],
    runnerName: "GitHub Actions 1",
    sku: "actions_linux",
  };
}

function run(id: string, jobs: HistoryJob[], definition: WorkflowDefinition | null = DEFINITION): HistoryRun {
  return {
    runId: id,
    workflowPath: PATH,
    workflowName: "ci",
    headSha: "a".repeat(40),
    headBranch: "feature",
    event: "pull_request",
    createdAt: "2026-10-19T00:00:00.000Z",
    attempt: 1,
    conclusion: "success",
    pullRequestNumbers: [7],
    jobs,
    definition,
    definitionResolution: definition === null ? "unresolved" : "resolved",
  };
}

function bundle(runs: HistoryRun[], options: { missingScopes?: HistoryBundle["missingScopes"]; retentionStatus?: "complete" | "unavailable" } = {}): HistoryBundle {
  const coverage = buildCoverage({ apiVersion: "2022-11-28", ghVersion: "2.0.0", requestedFrom: "2026-10-13T00:00:00.000Z", requestedTo: NOW }, options.retentionStatus === "unavailable" ? { retentionPolicy: { status: "unavailable", reasons: ["RETENTION_UNKNOWN"] } } : {});
  return {
    repositoryId: "git:" + "b".repeat(32),
    repositoryFullName: "owner/repo",
    defaultBranch: "main",
    requestedFrom: "2026-10-13T00:00:00.000Z",
    requestedTo: NOW,
    runs,
    pulls: new Map(),
    workflows: [],
    artifacts: [],
    retention: null,
    protection: { defaultBranch: "main", ruleCount: 0, classicProtection: true, fetchedAt: NOW },
    coverage,
    missingScopes: options.missingScopes ?? [],
  };
}
test("attributes matrix legs and aggregates unmatched names", () => {
  const report = buildDiagnostics(bundle([
    run("r1", [job("test (ubuntu-latest)", "r1"), job("test (windows-2022)", "r1"), job("mystery job", "r1")]),
    run("r2", [job("test (ubuntu-latest)", "r2"), job("mystery job", "r2")]),
  ]));

  assert.equal(report.runs, 2);
  assert.equal(report.jobs, 5);
  assert.equal(report.matchedJobs, 3);
  assert.equal(report.unmatchedJobs, 2);
  assert.equal(report.matchPercent, 60);
  assert.equal(report.workflows.length, 1);
  const workflow = report.workflows[0];
  assert.ok(workflow);
  assert.equal(workflow.analyzableRuns, 2);
  assert.equal(workflow.matrixJobs.length, 1);
  const matrix = workflow.matrixJobs[0];
  assert.ok(matrix);
  assert.equal(matrix.key, "test");
  assert.equal(matrix.legs, 2);
  assert.deepEqual(workflow.misses, [{ workflowPath: PATH, jobName: "mystery job", occurrences: 2 }]);
});

test("repeated runs expand a reported matrix only once", (t) => {
  const parsed = parseWorkflow(PATH, [
    "on: push", "jobs:", "  test:", "    name: test ${{ matrix.shard }}",
    "    runs-on: ubuntu-latest", "    strategy:", "      matrix:",
    "        shard: [" + Array.from({ length: 256 }, (_, index) => index).join(", ") + "]", "",
  ].join("\n"));
  const matrixJob = parsed.jobs[0]!;
  assert.ok(matrixJob.matrix);
  let reads = 0;
  const include = Array.from({ length: 1000 }, (_, index) => ({
    get color() { reads += 1; return index; },
  }));
  const definition = { ...parsed, jobs: [{ ...matrixJob, matrix: { ...matrixJob.matrix, include } }] };
  const report = buildDiagnostics(bundle(Array.from({ length: 100 }, (_, index) => {
    const id = "r" + index;
    return run(id, [job("test 0", id)], definition);
  })));
  assert.equal(report.matchedJobs, 100);
  assert.equal(report.unmatchedJobs, 0);
  assert.deepEqual(report.workflows[0]!.matrixJobs, [{ key: "test", template: "test ${{ matrix.shard }}", legs: 256, dynamic: false }]);
  t.diagnostic("include value reads across 100 runs: " + reads);
  assert.equal(reads, 2 * include.length, "one diagnostic expansion and one shared job-name index");
});

test("matrix diagnostics keep the first version of a job and discover later new keys", () => {
  const firstJob = DEFINITION.jobs[0]!;
  assert.ok(firstJob.matrix);
  const first = { ...DEFINITION, jobs: [{ ...firstJob, matrix: { ...firstJob.matrix, dynamic: true } }] };
  const later = { ...DEFINITION, jobs: [
    { ...firstJob, displayName: "Later template" },
    { ...firstJob, key: "new-matrix" },
  ] };
  const report = buildDiagnostics(bundle([run("r1", [], first), run("r2", [], later)]));
  assert.deepEqual(report.workflows[0]!.matrixJobs, [
    { key: "new-matrix", template: "test", legs: 2, dynamic: false },
    { key: "test", template: "test", legs: null, dynamic: true },
  ]);
});

test("keeps unresolvable runs out of the attribution rate", () => {
  const report = buildDiagnostics(bundle([
    run("r1", [job("test (ubuntu-latest)", "r1")]),
    run("r2", [job("lint", "r2"), job("lint", "r2")], null),
  ]));

  assert.equal(report.runs, 2);
  assert.equal(report.unresolvedRuns, 1);
  assert.equal(report.unattributableJobs, 2);
  assert.equal(report.jobs, 1);
  assert.equal(report.matchedJobs, 1);
  assert.equal(report.matchPercent, 100);
});

test("reports every coverage axis and incomplete collection", () => {
  const report = buildDiagnostics(bundle([run("r1", [job("lint", "r1")])], {
    retentionStatus: "unavailable",
    missingScopes: [{ family: "jobs", resource: "actions.runs.jobs", runId: "r1", attempt: 1, path: null, pullRequest: null, branch: null, from: null, to: null, reason: "JOB_PAGE_LIMIT_REACHED", resumable: true }],
  }));

  assert.deepEqual(report.coverage.map((axis) => axis.axis), ["history", "workflowDefinitions", "changedFiles", "protectionRules", "retentionPolicy"]);
  const retention = report.coverage.find((axis) => axis.axis === "retentionPolicy");
  assert.ok(retention);
  assert.equal(retention.status, "unavailable");
  assert.equal(report.missingScopes.length, 1);
  assert.equal(diagnosticsIncomplete(report), true);
});

test("treats fully covered history without unresolved runs as complete", () => {
  const report = buildDiagnostics(bundle([run("r1", [job("lint", "r1")])]));
  assert.equal(diagnosticsIncomplete(report), false);
});

function cacheReport(workflow: readonly string[]) {
  const definition = parseWorkflow(PATH, ["name: ci", "on: [push]", "jobs:", "  build:", "    runs-on: ubuntu-latest", "    steps:", ...workflow, ""].join("\n"));
  return buildDiagnostics(bundle([run("r1", [job("build", "r1")], definition)]));
}

test("flags dependency installs that have no cache", () => {
  const report = cacheReport([
    "      - name: Install deps",
    "        run: npm ci",
  ]);

  assert.deepEqual(report.cacheHints, [{ workflowPath: PATH, code: "CACHE_MISSING", jobs: ["build"], steps: ["Install deps"] }]);
});

test("accepts a hashFiles cache key", () => {
  const report = cacheReport([
    "      - name: Cache npm",
    "        uses: actions/cache@v4",
    "        with:",
    "          path: ~/.npm",
    "          key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}",
    "      - run: npm ci",
  ]);

  assert.deepEqual(report.cacheHints, []);
});

test("flags literal cache keys that cannot follow the lockfile", () => {
  const report = cacheReport([
    "      - name: Cache deps",
    "        uses: actions/cache@v4",
    "        with:",
    "          path: node_modules",
    "          key: deps-v1",
    "      - run: npm ci",
  ]);

  assert.deepEqual(report.cacheHints, [{ workflowPath: PATH, code: "CACHE_KEY_UNPINNED", jobs: ["build"], steps: ["Cache deps"] }]);
});

test("accepts setup action built-in caching instead of actions/cache", () => {
  const report = cacheReport([
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: 22",
    "          cache: npm",
    "      - run: npm ci",
  ]);

  assert.deepEqual(report.cacheHints, []);
});
