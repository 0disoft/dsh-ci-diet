#!/usr/bin/env node
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RULE_IDS } from "../core/model/domain.ts";
import type { RuleId } from "../core/model/domain.ts";
import { runStaticScan } from "../core/scan/scan.ts";
import { createLocalBinding, readGithubRemote } from "../core/scan/binding.ts";
import { discoverWorkflows } from "../core/scan/discover.ts";
import { parseWorkflow } from "../core/workflow/parse.ts";
import { syncRepositoryHistory } from "../core/history/sync.ts";
import { defaultStateDir } from "../core/state/paths.ts";
import { buildHistoryReport } from "../core/analysis/report.ts";
import { PROPOSED_RETENTION_DAYS } from "../core/rules/cd008.ts";
import { claimsFromTokens, evaluatePatchEligibility } from "../core/patch/eligibility.ts";
import { DEFAULT_CONFIG } from "../core/data/default-config.ts";
import type { Config } from "../core/contracts/schema.ts";
import type { Coverage } from "../core/contracts/schema.ts";
import type { HistoryBundle } from "../core/history/model.ts";
import { GitHubError } from "../adapters/github/errors.ts";
import { ContractViolationError } from "../core/contracts/validate.ts";
import { ENGINE_VERSION } from "../core/version.ts";
import { PatchStore } from "../core/patch/store.ts";
import type { PlanMeta } from "../core/patch/store.ts";
import { buildPatchPlan, buildPolicySnapshots, dependencyHashOf } from "../core/patch/plan.ts";
import { collectDependencies } from "../core/patch/dependencies.ts";
import { findFindingForRequest, targetReasons } from "../core/patch/target.ts";
import type { PlanRequest } from "../core/patch/target.ts";
import { planConcurrencyEdit, planRetentionEdit, planTimeoutEdit } from "../core/patch/edits.ts";
import type { EditResult } from "../core/patch/edits.ts";
import type { ByteEdit } from "../core/contracts/schema.ts";
import { createAttestation } from "../core/patch/attestation.ts";
import { approvePlan, approvalConfirmation } from "../core/patch/approval.ts";
import { applyPlan, revertChange } from "../core/patch/apply.ts";
import { renderHtmlReport } from "../core/report/html.ts";
import { createTranslator, resolveLocale, resolveLocaleFromEnv } from "../shared/i18n/index.ts";
import type { Locale, MessageKey } from "../shared/i18n/index.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_SCHEMA = 2;
const EXIT_INCOMPLETE = 3;
const EXIT_INVARIANT = 4;
const EXIT_NONCE = 5;
const EXIT_BACKUP = 6;
const EXIT_CANCELLED = 130;

interface Options {
  readonly command: string;
  readonly cwd: string;
  readonly json: boolean;
  readonly out: string | null;
  readonly rules: readonly RuleId[] | null;
  readonly requireComplete: boolean;
  readonly lang: string | null;
  readonly help: boolean;
  readonly version: boolean;
  readonly repo: string | null;
  readonly network: boolean;
  readonly days: number | null;
  readonly stateDir: string | null;
  readonly workflow: string | null;
  readonly rule: RuleId | null;
  readonly job: string | null;
  readonly step: number | null;
  readonly minutes: number | null;
  readonly plan: string | null;
  readonly change: string | null;
  readonly confirm: string | null;
  readonly subject: string;
  readonly claims: readonly string[];
  readonly report: string | null;
  readonly format: "text" | "json" | "html";
}

class UsageError extends Error {}

function parseRepoArgument(value: string): { owner: string; repository: string } {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
  if (!match || match[1] === undefined || match[2] === undefined || match[1] === "." || match[1] === "..") {
    throw new UsageError("INVALID_VALUE:--repo");
  }
  return { owner: match[1], repository: match[2] };
}

