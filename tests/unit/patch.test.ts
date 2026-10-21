import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseWorkflow } from "../../src/core/workflow/parse.ts";
import { applyEdits, concurrencyGroup, planConcurrencyEdit, planRetentionEdit, planTimeoutEdit } from "../../src/core/patch/edits.ts";
import { buildPatchPlan, buildPolicySnapshots, dependencyHashOf, previewEdits } from "../../src/core/patch/plan.ts";
import { checkApply } from "../../src/core/patch/verify.ts";
import { createAttestation } from "../../src/core/patch/attestation.ts";
import { semanticProblems } from "../../src/core/patch/semantic.ts";
import { ENGINE_VERSION } from "../../src/core/version.ts";
import { assertValidDocument } from "../../src/core/contracts/validate.ts";
import { createLocalBinding } from "../../src/core/scan/binding.ts";
import type { RepositoryBinding } from "../../src/core/contracts/schema.ts";

const workflowText = [
  "name: CI",
  "on:",
  "  pull_request:",
  "  push:",
  "    branches: [main]",
  "jobs:",
  "  test:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v7",
  "      - name: Test",
  "        run: bun test",
  "  upload:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v7",
  "      - uses: actions/upload-artifact@v4",
  "        with:",
  "          name: coverage",
  "          path: coverage/",
  "      - run: echo done",
  "",
].join("\n");

function binding(): RepositoryBinding {
  const result = createLocalBinding(process.cwd(), "2026-10-20T00:00:00Z", { repositoryFullName: "0disoft/example" });
  return result.binding;
}

function workflow(path = ".github/workflows/ci.yml") {
  return parseWorkflow(path, workflowText);
}

