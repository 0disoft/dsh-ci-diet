import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative as relativePath, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AppliedChange, Attestation, PatchPlan, PolicySnapshot } from "../contracts/schema.ts";
import type { RepositoryBinding } from "../contracts/schema.ts";
import { checkApply } from "./verify.ts";
import type { ApplyReasonCode } from "./verify.ts";
import { PatchStore, textHash } from "./store.ts";
import { digestOf } from "../../shared/cdj1.ts";
import type { ApprovalNonce, StoredPlan } from "./store.ts";
import { buildPolicySnapshots } from "./plan.ts";
import { semanticProblems } from "./semantic.ts";
import { parseWorkflow } from "../workflow/parse.ts";
import { collectDependencies } from "./dependencies.ts";
import { clockOf, idsOf, isExpired } from "../support/clock.ts";
import type { Clock, IdSource, RuntimeSeams } from "../support/clock.ts";
import { DEFAULT_APPROVAL_TTL_SECONDS, STORE_WRITE_LOCK_WAIT_MS, WRITER_LEASE_STALE_MS } from "../policy/constants.ts";
import {
  LEASE_TOKEN_FILE,
  acquireLock,
  acquireStoreLock,
  ageOf,
  createLockDirectory,
  leaseOwnerAlive,
  readLeaseObservation,
  releaseLock,
  restorePath,
  tightenLockPath,
} from "./locks.ts";
import type { LeaseObservation, StoreLock } from "./locks.ts";

// Kept as a re-export because the approval path imports the store lock here.
export { acquireStoreLock };
export type { LeaseObservation, StoreLock };

export interface ApplyOptions {
  readonly store: PatchStore;
  readonly planId: string;
  readonly now: Date;
  /** Present when the caller acts as a specific human; the approval must name the same subject. */
  readonly subjectId?: string;
  /** Maximum age of the approval nonce in seconds. Defaults to the plan-level 600 s. */
  readonly approvalTtlSeconds?: number;
  /** Maximum age of a coverage policy snapshot in seconds; defaults to the shared policy bound. */
  readonly policyMaxAgeSeconds?: number;
  /** Optional time source for lease and claim bookkeeping; defaults to the system clock. */
  readonly clock?: Clock;
  /** Optional id source for lease tokens; defaults to crypto.randomUUID. */
  readonly ids?: IdSource;
  /** Cancels before a mutation commits; once a replace starts the journal finishes. */
  readonly signal?: AbortSignal;
}