function parseArgs(argv: readonly string[]): Options {
  let command = "";
  let cwd = process.cwd();
  let json = false;
  let out: string | null = null;
  let rules: readonly RuleId[] | null = null;
  let requireComplete = false;
  let lang: string | null = null;
  let help = false;
  let version = false;
  let repo: string | null = null;
  let network = false;
  let days: number | null = null;
  let stateDir: string | null = null;
  let workflow: string | null = null;
  let rule: RuleId | null = null;
  let job: string | null = null;
  let step: number | null = null;
  let minutes: number | null = null;
  let plan: string | null = null;
  let change: string | null = null;
  let confirm: string | null = null;
  let subject = "local-user";
  let claims: readonly string[] = [];
  let report: string | null = null;
  let format: "text" | "json" | "html" = "text";

  const takeValue = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError("MISSING_VALUE:" + flag);
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--version" || arg === "-v") {
      version = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--network") {
      network = true;
    } else if (arg === "--require-complete") {
      requireComplete = true;
    } else if (arg === "--cwd") {
      cwd = takeValue(index, "--cwd");
      index += 1;
    } else if (arg === "--out") {
      out = takeValue(index, "--out");
      index += 1;
    } else if (arg === "--lang") {
      lang = takeValue(index, "--lang");
      index += 1;
    } else if (arg === "--repo") {
      repo = takeValue(index, "--repo");
      parseRepoArgument(repo);
      index += 1;
    } else if (arg === "--days") {
      const value = takeValue(index, "--days");
      index += 1;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 90) throw new UsageError("INVALID_VALUE:--days");
      days = parsed;
    } else if (arg === "--rules") {
      const value = takeValue(index, "--rules");
      index += 1;
      const requested = value.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
      for (const entry of requested) {
        if (!(RULE_IDS as readonly string[]).includes(entry)) throw new UsageError("UNKNOWN_RULE:" + entry);
      }
      rules = requested as readonly RuleId[];
    } else if (arg === "--state-dir") {
      stateDir = resolve(takeValue(index, "--state-dir"));
      index += 1;
    } else if (arg === "--workflow") {
      workflow = takeValue(index, "--workflow");
      index += 1;
    } else if (arg === "--rule") {
      const value = takeValue(index, "--rule");
      index += 1;
      if (!(RULE_IDS as readonly string[]).includes(value)) throw new UsageError("UNKNOWN_RULE:" + value);
      rule = value as RuleId;
    } else if (arg === "--job") {
      job = takeValue(index, "--job");
      index += 1;
    } else if (arg === "--step") {
      const value = takeValue(index, "--step");
      index += 1;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) throw new UsageError("INVALID_VALUE:--step");
      step = parsed;
    } else if (arg === "--minutes") {
      const value = takeValue(index, "--minutes");
      index += 1;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1440) throw new UsageError("INVALID_VALUE:--minutes");
      minutes = parsed;
    } else if (arg === "--plan") {
      plan = takeValue(index, "--plan");
      index += 1;
    } else if (arg === "--change") {
      change = takeValue(index, "--change");
      index += 1;
    } else if (arg === "--confirm") {
      confirm = takeValue(index, "--confirm");
      index += 1;
    } else if (arg === "--subject") {
      subject = takeValue(index, "--subject");
      index += 1;
    } else if (arg === "--claims") {
      claims = takeValue(index, "--claims").split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
      index += 1;
    } else if (arg === "--report") {
      report = takeValue(index, "--report");
      index += 1;
    } else if (arg === "--format") {
      const value = takeValue(index, "--format");
      index += 1;
      if (value !== "text" && value !== "json" && value !== "html") throw new UsageError("INVALID_VALUE:--format");
      format = value;
    } else if (arg.startsWith("-")) {
      throw new UsageError("UNKNOWN_FLAG:" + arg);
    } else if (command === "") {
      command = arg;
    } else {
      throw new UsageError("UNKNOWN_COMMAND:" + arg);
    }
  }

  return {
    command,
    cwd: resolve(cwd),
    json,
    out,
    rules,
    requireComplete,
    lang,
    help,
    version,
    repo,
    network,
    days,
    stateDir,
    workflow,
    rule,
    job,
    step,
    minutes,
    plan,
    change,
    confirm,
    subject,
    claims,
    report,
    format,
  };
}

function stateDirOf(options: Options): string {
  return options.stateDir ?? defaultStateDir();
}

function resolveUiLocale(lang: string | null): Locale {
  const fromFlag = lang === null ? null : resolveLocale(lang);
  return fromFlag ?? resolveLocaleFromEnv(process.env);
}

