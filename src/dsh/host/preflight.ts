import { execFileSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import type { PreToolDecision, ToolExecution } from "@deepseek-ai/dsh-tools";
import { digestOf } from "../../shared/cdj1.ts";
import { discoverWorkflows } from "../../core/scan/discover.ts";
import { parseWorkflow } from "../../core/workflow/parse.ts";
import { npmCacheDependencies, downloadCacheTargets } from "../../core/rules/npm-cache.ts";
import type { RuleId } from "../../core/model/domain.ts";

/** Only literal commands; substitutions, heredocs, pipelines and script wrappers stay untouched. */
function commands(source: string): string[][] | null {
  if (source.length > 16_384) return null;
  const out: string[][] = [];
  let words: string[] = [], word = "", quote = "";
  const flushWord = () => { if (word !== "") { words.push(word); word = ""; } };
  const flush = () => { flushWord(); if (words.length > 0) out.push(words); words = []; };
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quote !== "") {
      if (ch === quote) { quote = ""; continue; }
      if ((quote === '"' && /[$`\\]/.test(ch)) || ch === "\n") return null;
      word += ch; continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "#" && word === "") { while (i < source.length && source[i] !== "\n") i += 1; flush(); continue; }
    if (/[$`\\<>|(){}]/.test(ch)) return null;
    if (ch === "&") { if (source[++i] !== "&") return null; flush(); continue; }
    if (ch === ";" || ch === "\n") { if (words[0] === "cd") return null; flush(); continue; }
    if (/\s/.test(ch)) { flushWord(); continue; }
    word += ch;
  }
  if (quote !== "") return null;
  flush(); return out;
}

/** Resolve explicit cd / git -C before a recognized publish command, without executing shell text. */
export function deploymentDirectories(command: string, cwd: string): string[] {
  const parsed = commands(command);
  if (parsed === null) return [];
  let current = cwd;
  const roots = new Set<string>();
  for (const words of parsed) {
    const [head, verb] = words;
    if (head === "cd") {
      if (words.length !== 2 || verb === "-" || verb === "~") return [];
      current = resolve(current, verb!); continue;
    }
    let args = words;
    let root = current;
    if (head === "git" && verb === "-C") {
      if (words[2] === undefined) return [];
      root = resolve(current, words[2]); args = ["git", ...words.slice(3)];
    }
    const publish = args[0] === "git" && args[1] === "push"
      || ["npm", "pnpm", "bun"].includes(args[0] ?? "") && args[1] === "publish"
      || args[0] === "yarn" && (args[1] === "publish" || args[1] === "npm" && args[2] === "publish")
      || args[0] === "wrangler" && args[1] === "deploy"
      || args[0] === "npx" && args[1] === "wrangler" && args[2] === "deploy"
      || ["npm", "pnpm", "bun"].includes(args[0] ?? "") && args[1] === "run" && args[2] === "deploy";
    if (publish && !args.some((a) => ["--dry-run", "-n", "--help", "-h", "--version"].includes(a))) roots.add(root);
    // A preceding arbitrary command could change directory or replace the workflow.
    // Do not pretend that an inspection before that command covers its output.
    if (!publish && head !== "git") return [];
    if (head === "git" && !publish && !["status", "diff", "log", "add", "commit"].includes(verb ?? "")) return [];
  }
  return roots.size <= 4 ? [...roots] : [];
}

export interface PreflightSettings {
  readonly enabled: boolean;
  readonly rules: readonly RuleId[];
  readonly maxWorkflowBytes: number;
}

interface Opportunity {
  readonly rule: string;
  readonly workflow: string;
  readonly job?: string;
  readonly step?: number;
  readonly next: string;
}

export function inspectPreflight(cwd: string, settings: PreflightSettings) {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", windowsHide: true, timeout: 2000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const directory = join(root, ".github", "workflows");
  if (existsSync(directory) && readdirSync(directory).length > 32) throw new Error("preflight workflow budget exceeded");
  const discovery = discoverWorkflows(root, { maxBytes: Math.min(settings.maxWorkflowBytes || 524288, 524288) });
  if (discovery.workflows.reduce((total, file) => total + file.bytes, 0) > 2 * 1024 * 1024) throw new Error("preflight byte budget exceeded");
  const workflows = discovery.workflows.map((file) => parseWorkflow(file.path, file.text));
  const opportunities: Opportunity[] = [];
  const cacheTargets = settings.rules.includes("CD006") ? workflows.flatMap((workflow) => downloadCacheTargets(workflow, root).map((t) => ({ workflow, ...t }))) : [];
  const dependencies = cacheTargets.map((target) => npmCacheDependencies(root, target));
  for (const [index, { workflow, job, step }] of cacheTargets.entries()) if (dependencies[index] !== null) opportunities.push({ rule: "CD006", workflow: workflow.path,
    job: job.key, step: step.index, next: "ci_diet_scan then ci_diet_plan for this cwd, job and step; review and get human approval before apply" });
  if (settings.rules.includes("CD006")) for (const w of workflows) {
    if (w.parseError !== null || w.unsupported.length > 0) continue;
    for (const job of w.jobs) {
      if (cacheTargets.some((t) => t.workflow.path === w.path && t.job.key === job.key)) continue;
      if (!job.steps.some((s) => s.uses?.startsWith("oven-sh/setup-bun@"))
        || job.steps.some((s) => s.uses !== null && (/cache/i.test(s.uses) || s.uses.startsWith("./")))) continue;
      if (job.steps.some((s) => s.run?.trim() === "bun install --frozen-lockfile")) opportunities.push({ rule: "BUN_CACHE_REVIEW", workflow: w.path, job: job.key,
        next: "No explicit dependency cache step found. Review Bun cache configuration and consider caching dependency downloads with an OS/Bun-version/lockfile key before install. Keep frozen install and tests. This is advice, not a CD006 plan; no measured savings." });
    }
  }
  if (settings.rules.includes("CD001")) for (const w of workflows) {
    if (w.parseError !== null || w.unsupported.length > 0 || w.concurrency !== null || w.triggers.length !== 1 || w.triggers[0] !== "pull_request") continue;
    opportunities.push({ rule: "CD001", workflow: w.path, next: "Review whether superseded PR runs can be cancelled; ci_diet_sync requires network opt-in and plan requires human ci-only/replace-safe claims" });
  }
  return { root, opportunities, fingerprint: digestOf({ workflows: workflows.map((w) => [w.path, w.sha256]), dependencies, rules: settings.rules }) };
}

/** A once-per-session/source reminder, never an automatic patch or network request. */
export function registerPreflight(ctx: Context, settings: () => PreflightSettings, notice: () => string): void {
  const seen = new WeakMap<object, Map<string, string>>();
  ctx.on("tools/pre-execute", async (exec: ToolExecution, next: () => Promise<PreToolDecision>) => {
    const decision = await next();
    if (decision.kind !== "allow" || exec.name !== "bash" || exec.agent === undefined || exec.signal.aborted) return decision;
    const args = exec.arguments as { command?: unknown; workdir?: unknown } | null;
    if (typeof args?.command !== "string") return decision;
    // Only the stateless bash contract is supported. Persistent bash may have
    // changed its own cwd, which the session directory cannot establish.
    const definition = ctx.tools.get("bash", exec.agent);
    const parameters = definition?.parameters as { properties?: Record<string, unknown> } | undefined;
    if (parameters?.properties?.workdir === undefined) return decision;
    try {
      const config = settings();
      if (!config.enabled) return decision;
      const service = ctx.get("workingDirectory") as { get(session: unknown): string } | undefined;
      const base = service?.get(exec.agent.session);
      const cwd = typeof args.workdir === "string" && isAbsolute(args.workdir) ? args.workdir
        : base === undefined ? null : resolve(base, typeof args.workdir === "string" ? args.workdir : ".");
      if (cwd === null) return decision;
      const notices = [];
      const previous = new Map(seen.get(exec.agent));
      for (const directory of deploymentDirectories(args.command, cwd)) {
        const report = inspectPreflight(directory, config);
        if (report.opportunities.length === 0 || previous.get(report.root) === report.fingerprint) continue;
        if (previous.size >= 64) previous.delete(previous.keys().next().value!);
        previous.set(report.root, report.fingerprint);
        notices.push({ cwd: report.root, opportunities: report.opportunities.slice(0, 8), total: report.opportunities.length });
      }
      if (exec.signal.aborted || notices.length === 0) return decision;
      seen.set(exec.agent, previous);
      return { kind: "deny", reason: notice() + "\n" + JSON.stringify(notices) };
    } catch {
      // Advisory inspection must never lock users out of deploying.
      return decision;
    }
  });
}