export interface ApplyResult {
  readonly state: "applied" | "not_applied";
  readonly reasons: readonly ApplyReasonCode[];
  readonly change: AppliedChange | null;
  readonly resultText: string | null;
  readonly warnings?: readonly string[];
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function iso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function targetPath(binding: RepositoryBinding, plan: PatchPlan): string {
  return resolveInside(binding.workspaceRoot, plan.payload.workflowPath);
}

function resolveInside(root: string, relative: string): string {
  const base = resolve(root);
  const target = resolve(base, relative);
  if (!target.startsWith(base + sep)) throw new Error("WRITE_CONFLICT: path escapes the workspace");
  const physical = relativePath(realpathSync.native(base), realpathSync.native(target));
  if (physical === "" || isAbsolute(physical) || physical === ".." || physical.startsWith(".." + sep)) {
    throw new Error("WRITE_CONFLICT: resolved path escapes the workspace");
  }
  return target;
}

function assertRegularFile(path: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw new Error("WRITE_CONFLICT: refusing to replace a symbolic link");
  if (!stats.isFile()) throw new Error("WRITE_CONFLICT: target is not a regular file");
}

/**
 * Re-collect the files the workflow names right now instead of trusting the
 * refs stored in the plan: a symlink can be repointed at different bytes
 * without changing the path the plan recorded.
 */
function dependencyHashNow(binding: RepositoryBinding, workflowPath: string, text: string): string {
  try {
    const workflow = parseWorkflow(workflowPath, text);
    return digestOf({ dependencies: collectDependencies(binding.workspaceRoot, workflow).dependencies });
  } catch {
    // Bytes that cannot be parsed cannot match the approved dependency set.
    return "sha256:unparsable";
  }
}

/**
 * Serialize ci-diet writers with a directory lease.
 *
 * Two concurrent applies could interleave their backup and rename steps; the
 * lease makes the read-backup-replace sequence single-writer without depending
 * on platform file locking. A stale lease (a crashed process) expires by mtime,
 * and its owner process must be gone before anyone takes it over.
 *
 * Every mutation of the lease path happens while holding a short-lived claim
 * lock (a sibling directory): creating the lease, replacing a stale lease and
 * releasing are all serialized by it. The takeover therefore never moves a
 * lease path that another writer may be about to claim: it re-reads the lease
 * under the claim and leaves a live lease exactly where it is.
 */
function withWriterLease<T>(store: PatchStore, run: () => Promise<T>, seams?: RuntimeSeams): Promise<T> {
  const lockRoot = join(store.root, "locks");
  const lease = join(lockRoot, "writer");
  createLockDirectory(lockRoot);
  const clock = clockOf(seams);
  const ids = idsOf(seams);
  const token = "lease_" + process.pid.toString(36) + "_" + clock.now().getTime().toString(36) + "_" + ids.suffix(8);
  acquireWriterLease(lockRoot, lease, token, seams);
  return (async () => {
    try {
      return await run();
    } finally {
      releaseWriterLease(lease, token);
    }
  })();
}

function acquireWriterLease(lockRoot: string, lease: string, token: string, seams?: RuntimeSeams): void {
  const clock = clockOf(seams);
  // Heartbeat-free contention: a second writer fails fast instead of waiting.
  const claim = acquireLock(lockRoot, "writer", 0, "WRITE_CONFLICT: another ci-diet writer holds the workspace", seams);
  try {
    try {
      createWriterLease(lease, token);
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
    }
    const observed = readLeaseObservation(lease);
    if (observed === null) {
      // A lease directory without an owner token is a crash leftover. Under the
      // claim nobody else can create a lease, but only an old leftover is safe
      // to remove: a very recent one may be mid-create by an older writer.
      const age = ageOf(lease, clock);
      if (age !== null && age > WRITER_LEASE_STALE_MS) {
        rmSync(lease, { recursive: true, force: true });
        createWriterLease(lease, token);
        return;
      }
      throw new Error("WRITE_CONFLICT: another ci-diet writer holds the workspace");
    }
    if (clock.now().getTime() - observed.mtimeMs <= WRITER_LEASE_STALE_MS || leaseOwnerAlive(observed.owner)) {
      throw new Error("WRITE_CONFLICT: another ci-diet writer holds the workspace");
    }
    removeStaleWriterLease(lease, observed, token);
    createWriterLease(lease, token);
  } finally {
    claim.release();
  }
}

/** Move one observed-stale lease aside, verifying it under the writer claim. */
function removeStaleWriterLease(lease: string, observed: LeaseObservation, token: string): void {
  const trash = lease + ".stale-" + token;
  try {
    renameSync(lease, trash);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return;
    throw new Error("WRITE_CONFLICT: another ci-diet writer is taking over the lease");
  }
  const moved = readLeaseObservation(trash);
  if (moved === null || moved.owner !== observed.owner || leaseOwnerAlive(moved.owner)) {
    // Never delete a lease that turned out to have a live owner.
    restorePath(trash, lease);
    throw new Error("WRITE_CONFLICT: another ci-diet writer holds the workspace");
  }
  rmSync(trash, { recursive: true, force: true });
}

/**
 * Exported so the lease-race test can replay the takeover decision directly.
 * The decision is taken under the writer claim, exactly like a real acquire, so
 * a lease that changed owner after it was observed is never moved.
 */
export function takeOverWriterLease(lease: string, token: string, observed: LeaseObservation, seams?: RuntimeSeams): void {
  const claim = acquireLock(dirname(lease), "writer", 0, "WRITE_CONFLICT: another ci-diet writer holds the workspace", seams);
  try {
    const current = readLeaseObservation(lease);
    if (current === null) return;
    if (current.owner !== observed.owner || leaseOwnerAlive(current.owner)) {
      throw new Error("WRITE_CONFLICT: another ci-diet writer holds the workspace");
    }
    removeStaleWriterLease(lease, current, token);
    createWriterLease(lease, token);
  } finally {
    claim.release();
  }
}

function createWriterLease(lease: string, token: string): void {
  mkdirSync(lease);
  tightenLockPath(lease, 0o700);
  try {
    writeFileSync(join(lease, LEASE_TOKEN_FILE), token, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    // A lease directory without its token would block every writer until it
    // expires, so a failed create must remove what it just made.
    rmSync(lease, { recursive: true, force: true });
    throw error;
  }
}

function releaseWriterLease(lease: string, token: string): void {
  // Never move a lease that is not ours: if the owner token changed, the path
  // belongs to someone else and must stay where other writers can see it.
  releaseLock(lease, token);
}

async function replaceAtomically(path: string, text: string, mode: number, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const temporary = path + ".ci-diet-" + process.pid + "-" + Date.now().toString(36) + ".tmp";
  let renamed = false;
  try {
    try {
      writeFileSync(temporary, text, { encoding: "utf8", mode });
    } catch (error) {
      // Keep one error contract for every failed replacement attempt.
      throw new Error("WRITE_CONFLICT: replacement failed: " + String(error));
    }
    const handle = openSync(temporary, "r");
    try {
      try {
        fsyncSync(handle);
      } catch (syncError) {
        const code = (syncError as { code?: string }).code;
        if (code !== "EPERM" && code !== "EINVAL" && code !== "EBADF") throw syncError;
      }
    } finally {
      closeSync(handle);
    }
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        renameSync(temporary, path);
        renamed = true;
        return textHash(readFileSync(path, "utf8"));
      } catch (error) {
        lastError = error;
        if (signal?.aborted === true) break;
        await sleep(150 * (attempt + 1), undefined, signal === undefined ? undefined : { signal });
      }
    }
    throw new Error("WRITE_CONFLICT: replacement failed: " + String(lastError));
  } finally {
    // Never leave a sidecar behind, whether the write, fsync, sleep, or rename failed.
    if (!renamed) {
      try {
        rmSync(temporary, { force: true });
      } catch {
        // Cleanup is best-effort; the original failure is more useful.
      }
    }
  }
}

