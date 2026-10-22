#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { systemClock } from "../core/support/clock.ts";
import type { Clock } from "../core/support/clock.ts";
import { RULE_IDS } from "../core/model/domain.ts";
import type { RuleId } from "../core/model/domain.ts";
import { runStaticScan } from "../core/scan/scan.ts";
import { createLocalBinding, lookupGithubRemote } from "../core/scan/binding.ts";
import { discoverWorkflows } from "../core/scan/discover.ts";
import { parseWorkflow } from "../core/workflow/parse.ts";
import { syncRepositoryHistory } from "../core/history/sync.ts";
import { defaultStateDir } from "../core/state/paths.ts";
import { buildHistoryReport } from "../core/analysis/report.ts";
import { buildDiagnostics, diagnosticsIncomplete } from "../core/analysis/diagnostics.ts";
import { HISTORY_LOOKBACK_DAYS_MAX, HISTORY_LOOKBACK_DAYS_MIN, PROPOSED_RETENTION_DAYS, TIMEOUT_MINUTES_MAX, TIMEOUT_MINUTES_MIN } from "../core/policy/constants.ts";
import { buildRequestedPlan } from "../core/patch/request-plan.ts";
import { renderEditDiff } from "../core/patch/diff.ts";
import { sourceHashOf } from "../core/patch/plan.ts";
import { claimsFromTokens } from "../core/patch/eligibility.ts";
import { DEFAULT_CONFIG } from "../core/data/default-config.ts";
import { ConfigFileError, loadConfigFile } from "../core/config/load.ts";
import type { Config } from "../core/contracts/schema.ts";
import type { Coverage } from "../core/contracts/schema.ts";
import type { HistoryBundle } from "../core/history/model.ts";
import { GitHubError } from "../adapters/github/errors.ts";
import { DeadlineExceededError } from "../core/support/deadline.ts";
import { ContractViolationError } from "../core/contracts/validate.ts";
import { ENGINE_VERSION } from "../core/version.ts";
import { appliedBackupConfirmToken, PatchStore, StoreCorruptionError, StoreQuotaError } from "../core/patch/store.ts";
import type { PlanMeta } from "../core/patch/store.ts";
import { findFindingForRequest, targetReasons } from "../core/patch/target.ts";
import type { PlanRequest } from "../core/patch/target.ts";
import { approvePlan, approvalConfirmation } from "../core/patch/approval.ts";
import { applyPlan, revertChange } from "../core/patch/apply.ts";
import { renderHtmlReport } from "../core/report/html.ts";
import { localizedFinding } from "../core/report/localize.ts";
import { resolveRequestedLocale } from "../shared/i18n/host.ts";
import { createTranslator } from "../shared/i18n/index.ts";
import type { Locale, MessageKey } from "../shared/i18n/index.ts";

/** Output sink used by the CLI; process streams by default, buffers in tests. */
export interface CliOutput {
  write(text: string): void;
  readonly isTTY?: boolean;
}

/** Injectable process boundary for one CLI run. Everything omitted keeps production behavior. */
export interface CliContext {
  readonly cwd: string;
  readonly stdout: CliOutput;
  readonly stderr: CliOutput;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;
  /** Cancels network collection for commands that support it. */
  readonly signal?: AbortSignal;
}

function processContext(): CliContext {
  return {
    cwd: process.cwd(),
    stdout: { write: (text: string) => { process.stdout.write(text); },
      ...(process.stdout.isTTY === true ? { isTTY: true } : {}) },
    stderr: { write: (text: string) => { process.stderr.write(text); },
      ...(process.stderr.isTTY === true ? { isTTY: true } : {}) },
    env: process.env,
    clock: systemClock,
  };
}

let context: CliContext = processContext();

function writeOut(text: string): void { context.stdout.write(text); }
function writeErr(text: string): void { context.stderr.write(text); }
function now(): Date { return context.clock.now(); }

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_SCHEMA = 2;
const EXIT_INCOMPLETE = 3;
const EXIT_INVARIANT = 4;
const EXIT_NONCE = 5;
const EXIT_BACKUP = 6;
const EXIT_STORAGE = 7;
const EXIT_CANCELLED = 130;
/** Time a cancelled command gets to finish its journal or kill its child before a forced exit. */
const CANCEL_GRACE_MS = 5_000;

/** What the second and later Ctrl-C presses should do for a command. */
export type CancelAction = "stop-now" | "abort-then-wait" | "force-exit";

