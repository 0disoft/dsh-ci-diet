import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { DEFAULT_CONFIG } from "../../core/data/default-config.ts";
import { buildHistoryReport } from "../../core/analysis/report.ts";
import { composeCoverage } from "../../core/analysis/coverage.ts";
import { AXIS_NAMES, RULE_IDS } from "../../core/model/domain.ts";
import type { RuleId } from "../../core/model/domain.ts";
import type { Coverage } from "../../core/contracts/schema.ts";
import { PatchStore } from "../../core/patch/store.ts";
import { planConcurrencyEdit, planRetentionEdit, planTimeoutEdit } from "../../core/patch/edits.ts";
import { createLocalBinding, readGithubRemote } from "../../core/scan/binding.ts";
import { discoverWorkflows } from "../../core/scan/discover.ts";
import { runStaticScan } from "../../core/scan/scan.ts";
import { defaultStateDir } from "../../core/state/paths.ts";
import { syncRepositoryHistory } from "../../core/history/sync.ts";
import { parseWorkflow } from "../../core/workflow/parse.ts";
import type { WorkflowJob } from "../../core/workflow/model.ts";
import { resolveLocale, t } from "../../shared/i18n/index.ts";

export const name = "ci-diet";
export const inject = ["tools"];

export interface Config {
  networkEnabled: boolean;
  localApplyEnabled: boolean;
  stateDir: string;
}

export const Config: Schema<Config> = Schema.object({
  networkEnabled: Schema.boolean().default(false),
  localApplyEnabled: Schema.boolean().default(false),
  stateDir: Schema.string().default(""),
});

function stateDirOf(config: Config): string {
  return config.stateDir === "" ? defaultStateDir() : config.stateDir;
}

function locale() {
  const configured = process.env.DSH_LOCALE ?? process.env.LANG ?? "";
  return resolveLocale(configured) ?? resolveLocale("en")!;
}

function text(value: string) {
  return [{ type: "text" as const, text: value }];
}

const coverageSummary = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: { axis: { type: "string" }, status: { type: "string" } },
  },
} as const;

const metricSummary = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: { name: { type: "string" }, status: { type: "string" }, value: { type: "string" } },
  },
} as const;

const metricNames = [
  "observedRunnerSeconds",
  "candidateRemovableSeconds",
  "modeledRoundedMinutes",
  "listPriceUsd",
  "estimatedMarginalUsd",
  "actualBilledUsd",
] as const;

function coverageRows(coverage: Coverage): { axis: string; status: string }[] {
  return AXIS_NAMES.map((axis) => ({ axis, status: coverage[axis].status }));
}

function metricRows(metrics: Record<string, { status: string; value: number | string | null }>): { name: string; status: string; value: string }[] {
  return metricNames.map((name) => {
    const metric = metrics[name] ?? { status: "unknown", value: null };
    const value = metric.value === null ? "" : String(metric.value);
    return { name, status: metric.status, value };
  });
}

