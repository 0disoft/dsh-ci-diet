import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkflow } from "../../src/core/workflow/parse.ts";
import { createLocalBinding } from "../../src/core/scan/binding.ts";
import { PatchStore } from "../../src/core/patch/store.ts";
import {
  buildPatchPlan,
  buildPolicySnapshots,
  dependencyHashOf,
} from "../../src/core/patch/plan.ts";
import { planTimeoutEdit } from "../../src/core/patch/edits.ts";
import { createAttestation } from "../../src/core/patch/attestation.ts";
import { approvePlan, approvalConfirmation } from "../../src/core/patch/approval.ts";
import { applyPlan } from "../../src/core/patch/apply.ts";
import { collectDependencies } from "../../src/core/patch/dependencies.ts";

const WORKFLOW = [
  "on: pull_request",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    defaults:",
  "      run:",
  "        working-directory: scripts",
  "    steps:",
  "      - uses: ./.github/actions/setup",
  "      - run: bash check.sh && node build.js",
  "      - run: |",
  "          echo one; echo two",
  "          missing-script.sh",
].join("\n");

function workspace(): { root: string; path: string; text: string } {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-deps-"));
  const dir = join(root, ".github", "workflows");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, ".github", "actions", "setup"), { recursive: true });
  writeFileSync(join(dir, "ci.yml"), WORKFLOW, "utf8");
  writeFileSync(join(root, "scripts", "check.sh"), "#!/bin/sh\necho check\n", "utf8");
  writeFileSync(join(root, "scripts", "build.js"), "console.log('build')\n", "utf8");
  mkdirSync(join(root, ".github", "actions", "setup", "dist"), { recursive: true });
  writeFileSync(join(root, ".github", "actions", "setup", "action.yml"), "name: setup\n", "utf8");
  writeFileSync(
    join(root, ".github", "actions", "setup", "dist", "index.js"),
    "export {}\n",
    "utf8",
  );
  return { root, path: ".github/workflows/ci.yml", text: WORKFLOW };
}

test("collects local scripts, interpreter arguments, and composite action files", () => {
  const space = workspace();
  const workflow = parseWorkflow(space.path, space.text);
  const collection = collectDependencies(space.root, workflow);
  assert.deepEqual(collection.unresolved, []);
  assert.deepEqual(
    collection.dependencies.map((entry) => entry.ref),
    [
      ".github/actions/setup/action.yml",
      ".github/actions/setup/dist/index.js",
      "scripts/build.js",
      "scripts/check.sh",
    ],
  );
  for (const ref of collection.dependencies) assert.match(ref.sha256, /^sha256:[0-9a-f]{64}$/);
});

test("resolves scripts against the step working directory and reports unresolved ones", () => {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-deps-"));
  const dir = join(root, ".github", "workflows");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "build.js"), "console.log('scripts')\n", "utf8");
  writeFileSync(join(root, "build.js"), "console.log('root')\n", "utf8");
  const text = [
    "on: push",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: node build.js",
    "        working-directory: scripts",
    "      - run: node build.js",
    "        working-directory: .",
    "      - run: node absent.js",
    "        working-directory: scripts",
    "      - run: ./missing.sh",
  ].join("\n");
  writeFileSync(join(dir, "ci.yml"), text, "utf8");
  const workflow = parseWorkflow(".github/workflows/ci.yml", text);
  const collection = collectDependencies(root, workflow);
  assert.deepEqual(
    collection.dependencies.map((entry) => entry.ref),
    ["build.js", "scripts/build.js"],
  );
  assert.deepEqual(collection.unresolved, ["missing.sh", "scripts/absent.js"]);
});

