import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkflow } from "../../src/core/workflow/parse.ts";
import { createLocalBinding } from "../../src/core/scan/binding.ts";
import { PatchStore } from "../../src/core/patch/store.ts";
import { buildPatchPlan, buildPolicySnapshots, dependencyHashOf } from "../../src/core/patch/plan.ts";
import { applyEdits, planConcurrencyEdit, planTimeoutEdit } from "../../src/core/patch/edits.ts";
import { digestOf } from "../../src/shared/cdj1.ts";
import { createAttestation } from "../../src/core/patch/attestation.ts";
import { approvePlan, approvalConfirmation } from "../../src/core/patch/approval.ts";
import { applyPlan, revertChange } from "../../src/core/patch/apply.ts";
import type { AppliedChange } from "../../src/core/contracts/schema.ts";

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

test("status-only persistence rejects invalid status without changing stored records", (t) => {
  const f = setup();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const planFile = join(f.store.root, "plans", f.plan.planId + ".json");
  const metaFile = join(f.store.root, "plans", f.plan.planId + ".meta.json");
  const planBytes = readFileSync(planFile, "utf8");
  const metaBytes = readFileSync(metaFile, "utf8");
  assert.throws(() => f.store.updatePlanStatus(f.plan.planId, { ...f.plan.status, state: "invalid" as never }));
  assert.equal(readFileSync(planFile, "utf8"), planBytes);
  assert.equal(readFileSync(metaFile, "utf8"), metaBytes);
  assert.throws(() => f.store.updatePlanStatus("p_missing", f.plan.status), /STORE_PLAN_NOT_FOUND/);
});

test("approval does not rewrite unchanged read-only metadata", { skip: process.platform !== "win32" }, async (t) => {
  const f = setup();
  const metaFile = join(f.store.root, "plans", f.plan.planId + ".meta.json");
  const metadata = readFileSync(metaFile, "utf8");
  chmodSync(metaFile, 0o444);
  t.after(() => {
    chmodSync(metaFile, 0o666);
    rmSync(f.root, { recursive: true, force: true });
  });
  let approved;
  try {
    approved = approvePlan({ store: f.store, planId: f.plan.planId, confirmation: approvalConfirmation(f.plan),
      subjectId: "tester", channel: "human-cli", now: f.now });
  } catch (error) {
    assert.equal(f.store.readPlan(f.plan.planId)?.plan.status.state, f.plan.status.state,
      "Failed approval must not publish approved status before a failing metadata rewrite: " + String(error));
    throw error;
  }
  assert.equal(approved.plan.status.state, "approved");
  assert.equal(f.store.readPlan(f.plan.planId)?.plan.status.approvalNonceId, approved.nonce.nonceId);
  assert.equal(readFileSync(metaFile, "utf8"), metadata);
  const applied = await applyPlan({ store: f.store, planId: f.plan.planId, now: f.now, subjectId: "tester" });
  assert.equal(applied.state, "applied");
});

