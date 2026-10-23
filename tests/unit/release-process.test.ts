import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";
import { ENGINE_VERSION } from "../../src/core/version.ts";

type PackageManifest = {
  version: string;
  files: string[];
  bin: Record<string, string>;
  exports: Record<string, string>;
  engines: Record<string, string>;
  scripts: Record<string, string>;
  peerDependencies: Record<string, string>;
};

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const tagScript = fileURLToPath(new URL("../../scripts/check-release-tag.mjs", import.meta.url));
const publishWorkflow = fileURLToPath(new URL("../../.github/workflows/publish.yml", import.meta.url));
const ciWorkflow = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
) as PackageManifest;

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

// A throwaway repository copy with the contract areas and the sync script, so
// the script's own fallback path can be exercised without the design pack.
function contractsWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "ci-diet-contracts-"));
  for (const area of ["contracts", "examples"]) {
    cpSync(join(repoRoot, area), join(dir, area), { recursive: true });
  }
  mkdirSync(join(dir, "scripts"), { recursive: true });
  cpSync(join(repoRoot, "scripts", "sync-contracts.mjs"), join(dir, "scripts", "sync-contracts.mjs"));
  return dir;
}

function runSync(dir: string, args: string[]) {
  const env = { ...process.env };
  delete env.CI_DIET_DESIGN_PACK;
  const result = spawnSync(process.execPath, ["scripts/sync-contracts.mjs", ...args], {
    cwd: dir,
    encoding: "utf8",
    env,
  });
  return { code: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}

test("package version matches the engine version", () => {
  assert.equal(ENGINE_VERSION, packageJson.version);
});

test("the published package builds its artifacts before packing", () => {
  // dist/ is gitignored, so a fresh clone has no artifacts to ship. The prepack
  // hook is what turns a clean checkout into a package with a working bin.
  assert.equal(packageJson.scripts.prepack, "npm run build");
  assert.match(packageJson.scripts.build ?? "", /tsc -p tsconfig\.build\.json/);
  assert.ok(packageJson.files.includes("dist"), "files must ship dist/");
  assert.equal(packageJson.bin["ci-diet"], "./dist/cli/index.js");
  assert.equal(packageJson.exports["."], "./dist/dsh/bootstrap.js");
});

test("test:core refuses to report an empty run as passing", () => {
  assert.equal(packageJson.scripts["test:core"], "node scripts/test-core.mjs");
  const dir = mkdtempSync(join(tmpdir(), "ci-diet-tests-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    cpSync(join(repoRoot, "scripts", "test-core.mjs"), join(dir, "scripts", "test-core.mjs"));
    mkdirSync(join(dir, "tests", "unit"), { recursive: true });
    const empty = spawnSync(process.execPath, ["scripts/test-core.mjs"], { cwd: dir, encoding: "utf8" });
    assert.equal(empty.status, 1);
    assert.match(String(empty.stderr), /refusing to report a passing run/);

    writeFileSync(
      join(dir, "tests", "unit", "sample.test.ts"),
      'import { test } from "node:test";\ntest("sample", () => {});\n',
    );
    const filled = spawnSync(process.execPath, ["scripts/test-core.mjs"], { cwd: dir, encoding: "utf8" });
    assert.equal(filled.status, 0, String(filled.stderr));
    assert.match(String(filled.stdout), /running 1 test files/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the DSH peer range admits the next 0.2 prerelease", (t) => {
  const range = packageJson.peerDependencies["@deepseek-ai/dsh-tools"] ?? "";
  assert.equal(packageJson.engines.dsh, range);
  // A bare upper bound does not admit prereleases, so the range needs an arm
  // for each 0.2.x prerelease line we intend to support.
  assert.match(range, />=0\.2\.2-rc\.1/);
  const probe = spawnSync(
    "bun",
    [
      "-e",
      [
        "const r = " + JSON.stringify(range) + ";",
        'console.log(Bun.semver.satisfies("0.2.2-rc.1", r) ? "accept" : "reject", Bun.semver.satisfies("0.3.0-rc.1", r) ? "accept" : "reject");',
      ].join(" "),
    ],
    { encoding: "utf8" },
  );
  if (probe.error !== undefined || probe.status !== 0) {
    t.skip("bun is not available to evaluate the semver range");
    return;
  }
  assert.equal(String(probe.stdout).trim(), "accept reject");
});

test("CI runs the suite on the declared Node floor", () => {
  const doc = parse(readFileSync(ciWorkflow, "utf8")) as Record<string, unknown>;
  const job = (doc.jobs as Record<string, unknown>).check as Record<string, unknown>;
  const steps = job.steps as Array<Record<string, unknown>>;
  const node = steps.findIndex((step) => String(step.uses ?? "").startsWith("actions/setup-node@"));
  assert.notEqual(node, -1, "ci.yml must provision Node explicitly");
  const setup = steps[node] ?? {};
  const withBlock = (setup.with ?? {}) as Record<string, string>;
  const pinned = withBlock["node-version"] ?? "";
  assert.notEqual(pinned, "", "setup-node must pin a node-version");
  assert.match(packageJson.engines.node ?? "", new RegExp(pinned.replace(/\./g, "\\.")));
  const unit = steps.findIndex((step) => String(step.run ?? "").includes("test:core"));
  assert.ok(node < unit, "setup-node must precede the test run");
});

test("contract lock verifies the copies when the design pack is absent", () => {
  const dir = contractsWorkspace();
  try {
    const result = runSync(dir, ["--check"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /contracts match contracts\.lock\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tampered contract is rejected by the lock", () => {
  const dir = contractsWorkspace();
  try {
    const file = join(dir, "contracts", "coverage-policy.json");
    writeFileSync(file, readFileSync(file, "utf8") + "\n");
    const result = runSync(dir, ["--check"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /changed since contracts\.lock\.json was written/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock that names another design pack is rejected", () => {
  const dir = contractsWorkspace();
  try {
    const file = join(dir, "contracts", "contracts.lock.json");
    const lock = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    lock.pack = "ci-diet-design-v9.9.9";
    writeFileSync(file, JSON.stringify(lock, null, 2) + "\n");
    const result = runSync(dir, ["--check"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /pack "ci-diet-design-v9\.9\.9" is not "ci-diet-design-v0\.2\.1"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tampered provenance anchor is rejected", () => {
  const dir = contractsWorkspace();
  try {
    const file = join(dir, "contracts", "UPSTREAM.md");
    const text = readFileSync(file, "utf8").replace(
      /Archive sha256 \| `[0-9a-f]{64}`/,
      "Archive sha256 | `" + "a".repeat(64) + "`",
    );
    writeFileSync(file, text);
    const result = runSync(dir, ["--check"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /archive sha256/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update-lock refuses to certify the working tree without the design pack", () => {
  const dir = contractsWorkspace();
  try {
    const file = join(dir, "contracts", "contracts.lock.json");
    const before = readFileSync(file, "utf8");
    const result = runSync(dir, ["--update-lock"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /refusing to update contracts\/contracts\.lock\.json/);
    assert.equal(readFileSync(file, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  assert.match(runs, /npm publish --provenance --access public --ignore-scripts/);
  const buildIndex = steps.findIndex((step) => step.run === "bun run build");
  const smokeIndex = steps.findIndex((step) => step.run === "bun run smoke:node");
  const publishIndex = steps.findIndex((step) => String(step.run).startsWith("npm publish"));
  assert.ok(buildIndex >= 0 && buildIndex < smokeIndex && smokeIndex < publishIndex, "publishing without prepack requires a prior build and smoke test");
  assert.match(runs, /npm view "dsh-ci-diet@\$version" version/);
});
