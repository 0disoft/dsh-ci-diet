import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildCoverage } from "../../src/core/analysis/coverage.ts";
import { createLocalBinding } from "../../src/core/scan/binding.ts";
import { parseWorkflow } from "../../src/core/workflow/parse.ts";
import { claimsFromTokens } from "../../src/core/patch/eligibility.ts";
import { buildRequestedPlan } from "../../src/core/patch/request-plan.ts";
import type { Coverage, Finding, RepositoryBinding } from "../../src/core/contracts/schema.ts";
import type { HistoryBundle } from "../../src/core/history/model.ts";

const NOW = new Date("2026-10-20T00:00:00.000Z");
const ISO = NOW.toISOString();
const PATH = ".github/workflows/ci.yml";
const WORKFLOW = [
  "on: pull_request",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v7",
  "      - uses: actions/upload-artifact@v4",
  "        with:",
  "          name: coverage",
  "          path: coverage/",
  "",
].join("\n");

function workspace(): { root: string; binding: RepositoryBinding } {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-request-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, ".github", "workflows", "ci.yml"), WORKFLOW, "utf8");
  return { root, binding: createLocalBinding(root, ISO, { repositoryFullName: "owner/repo" }).binding };
}

function coverage(): Coverage {
  return buildCoverage({ apiVersion: "2026-03-10", ghVersion: "2.0.0", requestedFrom: "2026-10-13T00:00:00.000Z", requestedTo: ISO }, {});
}

function history(): HistoryBundle {
  return {
    repositoryId: "git:" + "c".repeat(32),
    repositoryFullName: "owner/repo",
    defaultBranch: "main",
    requestedFrom: "2026-10-13T00:00:00.000Z",
    requestedTo: ISO,
    runs: [],
    pulls: new Map(),
    workflows: [],
    artifacts: [],
    retention: { days: 90, maximumAllowedDays: 90, fetchedAt: ISO },
    protection: { defaultBranch: "main", ruleCount: 0, classicProtection: true, fetchedAt: ISO },
    coverage: coverage(),
    missingScopes: [],
  };
}

function finding(ruleId: Finding["ruleId"], workflowHash: string): Finding {
  return {
    findingId: "f_" + ruleId,
    fingerprint: "sha256:" + "a".repeat(64),
    ruleId,
    ruleVersion: "0.1.0",
    title: "title",
    renderedText: "rendered",
    workflowPath: PATH,
    workflowHash,
    evidenceLevel: "observed",
    patchability: "eligible",
    evidenceRefs: [],
    assumptions: [],
    blockers: [],
    standaloneRunnerSeconds: { status: "not_applicable", value: null, basis: "storage", reason: "storage" },
  };
}

describe("requested plan builder", () => {
  it("builds a CD001 plan and attestation without persisting them", () => {
    const { binding } = workspace();
    const workflow = parseWorkflow(PATH, WORKFLOW);
    const result = buildRequestedPlan({
      binding,
      workflow,
      text: WORKFLOW,
      rule: "CD001",
      allowedRules: ["CD001", "CD005", "CD008"],
      jobKey: null,
      stepIndex: null,
      minutes: null,
      finding: finding("CD001", workflow.sha256),
      coverage: coverage(),
      claims: claimsFromTokens(["ci-only", "replace-safe"]),
      history: history(),
      evidenceRef: "test:request",
      issuedBy: { channel: "human-cli", subjectId: "tester" },
      now: NOW,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.plan.payload.ruleIds, ["CD001"]);
    assert.equal(result.edits.length, 1);
    assert.equal(result.attestation.claims.ciOnly, true);
    assert.equal(result.coverageLevel, "full");
  });

  it("refuses a rule the configuration does not allow", () => {
    const { binding } = workspace();
    const workflow = parseWorkflow(PATH, WORKFLOW);
    const result = buildRequestedPlan({
      binding,
      workflow,
      text: WORKFLOW,
      rule: "CD001",
      allowedRules: ["CD005"],
      jobKey: null,
      stepIndex: null,
      minutes: null,
      finding: finding("CD001", workflow.sha256),
      coverage: coverage(),
      claims: claimsFromTokens(["ci-only", "replace-safe"]),
      history: history(),
      evidenceRef: "test:request",
      issuedBy: { channel: "human-cli", subjectId: "tester" },
      now: NOW,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.blocker, "RULE_NOT_ALLOWED");
    assert.deepEqual(result.reasons, ["RULE_NOT_ALLOWED: CD001"]);
  });

  it("refuses a CD005 request without a job and minutes", () => {
    const { binding } = workspace();
    const workflow = parseWorkflow(PATH, WORKFLOW);
    const result = buildRequestedPlan({
      binding,
      workflow,
      text: WORKFLOW,
      rule: "CD005",
      allowedRules: ["CD001", "CD005", "CD008"],
      jobKey: "build",
      stepIndex: null,
      minutes: null,
      finding: finding("CD005", workflow.sha256),
      coverage: coverage(),
      claims: claimsFromTokens([]),
      history: history(),
      evidenceRef: "test:request",
      issuedBy: { channel: "human-cli", subjectId: "tester" },
      now: NOW,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.blocker, "JOB_REQUIRED");
  });

  it("refuses a CD008 request for a step that does not exist", () => {
    const { binding } = workspace();
    const workflow = parseWorkflow(PATH, WORKFLOW);
    const result = buildRequestedPlan({
      binding,
      workflow,
      text: WORKFLOW,
      rule: "CD008",
      allowedRules: ["CD001", "CD005", "CD008"],
      jobKey: "build",
      stepIndex: 99,
      minutes: null,
      finding: finding("CD008", workflow.sha256),
      coverage: coverage(),
      claims: claimsFromTokens(["artifact-purpose:temporary", "consumer-min-days:1"]),
      history: history(),
      evidenceRef: "test:request",
      issuedBy: { channel: "human-cli", subjectId: "tester" },
      now: NOW,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.blocker, "STEP_REQUIRED");
  });

  it("returns eligibility reasons when required claims are missing", () => {
    const { binding } = workspace();
    const workflow = parseWorkflow(PATH, WORKFLOW);
    const result = buildRequestedPlan({
      binding,
      workflow,
      text: WORKFLOW,
      rule: "CD001",
      allowedRules: ["CD001", "CD005", "CD008"],
      jobKey: null,
      stepIndex: null,
      minutes: null,
      finding: finding("CD001", workflow.sha256),
      coverage: coverage(),
      claims: claimsFromTokens([]),
      history: history(),
      evidenceRef: "test:request",
      issuedBy: { channel: "human-cli", subjectId: "tester" },
      now: NOW,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.blocker, "NOT_ELIGIBLE");
    assert.ok(result.reasons.includes("CLAIM_CI_ONLY_MISSING"));
  });
});
