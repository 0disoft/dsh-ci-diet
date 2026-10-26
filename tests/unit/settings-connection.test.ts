import assert from "node:assert/strict";
import test from "node:test";
import { SettingsConnection, settingsNamespace } from "../../src/client/settings-connection.ts";
import type { FormSnapshot, SettingsPathOp } from "../../src/client/settings-connection.ts";

const entry = (entryId = "custom.ci-diet", extra = {}) => ({ entryId, moduleName: "dsh-ci-diet", enabled: true, fiberPhase: "active", ...extra });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(entries: unknown[] = [entry()], initial: FormSnapshot = { status: "ready", writable: true, revision: 8 }) {
  let inventory: unknown = { entries };
  let snapshot = initial;
  let mirrorSnapshot: { view?: unknown; error: string | null } = { view: { namespaces: [] }, error: null };
  let ensures = 0;
  let calls = 0;
  const selected: string[] = [];
  const writes: { ops: readonly SettingsPathOp[]; revision?: number | undefined }[] = [];
  const listeners = new Set<() => void>();
  const mirrorListeners = new Set<() => void>();
  const subscribe = (set: Set<() => void>, listener: () => void) => { set.add(listener); return () => { set.delete(listener); }; };
  const form = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => subscribe(listeners, listener),
    mutate: async (ops: readonly SettingsPathOp[], revision?: number) => { writes.push({ ops, revision }); return false; },
  };
  const connection = new SettingsConnection({
    get: (id) => { selected.push(id); return form; },
    describe: () => ({ getSnapshot: () => mirrorSnapshot, subscribe: (listener) => subscribe(mirrorListeners, listener), ensure: async () => { ensures++; } }),
  }, { rpc: { call: async () => {
    calls++;
    if (inventory instanceof Error) throw inventory;
    return { ok: true, value: inventory };
  } } });
  return {
    connection, selected, writes,
    get calls() { return calls; }, get ensures() { return ensures; },
    get subscriptionCount() { return listeners.size + mirrorListeners.size; },
    inventory(value: unknown) { inventory = value; },
    form(next: FormSnapshot) { snapshot = next; for (const listener of listeners) listener(); },
    mirror(next: typeof mirrorSnapshot) { mirrorSnapshot = next; for (const listener of mirrorListeners) listener(); },
  };
}

test("entry discovery ignores other packages, forwards exact operations/revision and returns host rejection", async () => {
  const h = harness([entry("unrelated", { moduleName: "dsh-ci-diet-other" }), entry()]);
  h.connection.connect(); await settle();
  assert.deepEqual(h.selected, ["custom.ci-diet"]);
  assert.equal(h.connection.getSnapshot().status, "ready");
  const ops: SettingsPathOp[] = [{ op: "unset", path: ["historyMaxRuns"] }, { op: "set", path: ["networkEnabled"], value: true }];
  assert.equal(await h.connection.mutate(ops, 7), false);
  assert.equal(h.writes[0]!.ops, ops);
  assert.equal(h.writes[0]!.revision, 7);
  h.form({ status: "ready", writable: true, revision: 9 });
  assert.equal(h.connection.getSnapshot().revision, 9);
  h.connection.dispose();
  assert.equal(h.subscriptionCount, 0);
  assert.equal(await h.connection.mutate(ops, 9), false);
});

for (const [name, entries, issue, ids] of [
  ["missing host", [], "missing", []],
  ["disabled host", [entry("disabled", { enabled: false })], "inactive", ["disabled"]],
  ["failed host", [entry("failed", { fiberPhase: "failed" })], "inactive", ["failed"]],
  ["starting host", [entry("starting", { fiberPhase: "loading" })], "inactive", ["starting"]],
  ["multiple active hosts", [entry("one"), entry("two")], "multiple", ["one", "two"]],
] as const) {
  test(`connection diagnoses ${name} without selecting or writing a form`, async () => {
    const h = harness([...entries]); h.connection.connect(); await settle();
    assert.equal(h.connection.getSnapshot().issue, issue);
    assert.deepEqual(h.connection.getSnapshot().entryIds, ids);
    assert.equal(await h.connection.mutate([{ op: "unset", path: ["rules"] }], 1), false);
    assert.equal(h.selected.length, 0); assert.equal(h.writes.length, 0);
  });
}

