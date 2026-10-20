import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PatchStore } from "../../src/core/patch/store.ts";
import { runStaticScan } from "../../src/core/scan/scan.ts";

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
