import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative as relativePath, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AppliedChange, Attestation, PatchPlan, PolicySnapshot } from "../contracts/schema.ts";
import type { RepositoryBinding } from "../contracts/schema.ts";
import { checkApply } from "./verify.ts";
import type { ApplyReasonCode } from "./verify.ts";
import { PatchStore, textHash } from "./store.ts";
import { digestOf, sha256Hex } from "../../shared/cdj1.ts";
import type { ApprovalNonce, StoredPlan } from "./store.ts";
import { buildPolicySnapshots } from "./plan.ts";
import { semanticProblems } from "./semantic.ts";
import { parseWorkflow } from "../workflow/parse.ts";

export interface ApplyOptions {
  readonly store: PatchStore;
  readonly planId: string;
  readonly now: Date;
  /** Present when the caller acts as a specific human; the approval must name the same subject. */
  readonly subjectId?: string;
  /** Maximum age of the approval nonce in seconds. Defaults to the plan-level 600 s. */
  readonly approvalTtlSeconds?: number;
}

export interface ApplyResult {
  readonly state: "applied" | "not_applied";
  readonly reasons: readonly ApplyReasonCode[];
  readonly change: AppliedChange | null;
  readonly resultText: string | null;
  readonly warnings?: readonly string[];
}

const WRITER_LEASE_STALE_MS = 10 * 60_000;
const DEFAULT_APPROVAL_TTL_SECONDS = 600;
const LEASE_TOKEN_FILE = "owner";

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

/** Recompute the dependency hash from the files that exist right now. */
function dependencyHashFromDisk(binding: RepositoryBinding, dependencies: PatchPlan["payload"]["dependencies"]): string {
  const rows = dependencies.map((dependency) => {
    try {
      const path = resolveInside(binding.workspaceRoot, dependency.ref);
      assertRegularFile(path);
      return { ref: dependency.ref, sha256: "sha256:" + sha256Hex(readFileSync(path, "utf8")) };
    } catch {
      return { ref: dependency.ref, sha256: "sha256:unresolved" };
    }
  });
  return digestOf({ dependencies: rows });
}

/** What a takeover observed about the lease before it tried to move it. */
export interface LeaseObservation {
  readonly owner: string;
  readonly mtimeMs: number;
}

/**
 * Serialize ci-diet writers with a directory lease.
 *
 * Two concurrent applies could interleave their backup and rename steps; the
 * lease makes the read-backup-replace sequence single-writer without depending
 * on platform file locking. A stale lease (a crashed process) expires by mtime.
 * The lease carries a unique owner token so a release only removes its own
 * lease, and a stale lease is taken over with rename, never remove-then-create.
 * A rename alone is not enough: the lease can be released and re-created by a
 * live writer between the staleness check and the rename, so takeover verifies
 * the moved token and restores the lease instead of stealing it.
 */
function withWriterLease<T>(store: PatchStore, run: () => Promise<T>): Promise<T> {
  const lockRoot = join(store.root, "locks");
  const lease = join(lockRoot, "writer");
  mkdirSync(lockRoot, { recursive: true });
  const token = "lease_" + process.pid.toString(36) + "_" + Date.now().toString(36) + "_" + randomUUID().slice(0, 8);
  acquireWriterLease(lease, token);
  return (async () => {
    try {
      return await run();
    } finally {
      releaseWriterLease(lease, token);
    }
  })();
}

function acquireWriterLease(lease: string, token: string): void {
  try {
    createWriterLease(lease, token);
    return;
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
  }
  const observed = readLeaseObservation(lease);
  if (observed === null) {
    // The lease vanished between mkdir and stat: try to become the owner now.
    try {
      createWriterLease(lease, token);
      return;
    } catch (retryError) {
      if ((retryError as { code?: string }).code === "EEXIST") throw new Error("WRITE_CONFLICT: another ci-diet writer holds the workspace");
      throw new Error("WRITE_CONFLICT: could not acquire the writer lease");
    }
  }
  if (Date.now() - observed.mtimeMs <= WRITER_LEASE_STALE_MS) {
    throw new Error("WRITE_CONFLICT: another ci-diet writer holds the workspace");
  }
  takeOverWriterLease(lease, token, observed);
}

