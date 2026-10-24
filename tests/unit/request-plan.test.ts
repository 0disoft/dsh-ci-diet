import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildCoverage } from "../../src/core/analysis/coverage.ts";
import { createLocalBinding } from "../../src/core/scan/binding.ts";
import { parseWorkflow } from "../../src/core/workflow/parse.ts";
import { claimsFromTokens } from "../../src/core/patch/eligibility.ts";
import { buildRequestedPlan, type RequestedPlanInput } from "../../src/core/patch/request-plan.ts";
import { dependencyHashOf } from "../../src/core/patch/plan.ts";
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

it("rejects ineligible requests before reading local action files, but still pins eligible dependencies", (t) => {
  const { root, binding } = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, ".github", "actions", "local");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "action.yml"), "name: local\nruns:\n  using: node20\n  main: dep-0.js\n");
  for (let i = 0; i < 32; i += 1) writeFileSync(join(directory, "dep-" + i + ".js"), Buffer.alloc(64 * 1024, 32));
  const prefix = realpathSync(directory);
  const text = WORKFLOW + "      - uses: ./.github/actions/local\n";
  const workflow = parseWorkflow(PATH, text);
  const input: RequestedPlanInput = {
    binding, workflow, text, rule: "CD001", allowedRules: ["CD001"],
    jobKey: null, stepIndex: null, minutes: null,
    finding: finding("CD001", workflow.sha256), coverage: coverage(),
    claims: claimsFromTokens(["ci-only", "replace-safe"]), history: history(),
    evidenceRef: "test:early-eligibility", issuedBy: { channel: "human-cli", subjectId: "tester" }, now: NOW,
  };
  let reads = 0, bytes = 0;
  const read = fs.readFileSync;
  const mocked = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    const result = read(...args);
    if (String(args[0]).startsWith(prefix + "/") || String(args[0]).startsWith(prefix + "\\")) {
      reads += 1;
      bytes += Buffer.byteLength(result);
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    const fresh = history();
    const stale = { ...fresh, protection: { ...fresh.protection!, fetchedAt: "2026-10-19T00:00:00Z" } };
    const refused = [
      buildRequestedPlan({ ...input, claims: claimsFromTokens([]) }),
      buildRequestedPlan({ ...input, finding: { ...input.finding, patchability: "blocked" } }),
      buildRequestedPlan({ ...input, history: stale }),
    ];
    for (const result of refused) {
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.blocker, "NOT_ELIGIBLE");
        assert.equal(result.edits.length, 1);
        assert.equal(result.coverageLevel, "full");
      }
    }
    assert.ok(!refused[0]!.ok && refused[0]!.reasons.includes("CLAIM_CI_ONLY_MISSING"));
    assert.ok(!refused[1]!.ok && refused[1]!.reasons.includes("FINDING_BLOCKED"));
    assert.ok(!refused[2]!.ok && refused[2]!.reasons.includes("POLICY_STALE"));
    t.diagnostic("ineligible local-action reads: " + reads + "; bytes: " + bytes);
    assert.equal(reads, 0, "ineligible plans must not scan dependency contents");
    const allowed = buildRequestedPlan(input);
    assert.equal(allowed.ok, true);
    if (allowed.ok) {
      assert.equal(reads, 33, "eligible plans must still read every action file");
      assert.equal(allowed.plan.payload.dependencies.length, 33);
      assert.equal(allowed.attestation.dependencyHash, dependencyHashOf(allowed.plan.payload.dependencies));
    }
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});
