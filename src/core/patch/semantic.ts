import { canonicalJson } from "../../shared/cdj1.ts";
import type { ByteEdit } from "../contracts/schema.ts";
import type { WorkflowDefinition, WorkflowJob, WorkflowStep } from "../workflow/model.ts";
import { parseWorkflow } from "../workflow/parse.ts";

/**
 * Semantic guard for a patch plan.
 *
 * The byte ranges in a plan decide what the editor may touch, but ranges alone
 * cannot describe intent: inserting a mapping after `uses:` could add an `env:`
 * key instead of `with:`. This module re-parses the edited bytes and compares a
 * projection of both definitions that erases exactly the fields the plan claims
 * to change. Any remaining difference is outside the allowed edit.
 */

interface StepView {
  readonly name: string | null;
  readonly uses: string | null;
  readonly run: string | null;
  readonly withPresent: boolean;
  readonly flow: boolean;
  readonly entries: readonly { readonly key: string; readonly kind: string; readonly literal: string | null }[];
  readonly other: readonly { readonly key: string; readonly kind: string; readonly literal: string | null }[];
}

interface JobView {
  readonly key: string;
  readonly displayName: string | null;
  readonly timeoutMinutes: number | null;
  readonly matrix: WorkflowJob["matrix"];
  readonly needs: readonly string[];
  readonly runsOn: string | null;
  readonly environment: string | null;
  readonly reusableWorkflow: string | null;
  readonly steps: readonly StepView[];
}

interface WorkflowView {
  readonly name: string | null;
  readonly triggers: readonly string[];
  readonly pullRequestTypes: readonly string[] | null;
  readonly concurrency: WorkflowDefinition["concurrency"];
  readonly jobs: readonly JobView[];
}

interface EditTarget {
  readonly jobKey: string;
  readonly timeout: boolean;
  readonly retentionStep: number | null;
}

function editTarget(edit: ByteEdit): EditTarget | null {
  const jobKey = /^jobs\.([^.]+)\./.exec(edit.semanticPath)?.[1] ?? null;
  if (jobKey === null) return null;
  const stepIndex = /^jobs\.[^.]+\.steps\[(\d+)\]/.exec(edit.semanticPath)?.[1];
  return {
    jobKey,
    timeout: edit.ruleId === "CD005",
    retentionStep: stepIndex === undefined ? null : Number(stepIndex),
  };
}

function stepView(step: WorkflowStep, stripRetention: boolean): StepView {
  const entries = step.withEntries
    .filter((entry) => !(stripRetention && entry.key === "retention-days"))
    .map((entry) => ({ key: entry.key, kind: entry.kind, literal: entry.literal }));
  const withPresent = entries.length > 0;
  const other = step.otherEntries.map((entry) => ({ key: entry.key, kind: entry.kind, literal: entry.literal }));
  return { name: step.name, uses: step.uses, run: step.run, withPresent, flow: step.flow, entries, other };
}

function jobView(job: WorkflowJob, target: EditTarget | null): JobView {
  const stripTimeout = target !== null && target.timeout && target.jobKey === job.key;
  return {
    key: job.key,
    displayName: job.displayName,
    timeoutMinutes: stripTimeout ? null : job.timeoutMinutes,
    matrix: job.matrix,
    needs: job.needs,
    runsOn: job.runsOn,
    environment: job.environment,
    reusableWorkflow: job.reusableWorkflow,
    steps: job.steps.map((step) => stepView(step, target !== null && target.retentionStep === step.index && target.jobKey === job.key)),
  };
}

function project(workflow: WorkflowDefinition, edits: readonly ByteEdit[], stripConcurrency: boolean): WorkflowView {
  const targets = edits.map(editTarget).filter((target): target is EditTarget => target !== null);
  return {
    name: workflow.name,
    triggers: workflow.triggers,
    pullRequestTypes: workflow.pullRequestTypes,
    concurrency: stripConcurrency ? null : workflow.concurrency,
    jobs: workflow.jobs.map((job) => jobView(job, targets.find((target) => target.jobKey === job.key) ?? null)),
  };
}

/**
 * Return every difference between the original and the edited workflow that the
 * plan does not explicitly claim, as human-readable strings.
 */
