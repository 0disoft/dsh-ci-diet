import assert from "node:assert/strict";
import { test } from "node:test";
import { skuForLabels } from "../../src/core/history/model.ts";
import { knownString, unknownString } from "../../src/core/savings/metrics.ts";
import { computeReportMetrics } from "../../src/core/savings/report-metrics.ts";

const UNSUPPORTED_LABELS = [
  ["macos-14-large"],
  ["macos-14-xlarge"],
  ["windows-2025-8core"],
  ["custom-windows-runner"],
  ["arm64"],
  ["slim"],
  ["custom-macos-arm64"],
  ["ubuntu-latest", "windows-latest"],
] as const;

test("unsupported or contradictory runner labels cannot produce known savings", () => {
  for (const labels of UNSUPPORTED_LABELS) {
    const sku = skuForLabels(labels);
    const { metrics } = computeReportMetrics([{
      jobId: "j1",
      durationMillis: 600_000,
      sku: sku === null ? unknownString("unresolved labels", "UNKNOWN_SKU") : knownString(sku, "runner labels"),
      removals: [{ findingId: "f1", startMillis: 0, endMillis: 600_000 }],
    }], { unavailableReason: "NO_HISTORY", billing: { includedMinutes: 0, accountMinutesUsed: 10 } });
    assert.equal(sku, null, JSON.stringify(labels));
    for (const metric of [metrics.listPriceUsd, metrics.estimatedMarginalUsd]) {
      assert.equal(metric.status, "unknown", JSON.stringify(labels));
      assert.equal(metric.reason, "UNKNOWN_SKU");
    }
    assert.equal(metrics.observedRunnerSeconds.value, 600);
  }
});

test("standard runner image labels retain all six pricing families", () => {
  const cases: readonly [readonly string[], string][] = [
    [["ubuntu-latest"], "actions_linux"],
    [["ubuntu-24.04"], "actions_linux"],
    [["UBUNTU-24.04-ARM"], "actions_linux_arm"],
    [["ubuntu-slim"], "actions_linux_slim"],
    [["windows-latest"], "actions_windows"],
    [["windows-2025"], "actions_windows"],
    [["windows-11-arm"], "actions_windows_arm"],
    [["windows-2025-arm"], "actions_windows_arm"],
    [["macos-latest"], "actions_macos"],
    [["macos-14"], "actions_macos"],
    [["macos-13.0"], "actions_macos"],
    [["ubuntu-latest", "ubuntu-24.04"], "actions_linux"],
  ];
  for (const [labels, expected] of cases) assert.equal(skuForLabels(labels), expected, JSON.stringify(labels));
});

test("unknown labels and self-hosted markers remain unknown regardless of order", () => {
  for (const labels of [[], ["ubuntu"], ["custom-runner"], ["ubuntu-latest", "custom-runner"],
    ["self-hosted", "ubuntu-latest"], ["ubuntu-latest", "SELF-HOSTED"],
    ["ubuntu-latest", "ubuntu-24.04-arm"], ["ubuntu-latest", "macos-14-large"]]) {
    assert.equal(skuForLabels(labels), null, JSON.stringify(labels));
    assert.equal(skuForLabels([...labels].reverse()), null, JSON.stringify(labels));
  }
});