export function apply(ctx: Context, config: Config) {
  ctx.tools.register(defineTool({
    name: "ci_diet_scan",
    description:
      "Scan a checked-out GitHub repository for wasteful CI workflows without network access. " +
      "Reads .github/workflows, parses it, evaluates the enabled static rules, and stores the report locally.",
    parameters: {
      cwd: { type: "string", description: "Absolute repository root; defaults to the current working directory." },
      rules: { type: "array", items: { type: "string", enum: [...RULE_IDS] }, description: "Rules to evaluate; defaults to the configured set." },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          root: { type: "string" },
          reportId: { type: "string" },
          workflowsParsed: { type: "number" },
          workflowsTotal: { type: "number" },
          findings: { type: "array", items: { type: "object", additionalProperties: true } },
          coverage: coverageSummary,
        },
        additionalProperties: false,
      },
      render: (_args, value) =>
        text(
          "CI Diet static scan: " + value.workflowsParsed + " of " + value.workflowsTotal + " workflows parsed. " +
          (value.findings ?? []).length + " finding(s). Report " + value.reportId + ".",
        ),
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const root = args.cwd ?? process.cwd();
      const rules = args.rules as readonly RuleId[] | undefined;
      const scan = runStaticScan({ workspaceRoot: root, enabledRules: rules, maxWorkflowBytes: DEFAULT_CONFIG.storage.workflowMaxBytes });
      if (!existsSync(root)) throw new Error("workspace does not exist: " + root);
      const store = PatchStore.open(stateDirOf(config));
      store.saveBinding(scan.binding);
      store.saveReport(scan.report);
      return {
        root: scan.binding.workspaceRoot,
        reportId: scan.report.reportId,
        workflowsParsed: scan.workflows.length,
        workflowsTotal: scan.workflows.length + scan.skipped.length,
        findings: scan.report.findings.map((finding) => ({
          ruleId: finding.ruleId,
          title: finding.title,
          patchability: finding.patchability,
          workflowPath: finding.workflowPath,
        })),
        coverage: coverageRows(scan.report.coverage),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "ci_diet_sync",
    description:
      "Fetch read-only GitHub Actions history for a repository, combine it with the local workflow files, " +
      "evaluate the history rules, and store the report. Requires network access to be enabled in the plugin config.",
    parameters: {
      cwd: { type: "string", description: "Absolute repository root; defaults to the current working directory." },
      repo: { type: "string", description: "owner/name; defaults to the origin remote." },
      days: { type: "number", description: "Lookback window in days (1-90); defaults to the configured window." },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          repository: { type: "string" },
          reportId: { type: "string" },
          findings: { type: "array", items: { type: "object", additionalProperties: true } },
          coverage: coverageSummary,
          truncated: { type: "boolean" },
        },
        additionalProperties: false,
      },
      render: (_args, value) =>
        text("Synced " + value.repository + ": " + (value.findings ?? []).length + " finding(s). Report " + value.reportId + "."),
    },
    async execute(args, exec) {
      if (!config.networkEnabled) throw new Error("network access is disabled; enable networkEnabled in the ci-diet plugin config");
      const root = args.cwd ?? process.cwd();
      const discovery = discoverWorkflows(root, { maxBytes: DEFAULT_CONFIG.storage.workflowMaxBytes });
      const workflows = discovery.workflows.map((file) => parseWorkflow(file.path, file.text));
      let owner: string;
      let repo: string;
      if (args.repo !== undefined) {
        const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(args.repo);
        if (match === null) throw new Error("invalid repository; expected owner/name");
        owner = match[1]!;
        repo = match[2]!;
      } else {
        const remote = readGithubRemote(root);
        if (remote === null) throw new Error("no GitHub origin remote found; pass repo explicitly");
        [owner, repo] = [remote.owner, remote.repository];
      }
      const days = args.days ?? DEFAULT_CONFIG.history.lookbackDays;
      if (!Number.isSafeInteger(days) || days < 1 || days > 90) throw new Error("days must be an integer between 1 and 90");
      const settings = { ...DEFAULT_CONFIG, history: { ...DEFAULT_CONFIG.history, lookbackDays: days } };
      const synced = await syncRepositoryHistory({ owner, repo, config: settings, now: new Date() });
      const binding = createLocalBinding(root, new Date().toISOString(), { repositoryFullName: synced.history.repositoryFullName }).binding;
      const built = buildHistoryReport({ binding, workflows, history: synced.history, config: settings, generatedAt: new Date().toISOString() });
      const store = PatchStore.open(stateDirOf(config));
      store.saveBinding(binding);
      store.saveReport(built.report);
      store.saveHistory(binding.bindingId, synced.history);
      const truncated = synced.history.missingScopes.some((scope) => scope.reason === "RUN_LIMIT_REACHED");
      return {
        repository: synced.history.repositoryFullName,
        reportId: built.report.reportId,
        findings: built.report.findings.map((finding) => ({
          ruleId: finding.ruleId,
          title: finding.title,
          patchability: finding.patchability,
          workflowPath: finding.workflowPath,
        })),
        coverage: coverageRows(built.report.coverage),
        truncated,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "ci_diet_report",
    description: "Read the most recent CI Diet report stored locally, without scanning or syncing again.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        properties: {
          reportId: { type: "string" },
          repository: { type: "string" },
          findings: { type: "array", items: { type: "object", additionalProperties: true } },
          metrics: metricSummary,
          coverage: coverageSummary,
        },
        additionalProperties: false,
      },
      render: (_args, value) => text("Report " + value.reportId + " for " + value.repository + " has " + (value.findings ?? []).length + " finding(s)."),
    },
    async execute(_args, exec) {
      exec.signal.throwIfAborted();
      const store = PatchStore.open(stateDirOf(config));
      const report = store.latestReport();
      if (report === null) throw new Error("no report stored yet; run ci_diet_scan or ci_diet_sync first");
      const binding = store.readBinding(report.bindingId);
      return {
        reportId: report.reportId,
        repository: binding?.repositoryFullName ?? "unknown",
        findings: report.findings.map((finding) => ({
          ruleId: finding.ruleId,
          title: finding.title,
          patchability: finding.patchability,
          workflowPath: finding.workflowPath,
        })),
        metrics: metricRows(report.metrics),
        coverage: coverageRows(report.coverage),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "ci_diet_plan",
    description:
      "Preview the exact byte edits CI Diet would make for one eligible finding. This tool never writes a file " +
      "and never approves anything; the human prints the plan with the ci-diet CLI and approves it there.",
    parameters: {
      rule: { type: "string", enum: ["CD001", "CD005", "CD008"], required: true, description: "Patch rule to preview." },
      workflow: { type: "string", description: "Workflow path relative to the repository root." },
      job: { type: "string", description: "Job key, required for CD005 and CD008." },
      step: { type: "number", description: "Step index, required for CD008." },
      minutes: { type: "number", description: "Timeout in minutes, required for CD005." },
      cwd: { type: "string", description: "Absolute repository root; defaults to the current working directory." },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          workflowPath: { type: "string" },
          edits: { type: "array", items: { type: "object", additionalProperties: true } },
          writeAllowed: { type: "boolean" },
          coverageLevel: { type: "string" },
          blockers: { type: "array", items: { type: "string" } },
          nextCommand: { type: "string" },
        },
        additionalProperties: false,
      },
      render: (_args, value) =>
        text((value.edits ?? []).length + " edit(s) proposed for " + value.workflowPath + ". " +
          (value.writeAllowed ? "The human can approve this with: " + value.nextCommand : "Blocked: " + (value.blockers ?? []).join(", "))),
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const store = PatchStore.open(stateDirOf(config));
      const report = store.latestReport();
      if (report === null) throw new Error("no report stored yet; run ci_diet_scan or ci_diet_sync first");
      const binding = store.readBinding(report.bindingId);
      if (binding === null) throw new Error("report has no binding; re-run ci_diet_scan");
      const rule = args.rule as RuleId;
      const discovery = discoverWorkflows(binding.workspaceRoot, { maxBytes: DEFAULT_CONFIG.storage.workflowMaxBytes });
      const candidates = report.findings.filter((finding) => finding.ruleId === rule).map((finding) => finding.workflowPath);
      const workflowPath = args.workflow !== undefined
        ? args.workflow.replace(/\\/g, "/")
        : [...new Set(candidates)].length === 1
          ? [...new Set(candidates)][0]!
          : discovery.workflows.length === 1
            ? discovery.workflows[0]!.path
            : null;
      if (workflowPath === null) throw new Error("workflow is required; several workflow files have eligible findings");
      const file = discovery.workflows.find((entry) => entry.path === workflowPath);
      if (file === undefined) throw new Error("workflow not found: " + workflowPath);
      const workflow = parseWorkflow(file.path, file.text);
      if (workflow.parseError !== null || workflow.unsupported.length > 0) throw new Error("workflow cannot be edited safely: " + file.path);
      const coverage = composeCoverage(report.coverage, rule, { currentDefinitionParsed: true, editedJobEvidenceComplete: rule !== "CD005" });
      const blockers: string[] = [];
      const edits = [] as { kind: string; startByte: number; endByte: number; replacementUtf8: string; semanticPath: string }[];
      const findings = report.findings.filter((finding) => finding.ruleId === rule && finding.workflowPath === workflowPath);
      if (!findings.some((finding) => finding.patchability !== "blocked")) blockers.push("NO_ELIGIBLE_FINDING");
      if (!coverage.writeAllowed) blockers.push("COVERAGE_" + coverage.level.toUpperCase());
      const job: WorkflowJob | undefined = args.job === undefined ? undefined : workflow.jobs.find((entry) => entry.key === args.job);
      if (rule === "CD001") {
        if (workflow.concurrency !== null) blockers.push("EXISTING_CONCURRENCY");
        else {
          const result = planConcurrencyEdit(file.text, workflow, binding.repositoryId);
          if (result.edit === null) blockers.push(result.error?.code ?? "EDIT_NOT_APPLICABLE");
          else edits.push(result.edit);
        }
      } else if (rule === "CD005") {
        if (job === undefined || args.minutes === undefined) blockers.push("JOB_AND_MINUTES_REQUIRED");
        else {
          const result = planTimeoutEdit(file.text, workflow, job, args.minutes);
          if (result.edit === null) blockers.push(result.error?.code ?? "EDIT_NOT_APPLICABLE");
          else edits.push(result.edit);
        }
      } else {
        if (job === undefined || args.step === undefined) blockers.push("JOB_AND_STEP_REQUIRED");
        else {
          const step = job.steps[args.step];
          if (step === undefined) blockers.push("STEP_NOT_FOUND");
          else {
            const result = planRetentionEdit(file.text, job, step, 7);
            if (result.edit === null) blockers.push(result.error?.code ?? "EDIT_NOT_APPLICABLE");
            else edits.push(result.edit);
          }
        }
      }
      const nextCommand = "ci-diet plan --rule " + rule + " --workflow " + workflowPath +
        (args.job === undefined ? "" : " --job " + args.job) +
        (args.step === undefined ? "" : " --step " + args.step) +
        (args.minutes === undefined ? "" : " --minutes " + args.minutes);
      return {
        workflowPath,
        edits,
        writeAllowed: coverage.writeAllowed && blockers.length === 0,
        coverageLevel: coverage.level,
        blockers,
        nextCommand,
      };
    },
  }));
}

export default { name, inject, Config, apply };