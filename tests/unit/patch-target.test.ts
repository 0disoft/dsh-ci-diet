import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCoverage } from "../../src/core/analysis/coverage.ts";
import { DEFAULT_CONFIG } from "../../src/core/data/default-config.ts";
import { evaluateRules } from "../../src/core/rules/index.ts";
import { buildFinding } from "../../src/core/rules/types.ts";
import type { RuleContext } from "../../src/core/rules/types.ts";
import { parseWorkflow } from "../../src/core/workflow/index.ts";
import type { HistoryBundle, HistoryJob, HistoryRun } from "../../src/core/history/model.ts";
import type { Finding } from "../../src/core/contracts/schema.ts";
import { findFindingForRequest, targetReasons } from "../../src/core/patch/target.ts";
import type { PlanRequest } from "../../src/core/patch/target.ts";

const NOW = "2026-10-20T00:00:00.000Z";
const PATH = ".github/workflows/ci.yml";

const WORKFLOW = [
  "name: ci",
  "on:",
  "  pull_request:",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: npm test",
  "  deploy:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: ./deploy.sh",
].join("\n");

const DEFINITION = parseWorkflow(PATH, WORKFLOW);

function job(id: string, runId: string): HistoryJob {
  return {
    jobId: id,
    runId,
    attempt: 1,
    name: "build",
    workflowPath: PATH,
    conclusion: "success",
    startedAt: "2026-10-19T00:00:00.000Z",
    completedAt: "2026-10-19T00:16:40.000Z",
    durationMillis: 1000000,
    labels: ["ubuntu-latest"],
    runnerName: "GitHub Actions 1",
    sku: "actions_linux",
  };
}

function history(): HistoryBundle {
  const runs: HistoryRun[] = [];
  for (let index = 0; index < 20; index += 1) {
    const runId = String(100 + index);
    runs.push({
      runId,
      workflowPath: PATH,
      workflowName: "ci",
      headSha: "a".repeat(40),
      headBranch: "feature",
      event: "pull_request",
      createdAt: "2026-10-19T00:00:00.000Z",
      attempt: 1,
      conclusion: "success",
      pullRequestNumbers: [7],
      jobs: [job("j" + runId, runId)],
      definition: DEFINITION,
      definitionResolution: "resolved",
    });
  }
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
    protection: null,
    coverage: buildCoverage({ apiVersion: "2022-11-28", ghVersion: "2.0.0", requestedFrom: "2026-10-13T00:00:00.000Z", requestedTo: NOW }, {}),
    missingScopes: [],
  };
}

function context(bundle: HistoryBundle): RuleContext {
  return {
    identity: {
      bindingId: "b_test",
      repositoryId: bundle.repositoryId,
      repositoryFullName: bundle.repositoryFullName,
      rootIdentityHash: "sha256:" + "c".repeat(64),
    },
    coverage: {
      apiVersion: "2022-11-28",
      ghVersion: "2.0.0",
      requestedFrom: bundle.requestedFrom,
      requestedTo: bundle.requestedTo,
      ...bundle.coverage,
    },
    workflows: [DEFINITION],
    generatedAt: NOW,
    mode: "history",
    config: DEFAULT_CONFIG,
    history: bundle,
  };
}

function cd005Finding(bundle: HistoryBundle): Finding {
  const evaluations = evaluateRules(context(bundle), ["CD005"]);
  const finding = evaluations[0]?.findings[0];
  if (finding === undefined) throw new Error("fixture produced no CD005 finding");
  return finding;
}

const request = (overrides: Partial<PlanRequest>): PlanRequest => ({
  rule: "CD005",
  jobKey: "build",
  stepIndex: null,
  minutes: 34,
  retentionDays: 7,
  ...overrides,
});

test("accepts the job and minutes the finding measured", () => {
  const bundle = history();
  const finding = cd005Finding(bundle);
  const problems = targetReasons({ finding, request: request({}), history: bundle, workflowText: WORKFLOW, workflow: DEFINITION });
  assert.deepEqual(problems, []);
});

test("never selects a finding for another job", () => {
  const bundle = history();
  const finding = cd005Finding(bundle);
  const deploy = request({ jobKey: "deploy", minutes: 34 });
  assert.equal(findFindingForRequest([finding], deploy), null);
  assert.ok(findFindingForRequest([finding], request({})) !== null);
});

test("rejects minutes that no cohort recommendation produced", () => {
  const bundle = history();
  const finding = cd005Finding(bundle);
  const problems = targetReasons({ finding, request: request({ minutes: 1 }), history: bundle, workflowText: WORKFLOW, workflow: DEFINITION });
  assert.deepEqual(problems, ["MINUTES_NOT_FROM_EVIDENCE"]);
});

test("rejects a finding created for older workflow bytes", () => {
  const bundle = history();
  const finding = cd005Finding(bundle);
  const problems = targetReasons({ finding, request: request({}), history: bundle, workflowText: WORKFLOW + "\n# changed\n", workflow: DEFINITION });
  assert.deepEqual(problems, ["WORKFLOW_HASH_MISMATCH"]);
});

const ARTIFACT_WORKFLOW = [
  "on: pull_request",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/upload-artifact@v4",
  "      - run: echo hi",
].join("\n");

function cd008Finding(text: string, stepIndex: number): Finding {
  const workflow = parseWorkflow(PATH, text);
  return buildFinding({
    ruleId: "CD008",
    ruleVersion: "0.1.0",
    workflowPath: PATH,
    workflowHash: workflow.sha256,
    title: "artifact kept for 90 days",
    renderedText: "artifact kept for 90 days",
    evidenceLevel: "static",
    patchability: "review-only",
    evidenceRefs: ["workflow:" + PATH + "#jobs.build.steps[" + stepIndex + "]"],
    assumptions: [],
    blockers: [],
    standaloneRunnerSeconds: { status: "not_applicable", value: null, basis: "retention is storage", reason: "retention is storage" },
    identity: { workflowPath: PATH, jobKey: "build", stepIndex },
  });
}

test("refuses a CD008 step that does not upload an artifact or does not exist", () => {
  const workflow = parseWorkflow(PATH, ARTIFACT_WORKFLOW);
  const cdRequest = request({ rule: "CD008", stepIndex: 1 });
  assert.deepEqual(
    targetReasons({ finding: cd008Finding(ARTIFACT_WORKFLOW, 1), request: cdRequest, history: history(), workflowText: ARTIFACT_WORKFLOW, workflow }),
    ["STEP_NOT_UPLOAD_ARTIFACT"],
  );
  const missing = request({ rule: "CD008", stepIndex: 2 });
  assert.deepEqual(
    targetReasons({ finding: cd008Finding(ARTIFACT_WORKFLOW, 2), request: missing, history: history(), workflowText: ARTIFACT_WORKFLOW, workflow }),
    ["STEP_NOT_FOUND"],
  );
});