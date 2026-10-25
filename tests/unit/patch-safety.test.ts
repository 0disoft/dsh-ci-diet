import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkflow } from "../../src/core/workflow/parse.ts";
import { createLocalBinding } from "../../src/core/scan/binding.ts";
import { PatchStore } from "../../src/core/patch/store.ts";
import { buildPatchPlan, buildPolicySnapshots, dependencyHashOf } from "../../src/core/patch/plan.ts";
import { applyEdits, planRetentionEdit, planTimeoutEdit } from "../../src/core/patch/edits.ts";
import { createAttestation } from "../../src/core/patch/attestation.ts";
import { approvePlan, approvalConfirmation } from "../../src/core/patch/approval.ts";
import { applyPlan, takeOverWriterLease } from "../../src/core/patch/apply.ts";
import { checkApply } from "../../src/core/patch/verify.ts";
import { attestationSatisfiesRule, claimsFromTokens, evaluatePatchEligibility } from "../../src/core/patch/eligibility.ts";
import { skuForLabels } from "../../src/core/history/model.ts";
import { buildCoverage } from "../../src/core/analysis/coverage.ts";
import { digestOf } from "../../src/shared/cdj1.ts";
import type { Coverage, Finding, PatchPlan, PolicySnapshot } from "../../src/core/contracts/schema.ts";
import type { HistoryBundle } from "../../src/core/history/model.ts";

const NOW = new Date("2026-10-20T00:00:00Z");
const ISO = NOW.toISOString();
const PATH = ".github/workflows/ci.yml";

const WORKFLOW = [
  "name: CI",
  "on:",
  "  pull_request:",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v7",
  "      - uses: actions/upload-artifact@v4",
  "        with:",
  "          name: dist",
  "          retention-days: 90",
  "  deploy:",
  "    environment: production",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: echo deploy",
  "",
].join("\n");

