import type { AnalysisReport, Finding, Metric } from "../contracts/schema.ts";
import { ENGINE_VERSION } from "../version.ts";

export interface HtmlReportOptions {
  readonly title?: string;
  readonly generatedBy?: string;
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

function findingRows(findings: readonly Finding[]): string {
  if (findings.length === 0) return "<p class=empty>No findings in this report.</p>";
  const rows = findings.map((finding) => {
    const blockers = finding.blockers.length === 0 ? "" : finding.blockers.map((blocker) => "<code>" + escapeHtml(blocker) + "</code>").join(" ");
    return [
      "<tr>",
      "<td><code>" + escapeHtml(finding.ruleId) + "</code></td>",
      "<td>" + text(finding.workflowPath) + "</td>",
      "<td>" + text(finding.title) + "</td>",
      "<td>" + escapeHtml(finding.evidenceLevel) + "</td>",
      "<td>" + escapeHtml(finding.patchability) + "</td>",
      "<td>" + (blockers === "" ? "—" : blockers) + "</td>",
      "</tr>",
    ].join("");
  });
  return ["<table class=findings><thead><tr><th>Rule</th><th>Workflow</th><th>Finding</th><th>Evidence</th><th>Patch</th><th>Blockers</th></tr></thead><tbody>", ...rows, "</tbody></table>"].join("\n");
}

function coverageRow(name: string, dimension: { status: string; fetched: number | null; expected: number | null; reasons: readonly string[] }): string {
  const counts = dimension.expected === null ? "" : " (" + String(dimension.fetched ?? 0) + "/" + String(dimension.expected) + ")";
  return (
    "<tr><td>" + escapeHtml(name) + "</td><td>" + escapeHtml(dimension.status + counts) + "</td><td>" + escapeHtml(dimension.reasons.join(", ")) + "</td></tr>"
  );
}

function ruleRows(report: AnalysisReport): string {
  if (report.ruleResults.length === 0) return "<p class=empty>No rule results in this report.</p>";
  return [
    "<table><thead><tr><th>Rule</th><th>Outcome</th><th>Reasons</th></tr></thead><tbody>",
    ...report.ruleResults.map((result) =>
      "<tr><td><code>" + escapeHtml(result.ruleId) + "</code></td><td>" + escapeHtml(result.outcome) + "</td><td>" + escapeHtml(result.reasons.join(", ")) + "</td></tr>",
    ),
    "</tbody></table>",
  ].join("\n");
}

export function renderHtmlReport(report: AnalysisReport, options: HtmlReportOptions = {}): string {
  const title = options.title ?? "CI Diet report";
  const metrics = report.metrics;
  const metricRows: readonly (readonly [string, Metric])[] = [
    ["Observed runner seconds", metrics.observedRunnerSeconds],
    ["Candidate removable seconds", metrics.candidateRemovableSeconds],
    ["Modeled rounded minutes", metrics.modeledRoundedMinutes],
    ["List price (USD)", metrics.listPriceUsd],
    ["Estimated marginal (USD)", metrics.estimatedMarginalUsd],
    ["Actual billed (USD)", metrics.actualBilledUsd],
  ];

  return [
    "<!doctype html>",
    '<html lang="en">',
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
    '<p class="muted">' + escapeHtml(report.provenance) + " report · generated " + escapeHtml(report.generatedAt) + " · engine " + escapeHtml(report.engineVersion) + " · report " + escapeHtml(report.reportId) + "</p>",
    "<h2>Coverage</h2>",
    "<table><thead><tr><th>Axis</th><th>Status</th><th>Reasons</th></tr></thead><tbody>",
    coverageRow("History", report.coverage.history),
    coverageRow("Workflow definitions", report.coverage.workflowDefinitions),
    coverageRow("Changed files", report.coverage.changedFiles),
    coverageRow("Protection rules", report.coverage.protectionRules),
    coverageRow("Retention policy", report.coverage.retentionPolicy),
    "</tbody></table>",
    "<h2>Cost metrics</h2>",
    "<table><thead><tr><th>Metric</th><th>Value</th><th>Basis</th><th>Reason</th></tr></thead><tbody>",
    ...metricRows.map(([label, metric]) => "<tr><td>" + escapeHtml(label) + "</td><td>" + metricCell(metric) + "</td><td>" + escapeHtml(metric.basis) + "</td><td>" + metricReason(metric) + "</td></tr>"),
    "</tbody></table>",
    "<h2>Findings (" + String(report.findings.length) + ")</h2>",
    findingRows(report.findings),
    "<h2>Rule results</h2>",
    ruleRows(report),
    '<p class="note">',
    "Read-only report. CI Diet never edits workflow files from a report; patches are separate plans that require human approval.",
    " Pricing snapshot " + escapeHtml(report.pricingSnapshot.pricingSnapshotId) + " (" + escapeHtml(report.pricingSnapshot.contentHash) + ").",
    " Generated by " + escapeHtml(options.generatedBy ?? "dsh-ci-diet " + ENGINE_VERSION) + ".",
    "</p>",
    "</main></body></html>",
    "",
  ].join("\n");
}
