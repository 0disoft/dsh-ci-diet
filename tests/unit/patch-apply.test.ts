import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkflow } from "../../src/core/workflow/parse.ts";
import { createLocalBinding } from "../../src/core/scan/binding.ts";
import { PatchStore } from "../../src/core/patch/store.ts";
import { buildPatchPlan, buildPolicySnapshots, dependencyHashOf } from "../../src/core/patch/plan.ts";
import { planConcurrencyEdit, planTimeoutEdit } from "../../src/core/patch/edits.ts";
import { createAttestation } from "../../src/core/patch/attestation.ts";
import { approvePlan, approvalConfirmation } from "../../src/core/patch/approval.ts";
import { applyPlan, revertChange } from "../../src/core/patch/apply.ts";

const WORKFLOW = [
  "name: CI",
  "on:",
  "  pull_request:",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: npm test",
  "",
].join("\n");

function workspace(text: string): { root: string; path: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-apply-"));
  const dir = join(root, ".github", "workflows");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "ci.yml");
  writeFileSync(file, text, "utf8");
  return { root, path: ".github/workflows/ci.yml", file };
}

function setup(text = WORKFLOW, rule: "CD001" | "CD005" = "CD001") {
  const space = workspace(text);
  const now = new Date("2026-10-20T00:00:00Z");
  const binding = createLocalBinding(space.root, now.toISOString(), { repositoryFullName: "owner/repo" }).binding;
  const workflow = parseWorkflow(space.path, text);
  const edits = rule === "CD001"
    ? [planConcurrencyEdit(text, workflow, binding.repositoryId)]
    : [planTimeoutEdit(text, workflow, workflow.jobs[0] as never, 15)];
  const edit = edits[0];
  if (edit?.edit == null) throw new Error("fixture edit failed");
  const attestation = createAttestation({
    bindingId: binding.bindingId,
    workflowPath: space.path,
    workflowHash: workflow.sha256,
    dependencyHash: dependencyHashOf([]),
    scope: rule === "CD001" ? "workflow" : "job",
    jobKey: rule === "CD001" ? null : "build",
    stepKey: null,
    claims: { ciOnly: true, replaceSafe: true, artifactPurpose: "unknown", consumerMinDays: null, reviewedOpaqueNodes: [] },
    evidenceRefs: ["test:apply"],
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
    text,
    edits: [edit.edit],
    attestations: [attestation],
    policies,
    blockers: [],
    coverageWriteAllowed: true,
    now,
  });
  store.savePlan(built.plan, { coverageWriteAllowed: true, reportId: null });
  return { ...space, binding, store, plan: built.plan, text, now };
}

test("apply requires an approved plan", async () => {
  const fixture = setup();
  const result = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester" });
  assert.equal(result.state, "not_applied");
  assert.deepEqual(result.reasons, ["NONCE_INVALID"]);
  assert.equal(readFileSync(fixture.file, "utf8"), fixture.text);
});

test("approve then apply writes the planned bytes and records a backup", async () => {
  const fixture = setup();
  const approved = approvePlan({
    store: fixture.store,
    planId: fixture.plan.planId,
    confirmation: approvalConfirmation(fixture.plan),
    subjectId: "tester",
    channel: "human-cli",
    now: fixture.now,
  });
  const result = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester" });
  assert.equal(result.state, "applied");
  const after = readFileSync(fixture.file, "utf8");
  assert.notEqual(after, fixture.text);
  assert.match(after, /concurrency:/);
  assert.equal(result.change?.state, "APPLIED");
  const backup = fixture.store.readBackup(result.change?.changeId ?? "");
  assert.equal(backup?.beforeText, fixture.text);
  assert.equal(backup?.afterText, after);
  assert.equal(approved.plan.status.state, "approved");
});

for (const defect of ["coverage-string", "nonce-channel", "nonce-subject", "nonce-time"] as const) {
  test("apply refuses malformed sidecar fields: " + defect, async () => {
    const f = setup();
    approvePlan({ store: f.store, planId: f.plan.planId, confirmation: approvalConfirmation(f.plan),
      subjectId: "tester", channel: "human-cli", now: f.now });
    const noncePath = join(f.store.root, "plans", f.plan.planId + ".nonce.json");
    const path = defect === "coverage-string"
      ? join(f.store.root, "plans", f.plan.planId + ".meta.json")
      : noncePath;
    const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (defect === "coverage-string") record.coverageWriteAllowed = "false";
    else if (defect === "nonce-channel") record.channel = "agent";
    else if (defect === "nonce-subject") delete record.subjectId;
    else record.createdAt = "not a timestamp";
    const contents = JSON.stringify(record);
    writeFileSync(path, contents);
    const nonceBefore = readFileSync(noncePath, "utf8");

    await assert.rejects(
      async () => {
        const result = await applyPlan({ store: f.store, planId: f.plan.planId, now: f.now, subjectId: "tester" });
        assert.fail("Malformed sidecar returned " + result.state);
      },
      (error: unknown) => error instanceof Error && error.message.startsWith("STATE_INVALID:") && error.message.includes(path),
    );
    assert.equal(readFileSync(f.file, "utf8"), f.text);
    assert.equal(readFileSync(path, "utf8"), contents);
    assert.equal(readFileSync(noncePath, "utf8"), nonceBefore);
    assert.equal(f.store.listChanges().length, 0);
  });
}

test("apply refuses a second time because the nonce was consumed", async () => {
  const fixture = setup();
  approvePlan({
    store: fixture.store,
    planId: fixture.plan.planId,
    confirmation: approvalConfirmation(fixture.plan),
    subjectId: "tester",
    channel: "human-cli",
    now: fixture.now,
  });
  assert.equal((await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester" })).state, "applied");
  const second = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester" });
  assert.equal(second.state, "not_applied");
  assert.ok(second.reasons.includes("NONCE_INVALID") || second.reasons.includes("SOURCE_HASH_MISMATCH"));
});

test("revert restores the original bytes only when the file still matches", async () => {
  const fixture = setup();
  approvePlan({
    store: fixture.store,
    planId: fixture.plan.planId,
    confirmation: approvalConfirmation(fixture.plan),
    subjectId: "tester",
    channel: "human-cli",
    now: fixture.now,
  });
  const applied = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester" });
  const changeId = applied.change?.changeId ?? "";
  const reverted = await revertChange({ store: fixture.store, changeId, now: fixture.now });
  assert.equal(reverted.state, "REVERTED");
  assert.equal(readFileSync(fixture.file, "utf8"), fixture.text);
});

test("revert refuses when the working tree changed after apply", async () => {
  const fixture = setup();
  approvePlan({
    store: fixture.store,
    planId: fixture.plan.planId,
    confirmation: approvalConfirmation(fixture.plan),
    subjectId: "tester",
    channel: "human-cli",
    now: fixture.now,
  });
  const applied = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester" });
  writeFileSync(fixture.file, readFileSync(fixture.file, "utf8") + "# local edit\n", "utf8");
  const reverted = await revertChange({ store: fixture.store, changeId: applied.change?.changeId ?? "", now: fixture.now });
  assert.equal(reverted.state, "CONFLICT");
});

test("wrong confirmation never approves", () => {
  const fixture = setup();
  assert.throws(
    () => approvePlan({
      store: fixture.store,
      planId: fixture.plan.planId,
      confirmation: "000000000000",
      subjectId: "tester",
      channel: "human-cli",
      now: fixture.now,
    }),
    /NONCE_INVALID/,
  );
});
