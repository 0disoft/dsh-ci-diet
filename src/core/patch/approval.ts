import type { PatchPlan } from "../contracts/schema.ts";
import type { ApprovalNonce, PatchStore } from "./store.ts";
import { digestOf } from "../../shared/cdj1.ts";
import { acquireStoreLock } from "./apply.ts";
import type { Clock, IdSource } from "../support/clock.ts";

const APPROVE_LOCK_WAIT_MS = 250;

export interface ApproveInput {
  readonly store: PatchStore;
  readonly planId: string;
  readonly confirmation: string;
  readonly subjectId: string;
  readonly channel: "human-ui" | "human-cli";
  readonly now: Date;
  /** Optional time source for lock bookkeeping; defaults to the system clock. */
  readonly clock?: Clock;
  /** Optional id source for lock tokens; defaults to crypto.randomUUID. */
  readonly ids?: IdSource;
}

export interface ApproveResult {
  readonly plan: PatchPlan;
  readonly nonce: ApprovalNonce;
  readonly warnings?: readonly string[];
}

/** The human must type the last 12 hex characters of the plan digest. */
export function approvalConfirmation(plan: PatchPlan): string {
  return plan.planDigest.slice(-12);
}

export function approvePlan(input: ApproveInput): ApproveResult {
  // Read once to validate the id through the store before it names a lock path.
  const initial = input.store.readPlan(input.planId);
  if (initial === null) throw new Error("PLAN_NOT_FOUND: " + input.planId);
  // The approval is a two-step write (nonce, then plan status). Serialize it per
  // plan so concurrent approvers cannot leave a nonce without its status, or a
  // status pointing at a nonce that a second approval overwrote.
  const lock = acquireStoreLock(input.store, "approve-" + initial.plan.planId, APPROVE_LOCK_WAIT_MS, { clock: input.clock, ids: input.ids });
  try {
    return approveLocked(input);
  } finally {
    lock.release();
  }
}

function approveLocked(input: ApproveInput): ApproveResult {
  const stored = input.store.readPlan(input.planId);
  if (stored === null) throw new Error("PLAN_NOT_FOUND: " + input.planId);
  const plan = stored.plan;
  if (plan.status.state === "approved") throw new Error("PLAN_ALREADY_APPROVED: " + input.planId);
  if (input.now.getTime() >= Date.parse(plan.payload.expiresAt)) throw new Error("PLAN_EXPIRED: " + plan.payload.expiresAt);
  if (input.confirmation.trim() !== approvalConfirmation(plan)) throw new Error("NONCE_INVALID: confirmation does not match the plan digest");
  const at = input.now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const nonce: ApprovalNonce = {
    nonceId: "n_" + digestOf({ planId: plan.planId, digest: plan.planDigest, at }).slice("sha256:".length, "sha256:".length + 24),
    planDigest: plan.planDigest,
    createdAt: at,
    subjectId: input.subjectId,
    channel: input.channel,
  };
  const approved: PatchPlan = {
    ...plan,
    status: {
      state: "approved",
      revision: plan.status.revision + 1,
      previewedAt: plan.status.previewedAt ?? at,
      approvedAt: at,
      approvalNonceId: nonce.nonceId,
    },
  };
  // A failed nonce write must leave the plan available for an explicit approval retry.
  input.store.saveNonce(plan.planId, nonce);
  input.store.updatePlanStatus(plan.planId, approved.status);
  const warnings = input.store.appendSummaryEvent({ type: "approved", planId: plan.planId, nonceId: nonce.nonceId, channel: input.channel }, input.now);
  return { plan: approved, nonce, ...(warnings.length > 0 ? { warnings } : {}) };
}