function changeRecord(
  plan: PatchPlan,
  changeId: string,
  state: AppliedChange["state"],
  binding: RepositoryBinding,
  beforeText: string,
  afterText: string,
  approvalReference: string,
  now: Date,
): AppliedChange {
  return {
    schemaVersion: 2,
    provenance: plan.provenance,
    changeId,
    bindingId: plan.payload.bindingId,
    planId: plan.planId,
    planDigest: plan.planDigest,
    workflowPath: plan.payload.workflowPath,
    state,
    before: {
      path: binding.workspaceRoot + sep + plan.payload.workflowPath,
      hash: textHash(beforeText),
      bytes: Buffer.byteLength(beforeText, "utf8"),
    },
    after: {
      path: binding.workspaceRoot + sep + plan.payload.workflowPath,
      hash: textHash(afterText),
      bytes: Buffer.byteLength(afterText, "utf8"),
    },
    approvalChannel: "human-cli",
    approvalReference,
    updatedAt: iso(now),
  };
}

function currentAttestations(store: PatchStore, plan: PatchPlan): Attestation[] {
  return plan.payload.attestations.map((attestation) => store.readAttestation(attestation.attestationId) ?? attestation);
}

function currentPolicies(store: PatchStore, binding: RepositoryBinding, now: Date): PolicySnapshot[] | undefined {
  const history = store.readLatestHistory(binding.bindingId);
  if (history === null) return undefined;
  return buildPolicySnapshots({ binding, protection: history.protection, retention: history.retention, now });
}

