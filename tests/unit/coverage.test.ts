import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCoverage, composeCoverage } from "../../src/core/analysis/coverage.ts";
import type { MissingScope } from "../../src/core/contracts/schema.ts";
import { COVERAGE_POLICY, loadCoveragePolicy } from "../../src/core/data/index.ts";
import type { CoveragePolicy } from "../../src/core/data/index.ts";

const META = {
  apiVersion: "2022-11-28",
  ghVersion: "2.0.0",
  requestedFrom: "2026-10-13T00:00:00.000Z",
  requestedTo: "2026-10-20T00:00:00.000Z",
};

function clonedPolicy(): Record<string, any> {
  return JSON.parse(JSON.stringify(COVERAGE_POLICY)) as Record<string, any>;
}

test("an unmapped rule x axis x status cell fails closed", () => {
  const policy = clonedPolicy();
  delete policy.rules.CD008.retentionPolicy.unavailable;
  const coverage = buildCoverage(META, { retentionPolicy: { status: "unavailable", reasons: ["TEST"] } });
  const composition = composeCoverage(coverage, "CD008", {}, policy as unknown as CoveragePolicy);
  assert.equal(composition.level, "skip");
  assert.equal(composition.writeAllowed, false);
});

test("the shipped coverage policy is valid", () => {
  const policy = loadCoveragePolicy(JSON.stringify(COVERAGE_POLICY));
  assert.deepEqual(policy.compositionOrder, ["full", "subset", "degrade", "skip"]);
  assert.equal(policy.writeEligibility.skip, "never");
});

test("loadCoveragePolicy rejects a cell that names an unknown level", () => {
  const policy = clonedPolicy();
  policy.rules.CD008.retentionPolicy.partial = "widen";
  assert.throws(() => loadCoveragePolicy(JSON.stringify(policy)), /unknown level/);
});

test("loadCoveragePolicy rejects a level without write eligibility", () => {
  const policy = clonedPolicy();
  delete policy.writeEligibility.degrade;
  assert.throws(() => loadCoveragePolicy(JSON.stringify(policy)), /writeEligibility/);
});

test("loadCoveragePolicy rejects a rule without axis cells", () => {
  const policy = clonedPolicy();
  delete policy.rules.CD005;
  assert.throws(() => loadCoveragePolicy(JSON.stringify(policy)), /rules\.CD005/);
});

test("buildCoverage copies override arrays instead of aliasing them", () => {
  const reasons = ["PARTIAL_COLLECTION"];
  const missingScopes: MissingScope[] = [];
  const coverage = buildCoverage(META, { history: { status: "partial", reasons, missingScopes } });
  assert.notEqual(coverage.history.reasons, reasons);
  assert.notEqual(coverage.history.missingScopes, missingScopes);
  coverage.history.reasons.push("EXTRA");
  assert.deepEqual(reasons, ["PARTIAL_COLLECTION"]);
});