export function cancelAction(deferred: boolean, waiting: boolean): CancelAction {
  if (!deferred) return "stop-now";
  return waiting ? "force-exit" : "abort-then-wait";
}

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
  readonly accountMinutesUsed: number | null;
  readonly includedMinutes: number | null;
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
  readonly appliedBackups: boolean;
  readonly config: Config;
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
  let cwd = context.cwd;
  let json = false;
  let outPath: string | null = null;
  let rules: readonly RuleId[] | null = null;
  let requireComplete = false;
  let lang: string | null = null;
  let help = false;
  let version = false;
  let repo: string | null = null;
  let network = false;
  let days: number | null = null;
  let accountMinutesUsed: number | null = null;
  let includedMinutes: number | null = null;
  let stateDirPath: string | null = null;
  let configPath: string | null = null;
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
  let appliedBackups = false;

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
    } else if (arg === "--applied-backups") {
      appliedBackups = true;
    } else if (arg === "--cwd") {
      cwd = takeValue(index, "--cwd");
      index += 1;
    } else if (arg === "--out") {
      outPath = takeValue(index, "--out");
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
      if (!Number.isSafeInteger(parsed) || parsed < HISTORY_LOOKBACK_DAYS_MIN || parsed > HISTORY_LOOKBACK_DAYS_MAX) throw new UsageError("INVALID_VALUE:--days");
      days = parsed;
    } else if (arg === "--account-minutes-used") {
      const value = takeValue(index, "--account-minutes-used");
      index += 1;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) throw new UsageError("INVALID_VALUE:--account-minutes-used");
      accountMinutesUsed = parsed;
    } else if (arg === "--included-minutes") {
      const value = takeValue(index, "--included-minutes");
      index += 1;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) throw new UsageError("INVALID_VALUE:--included-minutes");
      includedMinutes = parsed;
    } else if (arg === "--rules") {
      const value = takeValue(index, "--rules");
      index += 1;
      const requested = value.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
      for (const entry of requested) {
        if (!(RULE_IDS as readonly string[]).includes(entry)) throw new UsageError("UNKNOWN_RULE:" + entry);
      }
      rules = requested as readonly RuleId[];
    } else if (arg === "--state-dir") {
      stateDirPath = takeValue(index, "--state-dir");
      index += 1;
    } else if (arg === "--config") {
      configPath = takeValue(index, "--config");
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
      if (!Number.isSafeInteger(parsed) || parsed < TIMEOUT_MINUTES_MIN || parsed > TIMEOUT_MINUTES_MAX) throw new UsageError("INVALID_VALUE:--minutes");
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

  const effectiveCwd = resolve(context.cwd, cwd);
  const out = outPath === null ? null : resolve(effectiveCwd, outPath);
  const stateDir = stateDirPath === null ? null : resolve(effectiveCwd, stateDirPath);
  return {
    command,
    cwd: effectiveCwd,
    config: configPath === null ? DEFAULT_CONFIG : loadConfigFile(resolve(effectiveCwd, configPath)),
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
    accountMinutesUsed,
    includedMinutes,
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
    appliedBackups,
  };
}

function stateDirOf(options: Options): string {
  return options.stateDir ?? defaultStateDir();
}

/** Open the store with the product quota and warn once when it crosses the threshold. */
function openStore(stateDir: string, locale: Locale, storage: Config["storage"] = DEFAULT_CONFIG.storage): PatchStore {
  const store = PatchStore.open(stateDir, storage);
  const status = store.storageStatus();
  if (status.warning) {
    writeErr(
      createTranslator(locale)("cli.storage.warning", {
        percent: status.percent,
        used: status.bytes,
        limit: status.limit,
      }) + "\n",
    );
  }
  return store;
}

function resolveUiLocale(lang: string | null): Locale {
  return resolveRequestedLocale(lang, context.env);
}

function writeAtomically(path: string, content: string): void {
  const absolute = resolve(context.cwd, path);
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
  if (options.json) writeOut(reportJson);
  else writeOut(lines.join("\n") + "\n");
}

function scan(options: Options, locale: Locale): number {
  const t = createTranslator(locale);
  const result = runStaticScan({
    workspaceRoot: options.cwd,
    enabledRules: options.rules ?? undefined,
    maxWorkflowBytes: options.config.storage.workflowMaxBytes,
    generatedAt: now().toISOString(),
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
      lines.push(t("cli.scan.finding", { rule: finding.ruleId, title: localizedFinding(finding, locale).title }));
    }
    lines.push(t("cli.scan.summary", { findings: report.findings.length }));
  }
  if (skipped.length > 0) lines.push(t("cli.scan.incomplete"));
  lines.push(t("cli.scan.staticNote"));
  if (options.out !== null) lines.push(t("cli.scan.written", { path: resolve(context.cwd, options.out) }));

  reportText(JSON.stringify(report, null, 2) + "\n", options, lines);

  for (const warning of warnings) writeErr(warning + "\n");
  if (options.requireComplete && isIncomplete(report.coverage)) {
    writeErr(t("cli.scan.incomplete") + "\n");
    return EXIT_INCOMPLETE;
  }
  return EXIT_OK;
}