function writeAtomically(path: string, content: string): void {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  const temporary = absolute + ".tmp-" + process.pid;
  try {
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, absolute);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function isIncomplete(coverage: Coverage): boolean {
  for (const axis of ["history", "workflowDefinitions", "changedFiles", "protectionRules", "retentionPolicy"] as const) {
    if (coverage[axis].status !== "complete") return true;
  }
  return false;
}

function reportText(reportJson: string, options: Options, lines: readonly string[]): void {
  if (options.out !== null) writeAtomically(options.out, reportJson);
  if (options.json) process.stdout.write(reportJson);
  else process.stdout.write(lines.join("\n") + "\n");
}

function scan(options: Options, locale: Locale): number {
  const t = createTranslator(locale);
  const result = runStaticScan({
    workspaceRoot: options.cwd,
    enabledRules: options.rules ?? undefined,
  });
  const { report, binding, workflows, skipped, warnings } = result;
  const parsedCount = workflows.filter((workflow) => workflow.parseError === null && workflow.unsupported.length === 0).length;

  const lines: string[] = [];
  lines.push(t("cli.scan.root", { name: binding.repositoryFullName, root: binding.workspaceRoot }));
  if (workflows.length === 0) {
    lines.push(t("cli.scan.noWorkflows"));
  } else {
    lines.push(t("cli.scan.workflows", { parsed: parsedCount, total: workflows.length }));
    lines.push(
      t("cli.scan.coverage", {
        status: report.coverage.workflowDefinitions.status,
        fetched: report.coverage.workflowDefinitions.fetched,
        expected: report.coverage.workflowDefinitions.expected ?? "?",
      }),
    );
  }

  if (report.findings.length === 0) {
    lines.push(t("cli.scan.noFindings"));
  } else {
    const ordered = [...report.findings].sort((a, b) =>
      a.ruleId === b.ruleId ? (a.workflowPath < b.workflowPath ? -1 : 1) : a.ruleId < b.ruleId ? -1 : 1,
    );
    for (const finding of ordered) {
      lines.push(t("cli.scan.finding", { rule: finding.ruleId, title: finding.title }));
    }
    lines.push(t("cli.scan.summary", { findings: report.findings.length }));
  }
  if (skipped.length > 0) lines.push(t("cli.scan.incomplete"));
  lines.push(t("cli.scan.staticNote"));
  if (options.out !== null) lines.push(t("cli.scan.written", { path: resolve(options.out) }));

  reportText(JSON.stringify(report, null, 2) + "\n", options, lines);

  for (const warning of warnings) process.stderr.write(warning + "\n");
  if (options.requireComplete && isIncomplete(report.coverage)) {
    process.stderr.write(t("cli.scan.incomplete") + "\n");
    return EXIT_INCOMPLETE;
  }
  return EXIT_OK;
}

async function sync(options: Options, locale: Locale): Promise<number> {
  const t = createTranslator(locale);
  if (!options.network) {
    process.stderr.write(t("cli.sync.networkRequired") + "\n");
    return EXIT_USAGE;
  }

  const generatedAt = new Date().toISOString();
  const discovery = discoverWorkflows(options.cwd, {});
  const workflows = discovery.workflows.map((file) => parseWorkflow(file.path, file.text));

  let owner: string;
  let repository: string;
  if (options.repo !== null) {
    const parsed = parseRepoArgument(options.repo);
    owner = parsed.owner;
    repository = parsed.repository;
  } else {
    const remote = readGithubRemote(discovery.root);
    if (remote === null) {
      process.stderr.write(t("cli.sync.repoRequired") + "\n");
      return EXIT_USAGE;
    }
    owner = remote.owner;
    repository = remote.repository;
  }

  const config: Config = options.days === null
    ? DEFAULT_CONFIG
    : { ...DEFAULT_CONFIG, history: { ...DEFAULT_CONFIG.history, lookbackDays: options.days } };

  const showProgress = process.stderr.isTTY === true && !options.json;
  let progressPrinted = false;
  const syncResult = await syncRepositoryHistory({
    owner,
    repo: repository,
    config,
    now: new Date(),
    ...(showProgress
      ? {
          onProgress: (progress: { runsProcessed: number; runsTotal: number; jobsFetched: number }) => {
            progressPrinted = true;
            process.stderr.write("\r" + t("cli.sync.progress", {
              runs: progress.runsProcessed,
              total: progress.runsTotal,
              jobs: progress.jobsFetched,
            }));
          },
        }
      : {}),
  });
  if (progressPrinted) process.stderr.write("\r" + " ".repeat(72) + "\r");
  const history = syncResult.history;
  const upgraded = createLocalBinding(discovery.root, generatedAt, { repositoryFullName: history.repositoryFullName });
  const built = buildHistoryReport({
    binding: upgraded.binding,
    workflows,
    history,
    config,
    generatedAt,
    ...(options.rules === null ? {} : { enabledRules: options.rules }),
  });
  const report = built.report;

  const store = PatchStore.open(stateDirOf(options));
  store.saveBinding(upgraded.binding);
  store.saveReport(report);
  store.saveHistory(upgraded.binding.bindingId, history);

  const lines: string[] = [];
  lines.push(t("cli.sync.root", { name: history.repositoryFullName, root: upgraded.binding.workspaceRoot }));
  lines.push(
    t("cli.sync.window", {
      runs: history.runs.length,
      jobs: history.runs.reduce((total, run) => total + run.jobs.length, 0),
      from: history.requestedFrom,
      to: history.requestedTo,
    }),
  );
  lines.push(
    t("cli.sync.coverage", {
      history: report.coverage.history.status,
      definitions: report.coverage.workflowDefinitions.status,
      changedFiles: report.coverage.changedFiles.status,
    }),
  );
  if (report.findings.length === 0) {
    lines.push(t("cli.scan.noFindings"));
  } else {
    for (const finding of report.findings) {
      lines.push(t("cli.scan.finding", { rule: finding.ruleId, title: finding.title }));
    }
    lines.push(t("cli.scan.summary", { findings: report.findings.length }));
  }
  if (isIncomplete(report.coverage)) lines.push(t("cli.scan.incomplete"));
  lines.push(t("cli.sync.note"));
  if (options.out !== null) lines.push(t("cli.sync.written", { path: resolve(options.out) }));

  reportText(JSON.stringify(report, null, 2) + "\n", options, lines);

  if (options.requireComplete && isIncomplete(report.coverage)) {
    process.stderr.write(t("cli.scan.incomplete") + "\n");
    return EXIT_INCOMPLETE;
  }
  return EXIT_OK;
}

function requireEdit(result: EditResult): ByteEdit {
  if (result.edit === null) throw new UsageError("INVALID_VALUE:edit");
  return result.edit;
}

function pickWorkflowPath(options: Options, available: readonly string[]): string {
  if (options.workflow !== null) {
    const path = options.workflow.replace(/\\/g, "/");
    if (!available.includes(path)) throw new UsageError("INVALID_VALUE:--workflow");
    return path;
  }
  if (available.length === 1 && available[0] !== undefined) return available[0];
  throw new UsageError("MISSING_VALUE:--workflow");
}

async function planCommand(options: Options, locale: Locale): Promise<number> {
  const t = createTranslator(locale);
  const stateDir = stateDirOf(options);
  const store = existsSync(stateDir) ? PatchStore.open(stateDir) : null;
  if (store === null) {
    process.stderr.write(t("cli.plan.syncRequired") + "\n");
    return EXIT_USAGE;
  }
  const now = new Date();
  const root = realpathSync(options.cwd);
  const existing = store.findBindingByRoot(root);
  const current = existing ?? createLocalBinding(root, now.toISOString()).binding;
  const report = store.latestReportForBinding(current.bindingId);
  if (report === null) {
    process.stderr.write(t("cli.plan.syncRequired") + "\n");
    return EXIT_USAGE;
  }
  const binding = store.readBinding(report.bindingId) ?? current;
  const rule = options.rule;
  if (rule !== "CD001" && rule !== "CD005" && rule !== "CD008") {
    process.stderr.write(t("cli.plan.ruleRequired") + "\n");
    return EXIT_USAGE;
  }
  const discovery = discoverWorkflows(binding.workspaceRoot, {});
  const workflowPath = pickWorkflowPath(options, discovery.workflows.map((file) => file.path));
  const file = discovery.workflows.find((entry) => entry.path === workflowPath);
  if (file === undefined) {
    process.stderr.write(t("cli.plan.syncRequired") + "\n");
    return EXIT_USAGE;
  }
  if (file.text.length > 512 * 1024) {
    process.stderr.write(t("cli.plan.workflowTooLarge") + "\n");
    return EXIT_USAGE;
  }
  const workflow = parseWorkflow(file.path, file.text);
  if (workflow.parseError !== null || workflow.unsupported.length > 0) {
    process.stderr.write(t("cli.plan.unsupported") + "\n");
    return EXIT_USAGE;
  }

  const historyJson: HistoryBundle | null = store.readLatestHistory(binding.bindingId);
  if (historyJson === null) {
    process.stderr.write(t("cli.plan.syncRequired") + "\n");
    return EXIT_USAGE;
  }

  const request: PlanRequest = {
    rule,
    jobKey: options.job,
    stepIndex: rule === "CD008" ? options.step : null,
    minutes: options.minutes,
    retentionDays: PROPOSED_RETENTION_DAYS,
  };
  const candidates = report.findings.filter((entry) => entry.ruleId === rule && entry.workflowPath === workflowPath);
  const chosenFinding = findFindingForRequest(candidates, request);
  if (chosenFinding === null) {
    process.stderr.write(t("cli.plan.notTarget", { rule, target: options.job ?? "workflow" }) + "\n");
    process.stderr.write("  - FINDING_NOT_FOUND\n");
    return EXIT_INCOMPLETE;
  }
  const targetProblems = targetReasons({
    finding: chosenFinding,
    request,
    history: historyJson,
    workflowText: file.text,
    workflow,
  });
  if (targetProblems.length > 0) {
    process.stderr.write(t("cli.plan.notEligible", { rule }) + "\n");
    for (const problem of targetProblems) process.stderr.write("  - " + problem + "\n");
    if (targetProblems.includes("WORKFLOW_HASH_MISMATCH")) process.stderr.write(t("cli.plan.staleEvidence") + "\n");
    return EXIT_INCOMPLETE;
  }

  let edits: ByteEdit[] = [];
  let scope: "workflow" | "job" | "step" = "workflow";
  let jobKey: string | null = null;
  let stepKey: string | null = null;
  let expected: { group?: string; minutes?: number; days?: number } = {};
  if (rule === "CD001") {
    if (workflow.concurrency !== null) {
      process.stderr.write(t("cli.plan.existingConcurrency") + "\n");
      return EXIT_USAGE;
    }
    edits = [requireEdit(planConcurrencyEdit(file.text, workflow, binding.repositoryId))];
    const group = edits[0]?.replacementUtf8.split("group: ")[1]?.trim() ?? "";
    expected = { group };
  } else if (rule === "CD005") {
    const job = workflow.jobs.find((entry) => entry.key === options.job);
    if (job === undefined || options.minutes === null) {
      process.stderr.write(t("cli.plan.jobRequired") + "\n");
      return EXIT_USAGE;
    }
    edits = [requireEdit(planTimeoutEdit(file.text, workflow, job, options.minutes))];
    scope = "job";
    jobKey = job.key;
    expected = { minutes: options.minutes };
  } else {
    const job = workflow.jobs.find((entry) => entry.key === options.job);
    const step = job?.steps[options.step ?? -1];
    if (job === undefined || step === undefined || options.step === null) {
      process.stderr.write(t("cli.plan.stepRequired") + "\n");
      return EXIT_USAGE;
    }
    const days = PROPOSED_RETENTION_DAYS;
    edits = [requireEdit(planRetentionEdit(file.text, job, step, days))];
    scope = "step";
    jobKey = job.key;
    stepKey = "steps[" + options.step + "]";
    expected = { days };
  }

  const dependencies = collectDependencies(binding.workspaceRoot, workflow);
  const attestation = createAttestation({
    bindingId: binding.bindingId,
    workflowPath: file.path,
    workflowHash: workflow.sha256,
    dependencyHash: dependencyHashOf(dependencies),
    scope,
    jobKey,
    stepKey,
    claims: claimsFromTokens(options.claims),
    evidenceRefs: ["cli:plan:" + rule],
    issuedBy: { channel: "human-cli", subjectId: options.subject },
    now,
  });

  const eligibility = evaluatePatchEligibility({
    rule,
    finding: chosenFinding,
    coverage: report.coverage,
    claims: attestation.claims,
    history: historyJson,
    currentDefinitionParsed: true,
    editedJobEvidenceComplete: true,
    now,
  });
  if (!eligibility.allowed) {
    process.stderr.write(t("cli.plan.notEligible", { rule }) + "\n");
    for (const reason of eligibility.reasons) process.stderr.write("  - " + reason + "\n");
    return EXIT_INCOMPLETE;
  }
  store.saveAttestation(attestation);

  const policies = buildPolicySnapshots({
    binding,
    protection: historyJson.protection,
    retention: historyJson.retention,
    now,
  });

  const built = buildPatchPlan({
    binding,
    workflow,
    text: file.text,
    edits,
    attestations: [attestation],
    policies,
    blockers: eligibility.remainingBlockers,
    coverageWriteAllowed: true,
    now,
    dependencies,
    expected,
  });

  const plan = built.plan;
  const meta: PlanMeta = { coverageWriteAllowed: true, reportId: report.reportId };
  store.savePlan(plan, meta);

  const lines: string[] = [];
  lines.push(t("cli.plan.created", { plan: plan.planId, workflow: file.path, rule }));
  lines.push(t("cli.plan.target", { path: join(binding.workspaceRoot, file.path) }));
  lines.push(t("cli.plan.digest", { digest: plan.planDigest }));
  lines.push(t("cli.plan.confirm", { confirmation: approvalConfirmation(plan) }));
  lines.push(t("cli.plan.next", { plan: plan.planId }));
  if (options.out !== null) lines.push(t("cli.scan.written", { path: resolve(options.out) }));
  reportText(JSON.stringify(plan, null, 2) + "\n", options, lines);
  return EXIT_OK;
}

function approveCommand(options: Options, locale: Locale): number {
  const t = createTranslator(locale);
  if (options.plan === null || options.confirm === null) {
    process.stderr.write(t("cli.approve.usage") + "\n");
    return EXIT_USAGE;
  }
  const store = PatchStore.open(stateDirOf(options));
  const result = approvePlan({
    store,
    planId: options.plan,
    confirmation: options.confirm,
    subjectId: options.subject,
    channel: "human-cli",
    now: new Date(),
  });
  const lines: string[] = [];
  lines.push(t("cli.approve.done", { plan: result.plan.planId }));
  if (options.out !== null) lines.push(t("cli.scan.written", { path: resolve(options.out) }));
  reportText(JSON.stringify(result.plan, null, 2) + "\n", options, lines);
  return EXIT_OK;
}

async function applyCommand(options: Options, locale: Locale): Promise<number> {
  const t = createTranslator(locale);
  if (options.plan === null) {
    process.stderr.write(t("cli.apply.usage") + "\n");
    return EXIT_USAGE;
  }
  const store = PatchStore.open(stateDirOf(options));
  const result = await applyPlan({ store, planId: options.plan, now: new Date(), subjectId: options.subject });
  const lines: string[] = [];
  if (result.state === "applied") {
    lines.push(t("cli.apply.done", { change: result.change?.changeId ?? "", workflow: result.change?.workflowPath ?? "" }));
  } else {
    lines.push(t("cli.apply.refused", { reasons: result.reasons.join(", ") }));
  }
  reportText(JSON.stringify({ state: result.state, reasons: result.reasons, change: result.change }, null, 2) + "\n", options, lines);
  if (result.state === "applied") return EXIT_OK;
  if (result.reasons.includes("NONCE_INVALID")) return EXIT_NONCE;
  if (result.reasons.includes("BACKUP_UNAVAILABLE")) return EXIT_BACKUP;
  return EXIT_INCOMPLETE;
}

async function revertCommand(options: Options, locale: Locale): Promise<number> {
  const t = createTranslator(locale);
  if (options.change === null) {
    process.stderr.write(t("cli.revert.usage") + "\n");
    return EXIT_USAGE;
  }
  const store = PatchStore.open(stateDirOf(options));
  const result = await revertChange({ store, changeId: options.change, now: new Date() });
  const lines: string[] = [];
  if (result.state === "REVERTED") lines.push(t("cli.revert.done", { change: options.change }));
  else lines.push(t("cli.revert.refused", { state: result.state, reason: result.reason ?? "" }));
  reportText(JSON.stringify(result, null, 2) + "\n", options, lines);
  if (result.state === "REVERTED") return EXIT_OK;
  if (result.state === "RECOVERY_REQUIRED") return EXIT_INVARIANT;
  return EXIT_INCOMPLETE;
}

function showChanged(options: Options, locale: Locale): number {
  const t = createTranslator(locale);
  const store = PatchStore.open(stateDirOf(options));
  const changes = store.listChanges();
  const lines: string[] = [];
  if (changes.length === 0) {
    lines.push(t("cli.list.empty"));
  } else {
    for (const change of changes) {
      lines.push(t("cli.list.item", {
        change: change.changeId,
        state: change.state,
        workflow: change.workflowPath,
        at: change.updatedAt,
      }));
    }
  }
  reportText(JSON.stringify(changes, null, 2) + "\n", options, lines);
  return EXIT_OK;
}

function plansList(options: Options, locale: Locale): number {
  const t = createTranslator(locale);
  const store = PatchStore.open(stateDirOf(options));
  const plans = store.listPlans().map((entry) => ({
    planId: entry.plan.planId,
    state: entry.plan.status.state,
    workflowPath: entry.plan.payload.workflowPath,
    ruleIds: entry.plan.payload.ruleIds,
    createdAt: entry.plan.payload.createdAt,
    expiresAt: entry.plan.payload.expiresAt,
  }));
  const lines: string[] = [];
  if (plans.length === 0) lines.push(t("cli.list.empty"));
  else {
    for (const plan of plans) {
      lines.push(t("cli.list.plan", { plan: plan.planId, state: plan.state, workflow: plan.workflowPath, at: plan.createdAt }));
    }
  }
  reportText(JSON.stringify(plans, null, 2) + "\n", options, lines);
  return EXIT_OK;
}

function reportCommand(options: Options, locale: Locale): number {
  const t = createTranslator(locale);
  const stateDir = stateDirOf(options);
  if (!existsSync(stateDir)) {
    process.stderr.write(t("cli.report.none") + "\n");
    return EXIT_USAGE;
  }
  const store = PatchStore.open(stateDir);
  const report = options.report === null ? store.latestReport() : store.readReport(options.report);
  if (report === null) {
    process.stderr.write(t("cli.report.none") + "\n");
    return EXIT_USAGE;
  }

  const format = options.json ? "json" : options.format;
  if (format === "html") {
    const html = renderHtmlReport(report);
    if (options.out === null) process.stdout.write(html);
    else {
      writeAtomically(options.out, html);
      process.stdout.write(t("cli.report.written", { path: resolve(options.out) }) + "\n");
    }
    return EXIT_OK;
  }
  if (format === "json") {
    const json = JSON.stringify(report, null, 2) + "\n";
    if (options.out === null) process.stdout.write(json);
    else {
      writeAtomically(options.out, json);
      process.stdout.write(t("cli.report.written", { path: resolve(options.out) }) + "\n");
    }
    return EXIT_OK;
  }

  const binding = store.readBinding(report.bindingId);
  const observed = report.metrics.observedRunnerSeconds;
  const modeled = report.metrics.modeledRoundedMinutes;
  const price = report.metrics.listPriceUsd;
  const lines: string[] = [];
  lines.push(t("cli.report.summary", {
    report: report.reportId,
    name: binding?.repositoryFullName ?? report.bindingId,
    at: report.generatedAt,
  }));
  lines.push(t("cli.report.metrics", {
    observed: observed.status === "known" ? String(observed.value) + "s" : observed.status,
    modeled: modeled.status === "known" ? String(modeled.value) + " min" : modeled.status,
    price: price.status === "known" ? String(price.value) : price.status,
  }));
  if (report.findings.length === 0) lines.push(t("cli.scan.noFindings"));
  else {
    for (const finding of report.findings) lines.push(t("cli.scan.finding", { rule: finding.ruleId, title: finding.title }));
    lines.push(t("cli.scan.summary", { findings: report.findings.length }));
  }
  if (isIncomplete(report.coverage)) lines.push(t("cli.scan.incomplete"));
  if (options.out !== null) {
    writeAtomically(options.out, lines.join("\n") + "\n");
    lines.push(t("cli.report.written", { path: resolve(options.out) }));
  }
  process.stdout.write(lines.join("\n") + "\n");
  return EXIT_OK;
}

function pruneCommand(options: Options, locale: Locale): number {
  const t = createTranslator(locale);
  const stateDir = stateDirOf(options);
  if (!existsSync(stateDir)) {
    process.stdout.write(t("cli.prune.done", { reports: 0, plans: 0, cache: 0 }) + "\n");
    return EXIT_OK;
  }
  const store = PatchStore.open(stateDir);
  const result = store.prune(new Date(), {
    reportDays: DEFAULT_CONFIG.storage.reportDays,
    planDays: DEFAULT_CONFIG.storage.planDays,
    cacheDays: DEFAULT_CONFIG.storage.cacheDays,
  });
  if (options.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  else {
    process.stdout.write(t("cli.prune.done", {
      reports: result.removedReports,
      plans: result.removedPlans,
      cache: result.removedCacheEntries,
    }) + "\n");
    process.stdout.write(t("cli.prune.freed", { bytes: result.bytesFreed }) + "\n");
  }
  return EXIT_OK;
}

const HELP_KEYS: Record<string, MessageKey> = {
  scan: "cli.usage",
  sync: "cli.sync.help",
  plan: "cli.plan.help",
  approve: "cli.approve.help",
  apply: "cli.apply.help",
  revert: "cli.revert.help",
  changes: "cli.list.help",
  plans: "cli.list.help",
  report: "cli.report.help",
  prune: "cli.prune.help",
};

function usageMessage(error: UsageError, argv: readonly string[]): string {
  const [code = "", suffix = ""] = error.message.split(":", 2);
  const flagIndex = argv.indexOf("--lang");
  const lang = flagIndex === -1 ? null : (argv[flagIndex + 1] ?? null);
  const t = createTranslator(resolveUiLocale(lang));
  if (code === "UNKNOWN_RULE") return t("cli.unknownRule", { rule: suffix });
  if (code === "MISSING_VALUE") return t("cli.missingValue", { flag: suffix });
  if (code === "UNKNOWN_COMMAND") return t("cli.unknownCommand", { command: suffix });
  if (code === "UNKNOWN_FLAG") return t("cli.unknownFlag", { flag: suffix });
  if (code === "INVALID_VALUE") return t("cli.invalidValue", { flag: suffix });
  return suffix === "" ? code : suffix;
}

function mapError(error: unknown, t: ReturnType<typeof createTranslator>): number {
  if (error instanceof ContractViolationError) {
    process.stderr.write(t("error.SCHEMA_INVALID") + " " + error.message + "\n");
    return EXIT_SCHEMA;
  }
  if (error instanceof GitHubError) {
    if (error.code === "AUTH_REQUIRED") {
      process.stderr.write(t("error.AUTH_REQUIRED") + "\n");
      return EXIT_INCOMPLETE;
    }
    if (error.code === "BUDGET_EXHAUSTED") {
      process.stderr.write(t("error.REQUEST_BUDGET_EXHAUSTED") + "\n");
      return EXIT_INCOMPLETE;
    }
    process.stderr.write(t("cli.error.prefix") + " " + error.code + ": " + error.message + "\n");
    return EXIT_USAGE;
  }
  if (error instanceof Error && error.message.startsWith("NONCE_INVALID")) {
    process.stderr.write(t("cli.error.prefix") + " " + error.message + "\n");
    return EXIT_NONCE;
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(t("cli.error.prefix") + " " + message + "\n");
  return EXIT_USAGE;
}

export async function main(argv: readonly string[]): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write("error: " + usageMessage(error, argv) + "\n");
      return EXIT_USAGE;
    }
    throw error;
  }

  const locale = resolveUiLocale(options.lang);
  const t = createTranslator(locale);

  if (options.version) {
    process.stdout.write("ci-diet " + ENGINE_VERSION + "\n");
    return EXIT_OK;
  }
  if (options.help || options.command === "") {
    const key = HELP_KEYS[options.command] ?? "cli.usage";
    process.stdout.write(t(key) + "\n");
    return options.help ? EXIT_OK : EXIT_USAGE;
  }

  try {
    if (options.command === "scan") return scan(options, locale);
    if (options.command === "sync") return await sync(options, locale);
    if (options.command === "plan") return await planCommand(options, locale);
    if (options.command === "approve") return approveCommand(options, locale);
    if (options.command === "apply") return await applyCommand(options, locale);
    if (options.command === "revert") return await revertCommand(options, locale);
    if (options.command === "changes") return showChanged(options, locale);
    if (options.command === "plans") return plansList(options, locale);
    if (options.command === "report") return reportCommand(options, locale);
    if (options.command === "prune") return pruneCommand(options, locale);
  } catch (error) {
    return mapError(error, t);
  }
  process.stderr.write(t("cli.unknownCommand", { command: options.command }) + "\n");
  return EXIT_USAGE;
}

const invokedDirectly = process.argv[1] !== undefined && /(?:^|[\\/])cli(?:[\\/]index)?\.[cm]?[jt]s$/.test(process.argv[1]);
if (invokedDirectly) {
  process.on("SIGINT", () => {
    process.exit(EXIT_CANCELLED);
  });
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + "\n");
      process.exitCode = EXIT_USAGE;
    },
  );
}