function readLeaseObservation(lease: string): LeaseObservation | null {
  let owner: string;
  let mtimeMs: number;
  try {
    owner = readFileSync(join(lease, LEASE_TOKEN_FILE), "utf8");
    mtimeMs = statSync(lease).mtimeMs;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw new Error("WRITE_CONFLICT: could not read the writer lease");
  }
  return { owner, mtimeMs };
}

/** Exported so the lease-race test can replay the takeover decision directly. */
export function takeOverWriterLease(lease: string, token: string, observed: LeaseObservation): void {
  // rename is the atomic primitive: exactly one process can move the stale
  // directory aside, so two takeovers cannot both become the writer. The moved
  // directory is then checked against what was observed: a live writer may have
  // released the stale lease and created a fresh one after that check.
  const trash = lease + ".stale-" + token;
  try {
    renameSync(lease, trash);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      // Someone else took over or released first; only an uncontended mkdir wins.
      try {
        createWriterLease(lease, token);
      } catch (retryError) {
        if ((retryError as { code?: string }).code === "EEXIST") throw new Error("WRITE_CONFLICT: another ci-diet writer holds the workspace");
        throw new Error("WRITE_CONFLICT: could not acquire the writer lease");
      }
      return;
    }
    throw new Error("WRITE_CONFLICT: another ci-diet writer is taking over the lease");
  }
  const moved = readLeaseObservation(trash);
  if (moved === null || moved.owner !== observed.owner) {
    // The lease we moved is not the stale one we observed. Put the live lease
    // back so its owner keeps serialization; never delete another token.
    restoreWriterLease(trash, lease);
    throw new Error("WRITE_CONFLICT: another ci-diet writer holds the workspace");
  }
  rmSync(trash, { recursive: true, force: true });
  try {
    createWriterLease(lease, token);
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") throw new Error("WRITE_CONFLICT: another ci-diet writer holds the workspace");
    throw new Error("WRITE_CONFLICT: could not acquire the writer lease");
  }
}

function restoreWriterLease(trash: string, lease: string): void {
  try {
    renameSync(trash, lease);
  } catch {
    // The lease path is occupied again or cannot be restored. Keep the moved
    // lease under its trash name: deleting it would erase a live writer token.
  }
}

function createWriterLease(lease: string, token: string): void {
  mkdirSync(lease);
  try {
    writeFileSync(join(lease, LEASE_TOKEN_FILE), token, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    // A lease directory without its token would block every writer until it
    // expires, so a failed create must remove what it just made.
    rmSync(lease, { recursive: true, force: true });
    throw error;
  }
}

function releaseWriterLease(lease: string, token: string): void {
  // Move first and inspect the moved directory, so a lease that changed owners
  // between the token read and the delete is restored instead of removed.
  const trash = lease + ".release-" + token;
  try {
    renameSync(lease, trash);
  } catch {
    return;
  }
  const moved = readLeaseObservation(trash);
  if (moved === null || moved.owner !== token) {
    restoreWriterLease(trash, lease);
    return;
  }
  rmSync(trash, { recursive: true, force: true });
}

async function replaceAtomically(path: string, text: string, mode: number): Promise<string> {
  const temporary = path + ".ci-diet-" + process.pid + "-" + Date.now().toString(36) + ".tmp";
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
      return textHash(readFileSync(path, "utf8"));
    } catch (error) {
      lastError = error;
      await sleep(150 * (attempt + 1));
    }
  }
  rmSync(temporary, { force: true });
  throw new Error("WRITE_CONFLICT: replacement failed: " + String(lastError));
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
  if (options.now.getTime() > createdAt + ttlSeconds * 1000) return false;
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
    throw failure;
  }
  options.store.saveChange({ ...applying, state: "RECOVERY_REQUIRED", updatedAt: iso(options.now) });
  throw failure;
}

