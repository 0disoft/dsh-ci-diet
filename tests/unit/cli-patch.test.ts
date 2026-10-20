import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildCoverage } from "../../src/core/analysis/coverage.ts";
import { buildHistoryReport } from "../../src/core/analysis/report.ts";
import { DEFAULT_CONFIG } from "../../src/core/data/default-config.ts";
import { PatchStore } from "../../src/core/patch/store.ts";
import { createLocalBinding } from "../../src/core/scan/binding.ts";
import { parseWorkflow } from "../../src/core/workflow/parse.ts";
import type { HistoryBundle, HistoryRun } from "../../src/core/history/model.ts";
import { isolatedEnv } from "../helpers/test-env.ts";

const NOW = "2026-10-20T00:00:00.000Z";
const CLI = join(import.meta.dirname, "..", "..", "src", "cli", "index.ts");

const WORKFLOW = [
  "name: pr",
  "on:",
  "  pull_request:",
  "jobs:",
  "  test:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: echo hi",
  "",
].join("\n");

function makeRepo(workflow = WORKFLOW): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-cli-patch-"));
  const dir = join(root, ".github", "workflows");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "pr.yml");
  writeFileSync(file, workflow, "utf8");
  return { root, file };
}

function seed(root: string, stateDir: string, workflowText = WORKFLOW): void {
  const binding = createLocalBinding(root, NOW, { repositoryFullName: "owner/repo" }).binding;
  const definition = parseWorkflow(".github/workflows/pr.yml", workflowText);
  const first = {
    runId: "100",
    workflowPath: ".github/workflows/pr.yml",
    workflowName: "pr",
    headSha: "a".repeat(40),
    headBranch: "feature",
    event: "pull_request",
    createdAt: "2026-10-19T00:00:00.000Z",
    attempt: 1,
    conclusion: "success",
    pullRequestNumbers: [7],
    jobs: [
      {
        jobId: "j1",
        runId: "100",
        attempt: 1,
        name: "test",
        workflowPath: ".github/workflows/pr.yml",
        conclusion: "success",
        startedAt: "2026-10-19T00:50:00.000Z",
        completedAt: "2026-10-19T01:10:00.000Z",
        durationMillis: 1200000,
        labels: ["ubuntu-latest"],
        runnerName: "GitHub Actions 1",
        sku: "actions_linux",
      },
    ],
    definition,
    definitionResolution: "resolved",
  } as HistoryRun;
  const second = {
    ...first,
    runId: "101",
    headSha: "b".repeat(40),
    createdAt: "2026-10-19T01:00:00.000Z",
    jobs: [{ ...first.jobs[0]!, jobId: "j2", runId: "101" }],
  } as HistoryRun;
  const coverage = buildCoverage(
    {
      apiVersion: "2022-11-28",
      ghVersion: "2.0.0",
      requestedFrom: "2026-10-13T00:00:00.000Z",
      requestedTo: NOW,
    },
    {},
  );
  const history: HistoryBundle = {
    repositoryId: binding.repositoryId,
    repositoryFullName: "owner/repo",
    defaultBranch: "main",
    requestedFrom: "2026-10-13T00:00:00.000Z",
    requestedTo: NOW,
    runs: [first, second],
    pulls: new Map(),
    workflows: [],
    artifacts: [],
    retention: null,
    protection: {
      defaultBranch: "main",
      ruleCount: 0,
      classicProtection: true,
      fetchedAt: new Date().toISOString(),
    },
    coverage,
    missingScopes: [],
  };
  const built = buildHistoryReport({
    binding,
    workflows: [definition],
    history,
    config: DEFAULT_CONFIG,
    generatedAt: NOW,
  });
  const store = PatchStore.open(stateDir);
  store.saveBinding(binding);
  store.saveReport(built.report);
  store.saveHistory(binding.bindingId, history);
}

function cli(
  args: readonly string[],
  cwd: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: isolatedEnv() });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("CLI plan, approve, apply, and revert round-trip a concurrency patch", () => {
  const { root, file } = makeRepo();
  const stateDir = join(root, ".state");
  seed(root, stateDir);

  const planned = cli(
    [
      "plan",
      "--rule",
      "CD001",
      "--cwd",
      root,
      "--state-dir",
      stateDir,
      "--claims",
      "ci-only,replace-safe",
      "--json",
    ],
    root,
  );
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout) as {
    planId: string;
    planDigest: string;
    status: { state: string };
  };
  assert.equal(plan.status.state, "draft");
  const confirmation = plan.planDigest.slice(-12);

  const approved = cli(
    ["approve", "--plan", plan.planId, "--confirm", confirmation, "--state-dir", stateDir],
    root,
  );
  assert.equal(approved.status, 0, approved.stderr);

  const applied = cli(["apply", "--plan", plan.planId, "--state-dir", stateDir, "--json"], root);
  assert.equal(applied.status, 0, applied.stderr);
  const outcome = JSON.parse(applied.stdout) as {
    state: string;
    change: { changeId: string; state: string };
  };
  assert.equal(outcome.state, "applied");
  const patched = readFileSync(file, "utf8");
  assert.match(patched, /concurrency:/);
  assert.match(patched, /cancel-in-progress: true/);

  const reverted = cli(
    ["revert", "--change", outcome.change.changeId, "--state-dir", stateDir, "--json"],
    root,
  );
  assert.equal(reverted.status, 0, reverted.stderr);
  assert.equal(readFileSync(file, "utf8"), WORKFLOW);

  const changes = cli(["changes", "--state-dir", stateDir], root);
  assert.equal(changes.status, 0);
  assert.match(changes.stdout, /REVERTED/);
});

