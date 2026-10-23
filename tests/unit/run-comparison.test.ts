import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compareRuns } from "../../src/core/analysis/run-comparison.ts";
import type { RunObservation } from "../../src/core/analysis/run-comparison.ts";
import { collectRunObservation } from "../../src/adapters/github/run-observation.ts";
import type { GhRunner } from "../../src/adapters/github/transport.ts";
import { compareCommand } from "../../src/cli/compare.ts";
import { renderRunComparison } from "../../src/core/report/run-comparison.ts";
import { systemClock } from "../../src/core/support/clock.ts";

const before: RunObservation = { id: 1, attempt: 1, repository: "owner/repo", workflow: ".github/workflows/ci.yml", branch: "main", event: "push", sha: "a".repeat(40),
  jobs: [{ name: "check", labels: ["ubuntu-latest"], seconds: 60, steps: [{ name: "test", seconds: 40 }] }] };
const after: RunObservation = { ...before, id: 2, sha: "b".repeat(40), jobs: [{ ...before.jobs[0]!, seconds: 40, steps: [{ name: "test", seconds: 20 }, { name: "cache", seconds: 4 }] }] };

test("run comparison reports measured differences and includes cache overhead without claiming billing or causality", () => {
  const report = compareRuns(before, after);
  assert.equal(report.comparable, true);
  assert.equal(report.observedReductionSeconds, 20);
  assert.equal(report.jobs[0]!.steps[0]!.observedReductionSeconds, 20);
  assert.deepEqual(report.jobs[0]!.addedSteps, [{ name: "cache", seconds: 4 }]);
  assert.equal(report.actualBilledUsd, null);
  assert.equal(report.verifiedCausalSavings, false);
  assert.ok(report.warnings.includes("SOURCE_CHANGED_REVIEW_DIFF_AND_TEST_SCOPE"));
  assert.equal(compareRuns(after, before).observedReductionSeconds, -20, "a slowdown must stay negative");
});

test("different scope, ambiguous jobs and identical attempts suppress an aggregate savings number", () => {
  for (const change of [{ event: "pull_request" }, { branch: "other" }, { workflow: "publish" }, { jobs: [] },
    { jobs: [{ ...after.jobs[0]!, labels: ["windows-latest"] }] }, { jobs: [...after.jobs, ...after.jobs] }]) {
    const report = compareRuns(before, { ...after, ...change });
    assert.equal(report.comparable, false);
    assert.equal(report.observedReductionSeconds, null);
    assert.equal(report.observedReductionPercent, null);
  }
  assert.ok(compareRuns(before, before).blockers.includes("SAME_RUN_ATTEMPT"));
  const duplicateSteps = compareRuns({ ...before, jobs: [{ ...before.jobs[0]!, steps: [{ name: "test", seconds: 1 }, { name: "test", seconds: 2 }] }] }, after);
  assert.equal(duplicateSteps.jobs[0]!.steps[0]!.afterSeconds, null);
});

function api(options: { failed?: boolean; partial?: boolean; changedAttempt?: boolean; missingTime?: boolean } = {}): { runner: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: GhRunner = async (args) => {
    calls.push([...args]);
    const path = args.find((arg) => arg.startsWith("/repos/"))!;
    const id = Number(/\/runs\/(\d+)/.exec(path)?.[1]);
    const start = "2026-10-24T00:00:00Z", end = id === 1 ? "2026-10-24T00:01:00Z" : "2026-10-24T00:00:40Z";
    const body = path.includes("/jobs") ? { total_count: options.partial ? 2 : 1, jobs: [{ name: "check", labels: ["ubuntu-latest"], status: "completed", conclusion: "success", started_at: start,
      completed_at: options.missingTime ? null : end, steps: [{ name: "test", status: "completed", conclusion: "success", started_at: start, completed_at: end }] }] }
      : { id, repository: { full_name: "owner/repo" }, path: before.workflow, head_branch: "main", event: "push", head_sha: String(id).repeat(40),
        status: "completed", conclusion: options.failed ? "failure" : "success", run_attempt: options.changedAttempt && calls.length >= 3 ? 2 : 1 };
    return { exitCode: 0, stdout: "HTTP/2.0 200 OK\r\n\r\n" + JSON.stringify(body), stderr: "" };
  };
  return { runner, calls };
}

test("collector uses read-only attempt-specific jobs and fails closed for incomplete, failed or changing runs", async () => {
  const good = api();
  const run = await collectRunObservation("owner/repo", 1, { runner: good.runner });
  assert.equal(run.jobs[0]!.seconds, 60);
  assert.equal(good.calls.length, 3);
  assert.ok(good.calls.some((call) => call.some((arg) => arg.includes("/attempts/1/jobs"))));
  assert.ok(good.calls.every((call) => call[0] === "api" && call.includes("GET")));
  for (const options of [{ failed: true }, { partial: true }, { changedAttempt: true }, { missingTime: true }]) {
    await assert.rejects(collectRunObservation("owner/repo", 1, { runner: api(options).runner }));
  }
});

test("compare CLI requires opt-in, writes standalone HTML and preserves an existing output file", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-compare-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let stdout = "", stderr = "";
  const context = { cwd: root, stdout: { write: (value: string) => { stdout += value; } }, stderr: { write: (value: string) => { stderr += value; } }, env: {}, clock: systemClock };
  const mock = api();
  const args = ["--repo", "owner/repo", "--before-run", "1", "--after-run", "2"];
  assert.equal(await compareCommand(args, context, mock.runner), 1);
  assert.equal(mock.calls.length, 0);
  assert.match(stderr, /NETWORK_OPT_IN_REQUIRED/);
  assert.equal(await compareCommand([...args, "--network"], context, mock.runner), 0);
  assert.equal(JSON.parse(stdout).observedReductionSeconds, 20);
  assert.equal(await compareCommand([...args, "--network", "--format", "html", "--out", "comparison.html", "--lang", "ko"], context, mock.runner), 0);
  const file = join(root, "comparison.html");
  const html = readFileSync(file, "utf8");
  assert.match(html, /lang="ko"/);
  assert.match(html, /관측/);
  assert.match(html, /SINGLE_PAIR_NOT_CAUSAL_PROOF/);
  assert.equal(await compareCommand([...args, "--network", "--format", "html", "--out", "comparison.html"], context, mock.runner), 1);
  assert.equal(readFileSync(file, "utf8"), html);
});

test("comparison HTML escapes remote content and uses no executable scripts", () => {
  const html = renderRunComparison(compareRuns({ ...before, jobs: [{ ...before.jobs[0]!, name: "<script>alert(1)</script>" }] }, after), "en");
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("default-src 'none'"));
});
