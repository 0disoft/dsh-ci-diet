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

test("indexed comparison preserves runner identity, ambiguous steps, added-step order and input order", () => {
  const left = { ...before, jobs: [
    { name: "same", labels: ["linux", "x64"], seconds: 20, steps: [
      { name: "duplicate", seconds: 1 }, { name: "duplicate", seconds: 2 }, { name: "__proto__", seconds: 3 }, { name: "missing", seconds: 4 },
    ] },
    { name: "same", labels: ["windows"], seconds: 30, steps: [{ name: "test", seconds: 20 }] },
  ] };
  const right = { ...after, jobs: [
    { name: "same", labels: ["windows"], seconds: 25, steps: [{ name: "test", seconds: 10 }, { name: "test", seconds: 12 }] },
    { name: "same", labels: ["x64", "linux"], seconds: 15, steps: [
      { name: "new", seconds: 1 }, { name: "duplicate", seconds: 1 }, { name: "__proto__", seconds: 2 }, { name: "new", seconds: 2 },
    ] },
  ] };
  const original = JSON.stringify([left, right]);
  const result = compareRuns(left, right);
  assert.equal(result.comparable, true);
  assert.deepEqual(result.jobs.map((job) => job.afterSeconds), [15, 25]);
  assert.deepEqual(result.jobs[0]!.steps.map((step) => step.afterSeconds), [null, null, 2, null]);
  assert.equal(result.jobs[1]!.steps[0]!.afterSeconds, null);
  assert.deepEqual(result.jobs[0]!.addedSteps, [{ name: "new", seconds: 1 }, { name: "new", seconds: 2 }]);
  assert.equal(JSON.stringify([left, right]), original, "comparison must not mutate either observation");
  const ambiguous = compareRuns(left, { ...right, jobs: [...right.jobs, { ...right.jobs[1]!, seconds: 999 }] });
  assert.equal(ambiguous.comparable, false);
  assert.equal(ambiguous.observedReductionSeconds, null);
  assert.equal(ambiguous.jobs[0]!.afterSeconds, null, "duplicate identities cannot select the first match");
  const missing = compareRuns(left, { ...right, jobs: right.jobs.slice(0, 1) });
  assert.equal(missing.jobs[0]!.afterSeconds, null);
});

test("duplicate job identities on either side never yield attributed job or step differences", () => {
  const uniqueBefore = { ...before.jobs[0]!, name: "unique" };
  const uniqueAfter = { ...after.jobs[0]!, name: "unique" };
  for (const [beforeCount, afterCount] of [[2, 1], [3, 1], [1, 2], [1, 3], [2, 2], [3, 3]] as const) {
    const left = { ...before, jobs: [
      ...Array.from({ length: beforeCount }, () => before.jobs[0]!), uniqueBefore,
    ] };
    const right = { ...after, jobs: [
      ...Array.from({ length: afterCount }, () => after.jobs[0]!), uniqueAfter,
    ] };
    const result = compareRuns(left, right);
    assert.ok(result.blockers.includes("AMBIGUOUS_JOB_NAMES"));
    assert.equal(result.observedReductionSeconds, null);
    for (const job of result.jobs.slice(0, beforeCount)) {
      assert.equal(job.afterSeconds, null);
      assert.deepEqual(job.addedSteps, []);
      for (const step of job.steps) {
        assert.equal(step.afterSeconds, null);
        assert.equal(step.observedReductionSeconds, null);
      }
    }
    const unique = result.jobs.at(-1)!;
    assert.equal(unique.afterSeconds, 40, "unambiguous diagnostics remain available");
    assert.equal(unique.steps[0]!.observedReductionSeconds, 20);
    assert.deepEqual(unique.addedSteps, [{ name: "cache", seconds: 4 }]);
    assert.match(renderRunComparison(result, "en"), /<th>check<\/th><td>60<\/td><td>unknown<\/td>/);
  }
});

test("comparison reads job identities and step names in proportion to input size", (t) => {
  const jobCount = 100, stepCount = 100;
  let labelReads = 0, stepNameReads = 0;
  const jobs = Array.from({ length: jobCount }, (_, job) => ({ name: "job-" + job,
    get labels() { labelReads += 1; return ["ubuntu-latest", "x64"]; }, seconds: 300,
    steps: Array.from({ length: stepCount }, (_, step) => ({
      get name() { stepNameReads += 1; return "step-" + step; }, seconds: 1,
    })),
  }));
  const result = compareRuns({ ...before, jobs }, { ...after, jobs: [...jobs].reverse() });
  assert.equal(result.comparable, true);
  assert.equal(result.jobs.length, jobCount);
  assert.equal(result.jobs[0]!.steps.length, stepCount);
  t.diagnostic(JSON.stringify({ labelReads, stepNameReads }));
  assert.ok(labelReads <= 2 * jobCount, "each job identity is read once per observation");
  assert.ok(stepNameReads <= 6 * jobCount * stepCount, "step matching must not rescan whole step lists");
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


test("skipped jobs with no runner or timestamps compare only to other skipped jobs", async () => {
  const mock = api();
  const runner: GhRunner = async (...args) => {
    const result = await mock.runner(...args);
    if (args[0].some((arg) => arg.includes("/jobs"))) {
      const body = JSON.parse(result.stdout.split("\r\n\r\n")[1]!);
      body.jobs.push({ id: 99, name: "deploy", status: "completed", conclusion: "skipped" });
      body.total_count++;
      return { ...result, stdout: "HTTP/2.0 200 OK\r\n\r\n" + JSON.stringify(body) };
    }
    return result;
  };
  const left = await collectRunObservation("owner/repo", 1, { runner });
  const right = await collectRunObservation("owner/repo", 2, { runner });
  assert.equal(compareRuns(left, right).observedReductionSeconds, 20);
  assert.equal(compareRuns(left, { ...right, jobs: [right.jobs[0]!, { name: "deploy", seconds: 2, labels: ["ubuntu-latest"], steps: [] }] }).comparable, false);
});

test("collector paginates over 100 jobs and rejects duplicate or unstable pages", async () => {
  for (const broken of [false, true]) {
    const mock = api();
    const runner: GhRunner = async (...args) => {
      if (!args[0].some((arg) => arg.includes("/jobs"))) return mock.runner(...args);
      const second = args[0].some((arg) => /[?&]page=2(?:&|$)/.test(arg));
      const jobs = Array.from({ length: second ? 1 : 100 }, (_, i) => ({ id: second ? (broken ? 1 : 101) : i + 1,
        name: "job-" + (second ? 101 : i + 1), labels: ["ubuntu-latest"], status: "completed", conclusion: "success",
        started_at: "2026-10-24T00:00:00Z", completed_at: "2026-10-24T00:00:01Z", steps: [] }));
      return { exitCode: 0, stderr: "", stdout: 'HTTP/2.0 200 OK\r\n' + (second ? '' : 'Link: <https://api.github.com/jobs?page=2>; rel="next"\r\n')
        + '\r\n' + JSON.stringify({ total_count: 101, jobs }) };
    };
    if (broken) await assert.rejects(collectRunObservation("owner/repo", 1, { runner }), /JOB_COLLECTION_INCOMPLETE/);
    else assert.equal((await collectRunObservation("owner/repo", 1, { runner })).jobs.length, 101);
  }
});

