import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireStoreLock, withStoreWriteLock } from "../../src/core/patch/locks.ts";
import { appliedBackupConfirmToken, PatchStore, StoreCorruptionError, StoreQuotaError } from "../../src/core/patch/store.ts";
import type { AnalysisReport, AppliedChange, RepositoryBinding } from "../../src/core/contracts/schema.ts";
import type { HistoryBundle, HistoryPull } from "../../src/core/history/model.ts";
import { buildCoverage } from "../../src/core/analysis/coverage.ts";
import { buildHistoryReport } from "../../src/core/analysis/report.ts";
import { DEFAULT_CONFIG } from "../../src/core/data/default-config.ts";
import { createLocalBinding } from "../../src/core/scan/binding.ts";
import { isolatedEnv } from "../helpers/test-env.ts";
import type { DocumentKind } from "../../src/core/contracts/validate.ts";

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

function reportFor(binding: RepositoryBinding, snapshot: HistoryBundle): AnalysisReport {
  return buildHistoryReport({
    binding,
    workflows: [],
    history: snapshot,
    config: DEFAULT_CONFIG,
    generatedAt: snapshot.requestedTo,
  }).report;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2) + "\n", "utf8");
}

test("different history reports at the same timestamp retain distinct addressable ids", () => {
  withRoot((root) => {
    const binding = createLocalBinding(root, NOW.toISOString(), { repositoryFullName: "owner/repo" }).binding;
    const snapshot = (durationMillis: number): HistoryBundle => ({
      ...history(NOW.toISOString()),
      runs: [{
        runId: "42", workflowPath: ".github/workflows/ci.yml", workflowName: "CI", headSha: "a".repeat(40),
        headBranch: "main", event: "push", createdAt: NOW.toISOString(), attempt: 1, conclusion: "success",
        pullRequestNumbers: [], definition: null, definitionResolution: "unresolved",
        jobs: [{ jobId: "7", runId: "42", attempt: 1, name: "test", workflowPath: ".github/workflows/ci.yml",
          conclusion: "success", startedAt: NOW.toISOString(), completedAt: new Date(NOW.getTime() + durationMillis).toISOString(),
          durationMillis, labels: ["ubuntu-latest"], runnerName: null, sku: "actions_linux" }],
      }],
    });
    const first = reportFor(binding, snapshot(60_001));
    const second = reportFor(binding, snapshot(120_001));
    assert.equal(first.metrics.observedRunnerSeconds.value, 60);
    assert.equal(second.metrics.observedRunnerSeconds.value, 120);
    const store = PatchStore.open(join(root, "state"));
    store.saveReport(first);
    store.saveReport(second);
    assert.equal(store.readReport(first.reportId)?.metrics.observedRunnerSeconds.value, 60, "saving new observations must not overwrite the older report");
    assert.notEqual(first.reportId, second.reportId);
    assert.equal(store.readReport(second.reportId)?.metrics.observedRunnerSeconds.value, 120);
    assert.equal(reportFor(binding, snapshot(60_001)).reportId, first.reportId, "identical content keeps a deterministic id");
    const changedCoverage = reportFor(binding, { ...snapshot(60_001), apiVersion: "different-api-version" });
    assert.notEqual(changedCoverage.reportId, first.reportId, "coverage changes must also distinguish reports");
  });
});

