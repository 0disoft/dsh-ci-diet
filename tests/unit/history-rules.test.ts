import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCoverage } from "../../src/core/analysis/coverage.ts";
import { findingFingerprint } from "../../src/core/analysis/fingerprint.ts";
import { claimsFromTokens, evaluatePatchEligibility } from "../../src/core/patch/eligibility.ts";
import { targetReasons } from "../../src/core/patch/target.ts";
import { cd005Recommendations } from "../../src/core/rules/cd005.ts";
import { DEFAULT_CONFIG } from "../../src/core/data/default-config.ts";
import { evaluateRules } from "../../src/core/rules/index.ts";
import { parseWorkflow } from "../../src/core/workflow/index.ts";
import type { HistoryBundle, HistoryJob, HistoryPull, HistoryRun, ProtectionSnapshot } from "../../src/core/history/model.ts";
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


const TIMEOUT_WORKFLOW = (minutes: number | string): string =>
  [
    "name: pr",
    "on:",
    "  pull_request:",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: " + String(minutes),
    "    steps:",
    "      - run: echo hi",
    "",
  ].join("\n");

const UPLOAD_WORKFLOW = (extra: readonly string[]): string =>
  [
    "on:",
    "  pull_request:",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/upload-artifact@v4",
    ...extra,
    "",
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

function bundle(
  runs: HistoryRun[],
  pulls = new Map(),
  protection: Partial<ProtectionSnapshot> = {},
): HistoryBundle {
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
    protection: { defaultBranch: "main", ruleCount: 0, classicProtection: true, fetchedAt: NOW, ...protection },
    coverage,
    missingScopes: [],
  };
}

