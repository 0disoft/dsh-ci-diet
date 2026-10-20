import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCoverage } from "../../src/core/analysis/coverage.ts";
import { DEFAULT_CONFIG } from "../../src/core/data/default-config.ts";
import { evaluateRules } from "../../src/core/rules/index.ts";
import { parseWorkflow } from "../../src/core/workflow/index.ts";
import type { HistoryBundle, HistoryJob, HistoryRun } from "../../src/core/history/model.ts";
import type { WorkflowDefinition } from "../../src/core/workflow/model.ts";
import type { RuleContext } from "../../src/core/rules/types.ts";

const NOW = "2026-10-20T00:00:00.000Z";

const PR_ONLY = [
  "name: pr",
  "on:",
  "  pull_request:",
  "jobs:",
  "  test:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: echo hi",
].join("\n");

const PR_AND_PUSH = [
  "on: [push, pull_request]",
  "jobs:",
  "  test:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: echo hi",
].join("\n");

function definition(text: string, path = ".github/workflows/pr.yml"): WorkflowDefinition {
  return parseWorkflow(path, text);
}

function job(id: string, runId: string, startIso: string, durationMillis: number, conclusion: string | null = "success"): HistoryJob {
  const start = Date.parse(startIso);
  return {
    jobId: id,
    runId,
    attempt: 1,
    name: "test",
    workflowPath: ".github/workflows/pr.yml",
    conclusion,
    startedAt: startIso,
    completedAt: new Date(start + durationMillis).toISOString(),
    durationMillis,
    labels: ["ubuntu-latest"],
    runnerName: "GitHub Actions 1",
    sku: "actions_linux",
  };
}

function run(id: string, options: {
  sha?: string;
  createdAt?: string;
  event?: string;
  pullRequestNumbers?: number[];
  jobs?: HistoryJob[];
  definition?: WorkflowDefinition | null;
  path?: string;
} = {}): HistoryRun {
  return {
    runId: id,
    workflowPath: options.path ?? ".github/workflows/pr.yml",
    workflowName: "pr",
    headSha: options.sha ?? "a".repeat(40),
    headBranch: "feature",
    event: options.event ?? "pull_request",
    createdAt: options.createdAt ?? "2026-10-19T00:00:00.000Z",
    attempt: 1,
    conclusion: "success",
    pullRequestNumbers: options.pullRequestNumbers ?? [7],
    jobs: options.jobs ?? [],
    definition: options.definition === undefined ? definition(PR_ONLY) : options.definition,
    definitionResolution: "resolved",
  };
}

function bundle(runs: HistoryRun[], pulls = new Map()): HistoryBundle {
  const coverage = buildCoverage({ apiVersion: "2022-11-28", ghVersion: "2.0.0", requestedFrom: "2026-10-13T00:00:00.000Z", requestedTo: NOW }, {});
  return {
    repositoryId: "git:" + "b".repeat(32),
    repositoryFullName: "owner/repo",
    defaultBranch: "main",
    requestedFrom: "2026-10-13T00:00:00.000Z",
    requestedTo: NOW,
    runs,
    pulls,
    workflows: [],
    artifacts: [],
    retention: null,
    protection: { defaultBranch: "main", ruleCount: 0, classicProtection: true, fetchedAt: NOW },
    coverage,
    missingScopes: [],
  };
}

function context(history: HistoryBundle, rules: RuleContext["config"] = DEFAULT_CONFIG): RuleContext {
  const workflows = [...new Set(history.runs.map((entry) => entry.definition).filter((entry): entry is WorkflowDefinition => entry !== null))];
  return {
    identity: { bindingId: "b_test", repositoryId: history.repositoryId, repositoryFullName: history.repositoryFullName, rootIdentityHash: "sha256:" + "c".repeat(64) },
    coverage: buildCoverage({ apiVersion: "2022-11-28", ghVersion: "2.0.0", requestedFrom: history.requestedFrom, requestedTo: history.requestedTo }, {}),
    workflows,
    generatedAt: NOW,
    mode: "history",
    config: rules,
    history,
  };
}

function rule(report: ReturnType<typeof evaluateRules>, id: string) {
  const found = report.find((entry) => entry.results[0]?.ruleId === id);
  assert.ok(found, "missing rule result " + id);
  return found;
}

