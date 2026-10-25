import type { AppliedChange } from "../../core/contracts/schema.ts";
import { measureChangeEffect, type ChangeEffectRun } from "../../core/analysis/change-effect.ts";
import { sourceHashOf } from "../../core/patch/plan.ts";
import { RequestBudget } from "./budget.ts";
import { contentsSegments, ownerRepoPath } from "./endpoints.ts";
import { GhTransport, type GhRunner } from "./transport.ts";
import { collectAttemptJobs } from "./run-observation.ts";

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_RUN_DATA");
  return value as Record<string, unknown>;
}

/** At most 20 selected runs. All requests use the existing read-only allowlist. */
export async function collectChangeEffect(repository: string, change: AppliedChange,
  beforeIds: readonly number[], afterIds: readonly number[], options: { runner?: GhRunner; signal?: AbortSignal } = {}) {
  const parts = repository.split("/");
  const ids = [...beforeIds, ...afterIds];
  if (parts.length !== 2 || beforeIds.length < 1 || afterIds.length < 1 || beforeIds.length > 10 || afterIds.length > 10
    || new Set(ids).size !== ids.length || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error("INVALID_RUN_SELECTION");
  if (change.state !== "APPLIED") throw new Error("CHANGE_NOT_APPLIED");
  const base = ownerRepoPath(parts[0]!, parts[1]!);
  const transport = new GhTransport({ budget: new RequestBudget({ discovery: 60, definitions: 40, jobs: 200, policyAndFiles: 0 }),
    retries: 0, timeoutMs: 15_000, maxRetryWaitMs: 0, ...options });
  const hashes = new Map<string, string>();
  const fileHash = async (ref: string): Promise<string> => {
    const cached = hashes.get(ref);
    if (cached !== undefined) return cached;
    const file = record((await transport.get({ path: base + "/contents/" + contentsSegments(change.workflowPath), query: { ref } }, "definitions")).body);
    if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string" || file.content.length > 3 * 1024 * 1024) throw new Error("WORKFLOW_CONTENT_UNAVAILABLE");
    const bytes = Buffer.from(file.content, "base64"), text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("WORKFLOW_NOT_UTF8");
    const hash = sourceHashOf(text);
    hashes.set(ref, hash);
    return hash;
  };
  let scope: string | null = null;
  const collect = async (runIds: readonly number[], expectedHash: string): Promise<ChangeEffectRun[]> => {
    const result: ChangeEffectRun[] = [];
    for (const id of runIds) {
      const path = base + "/actions/runs/" + id;
      const run = record((await transport.get({ path }, "discovery")).body);
      const runRepository = record(run.repository);
      if (run.id !== id || typeof runRepository.full_name !== "string" || runRepository.full_name.toLowerCase() !== repository.toLowerCase()
        || run.path !== change.workflowPath || run.status !== "completed"
        || !Number.isSafeInteger(run.run_attempt) || (run.run_attempt as number) < 1
        || typeof run.conclusion !== "string" || typeof run.head_sha !== "string" || !/^[0-9a-f]{40}$/i.test(run.head_sha)) throw new Error("RUN_IDENTITY_MISMATCH");
      if (typeof run.event !== "string" || !["push", "workflow_dispatch", "pull_request"].includes(run.event)) throw new Error("WORKFLOW_REF_UNVERIFIABLE");
      let pullIdentity: unknown = null;
      let definitionRefs = [run.head_sha];
      if (run.event === "pull_request") {
        // A PR head alone does not identify its executed merge definition.
        if (!Array.isArray(run.pull_requests) || run.pull_requests.length !== 1) throw new Error("PR_SNAPSHOT_UNAVAILABLE");
        const pull = record(run.pull_requests[0]), head = record(pull.head), target = record(pull.base);
        if (!Number.isSafeInteger(pull.number) || (pull.number as number) < 1
          || ![head.sha, target.sha].every((sha) => typeof sha === "string" && /^[0-9a-f]{40}$/i.test(sha))
          || record(head.repo).id !== record(run.repository).id || record(target.repo).id !== record(run.repository).id
          || !Number.isSafeInteger(record(run.repository).id)) throw new Error("PR_SNAPSHOT_UNVERIFIABLE");
        if (run.head_sha === head.sha) {
          // If both immutable parents have identical workflow bytes, their
          // conflict-free merge cannot introduce a different workflow file.
          definitionRefs = [target.sha as string, head.sha as string];
          if (await fileHash(definitionRefs[0]!) !== await fileHash(definitionRefs[1]!)) throw new Error("PR_MERGE_DEFINITION_UNVERIFIABLE");
        } else {
          const commit = record((await transport.get({ path: base + "/git/commits/" + run.head_sha }, "discovery")).body);
          if (commit.sha !== run.head_sha || !Array.isArray(commit.parents) || commit.parents.length !== 2
            || record(commit.parents[0]).sha !== target.sha || record(commit.parents[1]).sha !== head.sha) throw new Error("PR_MERGE_DEFINITION_UNVERIFIABLE");
        }
        pullIdentity = [pull.number, record(target.repo).id];
      }
      if (typeof run.head_branch !== "string" || !run.head_branch) throw new Error("RUN_IDENTITY_MISMATCH");
      const runScope = JSON.stringify([run.head_branch, run.event, pullIdentity]);
      if (scope !== null && scope !== runScope) throw new Error("DIFFERENT_BRANCH_OR_EVENT");
      scope = runScope;
      const hash = await fileHash(definitionRefs[definitionRefs.length - 1]!);
      if (hash !== expectedHash) throw new Error("WORKFLOW_HASH_MISMATCH:" + id);
      // The same metadata guards cover definition and job collection. Do not
      // nest another complete observation collector with two more metadata GETs.
      const observation = run.conclusion === "success" ? {
        id, attempt: run.run_attempt as number, repository: runRepository.full_name,
        workflow: change.workflowPath, branch: run.head_branch, event: run.event, sha: run.head_sha,
        jobs: await collectAttemptJobs(base, id, run.run_attempt as number, transport),
      } : null;
      const check = record((await transport.get({ path }, "discovery")).body);
      if (check.id !== run.id || check.path !== run.path || record(check.repository).full_name !== runRepository.full_name
        || check.run_attempt !== run.run_attempt || check.head_sha !== run.head_sha || check.status !== run.status || check.conclusion !== run.conclusion
        || check.event !== run.event || check.head_branch !== run.head_branch
        || JSON.stringify(check.pull_requests) !== JSON.stringify(run.pull_requests)) throw new Error("RUN_CHANGED_DURING_COLLECTION");
      result.push({ id, attempt: run.run_attempt as number, conclusion: run.conclusion, workflowHash: hash, definitionRefs, observation });
    }
    return result;
  };
  const before = await collect(beforeIds, change.before.hash);
  const after = await collect(afterIds, change.after.hash);
  return measureChangeEffect(change, before, after);
}
