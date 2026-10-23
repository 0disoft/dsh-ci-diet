import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectRunObservation } from "../adapters/github/run-observation.ts";
import { compareRuns } from "../core/analysis/run-comparison.ts";
import { renderRunComparison } from "../core/report/run-comparison.ts";
import { withDeadline } from "../core/support/deadline.ts";
import { lookupGithubRemote } from "../core/scan/binding.ts";
import { resolveRequestedLocale } from "../shared/i18n/host.ts";
import type { CliContext } from "./index.ts";
import type { GhRunner } from "../adapters/github/transport.ts";

const HELP = "Usage: ci-diet compare --before-run <id> --after-run <id> --network [--repo <owner/name>] [--cwd <path>] [--format json|html] [--out <file>] [--lang <locale>]\n";

/** Separate parser keeps the new command out of the legacy, large CLI module. */
export async function compareCommand(argv: readonly string[], context: CliContext, runner?: GhRunner): Promise<number> {
  let before = "", after = "", network = false, repo: string | undefined, cwd = context.cwd;
  let format = "json", out: string | undefined, lang: string | null = null;
  try {
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i]!;
      if (flag === "--help" || flag === "-h") { context.stdout.write(HELP); return 0; }
      if (flag === "--network") { network = true; continue; }
      if (flag === "--json") { format = "json"; continue; }
      if (!["--before-run", "--after-run", "--repo", "--cwd", "--format", "--out", "--lang"].includes(flag)) throw new Error("UNKNOWN_FLAG:" + flag);
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error("MISSING_VALUE:" + flag);
      if (flag === "--before-run") before = value;
      if (flag === "--after-run") after = value;
      if (flag === "--repo") repo = value;
      if (flag === "--cwd") cwd = resolve(context.cwd, value);
      if (flag === "--format") format = value;
      if (flag === "--out") out = value;
      if (flag === "--lang") lang = value;
    }
    if (![before, after].every((id) => /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)))) throw new Error("RUN_IDS_REQUIRED");
    if (!["json", "html"].includes(format)) throw new Error("INVALID_FORMAT");
    if (!network) throw new Error("NETWORK_OPT_IN_REQUIRED:--network");
    if (repo === undefined) {
      const remote = lookupGithubRemote(cwd);
      if (remote.kind === "github") repo = remote.remote.fullName;
    }
    if (repo === undefined) throw new Error("REPOSITORY_REQUIRED:--repo");
    const deadline = withDeadline(context.signal, 60_000, "compare");
    try {
      const options = { signal: deadline.signal, ...(runner === undefined ? {} : { runner }) };
      const left = await collectRunObservation(repo, Number(before), options);
      const right = await collectRunObservation(repo, Number(after), options);
      const report = compareRuns(left, right);
      const output = format === "html" ? renderRunComparison(report, resolveRequestedLocale(lang, context.env)) : JSON.stringify(report, null, 2) + "\n";
      if (out === undefined) context.stdout.write(output);
      else writeFileSync(resolve(cwd, out), output, { flag: "wx" });
      return report.comparable ? 0 : 3;
    } finally { deadline.dispose(); }
  } catch (error) {
    context.stderr.write("error: " + (error instanceof Error ? error.message : String(error)) + "\n");
    return context.signal?.aborted === true ? 130 : 1;
  }
}
