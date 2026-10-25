import { collectChangeEffect } from "../../adapters/github/change-effect.ts";
import { withDeadline } from "../../core/support/deadline.ts";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { EngineSettings } from "../../core/config/plugin-settings.ts";
import type { RepositoryBinding } from "../../core/contracts/schema.ts";
import { PatchStore, type StoredPlan } from "../../core/patch/store.ts";
import { approvePlan } from "../../core/patch/approval.ts";
import { applyPlan, resolveWorkflowFile, revertChange } from "../../core/patch/apply.ts";
import { renderEditDiff } from "../../core/patch/diff.ts";
import { sourceHashOf } from "../../core/patch/plan.ts";
import { defaultStateDir } from "../../core/state/paths.ts";
import { localizedFinding } from "../../core/report/localize.ts";
import { resolveRequestedLocale } from "../../shared/i18n/host.ts";

/** This transport belongs to the browser owner, never the model tool registry. */
export const REVIEW_CHANNEL = "/api";
export const REVIEW_ENDPOINT = "ci-diet-review";
interface ReviewSettings { readonly engine: EngineSettings; readonly localApplyEnabled: boolean }
interface ReviewRequest { action: "load" | "approve" | "apply" | "revert" | "measure"; sessionId: string; id?: string; confirmation?: string; beforeRuns?: number[]; afterRuns?: number[] }
interface WorkflowSource { readonly text: string; readonly hash: string }

/** Share bytes and hashes only within one request; mutations always reread. */
function workflowSourceReader(binding: RepositoryBinding, maxBytes: number) {
  const sources = new Map<string, WorkflowSource | null>();
  return (path: string): WorkflowSource | null => {
    const cached = sources.get(path);
    if (cached !== undefined) return cached;
    let source: WorkflowSource | null = null;
    try {
      const file = resolveWorkflowFile(binding, path);
      if (maxBytes > 0 && statSync(file).size > maxBytes) throw new Error("WORKFLOW_TOO_LARGE");
      const text = readFileSync(file, "utf8");
      source = { text, hash: sourceHashOf(text) };
    } catch {
      // Unavailable and oversized sources remain blocked for every plan.
    }
    sources.set(path, source);
    return source;
  };
}

function requestOf(value: unknown): ReviewRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_REQUEST");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["action", "sessionId", "id", "confirmation", "beforeRuns", "afterRuns"].includes(key))) throw new Error("INVALID_REQUEST");
  if (!["load", "approve", "apply", "revert", "measure"].includes(String(record.action))
    || typeof record.sessionId !== "string" || record.sessionId.length === 0 || record.sessionId.length > 256
    || (record.id !== undefined && (typeof record.id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(record.id)))
    || (record.confirmation !== undefined && (typeof record.confirmation !== "string" || record.confirmation.length > 200))) throw new Error("INVALID_REQUEST");
  if (record.action !== "load" && typeof record.id !== "string") throw new Error("INVALID_REQUEST");
  if (record.action === "measure" && ![record.beforeRuns, record.afterRuns].every((ids) => Array.isArray(ids)
    && ids.length >= 1 && ids.length <= 10 && ids.every((id) => Number.isSafeInteger(id) && id > 0))) throw new Error("INVALID_RUN_SELECTION");
  return record as unknown as ReviewRequest;
}

export class ReviewService {
  private readonly rootForSession: (id: string) => string;
  private readonly settings: () => ReviewSettings;
  private readonly collect: typeof collectChangeEffect;
  constructor(rootForSession: (id: string) => string, settings: () => ReviewSettings, collect: typeof collectChangeEffect = collectChangeEffect) {
    this.rootForSession = rootForSession;
    this.settings = settings;
    this.collect = collect;
  }

