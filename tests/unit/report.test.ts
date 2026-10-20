import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { runStaticScan } from "../../src/core/scan/scan.ts";
import { PatchStore } from "../../src/core/patch/store.ts";
import { escapeHtml, renderHtmlReport } from "../../src/core/report/html.ts";
import type { AnalysisReport } from "../../src/core/contracts/schema.ts";
import { isolatedEnv } from "../helpers/test-env.ts";
import { localizedFinding } from "../../src/core/report/localize.ts";
import { LOCALES } from "../../src/shared/i18n/index.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const cliPath = join(repoRoot, "src", "cli", "index.ts");
let workspace = "";
let scanRoot = "";
let stateDir = "";
let report: AnalysisReport;

function runCli(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: isolatedEnv(),
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "ci-diet-report-"));
  scanRoot = join(workspace, "repo");
  cpSync(join(repoRoot, "tests", "fixtures", "repos", "static-scan"), scanRoot, { recursive: true });
  const scanned = runStaticScan({ workspaceRoot: scanRoot, generatedAt: "2026-10-20T00:00:00Z" });
  report = scanned.report;
  stateDir = join(workspace, "state");
  const store = PatchStore.open(stateDir);
  store.saveBinding(scanned.binding);
  store.saveReport(report);
  const old: AnalysisReport = {
    ...report,
    reportId: "r_" + "0".repeat(24),
    generatedAt: "2000-01-01T00:00:00Z",
  };
  store.saveReport(old);
});

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("html report", () => {
  it("escapes dynamic text", () => {
    assert.equal(escapeHtml('a<b>&"c"'), "a&lt;b&gt;&amp;&quot;c&quot;");
    const hostile: AnalysisReport = {
      ...report,
      findings: report.findings.map((finding) => {
        const { message: _message, ...rest } = finding;
        return { ...rest, title: "<script>alert(1)</script>" };
      }),
    };
    const html = renderHtmlReport(hostile);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it("renders a self-contained page", () => {
    const html = renderHtmlReport(report);
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<style>/);
    assert.match(html, /Coverage/);
    assert.match(html, /Findings \(2\)/);
    assert.match(html, new RegExp(report.reportId));
    assert.doesNotMatch(html, /https?:\/\//);
  });
});

describe("ci-diet report", () => {
  it("prints the latest report as JSON", () => {
    const result = runCli(["report", "--state-dir", stateDir, "--json"]);
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout) as { reportId: string; schemaVersion: number };
    assert.equal(parsed.schemaVersion, 2);
    assert.equal(parsed.reportId, report.reportId);
  });

  it("prints a human summary", () => {
    const result = runCli(["report", "--state-dir", stateDir, "--lang", "en"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Findings: 2/);
    assert.match(result.stdout, /Runner seconds/);
  });

  it("prints HTML with --format html", () => {
    const result = runCli(["report", "--state-dir", stateDir, "--format", "html"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^<!doctype html>/);
    assert.match(result.stdout, /CD004|CD008/);
  });

  it("writes HTML to --out", () => {
    const target = join(workspace, "out", "report.html");
    const result = runCli(["report", "--state-dir", stateDir, "--format", "html", "--out", target]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Report written to/);
  });

  it("fails without a stored report", () => {
    const result = runCli(["report", "--state-dir", join(workspace, "empty")]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No stored report/);
  });

  it("rejects an unknown format", () => {
    const result = runCli(["report", "--state-dir", stateDir, "--format", "pdf"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid value for --format/);
  });
});

describe("ci-diet prune", () => {
  it("removes expired reports but keeps fresh ones", () => {
    const result = runCli(["prune", "--state-dir", stateDir, "--json"]);
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout) as { removedReports: number; removedPlans: number };
    assert.equal(parsed.removedReports, 1);
    assert.equal(parsed.removedPlans, 0);
    const after = runCli(["report", "--state-dir", stateDir, "--json"]);
    assert.equal(after.status, 0);
    assert.equal((JSON.parse(after.stdout) as { reportId: string }).reportId, report.reportId);
  });
});
describe("localized rendering", () => {
  it("renders each shipped language with its own lang attribute", () => {
    const englishFinding = localizedFinding(report.findings[0]!, "en").title;
    const english = renderHtmlReport(report, { locale: "en" });
    for (const locale of LOCALES) {
      const html = renderHtmlReport(report, { locale });
      assert.match(html, new RegExp("<html lang=\"" + locale + "\""), "lang attribute for " + locale);
      const title = localizedFinding(report.findings[0]!, locale).title;
      assert.ok(html.includes(escapeHtml(title)), "localized finding title for " + locale);
      assert.ok(html.includes("CD004"), "rule id stays untranslated");
      if (locale !== "en") assert.notEqual(title, englishFinding, "finding title translated for " + locale);
    }
    assert.match(english, /<html lang="en">/);
  });

  it("keeps machine codes and numbers untranslated", () => {
    for (const locale of LOCALES) {
      const html = renderHtmlReport(report, { locale });
      assert.ok(html.includes("MATRIX_EDIT_NOT_SUPPORTED"), "blocker code in " + locale);
      assert.ok(html.includes("CD008"), "rule id in " + locale);
      assert.ok(html.includes("2"), "finding count in " + locale);
    }
  });

  it("prints human findings in every shipped language", () => {
    for (const locale of LOCALES) {
      const result = runCli(["report", "--state-dir", stateDir, "--lang", locale]);
      assert.equal(result.status, 0, "exit status for " + locale);
      const title = localizedFinding(report.findings[0]!, locale).title;
      assert.ok(result.stdout.includes(title), "finding title in " + locale + " output: " + result.stdout);
      assert.ok(result.stdout.includes("CD004"), "rule id in " + locale);
    }
  });

  it("writes HTML in the requested language", () => {
    const target = join(workspace, "out", "report-ko.html");
    const result = runCli(["report", "--state-dir", stateDir, "--format", "html", "--lang", "ko", "--out", target]);
    assert.equal(result.status, 0);
    const html = readFileSync(target, "utf8");
    assert.match(html, /<html lang="ko">/);
    assert.ok(html.includes(escapeHtml(localizedFinding(report.findings[0]!, "ko").title)));
  });
});