async function sync(options: Options, locale: Locale): Promise<number> {
  const t = createTranslator(locale);
  if (!options.network) {
    writeErr(t("cli.sync.networkRequired") + "\n");
    return EXIT_USAGE;
  }

  const generatedAt = now().toISOString();
  const discovery = discoverWorkflows(options.cwd, { maxBytes: options.config.storage.workflowMaxBytes });
  const workflows = discovery.workflows.map((file) => parseWorkflow(file.path, file.text));

  let owner: string;
  let repository: string;
  if (options.repo !== null) {
    const parsed = parseRepoArgument(options.repo);
    owner = parsed.owner;
    repository = parsed.repository;
  } else {
    const lookup = lookupGithubRemote(discovery.root);
    if (lookup.kind === "error") {
      const detail = lookup.error instanceof Error ? lookup.error.message : String(lookup.error);
      writeErr(t("cli.sync.remoteUnavailable", { detail }) + "\n");
      return EXIT_USAGE;
    }
    if (lookup.kind === "none") {
      writeErr(t("cli.sync.repoRequired") + "\n");
      return EXIT_USAGE;
    }
    owner = lookup.remote.owner;
    repository = lookup.remote.repository;
  }

  if ((options.accountMinutesUsed === null) !== (options.includedMinutes === null)) {
    writeErr(t("cli.invalidValue", { flag: options.accountMinutesUsed === null ? "--account-minutes-used" : "--included-minutes" }) + "\n");
    return EXIT_USAGE;
  }
  const billing = options.accountMinutesUsed === null || options.includedMinutes === null
    ? null
    : { accountMinutesUsed: options.accountMinutesUsed, includedMinutes: options.includedMinutes };
  const baseConfig: Config = options.days === null
    ? options.config
    : { ...options.config, history: { ...options.config.history, lookbackDays: options.days } };
  const config: Config = billing === null ? baseConfig : { ...baseConfig, billing };

  const showProgress = context.stderr.isTTY === true && !options.json;
  let progressPrinted = false;
  const syncResult = await syncRepositoryHistory({
    owner,
    repo: repository,
    config,
    now: now(),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(showProgress
      ? {
          onProgress: (progress: { runsProcessed: number; runsTotal: number; jobsFetched: number }) => {
            progressPrinted = true;
            writeErr("\r" + t("cli.sync.progress", {
              runs: progress.runsProcessed,
              total: progress.runsTotal,
              jobs: progress.jobsFetched,
            }));
          },
        }
      : {}),
  });
  if (progressPrinted) writeErr("\r" + " ".repeat(72) + "\r");
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

  // A cancelled sync must not leave a partial snapshot behind.
  context.signal?.throwIfAborted();
  const store = openStore(stateDirOf(options), locale, options.config.storage);
  // Binding, history, and report are one logical snapshot: when an older sync
  // finishes last, none of the three replaces the newer state.
  const historyStored = store.saveHistorySnapshot(upgraded.binding, history, report);
  if (!historyStored) writeErr(t("cli.sync.snapshotSkipped") + "\n");

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
      lines.push(t("cli.scan.finding", { rule: finding.ruleId, title: localizedFinding(finding, locale).title }));
    }
    lines.push(t("cli.scan.summary", { findings: report.findings.length }));
  }
  if (isIncomplete(report.coverage)) lines.push(t("cli.scan.incomplete"));
  lines.push(t("cli.sync.note"));
  if (options.out !== null) lines.push(t("cli.sync.written", { path: resolve(context.cwd, options.out) }));

  reportText(JSON.stringify(report, null, 2) + "\n", options, lines);

  if (options.requireComplete && isIncomplete(report.coverage)) {
    writeErr(t("cli.scan.incomplete") + "\n");
    return EXIT_INCOMPLETE;
  }
  return EXIT_OK;
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
  const store = existsSync(stateDir) ? openStore(stateDir, locale, options.config.storage) : null;
  if (store === null) {
    writeErr(t("cli.plan.syncRequired") + "\n");
    return EXIT_USAGE;
  }
  const plannedAt = now();
  const root = realpathSync(options.cwd);
  const existing = store.findBindingByRoot(root);
  const current = existing ?? createLocalBinding(root, plannedAt.toISOString()).binding;
  const report = store.latestReportForBinding(current.bindingId);
  if (report === null) {
    writeErr(t("cli.plan.syncRequired") + "\n");
    return EXIT_USAGE;
  }
  const binding = store.readBinding(report.bindingId) ?? current;
  const rule = options.rule;
  if (rule !== "CD001" && rule !== "CD005" && rule !== "CD008") {
    writeErr(t("cli.plan.ruleRequired") + "\n");
    return EXIT_USAGE;
  }
  const discovery = discoverWorkflows(binding.workspaceRoot, { maxBytes: options.config.storage.workflowMaxBytes });
  const requestedPath = options.workflow === null ? null : options.workflow.replace(/\\/g, "/");
  const oversized = discovery.skipped.find((entry) => entry.reason === "WORKFLOW_TOO_LARGE"
    && (requestedPath === null || entry.path === requestedPath));
  if (oversized !== undefined && (requestedPath !== null || discovery.workflows.length === 0)) {
    writeErr(t("cli.plan.workflowTooLarge") + "\n");
    return EXIT_USAGE;
  }
  const workflowPath = pickWorkflowPath(options, discovery.workflows.map((file) => file.path));
  const file = discovery.workflows.find((entry) => entry.path === workflowPath);
  if (file === undefined) {
    writeErr(t("cli.plan.syncRequired") + "\n");
    return EXIT_USAGE;
  }
  const workflow = parseWorkflow(file.path, file.text);
  if (workflow.parseError !== null || workflow.unsupported.length > 0) {
    writeErr(t("cli.plan.unsupported") + "\n");
    return EXIT_USAGE;
  }

  const historyJson: HistoryBundle | null = store.readLatestHistory(binding.bindingId);
  if (historyJson === null) {
    writeErr(t("cli.plan.syncRequired") + "\n");
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
    writeErr(t("cli.plan.notTarget", { rule, target: options.job ?? "workflow" }) + "\n");
    writeErr("  - FINDING_NOT_FOUND\n");
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
    writeErr(t("cli.plan.notEligible", { rule }) + "\n");
    for (const problem of targetProblems) writeErr("  - " + problem + "\n");
    if (targetProblems.includes("WORKFLOW_HASH_MISMATCH")) writeErr(t("cli.plan.staleEvidence") + "\n");
    return EXIT_INCOMPLETE;
  }

  const requested = buildRequestedPlan({
    binding,
    workflow,
    text: file.text,
    rule,
    allowedRules: options.config.apply.allowedRules,
    jobKey: options.job,
    stepIndex: rule === "CD008" ? options.step : null,
    minutes: options.minutes,
    finding: chosenFinding,
    coverage: report.coverage,
    claims: claimsFromTokens(options.claims),
    history: historyJson,
    evidenceRef: "cli:plan:" + rule,
    issuedBy: { channel: "human-cli", subjectId: options.subject },
    now: plannedAt,
    policyMaxAgeSeconds: options.config.apply.policyMaxAgeSeconds,
    attestationTtlSeconds: options.config.apply.attestationMaxAgeDays * 24 * 60 * 60,
  });
  if (!requested.ok) {
    switch (requested.blocker) {
      case "EXISTING_CONCURRENCY":
        writeErr(t("cli.plan.existingConcurrency") + "\n");
        return EXIT_USAGE;
      case "JOB_REQUIRED":
        writeErr(t("cli.plan.jobRequired") + "\n");
        return EXIT_USAGE;
      case "STEP_REQUIRED":
        writeErr(t("cli.plan.stepRequired") + "\n");
        return EXIT_USAGE;
      case "RULE_NOT_ALLOWED":
        writeErr(t("cli.plan.ruleNotAllowed", { rule }) + "\n");
        return EXIT_USAGE;
      case "NOT_ELIGIBLE":
        writeErr(t("cli.plan.notEligible", { rule }) + "\n");
        for (const reason of requested.reasons) writeErr("  - " + reason + "\n");
        return EXIT_INCOMPLETE;
      default:
        writeErr((requested.reasons[0] ?? requested.blocker) + "\n");
        return EXIT_INCOMPLETE;
    }
  }
  store.saveAttestation(requested.attestation);
  const plan = requested.plan;
  const meta: PlanMeta = { coverageWriteAllowed: true, reportId: report.reportId };
  store.savePlan(plan, meta);

  const lines: string[] = [];
  lines.push(t("cli.plan.created", { plan: plan.planId, workflow: file.path, rule }));
  lines.push(t("cli.plan.target", { path: join(binding.workspaceRoot, file.path) }));
  lines.push(t("cli.plan.diff"));
  for (const diffLine of renderEditDiff(file.text, plan.payload.edits)) {
    const marker = diffLine.kind === "removed" ? "- " : diffLine.kind === "added" ? "+ " : "  ";
    lines.push(marker + diffLine.text);
  }
  lines.push(t("cli.plan.digest", { digest: plan.planDigest }));
  lines.push(t("cli.plan.confirm", { confirmation: approvalConfirmation(plan) }));
  lines.push(t("cli.plan.next", { plan: plan.planId }));
  if (options.out !== null) lines.push(t("cli.scan.written", { path: resolve(context.cwd, options.out) }));
  reportText(JSON.stringify(plan, null, 2) + "\n", options, lines);
  return EXIT_OK;
}