export async function applyPlan(options: ApplyOptions): Promise<ApplyResult> {
  const stored: StoredPlan | null = options.store.readPlan(options.planId);
  if (stored === null) throw new Error("PLAN_NOT_FOUND: " + options.planId);
  const plan = stored.plan;
  if (plan.status.state !== "approved") return { state: "not_applied", reasons: ["NONCE_INVALID"], change: null, resultText: null };
  const binding = options.store.readBinding(plan.payload.bindingId);
  if (binding === null) throw new Error("BINDING_NOT_FOUND: " + plan.payload.bindingId);

  return withWriterLease(options.store, async () => {
    const target = targetPath(binding, plan);
    assertRegularFile(target);
    const beforeText = readFileSync(target, "utf8");
    const beforeHash = textHash(beforeText);
    const nonce = options.store.readNonce(plan.planId);
    const nonceValid = isNonceValid(nonce, plan, options);

    // A previous run may have replaced the file and crashed before the journal
    // recorded APPLIED. The target hash is the ground truth for that window.
    const recovered = convergeInterruptedApply(options, plan, beforeText, beforeHash, nonce);
    if (recovered !== null) return recovered;

    const reasons = checkApply({
      plan,
      now: options.now,
      currentText: beforeText,
      currentDependencyHash: dependencyHashFromDisk(binding, plan.payload.dependencies),
      coverageWriteAllowed: stored.meta.coverageWriteAllowed,
      nonceValid,
      backupAvailable: true,
      attestations: currentAttestations(options.store, plan),
      currentPolicies: currentPolicies(options.store, binding, options.now),
    });
    if (reasons.length > 0) {
      const warnings = options.store.appendSummaryEvent({ type: "apply_refused", planId: plan.planId, reasons }, options.now);
      return { state: "not_applied", reasons, change: null, resultText: null, ...(warnings.length > 0 ? { warnings } : {}) };
    }

    // Recompute the edited bytes now: never trust a preview file that may be stale.
    const { applyEdits } = await import("./edits.ts");
    const applied = applyEdits(beforeText, plan.payload.edits);
    if (applied.hash !== plan.payload.resultHash || applied.hash === textHash(beforeText)) {
      return { state: "not_applied", reasons: ["SOURCE_HASH_MISMATCH"], change: null, resultText: null };
    }
    const original = parseWorkflow(plan.payload.workflowPath, beforeText);
    const problems = semanticProblems({ original, originalText: beforeText, resultText: applied.text, edits: plan.payload.edits });
    if (problems.length > 0) {
      const warnings = options.store.appendSummaryEvent({ type: "edit_out_of_scope", planId: plan.planId, problems }, options.now);
      return { state: "not_applied", reasons: ["EDIT_OUT_OF_SCOPE"], change: null, resultText: null, ...(warnings.length > 0 ? { warnings } : {}) };
    }

    const changeId = options.store.changeIdFor(plan.planId, options.now);
    const manifest = options.store.writeBackup(changeId, beforeText, applied.text, plan.payload.workflowPath, options.now);
    if (manifest.beforeHash !== textHash(beforeText) || manifest.afterHash !== applied.hash) {
      return { state: "not_applied", reasons: ["BACKUP_UNAVAILABLE"], change: null, resultText: null };
    }
    const backup = options.store.readBackup(changeId);
    if (backup === null || backup.manifest.beforeHash !== manifest.beforeHash) {
      return { state: "not_applied", reasons: ["BACKUP_UNAVAILABLE"], change: null, resultText: null };
    }

    const reference = plan.status.approvalNonceId ?? "";
    const prepared = changeRecord(plan, changeId, "PREPARED", binding, beforeText, applied.text, reference, options.now);
    options.store.saveChange(prepared);

    // The bytes may have changed while the backup was written. Read again and
    // refuse rather than overwrite a concurrent user edit.
    const recheck = readFileSync(target, "utf8");
    if (textHash(recheck) !== beforeHash) {
      options.store.saveChange({ ...prepared, state: "NOT_APPLIED", updatedAt: iso(options.now) });
      const warnings = options.store.appendSummaryEvent({ type: "source_changed_before_replace", planId: plan.planId, changeId }, options.now);
      return { state: "not_applied", reasons: ["SOURCE_HASH_MISMATCH"], change: null, resultText: null, ...(warnings.length > 0 ? { warnings } : {}) };
    }

    // Journal the in-doubt state before touching the file, so a crash after the
    // rename is recoverable from the journal instead of looking untouched.
    const applying: AppliedChange = { ...prepared, state: "APPLYING", updatedAt: iso(options.now) };
    options.store.saveChange(applying);

    const mode = statSync(target).mode;
    let afterHash: string;
    try {
      afterHash = await replaceAtomically(target, applied.text, mode);
    } catch (error) {
      return handleReplaceFailure(options, plan, applying, target, beforeHash, applied.hash, reference, error);
    }
    if (afterHash !== applied.hash) {
      return handleReplaceFailure(options, plan, applying, target, beforeHash, applied.hash, reference,
        new Error("RECOVERY_REQUIRED: bytes on disk do not match the planned result"));
    }

    const change: AppliedChange = { ...applying, state: "APPLIED", updatedAt: iso(options.now) };
    options.store.saveChange(change);
    // Consume only after the target holds the after-hash: a crash before this
    // point leaves a still-usable approval for the recovery path.
    const warnings = consumeAfterApply(options, plan, reference);
    warnings.push(...options.store.appendSummaryEvent({ type: "applied", planId: plan.planId, changeId, resultHash: afterHash }, options.now));
    return { state: "applied", reasons: [], change, resultText: applied.text, ...(warnings.length > 0 ? { warnings } : {}) };
  });
}

