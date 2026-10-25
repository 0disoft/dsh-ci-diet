import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildCoverage } from "../../src/core/analysis/coverage.ts";
import { buildHistoryReport } from "../../src/core/analysis/report.ts";
import { DEFAULT_CONFIG } from "../../src/core/data/default-config.ts";
import type { HistoryBundle } from "../../src/core/history/model.ts";
import { historyFromRecord, historyRecord, type HistoryRecord } from "../../src/core/history/storage.ts";
import { PatchStore, StoreCorruptionError } from "../../src/core/patch/store.ts";
import { createLocalBinding } from "../../src/core/scan/binding.ts";
import { parseWorkflow } from "../../src/core/workflow/parse.ts";

const NOW = "2026-10-25T00:00:00Z";
const PATH = ".github/workflows/ci.yml";
const SOURCE = "on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n"
  + Array.from({ length: 50 }, (_, i) => "      - run: echo task-" + i + "\n").join("");

function history(): HistoryBundle {
  return {
    repositoryId: "git:" + "a".repeat(32), repositoryFullName: "owner/repo", defaultBranch: "main",
    requestedFrom: "2026-10-01T00:00:00Z", requestedTo: NOW,
    // Parse separately, as sync does for definitions at different commits.
    runs: Array.from({ length: 100 }, (_, i) => ({
      runId: String(i + 1), workflowPath: PATH, workflowName: "CI", headSha: i.toString(16).padStart(40, "0"),
      headBranch: "main", event: "push", createdAt: NOW, attempt: 1, conclusion: "success",
      pullRequestNumbers: [7], jobs: [], definition: i === 99 ? null : parseWorkflow(PATH, SOURCE),
      definitionResolution: i === 99 ? "unresolved" : "resolved",
    })),
    pulls: new Map([[7, { number: 7, baseBranch: "main", headBranch: "docs", files: ["README.md"] }]]),
    workflows: [], artifacts: [], retention: null, protection: null,
    coverage: buildCoverage({ apiVersion: "2026-03-10", ghVersion: "gh 2", requestedFrom: "2026-10-01T00:00:00Z", requestedTo: NOW }, {}),
    missingScopes: [],
  };
}

const encode = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const decode = (text: string) => historyFromRecord(JSON.parse(text) as HistoryRecord);

test("history storage deduplicates equal definitions across commits without changing the bundle", (t) => {
  const original = history();
  const record = historyRecord(original);
  assert.ok("storageVersion" in record);
  assert.equal(record.definitions.length, 1);
  const restored = decode(encode(record));
  assert.deepEqual(restored, original);
  assert.equal(restored.runs[0]?.definition, restored.runs[98]?.definition);
  assert.equal(restored.runs[99]?.definition, null);
  const before = Buffer.byteLength(encode({ ...original, pulls: [...original.pulls] }));
  const after = Buffer.byteLength(encode(record));
  assert.ok(after < before / 10, `${after} must be less than 10% of ${before}`);
  t.diagnostic(`100 runs / 99 equal definitions: ${before} -> ${after} UTF-8 bytes`);
});

test("history definition indexing preserves different paths and parser metadata even with the same source hash", () => {
  const original = history();
  const runs = [...original.runs];
  runs[1] = { ...runs[1]!, definition: parseWorkflow(".github/workflows/other.yml", SOURCE) };
  runs[2] = { ...runs[2]!, definition: { ...runs[2]!.definition!, parseError: { message: "unavailable", line: null } } };
  const bundle = { ...original, runs };
  const record = historyRecord(bundle);
  assert.ok("storageVersion" in record);
  assert.equal(record.definitions.length, 3);
  assert.deepEqual(decode(encode(record)), bundle);
});

test("history storage still reads inline definitions and the old lost-Map format", () => {
  const original = history();
  assert.deepEqual(decode(encode({ ...original, pulls: [...original.pulls] })), original);
  const legacy = decode(encode({ ...original, pulls: {} }));
  assert.equal(legacy.pulls.size, 0);
  assert.equal(legacy.coverage.changedFiles.status, "unavailable");
  assert.ok(legacy.coverage.changedFiles.reasons.includes("LEGACY_PULLS_UNAVAILABLE"));
  const single = { ...original, runs: original.runs.slice(0, 1) };
  assert.equal("storageVersion" in historyRecord(single), false, "no table overhead when nothing repeats");
});

test("history storage refuses invalid dictionary references and unknown format versions", () => {
  const record = historyRecord(history());
  assert.ok("storageVersion" in record);
  for (const reference of [-1, 0.5, 1, "0", {}]) {
    const malformed = { ...record, runs: [{ ...record.runs[0], definition: reference }] };
    assert.throws(() => decode(encode(malformed)), /invalid workflow definition reference/);
  }
  assert.throws(() => decode(encode({ ...record, storageVersion: 3 })), /invalid history storage format/);
  assert.throws(() => decode(encode({ ...record, definitions: [null] })), /invalid workflow definition table/);
});

for (const generation of [false, true]) {
  test("indexed history survives reopening " + (generation ? "a generation" : "a standalone snapshot"), () => {
    const root = mkdtempSync(join(tmpdir(), "ci-diet-history-storage-"));
    try {
      const state = join(root, "state");
      const store = PatchStore.open(state, { storeMaxBytes: 128 * 1024, warningPercent: 80,
        cacheMaxBytes: 0, pruneAppliedBackups: false });
      const binding = createLocalBinding(root, NOW, { repositoryFullName: "owner/repo" }).binding;
      const original = history();
      assert.ok(Buffer.byteLength(encode({ ...original, pulls: [...original.pulls] })) > 128 * 1024,
        "the inline snapshot would exceed this store quota");
      const analyze = (bundle: HistoryBundle) => buildHistoryReport({ binding, workflows: [], history: bundle,
        config: DEFAULT_CONFIG, generatedAt: NOW }).report;
      if (generation) store.saveHistorySnapshot(binding, original, analyze(original));
      else store.saveHistory(binding.bindingId, original);
      const restored = PatchStore.open(state).readLatestHistory(binding.bindingId);
      assert.ok(restored);
      assert.deepEqual(restored, original);
      assert.deepEqual(analyze(restored), analyze(original));
      if (!generation) {
        const file = join(state, "snapshots", "history", binding.bindingId + ".json");
        const corrupt = JSON.parse(readFileSync(file, "utf8"));
        corrupt.runs[0].definition = -1;
        writeFileSync(file, encode(corrupt));
        assert.throws(() => PatchStore.open(state).readLatestHistory(binding.bindingId), StoreCorruptionError);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
