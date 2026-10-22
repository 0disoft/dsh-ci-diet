import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigFileError, loadConfigFile, mergeConfig } from "../../src/core/config/load.ts";
import { DEFAULT_CONFIG } from "../../src/core/data/default-config.ts";

function withFile(value: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-config-"));
  const path = join(root, "ci-diet.config.json");
  writeFileSync(path, JSON.stringify(value), "utf8");
  return path;
}

test("a partial file merges over the shipped defaults without mutating them", () => {
  const path = withFile({
    history: { maxRuns: 5, quotas: { jobs: 25 } },
    storage: { reportDays: 0 },
    billing: { accountMinutesUsed: 2500, includedMinutes: 2000 },
  });
  try {
    const config = loadConfigFile(path);
    assert.equal(config.history.maxRuns, 5);
    assert.equal(config.history.quotas.jobs, 25);
    assert.equal(config.history.quotas.discovery, DEFAULT_CONFIG.history.quotas.discovery);
    assert.equal(config.storage.reportDays, 0);
    assert.equal(config.billing?.accountMinutesUsed, 2500);
    assert.equal(DEFAULT_CONFIG.history.maxRuns, 100);
    assert.equal(DEFAULT_CONFIG.storage.reportDays, 90);
  } finally {
    rmSync(join(path, ".."), { recursive: true, force: true });
  }
});

test("a file outside the contract is rejected with its path", () => {
  const path = withFile({ history: { lookbackDays: 31 } });
  try {
    assert.throws(() => loadConfigFile(path), (error: unknown) =>
      error instanceof ConfigFileError && /CONFIG_INVALID/.test(error.message) && error.message.includes(path));
  } finally {
    rmSync(join(path, ".."), { recursive: true, force: true });
  }
});

test("an unknown key is rejected instead of silently ignored", () => {
  const path = withFile({ storage: { notASetting: true } });
  try {
    assert.throws(() => loadConfigFile(path), /CONFIG_INVALID/);
  } finally {
    rmSync(join(path, ".."), { recursive: true, force: true });
  }
});

test("an unreadable file reports the path", () => {
  const missing = join(tmpdir(), "ci-diet-config-missing-" + process.pid + ".json");
  assert.throws(() => loadConfigFile(missing), (error: unknown) =>
    error instanceof ConfigFileError && /CONFIG_UNREADABLE/.test(error.message) && error.message.includes(missing));
});

test("mergeConfig rejects a non-object document", () => {
  assert.throws(() => mergeConfig(DEFAULT_CONFIG, []), /CONFIG_INVALID/);
  assert.throws(() => mergeConfig(DEFAULT_CONFIG, null), /CONFIG_INVALID/);
});

test("mergeConfig copies override arrays instead of aliasing them", () => {
  const override = { ui: { languages: ["en"] } };
  const merged = mergeConfig(DEFAULT_CONFIG, override);
  merged.ui.languages.push("ko");
  assert.deepEqual(override.ui.languages, ["en"]);
});
