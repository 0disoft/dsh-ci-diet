import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PatchStore } from "../../src/core/patch/store.ts";
import { runStaticScan } from "../../src/core/scan/scan.ts";
import { isolatedEnv } from "../helpers/test-env.ts";

const cases = [
  { name: "fractional seconds", older: "2026-10-20T00:00:00Z", newer: "2026-10-20T00:00:00.500Z" },
  { name: "timezone offsets", older: "2026-10-20T10:00:00+09:00", newer: "2026-10-20T02:00:00Z" },
];

for (const scenario of cases) {
  for (const scoped of [false, true]) {
    test("selects the latest report by time with " + scenario.name + (scoped ? " within a binding" : " globally"), () => {
      const root = mkdtempSync(join(tmpdir(), "ci-diet-store-"));
      try {
        const store = PatchStore.open(join(root, "state"));
        const scan = runStaticScan({ workspaceRoot: root, generatedAt: scenario.older });
        store.saveBinding(scan.binding);
        const older = { ...scan.report, reportId: "r_" + "1".repeat(24) };
        const newer = { ...scan.report, reportId: "r_" + "2".repeat(24), generatedAt: scenario.newer };
        store.saveReport(older);
        store.saveReport(newer);
        if (scoped) {
          // A newer report from a different binding must not escape the scope filter.
          store.saveReport({
            ...scan.report,
            reportId: "r_" + "3".repeat(24),
            bindingId: "b_" + "3".repeat(24),
            generatedAt: "2026-10-21T00:00:00Z",
          });
        }
        const latest = scoped ? store.latestReportForBinding(scan.binding.bindingId) : store.latestReport();
        assert.equal(latest?.reportId, newer.reportId);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

for (const contents of ['{"private":"sensitive-marker",BROKEN', "null", "{}"] as const) {
  test("identifies a corrupt stored report without exposing contents: " + contents.slice(-6), () => {
    const root = mkdtempSync(join(tmpdir(), "ci-diet-store-"));
    try {
      const store = PatchStore.open(join(root, "state"));
      const file = join(store.root, "reports", "r_broken.json");
      writeFileSync(file, contents);
      const result = spawnSync(process.execPath, [
        join(import.meta.dirname, "../../src/cli/index.ts"),
        "report", "--state-dir", store.root, "--json",
      ], { encoding: "utf8", env: isolatedEnv(), timeout: 10000 });
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, "");
      assert.ok(result.stderr.includes(file), result.stderr);
      assert.match(result.stderr, /STATE_INVALID/);
      assert.doesNotMatch(result.stderr, /sensitive-marker|private/);
      assert.equal(readFileSync(file, "utf8"), contents);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("rejects a structurally corrupt plan while keeping absent records distinct", () => {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-store-"));
  try {
    const store = PatchStore.open(join(root, "state"));
    assert.equal(store.readPlan("p_missing"), null);
    assert.equal(store.readReport("r_missing"), null);
    writeFileSync(join(store.root, "plans", "p_broken.json"), "{}");
    assert.throws(() => store.readPlan("p_broken"), /STATE_INVALID.*p_broken\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
