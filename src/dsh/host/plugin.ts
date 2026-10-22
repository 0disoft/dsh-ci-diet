import { existsSync, realpathSync } from "node:fs";
import type { Context, Volatile } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { defaultPluginSettings, engineSettingsOf } from "../../core/config/plugin-settings.ts";
import type { PluginSettingsValues } from "../../core/config/plugin-settings.ts";
import { HISTORY_CONCURRENT_REQUESTS_MAX, HISTORY_CONCURRENT_REQUESTS_MIN, HISTORY_LOOKBACK_DAYS_MAX, HISTORY_LOOKBACK_DAYS_MIN } from "../../core/policy/constants.ts";
import { buildHistoryReport } from "../../core/analysis/report.ts";
import { AXIS_NAMES, RULE_IDS } from "../../core/model/domain.ts";
import { DEFAULT_ENABLED_RULES } from "../../core/rules/index.ts";
import type { RuleId } from "../../core/model/domain.ts";
import type { Coverage, Dimension } from "../../core/contracts/schema.ts";
import { PatchStore } from "../../core/patch/store.ts";
import { PROPOSED_RETENTION_DAYS } from "../../core/patch/edits.ts";
import type { ByteEdit } from "../../core/contracts/schema.ts";
import { claimsFromTokens } from "../../core/patch/eligibility.ts";
import type { PatchRule } from "../../core/patch/eligibility.ts";
import { buildRequestedPlan } from "../../core/patch/request-plan.ts";
import { findFindingForRequest, targetReasons } from "../../core/patch/target.ts";
import type { PlanRequest } from "../../core/patch/target.ts";
import { createLocalBinding, lookupGithubRemote } from "../../core/scan/binding.ts";
import { discoverWorkflows } from "../../core/scan/discover.ts";
import { runStaticScan } from "../../core/scan/scan.ts";
import { defaultStateDir } from "../../core/state/paths.ts";
import { syncRepositoryHistory } from "../../core/history/sync.ts";
import { parseWorkflow } from "../../core/workflow/parse.ts";
import { localizedFinding } from "../../core/report/localize.ts";
import { resolveRequestedLocale } from "../../shared/i18n/host.ts";
import { createTranslator } from "../../shared/i18n/index.ts";
export const name = "ci-diet";
export const inject = ["tools"];

/**
 * Live settings. Every engine-facing value is volatile: the Settings page and
 * the Plugins page edit the same reference, and the next tool call reads it.
 */
export interface Config {
  networkEnabled: Volatile<boolean>;
  /** Reserved for applying plans from the Web UI; not a settings surface yet. */
  localApplyEnabled: boolean;
  stateDir: Volatile<string>;
  rules: Volatile<readonly RuleId[]>;
  historyLookbackDays: Volatile<number>;
  historyMaxRuns: Volatile<number>;
  historyMaxRequests: Volatile<number>;
  historyConcurrentRequests: Volatile<number>;
  historyRequestTimeoutMs: Volatile<number>;
  storageStoreMaxBytes: Volatile<number>;
  storageWorkflowMaxBytes: Volatile<number>;
  storageCacheMaxBytes: Volatile<number>;
  storageCacheDays: Volatile<number>;
  storageReportDays: Volatile<number>;
  storagePlanDays: Volatile<number>;
  billingEnabled: Volatile<boolean>;
  billingIncludedMinutes: Volatile<number>;
  billingAccountMinutesUsed: Volatile<number>;
}

const SHIPPED = defaultPluginSettings();

const RULE_SCHEMA = Schema.union(RULE_IDS.map((ruleId) => Schema.const(ruleId)));

