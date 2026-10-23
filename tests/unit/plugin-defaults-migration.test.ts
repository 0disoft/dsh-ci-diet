import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { DEFAULTS_REVISION, migratePluginDefaults, registerDefaultsMigration } from "../../src/dsh/host/defaults-migration.ts";

test("upgrades explicit legacy opt-outs and adds proven rules without changing account or storage settings", () => {
  const raw = { preflightEnabled: false, networkEnabled: false, localApplyEnabled: false,
    rules: ["CD003", "CD001"], stateDir: "custom", billingEnabled: false, storageReportDays: 21 };
  const next = migratePluginDefaults(raw);
  assert.deepEqual(next, { ...raw, preflightEnabled: true, networkEnabled: true, localApplyEnabled: true,
    rules: ["CD001", "CD002", "CD004", "CD006", "CD008", "CD003"], defaultsRevision: DEFAULTS_REVISION });
  assert.equal(raw.networkEnabled, false, "does not mutate the input");
});

test("records new installs and respects opt-outs after migration across reloads", () => {
  const first = migratePluginDefaults({});
  assert.equal(first.networkEnabled, true);
  assert.equal(first.localApplyEnabled, true);
  assert.ok(!(first.rules as string[]).includes("CD003"));
  assert.ok(!(first.rules as string[]).includes("CD005"));
  const saved = JSON.parse(JSON.stringify({ ...first, networkEnabled: false, localApplyEnabled: false,
    preflightEnabled: false, rules: ["CD008"] })) as Record<string, unknown>;
  assert.equal(migratePluginDefaults(saved), saved, "never overwrites a later deliberate opt-out");
  const future = { ...saved, defaultsRevision: 99 };
  assert.equal(migratePluginDefaults(future), future, "older code respects a newer policy");
});

test("migrates only its own active instance through the editor, reading locked current config", async () => {
  const fiber = { state: 1 };
  const other = { fiber: { state: 2 } };
  const own = { fiber };
  let raw: Record<string, unknown> = { networkEnabled: false };
  let edits = 0;
  let changed: ((fiber: unknown) => void) | undefined;
  const scope = {
    get: () => ({ entries: () => [other, own], async edit(entry: unknown, change: typeof migratePluginDefaults) {
      assert.equal(entry, own);
      edits += 1;
      // A concurrent editor change before the lock was acquired must survive.
      raw = change({ ...raw, historyMaxRuns: 42 });
    } }),
    on: (event: string, callback: (fiber: unknown) => void) => { assert.equal(event, "internal/status"); changed = callback; },
    logger: { warn() { assert.fail("unexpected migration failure"); } },
  };
  const ctx = { fiber, inject(_deps: string[], callback: (scope: unknown) => void) { callback(scope); } };
  registerDefaultsMigration(ctx as never, () => Number(raw.defaultsRevision ?? 0));
  assert.equal(edits, 0, "waits for an active plugin");
  fiber.state = 2;
  changed!(other.fiber);
  assert.equal(edits, 0);
  changed!(fiber);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(edits, 1);
  assert.equal(raw.networkEnabled, true);
  assert.equal(raw.historyMaxRuns, 42);
  raw.localApplyEnabled = false;
  changed!(fiber);
  assert.equal(edits, 1);
});

test("failed migration keeps the old config and logs the failure for a later retry", async () => {
  const fiber = { state: 2 };
  let warned = false;
  let attempts = 0;
  let changed: ((fiber: unknown) => void) | undefined;
  const scope = {
    get: () => ({ entries: () => [{ fiber }], async edit() { attempts += 1; throw new Error("read-only profile"); } }),
    on: (_event: string, callback: (fiber: unknown) => void) => { changed = callback; },
    logger: { warn() { warned = true; } },
  };
  registerDefaultsMigration({ fiber, inject(_deps: string[], callback: (scope: unknown) => void) { callback(scope); } } as never, () => 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(warned, true);
  changed!(fiber);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
});

test("real Cordis activation triggers migration without waiting for a settings page or tool call", async () => {
  const ctx = new Context();
  let raw: Record<string, unknown> = { networkEnabled: false };
  let owner: unknown;
  ctx.provide("configEditor", {
    entries: () => [{ fiber: owner }],
    async edit(_entry: unknown, change: typeof migratePluginDefaults) { raw = change(raw); },
  });
  try {
    await ctx.plugin({ apply(scope: Context) {
      owner = scope.fiber;
      registerDefaultsMigration(scope, () => Number(raw.defaultsRevision ?? 0));
    } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(raw.networkEnabled, true);
    assert.equal(raw.defaultsRevision, DEFAULTS_REVISION);
  } finally {
    await ctx.fiber.dispose();
  }
});