describe("patch edits", () => {
  it("appends a concurrency block that reparses with the expected group", () => {
    const definition = workflow();
    const result = planConcurrencyEdit(workflowText, definition, "git:abc");
    assert.ok(result.edit);
    const expected = concurrencyGroup("git:abc", definition.path);
    assert.match(result.edit.replacementUtf8, /^concurrency:/);
    const applied = applyEdits(workflowText, [result.edit]);
    const reparsed = parseWorkflow(definition.path, applied.text);
    assert.equal(reparsed.concurrency?.group, expected);
    assert.equal(reparsed.concurrency?.cancelInProgress, true);
    assert.equal(reparsed.jobs.length, definition.jobs.length);
  });

  it("inserts a timeout after the last line of a job without touching the next job", () => {
    const definition = workflow();
    const job = definition.jobs.find((candidate) => candidate.key === "test");
    assert.ok(job);
    const result = planTimeoutEdit(workflowText, definition, job, 20);
    assert.ok(result.edit);
    const applied = applyEdits(workflowText, [result.edit]);
    const reparsed = parseWorkflow(definition.path, applied.text);
    assert.equal(reparsed.jobs.find((candidate) => candidate.key === "test")?.timeoutMinutes, 20);
    assert.equal(reparsed.jobs.find((candidate) => candidate.key === "upload")?.timeoutMinutes, null);
    assert.equal(reparsed.jobs.length, 2);
  });

  it("inserts a timeout before the next sibling job", () => {
    const definition = workflow();
    const job = definition.jobs[0];
    assert.ok(job);
    const result = planTimeoutEdit(workflowText, definition, job, 15);
    assert.ok(result.edit);
    const applied = applyEdits(workflowText, [result.edit]);
    const reparsed = parseWorkflow(definition.path, applied.text);
    assert.equal(reparsed.jobs[0]?.timeoutMinutes, 15);
    assert.equal(reparsed.jobs[1]?.key, "upload");
    assert.equal(reparsed.jobs[1]?.timeoutMinutes, null);
  });

  it("adds retention-days inside an existing with mapping", () => {
    const definition = workflow();
    const job = definition.jobs.find((candidate) => candidate.key === "upload");
    const step = job?.steps.find((candidate) => candidate.uses?.startsWith("actions/upload-artifact"));
    assert.ok(job && step);
    const result = planRetentionEdit(workflowText, job, step, 7);
    assert.ok(result.edit);
    const applied = applyEdits(workflowText, [result.edit]);
    const reparsed = parseWorkflow(definition.path, applied.text);
    const edited = reparsed.jobs.find((candidate) => candidate.key === "upload")?.steps[1];
    assert.equal(edited?.withEntries.find((entry) => entry.key === "retention-days")?.literal, "7");
    assert.equal(edited?.withEntries.find((entry) => entry.key === "name")?.literal, "coverage");
  });

  it("adds a parent with mapping when the upload step has none", () => {
    const text = [
      "on: push",
      "jobs:",
      "  upload:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/upload-artifact@v4",
      "      - run: echo done",
      "",
    ].join("\n");
    const definition = parseWorkflow(".github/workflows/ci.yml", text);
    const job = definition.jobs[0];
    const step = job?.steps[0];
    assert.ok(job && step);
    const result = planRetentionEdit(text, job, step, 7);
    assert.ok(result.edit);
    assert.equal(result.edit.kind, "insertParentMapping");
    const applied = applyEdits(text, [result.edit]);
    const reparsed = parseWorkflow(".github/workflows/ci.yml", applied.text);
    const edited = reparsed.jobs[0]?.steps[0];
    assert.equal(edited?.withEntries.find((entry) => entry.key === "retention-days")?.literal, "7");
    assert.equal(reparsed.jobs[0]?.steps.length, 2);
  });

  it("adds a parent with mapping when uses is not the first step key", () => {
    const text = [
      "on: push",
      "jobs:",
      "  upload:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Upload coverage",
      "        uses: actions/upload-artifact@v4",
      "      - run: echo done",
      "",
    ].join("\n");
    const definition = parseWorkflow(".github/workflows/ci.yml", text);
    const job = definition.jobs[0];
    const step = job?.steps[0];
    assert.ok(job && step);
    const result = planRetentionEdit(text, job, step, 7);
    assert.ok(result.edit);
    const applied = applyEdits(text, [result.edit]);
    const reparsed = parseWorkflow(".github/workflows/ci.yml", applied.text);
    assert.equal(reparsed.parseError, null);
    assert.equal(reparsed.jobs[0]?.steps[0]?.withEntries.find((entry) => entry.key === "retention-days")?.literal, "7");
    assert.deepEqual(
      semanticProblems({ original: definition, originalText: text, resultText: applied.text, edits: [result.edit] }),
      [],
    );
  });

  it("rejects overlapping edits", () => {
    const definition = workflow();
    const job = definition.jobs[0];
    assert.ok(job);
    const first = planTimeoutEdit(workflowText, definition, job, 10).edit;
    assert.ok(first);
    const second = { ...first, startByte: first.startByte, endByte: first.endByte };
    assert.throws(() => applyEdits(workflowText, [first, second]), /EDIT_OVERLAP/);
  });
});