export function semanticProblems(original: WorkflowDefinition, resultText: string, edits: readonly ByteEdit[]): string[] {
  const reparsed = parseWorkflow(original.path, resultText);
  if (reparsed.parseError !== null) return ["edited workflow does not parse: " + reparsed.parseError.message];
  if (reparsed.unsupported.length > 0) return reparsed.unsupported.map((feature) => "edited workflow is unsupported: " + feature.code);

  // CD001 only inserts a concurrency policy when none existed. Replacing an
  // existing policy would change behavior the finding never argued for, so the
  // concurrency block stays in the projection in that case.
  const hasConcurrencyEdit = edits.some((edit) => edit.ruleId === "CD001");
  const stripConcurrency = hasConcurrencyEdit && original.concurrency === null;
  const before = project(original, edits, stripConcurrency);
  const after = project(reparsed, edits, stripConcurrency);
  if (canonicalJson(before) === canonicalJson(after)) return [];
  return externalDifferences(before, after);
}

function externalDifferences(before: WorkflowView, after: WorkflowView): string[] {
  const problems: string[] = [];
  if (canonicalJson(before.concurrency) !== canonicalJson(after.concurrency)) problems.push("concurrency outside the edited field");
  if (before.triggers.join(",") !== after.triggers.join(",")) problems.push("workflow triggers changed");
  if (before.pullRequestTypes?.join(",") !== after.pullRequestTypes?.join(",")) problems.push("pull request types changed");
  if (before.name !== after.name) problems.push("workflow name changed");
  const beforeJobs = new Map(before.jobs.map((job) => [job.key, job]));
  for (const job of after.jobs) {
    const previous = beforeJobs.get(job.key);
    if (previous === undefined) {
      problems.push("unexpected job added: " + job.key);
      continue;
    }
    beforeJobs.delete(job.key);
    if (canonicalJson(previous) === canonicalJson(job)) continue;
    if (canonicalJson(previous.matrix) !== canonicalJson(job.matrix)) problems.push("matrix changed on job " + job.key);
    if (previous.displayName !== job.displayName) problems.push("job name changed on job " + job.key);
    if (previous.runsOn !== job.runsOn) problems.push("runs-on changed on job " + job.key);
    if (previous.environment !== job.environment) problems.push("environment changed on job " + job.key);
    if (previous.reusableWorkflow !== job.reusableWorkflow) problems.push("reusable workflow changed on job " + job.key);
    if (previous.needs.join(",") !== job.needs.join(",")) problems.push("needs changed on job " + job.key);
    if (previous.steps.length !== job.steps.length) problems.push("steps changed on job " + job.key);
    for (const [index, step] of job.steps.entries()) {
      const oldStep = previous.steps[index];
      if (oldStep === undefined) continue;
      if (canonicalJson(oldStep) === canonicalJson(step)) continue;
      if (oldStep.uses !== step.uses) problems.push("uses changed on job " + job.key + " step " + index);
      if (oldStep.run !== step.run) problems.push("run changed on job " + job.key + " step " + index);
      if (oldStep.name !== step.name) problems.push("step name changed on job " + job.key + " step " + index);
      const oldEntries = new Map(oldStep.entries.map((entry) => [entry.key, entry]));
      for (const entry of step.entries) {
        const old = oldEntries.get(entry.key);
        if (old === undefined) problems.push("with entry added outside the edit: " + entry.key);
        else if (canonicalJson(old) !== canonicalJson(entry)) problems.push("with entry changed outside the edit: " + entry.key);
        oldEntries.delete(entry.key);
      }
      for (const key of oldEntries.keys()) problems.push("with entry removed outside the edit: " + key);
      const oldOther = new Map(oldStep.other.map((entry) => [entry.key, entry]));
      for (const entry of step.other) {
        const previousEntry = oldOther.get(entry.key);
        if (previousEntry === undefined) problems.push("step key added outside the edit: " + entry.key);
        else if (canonicalJson(previousEntry) !== canonicalJson(entry)) problems.push("step key changed outside the edit: " + entry.key);
        oldOther.delete(entry.key);
      }
      for (const key of oldOther.keys()) problems.push("step key removed outside the edit: " + key);
    }
  }
  for (const key of beforeJobs.keys()) problems.push("job removed: " + key);
  return problems.length === 0 ? ["workflow content outside the allowed edit paths changed"] : problems;
}