for (const refusal of ["changed source", "out of scope", "changed before replace"] as const) {
  test("apply preserves " + refusal + " refusal when the summary event fails", async (t) => {
    const f = setup();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    let plan = f.plan;
    if (refusal === "out of scope") {
      const edit = { ...plan.payload.edits[0]!, replacementUtf8: plan.payload.edits[0]!.replacementUtf8 + "permissions: {}\n" };
      const payload = { ...plan.payload, edits: [edit], resultHash: applyEdits(f.text, [edit]).hash };
      plan = { ...plan, payload, planDigest: digestOf(payload) };
      f.store.savePlan(plan, { coverageWriteAllowed: true, reportId: null });
    }
    approvePlan({ store: f.store, planId: plan.planId, confirmation: approvalConfirmation(plan),
      subjectId: "tester", channel: "human-cli", now: f.now });
    const nonce = f.store.readNonce(plan.planId);
    const concurrentText = f.text + "# user edit\n";
    if (refusal === "changed source") writeFileSync(f.file, concurrentText);
    if (refusal === "changed before replace") {
      const saveChange = f.store.saveChange.bind(f.store);
      t.mock.method(f.store, "saveChange", (change: Parameters<PatchStore["saveChange"]>[0]) => {
        saveChange(change);
        if (change.state === "PREPARED") writeFileSync(f.file, concurrentText);
      });
    }
    t.mock.method(f.store, "appendEvent", () => { throw new Error("private log error details"); });
    const result = await applyPlan({ store: f.store, planId: plan.planId, now: f.now, subjectId: "tester" });
    assert.equal(result.state, "not_applied");
    assert.deepEqual(result.reasons, [refusal === "out of scope" ? "EDIT_OUT_OF_SCOPE" : "SOURCE_HASH_MISMATCH"]);
    assert.deepEqual(result.warnings, ["EVENT_LOG_UNAVAILABLE"]);
    assert.equal(result.change, null);
    assert.equal(result.resultText, null);
    assert.equal(readFileSync(f.file, "utf8"), refusal === "out of scope" ? f.text : concurrentText);
    assert.deepEqual(f.store.readNonce(plan.planId), nonce);
    assert.deepEqual(f.store.listChanges().map((change) => change.state), refusal === "changed before replace" ? ["NOT_APPLIED"] : []);
  });
}

for (const failingWrite of ["saveNonce", "updatePlanStatus"] as const) {
  test("approval can retry after " + failingWrite + " fails without permitting an unapproved apply", async (t) => {
    const f = setup();
    const approve = () => approvePlan({
      store: f.store, planId: f.plan.planId, confirmation: approvalConfirmation(f.plan),
      subjectId: "tester", channel: "human-cli", now: f.now,
    });
    const failure = t.mock.method(f.store, failingWrite, () => { throw new Error("injected write failure"); });
    assert.throws(approve, /injected write failure/);
    failure.mock.restore();
    const stateAfterFailure = f.store.readPlan(f.plan.planId)?.plan.status.state;
    const refused = await applyPlan({ store: f.store, planId: f.plan.planId, now: f.now, subjectId: "tester" });
    assert.equal(refused.state, "not_applied");
    assert.ok(refused.reasons.includes("NONCE_INVALID"));
    assert.equal(readFileSync(f.file, "utf8"), f.text);

    const approved = approve();
    assert.equal(stateAfterFailure, f.plan.status.state);
    assert.equal(approved.plan.status.state, "approved");
    assert.equal(f.store.readNonce(f.plan.planId)?.nonceId, approved.plan.status.approvalNonceId);
    const applied = await applyPlan({ store: f.store, planId: f.plan.planId, now: f.now, subjectId: "tester" });
    assert.equal(applied.state, "applied");
  });
}

for (const operation of ["approve", "apply", "revert"] as const) {
  test(operation + " reports a committed action with a warning when the summary event fails", async (t) => {
    const f = setup();
    const approve = () => approvePlan({ store: f.store, planId: f.plan.planId,
      confirmation: approvalConfirmation(f.plan), subjectId: "tester", channel: "human-cli", now: f.now });
    if (operation !== "approve") approve();
    const applied = operation === "revert"
      ? await applyPlan({ store: f.store, planId: f.plan.planId, now: f.now, subjectId: "tester" })
      : null;
    t.mock.method(f.store, "appendEvent", () => { throw new Error("private log error details"); });
    if (operation === "approve") {
      const result = approve();
      assert.deepEqual(result.warnings, ["EVENT_LOG_UNAVAILABLE"]);
      assert.equal(f.store.readPlan(f.plan.planId)?.plan.status.state, "approved");
      assert.equal(f.store.readNonce(f.plan.planId)?.nonceId, result.plan.status.approvalNonceId);
      assert.equal(readFileSync(f.file, "utf8"), f.text);
    } else if (operation === "apply") {
      const result = await applyPlan({ store: f.store, planId: f.plan.planId, now: f.now, subjectId: "tester" });
      assert.equal(result.state, "applied");
      assert.deepEqual(result.warnings, ["EVENT_LOG_UNAVAILABLE"]);
      assert.equal(f.store.readChange(result.change!.changeId)?.state, "APPLIED");
      assert.notEqual(readFileSync(f.file, "utf8"), f.text);
    } else {
      const result = await revertChange({ store: f.store, changeId: applied!.change!.changeId, now: f.now });
      assert.equal(result.state, "REVERTED");
      assert.deepEqual(result.warnings, ["EVENT_LOG_UNAVAILABLE"]);
      assert.equal(f.store.readChange(applied!.change!.changeId)?.state, "REVERTED");
      assert.equal(readFileSync(f.file, "utf8"), f.text);
    }
  });
}

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

