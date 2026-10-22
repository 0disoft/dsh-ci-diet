import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { AnalysisReport, AppliedChange, Attestation, PatchPlan, PlanStatus, RepositoryBinding } from "../contracts/schema.ts";
import type { HistoryBundle } from "../history/model.ts";
import { assertValidDocument, validationErrors } from "../contracts/validate.ts";
import type { DocumentKind } from "../contracts/validate.ts";
import { digestOf } from "../../shared/cdj1.ts";

export interface PlanMeta {
  readonly coverageWriteAllowed: boolean;
  readonly reportId: string | null;
}

export interface ApprovalNonce {
  readonly nonceId: string;
  readonly planDigest: string;
  readonly createdAt: string;
  readonly subjectId: string;
  readonly channel: "human-ui" | "human-cli";
}

export interface BackupManifest {
  readonly changeId: string;
  readonly workflowPath: string;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly createdAt: string;
}

export interface StoredBackup {
  readonly manifest: BackupManifest;
  readonly beforeText: string;
  readonly afterText: string;
}

export interface StoredPlan {
  readonly plan: PatchPlan;
  readonly meta: PlanMeta;
}

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function requireId(value: string, label: string): string {
  if (!ID_PATTERN.test(value)) throw new Error("STORE_INVALID_ID: " + label);
  return value;
}

function sha256Text(text: string): string {
  return "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
}

export function textHash(text: string): string {
  return sha256Text(text);
}

export interface PruneLimits {
  readonly reportDays: number;
  readonly planDays: number;
  readonly cacheDays: number;
  /** Product cache cap; oldest cache entries are pruned until the directory fits. */
  readonly cacheMaxBytes?: number;
}

export interface PruneResult {
  readonly removedReports: number;
  readonly removedPlans: number;
  readonly removedCacheEntries: number;
  readonly bytesFreed: number;
}

/** Product-level limits from `Config.storage`; `null` means the store does not enforce a quota. */
export interface StorageLimits {
  readonly storeMaxBytes: number;
  readonly warningPercent: number;
  readonly cacheMaxBytes: number;
  readonly pruneAppliedBackups: boolean;
}

export interface StorageStatus {
  readonly bytes: number;
  readonly files: number;
  readonly limit: number;
  readonly percent: number;
  readonly warning: boolean;
  readonly blocked: boolean;
}

/** A write that would cross the configured store quota is refused before any byte lands. */
export class StoreQuotaError extends Error {
  constructor(usedBytes: number, limitBytes: number, additionalBytes: number) {
    super(
      "STORAGE_QUOTA_EXCEEDED: " + usedBytes + " + " + additionalBytes + " bytes exceeds the " + limitBytes + "-byte store quota",
    );
    this.name = "StoreQuotaError";
  }
}

export interface AppliedBackupCandidate {
  readonly changeId: string;
  readonly planId: string;
  readonly workflowPath: string;
  readonly state: AppliedChange["state"];
  readonly appliedAt: string;
  readonly bytes: number;
  readonly backupPath: string;
}

export interface AppliedBackupCleanupResult {
  readonly removedBackups: number;
  readonly bytesFreed: number;
}

/** Human-confirmation token for deleting applied backups; derived from the exact change ids. */
export function appliedBackupConfirmToken(changeIds: readonly string[]): string {
  const sorted = [...changeIds].sort();
  return createHash("sha256").update(sorted.join("\n"), "utf8").digest("hex").slice(0, 16);
}

const DAY_MS = 86_400_000;

/** Corrupt local state stays on disk for review and must not be treated as absent. */
export class StoreCorruptionError extends Error {
  constructor(path: string, reason: string) {
    super("STATE_INVALID: " + path + " (" + reason + ")");
    this.name = "StoreCorruptionError";
  }
}

function ageCutoff(now: Date, days: number): number {
  return now.getTime() - days * DAY_MS;
}

function entryBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Bytes in one file or an entire directory tree; used by cache and backup accounting. */
function deepBytes(path: string): number {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of readdirSync(path)) total += deepBytes(join(path, entry));
  return total;
}

export class PatchStore {
  readonly root: string;
  private readonly limits: StorageLimits | null;

  constructor(root: string, limits: StorageLimits | null = null) {
    this.root = root;
    this.limits = limits;
  }

  static open(root: string, limits: StorageLimits | null = null): PatchStore {
    const store = new PatchStore(root, limits);
    store.ensureDirectory(root);
    for (const directory of ["bindings", "reports", "plans", "attestations", "backups", "changes", "events", "snapshots", "snapshots/history"]) {
      store.ensureDirectory(join(root, directory));
    }
    return store;
  }

  private isWithinRoot(path: string): boolean {
    return path === this.root || path.startsWith(this.root.endsWith(sep) ? this.root : this.root + sep);
  }

  /**
   * The store belongs to one user, so its directories are 0700 and its files
   * 0600 on POSIX regardless of umask; Windows has no POSIX bits (ACLs apply).
   * An existing directory with wider modes is tightened on the next open.
   */
  private ensureDirectory(path: string): void {
    mkdirSync(path, { recursive: true });
    if (process.platform === "win32") return;
    let current = path;
    while (this.isWithinRoot(current)) {
      try {
        chmodSync(current, 0o700);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "EPERM" && code !== "EACCES" && code !== "ENOENT") throw error;
      }
      if (current === this.root) break;
      current = dirname(current);
    }
  }

  private path(...parts: string[]): string {
    return join(this.root, ...parts);
  }

  private writeJson(path: string, value: unknown): void {
    this.writeText(path, JSON.stringify(value, null, 2) + "\n");
  }

  private writeText(path: string, text: string): void {
    this.ensureCapacity(Buffer.byteLength(text, "utf8"));
    this.ensureDirectory(dirname(path));
    const temporary = path + ".tmp-" + process.pid + "-" + Math.random().toString(16).slice(2);
    try {
      // Rename keeps the mode, so one 0600 temp file settles the record's mode.
      writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
      const handle = openSync(temporary, "r");
      try {
        try {
          fsyncSync(handle);
        } catch (syncError) {
          // Windows rejects fsync on a read-only handle; durability is best effort there.
          const code = (syncError as { code?: string }).code;
          if (code !== "EPERM" && code !== "EINVAL" && code !== "EBADF") throw syncError;
        }
      } finally {
        closeSync(handle);
      }
      renameSync(temporary, path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  private readJson<T>(path: string, kind?: DocumentKind): T | null {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      // JSON parser messages can contain record contents; report only the file and category.
      throw new StoreCorruptionError(path, "invalid JSON");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new StoreCorruptionError(path, "expected an object");
    }
    if (kind !== undefined && validationErrors(kind, value).length > 0) {
      throw new StoreCorruptionError(path, kind + " schema mismatch");
    }
    return value as T;
  }

  saveBinding(binding: RepositoryBinding): void {
    assertValidDocument("RepositoryBinding", binding);
    this.writeJson(this.path("bindings", requireId(binding.bindingId, "bindingId") + ".json"), binding);
  }

  readBinding(bindingId: string): RepositoryBinding | null {
    return this.readJson<RepositoryBinding>(this.path("bindings", requireId(bindingId, "bindingId") + ".json"), "RepositoryBinding");
  }

  saveReport(report: AnalysisReport): void {
    assertValidDocument("AnalysisReport", report);
    this.writeJson(this.path("reports", requireId(report.reportId, "reportId") + ".json"), report);
  }

  /** Find the most recently recorded binding for a root, including after a remote change. */
  findBindingByRoot(workspaceRoot: string): RepositoryBinding | null {
    const directory = this.path("bindings");
    const wanted = process.platform === "win32" ? workspaceRoot.toLowerCase() : workspaceRoot;
    let latest: RepositoryBinding | null = null;
    let latestAt = Number.NEGATIVE_INFINITY;
    for (const file of readdirSync(directory)) {
      if (!file.endsWith(".json")) continue;
      const binding = this.readJson<RepositoryBinding>(join(directory, file), "RepositoryBinding");
      if (binding === null) continue;
      const candidate = process.platform === "win32" ? binding.workspaceRoot.toLowerCase() : binding.workspaceRoot;
      const at = Date.parse(binding.createdAt);
      if (candidate === wanted && at > latestAt) {
        latest = binding;
        latestAt = at;
      }
    }
    return latest;
  }

  readReport(reportId: string): AnalysisReport | null {
    return this.readJson<AnalysisReport>(this.path("reports", requireId(reportId, "reportId") + ".json"), "AnalysisReport");
  }

  latestReport(): AnalysisReport | null {
    const directory = this.path("reports");
    const files = readdirSync(directory).filter((name) => name.endsWith(".json"));
    let latest: AnalysisReport | null = null;
    let latestAt = Number.NEGATIVE_INFINITY;
    for (const file of files) {
      const report = this.readJson<AnalysisReport>(join(directory, file), "AnalysisReport");
      if (report === null) continue;
      const at = Date.parse(report.generatedAt);
      if (at > latestAt) {
        latestAt = at;
        latest = report;
      }
    }
    return latest;
  }

  /** Latest report produced for one binding, never another repository's report. */
  latestReportForBinding(bindingId: string): AnalysisReport | null {
    const directory = this.path("reports");
    const files = readdirSync(directory).filter((name) => name.endsWith(".json"));
    let latest: AnalysisReport | null = null;
    let latestAt = Number.NEGATIVE_INFINITY;
    for (const file of files) {
      const report = this.readJson<AnalysisReport>(join(directory, file), "AnalysisReport");
      if (report === null || report.bindingId !== bindingId) continue;
      const at = Date.parse(report.generatedAt);
      if (at > latestAt) {
        latestAt = at;
        latest = report;
      }
    }
    return latest;
  }

  saveAttestation(attestation: Attestation): void {
    assertValidDocument("Attestation", attestation);
    this.writeJson(this.path("attestations", requireId(attestation.attestationId, "attestationId") + ".json"), attestation);
  }

  readAttestation(attestationId: string): Attestation | null {
    return this.readJson<Attestation>(this.path("attestations", requireId(attestationId, "attestationId") + ".json"), "Attestation");
  }

  savePlan(plan: PatchPlan, meta: PlanMeta): void {
    assertValidDocument("PatchPlan", plan);
    this.writeJson(this.path("plans", requireId(plan.planId, "planId") + ".json"), plan);
    this.writeJson(this.path("plans", requireId(plan.planId, "planId") + ".meta.json"), meta);
  }

  readPlan(planId: string): StoredPlan | null {
    const plan = this.readJson<PatchPlan>(this.path("plans", requireId(planId, "planId") + ".json"), "PatchPlan");
    if (plan === null) return null;
    const metaPath = this.path("plans", requireId(planId, "planId") + ".meta.json");
    const meta = this.readJson<PlanMeta>(metaPath);
    if (meta !== null && (typeof meta.coverageWriteAllowed !== "boolean" || (meta.reportId !== null && typeof meta.reportId !== "string"))) {
      throw new StoreCorruptionError(metaPath, "PlanMeta schema mismatch");
    }
    return { plan, meta: meta ?? { coverageWriteAllowed: false, reportId: null } };
  }

  updatePlanStatus(planId: string, status: PlanStatus): void {
    const stored = this.readPlan(planId);
    if (stored === null) throw new Error("STORE_PLAN_NOT_FOUND: " + planId);
    const plan = { ...stored.plan, status };
    assertValidDocument("PatchPlan", plan);
    // A status transition must not republish unchanged metadata after the plan.
    this.writeJson(this.path("plans", requireId(planId, "planId") + ".json"), plan);
  }

  listPlans(): StoredPlan[] {
    const directory = this.path("plans");
    const plans: StoredPlan[] = [];
    for (const file of readdirSync(directory)) {
      if (!file.endsWith(".json") || file.endsWith(".meta.json") || file.endsWith(".nonce.json")) continue;
      const stored = this.readPlan(file.slice(0, -".json".length));
      if (stored !== null) plans.push(stored);
    }
    return plans;
  }

  saveNonce(planId: string, nonce: ApprovalNonce): void {
    this.writeJson(this.path("plans", requireId(planId, "planId") + ".nonce.json"), nonce);
  }

  readNonce(planId: string): ApprovalNonce | null {
    const path = this.path("plans", requireId(planId, "planId") + ".nonce.json");
    const nonce = this.readJson<ApprovalNonce>(path);
    if (nonce !== null && (
      typeof nonce.nonceId !== "string" || !ID_PATTERN.test(nonce.nonceId)
      || typeof nonce.planDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(nonce.planDigest)
      || typeof nonce.createdAt !== "string" || !Number.isFinite(Date.parse(nonce.createdAt))
      || typeof nonce.subjectId !== "string" || nonce.subjectId.trim() === ""
      || (nonce.channel !== "human-cli" && nonce.channel !== "human-ui")
    )) {
      throw new StoreCorruptionError(path, "ApprovalNonce schema mismatch");
    }
    return nonce;
  }

  consumeNonce(planId: string, nonceId: string): boolean {
    const nonce = this.readNonce(planId);
    if (nonce === null || nonce.nonceId !== nonceId) return false;
    rmSync(this.path("plans", requireId(planId, "planId") + ".nonce.json"), { force: true });
    return true;
  }

  writeBackup(changeId: string, beforeText: string, afterText: string, workflowPath: string, now: Date): BackupManifest {
    // Reserve before, after, manifest, and target temp space in one check so a
    // quota failure cannot leave a partially written backup behind.
    this.ensureCapacity(
      Buffer.byteLength(beforeText, "utf8") + Buffer.byteLength(afterText, "utf8") + 2048,
    );
    const directory = this.path("backups", requireId(changeId, "changeId"));
    this.ensureDirectory(directory);
    this.writeText(join(directory, "before.yml"), beforeText);
    this.writeText(join(directory, "after.yml"), afterText);
    const manifest: BackupManifest = {
      changeId,
      workflowPath,
      beforeHash: sha256Text(beforeText),
      afterHash: sha256Text(afterText),
      beforeBytes: Buffer.byteLength(beforeText, "utf8"),
      afterBytes: Buffer.byteLength(afterText, "utf8"),
      createdAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
    this.writeJson(join(directory, "manifest.json"), manifest);
    return manifest;
  }

  readBackup(changeId: string): StoredBackup | null {
    const directory = this.path("backups", requireId(changeId, "changeId"));
    const manifest = this.readJson<BackupManifest>(join(directory, "manifest.json"));
    if (manifest === null) return null;
    const beforePath = join(directory, "before.yml");
    const afterPath = join(directory, "after.yml");
    if (!existsSync(beforePath) || !existsSync(afterPath)) return null;
    return { manifest, beforeText: readFileSync(beforePath, "utf8"), afterText: readFileSync(afterPath, "utf8") };
  }

  saveHistory(bindingId: string, history: HistoryBundle): void {
    this.writeJson(this.path("snapshots", "history", requireId(bindingId, "bindingId") + ".json"), history);
  }

  readLatestHistory(bindingId: string): HistoryBundle | null {
    return this.readJson<HistoryBundle>(this.path("snapshots", "history", requireId(bindingId, "bindingId") + ".json"));
  }

  saveChange(change: AppliedChange): void {
    assertValidDocument("AppliedChange", change);
    this.writeJson(this.path("changes", requireId(change.changeId, "changeId") + ".json"), change);
  }

  readChange(changeId: string): AppliedChange | null {
    return this.readJson<AppliedChange>(this.path("changes", requireId(changeId, "changeId") + ".json"), "AppliedChange");
  }

  listChanges(): AppliedChange[] {
    const directory = this.path("changes");
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.readJson<AppliedChange>(join(directory, name), "AppliedChange"))
      .filter((change): change is AppliedChange => change !== null)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  appendEvent(event: Record<string, unknown>, now: Date): void {
    const line = JSON.stringify({ at: now.toISOString().replace(/\.\d{3}Z$/, "Z"), ...event }) + "\n";
    this.ensureCapacity(Buffer.byteLength(line, "utf8"));
    const path = this.path("events", "events.jsonl");
    this.ensureDirectory(dirname(path));
    writeFileSync(path, line, { encoding: "utf8", flag: "a", mode: 0o600 });
    if (process.platform !== "win32") {
      // The log is appended to, so an older 0644 file is repaired in place.
      try {
        chmodSync(path, 0o600);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "EPERM" && code !== "EACCES" && code !== "ENOENT") throw error;
      }
    }
  }

  /** Auxiliary summaries must not replace an authoritative success or refusal. */
  appendSummaryEvent(event: Record<string, unknown>, now: Date): readonly string[] {
    try {
      this.appendEvent(event, now);
      return [];
    } catch {
      return ["EVENT_LOG_UNAVAILABLE"];
    }
  }

  changeIdFor(planId: string, now: Date): string {
    const digest = digestOf({ planId, at: now.toISOString() }).slice("sha256:".length, "sha256:".length + 16);
    return "c_" + digest;
  }

  prune(now: Date, limits: PruneLimits): PruneResult {
    const reportCutoff = ageCutoff(now, limits.reportDays);
    const planCutoff = ageCutoff(now, limits.planDays);
    const cacheCutoff = ageCutoff(now, limits.cacheDays);
    let removedReports = 0;
    let removedPlans = 0;
    let removedCacheEntries = 0;
    let bytesFreed = 0;

    for (const name of readdirSync(this.path("reports"))) {
      if (!name.endsWith(".json")) continue;
      const full = this.path("reports", name);
      const report = this.readJson<AnalysisReport>(full, "AnalysisReport");
      if (report === null) continue;
      const at = Date.parse(report.generatedAt);
      if (!Number.isFinite(at) || at >= reportCutoff) continue;
      bytesFreed += entryBytes(full);
      rmSync(full, { force: true });
      removedReports += 1;
    }

    for (const stored of this.listPlans()) {
      const createdAt = Date.parse(stored.plan.payload.createdAt);
      if (!Number.isFinite(createdAt) || createdAt >= planCutoff) continue;
      const planId = stored.plan.planId;
      for (const suffix of [".json", ".meta.json", ".nonce.json"]) {
        const full = this.path("plans", requireId(planId, "planId") + suffix);
        bytesFreed += entryBytes(full);
        rmSync(full, { force: true });
      }
      removedPlans += 1;
    }

    const cacheRoot = this.path("cache");
    if (existsSync(cacheRoot)) {
      for (const entry of readdirSync(cacheRoot)) {
        const full = join(cacheRoot, entry);
        let modified = 0;
        try {
          modified = statSync(full).mtimeMs;
        } catch {
          continue;
        }
        if (modified >= cacheCutoff) continue;
        bytesFreed += entryBytes(full);
        rmSync(full, { recursive: true, force: true });
        removedCacheEntries += 1;
      }
    }

    const cacheCap = limits.cacheMaxBytes ?? 0;
    if (cacheCap > 0 && existsSync(cacheRoot)) {
      const entries: { full: string; size: number; modified: number }[] = [];
      for (const entry of readdirSync(cacheRoot)) {
        const full = join(cacheRoot, entry);
        let modified = 0;
        try {
          modified = statSync(full).mtimeMs;
        } catch {
          continue;
        }
        entries.push({ full, size: deepBytes(full), modified });
      }
      let total = entries.reduce((sum, entry) => sum + entry.size, 0);
      entries.sort((a, b) => a.modified - b.modified);
      for (const entry of entries) {
        if (total <= cacheCap) break;
        bytesFreed += entry.size;
        total -= entry.size;
        rmSync(entry.full, { recursive: true, force: true });
        removedCacheEntries += 1;
      }
    }

    return { removedReports, removedPlans, removedCacheEntries, bytesFreed };
  }

  /**
   * Backups whose revert outcome is already settled: applied changes that are
   * still live and changes that were already reverted. Recovery-relevant states
   * are never listed, because their backup is the only way back.
   */
  appliedBackupCandidates(): AppliedBackupCandidate[] {
    const settled = new Set<AppliedChange["state"]>(["APPLIED", "REVERTED"]);
    const candidates: AppliedBackupCandidate[] = [];
    for (const change of this.listChanges()) {
      if (!settled.has(change.state)) continue;
      const directory = this.path("backups", change.changeId);
      if (!existsSync(directory)) continue;
      candidates.push({
        changeId: change.changeId,
        planId: change.planId,
        workflowPath: change.workflowPath,
        state: change.state,
        appliedAt: change.updatedAt,
        bytes: deepBytes(directory),
        backupPath: directory,
      });
    }
    return candidates.sort((a, b) => (a.appliedAt < b.appliedAt ? -1 : 1));
  }

  /**
   * Delete applied backups only for the exact ids a human confirmed. There is
   * no age-based path here: the token binds the listing to the deletion, and a
   * stale token refuses instead of deleting a backup that appeared later.
   */
  pruneAppliedBackups(changeIds: readonly string[], confirmToken: string): AppliedBackupCleanupResult {
    const candidates = this.appliedBackupCandidates();
    const byId = new Map(candidates.map((candidate) => [candidate.changeId, candidate]));
    for (const changeId of changeIds) {
      if (!byId.has(changeId)) throw new Error("STORAGE_BACKUP_NOT_SETTLED: " + changeId);
    }
    if (confirmToken !== appliedBackupConfirmToken(changeIds)) {
      throw new Error("STORAGE_BACKUP_TOKEN_MISMATCH");
    }
    let removedBackups = 0;
    let bytesFreed = 0;
    for (const changeId of changeIds) {
      const candidate = byId.get(changeId);
      if (candidate === undefined) continue;
      rmSync(this.path("backups", requireId(changeId, "changeId")), { recursive: true, force: true });
      removedBackups += 1;
      bytesFreed += candidate.bytes;
    }
    return { removedBackups, bytesFreed };
  }

  /** Current usage together with the configured quota verdict. */
  storageStatus(): StorageStatus {
    const { bytes, files } = this.usage();
    const limit = this.limits?.storeMaxBytes ?? 0;
    const percent = limit > 0 ? Math.min(100, Math.floor((bytes / limit) * 100)) : 0;
    const warning = this.limits !== null && limit > 0 && percent >= this.limits.warningPercent;
    return { bytes, files, limit, percent, warning, blocked: limit > 0 && bytes >= limit };
  }

  /** Refuse a write before it starts when it would cross the store quota. */
  ensureCapacity(additionalBytes: number): void {
    const limit = this.limits?.storeMaxBytes ?? 0;
    if (limit <= 0 || !Number.isFinite(additionalBytes) || additionalBytes <= 0) return;
    const { bytes } = this.usage();
    if (bytes + additionalBytes > limit) throw new StoreQuotaError(bytes, limit, additionalBytes);
  }

  usage(): { bytes: number; files: number } {
    let bytes = 0;
    let files = 0;
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (entry.isFile()) {
          bytes += statSync(full).size;
          files += 1;
        }
      }
    };
    visit(this.root);
    return { bytes, files };
  }
}
