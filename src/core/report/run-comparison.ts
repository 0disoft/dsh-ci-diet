import type { RunComparison } from "../analysis/run-comparison.ts";
import { escapeHtml } from "./html.ts";
import { createTranslator, type Locale } from "../../shared/i18n/index.ts";

/** Standalone, script-free evidence view. Property names stay identical to JSON. */
export function renderRunComparison(report: RunComparison, locale: Locale): string {
  const e = escapeHtml;
  const t = createTranslator(locale);
  const unknown = e(t("ui.cost.unknown"));
  const rows = report.jobs.flatMap((job) => [
    `<tr><th>${e(job.name)}</th><td>${job.beforeSeconds}</td><td>${job.afterSeconds ?? unknown}</td></tr>`,
    ...job.steps.map((step) => `<tr><td>${e(step.name)}</td><td>${step.beforeSeconds}</td><td>${step.afterSeconds ?? unknown}</td></tr>`),
    ...job.addedSteps.map((step) => `<tr><td>+ ${e(step.name)}</td><td>—</td><td>${step.seconds}</td></tr>`),
  ]).join("\n");
  const runLink = (phase: "before" | "after") => {
    const run = report[phase];
    return `<a href="https://github.com/${encodeURIComponent(run.repository.split("/")[0]!)}/${encodeURIComponent(run.repository.split("/")[1]!)}/actions/runs/${run.id}/attempts/${run.attempt}">${phase}: ${run.id} / ${e(run.sha.slice(0, 12))}</a>`;
  };
  return `<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${e(t("report.title"))} — compare</title><style>
:root{color-scheme:light dark}body{font:16px/1.5 system-ui;max-width:1000px;margin:2rem auto;padding:0 1rem}a{color:LinkText}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.5rem;border-bottom:1px solid GrayText}pre{white-space:pre-wrap;overflow-wrap:anywhere}summary{cursor:pointer}li{overflow-wrap:anywhere}
</style><h1>CI Diet · compare</h1><p>${runLink("before")}<br>${runLink("after")}</p>
<h2>${e(t("ui.cost.observedRunnerSeconds"))}: ${report.beforeRunnerSeconds} → ${report.afterRunnerSeconds}</h2>
<p>observedReductionSeconds: ${report.observedReductionSeconds ?? unknown}<br>actualBilledUsd: ${unknown}<br>verifiedCausalSavings: false</p>
<ul>${[...report.blockers, ...report.warnings].map((warning) => "<li>" + e(warning) + "</li>").join("")}</ul>
<table><thead><tr><th>job / step</th><th>beforeSeconds</th><th>afterSeconds</th></tr></thead><tbody>${rows}</tbody></table>
<details><summary>JSON</summary><pre>${e(JSON.stringify(report, null, 2))}</pre></details></html>`;
}
