import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runStaticScan } from "../../src/core/scan/scan.ts";
import { npmCacheTargets } from "../../src/core/rules/npm-cache.ts";
import { parseWorkflow } from "../../src/core/workflow/parse.ts";
import { buildRequestedPlan } from "../../src/core/patch/request-plan.ts";
import { claimsFromTokens } from "../../src/core/patch/eligibility.ts";
import { PatchStore } from "../../src/core/patch/store.ts";
import { approvePlan, approvalConfirmation } from "../../src/core/patch/approval.ts";
import { applyPlan, revertChange } from "../../src/core/patch/apply.ts";
import { applyEdits, planNpmCacheEdit } from "../../src/core/patch/edits.ts";
import { semanticProblems } from "../../src/core/patch/semantic.ts";
import { isolatedEnv } from "../helpers/test-env.ts";

const PATH = ".github/workflows/ci.yml";
const SOURCE = "name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: '22' # keep this comment\n      - run: npm ci\n      - run: npm test\n";

function fixture(t: { after(fn: () => void): void }, source = SOURCE) {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(join(root, PATH), source);
  writeFileSync(join(root, "package.json"), '{"name":"fixture","private":true}');
  writeFileSync(join(root, "package-lock.json"), '{"name":"fixture","lockfileVersion":3,"packages":{}}');
  for (const args of [["init", "--quiet"], ["add", "--", "package.json", "package-lock.json"]]) execFileSync("git", args, { cwd: root, windowsHide: true, stdio: "pipe", timeout: 5000 });
  return root;
}

function planned(root: string) {
  const now = new Date();
  const scan = runStaticScan({ workspaceRoot: root });
  const finding = scan.report.findings.find((f) => f.ruleId === "CD006");
  assert.ok(finding);
  assert.equal(finding.standaloneRunnerSeconds.status, "unknown");
  const requested = buildRequestedPlan({ binding: scan.binding, workflow: scan.workflows[0]!, text: readFileSync(join(root, PATH), "utf8"),
    rule: "CD006", allowedRules: ["CD006"], jobKey: "test", stepIndex: 1, minutes: null, finding, coverage: scan.report.coverage,
    claims: claimsFromTokens([]), history: null, evidenceRef: "test:cache", issuedBy: { channel: "human-cli", subjectId: "tester" }, now });
  assert.equal(requested.ok, true, JSON.stringify(requested));
  if (!requested.ok) throw new Error("plan failed");
  const store = PatchStore.open(join(root, ".ci-diet"));
  store.saveBinding(scan.binding);
  store.saveAttestation(requested.attestation);
  store.savePlan(requested.plan, { coverageWriteAllowed: true, reportId: scan.report.reportId });
  return { store, now, plan: requested.plan };
}

test("offline cache scan -> plan -> human approval -> apply -> revert preserves tests and source", async (t) => {
  const root = fixture(t);
  const { store, now, plan } = planned(root);
  const options = { store, now, planId: plan.planId, subjectId: "tester", allowedRules: ["CD006"] as const };
  assert.equal((await applyPlan(options)).state, "not_applied");
  approvePlan({ ...options, channel: "human-cli", confirmation: approvalConfirmation(plan) });
  const applied = await applyPlan(options);
  assert.equal(applied.state, "applied", JSON.stringify(applied));
  const result = readFileSync(join(root, PATH), "utf8");
  assert.match(result, /cache: npm/);
  assert.match(result, /cache-dependency-path: package-lock.json/);
  assert.match(result, /node-version: '22' # keep this comment/);
  assert.match(result, /run: npm ci\n      - run: npm test/);
  assert.equal(runStaticScan({ workspaceRoot: root }).report.findings.filter((f) => f.ruleId === "CD006").length, 0);
  const reverted = await revertChange({ store, changeId: applied.change!.changeId, now });
  assert.equal(reverted.state, "REVERTED");
  assert.equal(readFileSync(join(root, PATH), "utf8"), SOURCE);
});

test("a lockfile changed after approval invalidates the cache plan", async (t) => {
  const root = fixture(t);
  const { store, now, plan } = planned(root);
  approvePlan({ store, now, planId: plan.planId, subjectId: "tester", channel: "human-cli", confirmation: approvalConfirmation(plan) });
  writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3,"packages":{"new":{}}}');
  const result = await applyPlan({ store, now, planId: plan.planId, subjectId: "tester" });
  assert.equal(result.state, "not_applied");
  assert.ok(result.reasons.includes("DEPENDENCY_HASH_MISMATCH"), JSON.stringify(result));
  assert.equal(readFileSync(join(root, PATH), "utf8"), SOURCE);
});