function changeForPlan(store: PatchStore, planId: string): AppliedChange | null {
  return store.listChanges().find((change) => change.planId === planId) ?? null;
}

/**
 * The journal, not the nonce, is the lasting record of a transaction: a nonce
 * that survived a failed cleanup would otherwise authorize a second apply of
 * an already applied or reverted change.
 */
function journalBlocksApply(store: PatchStore, planId: string): boolean {
  const change = changeForPlan(store, planId);
  if (change === null) return false;
  return change.state === "APPLIED" || change.state === "APPLYING"
    || change.state === "REVERTING" || change.state === "REVERTED";
}

function readTargetHash(target: string): string | null {
  try {
    return textHash(readFileSync(target, "utf8"));
  } catch {
    return null;
  }
}

function isNonceValid(nonce: ApprovalNonce | null, plan: PatchPlan, options: ApplyOptions): boolean {
  if (nonce === null) return false;
  if (plan.status.approvalNonceId !== nonce.nonceId || nonce.planDigest !== plan.planDigest) return false;
  const ttlSeconds = options.approvalTtlSeconds ?? DEFAULT_APPROVAL_TTL_SECONDS;
  const createdAt = Date.parse(nonce.createdAt);
  if (!Number.isFinite(createdAt)) return false;
  if (isExpired(options.now.getTime(), createdAt + ttlSeconds * 1000)) return false;
  if (options.subjectId !== undefined && nonce.subjectId !== options.subjectId) return false;
  return true;
}

function consumeAfterApply(options: ApplyOptions, plan: PatchPlan, reference: string): string[] {
  try {
    if (options.store.consumeNonce(plan.planId, reference)) return [];
  } catch {
    // The bytes are already correct; a failed nonce cleanup is reported, not fatal.
  }
  return ["NONCE_NOT_CONSUMED"];
}

/**
 * Recover an apply that crashed after the target was replaced but before the
 * journal recorded APPLIED. The target hash is the ground truth: if it already
 * holds the planned result, the journal is the only thing left to repair.
 */
function convergeInterruptedApply(
  options: ApplyOptions,
  plan: PatchPlan,
  targetText: string,
  targetHash: string,
  nonce: ApprovalNonce | null,
): ApplyResult | null {
  if (targetHash !== plan.payload.resultHash) return null;
  const recorded = changeForPlan(options.store, plan.planId);
  if (recorded === null) return null;
  if (recorded.before.hash !== plan.payload.sourceHash || recorded.after.hash !== plan.payload.resultHash) return null;
  const noncePending = nonce !== null && nonce.nonceId === plan.status.approvalNonceId;
  const inDoubt = recorded.state === "PREPARED" || recorded.state === "APPLYING";
  if (!inDoubt && !(recorded.state === "APPLIED" && noncePending)) return null;
  const change: AppliedChange = { ...recorded, state: "APPLIED", updatedAt: iso(options.now) };
  options.store.saveChange(change);
  const warnings = noncePending ? consumeAfterApply(options, plan, plan.status.approvalNonceId ?? "") : [];
  warnings.push(...options.store.appendSummaryEvent({ type: "apply_recovered", planId: plan.planId, changeId: change.changeId, resultHash: targetHash }, options.now));
  return { state: "applied", reasons: [], change, resultText: targetText, ...(warnings.length > 0 ? { warnings } : {}) };
}

/** Cleanup must not replace the error that explains why the transaction stopped. */
function discardBackup(store: PatchStore, changeId: string): void {
  try {
    store.removeBackup(changeId);
  } catch {
    // Best effort: a later prune can remove an unreachable backup.
  }
}