test("CD001 finds a superseded pull request run and records a removal", () => {
  const first = run("100", {
    sha: "1".repeat(40),
    createdAt: "2026-10-19T00:00:00.000Z",
    jobs: [job("j1", "100", "2026-10-19T00:00:10.000Z", 600000)],
  });
  const second = run("101", {
    sha: "2".repeat(40),
    createdAt: "2026-10-19T00:02:00.000Z",
    jobs: [job("j2", "101", "2026-10-19T00:02:10.000Z", 300000)],
  });
  const evaluation = rule(evaluateRules(context(bundle([first, second]))), "CD001");
  assert.equal(evaluation.results[0]?.outcome, "finding");
  assert.equal(evaluation.findings.length, 1);
  const finding = evaluation.findings[0];
  assert.ok(finding);
  assert.equal(finding.patchability, "eligible");
  assert.match(finding.renderedText, /0 s lag/);
  assert.equal(evaluation.removals.length, 1);
  assert.equal(evaluation.removals[0]?.jobId, "j1");
  assert.ok((evaluation.removals[0]?.endMillis ?? 0) > 0);
});

test("CD001 keeps an existing concurrency policy review-only", () => {
  const text = [
    "on:",
    "  pull_request:",
    "concurrency:",
    "  group: ci-${{ github.ref }}",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo hi",
  ].join("\n");
  const parsed = definition(text);
  const first = run("200", { sha: "3".repeat(40), createdAt: "2026-10-19T00:00:00.000Z", definition: parsed, jobs: [job("j3", "200", "2026-10-19T00:00:10.000Z", 600000)] });
  const second = run("201", { sha: "4".repeat(40), createdAt: "2026-10-19T00:02:00.000Z", definition: parsed });
  const evaluation = rule(evaluateRules(context(bundle([first, second]))), "CD001");
  assert.equal(evaluation.findings[0]?.patchability, "review-only");
  assert.ok(evaluation.findings[0]?.blockers.includes("EXISTING_CONCURRENCY_POLICY"));
});

test("CD002 reports a duplicate trigger as a candidate", () => {
  const parsed = definition(PR_AND_PUSH);
  const history = bundle([run("300", { definition: parsed })]);
  const evaluation = rule(evaluateRules(context(history)), "CD002");
  assert.equal(evaluation.results[0]?.outcome, "candidate");
  assert.equal(evaluation.findings[0]?.patchability, "review-only");
  assert.ok(evaluation.findings[0]?.blockers.includes("TRIGGER_REMOVAL_NOT_SUPPORTED"));
});

test("CD003 attributes heavy jobs on documentation-only pull requests", () => {
  const pulls = new Map([[7, { number: 7, baseBranch: "main", headBranch: "feature", files: ["README.md", "docs/notes/design.md"] }]]);
  const history = bundle([run("400", { jobs: [job("j4", "400", "2026-10-19T00:00:00.000Z", 120000)] })], pulls);
  const report = evaluateRules(context(history), ["CD003"]);
  const evaluation = rule(report, "CD003");
  assert.equal(evaluation.results[0]?.outcome, "candidate");
  assert.equal(evaluation.findings.length, 1);
  assert.ok(evaluation.findings[0]?.blockers.includes("PATH_FILTER_NOT_GENERATED"));
});

test("CD003 ignores pull requests that touch product code", () => {
  const pulls = new Map([[7, { number: 7, baseBranch: "main", headBranch: "feature", files: ["README.md", "src/index.ts"] }]]);
  const history = bundle([run("401", { jobs: [job("j5", "401", "2026-10-19T00:00:00.000Z", 120000)] })], pulls);
  const evaluation = rule(evaluateRules(context(history), ["CD003"]), "CD003");
  assert.equal(evaluation.results[0]?.outcome, "no_finding");
});

test("CD005 computes a p95 timeout cohort from 20 successful samples", () => {
  const jobs: HistoryJob[] = [];
  for (let index = 0; index < 20; index += 1) {
    jobs.push(job("t" + index, "500", "2026-10-19T00:00:00.000Z", (10 + index) * 1000));
  }
  const history = bundle([run("500", { jobs })]);
  const evaluation = rule(evaluateRules(context(history), ["CD005"]), "CD005");
  assert.equal(evaluation.results[0]?.outcome, "candidate");
  const finding = evaluation.findings[0];
  assert.ok(finding);
  assert.equal(finding.patchability, "eligible");
  assert.ok(finding.blockers.length === 0);
  assert.match(finding.title, /p95 is 28\.0 s/);
  assert.match(finding.renderedText, /timeout of 6 minutes/);
});

test("CD005 keeps a small cohort review-only", () => {
  const jobs: HistoryJob[] = [];
  for (let index = 0; index < 6; index += 1) {
    jobs.push(job("s" + index, "501", "2026-10-19T00:00:00.000Z", (10 + index) * 1000));
  }
  const evaluation = rule(evaluateRules(context(bundle([run("501", { jobs })])), ["CD005"]), "CD005");
  assert.equal(evaluation.findings[0]?.patchability, "review-only");
  assert.ok(evaluation.findings[0]?.blockers.includes("COHORT_BELOW_20"));
});