function withRoot<T>(run: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-quota-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const generation of [false, true]) {
  test("history preserves pull requests after reopening " + (generation ? "a generation" : "a legacy-path snapshot"), () => {
    withRoot((root) => {
      const state = join(root, "state");
      const store = PatchStore.open(state);
      const binding = createLocalBinding(root, NOW.toISOString(), { repositoryFullName: "owner/repo" }).binding;
      const pulls = new Map<number, HistoryPull>([
        [7, { number: 7, baseBranch: "main", headBranch: "docs", files: ["README.md", "docs/notes/한글.md"] }],
        [8, { number: 8, baseBranch: "main", headBranch: "feature", files: null }],
      ]);
      const snapshot = { ...history(NOW.toISOString()), pulls };
      if (generation) store.saveHistorySnapshot(binding, snapshot, reportFor(binding, snapshot));
      else store.saveHistory(binding.bindingId, snapshot);
      const loaded = PatchStore.open(state).readLatestHistory(binding.bindingId);
      assert.ok(loaded);
      assert.ok(loaded.pulls instanceof Map, "the storage boundary must restore the runtime Map");
      assert.equal(loaded.pulls.size, 2);
      assert.deepEqual([...loaded.pulls], [...pulls]);
      const analyze = (value: HistoryBundle) => buildHistoryReport({ binding, workflows: [], history: value,
        config: DEFAULT_CONFIG, generatedAt: snapshot.requestedTo, enabledRules: ["CD003"] }).report;
      assert.deepEqual(analyze(loaded), analyze(snapshot), "reanalysis uses the same pull-request evidence");
    });
  });
}

test("legacy lost pull requests remain readable but require a fresh sync for complete evidence", () => {
  withRoot((root) => {
    const store = PatchStore.open(join(root, "state"));
    const bindingId = "b_legacy_pulls";
    const base = history(NOW.toISOString());
    const pulls = new Map<number, HistoryPull>([[7, { number: 7, baseBranch: "main", headBranch: "docs", files: ["README.md"] }]]);
    const snapshot = { ...base, pulls, coverage: { ...base.coverage,
      changedFiles: { ...base.coverage.changedFiles, status: "complete" as const, fetched: 1, expected: 1, reasons: [] },
    } };
    const path = join(store.root, "snapshots", "history", bindingId + ".json");
    const oldBytes = JSON.stringify(snapshot);
    writeFileSync(path, oldBytes);
    const loaded = store.readLatestHistory(bindingId);
    assert.ok(loaded);
    assert.equal(loaded.pulls.size, 0);
    assert.equal(loaded.coverage.changedFiles.status, "unavailable");
    assert.ok(loaded.coverage.changedFiles.reasons.includes("LEGACY_PULLS_UNAVAILABLE"));
    assert.equal(readFileSync(path, "utf8"), oldBytes, "reading never rewrites old evidence");
    store.saveHistory(bindingId, snapshot);
    const refreshed = store.readLatestHistory(bindingId)!;
    assert.deepEqual([...refreshed.pulls], [...pulls]);
    assert.equal(refreshed.coverage.changedFiles.status, "complete");
  });
});

test("malformed pull request entries fail closed without deleting the stored evidence", () => {
  withRoot((root) => {
    const store = PatchStore.open(join(root, "state"));
    const path = join(store.root, "snapshots", "history", "b_bad_pulls.json");
    const pull = { number: 7, baseBranch: "main", headBranch: "private-marker", files: ["README.md"] };
    for (const pulls of [null, [[7]], [[7, pull], [7, pull]], [[8, pull]], [[7, { ...pull, files: [123] }]], [[1.5, pull]]]) {
      const contents = JSON.stringify({ ...history(NOW.toISOString()), pulls });
      writeFileSync(path, contents);
      assert.throws(() => store.readLatestHistory("b_bad_pulls"), (error: unknown) => {
        assert.ok(error instanceof StoreCorruptionError);
        assert.doesNotMatch(error.message, /private-marker/);
        return true;
      });
      assert.equal(readFileSync(path, "utf8"), contents);
    }
  });
});

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

test("a stale usage snapshot cannot admit a second process write", () => {
  withRoot((root) => {
    const snapshot = history("2026-10-20T00:00:00Z");
    const limit = jsonBytes(snapshot) * 2 - 1;
    const first = PatchStore.open(join(root, "state"), limits({ storeMaxBytes: limit }));
    const second = PatchStore.open(join(root, "state"), limits({ storeMaxBytes: limit }));
    // This instance caches the empty store; the other process then fills it.
    second.usage();
    assert.equal(first.saveHistory("b_" + "1".repeat(24), snapshot), true);
    assert.throws(
      () => second.saveHistory("b_" + "2".repeat(24), snapshot),
      (error: unknown) => error instanceof StoreQuotaError,
    );
  });
});

