import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative as relativePath, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AppliedChange, Attestation, PatchPlan, PolicySnapshot } from "../contracts/schema.ts";
import type { RepositoryBinding } from "../contracts/schema.ts";
import { checkApply } from "./verify.ts";
import type { ApplyReasonCode } from "./verify.ts";
import { PatchStore, textHash } from "./store.ts";
import { digestOf, sha256Hex } from "../../shared/cdj1.ts";
import type { StoredPlan } from "./store.ts";
import { buildPolicySnapshots } from "./plan.ts";
import { semanticProblems } from "./semantic.ts";
import { parseWorkflow } from "../workflow/parse.ts";

export interface ApplyOptions {
  readonly store: PatchStore;
  readonly planId: string;
  readonly now: Date;
  readonly subjectId: string;
}

export interface ApplyResult {
  readonly state: "applied" | "not_applied";
  readonly reasons: readonly ApplyReasonCode[];
  readonly change: AppliedChange | null;
  readonly resultText: string | null;
  readonly warnings?: readonly string[];
}

const WRITER_LEASE_STALE_MS = 10 * 60_000;

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

/**
 * Serialize ci-diet writers with a directory lease.
 *
 * Two concurrent applies could interleave their backup and rename steps; the
 * lease makes the read-backup-replace sequence single-writer without depending
 * on platform file locking. A stale lease (a crashed process) expires by mtime.
 */
function withWriterLease<T>(store: PatchStore, run: () => Promise<T>): Promise<T> {
  const lockRoot = join(store.root, "locks");
  const lease = join(lockRoot, "writer");
  mkdirSync(lockRoot, { recursive: true });
  let acquired = false;
  try {
    mkdirSync(lease);
    acquired = true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "EEXIST") throw error;
    try {
      const age = Date.now() - statSync(lease).mtimeMs;
      if (age <= WRITER_LEASE_STALE_MS) throw new Error("WRITE_CONFLICT: another ci-diet writer holds the workspace");
      rmSync(lease, { recursive: true, force: true });
      mkdirSync(lease);
      acquired = true;
    } catch (staleError) {
      if (staleError instanceof Error && staleError.message.startsWith("WRITE_CONFLICT")) throw staleError;
      throw new Error("WRITE_CONFLICT: could not acquire the writer lease");
    }
  }
  return (async () => {
    try {
      return await run();
    } finally {
      if (acquired) rmSync(lease, { recursive: true, force: true });
    }
  })();
}

async function replaceAtomically(path: string, text: string, mode: number): Promise<string> {
  const temporary = path + ".ci-diet-" + process.pid + "-" + Date.now().toString(36) + ".tmp";
  writeFileSync(temporary, text, { encoding: "utf8", mode });
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
    const nonce = options.store.readNonce(plan.planId);
    const nonceValid = nonce !== null && plan.status.approvalNonceId === nonce.nonceId && nonce.planDigest === plan.planDigest;

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
      options.store.appendEvent({ type: "apply_refused", planId: plan.planId, reasons }, options.now);
      return { state: "not_applied", reasons, change: null, resultText: null };
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
      options.store.appendEvent({ type: "edit_out_of_scope", planId: plan.planId, problems }, options.now);
      return { state: "not_applied", reasons: ["EDIT_OUT_OF_SCOPE"], change: null, resultText: null };
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
    if (textHash(recheck) !== textHash(beforeText)) {
      options.store.saveChange({ ...prepared, state: "NOT_APPLIED", updatedAt: iso(options.now) });
      options.store.appendEvent({ type: "source_changed_before_replace", planId: plan.planId, changeId }, options.now);
      return { state: "not_applied", reasons: ["SOURCE_HASH_MISMATCH"], change: null, resultText: null };
    }

    if (!options.store.consumeNonce(plan.planId, reference)) {
      options.store.saveChange({ ...prepared, state: "NOT_APPLIED", updatedAt: iso(options.now) });
      return { state: "not_applied", reasons: ["NONCE_INVALID"], change: null, resultText: null };
    }

    const mode = statSync(target).mode;
    let afterHash: string;
    try {
      afterHash = await replaceAtomically(target, applied.text, mode);
    } catch (error) {
      options.store.saveChange({ ...prepared, state: "RECOVERY_REQUIRED", updatedAt: iso(options.now) });
      throw error;
    }
    if (afterHash !== applied.hash) {
      options.store.saveChange({ ...prepared, state: "RECOVERY_REQUIRED", updatedAt: iso(options.now) });
      throw new Error("RECOVERY_REQUIRED: bytes on disk do not match the planned result");
    }

    const change: AppliedChange = { ...prepared, state: "APPLIED", updatedAt: iso(options.now) };
    options.store.saveChange(change);
    const warnings = options.store.appendSummaryEvent({ type: "applied", planId: plan.planId, changeId, resultHash: afterHash }, options.now);
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
  if (change.state !== "APPLIED" && change.state !== "RECOVERY_REQUIRED") return { state: change.state, reason: "CHANGE_NOT_APPLIED" };
  const binding = options.store.readBinding(change.bindingId);
  if (binding === null) throw new Error("BINDING_NOT_FOUND: " + change.bindingId);

  return withWriterLease(options.store, async () => {
    const backup = options.store.readBackup(change.changeId);
    if (backup === null) {
      options.store.saveChange({ ...change, state: "RECOVERY_REQUIRED", updatedAt: iso(options.now) });
      return { state: "RECOVERY_REQUIRED", reason: "BACKUP_UNAVAILABLE" };
    }
    const target = resolveInside(binding.workspaceRoot, change.workflowPath);
    assertRegularFile(target);
    const currentText = readFileSync(target, "utf8");
    if (textHash(currentText) !== change.after.hash) {
      options.store.saveChange({ ...change, state: "CONFLICT", updatedAt: iso(options.now) });
      return { state: "CONFLICT", reason: "CURRENT_BYTES_CHANGED" };
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