function approveCommand(options: Options, locale: Locale): number {
  const t = createTranslator(locale);
  if (options.plan === null || options.confirm === null) {
    writeErr(t("cli.approve.usage") + "\n");
    return EXIT_USAGE;
  }
  const store = openStore(stateDirOf(options), locale, options.config.storage);
  const result = approvePlan({
    store,
    planId: options.plan,
    confirmation: options.confirm,
    subjectId: options.subject,
    channel: "human-cli",
    now: now(),
  });
  for (const warning of result.warnings ?? []) writeErr(warning + "\n");
  const lines: string[] = [];
  lines.push(t("cli.approve.done", { plan: result.plan.planId }));
  if (options.out !== null) lines.push(t("cli.scan.written", { path: resolve(context.cwd, options.out) }));
  reportText(JSON.stringify(result.plan, null, 2) + "\n", options, lines);
  return EXIT_OK;
}

async function applyCommand(options: Options, locale: Locale): Promise<number> {
  const t = createTranslator(locale);
  if (options.plan === null) {
    writeErr(t("cli.apply.usage") + "\n");
    return EXIT_USAGE;
  }
  const store = openStore(stateDirOf(options), locale, options.config.storage);
  const result = await applyPlan({
    store,
    planId: options.plan,
    now: now(),
    subjectId: options.subject,
    approvalTtlSeconds: options.config.apply.approvalTtlSeconds,
    policyMaxAgeSeconds: options.config.apply.policyMaxAgeSeconds,
    allowedRules: options.config.apply.allowedRules,
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  });
  for (const warning of result.warnings ?? []) writeErr(warning + "\n");
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
    writeErr(t("cli.revert.usage") + "\n");
    return EXIT_USAGE;
  }
  const store = openStore(stateDirOf(options), locale, options.config.storage);
  const result = await revertChange({
    store,
    changeId: options.change,
    now: now(),
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  });
  for (const warning of result.warnings ?? []) writeErr(warning + "\n");
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
  const store = openStore(stateDirOf(options), locale, options.config.storage);
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
  const store = openStore(stateDirOf(options), locale, options.config.storage);
  if (options.plan !== null) {
    const stored = store.readPlan(options.plan);
    if (stored === null) {
      writeErr(t("cli.plan.notFound", { plan: options.plan }) + "\n");
      return EXIT_USAGE;
    }
    const payload = stored.plan.payload;
    const lines: string[] = [];
    lines.push(t("cli.plan.created", { plan: stored.plan.planId, workflow: payload.workflowPath, rule: payload.ruleIds.join(", ") }));
    lines.push(t("cli.plan.digest", { digest: stored.plan.planDigest }));
    const binding = store.readBinding(payload.bindingId);
    let source: string | null = null;
    if (binding !== null) {
      try {
        source = readFileSync(join(binding.workspaceRoot, payload.workflowPath), "utf8");
      } catch {
        source = null;
      }
    }
    if (source === null) {
      lines.push(t("cli.plan.diffUnavailable"));
      reportText(JSON.stringify(stored.plan, null, 2) + "\n", options, lines);
      return EXIT_INCOMPLETE;
    } else if (sourceHashOf(source) !== payload.sourceHash) {
      lines.push(t("cli.plan.sourceChanged"));
      reportText(JSON.stringify(stored.plan, null, 2) + "\n", options, lines);
      return EXIT_INCOMPLETE;
    } else {
      lines.push(t("cli.plan.target", { path: join(binding?.workspaceRoot ?? "", payload.workflowPath) }));
      lines.push(t("cli.plan.diff"));
      for (const diffLine of renderEditDiff(source, payload.edits)) {
        const marker = diffLine.kind === "removed" ? "- " : diffLine.kind === "added" ? "+ " : "  ";
        lines.push(marker + diffLine.text);
      }
    }
    reportText(JSON.stringify(stored.plan, null, 2) + "\n", options, lines);
    return EXIT_OK;
  }
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
    writeErr(t("cli.report.none") + "\n");
    return EXIT_USAGE;
  }
  const store = openStore(stateDir, locale, options.config.storage);
  const root = realpathSync(options.cwd);
  const currentBinding = store.findBindingByRoot(root);
  const report = options.report === null
    ? (currentBinding === null ? null : store.latestReportForBinding(currentBinding.bindingId))
    : store.readReport(options.report);
  if (report === null) {
    writeErr(t("cli.report.none") + "\n");
    return EXIT_USAGE;
  }

  const format = options.json ? "json" : options.format;
  if (format === "html") {
    const html = renderHtmlReport(report, { locale });
    if (options.out === null) writeOut(html);
    else {
      writeAtomically(options.out, html);
      writeOut(t("cli.report.written", { path: resolve(context.cwd, options.out) }) + "\n");
    }
    return EXIT_OK;
  }
  if (format === "json") {
    const json = JSON.stringify(report, null, 2) + "\n";
    if (options.out === null) writeOut(json);
    else {
      writeAtomically(options.out, json);
      writeOut(t("cli.report.written", { path: resolve(context.cwd, options.out) }) + "\n");
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
    for (const finding of report.findings) lines.push(t("cli.scan.finding", { rule: finding.ruleId, title: localizedFinding(finding, locale).title }));
    lines.push(t("cli.scan.summary", { findings: report.findings.length }));
  }
  if (isIncomplete(report.coverage)) lines.push(t("cli.scan.incomplete"));
  if (options.out !== null) {
    writeAtomically(options.out, lines.join("\n") + "\n");
    lines.push(t("cli.report.written", { path: resolve(context.cwd, options.out) }));
  }
  writeOut(lines.join("\n") + "\n");
  return EXIT_OK;
}

