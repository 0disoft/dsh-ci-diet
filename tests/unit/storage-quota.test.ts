import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireStoreLock, withStoreWriteLock } from "../../src/core/patch/locks.ts";
import { appliedBackupConfirmToken, PatchStore, StoreQuotaError } from "../../src/core/patch/store.ts";
import type { AppliedChange } from "../../src/core/contracts/schema.ts";
import type { HistoryBundle } from "../../src/core/history/model.ts";
import { buildCoverage } from "../../src/core/analysis/coverage.ts";
import { buildHistoryReport } from "../../src/core/analysis/report.ts";
import { DEFAULT_CONFIG } from "../../src/core/data/default-config.ts";
import { createLocalBinding } from "../../src/core/scan/binding.ts";
import { isolatedEnv } from "../helpers/test-env.ts";

const CLI = join(import.meta.dirname, "..", "..", "src", "cli", "index.ts");
const HASH = "sha256:" + "a".repeat(64);
const NOW = new Date("2026-10-20T00:00:00Z");

function limits(overrides: Partial<{ storeMaxBytes: number; warningPercent: number; cacheMaxBytes: number; pruneAppliedBackups: boolean }> = {}) {
  return { storeMaxBytes: 0, warningPercent: 80, cacheMaxBytes: 0, pruneAppliedBackups: false, ...overrides };
}

function change(changeId: string, state: AppliedChange["state"]): AppliedChange {
  return {
    schemaVersion: 2,
    provenance: "observed",
    changeId,
    bindingId: "b_" + "1".repeat(24),
    planId: "p_" + "2".repeat(24),
    planDigest: HASH,
    workflowPath: ".github/workflows/ci.yml",
    state,
    before: { path: "C:/repo/.github/workflows/ci.yml", hash: HASH, bytes: 1 },
    after: { path: "C:/repo/.github/workflows/ci.yml", hash: HASH, bytes: 1 },
    approvalChannel: "human-cli",
    approvalReference: "nonce-1",
    updatedAt: "2026-10-20T00:00:00Z",
  };
}

function history(requestedTo: string): HistoryBundle {
  return {
    repositoryId: "git:" + "a".repeat(32),
    repositoryFullName: "owner/repo",
    defaultBranch: "main",
    requestedFrom: "2026-10-01T00:00:00Z",
    requestedTo,
    runs: [],
    pulls: new Map(),
    workflows: [],
    artifacts: [],
    retention: null,
    protection: null,
    coverage: buildCoverage({ apiVersion: "2026-03-10", ghVersion: "gh 2", requestedFrom: "2026-10-01T00:00:00Z", requestedTo }, {}),
    missingScopes: [],
  };
}