function handleReplaceFailure(
  options: ApplyOptions,
  plan: PatchPlan,
  applying: AppliedChange,
  target: string,
  beforeHash: string,
  afterHash: string,
  reference: string,
  failure: unknown,
): ApplyResult {
  const landed = readTargetHash(target);
  if (landed === afterHash) {
    // The replacement did land even though the call reported an error.
    const change: AppliedChange = { ...applying, state: "APPLIED", updatedAt: iso(options.now) };
    options.store.saveChange(change);
    const warnings = consumeAfterApply(options, plan, reference);
    warnings.push("REPLACE_VERIFIED_AFTER_ERROR");
    warnings.push(...options.store.appendSummaryEvent({ type: "applied", planId: plan.planId, changeId: change.changeId, resultHash: afterHash }, options.now));
    return { state: "applied", reasons: [], change, resultText: readFileSync(target, "utf8"), warnings };
  }
  if (landed === beforeHash) {
    // The target is untouched: keep the nonce so the user can retry the apply.
    options.store.saveChange({ ...applying, state: "NOT_APPLIED", updatedAt: iso(options.now) });
    discardBackup(options.store, applying.changeId);
    throw failure;
  }
  options.store.saveChange({ ...applying, state: "RECOVERY_REQUIRED", updatedAt: iso(options.now) });
  throw failure;
}

type ApplyInspection =
  | { readonly kind: "refused"; readonly result: ApplyResult }
  | { readonly kind: "ready"; readonly beforeText: string; readonly beforeHash: string; readonly text: string; readonly hash: string };

/**
 * Read-only decision phase: bring the target, approval, and journal up to date,
 * then verify every precondition and recompute the bytes the commit would write.
 * Nothing past this point may discover a refusal, so commitApply has no branch
 * that has to decide whether the file was touched.
 */
async function inspectApply(
  options: ApplyOptions,
  plan: PatchPlan,
  stored: StoredPlan,
  binding: RepositoryBinding,
  target: string,
): Promise<ApplyInspection> {
  assertRegularFile(target);
  const beforeText = readFileSync(target, "utf8");
  const beforeHash = textHash(beforeText);
  const nonce = options.store.readNonce(plan.planId);
  const nonceValid = isNonceValid(nonce, plan, options);

  // A previous run may have replaced the file and crashed before the journal
  // recorded APPLIED. The target hash is the ground truth for that window.
  const recovered = convergeInterruptedApply(options, plan, beforeText, beforeHash, nonce);
  if (recovered !== null) return { kind: "refused", result: recovered };

  // One approval authorizes one apply transaction. A crash is handled above by
  // convergence; anything else past NOT_APPLIED must stay refused, even when
  // the nonce file survived a failed cleanup.
  if (journalBlocksApply(options.store, plan.planId)) {
    const reasons: readonly ApplyReasonCode[] = ["NONCE_INVALID"];
    const warnings = options.store.appendSummaryEvent({ type: "apply_refused", planId: plan.planId, reasons }, options.now);
    return { kind: "refused", result: { state: "not_applied", reasons, change: null, resultText: null, ...(warnings.length > 0 ? { warnings } : {}) } };
  }

  const reasons = checkApply({
    plan,
    now: options.now,
    currentText: beforeText,
    currentDependencyHash: dependencyHashNow(binding, plan.payload.workflowPath, beforeText),
    coverageWriteAllowed: stored.meta.coverageWriteAllowed,
    nonceValid,
    backupAvailable: true,
    ...(options.policyMaxAgeSeconds !== undefined ? { policyMaxAgeMs: options.policyMaxAgeSeconds * 1000 } : {}),
    attestations: currentAttestations(options.store, plan),
    currentPolicies: currentPolicies(options.store, binding, options.now),
  });
  if (reasons.length > 0) {
    const warnings = options.store.appendSummaryEvent({ type: "apply_refused", planId: plan.planId, reasons }, options.now);
    return { kind: "refused", result: { state: "not_applied", reasons, change: null, resultText: null, ...(warnings.length > 0 ? { warnings } : {}) } };
  }

  // Recompute the edited bytes now: never trust a preview file that may be stale.
  const { applyEdits } = await import("./edits.ts");
  const applied = applyEdits(beforeText, plan.payload.edits);
  if (applied.hash !== plan.payload.resultHash || applied.hash === beforeHash) {
    return { kind: "refused", result: { state: "not_applied", reasons: ["SOURCE_HASH_MISMATCH"], change: null, resultText: null } };
  }
  const original = parseWorkflow(plan.payload.workflowPath, beforeText);
  const problems = semanticProblems({ original, originalText: beforeText, resultText: applied.text, edits: plan.payload.edits });
  if (problems.length > 0) {
    const warnings = options.store.appendSummaryEvent({ type: "edit_out_of_scope", planId: plan.planId, problems }, options.now);
    return { kind: "refused", result: { state: "not_applied", reasons: ["EDIT_OUT_OF_SCOPE"], change: null, resultText: null, ...(warnings.length > 0 ? { warnings } : {}) } };
  }
  return { kind: "ready", beforeText, beforeHash, text: applied.text, hash: applied.hash };
}

