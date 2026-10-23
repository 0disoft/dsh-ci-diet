import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { isolatedEnv } from "../helpers/test-env.ts";
import { runCli } from "../helpers/cli.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const cliPath = join(repoRoot, "src", "cli", "index.ts");
let workspace = "";
let scanRoot = "";

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runProcessCli(args: readonly string[]): Run {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: isolatedEnv(),
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "ci-diet-cli-"));
  scanRoot = join(workspace, "static-scan");
  cpSync(join(repoRoot, "tests", "fixtures", "repos", "static-scan"), scanRoot, { recursive: true });
});

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("ci-diet scan", () => {
  it("prints a human summary and exits 0", async () => {
    const result = runProcessCli(["scan", "--cwd", scanRoot, "--lang", "en"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Workflows: 2 of 4 parsed/);
    assert.match(result.stdout, /\[CD004\]/);
    assert.match(result.stdout, /\[CD008\]/);
    assert.match(result.stdout, /Findings: 2/);
    assert.match(result.stdout, /Static scan: workflow text only/);
  });

  it("prints a schema-valid report with --json", async () => {
    const result = await runCli(["scan", "--cwd", scanRoot, "--json", "--lang", "en"]);
    assert.equal(result.status, 0);
    const report = JSON.parse(result.stdout) as { schemaVersion: number; findings: unknown[] };
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.findings.length, 2);
  });

  it("writes the report to --out", async () => {
    const target = join(workspace, "out", "report.json");
    const result = await runCli(["scan", "--cwd", scanRoot, "--out", target, "--lang", "en"]);
    assert.equal(result.status, 0);
    const written = JSON.parse(readFileSync(target, "utf8")) as { findings: unknown[] };
    assert.equal(written.findings.length, 2);
    assert.ok(result.stdout.includes("Report written"));
  });

  it("exits 3 with --require-complete when an axis is incomplete", async () => {
    const result = await runCli(["scan", "--cwd", scanRoot, "--require-complete", "--lang", "en"]);
    assert.equal(result.status, 3);
  });

  it("rejects unknown rules with a usage error", async () => {
    const result = await runCli(["scan", "--rules", "CD999", "--lang", "en"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown rule: CD999/);
  });

  it("honours --lang ko for its own text", async () => {
    const result = await runCli(["scan", "--cwd", scanRoot, "--lang", "ko"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /발견 사항: 2/);
  });

  it("prints usage and version without scanning", async () => {
    const usage = await runCli(["--help", "--lang", "en"]);
    assert.equal(usage.status, 0);
    assert.match(usage.stdout, /Usage: ci-diet <command>/);
    const version = await runCli(["--version"]);
    assert.equal(version.status, 0);
    assert.match(version.stdout, /^ci-diet \d+\.\d+\.\d+/);
    const empty = await runCli([]);
    assert.equal(empty.status, 1);
  });

  it("falls back to an English message for a missing directory", async () => {
    const result = await runCli(["scan", "--cwd", join(workspace, "absent"), "--lang", "en"]);
    assert.notEqual(result.status, 0);
    assert.ok(existsSync(scanRoot));
  });
});

describe("ci-diet sync guards", () => {
  it("refuses the network without --network", async () => {
    const result = await runCli(["sync", "--cwd", scanRoot, "--lang", "en"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Pass --network/);
  });

  it("rejects a malformed --repo before calling the API", async () => {
    const result = await runCli(["sync", "--network", "--repo", "no-slash", "--cwd", scanRoot, "--lang", "en"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid value for --repo/);
  });

  it("rejects --days outside the supported window", async () => {
    const result = await runCli(["sync", "--network", "--days", "0", "--cwd", scanRoot, "--lang", "en"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid value for --days/);
  });

  it("prints sync-specific usage", async () => {
    const result = await runCli(["sync", "--help", "--lang", "en"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: ci-diet sync --network/);
  });
});
