// Read-only check: the production parser and job-key recovery over A0a evidence.
// Compares against the spike baseline in evidence/a0a/jobkey.json.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseWorkflow, recoverJobKey } from "../../src/core/workflow/index.ts";

const ROOT = "evidence/a0a";
const RAW = path.join(ROOT, "raw");

const cache = JSON.parse(await readFile(path.join(ROOT, "workflow-yaml.json"), "utf8"));
const files = (await readdir(RAW)).filter((file) => file.endsWith(".json"));
const totals = { jobs: 0, single: 0, keyEqualsName: 0, nameLiteral: 0, matrix: 0, unmapped: 0, unsupportedWorkflows: 0 };
const cohorts = new Map();

for (const file of files) {
  const data = JSON.parse(await readFile(path.join(RAW, file), "utf8"));
  const definitions = new Map();
  for (const [key, text] of Object.entries(cache)) {
    if (!key.startsWith(data.repo + "|")) continue;
    definitions.set(key, text ? parseWorkflow(key, text) : null);
  }
  for (const [runId, jobs] of Object.entries(data.jobsByRun)) {
    const run = data.runs.find((item) => item.id === Number(runId));
    if (!run) continue;
    const workflow = data.workflows.find((item) => item.id === run.workflow_id);
    if (!workflow) continue;
    const definition = definitions.get(data.repo + "|" + workflow.path);
    if (!definition || definition.jobs.length === 0) continue;
    if (definition.unsupported.length > 0) totals.unsupportedWorkflows += 1;
    for (const job of jobs) {
      totals.jobs += 1;
      const match = recoverJobKey(job.name, definition.jobs);
      if (!match) {
        totals.unmapped += 1;
        continue;
      }
      if (match.level === "single-job") totals.single += 1;
      else if (match.level === "key-equals-name") totals.keyEqualsName += 1;
      else if (match.level === "name-literal") totals.nameLiteral += 1;
      else totals.matrix += 1;
      const cohortKey = data.repo + "|" + workflow.path + "|" + match.key;
      const cohort = cohorts.get(cohortKey) ?? { samples: 0 };
      cohort.samples += 1;
      cohorts.set(cohortKey, cohort);
    }
  }
}

const matched = totals.jobs - totals.unmapped;
const cohortList = [...cohorts.values()];
const report = {
  generatedAt: new Date().toISOString(),
  totals: { ...totals, matched, matchRate: totals.jobs === 0 ? 0 : Number((matched / totals.jobs).toFixed(4)) },
  cohorts: {
    count: cohortList.length,
    withAtLeast5: cohortList.filter((cohort) => cohort.samples >= 5).length,
    withAtLeast20: cohortList.filter((cohort) => cohort.samples >= 20).length,
  },
};
await writeFile(path.join(ROOT, "parser-verify.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
