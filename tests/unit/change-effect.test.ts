import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectChangeEffect } from "../../src/adapters/github/change-effect.ts";
import type { GhRunner } from "../../src/adapters/github/transport.ts";
import type { AppliedChange } from "../../src/core/contracts/schema.ts";
import { sourceHashOf } from "../../src/core/patch/plan.ts";
import { measureChangeEffect } from "../../src/core/analysis/change-effect.ts";
import { compareRuns } from "../../src/core/analysis/run-comparison.ts";
import { savedMeasurementOf } from "../../src/core/analysis/saved-measurement.ts";
import { PatchStore } from "../../src/core/patch/store.ts";
import { createLocalBinding } from "../../src/core/scan/binding.ts";
import { measureCommand } from "../../src/cli/measure.ts";
import { systemClock } from "../../src/core/support/clock.ts";

const workflow = ".github/workflows/ci.yml", beforeText = "name: Before\n", afterText = "name: After\n";
const change: AppliedChange = { schemaVersion: 2, provenance: "observed", changeId: "change_measure", bindingId: "binding_measure",
  planId: "plan_measure", planDigest: "sha256:" + "a".repeat(64), workflowPath: workflow, state: "APPLIED",
  before: { path: workflow, hash: sourceHashOf(beforeText), bytes: Buffer.byteLength(beforeText) },
  after: { path: workflow, hash: sourceHashOf(afterText), bytes: Buffer.byteLength(afterText) },
  approvalChannel: "human-cli", approvalReference: "nonce_measure", updatedAt: "2026-10-25T00:00:00Z" };

function api(options: { wrongHash?: boolean; wrongScope?: boolean; changedAttempt?: boolean; pull?: boolean; noSuccess?: boolean; slower?: boolean; beforeRunIds?: readonly number[] } = {}) {
  const calls: string[][] = [], seen = new Map<number, number>();
  const runner: GhRunner = async (args) => {
    calls.push([...args]);
    const path = args.find((arg) => arg.startsWith("/repos/"))!;
    const id = Number(/\/runs\/(\d+)/.exec(path)?.[1]);
    const isBefore = options.beforeRunIds?.includes(id) ?? id === 1;
    const conclusion = options.noSuccess || id === 3 ? "failure" : "success";
    const count = seen.get(id) ?? 0;
    if (!path.includes("/jobs")) seen.set(id, count + 1);
    let body: unknown;
    if (path.includes("/contents/")) {
      const before = args.includes("ref=" + "a".repeat(40)) || args.some((arg) => arg.includes("ref=" + "a".repeat(40)));
      body = { type: "file", encoding: "base64", content: Buffer.from(before ? beforeText : options.wrongHash ? "tampered" : afterText).toString("base64") };
    } else if (path.includes("/jobs")) {
      const end = isBefore ? "00:01:00" : options.slower ? "00:01:30" : "00:00:50";
      body = { total_count: 1, jobs: [{ id: id * 10, name: "check", labels: ["ubuntu-latest"], status: "completed", conclusion: "success",
        started_at: "2026-10-25T00:00:00Z", completed_at: "2026-10-25T" + end + "Z", steps: [
          { name: "test", status: "completed", conclusion: "success", started_at: "2026-10-25T00:00:00Z", completed_at: "2026-10-25T00:00:20Z" },
          { name: "Post cache save", status: "completed", conclusion: "success", started_at: "2026-10-25T00:00:20Z", completed_at: "2026-10-25T00:00:30Z" },
        ] }] };
    } else {
      body = { id, repository: { full_name: "owner/repo" }, path: workflow, status: "completed", conclusion,
        run_attempt: options.changedAttempt && count > 0 ? 3 : id === 3 ? 2 : 1,
        head_sha: (isBefore ? "a" : "b").repeat(40), head_branch: options.wrongScope && id === 3 ? "other" : "main",
        event: options.pull ? "pull_request" : "push" };
    }
    return { exitCode: 0, stdout: "HTTP/2.0 200 OK\r\n\r\n" + JSON.stringify(body), stderr: "" };
  };
  return { runner, calls };
}

test("20-run measurement shares metadata checks instead of collecting each successful run twice", async (t) => {
  const before = [1, ...Array.from({ length: 9 }, (_, i) => i + 4)];
  const after = Array.from({ length: 10 }, (_, i) => i + 13);
  const mock = api({ beforeRunIds: before });
  const report = await collectChangeEffect("owner/repo", change, before, after, { runner: mock.runner });
  const paths = mock.calls.map((args) => args.find((arg) => arg.startsWith("/repos/"))!);
  const metadata = paths.filter((path) => /\/actions\/runs\/\d+$/.test(path)).length;
  const jobs = paths.filter((path) => path.includes("/jobs")).length;
  const definitions = paths.filter((path) => path.includes("/contents/")).length;
  t.diagnostic(JSON.stringify({ metadata, jobs, definitions, total: paths.length }));
  assert.equal(report.observedReductionSeconds, 10);
  assert.equal(report.comparisons.length, 100);
  assert.equal(metadata, 40, "one metadata read before and one after each selected run");
  assert.equal(jobs, 20);
  assert.equal(definitions, 2);
  assert.equal(paths.length, 62);
});

