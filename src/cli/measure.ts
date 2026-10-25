import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectChangeEffect } from "../adapters/github/change-effect.ts";
import type { GhRunner } from "../adapters/github/transport.ts";
import { PatchStore } from "../core/patch/store.ts";
import { defaultStateDir } from "../core/state/paths.ts";
import { withDeadline } from "../core/support/deadline.ts";
import type { CliContext } from "./index.ts";

const HELP = "Usage: ci-diet measure --change <id> --before-runs <id,id> --after-runs <id,id> --network [--cwd <path>] [--state-dir <path>] [--out <json>]\n";
function runIds(value: string): number[] {
  if (!/^[1-9]\d*(,[1-9]\d*){0,9}$/.test(value)) throw new Error("INVALID_RUN_SELECTION");
  return value.split(",").map(Number);
}

export async function measureCommand(argv: readonly string[], context: CliContext, runner?: GhRunner): Promise<number> {
  let cwd = context.cwd, state: string | null = null, changeId = "", network = false, out: string | null = null;
  let before: number[] = [], after: number[] = [];
  try {
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i]!;
      if (flag === "--help" || flag === "-h") { context.stdout.write(HELP); return 0; }
      if (flag === "--network") { network = true; continue; }
      if (flag === "--json") continue;
      if (!["--change", "--before-runs", "--after-runs", "--cwd", "--state-dir", "--out"].includes(flag)) throw new Error("UNKNOWN_FLAG:" + flag);
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error("MISSING_VALUE:" + flag);
      if (flag === "--cwd") cwd = resolve(context.cwd, value);
      if (flag === "--state-dir") state = value;
      if (flag === "--change") changeId = value;
      if (flag === "--before-runs") before = runIds(value);
      if (flag === "--after-runs") after = runIds(value);
      if (flag === "--out") out = value;
    }
    if (!changeId || !before.length || !after.length) throw new Error("CHANGE_AND_RUNS_REQUIRED");
    if (!network) throw new Error("NETWORK_OPT_IN_REQUIRED:--network");
    const statePath = state === null ? defaultStateDir(context.env) : resolve(cwd, state);
    if (!existsSync(statePath)) throw new Error("STATE_NOT_FOUND");
    const store = PatchStore.open(statePath);
    const change = store.readChange(changeId);
    if (change === null) throw new Error("CHANGE_NOT_FOUND");
    const binding = store.readBinding(change.bindingId);
    if (binding === null || realpathSync(binding.workspaceRoot) !== realpathSync(cwd)) throw new Error("BINDING_MISMATCH");
    const deadline = withDeadline(context.signal, 120_000, "measure");
    try {
      const report = await collectChangeEffect(binding.repositoryFullName, change, before, after, {
        signal: deadline.signal, ...(runner === undefined ? {} : { runner }),
      });
      const output = JSON.stringify(report, null, 2) + "\n";
      if (out === null) context.stdout.write(output);
      else writeFileSync(resolve(cwd, out), output, { flag: "wx" });
      return report.comparable ? 0 : 3;
    } finally { deadline.dispose(); }
  } catch (error) {
    context.stderr.write("error: " + (error instanceof Error ? error.message : String(error)) + "\n");
    return context.signal?.aborted === true ? 130 : 1;
  }
}