test("a nested entry falls back to its row id before describe is ready", () => {
  assert.equal(settingsNamespace("include:ciDiet.bootstrap", undefined), "ciDiet.bootstrap");
  assert.equal(settingsNamespace("custom.ci-diet", undefined), "custom.ci-diet");
});

test("nested include entries resolve to the served settings namespace", async () => {
  const h = harness([entry("include:ciDiet.bootstrap")]);
  h.mirror({ view: { namespaces: [{ ns: "ciDiet.bootstrap" }] }, error: null });
  h.connection.connect(); await settle();
  assert.deepEqual(h.selected, ["ciDiet.bootstrap"]);
  assert.equal(h.connection.getSnapshot().status, "ready");
});

test("one active host is selected even if an older disabled installation remains", async () => {
  const h = harness([entry("old", { enabled: false }), entry("new")]);
  h.connection.connect(); await settle();
  assert.deepEqual(h.selected, ["new"]);
  assert.equal(h.connection.getSnapshot().status, "ready");
});

test("an unavailable or invalid host form is diagnosed with its actual ID", async () => {
  for (const status of ["unavailable", "loading"] as const) {
    const h = harness([entry()], { status, writable: false });
    h.connection.connect(); await settle();
    assert.equal(h.connection.getSnapshot().issue, "form");
    assert.deepEqual(h.connection.getSnapshot().entryIds, ["custom.ci-diet"]);
  }
});

test("initial describe failure is reported instead of leaving the page loading forever", async () => {
  const h = harness([entry()], { status: "loading", writable: false });
  h.mirror({ error: "Disconnected" });
  h.connection.connect(); await settle();
  assert.equal(h.connection.getSnapshot().issue, "transport");
  h.connection.retry(); await settle();
  assert.equal(h.ensures, 2);
  h.mirror({ view: { namespaces: [] }, error: null });
  h.form({ status: "ready", writable: true, revision: 1 });
  assert.equal(h.connection.getSnapshot().status, "ready");
});

test("malformed inventory and RPC exceptions fail closed; retry repeats discovery", async () => {
  for (const broken of [null, {}, { entries: [{}] }, new Error("endpoint unavailable")]) {
    const h = harness(); h.inventory(broken);
    h.connection.connect(); h.connection.connect(); await settle();
    assert.equal(h.connection.getSnapshot().issue, "transport"); assert.equal(h.calls, 1);
    h.inventory({ entries: [entry()] });
    h.connection.retry(); await settle();
    assert.equal(h.calls, 2); assert.equal(h.connection.getSnapshot().status, "ready");
  }
});

test("retry never sends an existing draft/revision to a replacement installation", async () => {
  const h = harness(); h.connection.connect(); await settle();
  h.inventory({ entries: [entry("replacement")] });
  h.connection.retry(); await settle();
  assert.equal(h.connection.getSnapshot().issue, "form");
  assert.deepEqual(h.selected, ["custom.ci-diet"]);
  assert.equal(await h.connection.mutate([{ op: "set", path: ["networkEnabled"], value: true }], 8), false);
  assert.equal(h.writes.length, 0);
});

test("dispose aborts pending inventory reads and prevents late binding", async () => {
  let finish!: (value: { ok: true; value: unknown }) => void;
  let signal: AbortSignal | undefined;
  const selected: string[] = [];
  const connection = new SettingsConnection({ get: (id) => { selected.push(id); throw new Error("must not bind"); } }, {
    rpc: { call: async (_channel, _endpoint, _payload, abort) => { signal = abort; return new Promise((resolve) => { finish = resolve; }); } },
  });
  connection.connect(); connection.dispose();
  assert.equal(signal?.aborted, true);
  finish({ ok: true, value: { entries: [entry()] } }); await settle();
  assert.deepEqual(selected, []);
});