test("applied-change measurement links exact file hashes and includes full runner overhead and reliability", async () => {
  const mock = api();
  const report = await collectChangeEffect("owner/repo", change, [1], [2, 3], { runner: mock.runner });
  assert.equal(report.planDigest, change.planDigest);
  assert.equal(report.observedReductionSeconds, 10, "60 - 50 including cache post steps, not just test step time");
  assert.equal(report.after.successRate, 0.5);
  assert.equal(report.after.failures, 1);
  assert.equal(report.after.rerunAttempts, 1);
  assert.equal(report.after.rerunRate, 0.5);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.before.runs[0]!.observation!.jobs[0]!.steps[1]!.name, "Post cache save");
  assert.equal(report.comparisons[0]!.beforeRunId, 1);
  assert.equal(report.comparisons[0]!.afterRunId, 2);
  assert.equal(report.verifiedCausalSavings, false);
  assert.equal(report.actualBilledUsd, null);
  assert.equal(mock.calls.filter((call) => call.some((arg) => arg.includes("/contents/"))).length, 2, "one file fetch per unique SHA");
  assert.ok(mock.calls.every((call) => call.includes("GET")));
  const slow = await collectChangeEffect("owner/repo", change, [1], [2], { runner: api({ slower: true }).runner });
  assert.equal(slow.observedReductionSeconds, -30);
  const duplicate = measureChangeEffect(change, report.before.runs, report.before.runs);
  assert.equal(duplicate.observedReductionSeconds, null);
  assert.ok(duplicate.blockers.includes("DUPLICATE_RUN"));
});

test("shared collection still checks metadata after jobs and rejects every identity or scope change", async () => {
  const changes = [{ run_attempt: 2 }, { head_sha: "c".repeat(40) }, { status: "in_progress" }, { conclusion: "failure" },
    { event: "workflow_dispatch" }, { head_branch: "other" }, { pull_requests: [] }, { id: 999 },
    { path: ".github/workflows/other.yml" }, { repository: { full_name: "other/repo" } }];
  for (const update of changes) {
    const mock = api();
    let jobsRead = false;
    const runner: GhRunner = async (...args) => {
      const response = await mock.runner(...args);
      const path = args[0].find((arg) => arg.startsWith("/repos/"))!;
      if (path.includes("/jobs")) jobsRead = true;
      if (jobsRead && path.endsWith("/actions/runs/1")) {
        const body = JSON.parse(response.stdout.split("\r\n\r\n")[1]!);
        return { ...response, stdout: "HTTP/2.0 200 OK\r\n\r\n" + JSON.stringify({ ...body, ...update }) };
      }
      return response;
    };
    await assert.rejects(collectChangeEffect("owner/repo", change, [1], [2], { runner }), /RUN_CHANGED_DURING_COLLECTION/);
    assert.equal(jobsRead, true);
    assert.ok(!mock.calls.some((args) => args.some((arg) => arg.endsWith("/actions/runs/2"))));
  }
});

test("shared measurement transport collects every job page before its final metadata check", async () => {
  const mock = api();
  const runner: GhRunner = async (...args) => {
    const response = await mock.runner(...args);
    const path = args[0].find((arg) => arg.startsWith("/repos/"))!;
    if (!path.includes("/jobs")) return response;
    const second = /[?&]page=2(?:&|$)/.test(path);
    const body = JSON.parse(response.stdout.split("\r\n\r\n")[1]!);
    body.total_count = 2;
    body.jobs[0].id += second ? 1 : 0;
    body.jobs[0].name = second ? "build" : "check";
    return { ...response, stdout: "HTTP/2.0 200 OK\r\n" + (second ? "" : 'Link: <https://api.github.com/jobs?page=2>; rel="next"\r\n')
      + "\r\n" + JSON.stringify(body) };
  };
  const effect = await collectChangeEffect("owner/repo", change, [1], [2], { runner });
  assert.equal(effect.before.runs[0]!.observation!.jobs.length, 2);
  assert.equal(effect.observedReductionSeconds, 20);
  const paths = mock.calls.map((args) => args.find((arg) => arg.startsWith("/repos/"))!);
  assert.equal(paths.filter((path) => path.includes("/jobs")).length, 4);
  assert.equal(paths.filter((path) => /\/actions\/runs\/\d+$/.test(path)).length, 4);
});

