import { digestOf } from "../../shared/cdj1.ts";
import { composeCoverage } from "../analysis/coverage.ts";
import { unknownSeconds } from "../savings/metrics.ts";
import { RULE_VERSION } from "../version.ts";
import { npmCacheDependencies, npmCacheTargets } from "./npm-cache.ts";
import { buildFinding, ruleResult } from "./types.ts";
import type { DetectionRule } from "./types.ts";

/** Cache downloads, never node_modules or the outcome of tests/install scripts. */
export const cd006: DetectionRule = {
  id: "CD006", version: RULE_VERSION,
  evaluate(context) {
    const composition = composeCoverage(context.coverage, "CD006");
    const candidates = context.workflows.flatMap((workflow) => npmCacheTargets(workflow, context.workspaceRoot).map((target) => ({ workflow, ...target })));
    const dependencies = candidates.map((target) => context.workspaceRoot === undefined ? null : npmCacheDependencies(context.workspaceRoot, target));
    const inputHash = digestOf({ workflows: context.workflows.map((w) => w.sha256), dependencies });
    const findings = composition.level === "skip" || context.workspaceRoot === undefined ? [] : candidates.flatMap(({ workflow, job, step, manager, lockfile }, index) => dependencies[index] === null ? [] : [buildFinding({
        ruleId: "CD006", ruleVersion: RULE_VERSION, workflowPath: workflow.path, workflowHash: workflow.sha256,
        title: "Cache " + manager + " downloads in job \"" + job.key + "\"",
        renderedText: "Enable setup-node's " + manager + " download cache keyed by " + lockfile + ". Installation and every test still run. No time or money saving has been measured.",
        message: { titleKey: "finding.CD006.title", textKey: "finding.CD006.text", params: { job: job.key, manager, lockfile, install: manager === "npm" ? "npm ci" : "pnpm install --frozen-lockfile" } },
        evidenceLevel: "static", patchability: composition.writeAllowed ? "eligible" : "review-only",
        evidenceRefs: ["workflow:" + workflow.path + "#jobs." + job.key + ".steps[" + step.index + "]", ...dependencies[index]!.map((d) => "file:" + d.ref + "@" + d.sha256)],
        assumptions: ["The selected package.json and lockfile are Git-tracked and checked out before setup-node.", "Cache contents are dependency downloads, never credentials or test results."],
        blockers: [], standaloneRunnerSeconds: unknownSeconds("cache benefit needs comparable cold and warm runs", "CACHE_BENEFIT_UNMEASURED"),
        identity: { workflowPath: workflow.path, jobKey: job.key, stepIndex: step.index, dependencies: dependencies[index] },
      })]);
    return { findings, removals: [], results: [ruleResult({ ruleId: "CD006", ruleVersion: RULE_VERSION, inputHash,
      outcome: composition.level === "skip" ? "skipped" : findings.length > 0 ? "candidate" : "no_finding",
      findings, reasons: composition.reasons })] };
  },
};