test("a failed report write leaves the previous generation committed", () => {
  withRoot((root) => {
    const state = join(root, "state");
    const store = PatchStore.open(state);
    const binding = createLocalBinding(root, "2026-10-20T00:00:00Z", { repositoryFullName: "owner/repo" }).binding;
    const first = history("2026-10-20T02:00:00Z");
    const firstReport = reportFor(binding, first);
    assert.equal(store.saveHistorySnapshot(binding, first, firstReport), true);
    const before = store.usage();

    const nextBinding = createLocalBinding(root, "2026-10-21T00:00:00Z", { repositoryFullName: "owner/repo" }).binding;
    const next = history("2026-10-21T00:00:00Z");
    const nextReport = reportFor(nextBinding, next);
    const additional = jsonBytes(nextBinding) + jsonBytes(next) + jsonBytes(nextReport);
    const limited = PatchStore.open(state, limits({ storeMaxBytes: before.bytes + additional - 1 }));
    assert.throws(
      () => limited.saveHistorySnapshot(nextBinding, next, nextReport),
      (error: unknown) => error instanceof StoreQuotaError,
    );

    assert.equal(limited.readLatestHistory(binding.bindingId)?.requestedTo, first.requestedTo);
    assert.equal(limited.readBinding(binding.bindingId)?.createdAt, binding.createdAt);
    assert.equal(limited.findBindingByRoot(root)?.createdAt, binding.createdAt);
    assert.equal(limited.latestReportForBinding(binding.bindingId)?.reportId, firstReport.reportId);
    assert.equal(limited.latestReport()?.reportId, firstReport.reportId);
    assert.equal(limited.readReport(firstReport.reportId)?.reportId, firstReport.reportId);
    assert.equal(limited.readReport(nextReport.reportId), null);
    assert.equal(readdirSync(join(state, "snapshots", "generations", binding.bindingId)).length, 1);
  });
});

test("readReport resolves a report kept by an earlier generation", () => {
  withRoot((root) => {
    const store = PatchStore.open(join(root, "state"));
    const binding = createLocalBinding(root, "2026-10-20T00:00:00Z", { repositoryFullName: "owner/repo" }).binding;
    const first = history("2026-10-20T01:00:00Z");
    const firstReport = reportFor(binding, first);
    assert.equal(store.saveHistorySnapshot(binding, first, firstReport), true);
    const second = history("2026-10-20T02:00:00Z");
    const secondReport = reportFor(binding, second);
    assert.equal(store.saveHistorySnapshot(binding, second, secondReport), true);
    const third = history("2026-10-20T03:00:00Z");
    const thirdReport = reportFor(binding, third);
    assert.equal(store.saveHistorySnapshot(binding, third, thirdReport), true);
    // Report retention is measured in days, not in the number of syncs.
    assert.equal(store.readReport(firstReport.reportId)?.reportId, firstReport.reportId);
    assert.equal(store.readReport(secondReport.reportId)?.reportId, secondReport.reportId);
    assert.equal(store.readReport(thirdReport.reportId)?.reportId, thirdReport.reportId);
  });
});