test("measurement rejects unrelated workflow versions, branch/event mixing and changing attempts", async () => {
  for (const options of [{ wrongHash: true }, { wrongScope: true }, { changedAttempt: true }, { pull: true }]) {
    await assert.rejects(collectChangeEffect("owner/repo", change, [1], [2, 3], { runner: api(options).runner }));
  }
  const empty = await collectChangeEffect("owner/repo", change, [1], [2], { runner: api({ noSuccess: true }).runner });
  assert.equal(empty.comparable, false);
  assert.equal(empty.observedReductionSeconds, null);
  assert.equal(empty.after.successRate, 0);
  const mock = api();
  await assert.rejects(collectChangeEffect("owner/repo", { ...change, state: "REVERTED" }, [1], [2], { runner: mock.runner }), /CHANGE_NOT_APPLIED/);
  await assert.rejects(collectChangeEffect("owner/repo", change, [1], [1], { runner: mock.runner }), /INVALID_RUN_SELECTION/);
  assert.equal(mock.calls.length, 0);
});

test("10 by 10 measurement keeps each run's steps once without building pairwise step diffs", () => {
  let stepReads = 0, labelReads = 0;
  const steps = Array.from({ length: 6 }, (_, i) => ({ name: "measured_step_" + i, seconds: 2 }));
  const sample = (id: number, before: boolean) => ({ id, attempt: 1, conclusion: "success",
    workflowHash: before ? change.before.hash : change.after.hash,
    observation: { id, attempt: 1, repository: "owner/repo", workflow, branch: "main", event: "push", sha: String(id),
      jobs: Array.from({ length: 20 }, (_, i) => ({ name: "job_" + i,
        get labels() { labelReads++; return ["ubuntu-latest"]; }, seconds: before ? 60 : 50,
        get steps() { stepReads++; return steps; } })) } });
  const before = Array.from({ length: 10 }, (_, i) => sample(i + 1, true));
  const after = Array.from({ length: 10 }, (_, i) => sample(i + 101, false));
  const effect = measureChangeEffect(change, before, after);
  assert.equal(effect.comparisons.length, 100);
  assert.equal(effect.observedReductionSeconds, 200);
  assert.ok(effect.comparisons.every((pair) => pair.comparable && pair.observedReductionSeconds === 200));
  assert.equal(labelReads, 20 * 20, "index each job once per run, not once per pair");
  assert.equal(stepReads, 0, "batch calculation must not construct per-pair step diffs");
  const json = JSON.stringify(effect);
  assert.equal(stepReads, 20 * 20, "serialization reads each job's steps once across 20 runs");
  assert.equal(json.match(/"name":"measured_step_0"/g)?.length, 20 * 20);
  const mismatched = after.map((run, index) => index === 9 ? { ...run, observation: { ...run.observation, branch: "other" } } : run);
  const blocked = measureChangeEffect(change, before, mismatched);
  assert.equal(blocked.comparable, false);
  assert.equal(blocked.observedReductionSeconds, null);
  assert.ok(blocked.blockers.includes("DIFFERENT_BRANCH"), "check all pairs, including the final sample");
  before[0]!.observation.jobs[0]!.seconds = 80;
  assert.equal(measureChangeEffect(change, before, after).comparisons[0]!.observedReductionSeconds, 220,
    "a new measurement must recompute totals even for reused observation objects");
  before[0]!.observation.jobs[0]!.name = "changed";
  assert.ok(measureChangeEffect(change, before, after).blockers.includes("DIFFERENT_JOBS_OR_RUNNERS"),
    "a new measurement must also recompute job identities");
});

test("legacy measurement caches normalize from samples without mutating cached data", async () => {
  const effect = await collectChangeEffect("owner/repo", change, [1], [2], { runner: api().runner });
  const legacy = { ...effect, schemaVersion: 1, comparisons: [
    compareRuns(effect.before.runs[0]!.observation!, effect.after.runs[0]!.observation!),
  ] };
  const saved = { measuredAt: change.updatedAt, bindingId: change.bindingId, effect: legacy };
  const originalJson = JSON.stringify(saved);
  assert.deepEqual(savedMeasurementOf(change, saved)?.effect, effect);
  assert.equal(JSON.stringify(saved), originalJson);
  assert.equal(savedMeasurementOf(change, { ...saved, effect: { ...legacy, observedReductionSeconds: 999 } }), null);
  const current = { ...saved, effect };
  assert.deepEqual(savedMeasurementOf(change, current)?.effect, effect);
  assert.equal(savedMeasurementOf(change, { ...current, effect: { ...effect, comparisons: [] } }), null);
  assert.equal(savedMeasurementOf(change, { ...current, effect: { ...effect, schemaVersion: 3 } }), null);
});