export const Config = Schema.object({
  networkEnabled: Schema.boolean().default(SHIPPED.networkEnabled).volatile(),
  localApplyEnabled: Schema.boolean().default(false),
  stateDir: Schema.string().default(SHIPPED.stateDir).volatile(),
  // The contract lives in the schema itself: a save that disables every rule is
  // rejected here, before the next tool call has to fail.
  rules: Schema.array(RULE_SCHEMA).min(1).default([...DEFAULT_ENABLED_RULES]).volatile(),
  historyLookbackDays: Schema.number().min(HISTORY_LOOKBACK_DAYS_MIN).max(HISTORY_LOOKBACK_DAYS_MAX).step(1).default(SHIPPED.historyLookbackDays).volatile(),
  historyMaxRuns: Schema.number().min(1).step(1).default(SHIPPED.historyMaxRuns).volatile(),
  historyMaxRequests: Schema.number().min(1).step(1).default(SHIPPED.historyMaxRequests).volatile(),
  historyConcurrentRequests: Schema.number().min(HISTORY_CONCURRENT_REQUESTS_MIN).max(HISTORY_CONCURRENT_REQUESTS_MAX).step(1).default(SHIPPED.historyConcurrentRequests).volatile(),
  historyRequestTimeoutMs: Schema.number().min(1).step(1).default(SHIPPED.historyRequestTimeoutMs).volatile(),
  storageStoreMaxBytes: Schema.number().min(0).step(1).default(SHIPPED.storageStoreMaxBytes).volatile(),
  storageWorkflowMaxBytes: Schema.number().min(0).step(1).default(SHIPPED.storageWorkflowMaxBytes).volatile(),
  storageCacheMaxBytes: Schema.number().min(0).step(1).default(SHIPPED.storageCacheMaxBytes).volatile(),
  storageCacheDays: Schema.number().min(0).step(1).default(SHIPPED.storageCacheDays).volatile(),
  storageReportDays: Schema.number().min(0).step(1).default(SHIPPED.storageReportDays).volatile(),
  storagePlanDays: Schema.number().min(0).step(1).default(SHIPPED.storagePlanDays).volatile(),
  billingEnabled: Schema.boolean().default(SHIPPED.billingEnabled).volatile(),
  billingIncludedMinutes: Schema.number().min(0).step(1).default(SHIPPED.billingIncludedMinutes).volatile(),
  billingAccountMinutesUsed: Schema.number().min(0).step(1).default(SHIPPED.billingAccountMinutesUsed).volatile(),
});

/** Read every engine-facing setting from its live reference. */
export function readPluginSettings(config: Config): PluginSettingsValues {
  return {
    networkEnabled: config.networkEnabled.get(),
    stateDir: config.stateDir.get(),
    rules: [...config.rules.get()],
    historyLookbackDays: config.historyLookbackDays.get(),
    historyMaxRuns: config.historyMaxRuns.get(),
    historyMaxRequests: config.historyMaxRequests.get(),
    historyConcurrentRequests: config.historyConcurrentRequests.get(),
    historyRequestTimeoutMs: config.historyRequestTimeoutMs.get(),
    storageStoreMaxBytes: config.storageStoreMaxBytes.get(),
    storageWorkflowMaxBytes: config.storageWorkflowMaxBytes.get(),
    storageCacheMaxBytes: config.storageCacheMaxBytes.get(),
    storageCacheDays: config.storageCacheDays.get(),
    storageReportDays: config.storageReportDays.get(),
    storagePlanDays: config.storagePlanDays.get(),
    billingEnabled: config.billingEnabled.get(),
    billingIncludedMinutes: config.billingIncludedMinutes.get(),
    billingAccountMinutesUsed: config.billingAccountMinutesUsed.get(),
  };
}

function stateDirOf(config: Config): string {
  const stateDir = config.stateDir.get();
  return stateDir === "" ? defaultStateDir() : stateDir;
}

/** True when history collection stopped early; the model must not treat the window as complete. */
export function isHistoryTruncated(coverage: Pick<Dimension, "status" | "reasons">): boolean {
  return coverage.status === "partial" || coverage.reasons.some((reason) => reason === "RUN_LIMIT_REACHED" || reason === "ARTIFACT_RUN_LIMIT_REACHED");
}

const SHELL_SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quote one argument for the shell the copied command will be pasted into.
 * The path is user-controlled, so it must never reach a shell as syntax.
 */
