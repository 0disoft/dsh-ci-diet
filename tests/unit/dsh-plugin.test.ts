import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { apply, isHistoryTruncated } from "../../src/dsh/host/plugin.ts";

interface Registered {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, { description?: string }>;
  execute(args: Record<string, unknown>, exec: { signal: AbortSignal }): Promise<unknown>;
}

function harness(config: { networkEnabled?: boolean; stateDir?: string } = {}) {
  const tools = new Map<string, Registered>();
  const ctx = {
    tools: {
      register(definition: Registered) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
  };
  const stateDir = config.stateDir ?? join(mkdtempSync(join(tmpdir(), "ci-diet-plugin-")), "state");
  apply(ctx as never, { networkEnabled: config.networkEnabled ?? false, localApplyEnabled: false, stateDir } as never);
  return { tools, stateDir };
}

const WORKFLOW = [
  "on: [push, pull_request]",
  "jobs:",
  "  test:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/upload-artifact@v4",
  "        with:",
  "          name: build",
  "          path: out",
  "",
].join("\n");

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-plugin-repo-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, ".github", "workflows", "ci.yml"), WORKFLOW, "utf8");
  return root;
}

test("registers the four model-facing tools", () => {
  const { tools } = harness();
  assert.deepEqual([...tools.keys()].sort(), ["ci_diet_plan", "ci_diet_report", "ci_diet_scan", "ci_diet_sync"]);
});

test("localizes tool and parameter descriptions from the DSH preference", () => {
  const profile = mkdtempSync(join(tmpdir(), "ci-diet-plugin-locale-"));
  writeFileSync(
    joinPath(profile, "cordis.patch.yml"),
    "- id: locale\n  name: \"@deepseek-ai/dsh-client-locale\"\n  config:\n    preference: ko\n",
    "utf8",
  );
  const previous = process.env.DSH_PROFILE_DIR;
  process.env.DSH_PROFILE_DIR = profile;
  try {
    const { tools } = harness();
    const scan = tools.get("ci_diet_scan")!;
    assert.match(scan.description, /체크아웃된 GitHub 저장소/);
    const properties = (scan.parameters as unknown as { properties?: Record<string, { description?: string }> }).properties;
    assert.match(properties?.cwd?.description ?? "", /현재 작업 폴더/);
    for (const tool of tools.values()) {
      assert.doesNotMatch(tool.description, /^Scan a checked-out|^Fetch read-only|^Read the most recent|^Preview the exact/);
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR;
    else process.env.DSH_PROFILE_DIR = previous;
  }
});

test("ci_diet_scan stores a report and lists findings", async () => {
  const { tools } = harness();
  const root = workspace();
  const result = (await tools.get("ci_diet_scan")!.execute({ cwd: root }, { signal: new AbortController().signal })) as {
    workflowsParsed: number;
    findings: { ruleId: string }[];
  };
  assert.equal(result.workflowsParsed, 1);
  const rules = result.findings.map((finding) => finding.ruleId).sort();
  assert.deepEqual(rules, ["CD008"]);

  const report = (await tools.get("ci_diet_report")!.execute({}, { signal: new AbortController().signal })) as {
    findings: unknown[];
    coverage: unknown[];
  };
  assert.equal(report.findings.length, 1);
  assert.equal(report.coverage.length, 5);
});

test("ci_diet_sync refuses without networkEnabled", async () => {
  const { tools } = harness({ networkEnabled: false });
  await assert.rejects(
    () => tools.get("ci_diet_sync")!.execute({ cwd: workspace() }, { signal: new AbortController().signal }),
    /networkEnabled/,
  );
});

test("reports truncated history from the history coverage dimension", () => {
  assert.equal(isHistoryTruncated({ status: "complete", reasons: [] }), false);
  assert.equal(isHistoryTruncated({ status: "partial", reasons: ["PARTIAL_COLLECTION"] }), true);
  assert.equal(isHistoryTruncated({ status: "unavailable", reasons: ["RUN_LIMIT_REACHED"] }), true);
  assert.equal(isHistoryTruncated({ status: "unavailable", reasons: ["ARTIFACT_RUN_LIMIT_REACHED"] }), true);
});

test("ci_diet_plan previews retention edits without writing", async () => {
  const { tools } = harness();
  const root = workspace();
  await tools.get("ci_diet_scan")!.execute({ cwd: root }, { signal: new AbortController().signal });
  const plan = (await tools.get("ci_diet_plan")!.execute(
    { rule: "CD008", job: "test", step: 0, cwd: root },
    { signal: new AbortController().signal },
  )) as { edits: { kind: string }[]; writeAllowed: boolean; blockers: string[] };
  assert.equal(plan.edits.length, 1);
  assert.equal(plan.edits[0]!.kind, "insertScalar");
  assert.ok(plan.blockers.includes("COVERAGE_DEGRADE"));
  assert.equal(plan.writeAllowed, false);
});