import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runStaticScan } from "../../src/core/scan/scan.ts";
import type { StaticScanOptions, StaticScanResult } from "../../src/core/scan/scan.ts";

const fixture = fileURLToPath(new URL("../fixtures/repos/static-scan/", import.meta.url));
const generatedAt = "2026-10-20T00:00:00.000Z";

/** Copy outside the repository so `git remote get-url origin` finds nothing. */
function scan(options: Partial<StaticScanOptions> = {}): StaticScanResult {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-scan-"));
  try {
    cpSync(fixture, root, { recursive: true });
    return runStaticScan({ workspaceRoot: root, generatedAt, ...options });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("scans workflow text without network access", () => {
  const result = scan();

  assert.equal(result.workflows.length, 4);
  assert.equal(result.skipped.length, 2);
  assert.deepEqual(
    result.skipped.map((entry) => entry.reason).sort(),
    ["WORKFLOW_PARSE_ERROR", "WORKFLOW_UNSUPPORTED"],
  );
  assert.ok(result.warnings.includes("GITHUB_REMOTE_NOT_FOUND"));
  assert.ok(result.binding.repositoryId.startsWith("local:"));
  assert.ok(result.binding.repositoryFullName.startsWith("local/"));
  assert.match(result.binding.rootIdentityHash, /^sha256:[0-9a-f]{64}$/);
});

test("marks workflow definitions partial when a file fails", () => {
  const { report } = scan();
  assert.equal(report.coverage.workflowDefinitions.status, "partial");
  assert.equal(report.coverage.workflowDefinitions.fetched, 2);
  assert.equal(report.coverage.workflowDefinitions.expected, 4);
  assert.equal(report.coverage.history.status, "unavailable");
  assert.equal(report.coverage.retentionPolicy.status, "unavailable");
  assert.equal(report.normalizedInputs.jobs.length, 0);
  assert.equal(report.metrics.observedRunnerSeconds.status, "unknown");
  assert.equal(report.metrics.actualBilledUsd.status, "unknown");
});

test("reports static matrix and retention candidates", () => {
  const { report } = scan();
  const rules = new Map(report.ruleResults.map((result) => [result.ruleId, result]));

  const matrix = rules.get("CD004");
  assert.ok(matrix);
  assert.equal(matrix.outcome, "candidate");
  assert.equal(matrix.findingIds.length, 1);

  const retention = rules.get("CD008");
  assert.ok(retention);
  assert.equal(retention.outcome, "candidate");
  assert.equal(retention.findingIds.length, 1);

  const finding = report.findings.find((entry) => entry.ruleId === "CD008");
  assert.ok(finding);
  assert.equal(finding.patchability, "review-only");
  assert.ok(finding.blockers.includes("EFFECTIVE_RETENTION_MAX_UNKNOWN"));
  assert.match(finding.fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.match(finding.findingId, /^f_[0-9a-f]{24}$/);
});

test("skips disabled rules and history rules without history", () => {
  const onlyRetention = scan({ enabledRules: ["CD008"] });
  assert.deepEqual(onlyRetention.report.ruleResults.map((result) => result.ruleId), ["CD008"]);

  const full = scan();
  // CD003 and CD005 stay off by default (ADR-13), so only CD001/CD002 appear.
  assert.deepEqual(full.report.ruleResults.map((result) => result.ruleId), ["CD001", "CD002", "CD004", "CD008"]);
  for (const result of full.report.ruleResults.filter((entry) => entry.ruleId === "CD001" || entry.ruleId === "CD002")) {
    assert.equal(result.outcome, "skipped");
    assert.ok(result.reasons.length > 0);
  }

  const optedIn = scan({ enabledRules: ["CD003", "CD005"] });
  assert.deepEqual(optedIn.report.ruleResults.map((result) => result.ruleId), ["CD003", "CD005"]);
  for (const result of optedIn.report.ruleResults) assert.equal(result.outcome, "skipped");
});

test("produces a stable report id for identical inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-scan-"));
  try {
    cpSync(fixture, root, { recursive: true });
    const first = runStaticScan({ workspaceRoot: root, generatedAt });
    const second = runStaticScan({ workspaceRoot: root, generatedAt });
    assert.equal(first.report.reportId, second.report.reportId);
    assert.equal(first.binding.bindingId, second.binding.bindingId);
    assert.deepEqual(first.report.inputHashes, second.report.inputHashes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