test("measure CLI enforces network opt-in and workspace binding and preserves output files", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-effect-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state"), store = PatchStore.open(state);
  const binding = createLocalBinding(root, change.updatedAt, { repositoryFullName: "owner/repo" }).binding;
  store.saveBinding(binding);
  store.saveChange({ ...change, bindingId: binding.bindingId });
  let stdout = "", stderr = "";
  const context = { cwd: root, stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } }, env: {}, clock: systemClock };
  const args = ["--change", change.changeId, "--state-dir", state, "--before-runs", "1", "--after-runs", "2,3"];
  const mock = api();
  assert.equal(await measureCommand(args, context, mock.runner), 1);
  assert.match(stderr, /NETWORK_OPT_IN_REQUIRED/);
  assert.equal(mock.calls.length, 0);
  assert.equal(await measureCommand([...args, "--network"], context, mock.runner), 0, stderr);
  assert.equal(JSON.parse(stdout).changeId, change.changeId);
  assert.equal(store.readMeasurement(change.changeId)?.effect.observedReductionSeconds, 10);
  assert.equal(await measureCommand([...args, "--network", "--out", "effect.json"], context, mock.runner), 0, stderr);
  const saved = readFileSync(join(root, "effect.json"), "utf8");
  assert.equal(await measureCommand([...args, "--network", "--out", "effect.json"], context, mock.runner), 1);
  assert.equal(readFileSync(join(root, "effect.json"), "utf8"), saved);
  const callCount = mock.calls.length;
  assert.equal(await measureCommand([...args, "--network", "--cwd", state], context, mock.runner), 1);
  assert.match(stderr, /BINDING_MISMATCH/);
  assert.equal(mock.calls.length, callCount);
  stdout = "";
  assert.equal(await measureCommand([...args, "--network"], context, api({ noSuccess: true }).runner), 3);
  assert.equal(JSON.parse(stdout).observedReductionSeconds, null);
});

test("PR measurement requires immutable merge parents, never a moving merge ref", async () => {
  const mock = api({ pull: true });
  const run = async (mode: "merge" | "same-file" | "head-only" | "bad-parents") => {
    const runner: GhRunner = async (args, options) => {
      const path = args.find((a) => a.startsWith("/repos/"))!;
      if (path.includes("/git/commits/")) {
        const sha = path.endsWith("c".repeat(40)) ? "c".repeat(40) : "d".repeat(40);
        const head = sha.startsWith("c") ? "a".repeat(40) : "b".repeat(40);
        return { exitCode: 0, stderr: "", stdout: "HTTP/2.0 200 OK\r\n\r\n" + JSON.stringify({ sha,
          parents: [{ sha: mode === "bad-parents" ? "f".repeat(40) : "e".repeat(40) }, { sha: head }] }) };
      }
      const response = await mock.runner(args, options);
      const split = response.stdout.indexOf("\r\n\r\n");
      const body = JSON.parse(response.stdout.slice(split + 4));
      if (/\/runs\/[0-9]+$/.test(path)) {
        const head = body.head_sha;
        body.repository.id = 10;
        body.pull_requests = [{ number: 42, head: { sha: head, repo: { id: 10 } },
          base: { sha: mode === "same-file" && head.startsWith("b") ? "f".repeat(40) : "e".repeat(40), repo: { id: 10 } } }];
        if (mode === "merge" || mode === "bad-parents") body.head_sha = (head.startsWith("a") ? "c" : "d").repeat(40);
      }
      if (path.includes("/contents/") && args.some((a) => a.includes("ref=" + "c".repeat(40)) || (mode === "same-file" && a.includes("ref=" + "e".repeat(40))))) body.content = Buffer.from(beforeText).toString("base64");
      return { ...response, stdout: response.stdout.slice(0, split + 4) + JSON.stringify(body) };
    };
    return collectChangeEffect("owner/repo", change, [1], [2], { runner });
  };
  assert.equal((await run("merge")).observedReductionSeconds, 10);
  assert.equal((await run("same-file")).observedReductionSeconds, 10);
  await assert.rejects(run("head-only"), /PR_MERGE_DEFINITION_UNVERIFIABLE/);
  await assert.rejects(run("bad-parents"), /PR_MERGE_DEFINITION_UNVERIFIABLE/);
  assert.ok(mock.calls.every((args) => !args.some((a) => a.includes("refs/pull"))));
});
