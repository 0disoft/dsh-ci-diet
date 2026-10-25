import type { AppliedChange } from "../../core/contracts/schema.ts";
import { measureChangeEffect, type ChangeEffectRun } from "../../core/analysis/change-effect.ts";
import { sourceHashOf } from "../../core/patch/plan.ts";
import { RequestBudget } from "./budget.ts";
import { contentsSegments, ownerRepoPath } from "./endpoints.ts";
import { GhTransport, type GhRunner } from "./transport.ts";
import { collectRunObservation } from "./run-observation.ts";

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
  const transport = new GhTransport({ budget: new RequestBudget({ discovery: 40, definitions: 20, jobs: 0, policyAndFiles: 0 }),
    retries: 0, timeoutMs: 15_000, maxRetryWaitMs: 0, ...options });
  const hashes = new Map<string, string>();
  let scope: string | null = null;
  const collect = async (runIds: readonly number[], expectedHash: string): Promise<ChangeEffectRun[]> => {
    const result: ChangeEffectRun[] = [];
    for (const id of runIds) {
      const path = base + "/actions/runs/" + id;
      const run = record((await transport.get({ path }, "discovery")).body);
      if (run.id !== id || String(record(run.repository).full_name).toLowerCase() !== repository.toLowerCase()
        || run.path !== change.workflowPath || run.status !== "completed"
        || !Number.isSafeInteger(run.run_attempt) || (run.run_attempt as number) < 1
        || typeof run.conclusion !== "string" || typeof run.head_sha !== "string" || !/^[0-9a-f]{40}$/i.test(run.head_sha)) throw new Error("RUN_IDENTITY_MISMATCH");
      // PR workflows may execute merge/base definitions rather than this head SHA.
      if (!["push", "workflow_dispatch"].includes(String(run.event))) throw new Error("WORKFLOW_REF_UNVERIFIABLE");
      if (typeof run.head_branch !== "string" || !run.head_branch) throw new Error("RUN_IDENTITY_MISMATCH");
      const runScope = JSON.stringify([run.head_branch, run.event]);
      if (scope !== null && scope !== runScope) throw new Error("DIFFERENT_BRANCH_OR_EVENT");
      scope = runScope;
      let hash = hashes.get(run.head_sha);
      if (hash === undefined) {
        const file = record((await transport.get({ path: base + "/contents/" + contentsSegments(change.workflowPath), query: { ref: run.head_sha } }, "definitions")).body);
        if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string" || file.content.length > 3 * 1024 * 1024) throw new Error("WORKFLOW_CONTENT_UNAVAILABLE");
        const bytes = Buffer.from(file.content, "base64");
        const text = bytes.toString("utf8");
        if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("WORKFLOW_NOT_UTF8");
        hash = sourceHashOf(text);
        hashes.set(run.head_sha, hash);
      }
      if (hash !== expectedHash) throw new Error("WORKFLOW_HASH_MISMATCH:" + id);
      const observation = run.conclusion === "success" ? await collectRunObservation(repository, id, options) : null;
      if (observation !== null && (observation.sha !== run.head_sha || observation.attempt !== run.run_attempt
        || observation.branch !== run.head_branch || observation.event !== run.event)) throw new Error("RUN_CHANGED_DURING_COLLECTION");
      const check = record((await transport.get({ path }, "discovery")).body);
      if (check.run_attempt !== run.run_attempt || check.head_sha !== run.head_sha || check.status !== run.status || check.conclusion !== run.conclusion) throw new Error("RUN_CHANGED_DURING_COLLECTION");
      result.push({ id, attempt: run.run_attempt as number, conclusion: run.conclusion, workflowHash: hash, observation });
    }
    return result;
  };
  const before = await collect(beforeIds, change.before.hash);
  const after = await collect(afterIds, change.after.hash);
  return measureChangeEffect(change, before, after);
}
