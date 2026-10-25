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

function api(options: { wrongHash?: boolean; wrongScope?: boolean; changedAttempt?: boolean; pull?: boolean; noSuccess?: boolean; slower?: boolean } = {}) {
  const calls: string[][] = [], seen = new Map<number, number>();
  const runner: GhRunner = async (args) => {
    calls.push([...args]);
    const path = args.find((arg) => arg.startsWith("/repos/"))!;
    const id = Number(/\/runs\/(\d+)/.exec(path)?.[1]);
    const conclusion = options.noSuccess || id === 3 ? "failure" : "success";
    const count = seen.get(id) ?? 0;
    if (!path.includes("/jobs")) seen.set(id, count + 1);
    let body: unknown;
    if (path.includes("/contents/")) {
      const before = args.includes("ref=" + "a".repeat(40)) || args.some((arg) => arg.includes("ref=" + "a".repeat(40)));
      body = { type: "file", encoding: "base64", content: Buffer.from(before ? beforeText : options.wrongHash ? "tampered" : afterText).toString("base64") };
    } else if (path.includes("/jobs")) {
      const end = id === 1 ? "00:01:00" : options.slower ? "00:01:30" : "00:00:50";
      body = { total_count: 1, jobs: [{ id: id * 10, name: "check", labels: ["ubuntu-latest"], status: "completed", conclusion: "success",
        started_at: "2026-10-25T00:00:00Z", completed_at: "2026-10-25T" + end + "Z", steps: [
          { name: "test", status: "completed", conclusion: "success", started_at: "2026-10-25T00:00:00Z", completed_at: "2026-10-25T00:00:20Z" },
          { name: "Post cache save", status: "completed", conclusion: "success", started_at: "2026-10-25T00:00:20Z", completed_at: "2026-10-25T00:00:30Z" },
        ] }] };
    } else {
      body = { id, repository: { full_name: "owner/repo" }, path: workflow, status: "completed", conclusion,
        run_attempt: options.changedAttempt && count > 0 ? 3 : id === 3 ? 2 : 1,
        head_sha: (id === 1 ? "a" : "b").repeat(40), head_branch: options.wrongScope && id === 3 ? "other" : "main",
        event: options.pull ? "pull_request" : "push" };
    }
    return { exitCode: 0, stdout: "HTTP/2.0 200 OK\r\n\r\n" + JSON.stringify(body), stderr: "" };
  };
  return { runner, calls };
}

test("applied-change measurement links exact file hashes and includes full runner overhead and reliability", async () => {
  const mock = api();
  const report = await collectChangeEffect("owner/repo", change, [1], [2, 3], { runner: mock.runner });
  assert.equal(report.planDigest, change.planDigest);
  assert.equal(report.observedReductionSeconds, 10, "60 - 50 including cache post steps, not just test step time");
  assert.equal(report.after.successRate, 0.5);
  assert.equal(report.after.failures, 1);
  assert.equal(report.after.rerunAttempts, 1);
  assert.equal(report.after.rerunRate, 0.5);
  assert.equal(report.comparisons[0]!.jobs[0]!.steps[1]!.name, "Post cache save");
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
