import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { sha256Hex } from "../../shared/cdj1.ts";
import type { WorkflowDefinition, WorkflowJob, WorkflowStep } from "../workflow/model.ts";

export type CacheManager = "npm" | "pnpm";
export interface NpmCacheTarget {
  readonly job: WorkflowJob;
  readonly step: WorkflowStep;
  readonly manager: CacheManager;
  readonly directory: string;
  readonly lockfile: string;
}

function directoryOf(workflow: WorkflowDefinition, job: WorkflowJob, install: WorkflowStep): string | null {
  const entry = install.otherEntries.find((item) => item.key === "working-directory");
  const dir = entry === undefined ? (job.defaultWorkingDirectory ?? workflow.defaultWorkingDirectory ?? ".") : entry.literal;
  if (dir === null || !/^[A-Za-z0-9_./@-]+$/.test(dir) || dir.startsWith("/") || dir.split("/").includes("..")) return null;
  return dir.replace(/^\.\//, "").replace(/\/$/, "") || ".";
}

function packageManifest(root: string, directory: string): Record<string, unknown> | null {
  try { return JSON.parse(readPinned(root, (directory === "." ? "" : directory + "/") + "package.json").toString("utf8")); }
  catch { return null; }
}

/** Add cache inputs only where the install and selected lockfile are unambiguous. */
export function npmCacheTargets(workflow: WorkflowDefinition, root?: string): NpmCacheTarget[] {
  if (workflow.parseError !== null || workflow.unsupported.length > 0) return [];
  const targets: NpmCacheTarget[] = [];
  for (const job of workflow.jobs) {
    if (job.reusableWorkflow !== null || job.steps.some((step) => /cache/i.test(step.uses ?? "") || (step.uses ?? "").startsWith("./"))) continue;
    const setups = job.steps.filter((step) => /^actions\/setup-node@v[3-7](?:\.\d+){0,2}$/.test(step.uses ?? ""));
    if (setups.length !== 1 || job.steps.filter((step) => (step.uses ?? "").startsWith("actions/setup-node@")).length !== 1) continue;
    const step = setups[0]!;
    const installs = job.steps.filter((item) => /^(?:npm ci|pnpm install --frozen-lockfile)$/.test(item.run?.trim() ?? ""));
    if (installs.length !== 1) continue;
    const install = installs[0]!;
    const manager: CacheManager = install.run!.trim().startsWith("pnpm") ? "pnpm" : "npm";
    const checkout = job.steps.find((item) => (item.uses ?? "").startsWith("actions/checkout@"));
    if (checkout === undefined || checkout.index >= step.index || install.index <= step.index
      || checkout.withEntries.some((item) => item.key !== "fetch-depth") || checkout.otherEntries.some((item) => item.key !== "id")) continue;
    if (step.flow || step.withFlow || step.otherEntries.some((item) => item.key !== "id")
      || install.otherEntries.some((item) => !["id", "working-directory"].includes(item.key))) continue;
    if (step.withEntries.some((entry) => ["cache", "cache-dependency-path", "package-manager-cache"].includes(entry.key))) continue;
    // Unknown commands between checkout and install may mutate the dependency tree.
    if (job.steps.slice(checkout.index + 1, install.index).some((item) => item !== step
      && !(item.run !== null && /^(?:echo [^\n]+|(?:node|npm|pnpm) --version)$/.test(item.run.trim()) && item.otherEntries.length === 0)
      && !((item.uses ?? "").startsWith("pnpm/action-setup@") && item.index < step.index
        && item.otherEntries.length === 0 && item.withEntries.every((entry) => entry.key === "version" || (entry.key === "run_install" && entry.literal === "false"))))) continue;
    if (manager === "pnpm" && !job.steps.slice(0, step.index).some((item) => (item.uses ?? "").startsWith("pnpm/action-setup@"))) continue;
    const directory = directoryOf(workflow, job, install);
    if (directory === null || (root === undefined && directory !== ".")) continue;
    const version = Number(/@v(\d+)/.exec(step.uses!)![1]);
    if (version >= 5) {
      if (root === undefined) continue;
      const manifest = packageManifest(root, ".");
      if (manifest === null) continue;
      const dev = manifest.devEngines as { packageManager?: { name?: unknown } } | undefined;
      const declared = dev?.packageManager?.name ?? (typeof manifest.packageManager === "string" ? manifest.packageManager.split("@")[0] : undefined);
      if (version === 5 ? declared !== undefined : declared === "npm") continue;
    }
    const lockfile = (directory === "." ? "" : directory + "/") + (manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml");
    const target = { job, step, manager, directory, lockfile };
    if (root !== undefined && npmCacheDependencies(root, target) === null) continue;
    targets.push(target);
  }
  return targets;
}

/** Bound reads, require Git-tracked files, and reject symlinked ancestors. */
function readPinned(root: string, ref: string, alreadyTracked = false): Buffer {
  const realRoot = realpathSync(root);
  let path = realRoot;
  for (const part of ref.split("/")) {
    if (!part || part === "..") throw new Error("unsafe cache path");
    path = join(path, part);
    if (lstatSync(path).isSymbolicLink()) throw new Error("symlinked dependency");
  }
  const escaped = relative(realRoot, realpathSync(path));
  if (escaped.startsWith(".." + sep) || escaped === "..") throw new Error("dependency outside root");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("unsupported manifest");
  if (!alreadyTracked) execFileSync("git", ["ls-files", "--error-unmatch", "--", ref], { cwd: realRoot, timeout: 10_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  return readFileSync(path);
}

export function npmCacheDependencies(root: string, target: Pick<NpmCacheTarget, "directory" | "manager" | "lockfile"> = { directory: ".", manager: "npm", lockfile: "package-lock.json" }): { ref: string; sha256: string }[] | null {
  try {
    const prefix = target.directory === "." ? "" : target.directory + "/";
    if (target.manager === "npm" && existsSync(join(root, prefix, "npm-shrinkwrap.json"))) return null;
    const refs = [...new Set(["package.json", prefix + "package.json", target.lockfile])];
    execFileSync("git", ["ls-files", "--error-unmatch", "--", ...refs], { cwd: root, timeout: 10_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    return refs.map((ref) => {
      const bytes = readPinned(root, ref, true);
      if (ref.endsWith(".json")) {
        const value = JSON.parse(bytes.toString("utf8"));
        if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid manifest");
        if (ref.endsWith("package-lock.json") && ![1, 2, 3].includes(value.lockfileVersion)) throw new Error("unsupported lockfile");
      }
      return { ref, sha256: "sha256:" + sha256Hex(bytes.toString("utf8")) };
    });
  } catch { return null; }
}