test("cache candidates skip existing caches, unsupported versions, conditions and alternate roots", () => {
  for (const source of [
    SOURCE.replace("node-version:", "cache: npm\n          node-version:"),
    SOURCE.replace("node-version:", "package-manager-cache: false\n          node-version:"),
    SOURCE.replace("setup-node@v4", "setup-node@v6"),
    SOURCE.replace("- run: npm ci", "- run: npm ci\n        working-directory: app"),
    SOURCE.replace("node-version:", "cache-dependency-path: app/package-lock.json\n          node-version:"),
    SOURCE.replace("- run: npm ci", "- run: npm ci\n        if: success()"),
    SOURCE.replace("checkout@v4", "checkout@v4\n        with:\n          repository: other/repo"),
    SOURCE.replace("- run: npm test", "- uses: actions/cache@v4"),
    SOURCE.replace("    runs-on:", "    defaults:\n      run:\n        working-directory: '${{ matrix.dir }}'\n    runs-on:"),
  ]) assert.equal(npmCacheTargets(parseWorkflow(PATH, source)).length, 0, source);
});

test("no cache finding without a tracked root lockfile", (t) => {
  const root = fixture(t);
  execFileSync("git", ["rm", "--cached", "--", "package-lock.json"], { cwd: root, windowsHide: true, stdio: "pipe", timeout: 5000 });
  assert.equal(runStaticScan({ workspaceRoot: root }).report.findings.filter((f) => f.ruleId === "CD006").length, 0);
});

test("does not key package-lock when npm ci actually uses shrinkwrap", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "npm-shrinkwrap.json"), '{"lockfileVersion":3}');
  assert.equal(runStaticScan({ workspaceRoot: root }).report.findings.filter((f) => f.ruleId === "CD006").length, 0);
});

test("cache insertion preserves CRLF and rejects changes outside its two inputs", () => {
  for (const source of [SOURCE, SOURCE.replace("        with:\n          node-version: '22' # keep this comment\n", "")].map((s) => s.replaceAll("\n", "\r\n"))) {
    const workflow = parseWorkflow(PATH, source);
    const edit = planNpmCacheEdit(source, workflow.jobs[0]!, workflow.jobs[0]!.steps[1]!).edit!;
    const result = applyEdits(source, [edit]).text;
    assert.doesNotMatch(result, /(?<!\r)\n|\r\r/);
    assert.deepEqual(semanticProblems({ original: workflow, originalText: source, resultText: result, edits: [edit] }), []);
    assert.ok(semanticProblems({ original: workflow, originalText: source, resultText: result.replace("npm test", "echo skipped"), edits: [edit] }).length > 0);
  }
});

test("CLI creates an offline CD006 plan in a fresh state directory", (t) => {
  const root = fixture(t);
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "../../src/cli/index.ts"), "plan", "--cwd", root,
    "--state-dir", join(root, "state"), "--rule", "CD006", "--workflow", PATH, "--job", "test", "--step", "1", "--json"],
  { env: isolatedEnv(), encoding: "utf8", timeout: 15000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout).payload.ruleIds[0], "CD006");
  assert.equal(readFileSync(join(root, PATH), "utf8"), SOURCE);
});