test("prune removes expired generation reports and their pointers", () => {
  withRoot((root) => {
    const state = join(root, "state");
    const store = PatchStore.open(state);
    const binding = createLocalBinding(root, "2026-01-01T00:00:00Z", { repositoryFullName: "owner/repo" }).binding;
    const first = history("2026-01-01T01:00:00Z");
    assert.equal(store.saveHistorySnapshot(binding, first, reportFor(binding, first)), true);
    const second = history("2026-01-02T01:00:00Z");
    const secondReport = reportFor(binding, second);
    assert.equal(store.saveHistorySnapshot(binding, second, secondReport), true);
    const before = store.usage().bytes;

    const result = store.prune(new Date("2027-01-01T00:00:00Z"), { reportDays: 90, planDays: 7, cacheDays: 30 });
    assert.equal(result.removedReports, 2);
    assert.ok(result.bytesFreed > 0, String(result.bytesFreed));
    assert.equal(existsSync(join(state, "snapshots", "current", binding.bindingId + ".json")), false);
    assert.equal(store.readLatestHistory(binding.bindingId), null);
    assert.equal(store.readReport(secondReport.reportId), null);
    // Revert still needs the binding after its report generation expired.
    assert.equal(store.readBinding(binding.bindingId)?.bindingId, binding.bindingId);
    assert.equal(store.findBindingByRoot(root)?.bindingId, binding.bindingId);
    assert.ok(store.usage().bytes < before, "prune frees generation bytes");
  });
});

for (const defect of ["invalid JSON", "invalid schema", "bindingId", "repositoryId", "workspaceRoot", "rootIdentityHash"] as const) {
  test("prune retains recovery generations when the existing binding has " + defect, () => {
    withRoot((root) => {
      const store = PatchStore.open(join(root, "state"));
      const binding = createLocalBinding(root, NOW.toISOString(), { repositoryFullName: "owner/repo" }).binding;
      const snapshot = history(NOW.toISOString());
      const report = reportFor(binding, snapshot);
      store.saveHistorySnapshot(binding, snapshot, report);
      const target = join(store.root, "bindings", binding.bindingId + ".json");
      const contents = defect === "invalid JSON" ? "{"
        : defect === "invalid schema" ? "{}"
        : JSON.stringify({ ...binding, [defect]: defect === "rootIdentityHash" ? HASH : "other-repository" });
      writeFileSync(target, contents);
      const pointerPath = join(store.root, "snapshots", "current", binding.bindingId + ".json");
      const pointerBytes = readFileSync(pointerPath, "utf8");
      const pointer = JSON.parse(pointerBytes) as { generationId: string };
      const directory = join(store.root, "snapshots", "generations", binding.bindingId, pointer.generationId);
      const before = ["binding.json", "history.json", "report.json"].map((file) => readFileSync(join(directory, file), "utf8"));
      const pruned = store.prune(new Date("2030-01-01T00:00:00Z"), { reportDays: 90, planDays: 7, cacheDays: 30 });
      assert.equal(pruned.removedReports, 0, "a file's existence is not proof that recovery metadata was preserved");
      assert.equal(pruned.bytesFreed, 0);
      assert.equal(readFileSync(target, "utf8"), contents, "prune must not overwrite invalid evidence");
      assert.equal(readFileSync(pointerPath, "utf8"), pointerBytes);
      assert.deepEqual(["binding.json", "history.json", "report.json"].map((file) => readFileSync(join(directory, file), "utf8")), before);
      assert.equal(store.readReport(report.reportId)?.reportId, report.reportId);
      // Once the operator removes the bad legacy record, the retained snapshot
      // still supplies the original binding needed by revert.
      rmSync(target);
      assert.equal(store.readBinding(binding.bindingId)?.workspaceRoot, binding.workspaceRoot);
    });
  });
}

test("latestReport trusts a valid index without scanning unrelated records", () => {
  withRoot((root) => {
    const store = PatchStore.open(join(root, "state"));
    const binding = createLocalBinding(root, "2026-10-20T00:00:00Z", { repositoryFullName: "owner/repo" }).binding;
    const report = reportFor(binding, history("2026-10-20T01:00:00Z"));
    store.saveReport(report);
    // A valid pointer must answer without reading every report; a corrupt
    // unrelated record would throw if the scan still ran.
    writeFileSync(join(store.root, "reports", "broken.json"), "{", "utf8");
    assert.equal(store.latestReport()?.reportId, report.reportId);
    assert.equal(store.latestReportForBinding(binding.bindingId)?.reportId, report.reportId);
  });
});