/** A real process id that is no longer running, for the crashed-owner case. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  return child.pid!;
}

function leaseToken(pid: number, suffix = "test"): string {
  return "lease_" + pid.toString(36) + "_" + Date.now().toString(36) + "_" + suffix;
}

function workspace(): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-safety-"));
  const dir = join(root, ".github", "workflows");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "ci.yml");
  writeFileSync(file, WORKFLOW, "utf8");
  return { root, file };
}

function policiesFor(bindingId: string): PolicySnapshot[] {
  return buildPolicySnapshots({
    binding: { bindingId } as never,
    protection: { defaultBranch: "main", ruleCount: 0, classicProtection: true, fetchedAt: ISO },
    retention: { days: 90, maximumAllowedDays: 90, fetchedAt: ISO },
    now: NOW,
  });
}

function attestationFor(
  bindingId: string,
  workflowHash: string,
  scope: "workflow" | "job" | "step" = "workflow",
  jobKey: string | null = null,
  stepKey: string | null = null,
) {
  return createAttestation({
    bindingId,
    workflowPath: PATH,
    workflowHash,
    dependencyHash: dependencyHashOf([]),
    scope,
    jobKey,
    stepKey,
    claims: claimsFromTokens(["ci-only", "replace-safe", "artifact-purpose:temporary", "consumer-min-days:1"]),
    evidenceRefs: ["test:safety"],
    issuedBy: { channel: "human-cli", subjectId: "tester" },
    now: NOW,
  });
}

function fixture(rule: "CD001" | "CD005" | "CD008" = "CD005") {
  const space = workspace();
  const binding = createLocalBinding(space.root, ISO, { repositoryFullName: "owner/repo" }).binding;
  const workflow = parseWorkflow(PATH, WORKFLOW);
  const edits = rule === "CD008"
    ? [planRetentionEdit(WORKFLOW, workflow.jobs[0]!, workflow.jobs[0]!.steps[1]!, 7).edit!]
    : [planTimeoutEdit(WORKFLOW, workflow, workflow.jobs[0]!, 20).edit!];
  const attestation = attestationFor(
    binding.bindingId,
    workflow.sha256,
    rule === "CD008" ? "step" : "job",
    "build",
    rule === "CD008" ? "steps[1]" : null,
  );
  const policies = policiesFor(binding.bindingId);
  const built = buildPatchPlan({
    binding,
    workflow,
    text: WORKFLOW,
    edits,
    attestations: [attestation],
    policies,
    blockers: [],
    coverageWriteAllowed: true,
    now: NOW,
    expected: rule === "CD008" ? { days: 7 } : { minutes: 20 },
  });
  const store = PatchStore.open(join(space.root, ".ci-diet"));
  store.saveBinding(binding);
  store.saveAttestation(attestation);
  store.savePlan(built.plan, { coverageWriteAllowed: true, reportId: null });
  return { ...space, binding, store, workflow, plan: built.plan, policies };
}

function approve(store: PatchStore, plan: PatchPlan): void {
  approvePlan({
    store,
    planId: plan.planId,
    confirmation: approvalConfirmation(plan),
    subjectId: "tester",
    channel: "human-cli",
    now: NOW,
  });
}

function coverage(): Coverage {
  return buildCoverage(
    { apiVersion: "2026-03-10", ghVersion: "2.0.0", requestedFrom: ISO, requestedTo: ISO },
    {},
  );
}

function finding(overrides: Partial<Finding>): Finding {
  return {
    findingId: "f_test",
    fingerprint: "sha256:" + "a".repeat(64),
    ruleId: "CD008",
    ruleVersion: "0.1.0",
    title: "title",
    renderedText: "rendered",
    workflowPath: PATH,
    workflowHash: "sha256:" + "b".repeat(64),
    evidenceLevel: "observed",
    patchability: "review-only",
    evidenceRefs: [],
    assumptions: [],
    blockers: ["ARTIFACT_PURPOSE_UNATTESTED", "EFFECTIVE_RETENTION_MAX_UNKNOWN"],
    standaloneRunnerSeconds: { status: "not_applicable", value: null, basis: "storage", reason: "storage" },
    ...overrides,
  };
}

function history(): HistoryBundle {
  return {
    repositoryId: "git:" + "c".repeat(32),
    repositoryFullName: "owner/repo",
    defaultBranch: "main",
    requestedFrom: "2026-10-13T00:00:00.000Z",
    requestedTo: ISO,
    runs: [],
    pulls: new Map(),
    workflows: [],
    artifacts: [],
    retention: { days: 90, maximumAllowedDays: 90, fetchedAt: ISO },
    protection: { defaultBranch: "main", ruleCount: 0, classicProtection: true, fetchedAt: ISO },
    coverage: coverage(),
    missingScopes: [],
  };
}

for (const age of [null, 0, 600_000, 601_000, -601_000]) {
  test("apply requires current retention evidence: " + (age === null ? "missing" : age + "ms old"), async (t) => {
    const f = fixture("CD008");
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    if (age !== null) {
      const snapshot = history();
      f.store.saveHistory(f.binding.bindingId, { ...snapshot, repositoryId: f.binding.repositoryId,
        retention: { ...snapshot.retention!, fetchedAt: new Date(NOW.getTime() - age).toISOString() } });
    }
    approve(f.store, f.plan);
    const result = await applyPlan({ store: f.store, planId: f.plan.planId, now: NOW, subjectId: "tester" });
    if (age !== null && Math.abs(age) <= 600_000) {
      assert.equal(result.state, "applied", result.reasons.join(","));
    } else {
      assert.equal(result.state, "not_applied");
      assert.ok(result.reasons.includes("POLICY_STALE"), result.reasons.join(","));
      assert.equal(readFileSync(f.file, "utf8"), WORKFLOW);
      assert.deepEqual(f.store.listChanges(), []);
      assert.deepEqual(readdirSync(join(f.store.root, "backups")), []);
      assert.notEqual(f.store.readNonce(f.plan.planId), null);
    }
  });
}

test("refuses an edit that changes a field outside the rule", () => {
  const space = workspace();
  const binding = createLocalBinding(space.root, ISO, { repositoryFullName: "owner/repo" }).binding;
  const definition = parseWorkflow(PATH, WORKFLOW);
  const marker = "    runs-on: ubuntu-latest\n";
  const start = Buffer.byteLength(WORKFLOW.slice(0, WORKFLOW.indexOf(marker) + marker.length), "utf8");
  const edit = {
    kind: "insertScalar" as const,
    startByte: start,
    endByte: start,
    replacementUtf8: "    environment: production\n",
    semanticPath: "jobs.build.environment",
    ruleId: "CD001" as const,
  };
  assert.throws(
    () => buildPatchPlan({
      binding,
      workflow: definition,
      text: WORKFLOW,
      edits: [edit],
      attestations: [attestationFor(binding.bindingId, definition.sha256)],
      policies: policiesFor(binding.bindingId),
      blockers: [],
      coverageWriteAllowed: true,
      now: NOW,
    }),
    /EDIT_OUT_OF_SCOPE/,
  );
});

test("apply rejects a payload that no longer matches the approved digest", async () => {
  const f = fixture("CD005");
  const edit = f.plan.payload.edits[0]!;
  const tampered: PatchPlan = {
    ...f.plan,
    payload: { ...f.plan.payload, edits: [{ ...edit, replacementUtf8: "    timeout-minutes: 999\n" }] },
  };
  f.store.savePlan(tampered, { coverageWriteAllowed: true, reportId: null });
  approve(f.store, tampered);
  const result = await applyPlan({ store: f.store, planId: tampered.planId, now: NOW, subjectId: "tester" });
  assert.equal(result.state, "not_applied");
  assert.ok(result.reasons.includes("PLAN_DIGEST_MISMATCH"), result.reasons.join(","));
  assert.equal(readFileSync(f.file, "utf8"), WORKFLOW);
});

test("apply refuses a synthetic plan", async () => {
  const space = workspace();
  const binding = createLocalBinding(space.root, ISO, { repositoryFullName: "owner/repo" }).binding;
  const workflow = parseWorkflow(PATH, WORKFLOW);
  const edit = planTimeoutEdit(WORKFLOW, workflow, workflow.jobs[0]!, 20).edit!;
  const built = buildPatchPlan({
    binding,
    workflow,
    text: WORKFLOW,
    edits: [edit],
    attestations: [attestationFor(binding.bindingId, workflow.sha256)],
    policies: policiesFor(binding.bindingId),
    blockers: [],
    coverageWriteAllowed: true,
    now: NOW,
    provenance: "synthetic",
    expected: { minutes: 20 },
  });
  const store = PatchStore.open(join(space.root, ".ci-diet"));
  store.saveBinding(binding);
  store.saveAttestation(attestationFor(binding.bindingId, workflow.sha256));
  store.savePlan(built.plan, { coverageWriteAllowed: true, reportId: null });
  approve(store, built.plan);
  const result = await applyPlan({ store, planId: built.plan.planId, now: NOW, subjectId: "tester" });
  assert.equal(result.state, "not_applied");
  assert.ok(result.reasons.includes("SYNTHETIC_PLAN"), result.reasons.join(","));
});

test("apply refuses to write while another writer holds the lease", async () => {
  const f = fixture("CD005");
  approve(f.store, f.plan);
  mkdirSync(join(f.store.root, "locks", "writer"), { recursive: true });
  await assert.rejects(
    applyPlan({ store: f.store, planId: f.plan.planId, now: NOW, subjectId: "tester" }),
    /WRITE_CONFLICT/,
  );
  assert.equal(readFileSync(f.file, "utf8"), WORKFLOW);
});

test("apply rejects a digest-consistent edit that touches another field", async () => {
  const f = fixture("CD005");
  const marker = "      - run: echo deploy\n";
  const start = Buffer.byteLength(WORKFLOW.slice(0, WORKFLOW.indexOf(marker) + marker.length), "utf8");
  const edit = {
    kind: "insertScalar" as const,
    startByte: start,
    endByte: start,
    replacementUtf8: "        env: production\n",
    semanticPath: "jobs.deploy.steps[0].with.env",
    ruleId: "CD005" as const,
  };
  const applied = applyEdits(WORKFLOW, [edit]);
  const deployAttestation = attestationFor(f.binding.bindingId, f.workflow.sha256, "job", "deploy");
  f.store.saveAttestation(deployAttestation);
  const payload = {
    ...f.plan.payload,
    edits: [edit],
    resultHash: applied.hash,
    attestations: [deployAttestation],
  };
  const tampered: PatchPlan = { ...f.plan, planDigest: digestOf(payload), payload };
  f.store.savePlan(tampered, { coverageWriteAllowed: true, reportId: null });
  approve(f.store, tampered);
  const result = await applyPlan({ store: f.store, planId: tampered.planId, now: NOW, subjectId: "tester" });
  assert.equal(result.state, "not_applied");
  assert.deepEqual(result.reasons, ["EDIT_OUT_OF_SCOPE"]);
  assert.equal(readFileSync(f.file, "utf8"), WORKFLOW);
});

test("plan state changes do not change the plan digest", () => {
  const f = fixture("CD005");
  approve(f.store, f.plan);
  const stored = f.store.readPlan(f.plan.planId)!;
  assert.equal(stored.plan.status.state, "approved");
  assert.equal(stored.plan.planDigest, f.plan.planDigest);
});

test("plans list excludes approval nonces and node reports by binding", () => {
  const f = fixture("CD005");
  f.store.saveNonce(f.plan.planId, {
    nonceId: "n_test",
    planDigest: f.plan.planDigest,
    createdAt: ISO,
    subjectId: "tester",
    channel: "human-cli",
  });
  assert.equal(f.store.listPlans().length, 1);
  assert.equal(f.store.findBindingByRoot(f.binding.workspaceRoot)?.bindingId, f.binding.bindingId);
});

test("replaces an existing retention-days value without duplicating the key", () => {
  const definition = parseWorkflow(PATH, WORKFLOW);
  const job = definition.jobs[0]!;
  const step = job.steps[1]!;
  const result = planRetentionEdit(WORKFLOW, job, step, 7);
  assert.ok(result.edit);
  assert.equal(result.edit.kind, "replaceScalar");
  const applied = applyEdits(WORKFLOW, [result.edit]);
  const reparsed = parseWorkflow(PATH, applied.text);
  const entries = reparsed.jobs[0]!.steps[1]!.withEntries.filter((entry) => entry.key === "retention-days");
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.literal, "7");
});

test("leaves a retention-days value at or below the proposal untouched", () => {
  const text = WORKFLOW.replace("retention-days: 90", "retention-days: 7");
  const definition = parseWorkflow(PATH, text);
  const result = planRetentionEdit(text, definition.jobs[0]!, definition.jobs[0]!.steps[1]!, 7);
  assert.equal(result.edit, null);
  assert.equal(result.error?.code, "EDIT_NOT_APPLICABLE");
});

test("lowers a retention-days value of 0 because it is the repository default", () => {
  const text = WORKFLOW.replace("retention-days: 90", "retention-days: 0");
  const definition = parseWorkflow(PATH, text);
  const result = planRetentionEdit(text, definition.jobs[0]!, definition.jobs[0]!.steps[1]!, 7);
  assert.ok(result.edit);
  assert.equal(result.edit.kind, "replaceScalar");
  const applied = applyEdits(text, [result.edit]);
  const reparsed = parseWorkflow(PATH, applied.text);
  assert.equal(reparsed.jobs[0]!.steps[1]!.withEntries.find((entry) => entry.key === "retention-days")?.literal, "7");
});

test("checks policy freshness per rule instead of the newest policy", () => {
  const f = fixture("CD005");
  const staleProtection = f.policies.map((policy) =>
    policy.kind === "protection" ? { ...policy, policyHash: "sha256:" + "d".repeat(64) } : policy,
  );
  const base = {
    plan: f.plan,
    now: NOW,
    currentText: WORKFLOW,
    currentDependencyHash: dependencyHashOf([]),
    coverageWriteAllowed: true,
    nonceValid: true,
    backupAvailable: true,
  };
  assert.deepEqual(checkApply({ ...base, currentPolicies: staleProtection }), []);

  const cd001 = buildPatchPlan({
    binding: f.binding,
    workflow: f.workflow,
    text: WORKFLOW,
    edits: [{
      kind: "insertScalar",
      startByte: 0,
      endByte: 0,
      replacementUtf8: "concurrency:\n  group: ci-diet-test\n  cancel-in-progress: true\n",
      semanticPath: "concurrency",
      ruleId: "CD001",
    }],
    attestations: [attestationFor(f.binding.bindingId, f.workflow.sha256)],
    policies: f.policies,
    blockers: [],
    coverageWriteAllowed: true,
    now: NOW,
    expected: { group: "ci-diet-test" },
  });
  const reasons = checkApply({
    ...base,
    plan: cd001.plan,
    currentText: WORKFLOW,
    currentPolicies: staleProtection,
  });
  assert.ok(reasons.includes("POLICY_STALE"), reasons.join(","));
});

test("accepts a policy snapshot exactly 600 seconds old and rejects either direction past it", () => {
  const f = fixture("CD008");
  const base = {
    plan: f.plan,
    currentText: WORKFLOW,
    currentDependencyHash: dependencyHashOf([]),
    coverageWriteAllowed: true,
    nonceValid: true,
    backupAvailable: true,
  };
  assert.deepEqual(checkApply({ ...base, now: new Date(NOW.getTime() + 600_000) }), []);
  assert.deepEqual(checkApply({ ...base, now: new Date(NOW.getTime() + 600_001) }), ["POLICY_STALE"]);
  assert.deepEqual(checkApply({ ...base, now: new Date(NOW.getTime() - 600_001) }), ["POLICY_STALE"]);
  // A future-dated snapshot 601 s ahead is stale exactly like a back-dated one.
  const ahead = new Date(NOW.getTime() + 601_000);
  const payload = {
    ...f.plan.payload,
    policies: f.plan.payload.policies.map((policy) => ({ ...policy, observedAt: ahead.toISOString().replace(/\.\d{3}Z$/, "Z") })),
  };
  const plan = { ...f.plan, payload, planDigest: digestOf(payload) };
  assert.deepEqual(checkApply({ ...base, plan, now: NOW }), ["POLICY_STALE"]);
});

test("apply refuses a retention edit declared as an allowed timeout rule", async (t) => {
  const f = fixture("CD008");
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  // Reproduce a schema-valid stored plan with a matching digest, but misleading
  // rule metadata. Normal plan creation derives this metadata from the edits.
  const payload = { ...f.plan.payload, ruleIds: ["CD005"] as PatchPlan["payload"]["ruleIds"] };
  const plan = { ...f.plan, payload, planDigest: digestOf(payload) };
  f.store.savePlan(plan, { coverageWriteAllowed: true, reportId: null });
  approve(f.store, plan);
  const nonce = f.store.readNonce(plan.planId);
  const result = await applyPlan({ store: f.store, planId: plan.planId, now: NOW,
    subjectId: "tester", allowedRules: ["CD005"] });
  t.diagnostic("retention edit with only timeout allowed: " + result.state);
  assert.equal(result.state, "not_applied");
  assert.ok(result.reasons.includes("RULE_NOT_ALLOWED"));
  assert.equal(readFileSync(f.file, "utf8"), WORKFLOW);
  assert.deepEqual(f.store.readNonce(plan.planId), nonce);
  assert.deepEqual(f.store.listChanges(), []);
  assert.deepEqual(readdirSync(join(f.store.root, "backups")), []);
});

for (const declared of [["CD005"], ["CD008", "CD005"]] as const) {
  test("apply invariant rejects declared rules inconsistent with edits: " + declared.join(","), (t) => {
    const f = fixture("CD008");
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const payload = { ...f.plan.payload, ruleIds: [...declared] };
    const plan = { ...f.plan, payload, planDigest: digestOf(payload) };
    assert.deepEqual(checkApply({ plan, now: NOW, currentText: WORKFLOW,
      currentDependencyHash: dependencyHashOf([]), coverageWriteAllowed: true,
      nonceValid: true, backupAvailable: true }), ["RULE_NOT_ALLOWED"]);
  });
}

test("apply invariant accepts the same rule set in a different order", (t) => {
  const f = fixture("CD005");
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const retention = planRetentionEdit(WORKFLOW, f.workflow.jobs[0]!, f.workflow.jobs[0]!.steps[1]!, 7).edit!;
  const built = buildPatchPlan({ binding: f.binding, workflow: f.workflow, text: WORKFLOW,
    edits: [...f.plan.payload.edits, retention], attestations: f.plan.payload.attestations,
    policies: f.policies, blockers: [], coverageWriteAllowed: true, now: NOW });
  const payload = { ...built.plan.payload, ruleIds: [...built.plan.payload.ruleIds].reverse() };
  assert.deepEqual(checkApply({ plan: { ...built.plan, payload, planDigest: digestOf(payload) }, now: NOW,
    currentText: WORKFLOW, currentDependencyHash: dependencyHashOf([]),
    coverageWriteAllowed: true, nonceValid: true, backupAvailable: true }), []);
  const duplicatePayload = { ...payload, ruleIds: ["CD005", "CD005"] as PatchPlan["payload"]["ruleIds"] };
  assert.deepEqual(checkApply({ plan: { ...built.plan, payload: duplicatePayload, planDigest: digestOf(duplicatePayload) },
    now: NOW, currentText: WORKFLOW, currentDependencyHash: dependencyHashOf([]),
    coverageWriteAllowed: true, nonceValid: true, backupAvailable: true }), ["RULE_NOT_ALLOWED"],
  "repeating one declared rule cannot hide a different rule in a mixed edit set");
});

test("classifies runner labels conservatively", () => {
  assert.equal(skuForLabels(["ubuntu-latest"]), "actions_linux");
  assert.equal(skuForLabels(["windows-2025"]), "actions_windows");
  assert.equal(skuForLabels(["macos-14"]), "actions_macos");
  assert.equal(skuForLabels(["ubuntu-slim"]), "actions_linux_slim");
  assert.equal(skuForLabels(["self-hosted", "linux", "x64"]), null);
  assert.equal(skuForLabels(["custom-runner"]), null);
  assert.equal(skuForLabels([]), null);
});

test("CD001 eligibility needs human claims and lifts only attestable blockers", () => {
  const cd001 = finding({
    ruleId: "CD001",
    blockers: ["PROTECTION_RULES_UNAVAILABLE", "REQUIRED_CHECK_OWNERSHIP_UNKNOWN"],
    patchability: "eligible",
  });
  const withoutClaims = evaluatePatchEligibility({
    rule: "CD001",
    finding: cd001,
    coverage: coverage(),
    claims: claimsFromTokens([]),
    history: history(),
    currentDefinitionParsed: true,
    editedJobEvidenceComplete: true,
    now: NOW,
  });
  assert.equal(withoutClaims.allowed, false);
  assert.ok(withoutClaims.reasons.includes("CLAIM_CI_ONLY_MISSING"));
  assert.ok(withoutClaims.reasons.includes("REQUIRED_CHECK_OWNERSHIP_UNKNOWN"));

  const withClaims = evaluatePatchEligibility({
    rule: "CD001",
    finding: cd001,
    coverage: coverage(),
    claims: claimsFromTokens(["ci-only", "replace-safe"]),
    history: history(),
    currentDefinitionParsed: true,
    editedJobEvidenceComplete: true,
    now: NOW,
  });
  assert.equal(withClaims.allowed, true, withClaims.reasons.join(","));
  assert.deepEqual(withClaims.remainingBlockers, []);
});

test("eligibility uses the same absolute 600 second policy freshness boundary", () => {
  const cd001 = finding({
    ruleId: "CD001",
    blockers: ["PROTECTION_RULES_UNAVAILABLE", "REQUIRED_CHECK_OWNERSHIP_UNKNOWN"],
    patchability: "eligible",
  });
  const base = {
    rule: "CD001" as const,
    finding: cd001,
    coverage: coverage(),
    claims: claimsFromTokens(["ci-only", "replace-safe"]),
    currentDefinitionParsed: true,
    editedJobEvidenceComplete: true,
  };
  assert.deepEqual(evaluatePatchEligibility({ ...base, history: history(), now: new Date(NOW.getTime() + 600_000) }).reasons, []);
  assert.deepEqual(evaluatePatchEligibility({ ...base, history: history(), now: new Date(NOW.getTime() + 600_001) }).reasons, ["POLICY_STALE"]);
  // A future-dated snapshot 601 s ahead is stale in eligibility too.
  const ahead = new Date(NOW.getTime() + 601_000).toISOString();
  const h = history();
  const futureHistory = { ...h, protection: { ...h.protection!, fetchedAt: ahead } };
  assert.deepEqual(evaluatePatchEligibility({ ...base, history: futureHistory, now: NOW }).reasons, ["POLICY_STALE"]);
});

test("CD001 eligibility never lifts a non-pull_request trigger", () => {
  const findingWithMixedTrigger = finding({
    ruleId: "CD001",
    blockers: ["WORKFLOW_TRIGGERS_NOT_PR_ONLY"],
    patchability: "eligible",
  });
  const claims = claimsFromTokens(["ci-only", "replace-safe"]);
  const result = evaluatePatchEligibility({
    rule: "CD001",
    finding: findingWithMixedTrigger,
    coverage: coverage(),
    claims,
    history: history(),
    currentDefinitionParsed: true,
    editedJobEvidenceComplete: true,
    now: NOW,
  });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("WORKFLOW_TRIGGERS_NOT_PR_ONLY"));
  assert.deepEqual(result.remainingBlockers, ["WORKFLOW_TRIGGERS_NOT_PR_ONLY"]);
  assert.equal(attestationSatisfiesRule("CD001", claims), true, "apply still checks only its own claims");
});

test("a blocked finding is never planned", () => {
  const blocked = evaluatePatchEligibility({
    rule: "CD001",
    finding: finding({ ruleId: "CD001", patchability: "blocked", blockers: ["DEPLOY_OR_RELEASE_JOB"] }),
    coverage: coverage(),
    claims: claimsFromTokens(["ci-only", "replace-safe"]),
    history: history(),
    currentDefinitionParsed: true,
    editedJobEvidenceComplete: true,
    now: NOW,
  });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.reasons.includes("FINDING_BLOCKED"));
  assert.ok(blocked.reasons.includes("DEPLOY_OR_RELEASE_JOB"));
});

test("a lease replaced while it is inspected is restored, never stolen", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-lease-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lease = join(root, "writer");
  mkdirSync(lease, { recursive: true });
  const live = leaseToken(process.pid, "live");
  writeFileSync(join(lease, "owner"), live, "utf8");
  // The takeover observed a dead owner token, but a live writer had already
  // replaced it before the rename.
  const observed = { owner: leaseToken(await deadPid(), "dead"), mtimeMs: Date.now() - 11 * 60_000 };
  assert.throws(() => takeOverWriterLease(lease, "takeover-token", observed), /WRITE_CONFLICT/);
  assert.equal(readFileSync(join(lease, "owner"), "utf8"), live);
});

test("a stale writer lease is taken over when its owner process is gone", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  approve(f.store, f.plan);
  const lease = join(f.store.root, "locks", "writer");
  mkdirSync(lease, { recursive: true });
  writeFileSync(join(lease, "owner"), leaseToken(await deadPid()), "utf8");
  const old = new Date(Date.now() - 11 * 60_000);
  utimesSync(lease, old, old);
  const result = await applyPlan({ store: f.store, planId: f.plan.planId, now: NOW, subjectId: "tester" });
  assert.equal(result.state, "applied");
  assert.equal(existsSync(lease), false);
  assert.deepEqual(readdirSync(join(f.store.root, "locks")), []);
});

test("a pinned clock ages a writer lease through the clock seam", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  approve(f.store, f.plan);
  const lease = join(f.store.root, "locks", "writer");
  mkdirSync(lease, { recursive: true });
  writeFileSync(join(lease, "owner"), leaseToken(await deadPid()), "utf8");
  // The lease mtime is fresh in real time; only the injected clock says it is stale.
  const staleNow = Date.now() + 11 * 60_000;
  const clock = { now: () => new Date(staleNow) };
  const result = await applyPlan({ store: f.store, planId: f.plan.planId, now: NOW, subjectId: "tester", clock });
  assert.equal(result.state, "applied");
  assert.equal(existsSync(lease), false);
});

test("a live owner is never moved, so a third writer cannot start beside it", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  approve(f.store, f.plan);
  const lease = join(f.store.root, "locks", "writer");
  mkdirSync(lease, { recursive: true });
  const owner = leaseToken(process.pid, "AAA");
  writeFileSync(join(lease, "owner"), owner, "utf8");
  const old = new Date(Date.now() - 11 * 60_000);
  utimesSync(lease, old, old);
  // B observes a stale lease, but A is still running. B must not move the path,
  // otherwise C can create a fresh lease there and apply concurrently with A.
  await assert.rejects(applyPlan({ store: f.store, planId: f.plan.planId, now: NOW, subjectId: "tester" }), /WRITE_CONFLICT/);
  await assert.rejects(applyPlan({ store: f.store, planId: f.plan.planId, now: NOW, subjectId: "tester" }), /WRITE_CONFLICT/);
  assert.equal(readFileSync(join(lease, "owner"), "utf8"), owner);
  assert.equal(readFileSync(f.file, "utf8"), WORKFLOW);
});

test("releasing the lease never removes a lease owned by another writer", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  approve(f.store, f.plan);
  const lease = join(f.store.root, "locks", "writer");
  const saveChange = f.store.saveChange.bind(f.store);
  t.mock.method(f.store, "saveChange", (change: Parameters<PatchStore["saveChange"]>[0]) => {
    saveChange(change);
    if (change.state === "APPLYING") writeFileSync(join(lease, "owner"), "foreign-owner", "utf8");
  });
  const result = await applyPlan({ store: f.store, planId: f.plan.planId, now: NOW, subjectId: "tester" });
  assert.equal(result.state, "applied");
  assert.equal(existsSync(lease), true);
  assert.equal(readFileSync(join(lease, "owner"), "utf8"), "foreign-owner");
});

test("concurrent approvals are serialized per plan", async (t) => {
  const f = fixture("CD005");
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const saveNonce = f.store.saveNonce.bind(f.store);
  let nested: unknown = null;
  t.mock.method(f.store, "saveNonce", (planId: string, nonce: Parameters<PatchStore["saveNonce"]>[1]) => {
    try {
      approve(f.store, f.plan);
    } catch (error) {
      nested = error;
    }
    saveNonce(planId, nonce);
  });
  const approved = approvePlan({
    store: f.store,
    planId: f.plan.planId,
    confirmation: approvalConfirmation(f.plan),
    subjectId: "tester",
    channel: "human-cli",
    now: NOW,
  });
  assert.match(String(nested), /WRITE_CONFLICT/);
  assert.equal(approved.plan.status.state, "approved");
  const stored = f.store.readPlan(f.plan.planId);
  const nonce = f.store.readNonce(f.plan.planId);
  assert.equal(stored?.plan.status.approvalNonceId, nonce?.nonceId);
  assert.equal(nonce?.subjectId, "tester");
  assert.deepEqual(readdirSync(join(f.store.root, "locks")), []);
});

test("an approval claim left by a dead process does not block approval", async (t) => {
  const f = fixture("CD005");
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const claim = join(f.store.root, "locks", "approve-" + f.plan.planId + ".claim");
  mkdirSync(claim, { recursive: true });
  writeFileSync(join(claim, "owner"), leaseToken(await deadPid()), "utf8");
  const approved = approvePlan({
    store: f.store,
    planId: f.plan.planId,
    confirmation: approvalConfirmation(f.plan),
    subjectId: "tester",
    channel: "human-cli",
    now: NOW,
  });
  assert.equal(approved.plan.status.state, "approved");
  assert.equal(existsSync(claim), false);
  assert.equal(f.store.readNonce(f.plan.planId)?.nonceId, approved.plan.status.approvalNonceId);
});

test("a writer claim blocks a second writer while the lease path is free", async (t) => {
  const f = fixture("CD005");
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  approve(f.store, f.plan);
  const claim = join(f.store.root, "locks", "writer.claim");
  mkdirSync(claim, { recursive: true });
  writeFileSync(join(claim, "owner"), leaseToken(process.pid, "holder"), "utf8");
  // Without the claim nobody may create the lease, so the gap the old rename
  // takeover opened (A and C both writers) is closed.
  await assert.rejects(applyPlan({ store: f.store, planId: f.plan.planId, now: NOW, subjectId: "tester" }), /WRITE_CONFLICT/);
  assert.equal(existsSync(join(f.store.root, "locks", "writer")), false);
  assert.equal(readFileSync(f.file, "utf8"), WORKFLOW);
  rmSync(claim, { recursive: true, force: true });
  const result = await applyPlan({ store: f.store, planId: f.plan.planId, now: NOW, subjectId: "tester" });
  assert.equal(result.state, "applied");
});

test("CD008 eligibility rejects a release artifact purpose", () => {
  const release = evaluatePatchEligibility({
    rule: "CD008",
    finding: finding({}),
    coverage: coverage(),
    claims: claimsFromTokens(["artifact-purpose:release", "consumer-min-days:7"]),
    history: history(),
    currentDefinitionParsed: true,
    editedJobEvidenceComplete: true,
    now: NOW,
  });
  assert.equal(release.allowed, false);
  assert.ok(release.reasons.includes("CLAIM_ARTIFACT_PURPOSE_NOT_TEMPORARY"));
  assert.ok(release.remainingBlockers.includes("ARTIFACT_PURPOSE_UNATTESTED"));
  assert.equal(attestationSatisfiesRule("CD008", claimsFromTokens(["artifact-purpose:release", "consumer-min-days:7"])), false);
  assert.equal(attestationSatisfiesRule("CD008", claimsFromTokens(["artifact-purpose:temporary", "consumer-min-days:7"])), true);
});

test("CD008 eligibility needs an attested purpose and a consumer floor", () => {
  const unknownPurpose = evaluatePatchEligibility({
    rule: "CD008",
    finding: finding({}),
    coverage: coverage(),
    claims: claimsFromTokens(["consumer-min-days:1"]),
    history: history(),
    currentDefinitionParsed: true,
    editedJobEvidenceComplete: true,
    now: NOW,
  });
  assert.ok(unknownPurpose.reasons.includes("CLAIM_ARTIFACT_PURPOSE_UNKNOWN"));

  const ok = evaluatePatchEligibility({
    rule: "CD008",
    finding: finding({}),
    coverage: coverage(),
    claims: claimsFromTokens(["artifact-purpose:temporary", "consumer-min-days:1"]),
    history: history(),
    currentDefinitionParsed: true,
    editedJobEvidenceComplete: true,
    now: NOW,
  });
  assert.equal(ok.allowed, true, ok.reasons.join(","));
});
