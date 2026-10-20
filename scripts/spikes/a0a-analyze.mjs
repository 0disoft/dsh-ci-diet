#!/usr/bin/env node
// A0a spike: turn the raw history sample into rule-level measurements.
// Definitions used here are deliberately explicit so the numbers can be
// challenged. This is measurement code, not the product engine.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rawDir = join(root, "evidence", "a0a", "raw");
const outFile = join(root, "evidence", "a0a", "metrics.json");

const DOCS_PATH = /^(docs?\/|.*\.mdx?$|.*\.markdown$|license|contributing|changelog|code_of_conduct|\.github\/(issue_template|pull_request_template|funding)|readme|\.[a-z]+\.md$)/i;
const PR_EVENTS = new Set(["pull_request", "pull_request_target"]);
const HEAVY_SECONDS = 60;
const CD005_MIN_SAMPLES = 20;
const RETENTION_LIMIT_DAYS = 7;

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

function secondsBetween(start, end) {
  if (!start || !end) return null;
  const value = (Date.parse(end) - Date.parse(start)) / 1000;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function docsOnly(files) {
  return files.length > 0 && files.every((file) => DOCS_PATH.test(file));
}

function normalizedName(name) {
  const last = String(name).split(" / ").pop() ?? "";
  return last.replace(/\s*\(.*$/, "").replace(/\s*\/.*$/, "").trim();
}

function matchJobKey(name, keys) {
  if (keys.length === 1) return keys[0];
  const base = normalizedName(name);
  if (keys.includes(base)) return base;
  for (const key of keys) {
    if (base === key || base.startsWith(key + " ") || base.toLowerCase() === key.toLowerCase()) return key;
  }
  return null;
}

function workflowPath(repoData, workflowId) {
  const wf = (repoData.workflows ?? []).find((item) => item.id === workflowId);
  return wf?.path ?? null;
}

const files = (await readdir(rawDir)).filter((name) => name.endsWith(".json")).sort();
const repos = [];
const totals = {
  repositories: 0,
  runs: 0,
  runsWithJobs: 0,
  jobs: 0,
  jobSeconds: 0,
  workflows: 0,
  workflowsDynamic: 0,
  workflowsUnavailable: 0,
  workflowsWithParseError: 0,
};
const cd001 = { prRuns: 0, superseded: 0, supersededObserved: 0, examples: [] };
const cd002 = { workflowsWithOverlap: 0, examples: [] };
const cd003 = { docsOnlyPrRuns: 0, heavyDocsOnlyRuns: 0, examples: [] };
const cd004 = { workflowsWithMatrix: 0, maxProduct: 0, distribution: [] };
const cd005 = { jobsLackingTimeout: 0, mappedJobs: 0, unmappedJobs: 0, workflowsEligible: 0, workflowsMeasured: 0, workflows5: 0, workflows10: 0, eligible5: 0, durations: [], byWorkflow: new Map(), examples: [] };
const cd008 = { artifacts: 0, aboveLimit: 0, retentionDays: [], examples: [] };

for (const file of files) {
  const repoData = JSON.parse(await readFile(join(rawDir, file), "utf8"));
  if (repoData.error) {
    repos.push({ repo: repoData.repo, error: repoData.error });
    continue;
  }
  totals.repositories += 1;
  totals.runs += repoData.runs.length;

  const shapeByPath = repoData.shapes ?? {};
  const shapes = Object.values(shapeByPath);
  totals.workflows += shapes.length;
  totals.workflowsWithParseError += shapes.filter((shape) => shape.parseError && shape.unavailable !== "dynamic").length;
  totals.workflowsDynamic += shapes.filter((shape) => shape.unavailable === "dynamic").length;
  totals.workflowsUnavailable = (totals.workflowsUnavailable ?? 0) + shapes.filter((shape) => shape.unavailable && shape.unavailable !== "dynamic").length;
  totals.workflowsContentUnavailable = (totals.workflowsContentUnavailable ?? 0) + shapes.filter((shape) => shape.unavailable === "content").length;

  const runDurations = new Map();
  for (const [runId, jobs] of Object.entries(repoData.jobsByRun ?? {})) {
    let total = 0;
    let counted = 0;
    for (const job of jobs) {
      const seconds = secondsBetween(job.started_at, job.completed_at);
      if (seconds === null) continue;
      total += seconds;
      counted += 1;
      totals.jobs += 1;
      totals.jobSeconds += seconds;
    }
    runDurations.set(Number(runId), { total, jobs: counted });
    if (counted > 0) totals.runsWithJobs += 1;
  }

  for (const [path, shape] of Object.entries(shapeByPath)) {
    if (shape.parseError) continue;
    const triggers = new Set(shape.on ?? []);
    if (triggers.has("push") && (triggers.has("pull_request") || triggers.has("pull_request_target"))) {
      cd002.workflowsWithOverlap += 1;
      if (cd002.examples.length < 10) cd002.examples.push(repoData.repo + " " + path);
    }
    for (const job of Object.values(shape.jobs ?? {})) {
      if (job.hasMatrix) {
        cd004.workflowsWithMatrix += 1;
        cd004.maxProduct = Math.max(cd004.maxProduct, job.matrixProduct);
        cd004.distribution.push({ repo: repoData.repo, path, axes: job.matrixAxes, product: job.matrixProduct });
        break;
      }
    }
  }

  const runsById = new Map(repoData.runs.map((run) => [run.id, run]));
  const byWorkflowPr = new Map();
  for (const run of repoData.runs) {
    if (!PR_EVENTS.has(run.event)) continue;
    const pr = run.prs[0];
    if (!pr) continue;
    const key = run.workflow_id + ":" + pr.number;
    if (!byWorkflowPr.has(key)) byWorkflowPr.set(key, []);
    byWorkflowPr.get(key).push(run);
    cd001.prRuns += 1;
  }
  for (const runList of byWorkflowPr.values()) {
    runList.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    for (let index = 0; index < runList.length - 1; index += 1) {
      const run = runList[index];
      cd001.superseded += 1;
      const duration = runDurations.get(run.id);
      if (duration && duration.total > 0) {
        cd001.supersededObserved += 1;
        if (cd001.examples.length < 10) {
          cd001.examples.push({ repo: repoData.repo, run: run.id, seconds: Math.round(duration.total) });
        }
      }
    }
  }

  const prFiles = repoData.prFiles ?? {};
  for (const run of repoData.runs) {
    if (!PR_EVENTS.has(run.event)) continue;
    const prNumber = run.prs[0]?.number;
    if (!prNumber) continue;
    const files = prFiles[prNumber];
    if (!files || files.length === 0 || files.length >= 100) continue;
    if (!docsOnly(files)) continue;
    const duration = runDurations.get(run.id);
    cd003.docsOnlyPrRuns += 1;
    if (duration && duration.total >= HEAVY_SECONDS) {
      cd003.heavyDocsOnlyRuns += 1;
      if (cd003.examples.length < 10) {
        cd003.examples.push({ repo: repoData.repo, run: run.id, pr: prNumber, seconds: Math.round(duration.total) });
      }
    }
  }

  for (const [runId, jobs] of Object.entries(repoData.jobsByRun ?? {})) {
    const run = runsById.get(Number(runId));
    if (!run) continue;
    const path = workflowPath(repoData, run.workflow_id);
    const shape = path ? shapeByPath[path] : null;
    if (!shape || shape.parseError) continue;
    const keys = Object.keys(shape.jobs ?? {});
    for (const job of jobs) {
      const seconds = secondsBetween(job.started_at, job.completed_at);
      if (seconds === null) continue;
      const key = matchJobKey(job.name, keys);
      if (!key) {
        cd005.unmappedJobs += 1;
        continue;
      }
      cd005.mappedJobs += 1;
      if (shape.jobs[key].hasTimeout) continue;
      cd005.jobsLackingTimeout += 1;
      const bucketKey = repoData.repo + " " + path;
      if (!cd005.byWorkflow.has(bucketKey)) cd005.byWorkflow.set(bucketKey, []);
      cd005.byWorkflow.get(bucketKey).push(seconds);
      cd005.durations.push(seconds);
      if (cd005.examples.length < 5) {
        cd005.examples.push({ repo: repoData.repo, workflow: path, job: key, seconds: Math.round(seconds) });
      }
    }
  }

  for (const artifact of repoData.artifacts ?? []) {
    const days = secondsBetween(artifact.created_at, artifact.expires_at);
    if (days === null) continue;
    const retention = days / 86400;
    cd008.artifacts += 1;
    cd008.retentionDays.push(round(retention, 2));
    if (retention > RETENTION_LIMIT_DAYS) {
      cd008.aboveLimit += 1;
      if (cd008.examples.length < 10) cd008.examples.push({ repo: repoData.repo, name: artifact.name, days: round(retention, 1) });
    }
  }

  repos.push({
    repo: repoData.repo,
    runs: repoData.runs.length,
    workflows: shapes.length,
    runsWithJobs: runDurations.size,
  });
}

const workflowEligibility = [];
for (const [key, durations] of cd005.byWorkflow) {
  const sorted = [...durations].sort((a, b) => a - b);
  const p95 = quantile(sorted, 0.95);
  const samples = sorted.length;
  const eligible = samples >= CD005_MIN_SAMPLES && p95 !== null && p95 * 2 <= 6 * 3600;
  if (samples >= CD005_MIN_SAMPLES) cd005.workflowsMeasured += 1;
  if (eligible) cd005.workflowsEligible += 1;
  if (samples >= 10) cd005.workflows10 += 1;
  if (samples >= 5) {
    cd005.workflows5 += 1;
    if (p95 !== null && p95 * 2 <= 6 * 3600) cd005.eligible5 += 1;
  }
  workflowEligibility.push({ workflow: key, samples, p95Seconds: p95 === null ? null : Math.round(p95), eligible, eligibleAt5: samples >= 5 && p95 !== null && p95 * 2 <= 6 * 3600 });
}

const sortedC005 = [...cd005.durations].sort((a, b) => a - b);
const sorted008 = [...cd008.retentionDays].sort((a, b) => a - b);
const metrics = {
  generatedAt: new Date().toISOString(),
  sample: {
    repositories: totals.repositories,
    runsPerRepo: 100,
    jobDetailsPerRepo: 25,
    prFileLookupsPerRepo: 10,
    docsPathRule: String(DOCS_PATH),
  },
  volume: {
    runs: totals.runs,
    runsWithJobs: totals.runsWithJobs,
    jobs: totals.jobs,
    observedRunnerHours: round(totals.jobSeconds / 3600, 2),
    workflows: totals.workflows,
    workflowsUnavailableDynamic: totals.workflowsDynamic,
    workflowsUnavailableOther: totals.workflowsUnavailable,
    workflowsUnavailableContent: totals.workflowsContentUnavailable ?? 0,
    workflowsWithParseError: totals.workflowsWithParseError,
  },
  rules: {
    CD001: {
      prRuns: cd001.prRuns,
      supersededRuns: cd001.superseded,
      supersededRunsWithObservedJobs: cd001.supersededObserved,
      supersededShareOfPrRuns: cd001.prRuns ? round(cd001.superseded / cd001.prRuns, 3) : null,
      examples: cd001.examples,
    },
    CD002: {
      workflowsWithPushAndPullRequest: cd002.workflowsWithOverlap,
      examples: cd002.examples,
    },
    CD003: {
      docsOnlyPrRuns: cd003.docsOnlyPrRuns,
      heavyDocsOnlyRuns: cd003.heavyDocsOnlyRuns,
      heavyShare: cd003.docsOnlyPrRuns ? round(cd003.heavyDocsOnlyRuns / cd003.docsOnlyPrRuns, 3) : null,
      examples: cd003.examples,
    },
    CD004: {
      workflowsWithMatrix: cd004.workflowsWithMatrix,
      maxMatrixProduct: cd004.maxProduct,
      top: cd004.distribution.sort((a, b) => b.product - a.product).slice(0, 10),
    },
    CD005: {
      mappedJobs: cd005.mappedJobs,
      unmappedJobs: cd005.unmappedJobs,
      p95JobSeconds: quantile(sortedC005, 0.95),
      medianJobSeconds: quantile(sortedC005, 0.5),
      samples: sortedC005.length,
      workflowsMeasured: cd005.workflowsMeasured,
      workflowsWith5Samples: cd005.workflows5,
      workflowsWith10Samples: cd005.workflows10,
      workflowsEligible: cd005.workflowsEligible,
      workflowsEligibleAt5Samples: cd005.eligible5,
      eligibility: workflowEligibility,
      examples: cd005.examples,
    },
    CD008: {
      artifacts: cd008.artifacts,
      aboveLimit: cd008.aboveLimit,
      aboveLimitShare: cd008.artifacts ? round(cd008.aboveLimit / cd008.artifacts, 3) : null,
      medianRetentionDays: quantile(sorted008, 0.5),
      examples: cd008.examples,
    },
  },
  repositories: repos,
};

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, JSON.stringify(metrics, null, 2) + "\n", "utf8");
console.log(JSON.stringify({
  volume: metrics.volume,
  CD001: metrics.rules.CD001,
  CD002: metrics.rules.CD002.workflowsWithPushAndPullRequest,
  CD003: metrics.rules.CD003,
  CD004: { workflows: metrics.rules.CD004.workflowsWithMatrix, max: metrics.rules.CD004.maxMatrixProduct },
  CD005: metrics.rules.CD005,
  CD008: metrics.rules.CD008,
}, null, 2));