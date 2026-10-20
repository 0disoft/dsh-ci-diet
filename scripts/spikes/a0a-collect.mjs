#!/usr/bin/env node
// A0a spike: collect read-only GitHub Actions history for a fixed repo sample.
// Throwaway measurement code. It is committed so the numbers in
// docs/spikes/a0a-rules.md can be reproduced, not shipped in the plugin.
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import YAML from "yaml";

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = join(root, "evidence", "a0a", "raw");

const REPOS = [
  "microsoft/vscode",
  "facebook/react",
  "vercel/next.js",
  "rust-lang/rust",
  "denoland/deno",
  "oven-sh/bun",
  "vitejs/vite",
  "withastro/astro",
  "tailwindlabs/tailwindcss",
  "microsoft/TypeScript-Website",
];

const MAX_RUNS = 100;
const MAX_RUN_DETAILS = 25;
const MAX_PR_FILES = 10;
const BUDGET = 1500;

const state = { requests: 0, truncated: false, failures: [] };

const token = process.env.GITHUB_TOKEN ?? (await run("gh", ["auth", "token"], { windowsHide: true })).stdout.trim();

async function api(path) {
  if (state.requests >= BUDGET) {
    state.truncated = true;
    throw new Error("BUDGET_EXCEEDED");
  }
  state.requests += 1;
  const response = await fetch("https://api.github.com/" + path, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: "Bearer " + token,
      "x-github-api-version": "2022-11-28",
      "user-agent": "ci-diet-a0a-spike",
    },
  });
  if (!response.ok) throw new Error("HTTP " + response.status + " " + path);
  return response.json();
}

async function tryApi(path) {
  try {
    return await api(path);
  } catch (error) {
    const message = String(error.message ?? error).replace(/\s+/g, " ").slice(0, 240);
    state.failures.push({ path, message });
    return null;
  }
}

function trimRun(r) {
  return {
    id: r.id,
    workflow_id: r.workflow_id,
    run_number: r.run_number,
    event: r.event,
    status: r.status,
    conclusion: r.conclusion,
    head_branch: r.head_branch,
    head_sha: r.head_sha,
    created_at: r.created_at,
    run_started_at: r.run_started_at,
    attempt: r.run_attempt,
    prs: (r.pull_requests ?? []).map((p) => ({ number: p.number })),
  };
}

function trimJob(j) {
  return {
    id: j.id,
    name: j.name,
    status: j.status,
    conclusion: j.conclusion,
    started_at: j.started_at,
    completed_at: j.completed_at,
    labels: j.labels ?? [],
    steps: (j.steps ?? []).length,
  };
}

function workflowShape(text) {
  const doc = YAML.parseDocument(text, { uniqueKeys: false });
  const shape = { parseError: null, on: null, jobs: {} };
  if (doc.errors.length > 0) {
    shape.parseError = String(doc.errors[0].message).slice(0, 160);
    return shape;
  }
  const value = doc.toJS({ maxAliasCount: 100 }) ?? {};
  const on = value.on;
  shape.on = Array.isArray(on) ? on.map(String) : on && typeof on === "object" ? Object.keys(on) : on ? [String(on)] : [];
  const jobs = value.jobs ?? {};
  for (const [key, job] of Object.entries(jobs)) {
    const matrix = job?.strategy?.matrix;
    let axes = 0;
    let product = 1;
    if (matrix && typeof matrix === "object" && !Array.isArray(matrix)) {
      for (const [axis, values] of Object.entries(matrix)) {
        if (axis === "include" || axis === "exclude") continue;
        axes += 1;
        if (Array.isArray(values)) product *= values.length;
      }
    }
    shape.jobs[key] = {
      hasTimeout: job && Object.prototype.hasOwnProperty.call(job, "timeout-minutes"),
      hasMatrix: axes > 0,
      matrixAxes: axes,
      matrixProduct: axes > 0 ? product : 0,
    };
  }
  return shape;
}

async function collectRepo(repo) {
  const meta = await tryApi("repos/" + repo);
  if (!meta) return { repo, error: "metadata unavailable" };

  const workflows = await tryApi("repos/" + repo + "/actions/workflows?per_page=100");
  const shapes = {};
  for (const wf of workflows?.workflows ?? []) {
    if (wf.path.startsWith("dynamic/")) {
      shapes[wf.path] = { parseError: null, unavailable: "dynamic", on: null, jobs: {} };
      continue;
    }
    const content = await tryApi("repos/" + repo + "/contents/" + encodeURI(wf.path));
    if (!content || !content.content) {
      shapes[wf.path] = { parseError: null, unavailable: "content", on: null, jobs: {} };
      continue;
    }
    const text = Buffer.from(content.content, "base64").toString("utf8");
    try {
      shapes[wf.path] = workflowShape(text);
    } catch (error) {
      shapes[wf.path] = { parseError: String(error.message).slice(0, 160), on: null, jobs: {} };
    }
  }

  const runsPage = await tryApi("repos/" + repo + "/actions/runs?per_page=" + MAX_RUNS);
  const runs = (runsPage?.workflow_runs ?? []).map(trimRun);

  const jobsByRun = {};
  const prRuns = runs.filter((r) => r.event === "pull_request" || r.event === "pull_request_target");
  const otherRuns = runs.filter((r) => r.event !== "pull_request" && r.event !== "pull_request_target");
  const details = [...prRuns.slice(0, 18), ...otherRuns.slice(0, 7)];
  for (const r of details) {
    const page = await tryApi("repos/" + repo + "/actions/runs/" + r.id + "/jobs?per_page=50");
    jobsByRun[r.id] = (page?.jobs ?? []).map(trimJob);
  }

  const artifactsPage = await tryApi("repos/" + repo + "/actions/artifacts?per_page=100");
  const artifacts = (artifactsPage?.artifacts ?? []).map((a) => ({
    name: a.name,
    created_at: a.created_at,
    expires_at: a.expires_at,
    size_in_bytes: a.size_in_bytes,
  }));

  const prFiles = {};
  const prNumbers = [];
  for (const r of details) {
    if (r.event !== "pull_request" && r.event !== "pull_request_target") continue;
    for (const p of r.prs) {
      if (!prNumbers.includes(p.number)) prNumbers.push(p.number);
    }
  }
  for (const number of prNumbers.slice(0, MAX_PR_FILES)) {
    const files = await tryApi("repos/" + repo + "/pulls/" + number + "/files?per_page=100");
    if (files) prFiles[number] = files.map((f) => f.filename);
  }

  return {
    repo,
    meta: {
      id: meta.id,
      default_branch: meta.default_branch,
      size_kb: meta.size,
      pushed_at: meta.pushed_at,
    },
    workflows: (workflows?.workflows ?? []).map((wf) => ({ id: wf.id, path: wf.path, state: wf.state })),
    shapes,
    runs,
    jobsByRun,
    artifacts,
    prFiles,
  };
}

async function pool(items, size, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, lane));
  return results;
}

await mkdir(outDir, { recursive: true });
const results = await pool(REPOS, 4, async (repo) => {
  const data = await collectRepo(repo);
  const file = join(outDir, repo.replace("/", "__") + ".json");
  await writeFile(file, JSON.stringify(data), "utf8");
  process.stderr.write("collected " + repo + " runs=" + (data.runs?.length ?? 0) + "\n");
  return { repo, file };
});

const summary = {
  generatedAt: new Date().toISOString(),
  repos: results.length,
  requests: state.requests,
  truncated: state.truncated,
  failures: state.failures,
};
await writeFile(join(root, "evidence", "a0a", "collect-summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
console.log(JSON.stringify(summary));