/**
 * Mutation phase. Every decision was made by inspectApply, so this function only
 * records the intent, rechecks the source immediately before the rename, and
 * finishes the journal. It keeps the original order: backup, PREPARED, recheck,
 * APPLYING, replace, APPLIED, consume.
 */
async function commitApply(
  options: ApplyOptions,
  plan: PatchPlan,
  binding: RepositoryBinding,
  target: string,
  inspection: Extract<ApplyInspection, { kind: "ready" }>,
): Promise<ApplyResult> {
  // Past this point a replace is committed: do not abort between the journal
  // entry and the rename, because the user asked for a recoverable transaction.
  throwIfAborted(options.signal);
  const changeId = options.store.changeIdFor(plan.planId, options.now);
  const manifest = options.store.writeBackup(changeId, inspection.beforeText, inspection.text, plan.payload.workflowPath, options.now);
  if (manifest.beforeHash !== textHash(inspection.beforeText) || manifest.afterHash !== inspection.hash) {
    discardBackup(options.store, changeId);
    return { state: "not_applied", reasons: ["BACKUP_UNAVAILABLE"], change: null, resultText: null };
  }
  const backup = options.store.readBackup(changeId);
  if (backup === null || backup.manifest.beforeHash !== manifest.beforeHash) {
    discardBackup(options.store, changeId);
    return { state: "not_applied", reasons: ["BACKUP_UNAVAILABLE"], change: null, resultText: null };
  }

  const reference = plan.status.approvalNonceId ?? "";
  const prepared = changeRecord(plan, changeId, "PREPARED", binding, inspection.beforeText, inspection.text, reference, options.now);
  try {
    options.store.saveChange(prepared);
  } catch (error) {
    // No journal record exists, so the file was never touched and nothing can
    // reference the backup.
    discardBackup(options.store, changeId);
    throw error;
  }

  // The bytes may have changed while the backup was written. Read again and
  // refuse rather than overwrite a concurrent user edit.
  const recheck = readFileSync(target, "utf8");
  if (textHash(recheck) !== inspection.beforeHash) {
    options.store.saveChange({ ...prepared, state: "NOT_APPLIED", updatedAt: iso(options.now) });
    discardBackup(options.store, changeId);
    const warnings = options.store.appendSummaryEvent({ type: "source_changed_before_replace", planId: plan.planId, changeId }, options.now);
    return { state: "not_applied", reasons: ["SOURCE_HASH_MISMATCH"], change: null, resultText: null, ...(warnings.length > 0 ? { warnings } : {}) };
  }

  // Journal the in-doubt state before touching the file, so a crash after the
  // rename is recoverable from the journal instead of looking untouched.
  const applying: AppliedChange = { ...prepared, state: "APPLYING", updatedAt: iso(options.now) };
  try {
    options.store.saveChange(applying);
  } catch (error) {
    discardBackup(options.store, changeId);
    throw error;
  }

  const mode = statSync(target).mode;
  let afterHash: string;
  try {
    afterHash = await replaceAtomically(target, inspection.text, mode, options.signal);
  } catch (error) {
    return handleReplaceFailure(options, plan, applying, target, inspection.beforeHash, inspection.hash, reference, error);
  }
  if (afterHash !== inspection.hash) {
    return handleReplaceFailure(options, plan, applying, target, inspection.beforeHash, inspection.hash, reference,
      new Error("RECOVERY_REQUIRED: bytes on disk do not match the planned result"));
  }

  const change: AppliedChange = { ...applying, state: "APPLIED", updatedAt: iso(options.now) };
  options.store.saveChange(change);
  // Consume only after the target holds the after-hash: a crash before this
  // point leaves a still-usable approval for the recovery path.
  const warnings = consumeAfterApply(options, plan, reference);
  warnings.push(...options.store.appendSummaryEvent({ type: "applied", planId: plan.planId, changeId, resultHash: afterHash }, options.now));
  return { state: "applied", reasons: [], change, resultText: inspection.text, ...(warnings.length > 0 ? { warnings } : {}) };
}
export async function applyPlan(options: ApplyOptions): Promise<ApplyResult> {
  throwIfAborted(options.signal);
  const stored: StoredPlan | null = options.store.readPlan(options.planId);
  if (stored === null) throw new Error("PLAN_NOT_FOUND: " + options.planId);
  const plan = stored.plan;
  if (plan.status.state !== "approved") return { state: "not_applied", reasons: ["NONCE_INVALID"], change: null, resultText: null };
  const binding = options.store.readBinding(plan.payload.bindingId);
  if (binding === null) throw new Error("BINDING_NOT_FOUND: " + plan.payload.bindingId);

  return withWriterLease(options.store, async () => {
    throwIfAborted(options.signal);
    const target = targetPath(binding, plan);
    const inspection = await inspectApply(options, plan, stored, binding, target);
    if (inspection.kind === "refused") return inspection.result;
    return commitApply(options, plan, binding, target, inspection);
  }, { clock: options.clock, ids: options.ids });
}