for (const missingFile of ["manifest.json", "before.yml"] as const) {
  test("revert records a missing " + missingFile + " and retries after backup repair", async () => {
    const f = setup();
    approvePlan({ store: f.store, planId: f.plan.planId, confirmation: approvalConfirmation(f.plan),
      subjectId: "tester", channel: "human-cli", now: f.now });
    const applied = await applyPlan({ store: f.store, planId: f.plan.planId, now: f.now, subjectId: "tester" });
    assert.equal(applied.state, "applied");
    const changeId = applied.change!.changeId;
    const after = readFileSync(f.file, "utf8");
    const backupFile = join(f.store.root, "backups", changeId, missingFile);
    const backup = readFileSync(backupFile);
    unlinkSync(backupFile);
    const now = new Date(f.now.getTime() + 1000);
    const refused = await revertChange({ store: f.store, changeId, now });
    assert.deepEqual(refused, { state: "RECOVERY_REQUIRED", reason: "BACKUP_UNAVAILABLE" });
    assert.equal(f.store.readChange(changeId)?.state, "RECOVERY_REQUIRED");
    assert.equal(f.store.readChange(changeId)?.updatedAt, now.toISOString().replace(/\.\d{3}Z$/, "Z"));
    assert.equal(readFileSync(f.file, "utf8"), after);

    writeFileSync(backupFile, backup);
    const retried = await revertChange({ store: f.store, changeId, now });
    assert.equal(retried.state, "REVERTED");
    assert.equal(f.store.readChange(changeId)?.state, "REVERTED");
    assert.equal(readFileSync(f.file, "utf8"), f.text);
  });
}

test("revert leaves the target untouched when the restore journal cannot be written", async (t) => {
  const f = setup();
  approvePlan({ store: f.store, planId: f.plan.planId, confirmation: approvalConfirmation(f.plan),
    subjectId: "tester", channel: "human-cli", now: f.now });
  const applied = await applyPlan({ store: f.store, planId: f.plan.planId, now: f.now, subjectId: "tester" });
  const changeId = applied.change!.changeId;
  const after = readFileSync(f.file, "utf8");
  t.mock.method(f.store, "saveChange", (change: AppliedChange) => {
    if (change.state === "REVERTING") throw new Error("STORAGE_QUOTA_EXCEEDED: test store is full");
  });
  await assert.rejects(revertChange({ store: f.store, changeId, now: f.now }), /STORAGE_QUOTA_EXCEEDED/);
  assert.equal(f.store.readChange(changeId)?.state, "APPLIED");
  assert.equal(readFileSync(f.file, "utf8"), after);
  t.mock.restoreAll();
  const retried = await revertChange({ store: f.store, changeId, now: f.now });
  assert.equal(retried.state, "REVERTED");
  assert.equal(readFileSync(f.file, "utf8"), f.text);
});

