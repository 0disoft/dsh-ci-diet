import type { AnalysisReport, Finding, Metric } from "../contracts/schema.ts";
import { t, type Locale } from "../../shared/i18n/index.ts";
import { ENGINE_VERSION } from "../version.ts";
import { localizedFinding } from "./localize.ts";

export interface HtmlReportOptions {
  readonly title?: string;
  readonly generatedBy?: string;
  readonly locale?: Locale;
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

function text(value: string | null | undefined): string {
  return value === null || value === undefined ? "—" : escapeHtml(value);
}

function metricCell(metric: Metric): string {
  if (metric.status === "known") return escapeHtml(String(metric.value));
  return "<span class=unknown>" + escapeHtml(metric.status) + "</span>";
}

function metricReason(metric: Metric): string {
  return metric.reason === null ? "" : escapeHtml(metric.reason);
}

function findingRows(findings: readonly Finding[], locale: Locale): string {
  if (findings.length === 0) return "<p class=empty>" + escapeHtml(t("report.noFindings", undefined, locale)) + "</p>";
  const rows = findings.map((finding) => {
    const blockers = finding.blockers.length === 0 ? "" : finding.blockers.map((blocker) => "<code>" + escapeHtml(blocker) + "</code>").join(" ");
    return [
      "<tr>",
      "<td><code>" + escapeHtml(finding.ruleId) + "</code></td>",
      "<td>" + text(finding.workflowPath) + "</td>",
      "<td>" + text(localizedFinding(finding, locale).title) + "</td>",
      "<td>" + escapeHtml(finding.evidenceLevel) + "</td>",
      "<td>" + escapeHtml(finding.patchability) + "</td>",
      "<td>" + (blockers === "" ? "—" : blockers) + "</td>",
      "</tr>",
    ].join("");
  });
  const headers = [
    t("report.rule", undefined, locale),
    t("report.workflow", undefined, locale),
    t("report.finding", undefined, locale),
    t("report.evidence", undefined, locale),
    t("report.patch", undefined, locale),
    t("report.blockers", undefined, locale),
  ].map((label) => "<th>" + escapeHtml(label) + "</th>").join("");
  return ["<table class=findings><thead><tr>" + headers + "</tr></thead><tbody>", ...rows, "</tbody></table>"].join("\n");
}

function coverageRow(name: string, dimension: { status: string; fetched: number | null; expected: number | null; reasons: readonly string[] }): string {
  const counts = dimension.expected === null ? "" : " (" + String(dimension.fetched ?? 0) + "/" + String(dimension.expected) + ")";
  return (
    "<tr><td>" + escapeHtml(name) + "</td><td>" + escapeHtml(dimension.status + counts) + "</td><td>" + escapeHtml(dimension.reasons.join(", ")) + "</td></tr>"
  );
}

function ruleRows(report: AnalysisReport, locale: Locale): string {
  if (report.ruleResults.length === 0) return "<p class=empty>" + escapeHtml(t("report.noRuleResults", undefined, locale)) + "</p>";
  return [
    "<table><thead><tr><th>" + escapeHtml(t("report.rule", undefined, locale)) + "</th><th>" + escapeHtml(t("report.outcome", undefined, locale)) + "</th><th>" + escapeHtml(t("report.reasons", undefined, locale)) + "</th></tr></thead><tbody>",
    ...report.ruleResults.map((result) =>
      "<tr><td><code>" + escapeHtml(result.ruleId) + "</code></td><td>" + escapeHtml(result.outcome) + "</td><td>" + escapeHtml(result.reasons.join(", ")) + "</td></tr>",
    ),
    "</tbody></table>",
  ].join("\n");
}

export function renderHtmlReport(report: AnalysisReport, options: HtmlReportOptions = {}): string {
  const locale = options.locale ?? "en";
  const title = options.title ?? t("report.title", undefined, locale);
  const metrics = report.metrics;
  const metricRows: readonly (readonly [string, Metric])[] = [
    [t("metric.observedRunnerSeconds", undefined, locale), metrics.observedRunnerSeconds],
    [t("metric.candidateRemovableSeconds", undefined, locale), metrics.candidateRemovableSeconds],
    [t("metric.modeledRoundedMinutes", undefined, locale), metrics.modeledRoundedMinutes],
    [t("metric.listPriceUsd", undefined, locale), metrics.listPriceUsd],
    [t("metric.estimatedMarginalUsd", undefined, locale), metrics.estimatedMarginalUsd],
    [t("metric.actualBilledUsd", undefined, locale), metrics.actualBilledUsd],
  ];
  const provenance = t("report.provenance", {
    provenance: report.provenance,
    generatedAt: report.generatedAt,
    engine: report.engineVersion,
    reportId: report.reportId,
  }, locale);

  return [
    "<!doctype html>",
    '<html lang="' + escapeHtml(locale) + '">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>" + escapeHtml(title) + "</title>",
    "<style>",
    ":root{color-scheme:light dark;--fg:#1f2328;--muted:#59636e;--line:#d1d9e0;--bg:#ffffff;--accent:#0969da}",
    "@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#9198a1;--line:#3d444d;--bg:#0d1117;--accent:#4493f8}}",
    "body{margin:0;padding:32px;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}",
    "main{max-width:1080px;margin:0 auto}",
    "h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}",
    "p{margin:4px 0}.muted{color:var(--muted)}code{font:12px ui-monospace,SFMono-Regular,Consolas,monospace;background:color-mix(in srgb,var(--fg) 8%,transparent);padding:1px 4px;border-radius:4px}",
    "table{border-collapse:collapse;width:100%;margin:8px 0}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}",
    "th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}",
    ".unknown{color:var(--muted);font-style:italic}.empty{color:var(--muted)}",
    ".note{margin-top:32px;padding-top:8px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}",
    "</style>",
    "</head>",
    "<body><main>",
    "<h1>" + escapeHtml(title) + "</h1>",
    '<p class="muted">' + escapeHtml(provenance) + "</p>",
    "<h2>" + escapeHtml(t("report.coverage", undefined, locale)) + "</h2>",
    "<table><thead><tr><th>" + escapeHtml(t("report.axis", undefined, locale)) + "</th><th>" + escapeHtml(t("report.status", undefined, locale)) + "</th><th>" + escapeHtml(t("report.reasons", undefined, locale)) + "</th></tr></thead><tbody>",
    coverageRow(t("report.axis.history", undefined, locale), report.coverage.history),
    coverageRow(t("report.axis.workflowDefinitions", undefined, locale), report.coverage.workflowDefinitions),
    coverageRow(t("report.axis.changedFiles", undefined, locale), report.coverage.changedFiles),
    coverageRow(t("report.axis.protectionRules", undefined, locale), report.coverage.protectionRules),
    coverageRow(t("report.axis.retentionPolicy", undefined, locale), report.coverage.retentionPolicy),
    "</tbody></table>",
    "<h2>" + escapeHtml(t("report.costMetrics", undefined, locale)) + "</h2>",
    "<table><thead><tr><th>" + escapeHtml(t("report.metric", undefined, locale)) + "</th><th>" + escapeHtml(t("report.value", undefined, locale)) + "</th><th>" + escapeHtml(t("report.basis", undefined, locale)) + "</th><th>" + escapeHtml(t("report.reason", undefined, locale)) + "</th></tr></thead><tbody>",
    ...metricRows.map(([label, metric]) => "<tr><td>" + escapeHtml(label) + "</td><td>" + metricCell(metric) + "</td><td>" + escapeHtml(metric.basis) + "</td><td>" + metricReason(metric) + "</td></tr>"),
    "</tbody></table>",
    "<h2>" + escapeHtml(t("report.findings", { count: report.findings.length }, locale)) + "</h2>",
    findingRows(report.findings, locale),
    "<h2>" + escapeHtml(t("report.ruleResults", undefined, locale)) + "</h2>",
    ruleRows(report, locale),
    '<p class="note">',
    escapeHtml(t("report.note", {
      snapshot: report.pricingSnapshot.pricingSnapshotId,
      hash: report.pricingSnapshot.contentHash,
      generator: options.generatedBy ?? "dsh-ci-diet " + ENGINE_VERSION,
    }, locale)),
    "</p>",
    "</main></body></html>",
    "",
  ].join("\n");
}
