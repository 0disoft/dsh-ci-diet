import type { Finding } from "../contracts/schema.ts";
import type { HistoryRun } from "../history/model.ts";
import type { WorkflowDefinition } from "../workflow/model.ts";
import { composeCoverage } from "../analysis/coverage.ts";
import { knownSeconds } from "../savings/metrics.ts";
import type { RuleRemoval } from "./types.ts";
import { buildFinding, ruleResult } from "./types.ts";
import type { DetectionRule, RuleContext, RuleEvaluation } from "./types.ts";
import { analyzableRuns, historyInputHash, jobLooksRisky, millis } from "./history-utils.ts";
import { RULE_VERSION } from "../version.ts";

const RULE_ID = "CD001";

/** Cancellation-lag scenarios used to present CD001 as a range. */
export const CD001_LAGS_SECONDS = [0, 30] as const;

interface RemovalAt {
  readonly jobId: string;
  readonly startMillis: number;
  readonly endMillis: number;
  readonly durationMillis: number;
}

function replacementOf(runs: readonly HistoryRun[], run: HistoryRun): HistoryRun | null {
  const created = millis(run.createdAt);
  if (created === null) return null;
  let best: HistoryRun | null = null;
  let bestAt = Number.POSITIVE_INFINITY;
  for (const candidate of runs) {
    if (candidate.runId === run.runId) continue;
    if (candidate.headSha === run.headSha) continue;
    const at = millis(candidate.createdAt);
    if (at === null || at <= created) continue;
    if (at < bestAt) {
      best = candidate;
      bestAt = at;
    }
  }
  return best;
}

function collectRemovals(run: HistoryRun, replacement: HistoryRun, lagSeconds: number): RemovalAt[] {
  const replacementAt = millis(replacement.createdAt);
  if (replacementAt === null) return [];
  const cutoff = replacementAt + lagSeconds * 1000;
  const rows: RemovalAt[] = [];
  for (const job of run.jobs) {
    const start = millis(job.startedAt);
    const end = job.completedAt === null ? null : millis(job.completedAt);
    const duration = job.durationMillis;
    if (start === null || end === null || duration === null || duration <= 0) continue;
    if (end <= cutoff) continue;
    const removedStart = Math.max(start, cutoff);
    const removedMillis = end - removedStart;
    if (removedMillis <= 0) continue;
    const relStart = removedStart - start;
    const relEnd = Math.min(duration, relStart + removedMillis);
    if (relEnd <= relStart) continue;
    rows.push({ jobId: job.jobId, startMillis: relStart, endMillis: relEnd, durationMillis: duration });
  }
  return rows;
}

/**
 * The stored protection snapshot is read for the default branch only, so a run
 * whose pull request targets another branch cannot be judged from it. Classic
 * protection and required checks also hide ownership that this tool cannot
 * resolve, so anything other than "no classic protection, zero required
 * checks, on the default branch" stays review-only.
 */
function protectionBlockers(context: RuleContext, run: HistoryRun): string[] {
  const blockers: string[] = [];
  const protection = context.history?.protection ?? null;
  if (context.coverage.protectionRules.status !== "complete" || protection === null) {
    blockers.push("PROTECTION_RULES_UNAVAILABLE");
    return blockers;
  }
  const pull = context.history?.pulls.get(run.pullRequestNumbers[0] ?? -1) ?? null;
  if (pull === null) blockers.push("PULL_REQUEST_BASE_BRANCH_UNKNOWN");
  else if (pull.baseBranch !== protection.defaultBranch) blockers.push("PULL_REQUEST_BASE_BRANCH_NOT_DEFAULT");
  if (protection.classicProtection !== false) blockers.push("CLASSIC_BRANCH_PROTECTION_UNKNOWN");
  if (protection.ruleCount === null || protection.ruleCount > 0) blockers.push("REQUIRED_CHECK_OWNERSHIP_UNKNOWN");
  return blockers;
}

function staticBlockers(context: RuleContext, definition: WorkflowDefinition, run: HistoryRun): string[] {
  const blockers: string[] = [];
  const triggers = [...definition.triggers].sort();
  if (triggers.length !== 1 || triggers[0] !== "pull_request") blockers.push("WORKFLOW_TRIGGERS_NOT_PR_ONLY");
  if (definition.concurrency !== null) blockers.push("EXISTING_CONCURRENCY_POLICY");
  if (definition.jobs.some((job) => job.environment !== null)) blockers.push("ENVIRONMENT_DEPENDENCY");
  if (definition.jobs.some((job) => job.reusableWorkflow !== null)) blockers.push("REUSABLE_WORKFLOW_JOB");
  if (definition.jobs.some((job) => jobLooksRisky(job))) blockers.push("DEPLOY_OR_RELEASE_JOB");
  blockers.push(...protectionBlockers(context, run));
  return blockers;
}

