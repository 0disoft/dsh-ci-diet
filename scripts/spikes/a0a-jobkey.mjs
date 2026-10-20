// A0a follow-up: how well can a job row be attributed to a YAML job key?
// Read-only probe. Reads the raw A0a collection and refetches workflow YAML.
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";

const ROOT = "evidence/a0a";
const RAW = path.join(ROOT, "raw");
const CACHE = path.join(ROOT, "workflow-yaml.json");
const API = "https://api.github.com/";
const TOKEN = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
const MATRIX_EXPR = /\$\{\{\s*matrix\.([A-Za-z0-9_.-]+)\s*\}\}/;
const MATRIX_EXPR_ALL = /\$\{\{\s*matrix\.([A-Za-z0-9_.-]+)\s*\}\}/g;

let requests = 0;
async function get(p) {
  requests += 1;
  const res = await fetch(new URL(p, API), {
    headers: { accept: "application/vnd.github+json", authorization: "Bearer " + TOKEN, "user-agent": "ci-diet-a0a-spike" },
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " " + p);
  return res.json();
}

function normalize(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

function scalar(node) {
  if (node && typeof node === "object" && "value" in node) return node.value;
  return node;
}

function plain(node) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node.items) && node.constructor && node.constructor.name === "YAMLSeq") {
    return node.items.map((item) => plain(item));
  }
  if (Array.isArray(node.items)) {
    const out = {};
    for (const pair of node.items) out[String(scalar(pair.key))] = plain(pair.value);
    return out;
  }
  return scalar(node);
}

function parseJobs(text) {
  const doc = parseDocument(text, { strict: false });
  const jobsNode = doc.get("jobs");
  if (!jobsNode || !jobsNode.items) return [];
  const jobs = [];
  for (const pair of jobsNode.items) {
    const key = String(scalar(pair.key));
    const job = pair.value;
    const nameNode = job && job.get ? job.get("name") : null;
    const name = nameNode ? String(scalar(nameNode)) : null;
    const strategy = job && job.get ? job.get("strategy") : null;
    const matrixNode = strategy && strategy.get ? strategy.get("matrix") : null;
    const axes = {};
    let dynamic = false;
    if (matrixNode && matrixNode.items) {
      for (const axis of matrixNode.items) {
        const axisName = String(scalar(axis.key));
        const axisValue = axis.value;
        if (!axisValue) continue;
        if (axisName === "include" || axisName === "exclude") continue;
        if (axisValue.items) {
          const values = axisValue.items.map((item) => plain(item));
          if (values.some((value) => typeof value === "string" && value.includes("${{"))) {
            dynamic = true;
          } else {
            axes[axisName] = values;
          }
        } else {
          dynamic = true;
        }
      }
    }
    jobs.push({ key, name, axes, dynamic });
  }
  return jobs;
}

function combinations(axes) {
  const names = Object.keys(axes);
  if (names.length === 0) return [{}];
  let out = [{}];
  for (const name of names) {
    const next = [];
    for (const prefix of out) {
      for (const value of axes[name]) next.push({ ...prefix, [name]: value });
    }
    out = next;
    if (out.length > 200) return out.slice(0, 200);
  }
  return out;
}