export async function revertChange(options: {
  readonly store: PatchStore;
  readonly changeId: string;
  readonly now: Date;
}): Promise<{ readonly state: string; readonly reason: string | null; readonly warnings?: readonly string[] }> {
  const change = options.store.readChange(options.changeId);
  if (change === null) throw new Error("CHANGE_NOT_FOUND: " + options.changeId);
  const revertable = change.state === "APPLIED" || change.state === "RECOVERY_REQUIRED"
    || change.state === "PREPARED" || change.state === "APPLYING";
  if (!revertable) return { state: change.state, reason: "CHANGE_NOT_APPLIED" };
  // PREPARED/APPLYING may be in doubt after a crash: the replacement may or may
  // not have landed, so classify by the target bytes before touching anything.
  const inDoubt = change.state === "PREPARED" || change.state === "APPLYING";
  const binding = options.store.readBinding(change.bindingId);
  if (binding === null) throw new Error("BINDING_NOT_FOUND: " + change.bindingId);

  return withWriterLease(options.store, async () => {
    const target = resolveInside(binding.workspaceRoot, change.workflowPath);
    assertRegularFile(target);
    const currentText = readFileSync(target, "utf8");
    if (textHash(currentText) !== change.after.hash) {
      if (inDoubt && textHash(currentText) === change.before.hash) {
        // The replacement never happened; only the journal needs correcting.
        options.store.saveChange({ ...change, state: "NOT_APPLIED", updatedAt: iso(options.now) });
        return { state: "NOT_APPLIED", reason: "TARGET_UNCHANGED" };
      }
      options.store.saveChange({ ...change, state: "CONFLICT", updatedAt: iso(options.now) });
      return { state: "CONFLICT", reason: "CURRENT_BYTES_CHANGED" };
    }
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
    const mode = statSync(target).mode;
    const restoredHash = await replaceAtomically(target, backup.beforeText, mode);
    if (restoredHash !== change.before.hash) {
      options.store.saveChange({ ...change, state: "RECOVERY_REQUIRED", updatedAt: iso(options.now) });
      return { state: "RECOVERY_REQUIRED", reason: "RESTORE_HASH_MISMATCH" };
    }
    options.store.saveChange({ ...change, state: "REVERTED", updatedAt: iso(options.now) });
    const warnings = options.store.appendSummaryEvent({ type: "reverted", changeId: change.changeId }, options.now);
    return { state: "REVERTED", reason: null, ...(warnings.length > 0 ? { warnings } : {}) };
  });
}

export function resolveWorkflowFile(binding: RepositoryBinding, workflowPath: string): string {
  const target = resolveInside(binding.workspaceRoot, workflowPath);
  void basename;
  void dirname;
  return target;
}