describe("patch plan", () => {
  const definition = workflow();
  const b = binding();
  const policies = buildPolicySnapshots({
    binding: b,
    protection: { defaultBranch: "main", ruleCount: 0, classicProtection: true, fetchedAt: "2026-10-20T00:00:00Z" },
    retention: { days: 90, maximumAllowedDays: 90, fetchedAt: "2026-10-20T00:00:00Z" },
    now: new Date("2026-10-20T00:00:00Z"),
  });

  function attestationFor(scope: "workflow" | "job" | "step", jobKey: string | null, stepKey: string | null) {
    return createAttestation({
      bindingId: b.bindingId,
      workflowPath: definition.path,
      scope,
      jobKey,
      stepKey,
      workflowHash: definition.sha256,
      dependencyHash: dependencyHashOf([]),
      claims: { ciOnly: true, replaceSafe: true, artifactPurpose: "temporary", consumerMinDays: 1, reviewedOpaqueNodes: [] },
      issuedBy: { channel: "human-cli", subjectId: "tester" },
      now: new Date("2026-10-20T00:00:00Z"),
    });
  }

  it("builds a schema-valid plan with a stable digest", () => {
    const job = definition.jobs.find((candidate) => candidate.key === "test");
    assert.ok(job);
    const edit = planTimeoutEdit(workflowText, definition, job, 20).edit;
    assert.ok(edit);
    const built = buildPatchPlan({
      binding: b,
      workflow: definition,
      text: workflowText,
      edits: [edit],
      attestations: [attestationFor("job", "test", null)],
      policies,
      blockers: [],
      coverageWriteAllowed: true,
      now: new Date("2026-10-20T00:00:00Z"),
    });
    assertValidDocument("PatchPlan", built.plan);
    assert.equal(built.plan.status.state, "draft");
    assert.equal(built.plan.payload.ruleIds[0], "CD005");
    assert.equal(built.plan.payload.engineVersion, ENGINE_VERSION);
    assert.match(built.plan.planDigest, /^sha256:[0-9a-f]{64}$/);
    const again = buildPatchPlan({
      binding: b,
      workflow: definition,
      text: workflowText,
      edits: [edit],
      attestations: [attestationFor("job", "test", null)],
      policies,
      blockers: [],
      coverageWriteAllowed: true,
      now: new Date("2026-10-20T00:00:00Z"),
    });
    assert.equal(again.plan.planDigest, built.plan.planDigest);
    assert.deepEqual(checkApply({
      plan: built.plan,
      now: new Date("2026-10-20T00:01:00Z"),
      currentText: workflowText,
      currentDependencyHash: dependencyHashOf([]),
      coverageWriteAllowed: true,
      nonceValid: true,
      backupAvailable: true,
    }), []);
  });

  it("rejects a plan without an attestation or with stale policy", () => {
    const job = definition.jobs.find((candidate) => candidate.key === "test");
    assert.ok(job);
    const edit = planTimeoutEdit(workflowText, definition, job, 20).edit;
    assert.ok(edit);
    assert.throws(() => buildPatchPlan({
      binding: b,
      workflow: definition,
      text: workflowText,
      edits: [edit],
      attestations: [],
      policies,
      blockers: [],
      coverageWriteAllowed: true,
      now: new Date("2026-10-20T00:00:00Z"),
    }), /ATTESTATION_MISSING/);
  });

  it("reports expired, mismatched, and stale invariants", () => {
    const job = definition.jobs.find((candidate) => candidate.key === "test");
    assert.ok(job);
    const edit = planTimeoutEdit(workflowText, definition, job, 20).edit;
    assert.ok(edit);
    const built = buildPatchPlan({
      binding: b,
      workflow: definition,
      text: workflowText,
      edits: [edit],
      attestations: [attestationFor("job", "test", null)],
      policies,
      blockers: [],
      coverageWriteAllowed: true,
      now: new Date("2026-10-20T00:00:00Z"),
    });
    const reasons = checkApply({
      plan: built.plan,
      now: new Date("2026-11-20T00:00:00Z"),
      currentText: workflowText + "\n# edited\n",
      currentDependencyHash: dependencyHashOf([{ ref: "local:action", sha256: "sha256:" + "a".repeat(64) }]),
      coverageWriteAllowed: false,
      nonceValid: false,
      backupAvailable: false,
    });
    // CD005 edits carry no policy requirement; freshness is enforced per rule.
    for (const expected of ["PLAN_EXPIRED", "DEPENDENCY_HASH_MISMATCH", "COVERAGE_INSUFFICIENT_FOR_WRITE", "SOURCE_HASH_MISMATCH", "NONCE_INVALID", "BACKUP_UNAVAILABLE"] as const) {
      assert.ok(reasons.includes(expected), expected);
    }
  });

  it("previews the exact bytes without writing a file", () => {
    const job = definition.jobs.find((candidate) => candidate.key === "upload");
    assert.ok(job);
    const edit = planTimeoutEdit(workflowText, definition, job, 5).edit;
    assert.ok(edit);
    const preview = previewEdits(definition, workflowText, [edit], { minutes: 5 });
    assert.match(preview.resultText, /timeout-minutes: 5/);
    assert.notEqual(preview.sourceHash, preview.resultHash);
  });
});