export async function revertChange(options: {
  readonly store: PatchStore;
  readonly changeId: string;
  readonly now: Date;
  /** Optional time source for lease bookkeeping; defaults to the system clock. */
  readonly clock?: Clock;
  /** Optional id source for lease tokens; defaults to crypto.randomUUID. */
  readonly ids?: IdSource;
  /** Cancels before the restore commits; once REVERTING is saved the journal finishes. */
  readonly signal?: AbortSignal;
}): Promise<{ readonly state: string; readonly reason: string | null; readonly warnings?: readonly string[] }> {
  throwIfAborted(options.signal);
  const change = options.store.readChange(options.changeId);
  if (change === null) throw new Error("CHANGE_NOT_FOUND: " + options.changeId);
  // CONFLICT is kept retryable: the user may restore the original bytes by hand,
  // and the hash check below then converges to REVERTED instead of dead-ending.
  const revertable = change.state === "APPLIED" || change.state === "RECOVERY_REQUIRED"
    || change.state === "REVERTING" || change.state === "PREPARED" || change.state === "APPLYING"
    || change.state === "CONFLICT";
  if (!revertable) return { state: change.state, reason: "CHANGE_NOT_APPLIED" };
  // PREPARED/APPLYING may be in doubt after a crash: the replacement may or may
  // not have landed, so classify by the target bytes before touching anything.
  const inDoubt = change.state === "PREPARED" || change.state === "APPLYING";
  const binding = options.store.readBinding(change.bindingId);
  if (binding === null) throw new Error("BINDING_NOT_FOUND: " + change.bindingId);

  return withWriterLease(options.store, async () => {
    throwIfAborted(options.signal);
    const target = resolveInside(binding.workspaceRoot, change.workflowPath);
    assertRegularFile(target);
    const currentText = readFileSync(target, "utf8");
    const currentHash = textHash(currentText);
    if (currentHash !== change.after.hash) {
      if (currentHash === change.before.hash) {
        if (inDoubt) {
          // The replacement never happened; only the journal needs correcting.
          options.store.saveChange({ ...change, state: "NOT_APPLIED", updatedAt: iso(options.now) });
          discardBackup(options.store, change.changeId);
          return { state: "NOT_APPLIED", reason: "TARGET_UNCHANGED" };
        }
        // A previous revert restored the bytes but crashed before finalizing the
        // journal, or the user restored them by hand. The goal already holds, so
        // converge instead of reporting a conflict the user cannot resolve.
        options.store.saveChange({ ...change, state: "REVERTED", updatedAt: iso(options.now) });
        const warnings = options.store.appendSummaryEvent({ type: "reverted", changeId: change.changeId }, options.now);
        return { state: "REVERTED", reason: null, ...(warnings.length > 0 ? { warnings } : {}) };
      }
      options.store.saveChange({ ...change, state: "CONFLICT", updatedAt: iso(options.now) });
      return { state: "CONFLICT", reason: "CURRENT_BYTES_CHANGED" };
    }
    // Hold the maintenance lock from the backup read through the restore, so a
    // confirmed backup cleanup cannot remove the bytes this revert depends on.
    const maintenance = acquireStoreLock(options.store, "maintenance", STORE_WRITE_LOCK_WAIT_MS, { clock: options.clock, ids: options.ids });
    try {
      const backup = options.store.readBackup(change.changeId);
      if (backup === null) {
        options.store.saveChange({ ...change, state: "RECOVERY_REQUIRED", updatedAt: iso(options.now) });
        return { state: "RECOVERY_REQUIRED", reason: "BACKUP_UNAVAILABLE" };
      }
      if (backup.manifest.beforeHash !== change.before.hash || textHash(backup.beforeText) !== change.before.hash) {
        options.store.saveChange({ ...change, state: "RECOVERY_REQUIRED", updatedAt: iso(options.now) });
        return { state: "RECOVERY_REQUIRED", reason: "BACKUP_HASH_MISMATCH" };
      }
      const recheck = readFileSync(target, "utf8");
      if (textHash(recheck) !== change.after.hash) {
        options.store.saveChange({ ...change, state: "CONFLICT", updatedAt: iso(options.now) });
        return { state: "CONFLICT", reason: "CURRENT_BYTES_CHANGED" };
      }
      // Record that the file may be restored before replacing it. A crash or a
      // journal write failure after this point leaves REVERTING with the bytes in
      // a known state, and a retry finishes the revert instead of conflicting.
      throwIfAborted(options.signal);
      if (change.state !== "REVERTING") {
        options.store.saveChange({ ...change, state: "REVERTING", updatedAt: iso(options.now) });
      }
      const mode = statSync(target).mode;
      const restoredHash = await replaceAtomically(target, backup.beforeText, mode, options.signal);
      if (restoredHash !== change.before.hash) {
        options.store.saveChange({ ...change, state: "RECOVERY_REQUIRED", updatedAt: iso(options.now) });
        return { state: "RECOVERY_REQUIRED", reason: "RESTORE_HASH_MISMATCH" };
      }
      options.store.saveChange({ ...change, state: "REVERTED", updatedAt: iso(options.now) });
      const warnings = options.store.appendSummaryEvent({ type: "reverted", changeId: change.changeId }, options.now);
      return { state: "REVERTED", reason: null, ...(warnings.length > 0 ? { warnings } : {}) };
    } finally {
      maintenance.release();
    }
  }, { clock: options.clock, ids: options.ids });
}

export function resolveWorkflowFile(binding: RepositoryBinding, workflowPath: string): string {
  const target = resolveInside(binding.workspaceRoot, workflowPath);
  void basename;
  void dirname;
  return target;
}