test("revert converges when the journal cannot record the restored bytes", async (t) => {
  const f = setup();
  approvePlan({ store: f.store, planId: f.plan.planId, confirmation: approvalConfirmation(f.plan),
    subjectId: "tester", channel: "human-cli", now: f.now });
  const applied = await applyPlan({ store: f.store, planId: f.plan.planId, now: f.now, subjectId: "tester" });
  const changeId = applied.change!.changeId;
  const original = f.store.saveChange.bind(f.store);
  let failed = false;
  t.mock.method(f.store, "saveChange", (change: AppliedChange) => {
    if (!failed && change.state === "REVERTED") {
      failed = true;
      throw new Error("STORAGE_QUOTA_EXCEEDED: test store is full");
    }
    return original(change);
  });
  await assert.rejects(revertChange({ store: f.store, changeId, now: f.now }), /STORAGE_QUOTA_EXCEEDED/);
  assert.equal(f.store.readChange(changeId)?.state, "REVERTING");
  assert.equal(readFileSync(f.file, "utf8"), f.text);
  t.mock.restoreAll();
  const retried = await revertChange({ store: f.store, changeId, now: f.now });
  assert.equal(retried.state, "REVERTED");
  assert.equal(f.store.readChange(changeId)?.state, "REVERTED");
  assert.equal(readFileSync(f.file, "utf8"), f.text);
});

test("revert finalizes when the target already holds the original bytes", async () => {
  const f = setup();
  approvePlan({ store: f.store, planId: f.plan.planId, confirmation: approvalConfirmation(f.plan),
    subjectId: "tester", channel: "human-cli", now: f.now });
  const applied = await applyPlan({ store: f.store, planId: f.plan.planId, now: f.now, subjectId: "tester" });
  const changeId = applied.change!.changeId;
  writeFileSync(f.file, f.text, "utf8");
  const reverted = await revertChange({ store: f.store, changeId, now: f.now });
  assert.equal(reverted.state, "REVERTED");
  assert.equal(f.store.readChange(changeId)?.state, "REVERTED");
  assert.equal(readFileSync(f.file, "utf8"), f.text);
});
test("revert retry from recovery still refuses a user-edited target", async () => {
  const f = setup();
  approvePlan({ store: f.store, planId: f.plan.planId, confirmation: approvalConfirmation(f.plan),
    subjectId: "tester", channel: "human-cli", now: f.now });
  const applied = await applyPlan({ store: f.store, planId: f.plan.planId, now: f.now, subjectId: "tester" });
  const change = applied.change!;
  f.store.saveChange({ ...change, state: "RECOVERY_REQUIRED" });
  const edited = readFileSync(f.file, "utf8") + "# user edit\n";
  writeFileSync(f.file, edited);
  const result = await revertChange({ store: f.store, changeId: change.changeId, now: f.now });
  assert.deepEqual(result, { state: "CONFLICT", reason: "CURRENT_BYTES_CHANGED" });
  assert.equal(f.store.readChange(change.changeId)?.state, "CONFLICT");
  assert.equal(readFileSync(f.file, "utf8"), edited);
});