function pull(baseBranch: string, number = 7): Map<number, HistoryPull> {
  return new Map([[number, { number, baseBranch, headBranch: "feature", files: [] }]]);
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
  const evaluation = rule(
    evaluateRules(context(bundle([first, second], pull("main"), { classicProtection: false }))),
    "CD001",
  );
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

test("CD001 keeps the candidate but drops savings when coverage degrades", () => {
  const first = run("300", {
    sha: "1".repeat(40),
    createdAt: "2026-10-19T00:00:00.000Z",
    jobs: [job("j300", "300", "2026-10-19T00:00:10.000Z", 600000)],
  });
  const second = run("301", {
    sha: "2".repeat(40),
    createdAt: "2026-10-19T00:02:00.000Z",
    jobs: [job("j301", "301", "2026-10-19T00:02:10.000Z", 300000)],
  });
  const ctx = context(bundle([first, second], pull("main"), { classicProtection: false }));
  (ctx.coverage.history as { status: string }).status = "partial";
  const evaluation = rule(evaluateRules(ctx), "CD001");
  assert.equal(evaluation.results[0]?.outcome, "finding");
  const finding = evaluation.findings[0];
  assert.ok(finding);
  assert.equal(finding.patchability, "review-only");
  assert.ok(finding.blockers.includes("COVERAGE_DEGRADE"));
  assert.equal(finding.standaloneRunnerSeconds.status, "unknown");
  assert.equal(finding.standaloneRunnerSeconds.reason, "COVERAGE_DEGRADE");
  assert.match(finding.renderedText, /Coverage is degraded/);
  assert.doesNotMatch(finding.renderedText, /0 s lag/);
  assert.equal(evaluation.removals.length, 0);
});
function supersededRuns(parsed: WorkflowDefinition, prefix: string): HistoryRun[] {
  return [
    run(prefix + "0", { sha: "5".repeat(40), createdAt: "2026-10-19T00:00:00.000Z", definition: parsed, jobs: [job(prefix + "--job", prefix + "0", "2026-10-19T00:00:10.000Z", 600000)] }),
    run(prefix + "1", { sha: "6".repeat(40), createdAt: "2026-10-19T00:02:00.000Z", definition: parsed }),
  ];
}

test("CD001 blocks a pull request that targets a branch other than the protected default", () => {
  const parsed = definition(PR_ONLY);
  const history = bundle(supersededRuns(parsed, "210"), pull("release"), { classicProtection: false });
  const evaluation = rule(evaluateRules(context(history)), "CD001");
  assert.equal(evaluation.findings[0]?.patchability, "review-only");
  assert.ok(evaluation.findings[0]?.blockers.includes("PULL_REQUEST_BASE_BRANCH_NOT_DEFAULT"));
});

test("CD001 blocks classic branch protection even without required checks", () => {
  const parsed = definition(PR_ONLY);
  const history = bundle(supersededRuns(parsed, "220"), pull("main"), { classicProtection: true, ruleCount: 0 });
  const evaluation = rule(evaluateRules(context(history)), "CD001");
  assert.equal(evaluation.findings[0]?.patchability, "review-only");
  assert.ok(evaluation.findings[0]?.blockers.includes("CLASSIC_BRANCH_PROTECTION_UNKNOWN"));
});

test("CD001 blocks a run whose pull request base branch was not synced", () => {
  const parsed = definition(PR_ONLY);
  const history = bundle(supersededRuns(parsed, "230"), new Map(), { classicProtection: false });
  const evaluation = rule(evaluateRules(context(history)), "CD001");
  assert.equal(evaluation.findings[0]?.patchability, "review-only");
  assert.ok(evaluation.findings[0]?.blockers.includes("PULL_REQUEST_BASE_BRANCH_UNKNOWN"));
});

test("CD001 keeps a mixed pull_request_target workflow unplannable", () => {
  const parsed = definition([
    "name: pr",
    "on:",
    "  pull_request:",
    "  pull_request_target:",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo hi",
  ].join("\n"));
  const history = bundle(supersededRuns(parsed, "240"), pull("main"), { classicProtection: false });
  const ctx = context(history);
  const evaluation = rule(evaluateRules(ctx), "CD001");
  const subject = evaluation.findings[0];
  assert.ok(subject);
  assert.equal(subject.patchability, "review-only");
  assert.ok(subject.blockers.includes("WORKFLOW_TRIGGERS_NOT_PR_ONLY"));
  const eligibility = evaluatePatchEligibility({
    rule: "CD001",
    finding: subject,
    coverage: ctx.coverage,
    claims: claimsFromTokens(["ci-only", "replace-safe"]),
    history,
    currentDefinitionParsed: true,
    editedJobEvidenceComplete: true,
    now: new Date(NOW),
  });
  assert.equal(eligibility.allowed, false);
  assert.ok(eligibility.reasons.includes("WORKFLOW_TRIGGERS_NOT_PR_ONLY"));
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

function twentyJobs(runId: string): HistoryJob[] {
  const jobs: HistoryJob[] = [];
  for (let index = 0; index < 20; index += 1) {
    jobs.push(job("t" + index, runId, "2026-10-19T00:00:00.000Z", (10 + index) * 1000));
  }
  return jobs;
}

const MATRIX_WORKFLOW = [
  "name: pr",
  "on:",
  "  pull_request:",
  "jobs:",
  "  test:",
  "    runs-on: ubuntu-latest",
  "    strategy:",
  "      matrix:",
  "        os: [ubuntu-latest, windows-2022]",
  "    steps:",
  "      - run: echo hi",
  "",
].join("\n");

/** Twenty fast Linux legs and twenty slow Windows legs of the same job. */
function matrixJobs(runId: string): HistoryJob[] {
  const jobs: HistoryJob[] = [];
  for (let index = 0; index < 20; index += 1) {
    jobs.push({ ...job("f" + index, runId, "2026-10-19T00:00:00.000Z", (10 + index) * 1000), name: "test (ubuntu-latest)" });
    jobs.push({ ...job("w" + index, runId, "2026-10-19T00:00:00.000Z", (600 + index) * 1000), name: "test (windows-2022)", labels: ["windows-2022"] });
  }
  return jobs;
}

test("CD005 cannot plan a job-wide timeout when a declared matrix leg has no successful samples", () => {
  const parsed = definition(MATRIX_WORKFLOW);
  for (const failedLegPresent of [false, true]) {
    const runId = "missing-leg-" + failedLegPresent;
    const jobs = matrixJobs(runId).filter((entry) => entry.name === "test (ubuntu-latest)");
    if (failedLegPresent) jobs.push({
      ...job("slow-failed", runId, "2026-10-19T00:00:00.000Z", 1_800_000, "failure"),
      name: "test (windows-2022)", labels: ["windows-2022"],
    });
    const history = bundle([run(runId, { jobs, definition: parsed })]);
    const finding = rule(evaluateRules(context(history), ["CD005"]), "CD005").findings[0];
    assert.ok(finding);
    assert.match(finding.renderedText, /6 minutes/);
    assert.equal(finding.patchability, "review-only", "20 fast successes cannot cover a leg with 0 successes");
    assert.ok(finding.blockers.includes("COHORT_BELOW_20"));
    assert.deepEqual(cd005Recommendations(history, parsed.path, parsed.sha256, "test"), []);
    const olderFinding = { ...finding, patchability: "eligible" as const, blockers: [] };
    const reasons = targetReasons({ finding: olderFinding, history, workflowText: MATRIX_WORKFLOW, workflow: parsed,
      request: { rule: "CD005", jobKey: "test", stepIndex: null, minutes: 6, retentionDays: 7 } });
    assert.ok(reasons.includes("EVIDENCE_NOT_FOUND"), "an older actionable finding cannot bypass the new evidence check");
  }
});

test("CD005 never pools unidentifiable dynamic matrix legs into a timeout cohort", () => {
  const text = MATRIX_WORKFLOW.replace("        os: [ubuntu-latest, windows-2022]", "        os: ${{ fromJSON(inputs.runners) }}")
    .replace("    runs-on: ubuntu-latest", "    name: Shared\n    runs-on: ubuntu-latest");
  const parsed = definition(text);
  const jobs = matrixJobs("dynamic").map((entry) => ({ ...entry, name: "Shared" }));
  const history = bundle([run("dynamic", { jobs, definition: parsed })]);
  assert.equal(rule(evaluateRules(context(history), ["CD005"]), "CD005").findings.length, 0);
  assert.deepEqual(cd005Recommendations(history, parsed.path, parsed.sha256, "test"), []);
});

test("CD005 keeps an equal or smaller literal timeout", () => {
  for (const minutes of [5, 6]) {
    const parsed = definition(TIMEOUT_WORKFLOW(minutes));
    const history = bundle([run("510", { jobs: twentyJobs("510"), definition: parsed })]);
    const evaluation = rule(evaluateRules(context(history), ["CD005"]), "CD005");
    assert.equal(evaluation.results[0]?.outcome, "no_finding", "timeout-minutes: " + minutes);
  }
});

test("CD005 proposes reducing a larger literal timeout", () => {
  const parsed = definition(TIMEOUT_WORKFLOW(30));
  const history = bundle([run("511", { jobs: twentyJobs("511"), definition: parsed })]);
  const finding = rule(evaluateRules(context(history), ["CD005"]), "CD005").findings[0];
  assert.ok(finding);
  assert.equal(finding.patchability, "review-only");
  assert.match(finding.title, /caps at 30 minutes; p95 is 28\.0 s/);
  assert.doesNotMatch(finding.title, /no timeout/);
  assert.match(finding.renderedText, /reduced to 6 minutes/);
  assert.equal(finding.message, undefined);
});

test("CD005 reports an expression timeout without proposing a literal", () => {
  const parsed = definition(TIMEOUT_WORKFLOW("$" + "{{ inputs.timeout }}"));
  const history = bundle([run("512", { jobs: twentyJobs("512"), definition: parsed })]);
  const finding = rule(evaluateRules(context(history), ["CD005"]), "CD005").findings[0];
  assert.ok(finding);
  assert.equal(finding.patchability, "review-only");
  assert.match(finding.title, /expression timeout/);
  assert.ok(finding.blockers.includes("EXPRESSION_TIMEOUT_REPORT_ONLY"));
});

test("CD005 ignores a cohort whose definition hash is not the scanned file", () => {
  const sampled = definition(PR_ONLY);
  const history = bundle([run("513", { jobs: twentyJobs("513"), definition: sampled })]);
  const edited = definition(TIMEOUT_WORKFLOW(30));
  const evaluation = rule(evaluateRules({ ...context(history), workflows: [edited] }, ["CD005"]), "CD005");
  assert.equal(evaluation.findings.length, 0);
  assert.equal(evaluation.results[0]?.outcome, "no_finding");
});

test("CD005 aggregates matrix legs into one job-wide recommendation", () => {
  const parsed = definition(MATRIX_WORKFLOW);
  const history = bundle([run("520", { jobs: matrixJobs("520"), definition: parsed })]);
  const evaluation = rule(evaluateRules(context(history), ["CD005"]), "CD005");
  assert.equal(evaluation.findings.length, 1);
  const finding = evaluation.findings[0];
  assert.ok(finding);
  assert.equal(finding.patchability, "eligible");
  assert.match(finding.title, /p95 is 618\.0 s/);
  assert.match(finding.renderedText, /across 2 matrix\/runner cohorts with a slowest-cohort nearest-rank p95 of 618\.0 s/);
  const matrixIdentity = [JSON.stringify({ os: "ubuntu-latest" }), JSON.stringify({ os: "windows-2022" })];
  assert.equal(finding.fingerprint, findingFingerprint({
    ruleId: "CD005",
    ruleVersion: finding.ruleVersion,
    workflowPath: ".github/workflows/pr.yml",
    workflowHash: parsed.sha256,
    identity: {
      workflowPath: ".github/workflows/pr.yml",
      workflowHash: parsed.sha256,
      jobKey: "test",
      runnerKey: "ubuntu-latest+windows-2022",
      event: "pull_request",
      sampleCount: 40,
      matrix: matrixIdentity,
    },
  }));
  const evidence = cd005Recommendations(history, ".github/workflows/pr.yml", parsed.sha256, "test");
  assert.deepEqual(evidence.map((entry) => entry.recommendedMinutes), [21]);
  assert.equal(evidence[0]?.sampleCount, 40);
  const request = { rule: "CD005" as const, jobKey: "test", stepIndex: null, retentionDays: 7 };
  const input = { finding, history, workflowText: MATRIX_WORKFLOW, workflow: parsed };
  assert.deepEqual(targetReasons({ ...input, request: { ...request, minutes: 21 } }), []);
  assert.ok(targetReasons({ ...input, request: { ...request, minutes: 6 } }).includes("MINUTES_NOT_FROM_EVIDENCE"));
});

test("CD008 treats retention-days: 0 as the repository default", () => {
  const parsed = definition(UPLOAD_WORKFLOW(["        with:", "          retention-days: 0"]));
  const evaluation = rule(evaluateRules(context(bundle([run("600", { definition: parsed })])), ["CD008"]), "CD008");
  const finding = evaluation.findings[0];
  assert.ok(finding);
  assert.match(finding.title, /repository default/);
  assert.match(finding.renderedText, /repository default \(retention-days: 0\)/);
  assert.equal(finding.patchability, "review-only");
});

test("CD008 keeps a 7-day literal and reports a larger one", () => {
  const seven = definition(UPLOAD_WORKFLOW(["        with:", "          retention-days: 7"]));
  const kept = rule(evaluateRules(context(bundle([run("601", { definition: seven })])), ["CD008"]), "CD008");
  assert.equal(kept.findings.length, 0);
  const thirty = definition(UPLOAD_WORKFLOW(["        with:", "          retention-days: 30"]));
  const reported = rule(evaluateRules(context(bundle([run("602", { definition: thirty })])), ["CD008"]), "CD008");
  assert.equal(reported.findings.length, 1);
  assert.match(reported.findings[0]?.title ?? "", /30 days/);
});

test("CD003 records a run once even when it repeats the same pull request number", () => {
  const pulls = new Map([[7, { number: 7, baseBranch: "main", headBranch: "feature", files: ["README.md"] }]]);
  const history = bundle([run("710", { pullRequestNumbers: [7, 7], jobs: [job("j710", "710", "2026-10-19T00:00:00.000Z", 120000)] })], pulls);
  const evaluation = rule(evaluateRules(context(history), ["CD003"]), "CD003");
  assert.equal(evaluation.findings.length, 1);
});

test("CD003 emits findings in pull request map order, not run order", () => {
  const docsPull = (number: number) => ({ number, baseBranch: "main", headBranch: "feature", files: ["README.md"] });
  const pulls = new Map([[8, docsPull(8)], [7, docsPull(7)]]);
  const history = bundle([
    run("720", { pullRequestNumbers: [7], jobs: [job("j720", "720", "2026-10-19T00:00:00.000Z", 120000)] }),
    run("721", { pullRequestNumbers: [8], jobs: [job("j721", "721", "2026-10-19T00:00:00.000Z", 120000)] }),
  ], pulls);
  const evaluation = rule(evaluateRules(context(history), ["CD003"]), "CD003");
  assert.deepEqual(evaluation.findings.map((entry) => entry.title), [
    "Documentation-only pull request #8 ran heavy checks",
    "Documentation-only pull request #7 ran heavy checks",
  ]);
});

test("CD001 skips a same-head rerun and uses the next different head", () => {
  const first = run("330", { sha: "7".repeat(40), createdAt: "2026-10-19T00:00:00.000Z", jobs: [job("j330", "330", "2026-10-19T00:00:10.000Z", 600000)] });
  const rerun = run("331", { sha: "7".repeat(40), createdAt: "2026-10-19T00:01:00.000Z" });
  const third = run("332", { sha: "8".repeat(40), createdAt: "2026-10-19T00:02:00.000Z" });
  const evaluation = rule(evaluateRules(context(bundle([first, rerun, third], pull("main"), { classicProtection: false }))), "CD001");
  assert.equal(evaluation.findings.length, 1);
  assert.ok(evaluation.findings[0]?.evidenceRefs.includes("run:332"));
  assert.ok(!evaluation.findings[0]?.evidenceRefs.includes("run:331"));
});

test("CD001 treats an equal createdAt tie as no replacement", () => {
  const first = run("340", { sha: "9".repeat(40), createdAt: "2026-10-19T00:00:00.000Z", jobs: [job("j340", "340", "2026-10-19T00:00:10.000Z", 600000)] });
  const tie = run("341", { sha: "a".repeat(40), createdAt: "2026-10-19T00:00:00.000Z" });
  const evaluation = rule(evaluateRules(context(bundle([first, tie], pull("main"), { classicProtection: false }))), "CD001");
  assert.equal(evaluation.results[0]?.outcome, "no_finding");
});

test("CD005 keeps definition hashes and job keys in separate cohorts", () => {
  const testDefinition = definition(PR_ONLY);
  const lintDefinition = definition([
    "name: pr",
    "on:",
    "  pull_request:",
    "jobs:",
    "  lint:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo hi",
    "",
  ].join("\n"));
  const testJobs: HistoryJob[] = [];
  const lintJobs: HistoryJob[] = [];
  for (let index = 0; index < 20; index += 1) {
    testJobs.push(job("a" + index, "610", "2026-10-19T00:00:00.000Z", (10 + index) * 1000));
    lintJobs.push(job("b" + index, "611", "2026-10-19T00:00:00.000Z", (100 + index) * 1000));
  }
  const history = bundle([
    run("610", { definition: testDefinition, jobs: testJobs }),
    run("611", { definition: lintDefinition, jobs: lintJobs }),
  ]);
  const evaluation = rule(evaluateRules(context(history), ["CD005"]), "CD005");
  assert.equal(evaluation.findings.length, 2);
  assert.match(evaluation.findings[0]?.title ?? "", /^Job test /);
  assert.match(evaluation.findings[1]?.title ?? "", /^Job lint /);
  assert.equal(cd005Recommendations(history, ".github/workflows/pr.yml", testDefinition.sha256, "test").length, 1);
  assert.equal(cd005Recommendations(history, ".github/workflows/pr.yml", lintDefinition.sha256, "lint").length, 1);
  assert.equal(cd005Recommendations(history, ".github/workflows/pr.yml", testDefinition.sha256, "lint").length, 0);
});

