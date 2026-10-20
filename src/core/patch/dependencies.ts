import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { WorkflowDefinition } from "../workflow/model.ts";
import { sha256Hex } from "../../shared/cdj1.ts";

/** Files a workflow runs from the repository, pinned by content hash. */
export interface DependencyRef {
  readonly ref: string;
  readonly sha256: string;
}

const MAX_DEPENDENCY_BYTES = 2 * 1024 * 1024;
const LOCAL_ACTION_FILES = ["action.yml", "action.yaml"];

function toPosix(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/");
}

function resolveInside(realRoot: string, candidate: string): string | null {
  if (isAbsolute(candidate)) return null;
  if (candidate.startsWith("-")) return null;
  if (candidate.includes("://")) return null;
  if (candidate.includes("${{")) return null;
  const target = join(realRoot, candidate);
  if (!existsSync(target)) return null;
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    return null;
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
  let info;
  try {
    info = statSync(real);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;
  if (info.size > MAX_DEPENDENCY_BYTES) return null;
  return real;
}

function hashFile(realPath: string): string | null {
  try {
    return "sha256:" + sha256Hex(readFileSync(realPath, "utf8"));
  } catch {
    return null;
  }
}

function commandTokens(run: string): string[] {
  return run
    .split(/\r?\n/)
    .flatMap((line) => line.split(/&&|\|\||[;|]/))
    .flatMap((segment) => segment.trim().split(/\s+/))
    .map((token) => token.replace(/^["\u0027]|["\u0027]$/g, ""))
    .filter((token) => token.length > 0);
}

/**
 * Collect local files a workflow depends on: script arguments that look like
 * repository paths and local actions referenced with `uses: ./...`. The plan
 * stores their hashes so an apply can refuse when a script changed.
 */
export function collectDependencies(workspaceRoot: string, workflow: WorkflowDefinition): DependencyRef[] {
  let realRoot: string;
  try {
    realRoot = realpathSync(workspaceRoot);
  } catch {
    return [];
  }
  const found = new Map<string, string>();
  const add = (candidate: string): void => {
    const real = resolveInside(realRoot, candidate);
    if (real === null) return;
    const relativePath = toPosix(relative(realRoot, real));
    if (relativePath === "" || relativePath.startsWith("..")) return;
    if (found.has(relativePath)) return;
    const hash = hashFile(real);
    if (hash === null) return;
    found.set(relativePath, hash);
  };

  for (const job of workflow.jobs) {
    for (const step of job.steps) {
      if (step.uses !== null && step.uses.startsWith("./")) {
        for (const actionFile of LOCAL_ACTION_FILES) {
          add(step.uses.slice(2) + "/" + actionFile);
        }
      }
      if (step.run === null) continue;
      for (const token of commandTokens(step.run)) {
        if (!token.includes("/")) continue;
        add(token);
      }
    }
  }

  return [...found.entries()]
    .map(([ref, sha256]) => ({ ref, sha256 }))
    .sort((left, right) => (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0));
}