function diagnoseCommand(options: Options, locale: Locale): number {
  const t = createTranslator(locale);
  if (options.format === "html") {
    writeErr(t("cli.invalidValue", { flag: "--format" }) + "\n");
    return EXIT_USAGE;
  }
  const stateDir = stateDirOf(options);
  if (!existsSync(stateDir)) {
    writeErr(t("cli.diagnose.syncRequired") + "\n");
    return EXIT_USAGE;
  }
  const store = openStore(stateDir, locale, options.config.storage);
  const root = realpathSync(options.cwd);
  const binding = store.findBindingByRoot(root) ?? createLocalBinding(root, now().toISOString()).binding;
  const history = store.readLatestHistory(binding.bindingId);
  if (history === null) {
    writeErr(t("cli.diagnose.syncRequired") + "\n");
    return EXIT_USAGE;
  }

  const diagnostics = buildDiagnostics(history);
  const payload = {
    repository: binding.repositoryFullName,
    workspaceRoot: binding.workspaceRoot,
    bindingId: binding.bindingId,
    ...diagnostics,
  };
  const lines: string[] = [];
  lines.push(t("cli.diagnose.summary", {
    name: binding.repositoryFullName ?? history.repositoryFullName,
    runs: diagnostics.runs,
    jobs: diagnostics.jobs,
    workflows: diagnostics.workflows.length,
  }));
  lines.push(t("cli.diagnose.match", {
    matched: diagnostics.matchedJobs,
    jobs: diagnostics.jobs,
    percent: diagnostics.matchPercent === null ? "n/a" : diagnostics.matchPercent.toFixed(1),
  }));
  const incomplete = diagnostics.coverage.filter((axis) => axis.status !== "complete");
  if (incomplete.length === 0) lines.push(t("cli.diagnose.axisComplete"));
  for (const axis of incomplete) {
    lines.push(t("cli.diagnose.axis", { axis: axis.axis, status: axis.status, reasons: axis.reasons.join(", ") }));
  }
  if (diagnostics.unresolvedRuns > 0) lines.push(t("cli.diagnose.unresolved", { count: diagnostics.unresolvedRuns }));
  if (diagnostics.missingScopes.length > 0) lines.push(t("cli.diagnose.scopes", { count: diagnostics.missingScopes.length }));
  for (const workflow of diagnostics.workflows) {
    lines.push(t("cli.diagnose.workflow", {
      path: workflow.path,
      runs: workflow.analyzableRuns,
      matched: workflow.matched,
      unmatched: workflow.unmatched,
    }));
    for (const matrix of workflow.matrixJobs) {
      lines.push(t("cli.diagnose.matrix", { job: matrix.template ?? matrix.key, legs: matrix.legs === null ? "unknown" : matrix.legs }));
    }
    for (const miss of workflow.misses.slice(0, 5)) {
      lines.push(t("cli.diagnose.miss", { name: miss.jobName, count: miss.occurrences }));
    }
  }
  if (diagnostics.workflows.every((workflow) => workflow.misses.length === 0)) lines.push(t("cli.diagnose.none"));
  if (diagnostics.cacheHints.length > 0) {
    lines.push(t("cli.diagnose.cache.header", { count: diagnostics.cacheHints.length }));
    for (const hint of diagnostics.cacheHints) {
      lines.push(t(hint.code === "CACHE_MISSING" ? "cli.diagnose.cache.missing" : "cli.diagnose.cache.unpinned", {
        path: hint.workflowPath,
        jobs: hint.jobs.join(", "),
        steps: hint.steps.join(", "),
      }));
    }
  }

  reportText(JSON.stringify(payload, null, 2) + "\n", options, lines);
  if (options.requireComplete && diagnosticsIncomplete(diagnostics)) {
    writeErr(t("cli.scan.incomplete") + "\n");
    return EXIT_INCOMPLETE;
  }
  return EXIT_OK;
}

