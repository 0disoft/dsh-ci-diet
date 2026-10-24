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
  const reads = new Map<string, number>();
  let unreadable = false;
  const read = fs.readFileSync;
  const mocked = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === f.file || args[0] === otherFile) reads.set(args[0], (reads.get(args[0]) ?? 0) + 1);
    if (args[0] === f.file && unreadable) throw Object.assign(new Error("unreadable workflow"), { code: "EACCES" });
    return read(...args);
  });
  syncBuiltinESMExports();
  try {
    type Loaded = { plans: { sourceValid: boolean; diff: unknown[]; blockers: string[] }[] };
    const initial = await f.call("load") as Loaded;
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