test("CLI plan refuses without observed coverage", () => {
  const { root } = makeRepo();
  const result = cli(
    ["plan", "--rule", "CD001", "--cwd", root, "--state-dir", join(root, ".state")],
    root,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /sync --network/);
});

test("CLI approve rejects a wrong confirmation", () => {
  const { root } = makeRepo();
  const stateDir = join(root, ".state");
  seed(root, stateDir);
  const planned = cli(
    [
      "plan",
      "--rule",
      "CD001",
      "--cwd",
      root,
      "--state-dir",
      stateDir,
      "--claims",
      "ci-only,replace-safe",
      "--json",
    ],
    root,
  );
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout) as { planId: string };
  const result = cli(
    ["approve", "--plan", plan.planId, "--confirm", "000000000000", "--state-dir", stateDir],
    root,
  );
  assert.equal(result.status, 5, result.stderr);
});
test("CLI plan scopes reports to the repository at the current root", () => {
  const first = makeRepo();
  const second = makeRepo();
  const stateDir = join(first.root, ".state");
  seed(first.root, stateDir);
  seed(second.root, stateDir);

  const planned = cli(
    [
      "plan",
      "--rule",
      "CD001",
      "--cwd",
      first.root,
      "--state-dir",
      stateDir,
      "--claims",
      "ci-only,replace-safe",
    ],
    first.root,
  );
  assert.equal(planned.status, 0, planned.stderr);
  assert.ok(
    planned.stdout.includes(join(first.root, ".github", "workflows", "pr.yml")),
    planned.stdout,
  );
});

test("CLI plan refuses to reuse another repository's report", () => {
  const first = makeRepo();
  const second = makeRepo();
  const stateDir = join(first.root, ".state");
  seed(second.root, stateDir);

  const planned = cli(
    [
      "plan",
      "--rule",
      "CD001",
      "--cwd",
      first.root,
      "--state-dir",
      stateDir,
      "--claims",
      "ci-only,replace-safe",
    ],
    first.root,
  );
  assert.equal(planned.status, 1);
  assert.match(planned.stderr, /sync/i);
});

test("CLI plan uses the newest binding when an older association remains at the same root", () => {
  const { root } = makeRepo();
  const stateDir = join(root, ".state");
  seed(root, stateDir);
  const store = PatchStore.open(stateDir);
  const current = createLocalBinding(root, NOW, { repositoryFullName: "owner/repo" }).binding;
  // A valid older association sorts before the binding created by the latest sync.
  store.saveBinding({
    ...current,
    bindingId: "b_" + "0".repeat(24),
    stateScope: "b_" + "0".repeat(24),
    repositoryFullName: "owner/previous",
    createdAt: "2026-10-19T00:00:00Z",
  });
  const planned = cli(
    ["plan", "--rule", "CD001", "--cwd", root, "--state-dir", stateDir, "--claims", "ci-only,replace-safe", "--json"],
    root,
  );
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(store.findBindingByRoot(current.workspaceRoot)?.bindingId, current.bindingId);
  const plan = JSON.parse(planned.stdout) as { payload: { bindingId: string } };
  assert.equal(plan.payload.bindingId, current.bindingId);
});

test("CLI plan refuses findings for workflow bytes that changed", () => {
  const { root, file } = makeRepo();
  const stateDir = join(root, ".state");
  seed(root, stateDir);
  writeFileSync(file, WORKFLOW + "# changed\n", "utf8");
  const planned = cli(
    [
      "plan",
      "--rule",
      "CD001",
      "--cwd",
      root,
      "--state-dir",
      stateDir,
      "--claims",
      "ci-only,replace-safe",
    ],
    root,
  );
  assert.equal(planned.status, 3, planned.stderr);
  assert.match(planned.stderr, /WORKFLOW_HASH_MISMATCH/);
});

test("CLI plan records unresolved dependencies as blockers and apply refuses", () => {
  const workflowText = [
    "name: pr",
    "on:",
    "  pull_request:",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: node absent.js",
    "",
  ].join("\n");
  const { root } = makeRepo(workflowText);
  const stateDir = join(root, ".state");
  seed(root, stateDir, workflowText);

  const planned = cli(
    [
      "plan",
      "--rule",
      "CD001",
      "--cwd",
      root,
      "--state-dir",
      stateDir,
      "--claims",
      "ci-only,replace-safe",
      "--json",
    ],
    root,
  );
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout) as {
    planId: string;
    planDigest: string;
    payload: { blockers: string[] };
  };
  assert.ok(
    plan.payload.blockers.includes("UNRESOLVED_DEPENDENCY:absent.js"),
    plan.payload.blockers.join(","),
  );

  const approved = cli(
    [
      "approve",
      "--plan",
      plan.planId,
      "--confirm",
      plan.planDigest.slice(-12),
      "--state-dir",
      stateDir,
    ],
    root,
  );
  assert.equal(approved.status, 0, approved.stderr);

  const applied = cli(["apply", "--plan", plan.planId, "--state-dir", stateDir], root);
  assert.equal(applied.status, 3, applied.stderr);
  assert.match(applied.stdout, /BLOCKERS_PRESENT/);
});