function pruneAppliedBackups(store: PatchStore, options: Options, locale: Locale): number {
  const t = createTranslator(locale);
  const candidates = store.appliedBackupCandidates();
  const changeIds = candidates.map((candidate) => candidate.changeId);
  const token = appliedBackupConfirmToken(candidates);
  if (options.confirm === null) {
    if (options.json) {
      writeOut(JSON.stringify({ candidates, token, automaticPruning: false }, null, 2) + "\n");
      return EXIT_OK;
    }
    if (candidates.length === 0) {
      writeOut(t("cli.prune.backups.none") + "\n");
      return EXIT_OK;
    }
    writeOut(t("cli.prune.backups.list", { count: candidates.length }) + "\n");
    for (const candidate of candidates) {
      writeOut(
        t("cli.prune.backups.item", {
          change: candidate.changeId,
          state: candidate.state,
          workflow: candidate.workflowPath,
          bytes: candidate.bytes,
          path: candidate.backupPath,
        }) + "\n",
      );
    }
    writeOut(t("cli.prune.backups.manual") + "\n");
    writeOut(t("cli.prune.backups.token", { token }) + "\n");
    return EXIT_OK;
  }
  if (options.confirm !== token) {
    writeErr(t("cli.prune.backups.invalidToken") + "\n");
    return EXIT_USAGE;
  }
  const cleanup = store.pruneAppliedBackups(changeIds, options.confirm);
  if (options.json) writeOut(JSON.stringify({ removedChangeIds: changeIds, ...cleanup }, null, 2) + "\n");
  else writeOut(t("cli.prune.backups.deleted", { count: cleanup.removedBackups, bytes: cleanup.bytesFreed }) + "\n");
  return EXIT_OK;
}

