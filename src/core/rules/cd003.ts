import type { Finding } from "../contracts/schema.ts";
import type { HistoryRun } from "../history/model.ts";
import { composeCoverage } from "../analysis/coverage.ts";
import { knownSeconds, unknownSeconds } from "../savings/metrics.ts";
import { isAnalyzable } from "../workflow/index.ts";
import { RULE_VERSION } from "../version.ts";
import { buildFinding, ruleResult } from "./types.ts";
import type { DetectionRule, RuleContext, RuleEvaluation } from "./types.ts";
import { historyInputHash, jobSeconds } from "./history-utils.ts";

const RULE_ID = "CD003";

/** A job at or above this many seconds is worth a documentation-scope review. */
export const CD003_HEAVY_SECONDS = 60;

/** Narrow defaults: README, CHANGELOG, and docs/notes only. */
const NON_PRODUCT_DOCS = [/^readme(\.[a-z0-9]+)?$/, /^changelog(\.[a-z0-9]+)?$/, /^docs\/notes\//];

function nonProductDoc(path: string): boolean {
  const normalized = path.replace(/^\.\//, "").toLowerCase();
  return NON_PRODUCT_DOCS.some((pattern) => pattern.test(normalized));
}

function evaluateCd003(context: RuleContext): RuleEvaluation {
  const inputHash = historyInputHash(context, RULE_ID);
  if (context.history === undefined || context.mode !== "history") {
    return skipped(inputHash, ["HISTORY_NOT_SYNCED"]);
  }
  const composition = composeCoverage(context.coverage, RULE_ID);
  if (composition.level === "skip") return skipped(inputHash, composition.reasons);

  // One pass over the runs builds every pull request bucket; the docs-only
  // pull loop then walks its own runs in history order instead of rescanning
  // all runs for each pull. A pull number repeated in one run is recorded once.
  const runsByPull = new Map<number, HistoryRun[]>();
  for (const run of context.history.runs) {
    if (run.event !== "pull_request") continue;
    for (const number of new Set(run.pullRequestNumbers)) {
      const bucket = runsByPull.get(number);
      if (bucket === undefined) runsByPull.set(number, [run]);
      else bucket.push(run);
    }
  }
  interface HeavyTotals {
    readonly count: number;
    readonly seconds: number;
    readonly refs: string[];
  }
  const heavyByRun = new Map<string, HeavyTotals>();
  const heavyTotals = (run: HistoryRun): HeavyTotals => {
    const cached = heavyByRun.get(run.runId);
    if (cached !== undefined) return cached;
    const heavy = run.jobs.filter((job) => {
      const seconds = jobSeconds(job);
      return seconds !== null && seconds >= CD003_HEAVY_SECONDS;
    });
    const totals: HeavyTotals = {
      count: heavy.length,
      seconds: heavy.reduce((sum, job) => sum + (jobSeconds(job) ?? 0), 0),
      refs: heavy.map((job) => "job:" + job.jobId),
    };
    heavyByRun.set(run.runId, totals);
    return totals;
  };

  const findings: Finding[] = [];
  for (const number of context.history.pulls.keys()) {
    const pullRuns = runsByPull.get(number);
    if (pullRuns === undefined) continue;
    for (const run of pullRuns) {
      const diff = run.pullDiffs?.find((item) => item.number === number && item.headSha === run.headSha
        && /^[a-f0-9]{40}$/i.test(item.baseSha));
      const files = diff?.files;
      if (files === undefined || files === null || files.length === 0 || !files.every(nonProductDoc)) continue;
      if (run.definition === null || !isAnalyzable(run.definition)) continue;
      const heavy = heavyTotals(run);
      if (heavy.count === 0) continue;
      const heavySeconds = heavy.seconds;
      const blockers = ["PATH_FILTER_NOT_GENERATED", "REQUIRED_CHECK_PENDING_RISK"];
      if (context.coverage.protectionRules.status !== "complete") blockers.push("PROTECTION_RULES_UNVERIFIED");
      const observed = composition.level === "full";
      findings.push(
        buildFinding({
          ruleId: RULE_ID,
          ruleVersion: RULE_VERSION,
          workflowPath: run.workflowPath,
          workflowHash: run.definition.sha256,
          title: "Documentation-only pull request #" + number + " ran heavy checks",
          renderedText:
            "Pull request #" + number + " changed only non-product documentation (" + files.join(", ") + "), yet " +
            heavy.count + " job(s) ran for at least " + CD003_HEAVY_SECONDS + " seconds each (" + heavySeconds.toFixed(1) + " runner seconds total). " +
            "CI Diet does not generate path filters in v0.1: a workflow-level paths skip can leave a required check Pending.",
          message: {
            titleKey: "finding.CD003.title",
            textKey: "finding.CD003.text",
            params: {
              pullRequest: number,
              files: files.join(", "),
              heavy: heavy.count,
              seconds: CD003_HEAVY_SECONDS,
              total: heavySeconds.toFixed(1),
            },
          },
          evidenceLevel: observed ? "observed" : "inferred",
          patchability: "review-only",
          evidenceRefs: ["pull:" + number, ...heavy.refs],
          assumptions: [
            "Only README, CHANGELOG, and docs/notes count as non-product documentation by default.",
            "MDX, documentation sites, API schemas, translations, fixtures, lockfiles, CI files, and shared scripts are product code.",
            "Both old and new paths of a rename are checked.",
          ],
          blockers,
          standaloneRunnerSeconds: observed
            ? knownSeconds(heavySeconds, "observed runner seconds of heavy jobs on the documentation-only pull request")
            : unknownSeconds("history or changed files are partial", "COVERAGE_SUBSET"),
          identity: { workflowPath: run.workflowPath, pullRequest: number, runId: run.runId, files: files },
        }),
      );
    }
  }

  return {
    results: [
      ruleResult({
        ruleId: RULE_ID,
        ruleVersion: RULE_VERSION,
        inputHash,
        outcome: findings.length > 0 ? "candidate" : "no_finding",
        reasons: [...composition.reasons, ...(findings.length > 0 ? ["DOCS_ONLY_HEAVY_RUN"] : ["NO_DOCS_ONLY_HEAVY_RUN"])],
        findings,
      }),
    ],
    findings,
    removals: [],
  };
}

function skipped(inputHash: string, reasons: readonly string[]): RuleEvaluation {
  return {
    results: [ruleResult({ ruleId: RULE_ID, ruleVersion: RULE_VERSION, inputHash, outcome: "skipped", reasons })],
    findings: [],
    removals: [],
  };
}

export const cd003: DetectionRule = { id: RULE_ID, version: RULE_VERSION, evaluate: evaluateCd003 };