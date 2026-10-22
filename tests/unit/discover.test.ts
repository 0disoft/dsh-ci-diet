import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverWorkflows, WORKFLOW_MAX_BYTES } from "../../src/core/scan/discover.ts";

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-discover-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  return root;
}

test("accepts a workflow at exactly the byte cap and skips one byte more", () => {
  const root = makeRoot();
  try {
    const atCap = join(root, ".github", "workflows", "at-cap.yml");
    const overCap = join(root, ".github", "workflows", "over-cap.yml");
    writeFileSync(atCap, "a".repeat(WORKFLOW_MAX_BYTES), "utf8");
    writeFileSync(overCap, "b".repeat(WORKFLOW_MAX_BYTES + 1), "utf8");
    const result = discoverWorkflows(root);
    assert.deepEqual(result.workflows.map((file) => file.path), [".github/workflows/at-cap.yml"]);
    assert.deepEqual(result.skipped, [{ path: ".github/workflows/over-cap.yml", reason: "WORKFLOW_TOO_LARGE" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not follow a symlinked workflow", (t) => {
  const root = makeRoot();
  const target = join(root, "real.yml");
  writeFileSync(target, "name: real\n", "utf8");
  try {
    symlinkSync(target, join(root, ".github", "workflows", "linked.yml"));
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    t.skip("symlinks unavailable: " + String(error));
    return;
  }
  try {
    const result = discoverWorkflows(root);
    assert.deepEqual(result.workflows, []);
    assert.deepEqual(result.skipped, [{ path: ".github/workflows/linked.yml", reason: "WORKFLOW_NOT_A_FILE" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
