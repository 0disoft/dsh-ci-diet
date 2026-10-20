#!/usr/bin/env node
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { RULE_IDS } from "../core/model/domain.ts";
import type { RuleId } from "../core/model/domain.ts";
import { runStaticScan } from "../core/scan/scan.ts";
import { createLocalBinding, readGithubRemote } from "../core/scan/binding.ts";
import { discoverWorkflows } from "../core/scan/discover.ts";
import { parseWorkflow } from "../core/workflow/parse.ts";
import { syncRepositoryHistory } from "../core/history/sync.ts";
import { buildHistoryReport } from "../core/analysis/report.ts";
import { DEFAULT_CONFIG } from "../core/data/default-config.ts";
import type { Config } from "../core/contracts/schema.ts";
import type { Coverage } from "../core/contracts/schema.ts";
import { GitHubError } from "../adapters/github/errors.ts";
import { ContractViolationError } from "../core/contracts/validate.ts";
import { ENGINE_VERSION } from "../core/version.ts";
import { createTranslator, resolveLocale, resolveLocaleFromEnv } from "../shared/i18n/index.ts";
import type { Locale } from "../shared/i18n/index.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_SCHEMA = 2;
const EXIT_INCOMPLETE = 3;

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
}

class UsageError extends Error {}

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
    } else if (arg.startsWith("-")) {
      throw new UsageError("UNKNOWN_FLAG:" + arg);
    } else if (command === "") {
      command = arg;
    } else {
      throw new UsageError("UNKNOWN_COMMAND:" + arg);
    }
  }

  return { command, cwd: resolve(cwd), json, out, rules, requireComplete, lang, help, version, repo, network, days };
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

function parseRepoArgument(value: string): { owner: string; repository: string } {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
  if (!match || match[1] === undefined || match[2] === undefined || match[1] === "." || match[1] === "..") {
    throw new UsageError("INVALID_VALUE:--repo");
  }
  return { owner: match[1], repository: match[2] };
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

  const syncResult = await syncRepositoryHistory({ owner, repo: repository, config, now: new Date() });
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

/** Render a UsageError through the message catalogue, using --lang when it was already parsed. */
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
    process.stdout.write(t(options.command === "sync" ? "cli.sync.help" : "cli.usage") + "\n");
    return options.help ? EXIT_OK : EXIT_USAGE;
  }

  try {
    if (options.command === "scan") return scan(options, locale);
    if (options.command === "sync") return await sync(options, locale);
  } catch (error) {
    return mapError(error, t);
  }
  process.stderr.write(t("cli.unknownCommand", { command: options.command }) + "\n");
  return EXIT_USAGE;
}

const invokedDirectly = process.argv[1] !== undefined && /(?:^|[\\/])cli(?:[\\/]index)?\.[cm]?[jt]s$/.test(process.argv[1]);
if (invokedDirectly) {
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