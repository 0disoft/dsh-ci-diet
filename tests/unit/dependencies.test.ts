import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkflow } from "../../src/core/workflow/parse.ts";
import { createLocalBinding } from "../../src/core/scan/binding.ts";
import { PatchStore } from "../../src/core/patch/store.ts";
import { buildPatchPlan, buildPolicySnapshots, dependencyHashOf } from "../../src/core/patch/plan.ts";
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
  "    steps:",
  "      - uses: ./.github/actions/setup",
  "      - run: bash scripts/check.sh && npm test",
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
  writeFileSync(join(root, ".github", "actions", "setup", "action.yml"), "name: setup\n", "utf8");
  return { root, path: ".github/workflows/ci.yml", text: WORKFLOW };
}

test("collects local scripts and composite actions referenced by the workflow", () => {
  const space = workspace();
  const workflow = parseWorkflow(space.path, space.text);
  const refs = collectDependencies(space.root, workflow);
  assert.deepEqual(refs.map((entry) => entry.ref), [".github/actions/setup/action.yml", "scripts/check.sh"]);
  for (const ref of refs) assert.match(ref.sha256, /^sha256:[0-9a-f]{64}$/);
});

test("apply refuses when a referenced script changed after the plan", async () => {
  const space = workspace();
  const now = new Date("2026-10-20T00:00:00Z");
  const binding = createLocalBinding(space.root, now.toISOString(), { repositoryFullName: "owner/repo" }).binding;
  const workflow = parseWorkflow(space.path, space.text);
  const deps = collectDependencies(space.root, workflow);
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
    claims: { ciOnly: true, replaceSafe: true, artifactPurpose: "unknown", consumerMinDays: null, reviewedOpaqueNodes: [] },
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
  writeFileSync(join(space.root, "scripts", "check.sh"), "#!/bin/sh\necho changed\n", "utf8");
  const result = await applyPlan({ store, planId: built.plan.planId, now, subjectId: "tester" });
  assert.equal(result.state, "not_applied");
  assert.ok(result.reasons.includes("DEPENDENCY_HASH_MISMATCH"), result.reasons.join(","));
});