import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { AnalysisReport, AppliedChange, Attestation, PatchPlan, PlanStatus, RepositoryBinding } from "../contracts/schema.ts";
import type { HistoryBundle } from "../history/model.ts";
import { assertValidDocument, validationErrors } from "../contracts/validate.ts";
import type { DocumentKind } from "../contracts/validate.ts";
import { digestOf } from "../../shared/cdj1.ts";
import { acquireStoreLock, withStoreWriteLock } from "./locks.ts";
import { STORE_WRITE_LOCK_WAIT_MS } from "../policy/constants.ts";

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

/** Index pointer that lets latestReport read one record instead of every report. */
interface ReportPointer {
  readonly reportId: string;
  readonly generatedAt: string;
  readonly bindingId: string;
}

/** Committed generation of one binding, history window, and report. */
interface SnapshotPointer {
  readonly generationId: string;
  readonly bindingId: string;
  readonly requestedTo: string;
  readonly reportId: string;
  readonly generatedAt: string;
}

interface CurrentSnapshot {
  readonly pointer: SnapshotPointer;
  readonly binding: RepositoryBinding;
  readonly history: HistoryBundle;
  readonly report: AnalysisReport;
  readonly directory: string;
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
  /** Digest of the backup manifest, so a changed backup invalidates an old token. */
  readonly backupHash: string;
}

export interface AppliedBackupCleanupResult {
  readonly removedBackups: number;
  readonly bytesFreed: number;
}

/**
 * Human-confirmation token for deleting applied backups. It binds the exact
 * change ids to their journal state, update time, size, and backup manifest, so
 * a listing becomes stale if anything about a selected backup changes.
 */
export function appliedBackupConfirmToken(candidates: readonly AppliedBackupCandidate[]): string {
  const sorted = candidates
    .map((candidate) => [candidate.changeId, candidate.state, candidate.appliedAt, candidate.bytes, candidate.backupHash].join("|"))
    .sort();
  return createHash("sha256").update(sorted.join("\n"), "utf8").digest("hex").slice(0, 16);
}

const DAY_MS = 86_400_000;
const USAGE_SNAPSHOT_TTL_MS = 1000;

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

/** Digest of a backup manifest, or null when it is missing or unreadable. */
function backupManifestHash(directory: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(join(directory, "manifest.json"))).digest("hex");
  } catch {
    return null;
  }
}

function entryBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function newestBinding(left: RepositoryBinding | null, right: RepositoryBinding | null): RepositoryBinding | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(right.createdAt) > Date.parse(left.createdAt) ? right : left;
}