for (const operation of ["apply", "revert"] as const) {
  test(operation + " refuses a parent directory redirected outside the workspace", async () => {
    const f = setup();
    approvePlan({ store: f.store, planId: f.plan.planId, confirmation: approvalConfirmation(f.plan),
      subjectId: "tester", channel: "human-cli", now: f.now });
    const applied = operation === "revert"
      ? await applyPlan({ store: f.store, planId: f.plan.planId, now: f.now, subjectId: "tester" })
      : null;
    if (applied !== null) assert.equal(applied.state, "applied");
    const original = readFileSync(f.file, "utf8");
    const outside = mkdtempSync(join(tmpdir(), "ci-diet-outside-"));
    const outsideFile = join(outside, "ci.yml");
    const workflows = join(f.root, ".github", "workflows");
    const saved = join(f.root, ".github", "workflows-saved");
    writeFileSync(outsideFile, original);
    renameSync(workflows, saved);
    let linked = false;
    try {
      symlinkSync(outside, workflows, process.platform === "win32" ? "junction" : "dir");
      linked = true;
      await assert.rejects(async () => {
        const result = operation === "apply"
          ? await applyPlan({ store: f.store, planId: f.plan.planId, now: f.now, subjectId: "tester" })
          : await revertChange({ store: f.store, changeId: applied!.change!.changeId, now: f.now });
        assert.fail("Redirected " + operation + " returned " + result.state);
      }, /WRITE_CONFLICT/);
      assert.equal(readFileSync(outsideFile, "utf8"), original);
      assert.equal(readFileSync(join(saved, "ci.yml"), "utf8"), original);
      if (operation === "apply") {
        assert.notEqual(f.store.readNonce(f.plan.planId), null);
        assert.equal(f.store.listChanges().length, 0);
      } else {
        assert.equal(f.store.readChange(applied!.change!.changeId)?.state, "APPLIED");
      }
    } finally {
      if (linked) unlinkSync(workflows);
      renameSync(saved, workflows);
      rmSync(outside, { recursive: true, force: true });
    }
  });
}

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

function blockReplacement(root: string, file: string): () => void {
  if (process.platform === "win32") {
    // A read-only target makes the rename fail with EPERM after the retries.
    chmodSync(file, 0o444);
    return () => chmodSync(file, 0o666);
  }
  // A non-writable directory makes the temporary write fail before the rename.
  const dir = join(root, ".github", "workflows");
  chmodSync(dir, 0o555);
  return () => chmodSync(dir, 0o755);
}

test("a failed replacement leaves the change not applied and keeps the approval retryable", async (t) => {
  const fixture = setup();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  approvePlan({
    store: fixture.store,
    planId: fixture.plan.planId,
    confirmation: approvalConfirmation(fixture.plan),
    subjectId: "tester",
    channel: "human-cli",
    now: fixture.now,
  });
  const nonce = fixture.store.readNonce(fixture.plan.planId);
  const restore = blockReplacement(fixture.root, fixture.file);
  try {
    await assert.rejects(
      applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester" }),
      /WRITE_CONFLICT/,
    );
  } finally {
    restore();
  }
  assert.equal(fixture.store.listChanges().at(-1)?.state, "NOT_APPLIED");
  assert.deepEqual(fixture.store.readNonce(fixture.plan.planId), nonce);
  assert.equal(readFileSync(fixture.file, "utf8"), fixture.text);
  const retried = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester" });
  assert.equal(retried.state, "applied");
  assert.notEqual(readFileSync(fixture.file, "utf8"), fixture.text);
});

test("a crash between the replacement and the APPLIED journal converges on the next apply", async (t) => {
  const fixture = setup();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  approvePlan({
    store: fixture.store,
    planId: fixture.plan.planId,
    confirmation: approvalConfirmation(fixture.plan),
    subjectId: "tester",
    channel: "human-cli",
    now: fixture.now,
  });
  const applied = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester" });
  assert.equal(applied.state, "applied");
  const patched = readFileSync(fixture.file, "utf8");
  const changeId = applied.change?.changeId ?? "";
  // Simulate the crash: the bytes are written, the journal still says PREPARED.
  fixture.store.saveChange({ ...applied.change!, state: "PREPARED" });
  const converged = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester" });
  assert.equal(converged.state, "applied");
  assert.equal(converged.change?.state, "APPLIED");
  assert.equal(readFileSync(fixture.file, "utf8"), patched);
  assert.equal(fixture.store.readChange(changeId)?.state, "APPLIED");
  assert.equal(fixture.store.readNonce(fixture.plan.planId), null);
  // The interrupted change can still be reverted.
  fixture.store.saveChange({ ...applied.change!, state: "PREPARED" });
  const reverted = await revertChange({ store: fixture.store, changeId, now: fixture.now });
  assert.equal(reverted.state, "REVERTED");
  assert.equal(readFileSync(fixture.file, "utf8"), fixture.text);
});