export function shellQuoteArg(value: string, platform: NodeJS.Platform = process.platform): string {
  if (SHELL_SAFE_ARG.test(value)) return value;
  if (platform === "win32") {
    // Windows agents paste into PowerShell, where single quotes suppress all expansion
    // and a literal single quote is written by doubling it.
    return "'" + value.replaceAll("'", "''") + "'";
  }
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export interface NextCommandInput {
  rule: string;
  workflowPath: string;
  job?: string | undefined;
  step?: number | undefined;
  minutes?: number | undefined;
  claims?: readonly string[] | undefined;
}

/** Build the argv-style command a human copies, with every value shell-quoted. */
export function buildNextCommand(input: NextCommandInput, platform: NodeJS.Platform = process.platform): string {
  const argv: string[] = ["ci-diet", "plan", "--rule", input.rule, "--workflow", input.workflowPath];
  if (input.job !== undefined) argv.push("--job", input.job);
  if (input.step !== undefined) argv.push("--step", String(input.step));
  if (input.minutes !== undefined) argv.push("--minutes", String(input.minutes));
  if ((input.claims ?? []).length > 0) argv.push("--claims", (input.claims ?? []).join(","));
  return argv.map((arg) => shellQuoteArg(arg, platform)).join(" ");
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
  // The registry captures this text at mount time; a live locale switch needs a reload.
  const locale = resolveRequestedLocale(null, process.env);
  const t = createTranslator(locale);
  ctx.tools.register(defineTool({
    name: "ci_diet_scan",
    description: t("dsh.scan.description"),
    parameters: {
      cwd: { type: "string", description: t("dsh.param.cwd") },
      rules: { type: "array", items: { type: "string", enum: [...RULE_IDS] }, description: t("dsh.param.rules") },
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
        text(t("dsh.scan.render", {
          parsed: value.workflowsParsed ?? 0,
          total: value.workflowsTotal ?? 0,
          findings: (value.findings ?? []).length,
          report: value.reportId ?? "",
        })),
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const settings = engineSettingsOf(readPluginSettings(config));
      const root = args.cwd ?? process.cwd();
      const rules = (args.rules as readonly RuleId[] | undefined) ?? settings.enabledRules;
      const scan = runStaticScan({ workspaceRoot: root, enabledRules: rules, maxWorkflowBytes: settings.config.storage.workflowMaxBytes });
      if (!existsSync(root)) throw new Error("workspace does not exist: " + root);
      const store = PatchStore.open(stateDirOf(config), settings.config.storage);
      store.saveBinding(scan.binding);
      store.saveReport(scan.report);
      return {
        root: scan.binding.workspaceRoot,
        reportId: scan.report.reportId,
        workflowsParsed: scan.workflows.length,
        workflowsTotal: scan.workflows.length + scan.skipped.length,
        findings: scan.report.findings.map((finding) => ({
          ruleId: finding.ruleId,
          title: localizedFinding(finding, locale).title,
          patchability: finding.patchability,
          workflowPath: finding.workflowPath,
        })),
        coverage: coverageRows(scan.report.coverage),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "ci_diet_sync",
    description: t("dsh.sync.description"),
    parameters: {
      cwd: { type: "string", description: t("dsh.param.cwd") },
      repo: { type: "string", description: t("dsh.param.repo") },
      days: { type: "number", description: t("dsh.param.days") },
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
        text(t("dsh.sync.render", { repository: value.repository ?? "", findings: (value.findings ?? []).length, report: value.reportId ?? "" })),
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const settings = engineSettingsOf(readPluginSettings(config));
      if (!settings.networkEnabled) throw new Error("network access is disabled; enable networkEnabled in the ci-diet settings");
      const root = args.cwd ?? process.cwd();
      const discovery = discoverWorkflows(root, { maxBytes: settings.config.storage.workflowMaxBytes });
      const workflows = discovery.workflows.map((file) => parseWorkflow(file.path, file.text));
      let owner: string;
      let repo: string;
      if (args.repo !== undefined) {
        const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(args.repo);
        if (match === null) throw new Error("invalid repository; expected owner/name");
        owner = match[1]!;
        repo = match[2]!;
      } else {
        const lookup = lookupGithubRemote(root);
        if (lookup.kind === "error") {
          const detail = lookup.error instanceof Error ? lookup.error.message : String(lookup.error);
          throw new Error("could not read the GitHub origin remote: " + detail);
        }
        if (lookup.kind === "none") throw new Error("no GitHub origin remote found; pass repo explicitly");
        [owner, repo] = [lookup.remote.owner, lookup.remote.repository];
      }
      const days = args.days ?? settings.config.history.lookbackDays;
      if (!Number.isSafeInteger(days) || days < HISTORY_LOOKBACK_DAYS_MIN || days > HISTORY_LOOKBACK_DAYS_MAX) throw new Error("days must be an integer between " + HISTORY_LOOKBACK_DAYS_MIN + " and " + HISTORY_LOOKBACK_DAYS_MAX);
      const syncConfig = { ...settings.config, history: { ...settings.config.history, lookbackDays: days } };
      const synced = await syncRepositoryHistory({ owner, repo, config: syncConfig, now: new Date(), signal: exec.signal });
      exec.signal.throwIfAborted();
      const binding = createLocalBinding(root, new Date().toISOString(), { repositoryFullName: synced.history.repositoryFullName }).binding;
      const built = buildHistoryReport({ binding, workflows, history: synced.history, config: syncConfig, enabledRules: settings.enabledRules, generatedAt: new Date().toISOString() });
      exec.signal.throwIfAborted();
      const store = PatchStore.open(stateDirOf(config), settings.config.storage);
      // An older overlapping sync must not publish its binding, history, or report.
      store.saveHistorySnapshot(binding, synced.history, built.report);
      const truncated = isHistoryTruncated(synced.history.coverage.history);
      return {
        repository: synced.history.repositoryFullName,
        reportId: built.report.reportId,
        findings: built.report.findings.map((finding) => ({
          ruleId: finding.ruleId,
          title: localizedFinding(finding, locale).title,
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
    description: t("dsh.report.description"),
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
      render: (_args, value) => text(t("dsh.report.render", { report: value.reportId ?? "", repository: value.repository ?? "", findings: (value.findings ?? []).length })),
    },
    async execute(_args, exec) {
      exec.signal.throwIfAborted();
      const settings = engineSettingsOf(readPluginSettings(config));
      const store = PatchStore.open(stateDirOf(config), settings.config.storage);
      const report = store.latestReport();
      if (report === null) throw new Error("no report stored yet; run ci_diet_scan or ci_diet_sync first");
      const binding = store.readBinding(report.bindingId);
      return {
        reportId: report.reportId,
        repository: binding?.repositoryFullName ?? "unknown",
        findings: report.findings.map((finding) => ({
          ruleId: finding.ruleId,
          title: localizedFinding(finding, locale).title,
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
    description: t("dsh.plan.description"),
    parameters: {
      rule: { type: "string", enum: ["CD001", "CD005", "CD008"], required: true, description: t("dsh.param.rule") },
      workflow: { type: "string", description: t("dsh.param.workflow") },
      job: { type: "string", description: t("dsh.param.job") },
      step: { type: "number", description: t("dsh.param.step") },
      minutes: { type: "number", description: t("dsh.param.minutes") },
      cwd: { type: "string", description: t("dsh.param.cwd") },
      claims: {
        type: "array",
        items: { type: "string" },
        description:
          "Human attestation claims for this preview only: ci-only, replace-safe, artifact-purpose:temporary|release, " +
          "consumer-min-days:N, reviewed-opaque-nodes. The tool never approves anything.",
      },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          workflowPath: { type: "string" },
          edits: { type: "array", items: { type: "object", additionalProperties: true } },
          planDigest: { type: "string", description: t("dsh.param.planDigest") },
          writeAllowed: { type: "boolean" },
          coverageLevel: { type: "string" },
          blockers: { type: "array", items: { type: "string" } },
          nextCommand: { type: "string" },
        },
        additionalProperties: false,
      },
      render: (_args, value) =>
        text(value.writeAllowed
          ? t("dsh.plan.render", { edits: (value.edits ?? []).length, workflow: value.workflowPath ?? "", command: value.nextCommand ?? "" })
          : t("dsh.plan.blocked", { edits: (value.edits ?? []).length, workflow: value.workflowPath ?? "", blockers: (value.blockers ?? []).join(", ") })),
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const settings = engineSettingsOf(readPluginSettings(config));
      const store = PatchStore.open(stateDirOf(config), settings.config.storage);
      const now = new Date();
      const root = realpathSync(args.cwd ?? process.cwd());
      const existing = store.findBindingByRoot(root);
      const current = existing ?? createLocalBinding(root, now.toISOString()).binding;
      const report = store.latestReportForBinding(current.bindingId);
      if (report === null) throw new Error("no report stored for this workspace; run ci_diet_scan or ci_diet_sync in it first");
      const binding = store.readBinding(report.bindingId) ?? current;
      const history = store.readLatestHistory(binding.bindingId);
      const rule = args.rule as PatchRule;
      const discovery = discoverWorkflows(binding.workspaceRoot, { maxBytes: settings.config.storage.workflowMaxBytes });
      const candidates = [...new Set(report.findings.filter((finding) => finding.ruleId === rule).map((finding) => finding.workflowPath))];
      const workflowPath = args.workflow !== undefined
        ? args.workflow.replace(/\\/g, "/")
        : candidates.length === 1
          ? candidates[0]!
          : discovery.workflows.length === 1
            ? discovery.workflows[0]!.path
            : null;
      if (workflowPath === null) throw new Error("workflow is required; several workflow files have eligible findings");
      const file = discovery.workflows.find((entry) => entry.path === workflowPath);
      if (file === undefined) throw new Error("workflow not found: " + workflowPath);
      const workflow = parseWorkflow(file.path, file.text);
      if (workflow.parseError !== null || workflow.unsupported.length > 0) throw new Error("workflow cannot be edited safely: " + file.path);

      const request: PlanRequest = {
        rule,
        jobKey: args.job ?? null,
        stepIndex: rule === "CD008" ? (args.step ?? null) : null,
        minutes: args.minutes ?? null,
        retentionDays: PROPOSED_RETENTION_DAYS,
      };
      const findings = report.findings.filter((finding) => finding.ruleId === rule && finding.workflowPath === workflowPath);
      const chosenFinding = findFindingForRequest(findings, request);
      const blockers: string[] = [];
      if (chosenFinding === null) blockers.push("FINDING_NOT_FOUND");
      else blockers.push(...targetReasons({ finding: chosenFinding, request, history, workflowText: file.text, workflow }));

      let edits: readonly ByteEdit[] = [];
      let planDigest: string | null = null;
      let coverageLevel = "skip";
      const claims = claimsFromTokens((args.claims ?? []) as string[]);
      if (chosenFinding !== null) {
        const requested = buildRequestedPlan({
          binding,
          workflow,
          text: file.text,
          rule,
          jobKey: request.jobKey,
          stepIndex: request.stepIndex,
          minutes: request.minutes,
          finding: chosenFinding,
          coverage: report.coverage,
          claims,
          history,
          evidenceRef: "dsh:plan:" + rule,
          issuedBy: { channel: "human-cli", subjectId: "dsh-session" },
          now,
          policyMaxAgeSeconds: settings.config.apply.policyMaxAgeSeconds,
          attestationTtlSeconds: settings.config.apply.attestationMaxAgeDays * 24 * 60 * 60,
        });
        edits = requested.edits;
        coverageLevel = requested.coverageLevel ?? "skip";
        if (requested.ok) {
          planDigest = requested.plan.planDigest;
        } else {
          blockers.push(requested.blocker);
          blockers.push(...requested.reasons);
        }
      }
      const nextCommand = buildNextCommand({
        rule,
        workflowPath,
        job: args.job as string | undefined,
        step: args.step as number | undefined,
        minutes: args.minutes as number | undefined,
        claims: args.claims as string[] | undefined,
      });
      return {
        workflowPath,
        edits: [...edits],
        planDigest: planDigest ?? "",
        writeAllowed: blockers.length === 0,
        coverageLevel,
        blockers,
        nextCommand,
      };
    },
  }));
}

export default { name, inject, Config, apply };