test("apply refuses when a referenced script changed after the plan", async () => {
  const space = workspace();
  const now = new Date("2026-10-20T00:00:00Z");
  const binding = createLocalBinding(space.root, now.toISOString(), {
    repositoryFullName: "owner/repo",
  }).binding;
  const workflow = parseWorkflow(space.path, space.text);
  const deps = collectDependencies(space.root, workflow).dependencies;
  const edit = planTimeoutEdit(space.text, workflow, workflow.jobs[0] as never, 15);
  if (edit.edit == null) throw new Error("fixture edit failed");
  const attestation = createAttestation({
    bindingId: binding.bindingId,
    workflowPath: space.path,
    workflowHash: workflow.sha256,
    dependencyHash: dependencyHashOf(deps),
    scope: "job",
    jobKey: "build",
    stepKey: null,
    claims: {
      ciOnly: true,
      replaceSafe: true,
      artifactPurpose: "unknown",
      consumerMinDays: null,
      reviewedOpaqueNodes: [],
    },
    evidenceRefs: ["test:deps"],
    issuedBy: { channel: "human-cli", subjectId: "tester" },
    now,
  });
  const store = PatchStore.open(join(space.root, ".ci-diet"));
  store.saveBinding(binding);
  store.saveAttestation(attestation);
  const fetchedAt = now.toISOString();
  const policies = buildPolicySnapshots({
    binding,
    protection: { defaultBranch: "main", ruleCount: 0, classicProtection: true, fetchedAt },
    retention: { days: 90, maximumAllowedDays: 90, fetchedAt },
    now,
  });
  const built = buildPatchPlan({
    binding,
    workflow,
    text: space.text,
    edits: [edit.edit],
    attestations: [attestation],
    policies,
    blockers: [],
    coverageWriteAllowed: true,
    dependencies: deps,
    now,
  });
  store.savePlan(built.plan, { coverageWriteAllowed: true, reportId: null });
  approvePlan({
    store,
    planId: built.plan.planId,
    confirmation: approvalConfirmation(built.plan),
    subjectId: "tester",
    channel: "human-cli",
    now,
  });
  writeFileSync(join(space.root, "scripts", "build.js"), "console.log('changed')\n", "utf8");
  const result = await applyPlan({ store, planId: built.plan.planId, now, subjectId: "tester" });
  assert.equal(result.state, "not_applied");
  assert.ok(result.reasons.includes("DEPENDENCY_HASH_MISMATCH"), result.reasons.join(","));
});

test("reports dynamic working directories and dynamic run scripts instead of skipping them", () => {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-deps-"));
  const dir = join(root, ".github", "workflows");
  mkdirSync(dir, { recursive: true });
  const text = [
    "on: push",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: node build.js",
    "        working-directory: ${{ matrix.dir }}",
    "      - run: ${{ matrix.script }}",
  ].join("\n");
  writeFileSync(join(dir, "ci.yml"), text, "utf8");
  const workflow = parseWorkflow(".github/workflows/ci.yml", text);
  const collection = collectDependencies(root, workflow);
  assert.deepEqual(collection.dependencies, []);
  assert.deepEqual(collection.unresolved, [
    "jobs.build.steps[0] (dynamic working-directory)",
    "jobs.build.steps[1] (dynamic run script)",
  ]);
});