test("revert of an interrupted change whose replacement never landed marks it not applied", async (t) => {
  const fixture = setup();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
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
  writeFileSync(fixture.file, fixture.text, "utf8");
  fixture.store.saveChange({ ...applied.change!, state: "PREPARED" });
  const reverted = await revertChange({ store: fixture.store, changeId, now: fixture.now });
  assert.equal(reverted.state, "NOT_APPLIED");
  assert.equal(reverted.reason, "TARGET_UNCHANGED");
  assert.equal(fixture.store.readChange(changeId)?.state, "NOT_APPLIED");
  assert.equal(readFileSync(fixture.file, "utf8"), fixture.text);
});

test("apply rejects an approval nonce older than the TTL", async (t) => {
  const fixture = setup(WORKFLOW, "CD005");
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  approvePlan({
    store: fixture.store,
    planId: fixture.plan.planId,
    confirmation: approvalConfirmation(fixture.plan),
    subjectId: "tester",
    channel: "human-cli",
    now: fixture.now,
  });
  const later = new Date(fixture.now.getTime() + 601_000);
  const expired = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: later, subjectId: "tester" });
  assert.equal(expired.state, "not_applied");
  assert.deepEqual(expired.reasons, ["NONCE_INVALID"]);
  assert.equal(readFileSync(fixture.file, "utf8"), fixture.text);
  const widened = await applyPlan({
    store: fixture.store,
    planId: fixture.plan.planId,
    now: later,
    subjectId: "tester",
    approvalTtlSeconds: 1_000,
  });
  assert.equal(widened.state, "applied");
});

test("apply rejects a nonce approved for a different subject", async (t) => {
  const fixture = setup();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  approvePlan({
    store: fixture.store,
    planId: fixture.plan.planId,
    confirmation: approvalConfirmation(fixture.plan),
    subjectId: "alice",
    channel: "human-cli",
    now: fixture.now,
  });
  const foreign = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "bob" });
  assert.equal(foreign.state, "not_applied");
  assert.deepEqual(foreign.reasons, ["NONCE_INVALID"]);
  assert.equal(readFileSync(fixture.file, "utf8"), fixture.text);
  const owner = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "alice" });
  assert.equal(owner.state, "applied");
});

test("a nonce cleanup failure after a successful replacement keeps the change applied", async (t) => {
  const fixture = setup();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  approvePlan({
    store: fixture.store,
    planId: fixture.plan.planId,
    confirmation: approvalConfirmation(fixture.plan),
    subjectId: "tester",
    channel: "human-cli",
    now: fixture.now,
  });
  t.mock.method(fixture.store, "consumeNonce", () => {
    throw new Error("injected nonce cleanup failure");
  });
  const result = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester" });
  assert.equal(result.state, "applied");
  assert.equal(result.change?.state, "APPLIED");
  assert.deepEqual(result.warnings, ["NONCE_NOT_CONSUMED"]);
  assert.notEqual(readFileSync(fixture.file, "utf8"), fixture.text);
  assert.notEqual(fixture.store.readNonce(fixture.plan.planId), null);
});


test("a surviving approval converges on an applied target instead of rewriting it", async (t) => {
  const fixture = setup();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  approvePlan({
    store: fixture.store,
    planId: fixture.plan.planId,
    confirmation: approvalConfirmation(fixture.plan),
    subjectId: "tester",
    channel: "human-cli",
    now: fixture.now,
  });
  t.mock.method(fixture.store, "consumeNonce", () => {
    throw new Error("injected nonce cleanup failure");
  });
  const first = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester" });
  assert.equal(first.state, "applied");
  assert.notEqual(fixture.store.readNonce(fixture.plan.planId), null);
  const patched = readFileSync(fixture.file, "utf8");
  // The target already holds the planned result, so the second call converges on
  // the recorded change (retrying the cleanup) and never writes the file again.
  const second = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester" });
  assert.equal(second.state, "applied");
  assert.deepEqual(second.warnings, ["NONCE_NOT_CONSUMED"]);
  assert.equal(second.change?.changeId, first.change?.changeId);
  assert.equal(readFileSync(fixture.file, "utf8"), patched);
  assert.equal(fixture.store.listChanges().length, 1);
  assert.equal(fixture.store.readChange(first.change!.changeId)?.state, "APPLIED");
});

