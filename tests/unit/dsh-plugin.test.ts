import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Config, apply, buildNextCommand, isHistoryTruncated, shellQuoteArg } from "../../src/dsh/host/plugin.ts";
import { DEFAULT_CONFIG } from "../../src/core/data/default-config.ts";
import { defaultPluginSettings, engineSettingsOf } from "../../src/core/config/plugin-settings.ts";
import type { PluginSettingsValues } from "../../src/core/config/plugin-settings.ts";

interface Registered {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, { description?: string }>;
  execute(args: Record<string, unknown>, exec: { signal: AbortSignal; agent?: unknown }): Promise<unknown>;
}

/** A mutable stand-in for the stable reference the DSH settings service updates. */
function live<T>(initial: T) {
  let current = initial;
  return {
    get: () => current,
    set(next: T) {
      current = next;
    },
  };
}

function harness(overrides: Partial<PluginSettingsValues> = {}, sessionCwd?: string) {
  const tools = new Map<string, Registered>();
  const listeners = new Map<string, unknown>();
  const ctx = {
    get(name: string) { return name === "workingDirectory" && sessionCwd !== undefined ? { get: () => sessionCwd } : undefined; },
    on(event: string, listener: unknown) { listeners.set(event, listener); },
    tools: {
      register(definition: Registered) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
  };
  const values: PluginSettingsValues = {
    ...defaultPluginSettings(),
    stateDir: join(mkdtempSync(join(tmpdir(), "ci-diet-plugin-")), "state"),
    ...overrides,
  };
  const refs = {} as Record<keyof PluginSettingsValues, ReturnType<typeof live>>;
  const config = { localApplyEnabled: false } as Record<string, unknown>;
  for (const [key, value] of Object.entries(values)) {
    const ref = live(value);
    refs[key as keyof PluginSettingsValues] = ref;
    config[key] = ref;
  }
  const stateDirRef = refs.stateDir as ReturnType<typeof live<string>>;
  apply(ctx as never, config as never);
  return { tools, listeners, stateDir: stateDirRef.get(), stateDirRef, networkEnabled: refs.networkEnabled, refs, ctx };
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

test("registers the five model-facing tools", () => {
  const { tools, listeners } = harness();
  assert.ok(listeners.has("tools/pre-execute"));
  assert.deepEqual([...tools.keys()].sort(), ["ci_diet_plan", "ci_diet_prune", "ci_diet_report", "ci_diet_scan", "ci_diet_sync"]);
});

test("ci_diet_scan uses the session directory when cwd is omitted", async () => {
  const root = workspace();
  const { tools } = harness({}, root);
  const result = await tools.get("ci_diet_scan")!.execute({}, {
    signal: new AbortController().signal,
    agent: { session: { id: "session-1" } },
  }) as { root: string; workflowsParsed: number };
  assert.equal(result.root, realpathSync(root));
  assert.equal(result.workflowsParsed, 1);
});

test("ci_diet_prune applies the configured retention limits", async () => {
  const { tools, stateDir, refs } = harness();
  const root = workspace();
  const signal = new AbortController().signal;
  await tools.get("ci_diet_scan")!.execute({ cwd: root }, { signal });
  assert.equal(readdirSync(join(stateDir, "reports")).length, 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  (refs.storageReportDays as ReturnType<typeof live<number>>).set(0);
  const pruned = await tools.get("ci_diet_prune")!.execute({}, { signal }) as { removedReports: number; blocked: boolean };
  assert.equal(pruned.removedReports, 1);
  assert.equal(pruned.blocked, false);
  assert.equal(readdirSync(join(stateDir, "reports")).length, 0);
});

test("exposes every engine-facing setting as live", () => {
  const fields = (Config as unknown as { dict: Record<string, { meta?: { volatile?: boolean } }> }).dict;
  for (const key of Object.keys(defaultPluginSettings())) {
    assert.equal(fields[key]?.meta?.volatile, true, key + " must be volatile");
  }
  assert.equal(fields.localApplyEnabled?.meta?.volatile, true);
});

test("defaults match the contract and rule defaults", () => {
  const settings = engineSettingsOf(defaultPluginSettings());
  assert.deepEqual(settings.config, DEFAULT_CONFIG);
  assert.deepEqual(settings.enabledRules, ["CD001", "CD002", "CD004", "CD006", "CD008"]);
  assert.equal(settings.config.storage.storeMaxBytes, 268435456);
  assert.equal(settings.config.billing, undefined);
});

test("ci_diet_plan previews the npm cache patch with network disabled and no history", async () => {
  const { tools } = harness();
  const root = workspace();
  const workflow = "on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n      - run: npm ci\n";
  writeFileSync(join(root, ".github/workflows/ci.yml"), workflow);
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}');
  for (const args of [["init", "--quiet"], ["add", "--", "package.json", "package-lock.json"]]) execFileSync("git", args, { cwd: root, stdio: "pipe", windowsHide: true, timeout: 5000 });
  const exec = { signal: new AbortController().signal };
  await tools.get("ci_diet_scan")!.execute({ cwd: root }, exec);
  const result = await tools.get("ci_diet_plan")!.execute({ rule: "CD006", cwd: root, job: "test", step: 1 }, exec) as { writeAllowed: boolean; blockers: string[]; nextCommand: string };
  assert.equal(result.writeAllowed, true, JSON.stringify(result));
  assert.deepEqual(result.blockers, []);
  assert.match(result.nextCommand, /--rule CD006/);
});

test("rejects an out-of-contract lookback and zero rules", () => {
  assert.throws(
    () => engineSettingsOf({ ...defaultPluginSettings(), historyLookbackDays: 31 }),
    /history\/lookbackDays maximum must be <= 30/,
  );
  assert.throws(
    () => engineSettingsOf({ ...defaultPluginSettings(), rules: [] }),
    /at least one analysis rule/,
  );
  assert.throws(() => engineSettingsOf({ ...defaultPluginSettings(), rules: ["CD999" as never] }), /unknown analysis rule: CD999/);
  assert.deepEqual(engineSettingsOf({ ...defaultPluginSettings(), rules: ["CD001", "CD001"] }).enabledRules, ["CD001"]);
});

test("the host schema rejects an out-of-contract save before a tool call", () => {
  const validate = Config as unknown as (input: Record<string, unknown>) => unknown;
  assert.throws(() => validate({ rules: [] }), /rules/);
  assert.throws(() => validate({ rules: ["CD001"], historyLookbackDays: 31 }), /historyLookbackDays/);
  assert.throws(() => validate({ rules: ["CD001"], historyConcurrentRequests: 5 }), /historyConcurrentRequests/);
  assert.throws(() => validate({ rules: ["CD999"] }), /rules/);
  const saved = validate({ rules: ["CD001"], historyLookbackDays: 30, historyConcurrentRequests: 1 }) as Record<string, unknown>;
  assert.deepEqual((saved.rules as { get(): unknown }).get(), ["CD001"]);
  assert.equal((saved.historyLookbackDays as { get(): unknown }).get(), 30);
});

test("enables billing only when the switch is on", () => {
  const off = engineSettingsOf(defaultPluginSettings());
  assert.equal(off.config.billing, undefined);
  const on = engineSettingsOf({ ...defaultPluginSettings(), billingEnabled: true, billingIncludedMinutes: 2000, billingAccountMinutesUsed: 2100 });
  assert.deepEqual(on.config.billing, { includedMinutes: 2000, accountMinutesUsed: 2100 });
});

test("reads live settings on every tool call", async () => {
  const { tools, stateDirRef, networkEnabled } = harness();
  const root = workspace();
  await tools.get("ci_diet_scan")!.execute({ cwd: root }, { signal: new AbortController().signal });

  const first = stateDirRef.get();
  stateDirRef.set(join(mkdtempSync(join(tmpdir(), "ci-diet-plugin-live-")), "state"));
  await assert.rejects(
    () => tools.get("ci_diet_report")!.execute({}, { signal: new AbortController().signal }),
    /no report stored yet/,
  );

  stateDirRef.set(first);
  const report = (await tools.get("ci_diet_report")!.execute({}, { signal: new AbortController().signal })) as { findings: unknown[] };
  assert.equal(report.findings.length, 1);

  await assert.rejects(
    () => tools.get("ci_diet_sync")!.execute({ cwd: root, repo: "not-a-repo" }, { signal: new AbortController().signal }),
    /networkEnabled/,
  );
  networkEnabled.set(true);
  await assert.rejects(
    () => tools.get("ci_diet_sync")!.execute({ cwd: root, repo: "not-a-repo" }, { signal: new AbortController().signal }),
    /invalid repository/,
  );
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

test("reads a changed rule switch on the next tool call", async () => {
  const { tools, refs } = harness();
  const root = workspace();
  const scan = tools.get("ci_diet_scan")!;
  const first = (await scan.execute({ cwd: root }, { signal: new AbortController().signal })) as { findings: unknown[] };
  assert.equal(first.findings.length, 1);
  (refs.rules as ReturnType<typeof live<readonly string[]>>).set(["CD001", "CD002", "CD004"]);
  const second = (await scan.execute({ cwd: root }, { signal: new AbortController().signal })) as { findings: unknown[] };
  assert.equal(second.findings.length, 0);
});

test("ci_diet_sync refuses without networkEnabled", async () => {
  const { tools } = harness({ networkEnabled: false });
  await assert.rejects(
    () => tools.get("ci_diet_sync")!.execute({ cwd: workspace() }, { signal: new AbortController().signal }),
    /networkEnabled/,
  );
});

test("ci_diet_sync refuses to run or save when the caller aborted", async () => {
  const { tools, stateDir } = harness({ networkEnabled: true });
  const controller = new AbortController();
  controller.abort(new Error("caller gave up"));
  await assert.rejects(
    () => tools.get("ci_diet_sync")!.execute({ cwd: workspace(), repo: "o/r" }, { signal: controller.signal }),
    /caller gave up/,
  );
  const historyDir = join(stateDir, "snapshots", "history");
  assert.equal(existsSync(historyDir) ? readdirSync(historyDir).length : 0, 0);
});

test("reports truncated history from the history coverage dimension", () => {
  assert.equal(isHistoryTruncated({ status: "complete", reasons: [] }), false);
  assert.equal(isHistoryTruncated({ status: "partial", reasons: ["PARTIAL_COLLECTION"] }), true);
  assert.equal(isHistoryTruncated({ status: "unavailable", reasons: ["RUN_LIMIT_REACHED"] }), true);
  assert.equal(isHistoryTruncated({ status: "unavailable", reasons: ["ARTIFACT_RUN_LIMIT_REACHED"] }), true);
});

test("nextCommand quotes workflow paths so shell syntax cannot execute", () => {
  const hostile = ".github/workflows/ci;printf REVIEW_OK;#.yml";
  assert.equal(
    buildNextCommand({ rule: "CD008", workflowPath: hostile }, "linux"),
    "ci-diet plan --rule CD008 --workflow '.github/workflows/ci;printf REVIEW_OK;#.yml'",
  );
  assert.equal(
    buildNextCommand({ rule: "CD008", workflowPath: ".github/workflows/my ci.yml" }, "linux"),
    "ci-diet plan --rule CD008 --workflow '.github/workflows/my ci.yml'",
  );
  assert.equal(shellQuoteArg("a'b.yml", "linux"), "'a'\\''b.yml'");
  assert.equal(
    buildNextCommand({ rule: "CD008", workflowPath: "$(touch pwned).yml" }, "linux"),
    "ci-diet plan --rule CD008 --workflow '$(touch pwned).yml'",
  );
  assert.equal(shellQuoteArg(".github/workflows/ci.yml", "linux"), ".github/workflows/ci.yml");
});

test("nextCommand quotes for PowerShell on Windows", () => {
  assert.equal(shellQuoteArg("a'b.yml", "win32"), "'a''b.yml'");
  assert.equal(
    buildNextCommand({ rule: "CD008", workflowPath: "$(touch pwned).yml", job: "test job" }, "win32"),
    "ci-diet plan --rule CD008 --workflow '$(touch pwned).yml' --job 'test job'",
  );
});

test("nextCommand forwards optional arguments and joins claims", () => {
  assert.equal(
    buildNextCommand({ rule: "CD008", workflowPath: ".github/workflows/ci.yml", job: "build", step: 2, minutes: 15, claims: ["A", "B"] }, "linux"),
    "ci-diet plan --rule CD008 --workflow .github/workflows/ci.yml --job build --step 2 --minutes 15 --claims A,B",
  );
  assert.equal(
    buildNextCommand(
      { rule: "CD008", workflowPath: ".github/workflows/ci.yml", cwd: "C:/work space/repo", stateDir: "C:/state", job: "build" },
      "win32",
    ),
    "ci-diet plan --rule CD008 --workflow .github/workflows/ci.yml --cwd 'C:/work space/repo' --state-dir C:/state --job build",
  );
});

test("ci_diet_plan previews retention edits without writing", async () => {
  const { tools } = harness();
  const root = workspace();
  await tools.get("ci_diet_scan")!.execute({ cwd: root }, { signal: new AbortController().signal });
  const plan = (await tools.get("ci_diet_plan")!.execute(
    { rule: "CD008", job: "test", step: 0, cwd: root },
    { signal: new AbortController().signal },
  )) as { edits: { kind: string }[]; writeAllowed: boolean; blockers: string[]; nextCommand: string };
  assert.equal(plan.edits.length, 1);
  assert.equal(plan.edits[0]!.kind, "insertScalar");
  assert.ok(plan.blockers.includes("COVERAGE_DEGRADE"));
  assert.equal(plan.writeAllowed, false);
  assert.match(plan.nextCommand, /--cwd /);
  assert.match(plan.nextCommand, /--state-dir /);
});
