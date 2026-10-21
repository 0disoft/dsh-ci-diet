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