test("a reverted change cannot be applied again with the stale approval", async (t) => {
  const fixture = setup();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  approvePlan({
    store: fixture.store,
    planId: fixture.plan.planId,
    confirmation: approvalConfirmation(fixture.plan),
    subjectId: "tester",
    channel: "human-cli",
    now: fixture.now,
  });
  t.mock.method(fixture.store, "consumeNonce", () => {
    throw new Error("injected nonce cleanup failure");
  });
  const applied = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester" });
  const reverted = await revertChange({ store: fixture.store, changeId: applied.change!.changeId, now: fixture.now });
  assert.equal(reverted.state, "REVERTED");
  assert.equal(readFileSync(fixture.file, "utf8"), fixture.text);
  assert.notEqual(fixture.store.readNonce(fixture.plan.planId), null);
  const replay = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester" });
  assert.equal(replay.state, "not_applied");
  assert.deepEqual(replay.reasons, ["NONCE_INVALID"]);
  assert.equal(readFileSync(fixture.file, "utf8"), fixture.text);
  assert.equal(fixture.store.readChange(applied.change!.changeId)?.state, "REVERTED");
});

test("a conflicted revert converges once the original bytes are restored", async (t) => {
  const fixture = setup();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  approvePlan({
    store: fixture.store,
    planId: fixture.plan.planId,
    confirmation: approvalConfirmation(fixture.plan),
    subjectId: "tester",
    channel: "human-cli",
    now: fixture.now,
  });
  const applied = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester" });
  const changeId = applied.change!.changeId;
  const patched = readFileSync(fixture.file, "utf8");
  writeFileSync(fixture.file, patched + "# local edit\n", "utf8");
  const conflict = await revertChange({ store: fixture.store, changeId, now: fixture.now });
  assert.equal(conflict.state, "CONFLICT");
  assert.equal(fixture.store.readChange(changeId)?.state, "CONFLICT");
  // The user restores the pre-apply bytes by hand: the goal already holds.
  writeFileSync(fixture.file, fixture.text, "utf8");
  const converged = await revertChange({ store: fixture.store, changeId, now: fixture.now });
  assert.equal(converged.state, "REVERTED");
  assert.equal(fixture.store.readChange(changeId)?.state, "REVERTED");
  assert.equal(readFileSync(fixture.file, "utf8"), fixture.text);
});

test("a conflicted revert still warns but retries when the file holds the patched bytes", async (t) => {
  const fixture = setup();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  approvePlan({
    store: fixture.store,
    planId: fixture.plan.planId,
    confirmation: approvalConfirmation(fixture.plan),
    subjectId: "tester",
    channel: "human-cli",
    now: fixture.now,
  });
  const applied = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester" });
  const changeId = applied.change!.changeId;
  const patched = readFileSync(fixture.file, "utf8");
  writeFileSync(fixture.file, patched + "# local edit\n", "utf8");
  assert.equal((await revertChange({ store: fixture.store, changeId, now: fixture.now })).state, "CONFLICT");
  // Another hand edit puts back exactly the applied bytes: the revert is safe again.
  writeFileSync(fixture.file, patched, "utf8");
  const retried = await revertChange({ store: fixture.store, changeId, now: fixture.now });
  assert.equal(retried.state, "REVERTED");
  assert.equal(readFileSync(fixture.file, "utf8"), fixture.text);
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