test("workspace binding lookup reads payloads only for matching snapshot roots", (t) => {
  withRoot((root) => {
    const store = PatchStore.open(join(root, "state"));
    const bindings = Array.from({ length: 8 }, (_, i) => {
      const directory = join(root, "repo-" + i);
      mkdirSync(directory);
      const binding = createLocalBinding(directory, NOW.toISOString(), { repositoryFullName: "owner/repo-" + i }).binding;
      const snapshot = history(NOW.toISOString());
      store.saveHistorySnapshot(binding, snapshot, reportFor(binding, snapshot));
      return binding;
    });
    const reader = store as unknown as { readJson(path: string, kind?: DocumentKind): unknown };
    const read = reader.readJson.bind(store);
    const payloadReads: string[] = [];
    t.mock.method(reader, "readJson", (path: string, kind?: DocumentKind) => {
      if (/[\\/](history|report)\.json$/.test(path)) payloadReads.push(path);
      return read(path, kind);
    });
    const target = bindings[3]!;
    assert.equal(store.findBindingByRoot(target.workspaceRoot)?.bindingId, target.bindingId);
    t.diagnostic("history/report payload reads for 8 repositories: " + payloadReads.length);
    assert.equal(payloadReads.length, 2, "only the matching snapshot's history and report are needed");

    const generation = (binding: RepositoryBinding) => {
      const pointer = JSON.parse(readFileSync(join(store.root, "snapshots", "current", binding.bindingId + ".json"), "utf8")) as { generationId: string };
      return join(store.root, "snapshots", "generations", binding.bindingId, pointer.generationId);
    };
    writeFileSync(join(generation(bindings[7]!), "history.json"), "{");
    writeFileSync(join(generation(bindings[7]!), "report.json"), "{");
    assert.equal(store.findBindingByRoot(target.workspaceRoot)?.bindingId, target.bindingId, "unrelated corruption cannot block the lookup");
    writeFileSync(join(generation(target), "history.json"), "{");
    assert.throws(() => store.findBindingByRoot(target.workspaceRoot), StoreCorruptionError, "matching snapshot validation stays mandatory");
    writeFileSync(join(generation(target), "history.json"), JSON.stringify(history(NOW.toISOString())));
    writeFileSync(join(generation(target), "report.json"), "{");
    assert.throws(() => store.findBindingByRoot(target.workspaceRoot), StoreCorruptionError, "matching report validation stays mandatory");
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
    // The usage snapshot is per instance and is only rescanned on open or after
    // one second, so a fresh instance is what observes files written out of band.
    const reopened = PatchStore.open(join(root, "state"), limits({ storeMaxBytes: 22000 }));
    const blocked = reopened.storageStatus();
    assert.equal(blocked.blocked, true);
    assert.throws(() => reopened.ensureCapacity(1), StoreQuotaError);
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

test("cache pruning counts nested bytes and reads cache metadata once", (t) => {
  withRoot((root) => {
    const store = PatchStore.open(join(root, "state"));
    const cache = join(store.root, "cache");
    const expired = join(cache, "expired");
    mkdirSync(expired, { recursive: true });
    writeFileSync(join(expired, "first.bin"), Buffer.alloc(700));
    writeFileSync(join(expired, "second.bin"), Buffer.alloc(800));
    const old = join(cache, "old.bin"), recent = join(cache, "recent.bin");
    writeFileSync(old, Buffer.alloc(900));
    writeFileSync(recent, Buffer.alloc(900));
    const setAge = (path: string, days: number) => {
      const at = new Date(NOW.getTime() - days * 86_400_000);
      utimesSync(path, at, at);
    };
    setAge(expired, 40);
    setAge(old, 2);
    setAge(recent, 1);
    let listings = 0, retainedStats = 0;
    const originalRead = fs.readdirSync, originalStat = fs.lstatSync;
    t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
      if (args[0] === cache) listings += 1;
      return originalRead(...args);
    });
    t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
      if (args[0] === old || args[0] === recent) retainedStats += 1;
      return originalStat(...args);
    });
    syncBuiltinESMExports();
    try {
      const result = store.prune(NOW, { reportDays: 90, planDays: 7, cacheDays: 30, cacheMaxBytes: 1000 });
      t.diagnostic(JSON.stringify({ bytesFreed: result.bytesFreed, listings, retainedStats }));
      assert.equal(result.bytesFreed, 2400, "1500 expired bytes plus the oldest 900-byte entry");
      assert.equal(result.removedCacheEntries, 2);
      assert.equal(listings, 1, "age and capacity eviction share one directory listing");
      assert.equal(retainedStats, 2, "each retained file is statted once");
      assert.equal(existsSync(expired), false);
      assert.equal(existsSync(old), false);
      assert.equal(existsSync(recent), true);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
});

test("prune never enters a cache root redirected outside the store", () => {
  withRoot((root) => {
    const store = PatchStore.open(join(root, "state"));
    const external = join(root, "external");
    mkdirSync(external);
    const file = join(external, "keep.bin");
    writeFileSync(file, Buffer.alloc(16));
    const expired = new Date(NOW.getTime() - 40 * 86_400_000);
    utimesSync(file, expired, expired);
    fs.symlinkSync(external, join(store.root, "cache"), process.platform === "win32" ? "junction" : "dir");
    const result = store.prune(NOW, { reportDays: 90, planDays: 7, cacheDays: 30, cacheMaxBytes: 10 });
    assert.equal(existsSync(file), true, "external files must never be deleted through the cache root");
    assert.equal(result.removedCacheEntries, 0);
    assert.equal(result.bytesFreed, 0);
  });
});

test("cache capacity ignores linked external bytes and preserves in-budget cache files", () => {
  withRoot((root) => {
    const store = PatchStore.open(join(root, "state"));
    const cache = join(store.root, "cache"), external = join(root, "external");
    mkdirSync(cache);
    mkdirSync(external);
    const kept = join(cache, "kept.bin"), linked = join(cache, "external");
    writeFileSync(kept, Buffer.alloc(8));
    writeFileSync(join(external, "outside.bin"), Buffer.alloc(16));
    utimesSync(kept, new Date(NOW.getTime() - 86_400_000), new Date(NOW.getTime() - 86_400_000));
    utimesSync(external, NOW, NOW);
    fs.symlinkSync(external, linked, process.platform === "win32" ? "junction" : "dir");
    const result = store.prune(NOW, { reportDays: 90, planDays: 7, cacheDays: 3650, cacheMaxBytes: 10 });
    assert.equal(existsSync(kept), true, "8 owned bytes fit in the 10-byte cache cap");
    assert.equal(result.bytesFreed, 0, "external bytes are never counted as reclaimed store space");
    assert.equal(result.removedCacheEntries, 0);
    assert.equal(readFileSync(join(external, "outside.bin")).length, 16);
  });
});

test("cache size walks do not follow cyclic links inside directories", (t) => {
  withRoot((root) => {
    const store = PatchStore.open(join(root, "state"));
    const directory = join(store.root, "cache", "entry");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "owned.bin"), Buffer.alloc(8));
    fs.symlinkSync(directory, join(directory, "loop"), process.platform === "win32" ? "junction" : "dir");
    let listings = 0;
    const original = fs.readdirSync;
    t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
      if (String(args[0]).startsWith(directory)) {
        listings += 1;
        if (listings > 8) throw new Error("test stopped a cyclic size walk");
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      const result = store.prune(NOW, { reportDays: 90, planDays: 7, cacheDays: 3650, cacheMaxBytes: 10 });
      assert.equal(listings, 1, "a linked subtree is not enumerated again");
      assert.equal(result.bytesFreed, 0);
      assert.equal(existsSync(directory), true);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
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
