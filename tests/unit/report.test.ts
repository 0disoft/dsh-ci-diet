import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { runStaticScan } from "../../src/core/scan/scan.ts";
import { createLocalBinding } from "../../src/core/scan/binding.ts";
import { PatchStore } from "../../src/core/patch/store.ts";
import { escapeHtml, renderHtmlReport } from "../../src/core/report/html.ts";
import type { AnalysisReport } from "../../src/core/contracts/schema.ts";
import { runCli } from "../helpers/cli.ts";
import { localizedFinding } from "../../src/core/report/localize.ts";
import { LOCALES } from "../../src/shared/i18n/index.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
let workspace = "";
let scanRoot = "";
let stateDir = "";
let report: AnalysisReport;

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
  it("escapes dynamic text", async () => {
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

  it("renders a self-contained page", async () => {
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
  it("prints the latest report as JSON", async () => {
    const result = await runCli(["report", "--cwd", scanRoot, "--state-dir", stateDir, "--json"]);
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout) as { reportId: string; schemaVersion: number };
    assert.equal(parsed.schemaVersion, 2);
    assert.equal(parsed.reportId, report.reportId);
  });


  it("scopes the latest report to the repository at the current root", async () => {
    const otherRoot = join(workspace, "other");
    mkdirSync(otherRoot, { recursive: true });
    const store = PatchStore.open(stateDir);
    const other = createLocalBinding(otherRoot, "2026-10-21T00:00:00Z").binding;
    store.saveBinding(other);
    store.saveReport({
      ...report,
      reportId: "r_" + "1".repeat(24),
      bindingId: other.bindingId,
      generatedAt: "2026-10-21T00:00:00Z",
    });
    assert.equal(store.latestReport()?.bindingId, other.bindingId);
    const result = await runCli(["report", "--cwd", scanRoot, "--state-dir", stateDir, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((JSON.parse(result.stdout) as { reportId: string }).reportId, report.reportId);
  });
  it("prints a human summary", async () => {
    const result = await runCli(["report", "--cwd", scanRoot, "--state-dir", stateDir, "--lang", "en"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Findings: 2/);
    assert.match(result.stdout, /Runner seconds/);
  });

  it("prints HTML with --format html", async () => {
    const result = await runCli(["report", "--cwd", scanRoot, "--state-dir", stateDir, "--format", "html"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^<!doctype html>/);
    assert.match(result.stdout, /CD004|CD008/);
  });

  it("writes HTML to --out", async () => {
    const target = join(workspace, "out", "report.html");
    const result = await runCli(["report", "--cwd", scanRoot, "--state-dir", stateDir, "--format", "html", "--out", target]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Report written to/);
  });

  it("fails without a stored report", async () => {
    const result = await runCli(["report", "--state-dir", join(workspace, "empty")]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No stored report/);
  });

  it("rejects an unknown format", async () => {
    const result = await runCli(["report", "--state-dir", stateDir, "--format", "pdf"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid value for --format/);
  });
});

describe("ci-diet prune", () => {
  it("removes expired reports but keeps fresh ones", async () => {
    const result = await runCli(["prune", "--state-dir", stateDir, "--json"]);
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout) as { removedReports: number; removedPlans: number };
    assert.equal(parsed.removedReports, 1);
    assert.equal(parsed.removedPlans, 0);
    const after = await runCli(["report", "--cwd", scanRoot, "--state-dir", stateDir, "--json"]);
    assert.equal(after.status, 0);
    assert.equal((JSON.parse(after.stdout) as { reportId: string }).reportId, report.reportId);
  });
});
describe("localized rendering", () => {
  it("renders each shipped language with its own lang attribute", async () => {
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

  it("keeps machine codes and numbers untranslated", async () => {
    for (const locale of LOCALES) {
      const html = renderHtmlReport(report, { locale });
      assert.ok(html.includes("MATRIX_EDIT_NOT_SUPPORTED"), "blocker code in " + locale);
      assert.ok(html.includes("CD008"), "rule id in " + locale);
      assert.ok(html.includes("2"), "finding count in " + locale);
    }
  });

  it("prints human findings in every shipped language", async () => {
    for (const locale of LOCALES) {
      const result = await runCli(["report", "--cwd", scanRoot, "--state-dir", stateDir, "--lang", locale]);
      assert.equal(result.status, 0, "exit status for " + locale);
      const title = localizedFinding(report.findings[0]!, locale).title;
      assert.ok(result.stdout.includes(title), "finding title in " + locale + " output: " + result.stdout);
      assert.ok(result.stdout.includes("CD004"), "rule id in " + locale);
    }
  });

  it("writes HTML in the requested language", async () => {
    const target = join(workspace, "out", "report-ko.html");
    const result = await runCli(["report", "--cwd", scanRoot, "--state-dir", stateDir, "--format", "html", "--lang", "ko", "--out", target]);
    assert.equal(result.status, 0);
    const html = readFileSync(target, "utf8");
    assert.match(html, /<html lang="ko">/);
    assert.ok(html.includes(escapeHtml(localizedFinding(report.findings[0]!, "ko").title)));
  });
});