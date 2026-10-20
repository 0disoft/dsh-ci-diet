import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";
import { ENGINE_VERSION } from "../../src/core/version.ts";

const tagScript = fileURLToPath(new URL("../../scripts/check-release-tag.mjs", import.meta.url));
const publishWorkflow = fileURLToPath(new URL("../../.github/workflows/publish.yml", import.meta.url));
const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
) as { version: string };

function runTag(tag: string, version: string) {
  const dir = mkdtempSync(join(tmpdir(), "ci-diet-release-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "dsh-ci-diet", version }));
    const result = spawnSync(process.execPath, [tagScript, tag], { cwd: dir, encoding: "utf8" });
    return { code: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("package version matches the engine version", () => {
  assert.equal(ENGINE_VERSION, packageJson.version);
});

test("release tag accepts a matching vX.Y.Z tag", () => {
  const result = runTag("v0.1.0", "0.1.0");
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /tag v0\.1\.0 matches package\.json version 0\.1\.0/);
});

test("release tag accepts a matching prerelease tag", () => {
  const result = runTag("v1.2.3-rc.1", "1.2.3-rc.1");
  assert.equal(result.code, 0, result.stderr);
});

test("release tag rejects a tag from another version", () => {
  const result = runTag("v0.1.1", "0.1.0");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /tag "v0\.1\.1" does not match package\.json version "0\.1\.0"/);
});

test("release tag rejects a tag without the v prefix", () => {
  const result = runTag("0.1.0", "0.1.0");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /does not match/);
});

test("release tag rejects a non-semver package version", () => {
  const result = runTag("v0.1", "0.1");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /is not semver/);
});

test("publish workflow publishes on v* tags with OIDC and no token", () => {
  const text = readFileSync(publishWorkflow, "utf8");
  const doc = parse(text) as Record<string, unknown>;
  const triggers = doc.on as Record<string, unknown>;
  const push = triggers.push as Record<string, unknown>;
  assert.deepEqual(push.tags, ["v*"]);

  const permissions = doc.permissions as Record<string, string>;
  assert.equal(permissions.contents, "read");
  assert.equal(permissions["id-token"], "write");

  assert.doesNotMatch(text, /NODE_AUTH_TOKEN\s*:/);
  assert.doesNotMatch(text, /registry-url\s*:/);
  assert.doesNotMatch(text, /secrets\.[A-Z0-9_]*TOKEN/);

  const job = (doc.jobs as Record<string, unknown>).publish as Record<string, unknown>;
  const steps = job.steps as Array<Record<string, unknown>>;
  const runs = steps.map((step) => String(step.run ?? "")).join("\n");
  assert.match(runs, /npm install --global npm@\^11\.15\.0/);
  assert.match(runs, /scripts\/check-release-tag\.mjs/);
  assert.match(runs, /npm publish --provenance --access public/);
  assert.match(runs, /npm view "dsh-ci-diet@\$version" version/);
});
