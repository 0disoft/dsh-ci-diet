import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { sha256Hex } from "../../shared/cdj1.ts";
import type { WorkflowDefinition, WorkflowJob, WorkflowStep } from "../workflow/model.ts";

export interface NpmCacheTarget { readonly job: WorkflowJob; readonly step: WorkflowStep }

/** Deliberately narrow: v3/v4 have opt-in npm caching; newer versions can auto-cache. */
export function npmCacheTargets(workflow: WorkflowDefinition): NpmCacheTarget[] {
  if (workflow.parseError !== null || workflow.unsupported.length > 0 || workflow.defaultWorkingDirectory !== null) return [];
  const targets: NpmCacheTarget[] = [];
  for (const job of workflow.jobs) {
    if (job.defaultWorkingDirectory !== null || job.reusableWorkflow !== null) continue;
    if (job.steps.some((step) => step.uses !== null && (/cache/i.test(step.uses) || step.uses.startsWith("./")))) continue;
    const setups = job.steps.filter((step) => /^actions\/setup-node@v[34](?:\.\d+){0,2}$/.test(step.uses ?? ""));
    if (setups.length !== 1 || job.steps.filter((step) => (step.uses ?? "").startsWith("actions/setup-node@")).length !== 1) continue;
    const step = setups[0]!;
    const checkout = job.steps[step.index - 1];
    const install = job.steps[step.index + 1];
    if (!(checkout?.uses ?? "").startsWith("actions/checkout@") || install?.run?.trim() !== "npm ci") continue;
    if (checkout!.withPresent || checkout!.otherEntries.some((entry) => entry.key !== "id")) continue;
    if (step.flow || step.withFlow || step.otherEntries.some((entry) => entry.key !== "id")) continue;
    if (install.otherEntries.some((entry) => entry.key !== "id")) continue;
    if (step.withEntries.some((entry) => ["cache", "cache-dependency-path", "package-manager-cache"].includes(entry.key))) continue;
    targets.push({ job, step });
  }
  return targets;
}

/** Pin the actual root manifest and lock; do not follow symlinks or read large files. */
export function npmCacheDependencies(root: string): { ref: string; sha256: string }[] | null {
  try {
    const realRoot = realpathSync(root);
    // npm ci prefers shrinkwrap to package-lock; this proposal must not key a
    // different dependency tree. Use the patch dependency collector's 2 MiB cap.
    if (existsSync(join(realRoot, "npm-shrinkwrap.json"))) return null;
    execFileSync("git", ["ls-files", "--error-unmatch", "--", "package.json", "package-lock.json"], {
      cwd: realRoot, timeout: 2000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const dependencies = ["package.json", "package-lock.json"].map((ref) => {
      const path = join(realRoot, ref);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error("unsupported manifest");
      const bytes = readFileSync(path);
      const value = JSON.parse(bytes.toString("utf8"));
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid manifest");
      if (ref === "package-lock.json" && ![1, 2, 3].includes(value.lockfileVersion)) throw new Error("unsupported lockfile");
      return { ref, sha256: "sha256:" + sha256Hex(bytes.toString("utf8")) };
    });
    return dependencies;
  } catch { return null; }
}
