import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Product cap for one workflow source file (see docs/spec/storage.md). */
export const WORKFLOW_MAX_BYTES = 512 * 1024;

const WORKFLOW_FILE = /\.ya?ml$/i;
const WORKFLOW_DIR = [".github", "workflows"];

export type SkippedWorkflowReason =
  | "WORKFLOW_TOO_LARGE"
  | "WORKFLOW_NOT_A_FILE"
  | "WORKFLOW_OUTSIDE_ROOT"
  | "WORKFLOW_UNREADABLE"
  | "WORKFLOW_PARSE_ERROR"
  | "WORKFLOW_UNSUPPORTED";

export interface SkippedWorkflow {
  readonly path: string;
  readonly reason: SkippedWorkflowReason;
}

export interface DiscoveredWorkflow {
  /** Repository-relative POSIX path, for example `.github/workflows/ci.yml`. */
  readonly path: string;
  readonly text: string;
  readonly bytes: number;
}

export interface DiscoveryResult {
  readonly root: string;
  readonly workflows: readonly DiscoveredWorkflow[];
  readonly skipped: readonly SkippedWorkflow[];
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function insideRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath !== "" && !relativePath.startsWith("..") && !relativePath.includes(".." + sep);
}

/**
 * Discover `.github/workflows/*.yml|yaml` without following links.
 *
 * The scan is deliberately shallow: GitHub only reads the top level of the
 * workflows directory, and following a junction could read outside the root.
 */
export function discoverWorkflows(
  workspaceRoot: string,
  options: { maxBytes?: number } = {},
): DiscoveryResult {
  const maxBytes = options.maxBytes ?? WORKFLOW_MAX_BYTES;
  const root = realpathSync.native(workspaceRoot);
  const directory = join(root, ...WORKFLOW_DIR);
  const workflows: DiscoveredWorkflow[] = [];
  const skipped: SkippedWorkflow[] = [];

  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    // A missing workflows directory is normal; other failures mean coverage is incomplete.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      skipped.push({ path: toPosix(join(...WORKFLOW_DIR)), reason: "WORKFLOW_UNREADABLE" });
    }
    return { root, workflows, skipped };
  }

  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (!WORKFLOW_FILE.test(entry.name)) continue;
    const absolute = join(directory, entry.name);
    const path = toPosix(relative(root, absolute));
    if (entry.isSymbolicLink() || !entry.isFile()) {
      skipped.push({ path, reason: "WORKFLOW_NOT_A_FILE" });
      continue;
    }

    let bytes: number;
    try {
      const resolved = realpathSync.native(absolute);
      if (!insideRoot(root, resolved)) {
        skipped.push({ path, reason: "WORKFLOW_OUTSIDE_ROOT" });
        continue;
      }
      bytes = statSync(resolved).size;
      if (bytes > maxBytes) {
        skipped.push({ path, reason: "WORKFLOW_TOO_LARGE" });
        continue;
      }
      const text = readFileSync(resolved, "utf8");
      workflows.push({ path, text, bytes });
    } catch {
      skipped.push({ path, reason: "WORKFLOW_UNREADABLE" });
    }
  }

  return { root, workflows, skipped };
}
