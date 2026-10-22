import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PatchStore } from "../../src/core/patch/store.ts";

const posix = process.platform === "win32" ? { skip: "POSIX file modes are not exposed on Windows" } : {};
const MANAGED = [
  "bindings", "reports", "plans", "attestations", "backups", "changes", "events", "snapshots", "snapshots/history",
];

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

function withRoot<T>(run: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-modes-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("opens the store root and every managed directory as 0700", posix, () => {
  withRoot((root) => {
    const store = PatchStore.open(join(root, "nested", "state"));
    assert.equal(modeOf(store.root), 0o700, store.root);
    for (const directory of MANAGED) assert.equal(modeOf(join(store.root, directory)), 0o700, directory);
  });
});

test("tightens pre-existing store directories that were created world-readable", posix, () => {
  withRoot((root) => {
    const state = join(root, "state");
    mkdirSync(join(state, "reports"), { recursive: true });
    chmodSync(state, 0o755);
    chmodSync(join(state, "reports"), 0o755);
    const store = PatchStore.open(state);
    assert.equal(modeOf(state), 0o700);
    assert.equal(modeOf(join(store.root, "reports")), 0o700);
  });
});

test("writes backups, manifests, and the event log as 0600", posix, () => {
  withRoot((root) => {
    const store = PatchStore.open(join(root, "state"));
    const changeId = "c_" + "3".repeat(16);
    store.writeBackup(changeId, "before: 1\n", "after: 1\n", ".github/workflows/ci.yml", new Date("2026-10-20T00:00:00Z"));
    const directory = join(store.root, "backups", changeId);
    for (const name of ["before.yml", "after.yml", "manifest.json"]) assert.equal(modeOf(join(directory, name)), 0o600, name);
    store.appendEvent({ type: "test" }, new Date("2026-10-20T00:00:00Z"));
    assert.equal(modeOf(join(store.root, "events", "events.jsonl")), 0o600);
    for (const name of ["before.yml", "after.yml", "manifest.json"]) assert.equal(existsSync(join(directory, name + ".tmp")), false);
  });
});

test("repairs a legacy world-readable record on the next write instead of preserving its mode", posix, () => {
  withRoot((root) => {
    const store = PatchStore.open(join(root, "state"));
    const log = join(store.root, "events", "events.jsonl");
    writeFileSync(log, "", "utf8");
    chmodSync(log, 0o644);
    store.appendEvent({ type: "test" }, new Date("2026-10-20T00:00:00Z"));
    assert.equal(modeOf(log), 0o600);
    const changeId = "c_" + "4".repeat(16);
    const directory = join(store.root, "backups", changeId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "before.yml"), "old", "utf8");
    chmodSync(join(directory, "before.yml"), 0o644);
    store.writeBackup(changeId, "before: 2\n", "after: 2\n", ".github/workflows/ci.yml", new Date("2026-10-20T00:00:00Z"));
    assert.equal(modeOf(join(directory, "before.yml")), 0o600);
  });
});