function lookup(values, dotted) {
  let current = values;
  for (const part of dotted.split(".")) {
    if (current === null || typeof current !== "object" || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function render(template, values) {
  let unresolved = false;
  const text = template.replace(MATRIX_EXPR_ALL, (_, axis) => {
    const value = lookup(values, axis);
    if (value === undefined) {
      unresolved = true;
      return "";
    }
    return String(value);
  });
  return unresolved ? null : normalize(text);
}

function matchJob(displayName, jobs) {
  const name = normalize(displayName);
  if (jobs.length === 1) return { key: jobs[0].key, level: "single-job" };
  for (const job of jobs) if (job.key === name) return { key: job.key, level: "key-equals-name" };
  for (const job of jobs) if (job.name !== null && normalize(job.name) === name) return { key: job.key, level: "name-literal" };
  for (const job of jobs) {
    if (job.name === null || !MATRIX_EXPR.test(job.name)) continue;
    for (const values of combinations(job.axes)) {
      if (render(job.name, values) === name) return { key: job.key, level: "matrix-expanded" };
    }
  }
  return null;
}

const files = (await readdir(RAW)).filter((f) => f.endsWith(".json") && f !== "collect-summary.json" && f !== "pr-probe.json");
const cache = JSON.parse(await readFile(CACHE, "utf8").catch(() => "{}"));
const repos = {};
for (const file of files) {
  const d = JSON.parse(await readFile(path.join(RAW, file), "utf8"));
  repos[d.repo] = d;
}

for (const [repo, d] of Object.entries(repos)) {
  for (const wf of d.workflows) {
    const shape = d.shapes[wf.path];
    if (!shape || !shape.jobs || shape.unavailable) continue;
    const key = repo + "|" + wf.path;
    if (cache[key]) continue;
    try {
      const body = await get("repos/" + repo + "/contents/" + wf.path);
      cache[key] = Buffer.from(body.content || "", "base64").toString("utf8");
    } catch (error) {
      cache[key] = null;
      console.error(repo, wf.path, error.message);
    }
  }
}
await mkdir(ROOT, { recursive: true });
await writeFile(CACHE, JSON.stringify(cache, null, 1));

const totals = { jobs: 0, single: 0, keyEqualsName: 0, nameLiteral: 0, matrix: 0, unmapped: 0 };
const cohorts = new Map();
const perRepo = {};
for (const [repo, d] of Object.entries(repos)) {
  const stats = { jobs: 0, single: 0, keyEqualsName: 0, nameLiteral: 0, matrix: 0, unmapped: 0 };
  for (const [runId, jobs] of Object.entries(d.jobsByRun)) {
    const run = d.runs.find((r) => r.id === Number(runId));
    if (!run) continue;
    const wf = d.workflows.find((w) => w.id === run.workflow_id);
    if (!wf) continue;
    const shape = d.shapes[wf.path];
    if (!shape || !shape.jobs || shape.unavailable) continue;
    const yamlText = cache[repo + "|" + wf.path];
    if (!yamlText) continue;
    const parsed = parseJobs(yamlText);
    if (parsed.length === 0) continue;
    for (const job of jobs) {
      stats.jobs += 1;
      const hit = matchJob(job.name, parsed);
      if (!hit) { stats.unmapped += 1; continue; }
      if (hit.level === "single-job") stats.single += 1;
      else if (hit.level === "key-equals-name") stats.keyEqualsName += 1;
      else if (hit.level === "name-literal") stats.nameLiteral += 1;
      else stats.matrix += 1;
      const cohortKey = repo + "|" + wf.path + "|" + hit.key;
      const cohort = cohorts.get(cohortKey) || { samples: 0, timeoutMissing: 0 };
      cohort.samples += 1;
      if (!shape.jobs[hit.key] || shape.jobs[hit.key].hasTimeout === false) cohort.timeoutMissing += 1;
      cohorts.set(cohortKey, cohort);
    }
  }
  perRepo[repo] = stats;
  for (const [k, v] of Object.entries(stats)) totals[k] += v;
}

const matched = totals.jobs - totals.unmapped;
const cohortList = [...cohorts.entries()].map(([key, value]) => ({ key, ...value }));
const report = {
  generatedAt: new Date().toISOString(),
  requests,
  totals: { ...totals, matched, matchRate: totals.jobs ? Number((matched / totals.jobs).toFixed(4)) : 0 },
  cohorts: {
    count: cohortList.length,
    withAtLeast5: cohortList.filter((c) => c.samples >= 5).length,
    withAtLeast20: cohortList.filter((c) => c.samples >= 20).length,
    top: cohortList.sort((a, b) => b.samples - a.samples).slice(0, 10),
  },
  perRepo,
};
await writeFile(path.join(ROOT, "jobkey.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.totals, null, 1));
console.log("cohorts", JSON.stringify(report.cohorts));
console.log("requests", requests);