function pruneCommand(options: Options, locale: Locale): number {
  const t = createTranslator(locale);
  const stateDir = stateDirOf(options);
  if (!existsSync(stateDir)) {
    if (options.appliedBackups) writeOut(t("cli.prune.backups.none") + "\n");
    else writeOut(t("cli.prune.done", { reports: 0, plans: 0, cache: 0 }) + "\n");
    return EXIT_OK;
  }
  const store = openStore(stateDir, locale, options.config.storage);
  if (options.appliedBackups) return pruneAppliedBackups(store, options, locale);
  const result = store.prune(now(), {
    reportDays: options.config.storage.reportDays,
    planDays: options.config.storage.planDays,
    cacheDays: options.config.storage.cacheDays,
    cacheMaxBytes: options.config.storage.cacheMaxBytes,
  });
  if (options.json) writeOut(JSON.stringify(result, null, 2) + "\n");
  else {
    writeOut(t("cli.prune.done", {
      reports: result.removedReports,
      plans: result.removedPlans,
      cache: result.removedCacheEntries,
    }) + "\n");
    writeOut(t("cli.prune.freed", { bytes: result.bytesFreed }) + "\n");
  }
  const status = store.storageStatus();
  if (status.blocked) writeErr(t("error.STORAGE_QUOTA_EXCEEDED") + "\n");
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
  diagnose: "cli.diagnose.help",
  prune: "cli.prune.help",
};

function resolveLang(argv: readonly string[]): string | null {
  const flagIndex = argv.indexOf("--lang");
  return flagIndex === -1 ? null : (argv[flagIndex + 1] ?? null);
}

function usageMessage(error: UsageError, argv: readonly string[]): string {
  const [code = "", suffix = ""] = error.message.split(":", 2);
  const t = createTranslator(resolveUiLocale(resolveLang(argv)));
  if (code === "UNKNOWN_RULE") return t("cli.unknownRule", { rule: suffix });
  if (code === "MISSING_VALUE") return t("cli.missingValue", { flag: suffix });
  if (code === "UNKNOWN_COMMAND") return t("cli.unknownCommand", { command: suffix });
  if (code === "UNKNOWN_FLAG") return t("cli.unknownFlag", { flag: suffix });
  if (code === "INVALID_VALUE") return t("cli.invalidValue", { flag: suffix });
  return suffix === "" ? code : suffix;
}

