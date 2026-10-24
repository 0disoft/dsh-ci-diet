import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { applyPlan } from "../../src/core/patch/apply.ts";
import { approvePlan, approvalConfirmation } from "../../src/core/patch/approval.ts";
import { createAttestation } from "../../src/core/patch/attestation.ts";
import { collectDependencies } from "../../src/core/patch/dependencies.ts";
import { planTimeoutEdit } from "../../src/core/patch/edits.ts";
import { buildPatchPlan, buildPolicySnapshots, dependencyHashOf } from "../../src/core/patch/plan.ts";
import { PatchStore } from "../../src/core/patch/store.ts";
import { createLocalBinding } from "../../src/core/scan/binding.ts";
import { parseWorkflow } from "../../src/core/workflow/parse.ts";

const PATH = ".github/workflows/ci.yml";
const NOW = new Date("2026-10-20T00:00:00Z");

function fixture(t: TestContext, command: string) {
  const parent = mkdtempSync(join(tmpdir(), "ci-diet-cwd-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "repo");
  const external = join(parent, "external");
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  mkdirSync(join(root, "scripts"));
  mkdirSync(external);
  writeFileSync(join(root, "build.js"), "console.log('decoy')\n");
  writeFileSync(join(root, "scripts", "build.js"), "console.log('script')\n");
  writeFileSync(join(external, "build.js"), "console.log('external')\n");
  const text = "on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: " + command + "\n";
  writeFileSync(join(root, PATH), text);
  return { root, external, text, workflow: parseWorkflow(PATH, text) };
}

for (const cd of ["cd ../external", "cd /external", "cd", "cd -", 'cd "$WORKDIR"', "cd -P scripts", "cd scripts extra"]) {
  test("does not attribute subsequent commands to the old directory after " + cd, (t) => {
    const f = fixture(t, cd + " && node build.js");
    const collection = collectDependencies(f.root, f.workflow);
    assert.deepEqual(collection.dependencies, []);
    const reason = cd === 'cd "$WORKDIR"' ? "unsupported shell quoting or expansion" : "unresolved cd working-directory";
    assert.deepEqual(collection.unresolved, ["jobs.build.steps[0] (" + reason + ")"]);
  });
}

test("keeps literal relative cd, parent traversal within the root, and cd -- supported", (t) => {
  const f = fixture(t, "cd -- scripts && node build.js && cd .. && node build.js");
  const collection = collectDependencies(f.root, f.workflow);
  assert.deepEqual(collection.dependencies.map((entry) => entry.ref), ["build.js", "scripts/build.js"]);
  assert.deepEqual(collection.unresolved, []);
});

test("apply refuses an older approval that pinned a decoy after an escaping cd", async (t) => {
  const f = fixture(t, "cd ../external && node build.js");
  const binding = createLocalBinding(f.root, NOW.toISOString(), { repositoryFullName: "owner/repo" }).binding;
  // Reproduce a plan issued by the old collector: it hashed the root decoy.
  const decoyWorkflow = parseWorkflow(PATH, f.text.replace("cd ../external && ", ""));
  const dependencies = collectDependencies(f.root, decoyWorkflow).dependencies;
  assert.deepEqual(dependencies.map((entry) => entry.ref), ["build.js"]);
  const edit = planTimeoutEdit(f.text, f.workflow, f.workflow.jobs[0]!, 15);
  assert.ok(edit.edit);
  const attestation = createAttestation({
    bindingId: binding.bindingId, workflowPath: PATH, workflowHash: f.workflow.sha256,
    dependencyHash: dependencyHashOf(dependencies), scope: "job", jobKey: "build", stepKey: null,
    claims: { ciOnly: true, replaceSafe: true, artifactPurpose: "unknown", consumerMinDays: null, reviewedOpaqueNodes: [] },
    evidenceRefs: ["test:escaping-cd"], issuedBy: { channel: "human-cli", subjectId: "tester" }, now: NOW,
  });
  const policies = buildPolicySnapshots({ binding, now: NOW,
    protection: { defaultBranch: "main", ruleCount: 0, classicProtection: true, fetchedAt: NOW.toISOString() },
    retention: { days: 90, maximumAllowedDays: 90, fetchedAt: NOW.toISOString() },
  });
  const { plan } = buildPatchPlan({ binding, workflow: f.workflow, text: f.text, edits: [edit.edit],
    attestations: [attestation], policies, blockers: [], coverageWriteAllowed: true, dependencies, now: NOW });
  const store = PatchStore.open(join(f.root, ".ci-diet"));
  store.saveBinding(binding);
  store.saveAttestation(attestation);
  store.savePlan(plan, { coverageWriteAllowed: true, reportId: null });
  approvePlan({ store, planId: plan.planId, confirmation: approvalConfirmation(plan), subjectId: "tester", channel: "human-cli", now: NOW });
  writeFileSync(join(f.external, "build.js"), "console.log('changed after approval')\n");
  const result = await applyPlan({ store, planId: plan.planId, now: NOW, subjectId: "tester" });
  assert.equal(result.state, "not_applied");
  assert.ok(result.reasons.includes("DEPENDENCY_HASH_MISMATCH"), result.reasons.join(","));
  assert.equal(readFileSync(join(f.root, PATH), "utf8"), f.text);
  assert.deepEqual(readdirSync(join(store.root, "backups")), []);
});
