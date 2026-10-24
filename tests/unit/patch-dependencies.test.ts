import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyPlan } from "../../src/core/patch/apply.ts";
import { approvePlan, approvalConfirmation } from "../../src/core/patch/approval.ts";
import { createAttestation } from "../../src/core/patch/attestation.ts";
import { collectDependencies } from "../../src/core/patch/dependencies.ts";
import { planTimeoutEdit } from "../../src/core/patch/edits.ts";
import { buildPatchPlan, buildPolicySnapshots, dependencyHashOf } from "../../src/core/patch/plan.ts";
import { PatchStore } from "../../src/core/patch/store.ts";
import { parseWorkflow } from "../../src/core/workflow/parse.ts";
import { createLocalBinding } from "../../src/core/scan/binding.ts";

const NOW = new Date("2026-10-21T00:00:00Z");

function workspace(workflow: string): { root: string; path: string; text: string } {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-depfail-"));
  const dir = join(root, ".github", "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ci.yml"), workflow, "utf8");
  return { root, path: ".github/workflows/ci.yml", text: workflow };
}

const BINARY_WORKFLOW = [
  "on: push",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: ./.github/actions/binary",
].join("\n");

test("pins dependency bytes, so binary files that share a decoded text do not collide", (t) => {
  const space = workspace(BINARY_WORKFLOW);
  t.after(() => rmSync(space.root, { recursive: true, force: true }));
  const action = join(space.root, ".github", "actions", "binary");
  mkdirSync(action, { recursive: true });
  writeFileSync(join(action, "action.yml"), "runs:\n  using: node20\n  main: run.bin\n", "utf8");
  const left = Buffer.from([0x4d, 0x5a, 0x80]);
  const right = Buffer.from([0x4d, 0x5a, 0x81]);
  writeFileSync(join(action, "run.bin"), left);
  writeFileSync(join(action, "other.bin"), right);

  const collection = collectDependencies(space.root, parseWorkflow(space.path, space.text));
  const byRef = new Map(collection.dependencies.map((entry) => [entry.ref, entry.sha256]));
  const expected = (bytes: Buffer): string => "sha256:" + createHash("sha256").update(bytes).digest("hex");
  assert.equal(byRef.get(".github/actions/binary/run.bin"), expected(left));
  assert.equal(byRef.get(".github/actions/binary/other.bin"), expected(right));
  assert.notEqual(
    byRef.get(".github/actions/binary/run.bin"),
    byRef.get(".github/actions/binary/other.bin"),
    "both decode to the same replacement text, only the raw bytes differ",
  );
});

test("a file that exceeds the dependency cap inside a local action is unresolved", (t) => {
  const space = workspace(BINARY_WORKFLOW);
  t.after(() => rmSync(space.root, { recursive: true, force: true }));
  const action = join(space.root, ".github", "actions", "binary");
  mkdirSync(action, { recursive: true });
  writeFileSync(join(action, "action.yml"), "runs:\n  using: node20\n  main: run.bin\n", "utf8");
  writeFileSync(join(action, "run.bin"), "console.log('run')\n", "utf8");
  writeFileSync(join(action, "blob.bin"), Buffer.alloc(2 * 1024 * 1024 + 1));

  const collection = collectDependencies(space.root, parseWorkflow(space.path, space.text));
  assert.ok(
    collection.unresolved.includes(".github/actions/binary/blob.bin (file too large)"),
    collection.unresolved.join(","),
  );
  assert.equal(
    collection.dependencies.some((entry) => entry.ref.endsWith("blob.bin")),
    false,
    "an oversized blob must not be pinned as if it were reviewed",
  );
  assert.ok(collection.dependencies.some((entry) => entry.ref.endsWith("action.yml")));
});