function withRoot<T>(run: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-quota-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("an older overlapping sync cannot publish a partial snapshot", () => {
  withRoot((root) => {
    const store = PatchStore.open(join(root, "state"));
    const binding = createLocalBinding(root, "2026-10-20T00:00:00Z", { repositoryFullName: "owner/repo" }).binding;
    const newer = history("2026-10-20T02:00:00Z");
    const older = history("2026-10-20T01:00:00Z");
    const reportFor = (snapshot: HistoryBundle) => buildHistoryReport({
      binding,
      workflows: [],
      history: snapshot,
      config: DEFAULT_CONFIG,
      generatedAt: snapshot.requestedTo,
    }).report;
    assert.equal(store.saveHistorySnapshot(binding, newer, reportFor(newer)), true);
    assert.equal(store.saveHistorySnapshot(binding, older, reportFor(older)), false);
    assert.equal(store.readLatestHistory(binding.bindingId)?.requestedTo, newer.requestedTo);
  });
});

test("refuses a backup write that would cross the store quota and leaves no directory behind", () => {
  withRoot((root) => {
    const store = PatchStore.open(join(root, "state"), limits({ storeMaxBytes: 2048 }));
    const big = "a".repeat(4096);
    assert.throws(
      () => store.writeBackup("c_" + "3".repeat(16), big, big, ".github/workflows/ci.yml", NOW),
      (error: unknown) => error instanceof StoreQuotaError && /STORAGE_QUOTA_EXCEEDED/.test((error as Error).message),
    );
    assert.equal(existsSync(join(store.root, "backups", "c_" + "3".repeat(16))), false);
  });
});

test("the store write lock excludes a second writer until it is released", () => {
  withRoot((root) => {
    const store = PatchStore.open(join(root, "state"), limits());
    withStoreWriteLock(store, () => {
      assert.throws(
        () => acquireStoreLock(store, "write", 0),
        /another ci-diet process is updating the same record/,
      );
    });
    const lock = acquireStoreLock(store, "write", 0);
    lock.release();
  });
});

test("reports a warning near the quota and a block once usage reaches it", () => {
  withRoot((root) => {
    const store = PatchStore.open(join(root, "state"), limits({ storeMaxBytes: 22000 }));
    store.writeBackup("c_" + "4".repeat(16), "x".repeat(9000), "y".repeat(9000), ".github/workflows/ci.yml", NOW);
    const warning = store.storageStatus();
    assert.equal(warning.warning, true);
    assert.equal(warning.blocked, false);
    assert.ok(warning.percent >= 80, String(warning.percent));
    mkdirSync(join(store.root, "cache"), { recursive: true });
    writeFileSync(join(store.root, "cache", "filler.bin"), Buffer.alloc(22000));
    const blocked = store.storageStatus();
    assert.equal(blocked.blocked, true);
    assert.throws(() => store.ensureCapacity(1), StoreQuotaError);
  });
});

test("an older history snapshot cannot replace a newer one", () => {
  withRoot((root) => {
    const store = PatchStore.open(join(root, "state"), limits());
    const bindingId = "b_" + "1".repeat(24);
    const older = history("2026-10-20T00:00:00Z");
    const newer = history("2026-10-21T00:00:00Z");
    assert.equal(store.saveHistory(bindingId, older), true);
    assert.equal(store.saveHistory(bindingId, newer), true);
    assert.equal(store.saveHistory(bindingId, older), false);
    assert.equal(store.readLatestHistory(bindingId)?.requestedTo, newer.requestedTo);
    assert.equal(store.saveHistory(bindingId, history(newer.requestedTo)), true);
  });
});

test("prune evicts the oldest cache entries when the cache cap is exceeded", () => {
  withRoot((root) => {
    const store = PatchStore.open(join(root, "state"));
    const cache = join(store.root, "cache");
    mkdirSync(cache, { recursive: true });
    const entries = ["oldest", "middle", "newest"];
    for (let index = 0; index < entries.length; index += 1) {
      const file = join(cache, entries[index]!);
      writeFileSync(file, "z".repeat(600));
      const at = new Date(NOW.getTime() - (3 - index) * 60_000);
      utimesSync(file, at, at);
    }
    const result = store.prune(NOW, { reportDays: 90, planDays: 7, cacheDays: 3650, cacheMaxBytes: 1000 });
    assert.equal(result.removedCacheEntries, 2);
    assert.equal(result.bytesFreed, 1200);
    assert.deepEqual(existsSync(join(cache, "oldest")), false);
    assert.deepEqual(existsSync(join(cache, "middle")), false);
    assert.deepEqual(existsSync(join(cache, "newest")), true);
  });
});

test("lists only settled backups and deletes them only with the exact listing token", () => {
  withRoot((root) => {
    const store = PatchStore.open(join(root, "state"));
    const appliedId = "c_" + "5".repeat(16);
    const preparingId = "c_" + "6".repeat(16);
    store.saveChange(change(appliedId, "APPLIED"));
    store.saveChange(change(preparingId, "RECOVERY_REQUIRED"));
    for (const id of [appliedId, preparingId]) {
      store.writeBackup(id, "before\n", "after\n", ".github/workflows/ci.yml", NOW);
    }
    const candidates = store.appliedBackupCandidates();
    assert.deepEqual(candidates.map((candidate) => candidate.changeId), [appliedId]);
    assert.ok(candidates[0]!.bytes > 0);
    const token = appliedBackupConfirmToken(candidates);
    assert.throws(() => store.pruneAppliedBackups([appliedId], "wrong"), /STORAGE_BACKUP_TOKEN_MISMATCH/);
    assert.throws(() => store.pruneAppliedBackups(["c_" + "7".repeat(16)], token), /STORAGE_BACKUP_NOT_SETTLED/);
    const cleanup = store.pruneAppliedBackups([appliedId], token);
    assert.equal(cleanup.removedBackups, 1);
    assert.equal(existsSync(join(store.root, "backups", appliedId)), false);
    assert.equal(existsSync(join(store.root, "backups", preparingId)), true);
    assert.deepEqual(store.appliedBackupCandidates(), []);
  });
});

test("a changed backup invalidates the confirmation token", () => {
  withRoot((root) => {
    const store = PatchStore.open(join(root, "state"));
    const appliedId = "c_" + "9".repeat(16);
    store.saveChange(change(appliedId, "APPLIED"));
    store.writeBackup(appliedId, "before\n", "after\n", ".github/workflows/ci.yml", NOW);
    const token = appliedBackupConfirmToken(store.appliedBackupCandidates());
    const manifestPath = join(store.root, "backups", appliedId, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.createdAt = "2026-10-21T00:00:00Z";
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    assert.throws(() => store.pruneAppliedBackups([appliedId], token), /STORAGE_BACKUP_TOKEN_MISMATCH/);
    assert.equal(existsSync(join(store.root, "backups", appliedId)), true);
  });
});

test("prune --applied-backups lists a token, refuses a stale token, then deletes on confirmation", () => {
  withRoot((root) => {
    const stateDir = join(root, "state");
    const store = PatchStore.open(stateDir);
    const appliedId = "c_" + "8".repeat(16);
    store.saveChange(change(appliedId, "APPLIED"));
    store.writeBackup(appliedId, "before\n", "after\n", ".github/workflows/ci.yml", NOW);
    const env = isolatedEnv();
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, "prune", "--state-dir", stateDir, ...args], { encoding: "utf8", env, timeout: 15000 });
    const listed = run("--applied-backups");
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(appliedId));
    assert.match(listed.stdout, /--applied-backups --confirm/);
    const json = run("--applied-backups", "--json");
    assert.equal(json.status, 0, json.stderr);
    const payload = JSON.parse(json.stdout) as { token: string; candidates: { changeId: string }[] };
    assert.equal(payload.candidates.length, 1);
    assert.equal(payload.token, appliedBackupConfirmToken(store.appliedBackupCandidates()));
    const stale = run("--applied-backups", "--confirm", "deadbeef");
    assert.equal(stale.status, 1, stale.stderr);
    assert.match(stale.stderr, /token/i);
    assert.equal(existsSync(join(store.root, "backups", appliedId)), true);
    const confirmed = run("--applied-backups", "--confirm", payload.token);
    assert.equal(confirmed.status, 0, confirmed.stderr);
    assert.equal(existsSync(join(store.root, "backups", appliedId)), false);
  });
});
