import { RequestBudget } from "./budget.ts";
import { ownerRepoPath } from "./endpoints.ts";
import { GhTransport } from "./transport.ts";
import type { GhRunner } from "./transport.ts";
import type { RunObservation, JobObservation } from "../../core/analysis/run-comparison.ts";

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_RUN_DATA");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("INVALID_RUN_DATA");
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("INVALID_RUN_DATA");
  return value;
}
function seconds(start: unknown, end: unknown): number {
  const from = Date.parse(string(start)), to = Date.parse(string(end));
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) throw new Error("INVALID_RUN_TIMESTAMPS");
  return (to - from) / 1000;
}

/** At most four GETs per run. Fail on pagination instead of comparing partial jobs. */
export async function collectRunObservation(repository: string, runId: number, options: { runner?: GhRunner; signal?: AbortSignal } = {}): Promise<RunObservation> {
  const parts = repository.split("/");
  if (parts.length !== 2 || !Number.isSafeInteger(runId) || runId < 1) throw new Error("INVALID_RUN_REQUEST");
  const base = ownerRepoPath(parts[0]!, parts[1]!);
  const transport = new GhTransport({ budget: new RequestBudget({ discovery: 2, jobs: 2, definitions: 0, policyAndFiles: 0 }),
    retries: 0, timeoutMs: 15_000, maxRetryWaitMs: 0, ...options });
  const run = record((await transport.get({ path: base + "/actions/runs/" + runId }, "discovery")).body);
  if (integer(run.id) !== runId || string(record(run.repository).full_name).toLowerCase() !== repository.toLowerCase()) throw new Error("RUN_IDENTITY_MISMATCH");
  if (run.status !== "completed" || run.conclusion !== "success") throw new Error("RUN_NOT_SUCCESSFUL");
  const attempt = integer(run.run_attempt);
  const response = await transport.get({ path: base + "/actions/runs/" + runId + "/attempts/" + attempt + "/jobs", query: { per_page: "100", page: "1" } }, "jobs");
  const body = record(response.body);
  if (!Array.isArray(body.jobs) || typeof body.total_count !== "number" || body.total_count !== body.jobs.length
    || /rel="next"/.test(response.headers.link ?? "")) throw new Error("JOB_COLLECTION_INCOMPLETE");
  const jobs: JobObservation[] = [];
  for (const item of body.jobs) {
    const job = record(item);
    if (job.conclusion !== "success" || job.status !== "completed") throw new Error("JOB_NOT_SUCCESSFUL");
    if (!Array.isArray(job.labels) || job.labels.length === 0 || !Array.isArray(job.steps)) throw new Error("INVALID_JOB_DATA");
    const steps = job.steps.map((item) => {
      const step = record(item);
      if (step.status !== "completed" || !["success", "skipped"].includes(String(step.conclusion))) throw new Error("STEP_NOT_SUCCESSFUL");
      return { name: string(step.name), seconds: step.conclusion === "skipped" ? 0 : seconds(step.started_at, step.completed_at) };
    });
    jobs.push({ name: string(job.name), labels: job.labels.map(string), seconds: seconds(job.started_at, job.completed_at), steps });
  }
  // A re-run starting during collection changes the attempt; never mix its metadata and jobs.
  const check = record((await transport.get({ path: base + "/actions/runs/" + runId }, "discovery")).body);
  if (check.run_attempt !== attempt || check.status !== "completed" || check.conclusion !== "success") throw new Error("RUN_CHANGED_DURING_COLLECTION");
  return { id: runId, attempt, repository: string(record(run.repository).full_name), workflow: string(run.path),
    branch: string(run.head_branch), event: string(run.event), sha: string(run.head_sha), jobs };
}
