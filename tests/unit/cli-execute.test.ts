import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

test("executeCli reports usage errors without touching the real streams", async () => {
  const stdout = capture();
  const stderr = capture();
  const code = await executeCli(["unknown-command"], { stdout, stderr });
  assert.equal(code, 1);
  assert.equal(stdout.text(), "");
  assert.match(stderr.text(), /unknown-command/);
});