test("treats boolean node flags as flags and follows value-taking ones", () => {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-deps-"));
  const dir = join(root, ".github", "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, "build.js"), "console.log('build')\n", "utf8");
  writeFileSync(join(root, "setup.cjs"), "module.exports = {}\n", "utf8");
  const text = [
    "on: push",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: node --enable-source-maps build.js",
    "      - run: node --require ./setup.cjs build.js",
  ].join("\n");
  writeFileSync(join(dir, "ci.yml"), text, "utf8");
  const workflow = parseWorkflow(".github/workflows/ci.yml", text);
  const collection = collectDependencies(root, workflow);
  assert.deepEqual(collection.dependencies.map((entry) => entry.ref), [
    "build.js",
    "setup.cjs",
  ]);
  assert.deepEqual(collection.unresolved, []);
});

test("marks a local action as unresolved when the file limit hides files", () => {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-deps-"));
  const dir = join(root, ".github", "workflows");
  mkdirSync(dir, { recursive: true });
  const action = join(root, ".github", "actions", "big");
  mkdirSync(action, { recursive: true });
  writeFileSync(join(action, "action.yml"), "runs:\n  using: node20\n  main: zzz.js\n", "utf8");
  for (let index = 0; index < 505; index += 1) {
    writeFileSync(join(action, "f" + String(index).padStart(3, "0") + ".js"), "export {}\n", "utf8");
  }
  writeFileSync(join(action, "zzz.js"), "console.log('main')\n", "utf8");
  const text = [
    "on: push",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: ./.github/actions/big",
  ].join("\n");
  writeFileSync(join(dir, "ci.yml"), text, "utf8");
  const workflow = parseWorkflow(".github/workflows/ci.yml", text);
  const collection = collectDependencies(root, workflow);
  assert.ok(
    collection.unresolved.some((entry) => entry.includes("(file limit reached)")),
    collection.unresolved.join(","),
  );
  assert.ok(
    collection.dependencies.length < 507,
    "expected the limit to stop collection before every file",
  );
});

test("apply refuses a changed script even when the command starts with a boolean node flag", async () => {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-deps-"));
  const dir = join(root, ".github", "workflows");
  mkdirSync(dir, { recursive: true });
  const text = [
    "on: push",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: node --enable-source-maps build.js",
  ].join("\n");
  writeFileSync(join(dir, "ci.yml"), text, "utf8");
  writeFileSync(join(root, "build.js"), "console.log('build')\n", "utf8");
  const now = new Date("2026-10-21T00:00:00Z");
  const binding = createLocalBinding(root, now.toISOString(), { repositoryFullName: "owner/repo" }).binding;
  const workflow = parseWorkflow(".github/workflows/ci.yml", text);
  const deps = collectDependencies(root, workflow).dependencies;
  assert.deepEqual(deps.map((entry) => entry.ref), ["build.js"]);
  const edit = planTimeoutEdit(text, workflow, workflow.jobs[0] as never, 15);
  if (edit.edit == null) throw new Error("fixture edit failed");
  const attestation = createAttestation({
    bindingId: binding.bindingId,
    workflowPath: ".github/workflows/ci.yml",
    workflowHash: workflow.sha256,
    dependencyHash: dependencyHashOf(deps),
    scope: "job",
    jobKey: "build",
    stepKey: null,
    claims: { ciOnly: true, replaceSafe: true, artifactPurpose: "unknown", consumerMinDays: null, reviewedOpaqueNodes: [] },
    evidenceRefs: ["test:deps-flags"],
    issuedBy: { channel: "human-cli", subjectId: "tester" },
    now,
  });
  const store = PatchStore.open(join(root, ".ci-diet"));
  store.saveBinding(binding);
  store.saveAttestation(attestation);
  const fetchedAt = now.toISOString();
  const policies = buildPolicySnapshots({
    binding,
    protection: { defaultBranch: "main", ruleCount: 0, classicProtection: true, fetchedAt },
    retention: { days: 90, maximumAllowedDays: 90, fetchedAt },
    now,
  });
  const built = buildPatchPlan({
    binding,
    workflow,
    text,
    edits: [edit.edit],
    attestations: [attestation],
    policies,
    blockers: [],
    coverageWriteAllowed: true,
    dependencies: deps,
    now,
  });
  store.savePlan(built.plan, { coverageWriteAllowed: true, reportId: null });
  approvePlan({
    store,
    planId: built.plan.planId,
    confirmation: approvalConfirmation(built.plan),
    subjectId: "tester",
    channel: "human-cli",
    now,
  });
  writeFileSync(join(root, "build.js"), "console.log('changed')\n", "utf8");
  const result = await applyPlan({ store, planId: built.plan.planId, now, subjectId: "tester" });
  assert.equal(result.state, "not_applied");
  assert.ok(result.reasons.includes("DEPENDENCY_HASH_MISMATCH"), result.reasons.join(","));
});
