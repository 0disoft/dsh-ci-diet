import { measureChangeEffect } from "../../src/core/analysis/change-effect.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ReviewService, registerReview, REVIEW_CHANNEL, REVIEW_ENDPOINT } from "../../src/dsh/host/review.ts";
import { defaultPluginSettings, engineSettingsOf } from "../../src/core/config/plugin-settings.ts";
import { PatchStore } from "../../src/core/patch/store.ts";
import { createLocalBinding } from "../../src/core/scan/binding.ts";
import { buildPatchPlan, buildPolicySnapshots, dependencyHashOf } from "../../src/core/patch/plan.ts";
import { planConcurrencyEdit } from "../../src/core/patch/edits.ts";
import { createAttestation } from "../../src/core/patch/attestation.ts";
import { parseWorkflow } from "../../src/core/workflow/parse.ts";
import { runStaticScan } from "../../src/core/scan/scan.ts";
import { buildCoverage } from "../../src/core/analysis/coverage.ts";
import { digestOf } from "../../src/shared/cdj1.ts";

const SOURCE = "on: [pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n";
function fixture(t: { after(fn: () => void): void }) {
  const temp = mkdtempSync(join(tmpdir(), "ci-diet-review-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = realpathSync(temp);
  const workflowPath = ".github/workflows/ci.yml";
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  const file = join(root, workflowPath);
  writeFileSync(file, SOURCE);
  const now = new Date();
  const binding = createLocalBinding(root, now.toISOString(), { repositoryFullName: "owner/repo" }).binding;
  const stateDir = join(root, "state");
  const store = PatchStore.open(stateDir);
  store.saveBinding(binding);
  const workflow = parseWorkflow(workflowPath, SOURCE);
  const edit = planConcurrencyEdit(SOURCE, workflow, binding.repositoryId).edit!;
  const attestation = createAttestation({ bindingId: binding.bindingId, workflowPath, workflowHash: workflow.sha256,
    dependencyHash: dependencyHashOf([]), scope: "workflow", jobKey: null, stepKey: null,
    claims: { ciOnly: true, replaceSafe: true, artifactPurpose: "unknown", consumerMinDays: null, reviewedOpaqueNodes: [] },
    evidenceRefs: ["test:review"], issuedBy: { channel: "human-cli", subjectId: "tester" }, now });
  store.saveAttestation(attestation);
  const fetchedAt = now.toISOString();
  store.saveHistory(binding.bindingId, {
    repositoryId: binding.repositoryId, repositoryFullName: "owner/repo", defaultBranch: "main",
    requestedFrom: fetchedAt, requestedTo: fetchedAt, runs: [], pulls: new Map(), workflows: [], artifacts: [],
    protection: { defaultBranch: "main", ruleCount: 0, classicProtection: true, fetchedAt },
    retention: { days: 90, maximumAllowedDays: 90, fetchedAt },
    coverage: buildCoverage({ apiVersion: "2026-03-10", ghVersion: "gh 2", requestedFrom: fetchedAt, requestedTo: fetchedAt }, {}),
    missingScopes: [],
  });
  const built = buildPatchPlan({ binding, workflow, text: SOURCE, edits: [edit], attestations: [attestation],
    policies: buildPolicySnapshots({ binding, protection: { defaultBranch: "main", ruleCount: 0, classicProtection: true, fetchedAt: now.toISOString() },
      retention: { days: 90, maximumAllowedDays: 90, fetchedAt: now.toISOString() }, now }), blockers: [], coverageWriteAllowed: true, now });
  store.savePlan(built.plan, { coverageWriteAllowed: true, reportId: null });
  const engine = engineSettingsOf({ ...defaultPluginSettings(), stateDir });
  let enabled = true;
  const service = new ReviewService((id) => { if (id !== "session") throw new Error("SESSION_NOT_FOUND"); return root; },
    () => ({ engine, localApplyEnabled: enabled }));
  const call = (action: string, extra = {}) => service.execute({ sessionId: "session", action, ...extra }, "browser", new AbortController().signal);
  return { root, file, stateDir, store, binding, plan: built.plan, call, service, engine, disable: () => { enabled = false; } };
}

test("review approves as human-ui, applies once, and restores original bytes", async (t) => {
  const f = fixture(t);
  const initial = await f.call("load") as { plans: { sourceValid: boolean; diff: unknown[] }[] };
  assert.equal(initial.plans[0]!.sourceValid, true);
  assert.ok(initial.plans[0]!.diff.length > 0);
  await assert.rejects(f.call("approve", { id: f.plan.planId, confirmation: "wrong" }), /NONCE_INVALID/);
  await f.call("approve", { id: f.plan.planId, confirmation: f.plan.planDigest.slice(-12) });
  assert.equal(f.store.readNonce(f.plan.planId)?.channel, "human-ui");
  const applied = await f.call("apply", { id: f.plan.planId }) as { state: string; change: { changeId: string } };
  assert.equal(applied.state, "applied");
  assert.match(readFileSync(f.file, "utf8"), /concurrency/);
  await assert.rejects(f.call("apply", { id: f.plan.planId }), /SOURCE_HASH_MISMATCH|PLAN_ALREADY_USED/);
  const changeId = applied.change.changeId;
  await assert.rejects(f.call("revert", { id: changeId }), /CONFIRMATION_REQUIRED/);
  assert.equal((await f.call("revert", { id: changeId, confirmation: changeId }) as { state: string }).state, "REVERTED");
  assert.equal(readFileSync(f.file, "utf8"), SOURCE);
});

test("review fails closed for changed/deleted source, disabled writes and foreign plans", async (t) => {
  const f = fixture(t);
  writeFileSync(f.file, SOURCE + "# changed\n");
  const data = await f.call("load") as { plans: { sourceValid: boolean; diff: unknown[]; blockers: string[] }[] };
  assert.equal(data.plans[0]!.sourceValid, false);
  assert.deepEqual(data.plans[0]!.diff, []);
  await assert.rejects(f.call("approve", { id: f.plan.planId, confirmation: f.plan.planDigest.slice(-12) }), /SOURCE_HASH_MISMATCH/);
  rmSync(f.file);
  assert.match(JSON.stringify(await f.call("load")), /SOURCE_UNAVAILABLE/);
  f.disable();
  await assert.rejects(f.call("approve", { id: f.plan.planId }), /LOCAL_APPLY_DISABLED/);
  await assert.rejects(f.call("revert", { id: "foreign" }), /LOCAL_APPLY_DISABLED/);
  const other = new ReviewService(() => tmpdir(), () => ({ engine: f.engine, localApplyEnabled: true }));
  await assert.rejects(other.execute({ action: "apply", sessionId: "session", id: f.plan.planId }, "browser", new AbortController().signal), /BINDING_NOT_FOUND/);
  await assert.rejects(f.call("load", { cwd: tmpdir() }), /INVALID_REQUEST/);
});

test("review reads each workflow once per load and refreshes before approval", async (t) => {
  const f = fixture(t);
  const otherPath = ".github/workflows/other.yml";
  const otherFile = join(f.root, otherPath);
  writeFileSync(otherFile, SOURCE);
  // Forty plans across two workflows, including an outdated source hash.
  for (let i = 1; i < 40; i += 1) {
    const payload = { ...f.plan.payload,
      workflowPath: i < 20 ? f.plan.payload.workflowPath : otherPath,
      createdAt: new Date(Date.now() + i * 1000).toISOString(),
      sourceHash: i === 1 ? "sha256:" + "0".repeat(64) : f.plan.payload.sourceHash };
    const planDigest = digestOf(payload);
    f.store.savePlan({ ...f.plan, payload, planDigest, planId: "p_" + planDigest.slice(7, 31) },
      { coverageWriteAllowed: true, reportId: null });
  }
  const planFiles = new Set(readdirSync(join(f.stateDir, "plans")).map((file) => join(f.stateDir, "plans", file)));
  const planBytes = [...planFiles].reduce((total, file) => total + readFileSync(file).byteLength, 0);
  let planReads = 0, bytesRead = 0;
  const reads = new Map<string, number>();
  let unreadable = false;
  const read = fs.readFileSync;
  const mocked = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === f.file || args[0] === otherFile) reads.set(args[0], (reads.get(args[0]) ?? 0) + 1);
    if (args[0] === f.file && unreadable) throw Object.assign(new Error("unreadable workflow"), { code: "EACCES" });
    const result = read(...args);
    if (planFiles.has(String(args[0]))) {
      planReads += 1;
      bytesRead += Buffer.byteLength(result);
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    type Loaded = { plans: { sourceValid: boolean; diff: unknown[]; blockers: string[] }[] };
    const initial = await f.call("load") as Loaded;
    t.diagnostic("plan JSON reads: " + planReads + "; bytes: " + bytesRead + "; single-pass bytes: " + planBytes);
    assert.equal(planReads, 80, "40 plans and their metadata must each be read once per load");
    assert.equal(bytesRead, planBytes);
    assert.equal(initial.plans.length, 40);
    assert.equal(initial.plans.filter((plan) => plan.sourceValid).length, 39);
    const outdated = initial.plans.find((plan) => !plan.sourceValid)!;
    assert.ok(outdated.blockers.includes("SOURCE_HASH_MISMATCH"));
    assert.deepEqual(outdated.diff, []);
    assert.deepEqual([...reads.values()], [1, 1], "40 previews must read only two workflow sources");
    t.diagnostic("workflow reads: 40 -> 2; source bytes: " + 40 * Buffer.byteLength(SOURCE) + " -> " + 2 * Buffer.byteLength(SOURCE));

    writeFileSync(f.file, SOURCE + "# changed\n");
    await assert.rejects(f.call("approve", { id: f.plan.planId, confirmation: f.plan.planDigest.slice(-12) }), /SOURCE_HASH_MISMATCH/);
    const updated = await f.call("load") as Loaded;
    assert.equal(updated.plans.filter((plan) => plan.sourceValid).length, 20);
    assert.equal(reads.get(f.file), 3, "approval and reload must each read fresh source");
    assert.equal(reads.get(otherFile), 2);

    unreadable = true;
    const inaccessible = await f.call("load") as Loaded;
    assert.equal(inaccessible.plans.filter((plan) => plan.blockers.includes("SOURCE_UNAVAILABLE")).length, 20);
    assert.equal(reads.get(f.file), 4, "an unreadable source is attempted once per load");
    unreadable = false;
    rmSync(f.file);
    const deleted = await f.call("load") as Loaded;
    assert.equal(deleted.plans.filter((plan) => plan.blockers.includes("SOURCE_UNAVAILABLE")).length, 20);
    writeFileSync(f.file, SOURCE);
    const restored = await f.call("load") as Loaded;
    assert.equal(restored.plans.filter((plan) => plan.sourceValid).length, 39, "failed reads must not survive a request");
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test("review reloads coverage metadata for approval and apply and fails closed when missing or malformed", async (t) => {
  const f = fixture(t);
  await f.call("load");
  const metaPath = join(f.stateDir, "plans", f.plan.planId + ".meta.json");
  const setCoverage = (allowed: unknown) => writeFileSync(metaPath, JSON.stringify({ coverageWriteAllowed: allowed, reportId: null }));
  const approval = { id: f.plan.planId, confirmation: f.plan.planDigest.slice(-12) };
  setCoverage(false);
  await assert.rejects(f.call("approve", approval), /COVERAGE_INSUFFICIENT_FOR_WRITE/);
  assert.equal(f.store.readNonce(f.plan.planId), null);
  rmSync(metaPath);
  const missing = await f.call("load") as { plans: { blockers: string[] }[] };
  assert.ok(missing.plans[0]!.blockers.includes("COVERAGE_INSUFFICIENT_FOR_WRITE"));
  setCoverage("true");
  await assert.rejects(f.call("load"), /PlanMeta schema mismatch/);
  setCoverage(true);
  await f.call("approve", approval);
  setCoverage(false);
  await assert.rejects(f.call("apply", { id: f.plan.planId }), /COVERAGE_INSUFFICIENT_FOR_WRITE/);
  assert.equal(readFileSync(f.file, "utf8"), SOURCE);
});

test("read-only report load scopes binding and never creates directories or repairs index", async (t) => {
  const f = fixture(t);
  const scan = runStaticScan({ workspaceRoot: f.root });
  // Use the same binding; static scans may have a distinct remote identity.
  f.store.saveReport({ ...scan.report, bindingId: f.binding.bindingId });
  const indexes = join(f.stateDir, "index");
  for (const file of readdirSync(indexes)) rmSync(join(indexes, file));
  const loaded = await f.call("load") as { report: { reportId: string } };
  assert.equal(loaded.report.reportId, scan.report.reportId);
  assert.deepEqual(readdirSync(indexes), []);
  const absent = join(f.root, "absent");
  const service = new ReviewService(() => f.root, () => ({ engine: { ...f.engine, stateDir: absent }, localApplyEnabled: false }));
  const result = await service.execute({ action: "load", sessionId: "session" }, "browser", new AbortController().signal) as { report: unknown };
  assert.equal(result.report, null);
  assert.equal(existsSync(absent), false);
});

test("review keeps approval TTL enforcement in the existing apply engine", async (t) => {
  const f = fixture(t);
  await f.call("approve", { id: f.plan.planId, confirmation: f.plan.planDigest.slice(-12) });
  const nonce = f.store.readNonce(f.plan.planId)!;
  f.store.saveNonce(f.plan.planId, { ...nonce, createdAt: new Date(Date.now() - 601_000).toISOString() });
  const result = await f.call("apply", { id: f.plan.planId }) as { state: string; reasons: readonly string[] };
  assert.equal(result.state, "not_applied");
  assert.ok(result.reasons.includes("NONCE_INVALID"));
  assert.equal(readFileSync(f.file, "utf8"), SOURCE);
});

test("review respects zero as a disabled workflow size limit", async (t) => {
  const f = fixture(t);
  const engine = engineSettingsOf({ ...defaultPluginSettings(), stateDir: f.stateDir, storageWorkflowMaxBytes: 0 });
  const service = new ReviewService(() => f.root, () => ({ engine, localApplyEnabled: true }));
  const result = await service.execute({ action: "load", sessionId: "session" }, "browser", new AbortController().signal) as { plans: { sourceValid: boolean }[] };
  assert.equal(result.plans[0]!.sourceValid, true);
});

test("browser route rejects owner API peers and never registers a model tool", async (t) => {
  const f = fixture(t);
  let handler: (request: Request) => Promise<Response>;
  const connection = { browserPeer: { id: "browser" },
    admit(request: Request) { return { peer: { id: request.headers.get("test-peer") ?? "browser", principal: { kind: "owner" } } }; },
    fetch: { register(route: {path: string; fetch: typeof handler}) {
      assert.equal(route.path, REVIEW_CHANNEL + "/" + REVIEW_ENDPOINT); handler = route.fetch; return async () => {};
    } } };
  const scope = { get(key: string) { return key === "connection" ? connection : key === "sessions" ? { get: () => ({ header: { cwd: f.root } }) } : undefined; }, effect(fn: () => unknown) { fn(); } };
  registerReview({ inject(_deps: unknown, fn: (ctx: unknown) => void) { fn(scope); } } as never,
    () => ({ engine: f.engine, localApplyEnabled: true }));
  const request = (peer: string) => new Request("http://localhost/api/ci-diet-review", {method:"POST",headers:{"content-type":"application/json","test-peer":peer},body:JSON.stringify({type:"client-request",rpcId:"test",method:REVIEW_ENDPOINT,payload:{action:"load",sessionId:"session"}})});
  const denied = await handler!(request("api-owner")); assert.equal(denied.status,403);
  const allowed = await handler!(request("browser"));
  assert.equal((await allowed.json() as {result:{ok:boolean}}).result.ok,true);
});

test("browser measurement is workspace-bound, read-only on load, and independent of local apply", async (t) => {
  const f = fixture(t), signal = new AbortController().signal;
  await f.call("approve", { id: f.plan.planId, confirmation: f.plan.planDigest.slice(-12) });
  const applied = await f.call("apply", { id: f.plan.planId }) as { change: { changeId: string } };
  const change = f.store.readChange(applied.change.changeId)!;
  const observation = (id: number, seconds: number) => ({ id, attempt: 1, repository: "owner/repo", workflow: change.workflowPath,
    branch: "main", event: "push", sha: String(id).repeat(40), jobs: [{ name: "test", labels: ["ubuntu-latest"], seconds, steps: [] }] });
  const effect = measureChangeEffect(change,
    [{ id: 1, attempt: 1, conclusion: "success", workflowHash: change.before.hash, observation: observation(1, 30) }],
    [{ id: 2, attempt: 1, conclusion: "success", workflowHash: change.after.hash, observation: observation(2, 35) }]);
  let calls = 0;
  const service = new ReviewService(() => f.root, () => ({ engine: f.engine, localApplyEnabled: false }), async (repo, journal, before, after) => {
    calls++; assert.equal(repo, "owner/repo"); assert.equal(journal.changeId, change.changeId);
    assert.deepEqual(before, [1]); assert.deepEqual(after, [2]); return effect;
  });
  const request = { action: "measure", sessionId: "session", id: change.changeId, beforeRuns: [1], afterRuns: [2] };
  assert.equal((await service.execute(request, "browser", signal) as { state: string }).state, "measured");
  const view = await service.execute({ action: "load", sessionId: "session" }, "browser", signal) as { changes: { measurement: { effect: { observedReductionSeconds: number } } }[] };
  assert.equal(view.changes[0]!.measurement.effect.observedReductionSeconds, -5);
  assert.equal(calls, 1, "rendering never starts another GitHub collection");
  const off = new ReviewService(() => f.root, () => ({ engine: { ...f.engine, networkEnabled: false }, localApplyEnabled: false }));
  await assert.rejects(off.execute(request, "browser", signal), /NETWORK_DISABLED/);
  await assert.rejects(service.execute({ ...request, beforeRuns: [] }, "browser", signal), /INVALID_RUN_SELECTION/);
  await assert.rejects(service.execute({ ...request, id: "foreign" }, "browser", signal), /CHANGE_NOT_FOUND/);
  const file = join(f.stateDir, "cache", "effect-" + change.changeId + ".json");
  const saved = JSON.parse(readFileSync(file, "utf8")); saved.effect.observedReductionSeconds = 999;
  writeFileSync(file, JSON.stringify(saved));
  assert.equal(f.store.readMeasurement(change.changeId), null, "tampered cached metrics are not displayed");
  assert.throws(() => new PatchStore(f.stateDir, { storeMaxBytes: 1, warningPercent: 90, cacheMaxBytes: 0, pruneAppliedBackups: false })
    .saveMeasurement(effect, new Date()), /STORAGE_QUOTA_EXCEEDED/);
});