  private preview(store: PatchStore, stored: StoredPlan, settings: ReviewSettings, now: Date, readSource: ReturnType<typeof workflowSourceReader>, usedPlans?: ReadonlySet<string>) {
    // Reuse the validated plan and metadata read together by this request.
    const { plan, meta } = stored;
    const blockers = [...plan.payload.blockers];
    let sourceValid = false;
    let diff: ReturnType<typeof renderEditDiff> = [];
    try {
      const source = readSource(plan.payload.workflowPath);
      if (source === null) throw new Error("SOURCE_UNAVAILABLE");
      sourceValid = source.hash === plan.payload.sourceHash;
      if (sourceValid) diff = renderEditDiff(source.text, plan.payload.edits);
      else blockers.push("SOURCE_HASH_MISMATCH");
    } catch {
      blockers.push("SOURCE_UNAVAILABLE");
    }
    if (now.getTime() >= Date.parse(plan.payload.expiresAt)) blockers.push("PLAN_EXPIRED");
    if (!meta.coverageWriteAllowed) blockers.push("COVERAGE_INSUFFICIENT_FOR_WRITE");
    if (plan.provenance !== "observed") blockers.push("SYNTHETIC_PLAN");
    if (plan.payload.ruleIds.some((id) => !settings.engine.config.apply.allowedRules.includes(id))) blockers.push("RULE_NOT_ALLOWED");
    if ((usedPlans ?? new Set(store.listChanges().filter((change) => change.state !== "NOT_APPLIED").map((change) => change.planId))).has(plan.planId)) blockers.push("PLAN_ALREADY_USED");
    const nonce = plan.status.state === "approved" ? store.readNonce(plan.planId) : null;
    const approvalExpiresAt = nonce === null ? null : new Date(Date.parse(nonce.createdAt)
      + settings.engine.config.apply.approvalTtlSeconds * 1000).toISOString();
    return { approvalExpiresAt, id: plan.planId, digest: plan.planDigest, workflowPath: plan.payload.workflowPath,
      ruleId: plan.payload.ruleIds.join(", "), state: plan.status.state, expiresAt: plan.payload.expiresAt,
      sourceValid, blockers: [...new Set(blockers)], diff };
  }

  async execute(value: unknown, subjectId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const request = requestOf(value);
    // Resolve on the Host. Neither cwd nor a caller-provided binding can escape
    // the selected live Session's effective working directory.
    const root = realpathSync(this.rootForSession(request.sessionId));
    const settings = this.settings();
    const stateDir = settings.engine.stateDir || defaultStateDir();
    // No mkdir, chmod or index repair during read-only rendering.
    const reader = new PatchStore(stateDir, settings.engine.config.storage);
    const binding = existsSync(join(stateDir, "bindings")) ? reader.findBindingByRoot(root) : null;
    if (request.action === "load") {
      const report = binding === null ? null : reader.latestReportForBinding(binding.bindingId, false);
      const locale = resolveRequestedLocale(null, process.env);
      const changes = binding === null ? [] : reader.listChanges().filter((change) => change.bindingId === binding.bindingId);
      const usedPlans = new Set(changes.filter((change) => change.state !== "NOT_APPLIED").map((change) => change.planId));
      const readSource = binding === null ? null : workflowSourceReader(binding, settings.engine.config.storage.workflowMaxBytes);
      return { root, bindingId: binding?.bindingId ?? null, localApplyEnabled: settings.localApplyEnabled, networkEnabled: settings.engine.networkEnabled,
        report: report === null ? null : { ...report, findings: report.findings.map((finding) => {
          const localized = localizedFinding(finding, locale);
          return { ...finding, title: localized.title, renderedText: localized.text };
        }) },
        plans: binding === null ? [] : reader.listPlans().filter(({ plan }) => plan.payload.bindingId === binding.bindingId)
          .map((stored) => this.preview(reader, stored, settings, new Date(), readSource!, usedPlans)),
        changes: changes
          .map(({ changeId, workflowPath, state }) => ({ changeId, workflowPath, state, measurement: reader.readMeasurement(changeId) })) };
    }
    if (request.action === "measure") {
      if (!settings.engine.networkEnabled) throw new Error("NETWORK_DISABLED");
      if (binding === null) throw new Error("BINDING_NOT_FOUND");
      const change = reader.readChange(request.id!);
      if (change === null || change.bindingId !== binding.bindingId) throw new Error("CHANGE_NOT_FOUND");
      const deadline = withDeadline(signal, 120_000, "measure");
      try {
        const effect = await this.collect(binding.repositoryFullName, change, request.beforeRuns!, request.afterRuns!, { signal: deadline.signal });
        signal.throwIfAborted();
        const current = reader.readChange(change.changeId);
        if (current?.state !== "APPLIED" || current.planDigest !== change.planDigest) throw new Error("CHANGE_CHANGED_DURING_COLLECTION");
        PatchStore.open(stateDir, settings.engine.config.storage).saveMeasurement(effect, new Date());
        return { state: effect.comparable ? "measured" : "blocked", reasons: effect.blockers };
      } finally { deadline.dispose(); }
    }
    if (!settings.localApplyEnabled) throw new Error("LOCAL_APPLY_DISABLED");
    if (binding === null) throw new Error("BINDING_NOT_FOUND");
    const id = request.id!;
    if (request.action === "revert") {
      const change = reader.readChange(id);
      if (change === null || change.bindingId !== binding.bindingId) throw new Error("CHANGE_NOT_FOUND");
      if (request.confirmation !== id) throw new Error("CONFIRMATION_REQUIRED");
      return revertChange({ store: PatchStore.open(stateDir, settings.engine.config.storage), changeId: id, now: new Date(), signal });
    }
    const stored = reader.readPlan(id);
    if (stored === null || stored.plan.payload.bindingId !== binding.bindingId) throw new Error("PLAN_NOT_FOUND");
    const preview = this.preview(reader, stored, settings, new Date(), workflowSourceReader(binding, settings.engine.config.storage.workflowMaxBytes));
    if (preview.blockers.length > 0) throw new Error(preview.blockers.join(", "));
    const store = PatchStore.open(stateDir, settings.engine.config.storage);
    if (request.action === "approve") {
      const approved = approvePlan({ store, planId: id, confirmation: request.confirmation ?? "", subjectId, channel: "human-ui", approvalTtlSeconds: settings.engine.config.apply.approvalTtlSeconds, now: new Date() });
      return { state: approved.plan.status.state, warnings: approved.warnings ?? [] };
    }
    // A separate explicit Apply click consumes the single-use approval. All
    // dependency, policy, TTL and backup checks remain in the patch engine.
    return applyPlan({ store, planId: id, subjectId, now: new Date(), signal,
      allowedRules: settings.engine.config.apply.allowedRules,
      approvalTtlSeconds: settings.engine.config.apply.approvalTtlSeconds,
      policyMaxAgeSeconds: settings.engine.config.apply.policyMaxAgeSeconds });
  }
}