function mapError(error: unknown, t: ReturnType<typeof createTranslator>): number {
  if (error instanceof ContractViolationError || error instanceof StoreCorruptionError) {
    writeErr(t("error.SCHEMA_INVALID") + " " + error.message + "\n");
    return EXIT_SCHEMA;
  }
  if (error instanceof DeadlineExceededError) {
    writeErr(t("cli.sync.deadline", { minutes: Math.max(1, Math.round(error.timeoutMs / 60000)) }) + "\n");
    return EXIT_INCOMPLETE;
  }
  if (error instanceof GitHubError) {
    if (error.code === "AUTH_REQUIRED") {
      writeErr(t("error.AUTH_REQUIRED") + "\n");
      return EXIT_INCOMPLETE;
    }
    if (error.code === "BUDGET_EXHAUSTED") {
      writeErr(t("error.REQUEST_BUDGET_EXHAUSTED") + "\n");
      return EXIT_INCOMPLETE;
    }
    writeErr(t("cli.error.prefix") + " " + error.code + ": " + error.message + "\n");
    if (error.detail !== null) {
      // gh echoes multi-line diagnostics; keep the explanation on one bounded line.
      writeErr("  " + error.detail.replace(/\s+/g, " ").slice(0, 400) + "\n");
    }
    return EXIT_USAGE;
  }
  if (error instanceof Error && error.name === "AbortError") {
    writeErr(t("cli.cancelled") + "\n");
    return EXIT_CANCELLED;
  }
  if (error instanceof StoreQuotaError) {
    writeErr(t("error.STORAGE_QUOTA_EXCEEDED") + " " + error.message + "\n");
    return EXIT_STORAGE;
  }
  if (error instanceof Error && (error.message.startsWith("PLAN_EXPIRED") || error.message.startsWith("POLICY_STALE"))) {
    writeErr(t("cli.error.prefix") + " " + error.message + "\n");
    return EXIT_INCOMPLETE;
  }
  if (error instanceof Error && error.message.startsWith("NONCE_INVALID")) {
    writeErr(t("cli.error.prefix") + " " + error.message + "\n");
    return EXIT_NONCE;
  }
  const message = error instanceof Error ? error.message : String(error);
  writeErr(t("cli.error.prefix") + " " + message + "\n");
  return EXIT_USAGE;
}

/**
 * Run one CLI invocation against an injected process boundary. The default
 * context reads the real cwd, streams, environment, and clock, so the wrapper
 * below and every existing caller keep production behaviour.
 */
export async function executeCli(argv: readonly string[], overrides: Partial<CliContext> = {}): Promise<number> {
  const previous = context;
  context = { ...processContext(), ...overrides };
  try {
    return await main(argv);
  } finally {
    context = previous;
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      writeErr("error: " + usageMessage(error, argv) + "\n");
      return EXIT_USAGE;
    }
    if (error instanceof ConfigFileError) {
      writeErr("error: " + error.message + "\n");
      return EXIT_SCHEMA;
    }
    throw error;
  }

  const locale = resolveUiLocale(options.lang);
  const t = createTranslator(locale);

  if (options.version) {
    writeOut("ci-diet " + ENGINE_VERSION + "\n");
    return EXIT_OK;
  }
  if (options.help || options.command === "") {
    const key = HELP_KEYS[options.command] ?? "cli.usage";
    writeOut(t(key) + "\n");
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
    if (options.command === "diagnose") return diagnoseCommand(options, locale);
    if (options.command === "prune") return pruneCommand(options, locale);
  } catch (error) {
    return mapError(error, t);
  }
  writeErr(t("cli.unknownCommand", { command: options.command }) + "\n");
  return EXIT_USAGE;
}

const invokedDirectly = process.argv[1] !== undefined && /(?:^|[\\/])cli(?:[\\/]index)?\.[cm]?[jt]s$/.test(process.argv[1]);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  // Mutating commands finish their journal and network commands kill their gh
  // child before leaving. Everything else stops once the signal is forwarded.
  const deferred = argv.some((arg) => arg === "apply" || arg === "revert" || arg === "sync");
  const controller = new AbortController();
  let interrupted = false;
  let graceTimer: NodeJS.Timeout | null = null;
  process.on("SIGINT", () => {
    interrupted = true;
    // Always forward the signal first: exiting before abort can orphan a gh
    // child that then writes to the store after the CLI is gone.
    controller.abort();
    const action = cancelAction(deferred, graceTimer !== null);
    if (action !== "abort-then-wait") {
      process.exit(EXIT_CANCELLED);
      return;
    }
    graceTimer = setTimeout(() => process.exit(EXIT_CANCELLED), CANCEL_GRACE_MS);
    graceTimer.unref();
  });
  executeCli(argv, { signal: controller.signal }).then(
    (code) => {
      if (interrupted) {
        if (code !== EXIT_CANCELLED) {
          writeErr(createTranslator(resolveUiLocale(resolveLang(argv)))("cli.cancelled") + "\n");
        }
        process.exitCode = EXIT_CANCELLED;
        return;
      }
      process.exitCode = code;
    },
    (error: unknown) => {
      writeErr((error instanceof Error ? error.stack ?? error.message : String(error)) + "\n");
      process.exitCode = EXIT_USAGE;
    },
  );
}