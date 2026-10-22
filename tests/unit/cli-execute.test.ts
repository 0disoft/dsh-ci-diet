import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executeCli } from "../../src/cli/index.ts";

function capture(): { write: (text: string) => void; text: () => string } {
  const chunks: string[] = [];
  return { write: (text: string) => { chunks.push(text); }, text: () => chunks.join("") };
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-cli-context-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  return root;
}

test("executeCli runs against injected streams instead of the process", async () => {
  const stdout = capture();
  const stderr = capture();
  const code = await executeCli(["--version"], { stdout, stderr });
  assert.equal(code, 0);
  assert.equal(stdout.text(), "ci-diet 0.2.0\n");
  assert.equal(stderr.text(), "");
});

test("executeCli resolves relative output paths against the injected cwd", async () => {
  const root = makeRoot();
  try {
    const stdout = capture();
    const code = await executeCli(["scan", "--json", "--out", "report.json"], {
      cwd: root,
      stdout,
      stderr: capture(),
    });
    assert.equal(code, 0);
    assert.ok(existsSync(join(root, "report.json")));
    assert.doesNotThrow(() => JSON.parse(stdout.text()) as unknown);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executeCli resolves --out and --state-dir against --cwd", async () => {
  const root = makeRoot();
  const base = mkdtempSync(join(tmpdir(), "ci-diet-cli-base-"));
  try {
    const code = await executeCli(["scan", "--json", "--cwd", root, "--out", "report.json"], {
      cwd: base,
      stdout: capture(),
      stderr: capture(),
    });
    assert.equal(code, 0);
    assert.ok(existsSync(join(root, "report.json")));
    assert.equal(existsSync(join(base, "report.json")), false);
    const prune = await executeCli(["changes", "--cwd", root, "--state-dir", "state"], {
      cwd: base,
      stdout: capture(),
      stderr: capture(),
    });
    assert.equal(prune, 0);
    assert.ok(existsSync(join(root, "state")));
    assert.equal(existsSync(join(base, "state")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});

test("executeCli stamps reports with the injected clock", async () => {
  const root = makeRoot();
  try {
    const stdout = capture();
    const clock = { now: () => new Date("2026-01-02T03:04:05.000Z") };
    const code = await executeCli(["scan", "--json"], {
      cwd: root,
      clock,
      stdout,
      stderr: capture(),
    });
    assert.equal(code, 0);
    const report = JSON.parse(stdout.text()) as { generatedAt?: string };
    assert.equal(report.generatedAt, "2026-01-02T03:04:05.000Z");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executeCli applies the storage cap from --config", async () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, ".github", "workflows", "valid.yml"), "on: push\njobs: {}\n", "utf8");
    writeFileSync(join(root, ".github", "workflows", "large.yml"), "#".repeat(300), "utf8");
    writeFileSync(join(root, "config.json"), JSON.stringify({ storage: { workflowMaxBytes: 256 } }), "utf8");
    const stdout = capture();
    const code = await executeCli(["scan", "--json", "--cwd", root, "--config", "config.json"], {
      cwd: tmpdir(),
      stdout,
      stderr: capture(),
    });
    assert.equal(code, 0);
    const report = JSON.parse(stdout.text()) as {
      coverage: { workflowDefinitions: { status: string; fetched: number; expected: number; missingScopes: { reason: string }[] } };
    };
    const coverage = report.coverage.workflowDefinitions;
    assert.equal(coverage.status, "partial");
    assert.equal(coverage.fetched, 1);
    assert.equal(coverage.expected, 2);
    assert.equal(coverage.missingScopes[0]?.reason, "WORKFLOW_TOO_LARGE");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executeCli rejects an invalid --config before running the command", async () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, "broken.json"), "{not json", "utf8");
    const stderr = capture();
    const code = await executeCli(["scan", "--config", "broken.json"], {
      cwd: root,
      stdout: capture(),
      stderr,
    });
    assert.equal(code, 2);
    assert.match(stderr.text(), /CONFIG_INVALID/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executeCli localizes through the injected environment", async () => {
  const root = makeRoot();
  try {
    const stdout = capture();
    const code = await executeCli(["scan"], {
      cwd: root,
      env: { LANG: "ko_KR.UTF-8" },
      stdout,
      stderr: capture(),
    });
    assert.equal(code, 0);
    assert.match(stdout.text(), /워크플로 파일을 찾지 못했습니다/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executeCli reports a pre-aborted mutating command as cancelled", async () => {
  const root = makeRoot();
  try {
    const stdout = capture();
    const stderr = capture();
    const controller = new AbortController();
    controller.abort();
    const code = await executeCli(["apply", "--plan", "p_missing"], {
      cwd: root,
      env: {},
      stdout,
      stderr,
      signal: controller.signal,
    });
    assert.equal(code, 130);
    assert.equal(stdout.text(), "");
    assert.match(stderr.text(), /Cancelled/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executeCli reports usage errors without touching the real streams", async () => {
  const stdout = capture();
  const stderr = capture();
  const code = await executeCli(["unknown-command"], { stdout, stderr });
  assert.equal(code, 1);
  assert.equal(stdout.text(), "");
  assert.match(stderr.text(), /unknown-command/);
});