function newestReport(left: AnalysisReport | null, right: AnalysisReport | null): AnalysisReport | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(right.generatedAt) > Date.parse(left.generatedAt) ? right : left;
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
  /** Cached store size for this instance; adjusted by its own writes and rescanned when old. */
  private usageSnapshot: { bytes: number; files: number; observedAt: number } | null = null;
  /** Depth of the current write lock; quota checks rescan once per acquisition. */
  private writeLockDepth = 0;

  constructor(root: string, limits: StorageLimits | null = null) {
    this.root = root;
    this.limits = limits;
  }

  static open(root: string, limits: StorageLimits | null = null): PatchStore {
    const store = new PatchStore(root, limits);
    store.ensureDirectory(root);
    for (const directory of ["bindings", "reports", "index", "plans", "attestations", "backups", "changes", "events", "snapshots", "snapshots/history", "snapshots/current", "snapshots/generations", "locks"]) {
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
        // Filesystems without POSIX modes (a mounted share, a FAT volume) cannot honor 0700; the store still works.
        const code = (error as { code?: string }).code;
        if (code !== "EPERM" && code !== "EACCES" && code !== "ENOENT" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
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
    this.withWriteLock(() => this.writeTextUnlocked(path, text));
  }

  /**
   * Every mutation holds the store write lock. A usage snapshot can predate
   * another process's write, so the lock entry discards it; the first quota
   * check inside the lock rescans, and later checks reuse the adjusted total.
   */
  private withWriteLock<T>(run: () => T): T {
    this.writeLockDepth += 1;
    if (this.writeLockDepth === 1) this.invalidateUsage();
    try {
      return withStoreWriteLock(this, run);
    } finally {
      this.writeLockDepth -= 1;
    }
  }

  private writeJsonUnlocked(path: string, value: unknown): void {
    this.writeTextUnlocked(path, JSON.stringify(value, null, 2) + "\n");
  }

  private writeTextUnlocked(path: string, text: string): void {
    const newBytes = Buffer.byteLength(text, "utf8");
    const existed = existsSync(path);
    const previousBytes = existed ? entryBytes(path) : 0;
    this.ensureCapacity(newBytes);
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
      // The rename landed: book the exact delta. A failure above changes nothing.
      this.adjustUsage(newBytes - previousBytes, existed ? 0 : 1);
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
    const id = requireId(bindingId, "bindingId");
    const legacy = this.readJson<RepositoryBinding>(this.path("bindings", id + ".json"), "RepositoryBinding");
    const snapshot = this.readCurrentSnapshot(id);
    return snapshot === null ? legacy : newestBinding(legacy, snapshot.binding);
  }

  saveReport(report: AnalysisReport): void {
    assertValidDocument("AnalysisReport", report);
    this.writeJson(this.path("reports", requireId(report.reportId, "reportId") + ".json"), report);
    this.saveReportPointers(report);
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
    for (const snapshot of this.currentSnapshots()) {
      const binding = snapshot.binding;
      const candidate = process.platform === "win32" ? binding.workspaceRoot.toLowerCase() : binding.workspaceRoot;
      if (candidate !== wanted) continue;
      const merged = newestBinding(latest, binding);
      if (merged !== latest) {
        latest = merged;
        latestAt = Date.parse(binding.createdAt);
      }
    }
    return latest;
  }

  readReport(reportId: string): AnalysisReport | null {
    const id = requireId(reportId, "reportId");
    const direct = this.readJson<AnalysisReport>(this.path("reports", id + ".json"), "AnalysisReport");
    if (direct !== null) return direct;
    // A generation keeps its report after it stops being current, so a stored
    // report id stays addressable until prune removes that generation.
    return this.generationReport(id);
  }

  latestReport(): AnalysisReport | null {
    const snapshotLatest = this.latestSnapshotReport(null);
    const pointer = this.readReportPointer(this.latestReportPointer());
    const pointerReport = pointer === null ? null : this.readReportPointerReport(pointer, null);
    if (pointerReport !== null) {
      // The index is authoritative while it agrees with its record; comparing it
      // with the current generation avoids rescanning every stored report.
      return newestReport(snapshotLatest, pointerReport);
    }
    const scanned = this.scanLatestReport(null);
    const latest = newestReport(snapshotLatest, scanned);
    if (latest === null || latest === snapshotLatest) return latest;
    this.saveReportPointers(latest, this.latestReportPointer());
    return latest;
  }

  /** Latest report produced for one binding, never another repository's report. */
  latestReportForBinding(bindingId: string): AnalysisReport | null {
    const snapshotReport = this.latestSnapshotReport(bindingId);
    let pointerReport: AnalysisReport | null = null;
    // A binding id is a file name here, so only pattern-safe ids get a pointer;
    // other schema-valid ids still work through the scan below.
    if (ID_PATTERN.test(bindingId)) {
      const pointer = this.readReportPointer(this.latestReportPointerFor(bindingId));
      if (pointer !== null && pointer.bindingId === bindingId) {
        pointerReport = this.readReportPointerReport(pointer, bindingId);
      }
    }
    if (pointerReport !== null) return newestReport(snapshotReport, pointerReport);
    const scanned = this.scanLatestReport(bindingId);
    const latest = newestReport(snapshotReport, scanned);
    if (latest === null || latest === snapshotReport) return latest;
    this.saveReportPointers(latest, ID_PATTERN.test(bindingId) ? this.latestReportPointerFor(bindingId) : undefined);
    return latest;
  }

  private snapshotPointerPath(bindingId: string): string {
    return this.path("snapshots", "current", requireId(bindingId, "bindingId") + ".json");
  }

  private snapshotDirectory(bindingId: string, generationId: string): string {
    return this.path("snapshots", "generations", requireId(bindingId, "bindingId"), requireId(generationId, "generationId"));
  }

  /** A corrupt or half-written pointer is a cache miss; the legacy files still answer. */
  private readSnapshotPointer(bindingId: string): SnapshotPointer | null {
    let text: string;
    try {
      text = readFileSync(this.snapshotPointerPath(bindingId), "utf8");
    } catch {
      return null;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.generationId !== "string" || !ID_PATTERN.test(record.generationId)) return null;
    if (record.bindingId !== bindingId) return null;
    if (typeof record.requestedTo !== "string" || !Number.isFinite(Date.parse(record.requestedTo))) return null;
    if (typeof record.reportId !== "string" || !ID_PATTERN.test(record.reportId)) return null;
    if (typeof record.generatedAt !== "string" || !Number.isFinite(Date.parse(record.generatedAt))) return null;
    return {
      generationId: record.generationId,
      bindingId,
      requestedTo: record.requestedTo,
      reportId: record.reportId,
      generatedAt: record.generatedAt,
    };
  }

  /**
   * Resolve the committed generation. A concurrent save can switch the pointer
   * and delete the old generation between the pointer read and the file reads,
   * so a vanished generation is retried once against the new pointer.
   */
  private readCurrentSnapshot(bindingId: string): CurrentSnapshot | null {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pointer = this.readSnapshotPointer(bindingId);
      if (pointer === null) return null;
      const directory = this.snapshotDirectory(bindingId, pointer.generationId);
      const binding = this.readJson<RepositoryBinding>(join(directory, "binding.json"), "RepositoryBinding");
      const history = this.readJson<HistoryBundle>(join(directory, "history.json"));
      const report = this.readJson<AnalysisReport>(join(directory, "report.json"), "AnalysisReport");
      if (
        binding !== null && history !== null && report !== null
        && binding.bindingId === pointer.bindingId
        && history.requestedTo === pointer.requestedTo
        && report.reportId === pointer.reportId
        && report.bindingId === pointer.bindingId
        && report.generatedAt === pointer.generatedAt
      ) {
        return { pointer, binding, history, report, directory };
      }
    }
    return null;
  }

  private currentSnapshots(): CurrentSnapshot[] {
    let names: string[];
    try {
      names = readdirSync(this.path("snapshots", "current"));
    } catch {
      return [];
    }
    const snapshots: CurrentSnapshot[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const bindingId = name.slice(0, -".json".length);
      if (!ID_PATTERN.test(bindingId)) continue;
      const snapshot = this.readCurrentSnapshot(bindingId);
      if (snapshot !== null) snapshots.push(snapshot);
    }
    return snapshots;
  }

  /** Snapshot pointers newest first; loading only the newest avoids reading every generation. */
  private snapshotPointers(bindingId: string | null): SnapshotPointer[] {
    let names: string[];
    try {
      names = readdirSync(this.path("snapshots", "current"));
    } catch {
      return [];
    }
    const pointers: SnapshotPointer[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (!ID_PATTERN.test(id) || (bindingId !== null && id !== bindingId)) continue;
      const pointer = this.readSnapshotPointer(id);
      if (pointer !== null) pointers.push(pointer);
    }
    return pointers.sort((left, right) => Date.parse(right.generatedAt) - Date.parse(left.generatedAt));
  }

  private latestSnapshotReport(bindingId: string | null): AnalysisReport | null {
    for (const pointer of this.snapshotPointers(bindingId)) {
      const snapshot = this.readCurrentSnapshot(pointer.bindingId);
      if (snapshot === null) continue;
      if (bindingId !== null && snapshot.report.bindingId !== bindingId) continue;
      return snapshot.report;
    }
    return null;
  }

  private generationReport(reportId: string): AnalysisReport | null {
    const root = this.path("snapshots", "generations");
    let bindings;
    try {
      bindings = readdirSync(root, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const binding of bindings) {
      if (!binding.isDirectory() || !ID_PATTERN.test(binding.name)) continue;
      let generations;
      try {
        generations = readdirSync(join(root, binding.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const generation of generations) {
        if (!generation.isDirectory() || !ID_PATTERN.test(generation.name)) continue;
        const report = this.readJson<AnalysisReport>(join(root, binding.name, generation.name, "report.json"), "AnalysisReport");
        if (report !== null && report.reportId === reportId) return report;
      }
    }
    return null;
  }

  /**
   * Apply report retention to committed generations. A generation stores its
   * report beside the binding and history, so an expired generation is removed
   * as a unit; when it is current, its pointer goes with it.
   */
  private pruneExpiredSnapshots(reportCutoff: number): { removedReports: number; bytesFreed: number } {
    const root = this.path("snapshots", "generations");
    let bindings;
    try {
      bindings = readdirSync(root, { withFileTypes: true });
    } catch {
      return { removedReports: 0, bytesFreed: 0 };
    }
    let removedReports = 0;
    let bytesFreed = 0;
    for (const binding of bindings) {
      if (!binding.isDirectory() || !ID_PATTERN.test(binding.name)) continue;
      const pointer = this.readSnapshotPointer(binding.name);
      let generations;
      try {
        generations = readdirSync(join(root, binding.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const generation of generations) {
        if (!generation.isDirectory() || !ID_PATTERN.test(generation.name)) continue;
        const directory = join(root, binding.name, generation.name);
        const report = this.readJson<AnalysisReport>(join(directory, "report.json"), "AnalysisReport");
        if (report === null) continue;
        const at = Date.parse(report.generatedAt);
        if (!Number.isFinite(at) || at >= reportCutoff) continue;
        bytesFreed += deepBytes(directory);
        rmSync(directory, { recursive: true, force: true });
        removedReports += 1;
        if (pointer !== null && pointer.generationId === generation.name) {
          rmSync(this.snapshotPointerPath(binding.name), { force: true });
        }
      }
    }
    return { removedReports, bytesFreed };
  }

  /** Keep the committed generation and one predecessor; readers retry the pointer. */
  private pruneSnapshots(bindingId: string): void {
    try {
      const directory = this.path("snapshots", "generations", requireId(bindingId, "bindingId"));
      const entries = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name, modified: statSync(join(directory, entry.name)).mtimeMs }))
        .sort((a, b) => b.modified - a.modified);
      // Never prune the generation the pointer names, even when three saves
      // share one mtime; keep it plus the newest predecessor.
      const keep = new Set<string>();
      const current = this.readSnapshotPointer(bindingId)?.generationId;
      if (current !== undefined) keep.add(current);
      for (const entry of entries) {
        if (keep.size >= 2) break;
        keep.add(entry.name);
      }
      for (const entry of entries) {
        if (!keep.has(entry.name)) rmSync(join(directory, entry.name), { recursive: true, force: true });
      }
      if (entries.some((entry) => !keep.has(entry.name))) this.invalidateUsage();
    } catch {
      // Cleanup is best effort; an unreferenced generation only costs space.
    }
  }

  /**
   * A pointer is only a cache hint. It must agree with the record it names on
   * both the generation and the binding, otherwise a corrupted or overwritten
   * pointer could answer with a report that is no longer the latest.
   */
  private readReportPointerReport(pointer: ReportPointer, bindingId: string | null): AnalysisReport | null {
    const report = this.readReport(pointer.reportId);
    if (report === null) return null;
    if (report.generatedAt !== pointer.generatedAt) return null;
    if (report.bindingId !== pointer.bindingId) return null;
    if (bindingId !== null && report.bindingId !== bindingId) return null;
    return report;
  }

  private scanLatestReport(bindingId: string | null): AnalysisReport | null {
    const directory = this.path("reports");
    const files = readdirSync(directory).filter((name) => name.endsWith(".json"));
    let latest: AnalysisReport | null = null;
    let latestAt = Number.NEGATIVE_INFINITY;
    for (const file of files) {
      const report = this.readJson<AnalysisReport>(join(directory, file), "AnalysisReport");
      if (report === null) continue;
      if (bindingId !== null && report.bindingId !== bindingId) continue;
      const at = Date.parse(report.generatedAt);
      if (at > latestAt) {
        latestAt = at;
        latest = report;
      }
    }
    return latest;
  }

  private latestReportPointer(): string {
    return this.path("index", "latest-report.json");
  }

  private latestReportPointerFor(bindingId: string): string {
    return this.path("index", "latest-report-" + requireId(bindingId, "bindingId") + ".json");
  }

  private reportPointerPaths(report: AnalysisReport): string[] {
    const paths = [this.latestReportPointer()];
    if (ID_PATTERN.test(report.bindingId)) paths.push(this.latestReportPointerFor(report.bindingId));
    return paths;
  }

  /** A malformed or missing pointer is simply a cache miss; the scan is authoritative. */
  private readReportPointer(path: string): ReportPointer | null {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return null;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.reportId !== "string" || !ID_PATTERN.test(record.reportId)) return null;
    if (typeof record.generatedAt !== "string" || !Number.isFinite(Date.parse(record.generatedAt))) return null;
    if (typeof record.bindingId !== "string" || record.bindingId.length === 0) return null;
    return { reportId: record.reportId, generatedAt: record.generatedAt, bindingId: record.bindingId };
  }

  private writeReportPointersUnlocked(report: AnalysisReport, repairPath?: string): void {
    const record: ReportPointer = { reportId: report.reportId, generatedAt: report.generatedAt, bindingId: report.bindingId };
    for (const path of this.reportPointerPaths(report)) {
      if (path !== repairPath) {
        const current = this.readReportPointer(path);
        // Newest wins even when an older report is saved last (out-of-order sync).
        if (current !== null && Date.parse(current.generatedAt) > Date.parse(record.generatedAt)) continue;
      }
      this.writeJsonUnlocked(path, record);
    }
  }

  /** Best effort: a pointer write failure must not fail the report it describes. */
  private saveReportPointers(report: AnalysisReport, repairPath?: string): void {
    try {
      this.withWriteLock(() => this.writeReportPointersUnlocked(report, repairPath));
    } catch {
      this.discardReportPointers(report);
    }
  }

  private discardReportPointers(report: AnalysisReport): void {
    for (const path of this.reportPointerPaths(report)) {
      try {
        rmSync(path, { force: true });
      } catch {
        // The index is a cache; a failed cleanup just leaves the scan fallback.
      }
    }
    this.invalidateUsage();
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

  /**
   * Compare-and-set a plan status. Approval is already serialized per plan, but
   * a prune or a second writer can still replace the record between the read
   * and this write; the expected revision turns that into a refusal instead of
   * silently resurrecting a deleted plan or overwriting a newer status.
   */
  updatePlanStatus(planId: string, status: PlanStatus, expectedRevision?: number): void {
    const stored = this.readPlan(planId);
    if (stored === null) throw new Error("STORE_PLAN_NOT_FOUND: " + planId);
    if (expectedRevision !== undefined && stored.plan.status.revision !== expectedRevision) {
      throw new Error("PLAN_STATUS_CONFLICT: expected revision " + expectedRevision + ", found " + stored.plan.status.revision);
    }
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
    this.invalidateUsage();
    return true;
  }

  writeBackup(changeId: string, beforeText: string, afterText: string, workflowPath: string, now: Date): BackupManifest {
    // One lock covers the reservation and all three files, so a concurrent
    // writer cannot pass the quota check with the same free bytes.
    return this.withWriteLock(() => {
      // Reserve before, after, manifest, and target temp space in one check so a
      // quota failure cannot leave a partially written backup behind.
      this.ensureCapacity(
        Buffer.byteLength(beforeText, "utf8") + Buffer.byteLength(afterText, "utf8") + 2048,
      );
      const directory = this.path("backups", requireId(changeId, "changeId"));
      const existed = existsSync(directory);
      try {
        this.ensureDirectory(directory);
        this.writeTextUnlocked(join(directory, "before.yml"), beforeText);
        this.writeTextUnlocked(join(directory, "after.yml"), afterText);
        const manifest: BackupManifest = {
          changeId,
          workflowPath,
          beforeHash: sha256Text(beforeText),
          afterHash: sha256Text(afterText),
          beforeBytes: Buffer.byteLength(beforeText, "utf8"),
          afterBytes: Buffer.byteLength(afterText, "utf8"),
          createdAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
        };
        this.writeJsonUnlocked(join(directory, "manifest.json"), manifest);
        return manifest;
      } catch (error) {
        // Only remove a directory this call created: a pre-existing backup may be
        // the only copy of the user's bytes.
        if (!existed) {
          rmSync(directory, { recursive: true, force: true });
          this.invalidateUsage();
        }
        throw error;
      }
    });
  }

  /** Removes a backup that no journal record can reference. */
  removeBackup(changeId: string): void {
    rmSync(this.path("backups", requireId(changeId, "changeId")), { recursive: true, force: true });
    this.invalidateUsage();
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

  /**
   * Save a history snapshot only when it is at least as new as the stored one.
   * Two syncs can overlap; finishing last must not replace a newer window with
   * an older one and silently shrink what later rules can see. Equal windows
   * still replace, so a retry can complete a partial collection.
   */
  saveHistory(bindingId: string, history: HistoryBundle): boolean {
    return this.withWriteLock(() => {
      const current = this.readLatestHistory(bindingId);
      if (current !== null && Date.parse(current.requestedTo) > Date.parse(history.requestedTo)) return false;
      this.writeJsonUnlocked(this.path("snapshots", "history", requireId(bindingId, "bindingId") + ".json"), history);
      return true;
    });
  }

  /**
   * Persist a binding, its history window, and the report as one generation.
   * The three records are written into a new directory, and only after all of
   * them are durable does the current-snapshot pointer switch to it. A quota or
   * I/O failure removes the whole generation and leaves the previous pointer,
   * so readers never observe a binding or history whose report is missing.
   * Returns false without writing anything when the stored window is newer.
   */
  saveHistorySnapshot(binding: RepositoryBinding, history: HistoryBundle, report: AnalysisReport): boolean {
    assertValidDocument("RepositoryBinding", binding);
    assertValidDocument("AnalysisReport", report);
    return this.withWriteLock(() => {
      const bindingId = requireId(binding.bindingId, "bindingId");
      const current = this.readLatestHistory(bindingId);
      if (current !== null && Date.parse(current.requestedTo) > Date.parse(history.requestedTo)) return false;
      const generationId = "g_" + randomUUID().replaceAll("-", "");
      const directory = this.snapshotDirectory(bindingId, generationId);
      try {
        this.ensureDirectory(directory);
        this.writeJsonUnlocked(join(directory, "binding.json"), binding);
        this.writeJsonUnlocked(join(directory, "history.json"), history);
        this.writeJsonUnlocked(join(directory, "report.json"), report);
        const pointer: SnapshotPointer = {
          generationId,
          bindingId,
          requestedTo: history.requestedTo,
          reportId: report.reportId,
          generatedAt: report.generatedAt,
        };
        this.writeJsonUnlocked(this.snapshotPointerPath(bindingId), pointer);
      } catch (error) {
        rmSync(directory, { recursive: true, force: true });
        this.invalidateUsage();
        throw error;
      }
      this.pruneSnapshots(bindingId);
      return true;
    });
  }

  readLatestHistory(bindingId: string): HistoryBundle | null {
    const id = requireId(bindingId, "bindingId");
    const snapshot = this.readCurrentSnapshot(id);
    const legacy = this.readJson<HistoryBundle>(this.path("snapshots", "history", id + ".json"));
    if (snapshot === null) return legacy;
    if (legacy === null) return snapshot.history;
    return Date.parse(legacy.requestedTo) > Date.parse(snapshot.history.requestedTo) ? legacy : snapshot.history;
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
    // Reserve and append under the same lock; otherwise two processes can pass
    // the quota check and both append past the limit.
    this.withWriteLock(() => {
      const line = JSON.stringify({ at: now.toISOString().replace(/\.\d{3}Z$/, "Z"), ...event }) + "\n";
      const lineBytes = Buffer.byteLength(line, "utf8");
      this.ensureCapacity(lineBytes);
      const path = this.path("events", "events.jsonl");
      const existed = existsSync(path);
      this.ensureDirectory(dirname(path));
      writeFileSync(path, line, { encoding: "utf8", flag: "a", mode: 0o600 });
      this.adjustUsage(lineBytes, existed ? 0 : 1);
      if (process.platform !== "win32") {
        // The log is appended to, so an older 0644 file is repaired in place.
        try {
          chmodSync(path, 0o600);
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code !== "EPERM" && code !== "EACCES" && code !== "ENOENT" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
        }
      }
    });
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

    // Generations are also reports; prune them under the write lock so a
    // concurrent sync cannot switch the pointer to a generation being removed.
    const generations = this.withWriteLock(() => this.pruneExpiredSnapshots(reportCutoff));
    removedReports += generations.removedReports;
    bytesFreed += generations.bytesFreed;

    for (const stored of this.listPlans()) {
      const createdAt = Date.parse(stored.plan.payload.createdAt);
      if (!Number.isFinite(createdAt) || createdAt >= planCutoff) continue;
      const planId = stored.plan.planId;
      // An approval holds this claim from its first read through the status
      // write. Skip rather than delete a plan out from under it; the next prune
      // removes it once the approval has finished.
      let lock;
      try {
        lock = acquireStoreLock(this, "approve-" + planId, 0);
      } catch {
        continue;
      }
      try {
        if (this.readPlan(planId) === null) continue;
        for (const suffix of [".json", ".meta.json", ".nonce.json"]) {
          const full = this.path("plans", requireId(planId, "planId") + suffix);
          bytesFreed += entryBytes(full);
          rmSync(full, { force: true });
        }
      } finally {
        lock.release();
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

    this.invalidateUsage();
    return { removedReports, removedPlans, removedCacheEntries, bytesFreed };
  }

  /**
   * Backups whose revert outcome is already settled: applied changes that are
   * still live and changes that were already reverted. Recovery-relevant states
   * are never listed, because their backup is the only way back.
   */
  appliedBackupCandidates(): AppliedBackupCandidate[] {
    return this.withMaintenance(() => this.appliedBackupCandidatesUnlocked());
  }

  private appliedBackupCandidatesUnlocked(): AppliedBackupCandidate[] {
    const settled = new Set<AppliedChange["state"]>(["APPLIED", "REVERTED"]);
    const candidates: AppliedBackupCandidate[] = [];
    for (const change of this.listChanges()) {
      if (!settled.has(change.state)) continue;
      const directory = this.path("backups", change.changeId);
      if (!existsSync(directory)) continue;
      const backupHash = backupManifestHash(directory);
      // A backup without a readable manifest cannot be verified or safely
      // deleted on confirmation; leave it for the recovery path.
      if (backupHash === null) continue;
      candidates.push({
        changeId: change.changeId,
        planId: change.planId,
        workflowPath: change.workflowPath,
        state: change.state,
        appliedAt: change.updatedAt,
        bytes: deepBytes(directory),
        backupPath: directory,
        backupHash,
      });
    }
    return candidates.sort((a, b) => (a.appliedAt < b.appliedAt ? -1 : 1));
  }

  /**
   * Delete applied backups only for the exact ids a human confirmed. There is
   * no age-based path here: the token binds the listing to the deletion, and a
   * stale token refuses instead of deleting a backup that appeared later.
   *
   * The listing, revalidation, and deletion all run under one maintenance lock,
   * so a revert cannot read a backup that prune deletes between its read and
   * the restore.
   */
  pruneAppliedBackups(changeIds: readonly string[], confirmToken: string): AppliedBackupCleanupResult {
    return this.withMaintenance(() => {
      const candidates = this.appliedBackupCandidatesUnlocked();
      const byId = new Map(candidates.map((candidate) => [candidate.changeId, candidate]));
      const selected: AppliedBackupCandidate[] = [];
      for (const changeId of changeIds) {
        const candidate = byId.get(changeId);
        if (candidate === undefined) throw new Error("STORAGE_BACKUP_NOT_SETTLED: " + changeId);
        selected.push(candidate);
      }
      if (confirmToken !== appliedBackupConfirmToken(selected)) {
        throw new Error("STORAGE_BACKUP_TOKEN_MISMATCH");
      }
      let removedBackups = 0;
      let bytesFreed = 0;
      for (const candidate of selected) {
        rmSync(this.path("backups", requireId(candidate.changeId, "changeId")), { recursive: true, force: true });
        removedBackups += 1;
        bytesFreed += candidate.bytes;
      }
      this.invalidateUsage();
      return { removedBackups, bytesFreed };
    });
  }

  private withMaintenance<T>(run: () => T): T {
    const lock = acquireStoreLock(this, "maintenance", STORE_WRITE_LOCK_WAIT_MS);
    try {
      return run();
    } finally {
      lock.release();
    }
  }

  /** Current usage together with the configured quota verdict. */
  storageStatus(): StorageStatus {
    const { bytes, files } = this.usage();
    const limit = this.limits?.storeMaxBytes ?? 0;
    const percent = limit > 0 ? Math.min(100, Math.floor((bytes / limit) * 100)) : 0;
    const warning = this.limits !== null && limit > 0 && percent >= this.limits.warningPercent;
    return { bytes, files, limit, percent, warning, blocked: limit > 0 && bytes >= limit };
  }

  /**
   * Refuse a write before it starts when it would cross the store quota.
   * Admission never trusts the display cache: outside a write lock it scans,
   * and inside one the entry scan plus this instance's landed writes are exact
   * because every cooperating process serializes on the same lock.
   */
  ensureCapacity(additionalBytes: number): void {
    const limit = this.limits?.storeMaxBytes ?? 0;
    if (limit <= 0 || !Number.isFinite(additionalBytes) || additionalBytes <= 0) return;
    const { bytes } = this.writeLockDepth > 0 ? this.usage() : this.usageFresh();
    if (bytes + additionalBytes > limit) throw new StoreQuotaError(bytes, limit, additionalBytes);
  }

  private usageFresh(): { bytes: number; files: number } {
    const scanned = this.scanUsage();
    this.usageSnapshot = { bytes: scanned.bytes, files: scanned.files, observedAt: Date.now() };
    return scanned;
  }

  /**
   * Store size for quota decisions. A full scan is O(files), so this instance
   * keeps a snapshot adjusted by its own successful writes and deletes, and
   * rescans when it has none or the snapshot is older than one second. The
   * snapshot therefore cannot see another process's changes for up to
   * USAGE_SNAPSHOT_TTL_MS; ensureCapacity re-reads at that bound.
   * Files in the top-level locks directory are transient claim/log state and
   * are excluded, because a scan can run while this or another process holds
   * the write claim (otherwise the token would be counted and never removed).
   */
  usage(): { bytes: number; files: number } {
    const snapshot = this.usageSnapshot;
    if (snapshot !== null && Date.now() - snapshot.observedAt <= USAGE_SNAPSHOT_TTL_MS) {
      return { bytes: snapshot.bytes, files: snapshot.files };
    }
    const scanned = this.scanUsage();
    this.usageSnapshot = { bytes: scanned.bytes, files: scanned.files, observedAt: Date.now() };
    return scanned;
  }

  private scanUsage(): { bytes: number; files: number } {
    let bytes = 0;
    let files = 0;
    const visit = (directory: string, topLevel: boolean): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (topLevel && entry.isDirectory() && entry.name === "locks") continue;
        const full = join(directory, entry.name);
        if (entry.isDirectory()) visit(full, false);
        else if (entry.isFile()) {
          bytes += statSync(full).size;
          files += 1;
        }
      }
    };
    visit(this.root, true);
    return { bytes, files };
  }

  /** Book a write or delete that already landed; failure paths must not call this. */
  private adjustUsage(bytesDelta: number, filesDelta: number): void {
    const snapshot = this.usageSnapshot;
    if (snapshot === null) return;
    snapshot.bytes = Math.max(0, snapshot.bytes + bytesDelta);
    snapshot.files = Math.max(0, snapshot.files + filesDelta);
  }

  private invalidateUsage(): void {
    this.usageSnapshot = null;
  }
}