function evaluateCd001(context: RuleContext): RuleEvaluation {
  const inputHash = historyInputHash(context, RULE_ID);
  if (context.history === undefined || context.mode !== "history") {
    return skipped(inputHash, ["HISTORY_NOT_SYNCED"]);
  }
  const composition = composeCoverage(context.coverage, RULE_ID);
  if (composition.level === "skip") return skipped(inputHash, composition.reasons);

  const groups = new Map<string, HistoryRun[]>();
  for (const { run } of analyzableRuns(context.history)) {
    if (run.event !== "pull_request") continue;
    if (run.pullRequestNumbers.length !== 1) continue;
    const pullRequest = run.pullRequestNumbers[0];
    if (pullRequest === undefined) continue;
    const key = run.workflowPath + "#" + pullRequest;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [run]);
    else bucket.push(run);
  }

  const findings: Finding[] = [];
  const removals: RuleRemoval[] = [];
  for (const bucket of groups.values()) {
    bucket.sort((a, b) => {
      const left = millis(a.createdAt) ?? 0;
      const right = millis(b.createdAt) ?? 0;
      return left === right ? (a.runId < b.runId ? -1 : 1) : left - right;
    });
    for (const run of bucket) {
      const replacement = replacementOf(bucket, run);
      if (replacement === null) continue;
      if (run.definition === null || replacement.definition === null) continue;
      const definition = run.definition;
      const pullRequest = run.pullRequestNumbers[0] ?? 0;
      const removalsAtZero = collectRemovals(run, replacement, 0);
      if (removalsAtZero.length === 0) continue;
      const removalsAtThirty = collectRemovals(run, replacement, 30);
      const removedZero = removalsAtZero.reduce((sum, row) => sum + (row.endMillis - row.startMillis) / 1000, 0);
      const removedThirty = removalsAtThirty.reduce((sum, row) => sum + (row.endMillis - row.startMillis) / 1000, 0);
      const blockers = staticBlockers(context, definition, run);
      if (composition.level !== "full") blockers.push("COVERAGE_" + composition.level.toUpperCase());
      const eligible = blockers.length === 0 && composition.writeAllowed;
      const finding = buildFinding({
        ruleId: RULE_ID,
        ruleVersion: RULE_VERSION,
        workflowPath: run.workflowPath,
        workflowHash: definition.sha256,
        title: "Pull request #" + pullRequest + " left a superseded run on " + run.workflowPath,
        renderedText:
          "Run " + run.runId + " for pull request #" + pullRequest + " started before a newer run on a different head commit. " +
          "Cancelling it when the replacement was created would have saved about " + removedZero.toFixed(1) + " runner seconds at a 0 s lag, or " +
          removedThirty.toFixed(1) + " runner seconds at a 30 s lag. The lag is a scenario, not a measured cancellation time.",
        message: {
          titleKey: "finding.CD001.title",
          textKey: "finding.CD001.text",
          params: {
            pullRequest,
            workflow: run.workflowPath,
            runId: run.runId,
            removedZero: removedZero.toFixed(1),
            removedThirty: removedThirty.toFixed(1),
          },
        },
        evidenceLevel: "observed",
        patchability: eligible ? "eligible" : "review-only",
        evidenceRefs: [
          "run:" + run.runId,
          "run:" + replacement.runId,
          "workflow:" + run.workflowPath,
          ...removalsAtZero.map((row) => "job:" + row.jobId),
        ],
        assumptions: [
          "The replacement is the first newer run with a different head commit; same-SHA reruns do not replace.",
          "Cancellation lag is presented as a 0 s and 30 s range, never as a measured time.",
          "A human Attestation must cover ciOnly and replaceSafe before any plan is approved.",
        ],
        blockers,
        standaloneRunnerSeconds: knownSeconds(removedZero, "runner seconds in the superseded run after the replacement started"),
        identity: {
          workflowPath: run.workflowPath,
          pullRequest,
          runId: run.runId,
          replacementRunId: replacement.runId,
          headSha: run.headSha,
          replacementHeadSha: replacement.headSha,
        },
      });
      findings.push(finding);
      for (const row of removalsAtZero) {
        removals.push({
          findingId: finding.findingId,
          jobId: row.jobId,
          startMillis: Math.round(row.startMillis),
          endMillis: Math.round(row.endMillis),
        });
      }
    }
  }

  return {
    results: [
      ruleResult({
        ruleId: RULE_ID,
        ruleVersion: RULE_VERSION,
        inputHash,
        outcome: findings.length > 0 ? "finding" : "no_finding",
        reasons: [...composition.reasons, ...(findings.length > 0 ? ["SUPERSEDED_PR_RUN"] : ["NO_SUPERSEDED_PR_RUN"])],
        findings,
      }),
    ],
    findings,
    removals,
  };
}

function skipped(inputHash: string, reasons: readonly string[]): RuleEvaluation {
  return {
    results: [ruleResult({ ruleId: RULE_ID, ruleVersion: RULE_VERSION, inputHash, outcome: "skipped", reasons })],
    findings: [],
    removals: [],
  };
}

export const cd001: DetectionRule = { id: RULE_ID, version: RULE_VERSION, evaluate: evaluateCd001 };