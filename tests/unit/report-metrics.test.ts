import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobInput } from "../../src/core/contracts/schema.ts";
import { computeReportMetrics } from "../../src/core/savings/report-metrics.ts";
import { knownString, unknownString } from "../../src/core/savings/metrics.ts";

function job(id: string, sku: "known" | "unknown" = "known"): JobInput {
  return {
    jobId: id,
    durationMillis: 600000,
    sku: sku === "known" ? knownString("actions_linux", "runner label") : unknownString("labels unresolved", "UNKNOWN_SKU"),
    removals: [{ findingId: "f_" + id, startMillis: 0, endMillis: 600000 }],
  };
}

function marginal(billing: { accountMinutesUsed: number; includedMinutes: number } | null, sku: "known" | "unknown" = "known") {
  return computeReportMetrics([job("j1", sku)], { unavailableReason: "NO_HISTORY", billing }).metrics.estimatedMarginalUsd;
}

test("marginal cost is unknown until the account allowance is configured", () => {
  const value = marginal(null);
  assert.equal(value.status, "unknown");
  assert.equal(value.value, null);
  assert.equal(value.reason, "BILLING_ESTIMATE_UNCONFIGURED");
});

test("savings inside the included allowance cost nothing", () => {
  const value = marginal({ accountMinutesUsed: 100, includedMinutes: 2000 });
  assert.equal(value.status, "known");
  assert.equal(value.value, "0.000000");
});

test("usage just past the allowance bills only the overlapping minutes", () => {
  const value = marginal({ accountMinutesUsed: 2005, includedMinutes: 2000 });
  assert.equal(value.status, "known");
  assert.equal(value.value, "0.030000");
});

test("savings are capped by the minutes already over the allowance", () => {
  for (const accountMinutesUsed of [2100, 2500]) {
    const value = marginal({ accountMinutesUsed, includedMinutes: 2000 });
    assert.equal(value.status, "known");
    assert.equal(value.value, "0.060000");
  }
});

test("usage at or below the allowance keeps the marginal cost at zero", () => {
  for (const accountMinutesUsed of [1900, 2000]) {
    const value = marginal({ accountMinutesUsed, includedMinutes: 2000 });
    assert.equal(value.status, "known");
    assert.equal(value.value, "0.000000");
  }
});

test("a known SKU with no removable minutes costs zero instead of unknown", () => {
  const value = computeReportMetrics(
    [{ jobId: "j1", durationMillis: 600000, sku: knownString("actions_linux", "runner label"), removals: [] }],
    { unavailableReason: "NO_HISTORY", billing: { accountMinutesUsed: 2500, includedMinutes: 2000 } },
  ).metrics.estimatedMarginalUsd;
  assert.equal(value.status, "known");
  assert.equal(value.value, "0.000000");
});

test("an unknown SKU keeps the marginal estimate unknown", () => {
  const value = marginal({ accountMinutesUsed: 2500, includedMinutes: 2000 }, "unknown");
  assert.equal(value.status, "unknown");
  assert.equal(value.reason, "UNKNOWN_SKU");
});
