import * as React from "react";
interface SampleSummary {
  selectedRuns: number; successes: number; meanSuccessfulRunnerSeconds: number | null; successRate: number | null; rerunRate: number | null;
  runs: { id: number; observation: { jobs: { seconds: number }[] } | null }[];
}
interface SavedMeasurement {
  measuredAt: string;
  effect: { changeId: string; comparable: boolean; observedReductionSeconds: number | null; before: SampleSummary; after: SampleSummary; blockers: string[]; warnings: string[] };
}

function validMeasurement(value: unknown, id: string): value is SavedMeasurement {
  try {
    const saved = value as SavedMeasurement, e = saved.effect;
    const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n);
    return typeof saved.measuredAt === "string" && e.changeId === id && typeof e.comparable === "boolean"
      && (e.comparable ? finite(e.observedReductionSeconds) : e.observedReductionSeconds === null)
      && [e.blockers, e.warnings].every((xs) => Array.isArray(xs) && xs.every((x) => typeof x === "string"))
      && [e.before, e.after].every((s) => Number.isSafeInteger(s.selectedRuns) && s.selectedRuns >= 1 && s.selectedRuns <= 10
        && Number.isSafeInteger(s.successes) && s.successes >= 0 && s.successes <= s.selectedRuns
        && [s.meanSuccessfulRunnerSeconds, s.successRate, s.rerunRate].every((n) => n === null || finite(n))
        && Array.isArray(s.runs) && s.runs.length <= 10 && s.runs.every((r) => Number.isSafeInteger(r.id) && r.id > 0
          && (r.observation === null || (Array.isArray(r.observation.jobs) && r.observation.jobs.length <= 1000
            && r.observation.jobs.every((j) => finite(j.seconds) && j.seconds >= 0)))));
  } catch { return false; }
}

type Translate = (key: string, params?: Record<string, string | number>) => string;
type Phase = "before" | "after";

export function selectedRunIds(text: string): number[] | null {
  if (!/^\s*[1-9]\d*(?:\s*,\s*[1-9]\d*){0,9}\s*$/.test(text)) return null;
  const ids = text.split(",").map(Number);
  return ids.every(Number.isSafeInteger) && new Set(ids).size === ids.length ? ids : null;
}

/** Sample order is user-selected, never presented as a causal time series. */
export function measurementView(props: {
  id: string; state: string; measurement: unknown; before: string; after: string; busy: boolean; networkEnabled: boolean;
  t: Translate; edit(phase: Phase, text: string): void; measure(before: number[], after: number[]): void;
}): unknown {
  const { t } = props, h = React.createElement;
  const before = selectedRunIds(props.before), after = selectedRunIds(props.after);
  const saved = validMeasurement(props.measurement, props.id) ? props.measurement : null;
  const fields = (["before", "after"] as const).map((phase) => h("label", { key: phase, className: "ci-diet-label" },
    t("measure." + phase), h("input", { type: "text", maxLength: 220, value: props[phase], disabled: props.busy,
      "aria-label": t("measure." + phase) + " " + props.id, placeholder: "100,101", className: "ci-diet-input",
      onChange: (event: { target: { value: string } }) => props.edit(phase, event.target.value) })));
  const details: unknown[] = [];
  if (saved === null) details.push(h("p", { key: "empty", className: "ci-diet-group-desc" }, t("measure.empty")));
  else {
    const effect = saved.effect;
    details.push(h("p", { key: "at", className: "ci-diet-group-desc" }, saved.measuredAt));
    if (!effect.comparable) details.push(h("p", { key: "blocked", role: "status" }, t("measure.blocked") + ": " + effect.blockers.join(", ")));
    else details.push(h("strong", { key: "delta" }, t("measure.delta") + ": " + effect.observedReductionSeconds?.toFixed(1) + " s"));
    for (const phase of ["before", "after"] as const) {
      const summary = effect[phase];
      details.push(h("p", { key: phase, className: "ci-diet-group-desc" },
        t("measure." + phase) + " · " + t("measure.mean") + ": " + (effect.comparable ? summary.meanSuccessfulRunnerSeconds?.toFixed(1) ?? "—" : "—") + " s · "
        + t("measure.success") + ": " + ((summary.successRate ?? 0) * 100).toFixed(0) + "% (" + summary.successes + "/" + summary.selectedRuns + ") · "
        + t("measure.rerun") + ": " + ((summary.rerunRate ?? 0) * 100).toFixed(0) + "% (n=" + summary.selectedRuns + ")"));
    }
    const series = (["before", "after"] as const).map((phase) => ({ phase, points: effect[phase].runs.flatMap((run) =>
      run.observation === null ? [] : [{ id: run.id, seconds: run.observation.jobs.reduce((sum, job) => sum + job.seconds, 0) }]) }));
    const max = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.seconds)));
    if (effect.comparable) details.push(h("svg", { key: "chart", viewBox: "0 0 320 90", role: "img", "aria-label": t("measure.samples"),
      style: { width: "100%", maxWidth: "480px", height: "100px" } }, h("title", null, t("measure.samples")),
      ...series.map(({ phase, points }) => h("g", { key: phase, opacity: phase === "before" ? 0.45 : 1 },
        h("polyline", { points: points.map((p, i) => (10 + i * 300 / Math.max(1, points.length - 1)) + "," + (80 - p.seconds / max * 70)).join(" "),
          fill: "none", stroke: "currentColor", strokeWidth: 2, strokeDasharray: phase === "before" ? "4 3" : undefined }),
        ...points.map((p, i) => h("circle", { key: p.id, cx: 10 + i * 300 / Math.max(1, points.length - 1), cy: 80 - p.seconds / max * 70, r: 3, fill: "currentColor" },
          h("title", null, t("measure." + phase) + " #" + p.id + ": " + p.seconds + " s")))))));
    details.push(h("p", { key: "samples", className: "ci-diet-group-desc" }, t("measure.samples") + " · "
      + series.map((s) => t("measure." + s.phase) + ": " + s.points.map((p) => "#" + p.id + " " + p.seconds + " s").join(", ")).join(" / ")));
    details.push(h("details", { key: "warnings" }, h("summary", null, t("measure.limits")),
      h("p", { className: "ci-diet-group-desc" }, effect.warnings.join(" · "))));
  }
  return h("section", { className: "ci-diet-review-measurement", "aria-label": t("measure.title") },
    h("h3", { className: "ci-diet-review-subhead" }, t("measure.title")),
    h("p", { className: "ci-diet-group-desc" }, t("measure.hint")), ...details, ...fields,
    h("p", { className: "ci-diet-group-desc" }, t(props.networkEnabled ? "measure.network" : "measure.off")),
    h("button", { type: "button", className: "ci-diet-save", disabled: props.busy || !props.networkEnabled || props.state !== "APPLIED"
      || before === null || after === null || new Set([...(before ?? []), ...(after ?? [])]).size !== (before?.length ?? 0) + (after?.length ?? 0),
      onClick: () => { if (before && after) props.measure(before, after); } }, t("measure.action")));
}
