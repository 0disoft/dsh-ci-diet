import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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
import { acquireStoreLock, applyPlan, revertChange } from "../../src/core/patch/apply.ts";
import type { AppliedChange } from "../../src/core/contracts/schema.ts";
import type { HistoryBundle } from "../../src/core/history/model.ts";
import { buildCoverage } from "../../src/core/analysis/coverage.ts";
import { buildHistoryReport } from "../../src/core/analysis/report.ts";
import { DEFAULT_CONFIG } from "../../src/core/data/default-config.ts";

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

for (const phase of ["age check", "owner write"]) {
  test("apply preserves a writer owner published during " + phase, async (t) => {
    const f = setup();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const approved = approvePlan({ store: f.store, planId: f.plan.planId,
      confirmation: approvalConfirmation(f.plan), subjectId: "tester", channel: "human-cli", now: f.now });
    const lease = join(f.store.root, "locks", "writer");
    const ownerPath = join(lease, "owner");
    const owner = "lease_" + process.pid.toString(36) + "_live_other";
    if (phase === "age check") {
      mkdirSync(lease);
      const old = new Date(Date.now() - 11 * 60_000);
      fs.utimesSync(lease, old, old);
    }
    const stat = fs.statSync;
    const write = fs.writeFileSync;
    let published = false;
    t.mock.method(fs, "statSync", (...args: Parameters<typeof fs.statSync>) => {
      const result = stat(...args);
      if (phase === "age check" && !published && String(args[0]) === lease) {
        published = true;
        write(ownerPath, owner);
      }
      return result;
    });
    t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
      if (phase === "owner write" && !published && String(args[0]) === ownerPath) {
        published = true;
        write(ownerPath, owner);
      }
      return write(...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(applyPlan({ store: f.store, planId: f.plan.planId, now: f.now, subjectId: "tester" }));
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.equal(published, true);
    assert.equal(readFileSync(ownerPath, "utf8"), owner);
    assert.equal(readFileSync(f.file, "utf8"), f.text);
    assert.equal(f.store.readNonce(f.plan.planId)?.nonceId, approved.nonce.nonceId);
    assert.deepEqual(f.store.listChanges(), []);
    assert.deepEqual(readdirSync(join(f.store.root, "backups")), []);
  });
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

test("apply refuses a missing live attestation instead of reviving the plan snapshot", async (t) => {
  const fixture = setup(WORKFLOW, "CD005");
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const approved = approvePlan({ store: fixture.store, planId: fixture.plan.planId,
    confirmation: approvalConfirmation(fixture.plan), subjectId: "tester", channel: "human-cli", now: fixture.now });
  const attestation = fixture.plan.payload.attestations[0]!;
  const record = join(fixture.store.root, "attestations", attestation.attestationId + ".json");
  const original = readFileSync(record);
  unlinkSync(record);

  const result = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester" });
  assert.equal(result.state, "not_applied");
  assert.ok(result.reasons.includes("ATTESTATION_MISSING"));
  assert.equal(readFileSync(fixture.file, "utf8"), fixture.text);
  assert.deepEqual(fixture.store.listChanges(), []);
  assert.deepEqual(readdirSync(join(fixture.store.root, "backups")), []);
  assert.equal(fixture.store.readNonce(fixture.plan.planId)?.nonceId, approved.nonce.nonceId);

  for (const reason of ["ATTESTATION_REVOKED", "ATTESTATION_EXPIRED"] as const) {
    fixture.store.saveAttestation({ ...attestation,
      ...(reason === "ATTESTATION_REVOKED" ? { revokedAt: fixture.now.toISOString() } : { expiresAt: fixture.now.toISOString() }),
    });
    const refused = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester" });
    assert.equal(refused.state, "not_applied");
    assert.ok(refused.reasons.includes(reason), "live state overrides the unrevoked, unexpired snapshot");
    assert.equal(readFileSync(fixture.file, "utf8"), fixture.text);
    assert.deepEqual(fixture.store.listChanges(), []);
    assert.deepEqual(readdirSync(join(fixture.store.root, "backups")), []);
    assert.equal(fixture.store.readNonce(fixture.plan.planId)?.nonceId, approved.nonce.nonceId);
  }

  writeFileSync(record, original);
  const retry = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester" });
  assert.equal(retry.state, "applied", "restoring the live record allows the still-valid approval to be retried");
});

for (const corruptedFile of ["before.yml", "after.yml"]) {
  test("apply refuses a corrupted " + corruptedFile + " before replacing the workflow", async (t) => {
    const fixture = setup();
    t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
    approvePlan({
      store: fixture.store, planId: fixture.plan.planId,
      confirmation: approvalConfirmation(fixture.plan), subjectId: "tester",
      channel: "human-cli", now: fixture.now,
    });
    const original = fixture.store.writeBackup.bind(fixture.store);
    const corrupt = t.mock.method(fixture.store, "writeBackup", (...args: Parameters<PatchStore["writeBackup"]>) => {
      const manifest = original(...args);
      const path = join(fixture.store.root, "backups", args[0], corruptedFile);
      const bytes = readFileSync(path);
      bytes[0] = bytes[0]! ^ 1;
      writeFileSync(path, bytes);
      return manifest;
    });
    const refused = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester" });
    assert.equal(refused.state, "not_applied");
    assert.deepEqual(refused.reasons, ["BACKUP_UNAVAILABLE"]);
    assert.equal(readFileSync(fixture.file, "utf8"), fixture.text);
    assert.equal(fixture.store.listChanges().length, 0);
    assert.notEqual(fixture.store.readNonce(fixture.plan.planId), null);
    corrupt.mock.restore();
    const retried = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester" });
    assert.equal(retried.state, "applied");
    assert.equal((await revertChange({ store: fixture.store, changeId: retried.change!.changeId, now: fixture.now })).state, "REVERTED");
    assert.equal(readFileSync(fixture.file, "utf8"), fixture.text);
  });
}

for (const corruptLegacy of [false, true]) {
test("prune keeps the binding a revert still needs" + (corruptLegacy ? " beside corrupt legacy metadata" : ""), async (t) => {
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
  const changeId = applied.change?.changeId;
  assert.ok(changeId);
  // The sync path stores the binding in its generation, not as a legacy record.
  rmSync(join(fixture.store.root, "bindings", fixture.binding.bindingId + ".json"));

  const requestedFrom = "2026-10-01T00:00:00Z";
  const requestedTo = fixture.now.toISOString();
  const snapshot: HistoryBundle = {
    repositoryId: fixture.binding.repositoryId,
    repositoryFullName: "owner/repo",
    defaultBranch: "main",
    requestedFrom,
    requestedTo,
    runs: [],
    pulls: new Map(),
    workflows: [],
    artifacts: [],
    retention: null,
    protection: null,
    coverage: buildCoverage({ apiVersion: "2026-03-10", ghVersion: "gh 2", requestedFrom, requestedTo }, {}),
    missingScopes: [],
  };
  const report = buildHistoryReport({
    binding: fixture.binding,
    workflows: [],
    history: snapshot,
    config: DEFAULT_CONFIG,
    generatedAt: requestedTo,
  }).report;
  assert.equal(fixture.store.saveHistorySnapshot(fixture.binding, snapshot, report), true);
  const legacyPath = join(fixture.store.root, "bindings", fixture.binding.bindingId + ".json");
  if (corruptLegacy) writeFileSync(legacyPath, "{");
  const pruned = fixture.store.prune(new Date("2030-01-01T00:00:00Z"), { reportDays: 90, planDays: 7, cacheDays: 30 });
  assert.equal(pruned.removedReports, corruptLegacy ? 0 : 1);
  if (corruptLegacy) {
    assert.equal(readFileSync(legacyPath, "utf8"), "{", "prune preserves the corrupt record for review");
    // Simulate an operator quarantining the corrupt legacy record. The last
    // valid generation must still support a real restore from the backup.
    rmSync(legacyPath);
  }

  const reverted = await revertChange({ store: fixture.store, changeId, now: fixture.now });
  assert.equal(reverted.state, "REVERTED");
  assert.equal(readFileSync(fixture.file, "utf8"), fixture.text);
});
}

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

test("a status write refuses a stale revision and leaves the plan unchanged", (t) => {
  const f = setup();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const before = readFileSync(join(f.store.root, "plans", f.plan.planId + ".json"), "utf8");
  assert.throws(
    () => f.store.updatePlanStatus(f.plan.planId, { ...f.plan.status, state: "approved" }, f.plan.status.revision + 1),
    /PLAN_STATUS_CONFLICT: expected revision/,
  );
  assert.equal(readFileSync(join(f.store.root, "plans", f.plan.planId + ".json"), "utf8"), before);
});

test("status compare-and-set reads the revision after acquiring the write lock", (t) => {
  const f = setup();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const rival = PatchStore.open(f.store.root);
  const revision = f.plan.status.revision;
  const newerStatus = { ...f.plan.status, revision: revision + 2 };
  const originalMkdir = fs.mkdirSync;
  let interleaved = false;
  const mocked = t.mock.method(fs, "mkdirSync", (...args: Parameters<typeof mkdirSync>) => {
    if (!interleaved && String(args[0]) === join(f.store.root, "locks", "write.claim")) {
      interleaved = true;
      // A different store writer commits just before this writer gets its lock.
      rival.updatePlanStatus(f.plan.planId, newerStatus, revision);
    }
    return originalMkdir(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => f.store.updatePlanStatus(f.plan.planId, { ...f.plan.status, revision: revision + 1 }, revision),
      /PLAN_STATUS_CONFLICT: expected revision/,
    );
    assert.equal(interleaved, true);
    assert.deepEqual(f.store.readPlan(f.plan.planId)?.plan.status, newerStatus);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  // A refused CAS must also release its lock so a fresh revision can proceed.
  f.store.updatePlanStatus(f.plan.planId, { ...newerStatus, revision: revision + 3 }, revision + 2);
  assert.equal(f.store.readPlan(f.plan.planId)?.plan.status.revision, revision + 3);
});

test("prune skips a plan whose approval claim is held", (t) => {
  const f = setup();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const later = new Date(f.now.getTime() + 8 * 24 * 60 * 60 * 1000);
  const lock = acquireStoreLock(f.store, "approve-" + f.plan.planId, 0);
  try {
    const skipped = f.store.prune(later, { reportDays: 90, planDays: 7, cacheDays: 30 });
    assert.equal(skipped.removedPlans, 0);
    assert.notEqual(f.store.readPlan(f.plan.planId), null);
  } finally {
    lock.release();
  }
  const pruned = f.store.prune(later, { reportDays: 90, planDays: 7, cacheDays: 30 });
  assert.equal(pruned.removedPlans, 1);
  assert.equal(f.store.readPlan(f.plan.planId), null);
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

for (const operation of ["apply", "revert"] as const) {
  test(operation + " closes and removes its replacement after a partial write", async (t) => {
    const f = setup();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    approvePlan({ store: f.store, planId: f.plan.planId, confirmation: approvalConfirmation(f.plan),
      subjectId: "tester", channel: "human-cli", now: f.now });
    const applied = operation === "revert"
      ? await applyPlan({ store: f.store, planId: f.plan.planId, now: f.now, subjectId: "tester" })
      : null;
    const before = readFileSync(f.file, "utf8");
    const write = fs.writeFileSync;
    let handle: number | null = null;
    t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
      if (typeof args[0] === "number" && handle === null) {
        handle = args[0];
        write(handle, "partial bytes");
        throw Object.assign(new Error("injected partial write"), { code: "ENOSPC" });
      }
      return write(...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(operation === "apply"
        ? applyPlan({ store: f.store, planId: f.plan.planId, now: f.now, subjectId: "tester" })
        : revertChange({ store: f.store, changeId: applied!.change!.changeId, now: f.now }), /WRITE_CONFLICT/);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.notEqual(handle, null);
    assert.throws(() => fs.fstatSync(handle!), { code: "EBADF" });
    assert.equal(readFileSync(f.file, "utf8"), before);
    assert.deepEqual(readdirSync(join(f.root, ".github", "workflows")), ["ci.yml"]);
  });

  for (const collision of ["file", "hard link"] as const) {
    test(operation + " preserves a pre-existing replacement " + collision, async (t) => {
      const f = setup();
      t.after(() => rmSync(f.root, { recursive: true, force: true }));
      approvePlan({ store: f.store, planId: f.plan.planId, confirmation: approvalConfirmation(f.plan),
        subjectId: "tester", channel: "human-cli", now: f.now });
      const applied = operation === "revert"
        ? await applyPlan({ store: f.store, planId: f.plan.planId, now: f.now, subjectId: "tester" })
        : null;
      const before = readFileSync(f.file, "utf8");
      const stamp = Date.now();
      t.mock.method(Date, "now", () => stamp);
      const temporary = f.file + ".ci-diet-" + process.pid + "-" + stamp.toString(36) + ".tmp";
      const unrelated = join(f.root, "unrelated.txt");
      writeFileSync(unrelated, "unrelated bytes");
      if (collision === "hard link") fs.linkSync(unrelated, temporary);
      else writeFileSync(temporary, "unrelated bytes");
      await assert.rejects(operation === "apply"
        ? applyPlan({ store: f.store, planId: f.plan.planId, now: f.now, subjectId: "tester" })
        : revertChange({ store: f.store, changeId: applied!.change!.changeId, now: f.now }), /WRITE_CONFLICT/);
      assert.equal(readFileSync(f.file, "utf8"), before);
      assert.equal(readFileSync(temporary, "utf8"), "unrelated bytes");
      assert.equal(readFileSync(unrelated, "utf8"), "unrelated bytes");
    });
  }
}

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

for (const operation of ["apply", "revert"] as const) {
  test(operation + " preserves edits made after its final journal write", async (t) => {
    const f = setup();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    approvePlan({ store: f.store, planId: f.plan.planId, confirmation: approvalConfirmation(f.plan),
      subjectId: "tester", channel: "human-cli", now: f.now });
    const applied = operation === "revert"
      ? await applyPlan({ store: f.store, planId: f.plan.planId, now: f.now, subjectId: "tester" })
      : null;
    const edited = readFileSync(f.file, "utf8") + "# concurrent user edit\n";
    const saveChange = f.store.saveChange.bind(f.store);
    let injected = false;
    t.mock.method(f.store, "saveChange", (change: AppliedChange) => {
      saveChange(change);
      if (change.state === (operation === "apply" ? "APPLYING" : "REVERTING")) {
        injected = true;
        writeFileSync(f.file, edited);
      }
    });
    const changeId = applied?.change?.changeId ?? f.store.changeIdFor(f.plan.planId, f.now);
    await assert.rejects(operation === "apply"
      ? applyPlan({ store: f.store, planId: f.plan.planId, now: f.now, subjectId: "tester" })
      : revertChange({ store: f.store, changeId, now: f.now }), /WRITE_CONFLICT/);
    assert.equal(injected, true);
    assert.equal(readFileSync(f.file, "utf8"), edited);
    assert.equal(f.store.readChange(changeId)?.state, operation === "apply" ? "RECOVERY_REQUIRED" : "REVERTING");
    assert.notEqual(f.store.readBackup(changeId), null);
    assert.deepEqual(readdirSync(join(f.root, ".github", "workflows")), ["ci.yml"]);
    t.mock.restoreAll();
    assert.equal((await revertChange({ store: f.store, changeId, now: f.now })).state, "CONFLICT");
    assert.equal(readFileSync(f.file, "utf8"), edited);
  });

  test(operation + " rechecks the target after a failed rename before retrying", async (t) => {
    const f = setup();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    approvePlan({ store: f.store, planId: f.plan.planId, confirmation: approvalConfirmation(f.plan),
      subjectId: "tester", channel: "human-cli", now: f.now });
    const applied = operation === "revert"
      ? await applyPlan({ store: f.store, planId: f.plan.planId, now: f.now, subjectId: "tester" })
      : null;
    const edited = readFileSync(f.file, "utf8") + "# user edit during rename contention\n";
    const changeId = applied?.change?.changeId ?? f.store.changeIdFor(f.plan.planId, f.now);
    const rename = fs.renameSync;
    let attempts = 0;
    const mocked = t.mock.method(fs, "renameSync", (...args: Parameters<typeof renameSync>) => {
      if (args[1] === f.file && ++attempts === 1) {
        writeFileSync(f.file, edited);
        throw Object.assign(new Error("simulated rename contention"), { code: "EPERM" });
      }
      return rename(...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(operation === "apply"
        ? applyPlan({ store: f.store, planId: f.plan.planId, now: f.now, subjectId: "tester" })
        : revertChange({ store: f.store, changeId, now: f.now }), /WRITE_CONFLICT/);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(attempts, 1, "a conflict must prevent the next rename attempt");
    assert.equal(readFileSync(f.file, "utf8"), edited);
    assert.notEqual(f.store.readBackup(changeId), null);
    assert.deepEqual(readdirSync(join(f.root, ".github", "workflows")), ["ci.yml"]);
  });
}

test("a failed replacement leaves the change not applied and keeps the approval retryable", async (t) => {
  if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0) {
    // Root bypasses directory write bits, so this filesystem seam cannot fail the rename.
    t.skip("root ignores the non-writable directory used to inject the failure");
    return;
  }
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
  assert.deepEqual(readdirSync(join(fixture.root, ".github", "workflows")), ["ci.yml"], "a failed replacement leaves no temporary file");
  const changeId = fixture.store.changeIdFor(fixture.plan.planId, fixture.now);
  assert.equal(fixture.store.readBackup(changeId), null, "a replacement that never landed keeps no backup");
  assert.equal(existsSync(join(fixture.store.root, "backups", changeId)), false);
  const retried = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester" });
  assert.equal(retried.state, "applied");
  assert.notEqual(readFileSync(fixture.file, "utf8"), fixture.text);
});

test("a journal write failure removes the backup it prepared", async (t) => {
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
  const changeId = fixture.store.changeIdFor(fixture.plan.planId, fixture.now);
  const blockedRecord = join(fixture.store.root, "changes", changeId + ".json");
  mkdirSync(blockedRecord, { recursive: true });
  await assert.rejects(
    applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester" }),
  );
  assert.equal(existsSync(join(fixture.store.root, "backups", changeId)), false, "an unreferenced backup is removed");
  assert.equal(readFileSync(fixture.file, "utf8"), fixture.text);
  rmSync(blockedRecord, { recursive: true, force: true });
  const retried = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester" });
  assert.equal(retried.state, "applied");
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

test("a conflicted approval cannot be replayed after the bytes are restored", async (t) => {
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
  const changeId = applied.change!.changeId;
  writeFileSync(fixture.file, readFileSync(fixture.file, "utf8") + "# local edit\n", "utf8");
  assert.equal((await revertChange({ store: fixture.store, changeId, now: fixture.now })).state, "CONFLICT");
  // Restoring the pre-apply bytes does not revive the spent approval.
  writeFileSync(fixture.file, fixture.text, "utf8");
  const replay = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester" });
  assert.equal(replay.state, "not_applied");
  assert.deepEqual(replay.reasons, ["NONCE_INVALID"]);
  assert.equal(readFileSync(fixture.file, "utf8"), fixture.text);
  assert.equal(fixture.store.readChange(changeId)?.state, "CONFLICT");
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

test("approval at exactly the plan expiry is rejected and one millisecond earlier is accepted", (t) => {
  const fixture = setup();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const expiresAt = new Date(fixture.now.getTime() + 60_000);
  const payload = { ...fixture.plan.payload, expiresAt: expiresAt.toISOString().replace(/\.\d{3}Z$/, "Z") };
  const plan = { ...fixture.plan, payload, planDigest: digestOf(payload) };
  fixture.store.savePlan(plan, { coverageWriteAllowed: true, reportId: null });
  const input = {
    store: fixture.store,
    planId: plan.planId,
    confirmation: approvalConfirmation(plan),
    subjectId: "tester",
    channel: "human-cli" as const,
  };
  assert.throws(() => approvePlan({ ...input, now: expiresAt }), /PLAN_EXPIRED/);
  const approved = approvePlan({ ...input, now: new Date(expiresAt.getTime() - 1) });
  assert.equal(approved.plan.status.state, "approved");
});

test("an approval nonce expiring exactly now is rejected", async (t) => {
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
  const boundary = new Date(fixture.now.getTime() + 1000);
  const expired = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: boundary, subjectId: "tester", approvalTtlSeconds: 1 });
  assert.equal(expired.state, "not_applied");
  assert.deepEqual(expired.reasons, ["NONCE_INVALID"]);
  const accepted = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: new Date(boundary.getTime() - 1), subjectId: "tester", approvalTtlSeconds: 1 });
  assert.equal(accepted.state, "applied");
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

test("an aborted apply leaves the target, journal, and approval untouched", async (t) => {
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
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester", signal: controller.signal }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(readFileSync(fixture.file, "utf8"), fixture.text);
  assert.equal(fixture.store.listChanges().length, 0);
  assert.notEqual(fixture.store.readNonce(fixture.plan.planId), null);
  // The writer lease was released, so the unchanged approval can still apply.
  const applied = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: fixture.now, subjectId: "tester" });
  assert.equal(applied.state, "applied");
});

test("apply honors a shorter configured approval lifetime", async (t) => {
  const fixture = setup();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  approvePlan({ store: fixture.store, planId: fixture.plan.planId, confirmation: approvalConfirmation(fixture.plan),
    subjectId: "tester", channel: "human-cli", now: fixture.now });
  const later = new Date(fixture.now.getTime() + 300_000);
  const rejected = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: later,
    subjectId: "tester", approvalTtlSeconds: 100 });
  assert.equal(rejected.state, "not_applied");
  assert.ok(rejected.reasons.includes("NONCE_INVALID"), "reasons: " + rejected.reasons.join(","));
  assert.equal(readFileSync(fixture.file, "utf8"), fixture.text);
  const applied = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: later,
    subjectId: "tester", approvalTtlSeconds: 600 });
  assert.equal(applied.state, "applied");
});

test("apply honors a configured policy freshness bound", async (t) => {
  const fixture = setup();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  approvePlan({ store: fixture.store, planId: fixture.plan.planId, confirmation: approvalConfirmation(fixture.plan),
    subjectId: "tester", channel: "human-cli", now: fixture.now });
  const later = new Date(fixture.now.getTime() + 601_000);
  const rejected = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: later,
    subjectId: "tester", approvalTtlSeconds: 1200 });
  assert.equal(rejected.state, "not_applied");
  assert.ok(rejected.reasons.includes("POLICY_STALE"), "reasons: " + rejected.reasons.join(","));
  const applied = await applyPlan({ store: fixture.store, planId: fixture.plan.planId, now: later,
    subjectId: "tester", approvalTtlSeconds: 1200, policyMaxAgeSeconds: 1200 });
  assert.equal(applied.state, "applied");
});

test("an aborted revert keeps the applied change until a retry finishes it", async (t) => {
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
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => revertChange({ store: fixture.store, changeId, now: fixture.now, signal: controller.signal }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(readFileSync(fixture.file, "utf8"), patched);
  assert.equal(fixture.store.readChange(changeId)?.state, "APPLIED");
  const reverted = await revertChange({ store: fixture.store, changeId, now: fixture.now });
  assert.equal(reverted.state, "REVERTED");
  assert.equal(readFileSync(fixture.file, "utf8"), fixture.text);
});