test("reused local actions are scanned once and remain fully resolved", (t) => {
  const text = BINARY_WORKFLOW + "\n" + "      - uses: ./.github/actions/binary/.\n".repeat(19);
  const space = workspace(text);
  t.after(() => rmSync(space.root, { recursive: true, force: true }));
  const action = join(space.root, ".github", "actions", "binary");
  mkdirSync(action, { recursive: true });
  writeFileSync(join(action, "action.yml"), "runs:\n  using: node20\n  main: run.js\n");
  writeFileSync(join(action, "run.js"), "console.log('run')\n");
  const canonical = realpathSync(action);
  const read = fs.readdirSync;
  let scans = 0;
  const mocked = t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
    if (args[0] === canonical) scans += 1;
    return read(...args);
  });
  syncBuiltinESMExports();
  try {
    const collection = collectDependencies(space.root, parseWorkflow(space.path, text));
    t.diagnostic("local action directory scans: " + scans + " for 20 references");
    assert.deepEqual(collection.unresolved, [], "reused files are resolved, not missing");
    assert.equal(scans, 1);
    assert.equal(collection.dependencies.length, 2);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test("overlapping local action directories count already-pinned files as resolved", (t) => {
  const space = workspace(BINARY_WORKFLOW + "\n      - uses: ./.github/actions/binary/nested\n");
  t.after(() => rmSync(space.root, { recursive: true, force: true }));
  const action = join(space.root, ".github", "actions", "binary");
  mkdirSync(join(action, "nested"), { recursive: true });
  writeFileSync(join(action, "action.yml"), "name: parent\n");
  writeFileSync(join(action, "nested", "action.yml"), "name: nested\n");
  const collection = collectDependencies(space.root, parseWorkflow(space.path, space.text));
  assert.deepEqual(collection.unresolved, []);
  assert.equal(collection.dependencies.length, 2);
});

for (const kind of ["complete", "repeated", "repeated-changed", "oversized", "linked-directory", "linked-file"] as const) {
  const incomplete = kind !== "complete" && kind !== "repeated";
  test("apply checks local-action dependency completeness: " + kind, async (t) => {
    const repeated = kind !== "complete";
    const space = workspace(BINARY_WORKFLOW + (repeated ? "\n      - uses: ./.github/actions/binary\n" : ""));
    t.after(() => rmSync(space.root, { recursive: true, force: true }));
    const action = join(space.root, ".github", "actions", "binary");
    mkdirSync(action, { recursive: true });
    writeFileSync(join(action, "action.yml"), "runs:\n  using: node20\n  main: run.js\n");
    writeFileSync(join(action, "run.js"), "console.log('run')\n");
    const linked = kind === "linked-directory" || kind === "linked-file";
    const runtime = join(space.root, "runtime");
    if (linked) {
      mkdirSync(runtime);
      writeFileSync(join(runtime, "run.js"), "console.log('reviewed')\n");
      writeFileSync(join(action, "action.yml"), "runs:\n  using: node20\n  main: "
        + (kind === "linked-directory" ? "linked/run.js" : "linked") + "\n");
      try {
        symlinkSync(kind === "linked-directory" ? runtime : join(runtime, "run.js"), join(action, "linked"),
          kind === "linked-file" ? "file" : process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
        t.skip("symlink creation is not permitted on this platform");
        return;
      }
    }
    const workflow = parseWorkflow(space.path, space.text);
    const before = collectDependencies(space.root, workflow);
    if (!linked) assert.deepEqual(before.unresolved, []);
    // Recreate an already-approved plan from versions that silently omitted links.
    const binding = createLocalBinding(space.root, NOW.toISOString(), { repositoryFullName: "owner/repo" }).binding;
    const attestation = createAttestation({
      bindingId: binding.bindingId, workflowPath: space.path, workflowHash: workflow.sha256,
      dependencyHash: dependencyHashOf(before.dependencies), scope: "job", jobKey: "build", stepKey: null,
      claims: { ciOnly: true, replaceSafe: true, artifactPurpose: "unknown", consumerMinDays: null, reviewedOpaqueNodes: [] },
      evidenceRefs: ["test:dependency-completeness"], issuedBy: { channel: "human-cli", subjectId: "tester" }, now: NOW,
    });
    const built = buildPatchPlan({
      binding, workflow, text: space.text,
      edits: [planTimeoutEdit(space.text, workflow, workflow.jobs[0]!, 15).edit!],
      attestations: [attestation], policies: buildPolicySnapshots({ binding, protection: null, retention: null, now: NOW }),
      blockers: [], coverageWriteAllowed: true, dependencies: before.dependencies, now: NOW,
    });
    const store = PatchStore.open(join(space.root, ".ci-diet"));
    store.saveBinding(binding);
    store.saveAttestation(attestation);
    store.savePlan(built.plan, { coverageWriteAllowed: true, reportId: null });
    const approval = approvePlan({ store, planId: built.plan.planId, confirmation: approvalConfirmation(built.plan),
      subjectId: "tester", channel: "human-cli", now: NOW });
    if (kind === "repeated-changed") writeFileSync(join(action, "run.js"), "console.log('changed after approval')\n");
    if (kind === "oversized") {
      writeFileSync(join(action, "blob.bin"), Buffer.alloc(2 * 1024 * 1024 + 1));
      const after = collectDependencies(space.root, workflow);
      assert.deepEqual(after.dependencies, before.dependencies, "the hashable subset is unchanged");
      assert.deepEqual(after.unresolved, [".github/actions/binary/blob.bin (file too large)"]);
    }
    if (linked) {
      writeFileSync(join(runtime, "run.js"), "console.log('unreviewed')\n");
      const after = collectDependencies(space.root, workflow);
      assert.deepEqual(after.dependencies, before.dependencies, "the linked runtime is absent from the pinned subset");
    }
    const result = await applyPlan({ store, planId: built.plan.planId, now: NOW, subjectId: "tester" });
    assert.equal(result.state, incomplete ? "not_applied" : "applied");
    if (incomplete) {
      assert.deepEqual(result.reasons, ["DEPENDENCY_HASH_MISMATCH"]);
      assert.equal(readFileSync(join(space.root, space.path), "utf8"), space.text);
      assert.equal(store.readNonce(built.plan.planId)?.nonceId, approval.nonce.nonceId);
      assert.deepEqual(store.listChanges(), []);
      assert.equal(store.readBackup(store.changeIdFor(built.plan.planId, NOW)), null);
    }
    if (linked) {
      assert.deepEqual(collectDependencies(space.root, workflow).unresolved,
        [".github/actions/binary/linked (symbolic link)"]);
    }
  });
}

const SCRIPT_WORKFLOW = [
  "on: pull_request",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: node task.js",
].join("\n");

test("apply re-collects the workflow dependencies instead of trusting the stored refs", async (t) => {
  const space = workspace(SCRIPT_WORKFLOW);
  t.after(() => rmSync(space.root, { recursive: true, force: true }));
  const before = "console.log('a')\n";
  writeFileSync(join(space.root, "a.js"), before, "utf8");
  writeFileSync(join(space.root, "b.js"), "console.log('b')\n", "utf8");
  try {
    symlinkSync("a.js", join(space.root, "task.js"), "file");
  } catch (error) {
    t.skip("symlinks are not permitted here: " + String(error));
    return;
  }

  const binding = createLocalBinding(space.root, NOW.toISOString(), { repositoryFullName: "owner/repo" }).binding;
  const workflow = parseWorkflow(space.path, space.text);
  const deps = collectDependencies(space.root, workflow).dependencies;
  // The plan records the symlink target, so the stored ref (a.js) keeps its
  // hash even after the link is repointed.
  assert.deepEqual(deps.map((entry) => entry.ref), ["a.js"]);
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
    evidenceRefs: ["test:deps-symlink"],
    issuedBy: { channel: "human-cli", subjectId: "tester" },
    now: NOW,
  });
  const store = PatchStore.open(join(space.root, ".ci-diet"));
  store.saveBinding(binding);
  store.saveAttestation(attestation);
  const fetchedAt = NOW.toISOString();
  const policies = buildPolicySnapshots({
    binding,
    protection: { defaultBranch: "main", ruleCount: 0, classicProtection: true, fetchedAt },
    retention: { days: 90, maximumAllowedDays: 90, fetchedAt },
    now: NOW,
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
    now: NOW,
  });
  store.savePlan(built.plan, { coverageWriteAllowed: true, reportId: null });
  approvePlan({
    store,
    planId: built.plan.planId,
    confirmation: approvalConfirmation(built.plan),
    subjectId: "tester",
    channel: "human-cli",
    now: NOW,
  });

  unlinkSync(join(space.root, "task.js"));
  symlinkSync("b.js", join(space.root, "task.js"), "file");
  assert.equal(readFileSync(join(space.root, "a.js"), "utf8"), before, "the stored ref itself is untouched");

  const result = await applyPlan({ store, planId: built.plan.planId, now: NOW, subjectId: "tester" });
  assert.equal(result.state, "not_applied");
  assert.ok(result.reasons.includes("DEPENDENCY_HASH_MISMATCH"), result.reasons.join(","));
});