interface Connection {
  readonly browserPeer: { readonly id: string };
  admit(request: Request): { peer: { id: string; principal: { kind: string } } } | { rejection: number };
  readonly fetch: { register(route: { path: string; methods: string[]; requestBody: "buffered"; fetch(request: Request): Promise<Response> }): () => Promise<void> };
}

export function registerReview(ctx: Context, settings: () => ReviewSettings): void {
  // CLI-only / older hosts keep their tools even when the browser carrier is absent.
  if (typeof ctx.inject !== "function") return;
  ctx.inject(["connection", "sessions", "webServer"], (scope) => {
    const connection = scope.get("connection") as Connection;
    const sessions = scope.get("sessions") as { get(id: string): unknown };
    const service = new ReviewService((id) => {
      const session = sessions.get(id) as { header?: { cwd?: string } } | undefined;
      if (session === undefined) throw new Error("SESSION_NOT_FOUND");
      const directories = scope.get("workingDirectory") as { get(session: unknown): string } | undefined;
      const root = directories?.get(session) ?? session.header?.cwd;
      if (root === undefined) throw new Error("SESSION_WORKSPACE_UNAVAILABLE");
      return root;
    }, settings);
    // /api has one Gateway-owned RPC interceptor. Exact extension routes use
    // the public Fetch registry and retain Connection's Host/Origin/auth fence.
    scope.effect(() => connection.fetch.register({ path: REVIEW_CHANNEL + "/" + REVIEW_ENDPOINT, methods: ["POST"], requestBody: "buffered", async fetch(request) {
      const admission = connection.admit(request);
      if ("rejection" in admission || admission.peer.principal.kind !== "owner" || admission.peer.id !== connection.browserPeer.id) {
        return new Response("BROWSER_OWNER_REQUIRED", { status: 403 });
      }
      if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") return new Response("INVALID_REQUEST", { status: 415 });
      let envelope: { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown };
      try { envelope = await request.json() as typeof envelope; }
      catch { return new Response("INVALID_REQUEST", { status: 400 }); }
      if (envelope === null || typeof envelope !== "object" || envelope.type !== "client-request" || envelope.method !== REVIEW_ENDPOINT
        || typeof envelope.rpcId !== "string" || envelope.rpcId.length === 0 || envelope.rpcId.length > 256) return new Response("INVALID_REQUEST", { status: 400 });
      let result: unknown;
      try { result = { ok: true, value: await service.execute(envelope.payload, "dsh-browser-owner", request.signal) }; }
      catch (error) { result = { ok: false, error: { code: "CI_DIET_REVIEW", message: error instanceof Error ? error.message : String(error), details: {} } }; }
      return Response.json({ type: "server-response", rpcId: envelope.rpcId, result });
    } }));
  });
}
