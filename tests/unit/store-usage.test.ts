import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AppliedChange } from "../../src/core/contracts/schema.ts";
import { PatchStore, StoreQuotaError } from "../../src/core/patch/store.ts";
import { createLocalBinding } from "../../src/core/scan/binding.ts";

const HASH = "sha256:" + "a".repeat(64);
const NOW = new Date("2026-10-20T00:00:00Z");

function limits(overrides: Partial<{ storeMaxBytes: number; warningPercent: number }> = {}) {
  return { storeMaxBytes: 0, warningPercent: 80, cacheMaxBytes: 0, pruneAppliedBackups: false, ...overrides };
}

function change(index: number): AppliedChange {
  return {
    schemaVersion: 2,
    provenance: "observed",
    changeId: "c_" + index.toString(16).padStart(16, "0"),
    bindingId: "b_" + "1".repeat(24),
    planId: "p_" + "2".repeat(24),
    planDigest: HASH,
    workflowPath: ".github/workflows/ci.yml",
    state: "APPLIED",
    before: { path: "C:/repo/.github/workflows/ci.yml", hash: HASH, bytes: 1 },
    after: { path: "C:/repo/.github/workflows/ci.yml", hash: HASH, bytes: 1 },
    approvalChannel: "human-cli",
    approvalReference: "nonce-1",
    updatedAt: "2026-10-20T00:00:00Z",
  };
}

/** Independent recursive copy of the accounting rule: everything but the top-level locks dir. */
function deepUsage(directory: string, topLevel = true): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (topLevel && entry.isDirectory() && entry.name === "locks") continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = deepUsage(full, false);
      bytes += nested.bytes;
      files += nested.files;
    } else if (entry.isFile()) {
      bytes += statSync(full).size;
      files += 1;
    }
  }
  return { bytes, files };
}

function withRoot<T>(run: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-usage-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("usage stays exact after every write and append", () => {
  withRoot((root) => {
    const store = PatchStore.open(join(root, "state"));
    assert.deepEqual(store.usage(), deepUsage(store.root));
    for (let index = 1; index <= 6; index += 1) {
      store.saveChange(change(index));
      assert.deepEqual(store.usage(), deepUsage(store.root));
      store.appendEvent({ kind: "usage-test", index }, NOW);
      assert.deepEqual(store.usage(), deepUsage(store.root));
    }
    // Replacing an existing record adjusts bytes only, never the file count.
    const beforeFiles = store.usage().files;
    store.saveChange({ ...change(6), state: "REVERTED" });
    const after = store.usage();
    assert.deepEqual(after, deepUsage(store.root));
    assert.equal(after.files, beforeFiles);
  });
});

test("deleting a backup invalidates the snapshot and returns the reduced usage", () => {
  withRoot((root) => {
    const store = PatchStore.open(join(root, "state"));
    const changeId = "c_" + "3".repeat(16);
    store.writeBackup(changeId, "x".repeat(400), "y".repeat(400), ".github/workflows/ci.yml", NOW);
    assert.deepEqual(store.usage(), deepUsage(store.root));
    store.removeBackup(changeId);
    assert.equal(existsSync(join(store.root, "backups", changeId)), false);
    assert.deepEqual(store.usage(), deepUsage(store.root));
  });
});

test("quota refusal stays exact at the byte limit", () => {
  withRoot((root) => {
    const state = join(root, "state");
    const probe = PatchStore.open(state);
    const binding = createLocalBinding(root, "2026-10-20T00:00:00Z", { repositoryFullName: "owner/repo" }).binding;
    const text = JSON.stringify(binding, null, 2) + "\n";
    const limit = probe.usage().bytes + Buffer.byteLength(text, "utf8");
    const store = PatchStore.open(state, limits({ storeMaxBytes: limit }));
    store.saveBinding(binding);
    assert.equal(store.usage().bytes, limit);
    assert.throws(() => store.ensureCapacity(1), StoreQuotaError);
    assert.throws(() => store.saveChange(change(9)), StoreQuotaError);
    assert.deepEqual(store.usage(), deepUsage(store.root));
  });
});
