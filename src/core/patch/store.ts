import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AnalysisReport, AppliedChange, Attestation, PatchPlan, PlanStatus, RepositoryBinding } from "../contracts/schema.ts";
import type { HistoryBundle } from "../history/model.ts";
import { assertValidDocument } from "../contracts/validate.ts";
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
}

export interface PruneResult {
  readonly removedReports: number;
  readonly removedPlans: number;
  readonly removedCacheEntries: number;
  readonly bytesFreed: number;
}

const DAY_MS = 86_400_000;

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

export class PatchStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  static open(root: string): PatchStore {
    const store = new PatchStore(root);
    for (const directory of ["bindings", "reports", "plans", "attestations", "backups", "changes", "events", "snapshots/history"]) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    return store;
  }

  private path(...parts: string[]): string {
    return join(this.root, ...parts);
  }

  private writeJson(path: string, value: unknown): void {
    this.writeText(path, JSON.stringify(value, null, 2) + "\n");
  }

  private writeText(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = path + ".tmp-" + process.pid + "-" + Math.random().toString(16).slice(2);
    try {
      writeFileSync(temporary, text, "utf8");
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

  private readJson<T>(path: string): T | null {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  }

  saveBinding(binding: RepositoryBinding): void {
    assertValidDocument("RepositoryBinding", binding);
    this.writeJson(this.path("bindings", requireId(binding.bindingId, "bindingId") + ".json"), binding);
  }

  readBinding(bindingId: string): RepositoryBinding | null {
    return this.readJson<RepositoryBinding>(this.path("bindings", requireId(bindingId, "bindingId") + ".json"));
  }

  saveReport(report: AnalysisReport): void {
    assertValidDocument("AnalysisReport", report);
    this.writeJson(this.path("reports", requireId(report.reportId, "reportId") + ".json"), report);
  }

  /** Find the binding recorded for a workspace root, regardless of how its remote was named at scan time. */
  findBindingByRoot(workspaceRoot: string): RepositoryBinding | null {
    const directory = this.path("bindings");
    const wanted = process.platform === "win32" ? workspaceRoot.toLowerCase() : workspaceRoot;
    for (const file of readdirSync(directory)) {
      if (!file.endsWith(".json")) continue;
      const binding = this.readJson<RepositoryBinding>(join(directory, file));
      if (binding === null) continue;
      const candidate = process.platform === "win32" ? binding.workspaceRoot.toLowerCase() : binding.workspaceRoot;
      if (candidate === wanted) return binding;
    }
    return null;
  }

  readReport(reportId: string): AnalysisReport | null {
    return this.readJson<AnalysisReport>(this.path("reports", requireId(reportId, "reportId") + ".json"));
  }

  latestReport(): AnalysisReport | null {
    const directory = this.path("reports");
    const files = readdirSync(directory).filter((name) => name.endsWith(".json"));
    let latest: AnalysisReport | null = null;
    let latestAt = "";
    for (const file of files) {
      const report = this.readJson<AnalysisReport>(join(directory, file));
      if (report === null) continue;
      if (report.generatedAt > latestAt) {
        latestAt = report.generatedAt;
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
    let latestAt = "";
    for (const file of files) {
      const report = this.readJson<AnalysisReport>(join(directory, file));
      if (report === null || report.bindingId !== bindingId) continue;
      if (report.generatedAt > latestAt) {
        latestAt = report.generatedAt;
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
    return this.readJson<Attestation>(this.path("attestations", requireId(attestationId, "attestationId") + ".json"));
  }

  savePlan(plan: PatchPlan, meta: PlanMeta): void {
    assertValidDocument("PatchPlan", plan);
    this.writeJson(this.path("plans", requireId(plan.planId, "planId") + ".json"), plan);
    this.writeJson(this.path("plans", requireId(plan.planId, "planId") + ".meta.json"), meta);
  }

  readPlan(planId: string): StoredPlan | null {
    const plan = this.readJson<PatchPlan>(this.path("plans", requireId(planId, "planId") + ".json"));
    if (plan === null) return null;
    const meta = this.readJson<PlanMeta>(this.path("plans", requireId(planId, "planId") + ".meta.json"));
    return { plan, meta: meta ?? { coverageWriteAllowed: false, reportId: null } };
  }

  updatePlanStatus(planId: string, status: PlanStatus): void {
    const stored = this.readPlan(planId);
    if (stored === null) throw new Error("STORE_PLAN_NOT_FOUND: " + planId);
    this.savePlan({ ...stored.plan, status }, stored.meta);
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
    return this.readJson<ApprovalNonce>(this.path("plans", requireId(planId, "planId") + ".nonce.json"));
  }

  consumeNonce(planId: string, nonceId: string): boolean {
    const nonce = this.readNonce(planId);
    if (nonce === null || nonce.nonceId !== nonceId) return false;
    rmSync(this.path("plans", requireId(planId, "planId") + ".nonce.json"), { force: true });
    return true;
  }

  writeBackup(changeId: string, beforeText: string, afterText: string, workflowPath: string, now: Date): BackupManifest {
    const directory = this.path("backups", requireId(changeId, "changeId"));
    mkdirSync(directory, { recursive: true });
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
    return this.readJson<AppliedChange>(this.path("changes", requireId(changeId, "changeId") + ".json"));
  }

  listChanges(): AppliedChange[] {
    const directory = this.path("changes");
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.readJson<AppliedChange>(join(directory, name)))
      .filter((change): change is AppliedChange => change !== null)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  appendEvent(event: Record<string, unknown>, now: Date): void {
    const line = JSON.stringify({ at: now.toISOString().replace(/\.\d{3}Z$/, "Z"), ...event }) + "\n";
    const path = this.path("events", "events.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, line, { encoding: "utf8", flag: "a" });
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
      const report = this.readJson<AnalysisReport>(full);
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

    return { removedReports, removedPlans, removedCacheEntries, bytesFreed };
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