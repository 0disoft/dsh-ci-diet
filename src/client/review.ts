/** DSH report and approval page for CI Diet.
 *
 * This surface only presents host results and asks for intent. The host owns
 * session identity, digest checks, approval nonces, source checks, and writes.
 */
import * as React from "react";
import { REVIEW_DICTIONARIES, REVIEW_NS } from "./review-i18n.ts";

type ReviewAction = "load" | "approve" | "apply" | "revert";
type ReviewResult = { ok: true; value: unknown } | { ok: false; error: { message: string } };
type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface ReviewContext {
  readonly connection: {
    readonly rpc: {
      call(channel: string, endpoint: string, payload: unknown): Promise<ReviewResult>;
    };
  };
  useSessionId(): string | undefined;
  readonly locale?: {
    bind(namespace: string): (key: string) => string;
  };
}

type MetricStatus = "known" | "unknown" | "not_applicable";

export interface ReviewMetric {
  readonly status: MetricStatus;
  readonly value: number | string | null;
  readonly basis: string;
  readonly reason: string | null;
}

interface CoverageDimension {
  readonly status: "complete" | "partial" | "unavailable";
  readonly reasons: readonly string[];
}

interface ReviewCoverage {
  readonly apiVersion: string;
  readonly ghVersion: string;
  readonly requestedFrom: string;
  readonly requestedTo: string;
  readonly history: CoverageDimension;
  readonly workflowDefinitions: CoverageDimension;
  readonly changedFiles: CoverageDimension;
  readonly protectionRules: CoverageDimension;
  readonly retentionPolicy: CoverageDimension;
}

interface ReviewFinding {
  readonly ruleId: string;
  readonly title: string;
  readonly renderedText: string;
  readonly workflowPath: string;
}

interface ReviewReport {
  readonly reportId: string;
  readonly generatedAt: string;
  readonly findings: readonly ReviewFinding[];
  readonly coverage: ReviewCoverage;
  readonly metrics: Readonly<Record<string, ReviewMetric | null>>;
}

interface ReviewDiffLine {
  readonly kind: "context" | "removed" | "added";
  readonly text: string;
}

interface ReviewPlan {
  readonly id: string;
  readonly digest: string;
  readonly workflowPath: string;
  readonly ruleId: string;
  readonly state: string;
  readonly expiresAt: string;
  readonly approvalExpiresAt: string;
  readonly sourceValid: boolean;
  readonly blockers: readonly string[];
  readonly diff: readonly ReviewDiffLine[];
}

interface ReviewChange {
  readonly changeId: string;
  readonly workflowPath: string;
  readonly state: string;
}

export interface ReviewData {
  readonly root: string;
  readonly bindingId: string | null;
  readonly localApplyEnabled: boolean;
  readonly report: ReviewReport | null;
  readonly plans: readonly ReviewPlan[];
  readonly changes: readonly ReviewChange[];
}

interface ActionFeedback {
  readonly state: string;
  readonly reasons: readonly string[];
}

const EN = REVIEW_DICTIONARIES.en as Record<string, string>;
const METRIC_KEYS = [
  "observedRunnerSeconds",
  "candidateRemovableSeconds",
  "modeledRoundedMinutes",
  "listPriceUsd",
  "estimatedMarginalUsd",
  "actualBilledUsd",
  "queueSeconds",
  "executionSpanSeconds",
  "criticalPathWorkSeconds",
  "estimatedUserWaitReductionSeconds",
] as const;
const COVERAGE_KEYS = [
  "history",
  "workflowDefinitions",
  "changedFiles",
  "protectionRules",
  "retentionPolicy",
] as const;

function translateWith(dictionary: Record<string, string>, bound?: (key: string) => string): Translate {
  return (key, params = {}) => {
    const template = bound?.(key) ?? dictionary[key] ?? EN[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? ""));
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textOf(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function metricStatus(value: unknown): MetricStatus {
  return value === "known" || value === "not_applicable" ? value : "unknown";
}

function normalizeMetric(value: unknown): ReviewMetric | null {
  if (!isRecord(value)) return null;
  const raw = value.value;
  return {
    status: metricStatus(value.status),
    value: typeof raw === "number" || typeof raw === "string" || raw === null ? raw : null,
    basis: textOf(value.basis),
    reason: value.reason === null ? null : typeof value.reason === "string" ? value.reason : null,
  };
}

function normalizeDimension(value: unknown): CoverageDimension {
  if (!isRecord(value)) return { status: "unavailable", reasons: [] };
  const status = value.status === "complete" || value.status === "partial" ? value.status : "unavailable";
  return { status, reasons: stringsOf(value.reasons) };
}

function normalizeCoverage(value: unknown): ReviewCoverage {
  const coverage = isRecord(value) ? value : {};
  return {
    apiVersion: textOf(coverage.apiVersion),
    ghVersion: textOf(coverage.ghVersion),
    requestedFrom: textOf(coverage.requestedFrom),
    requestedTo: textOf(coverage.requestedTo),
    history: normalizeDimension(coverage.history),
    workflowDefinitions: normalizeDimension(coverage.workflowDefinitions),
    changedFiles: normalizeDimension(coverage.changedFiles),
    protectionRules: normalizeDimension(coverage.protectionRules),
    retentionPolicy: normalizeDimension(coverage.retentionPolicy),
  };
}

function normalizeReport(value: unknown): ReviewReport | null {
  if (!isRecord(value)) return null;
  const findings = Array.isArray(value.findings)
    ? value.findings.flatMap((item): ReviewFinding[] => {
        if (!isRecord(item)) return [];
        return [{
          ruleId: textOf(item.ruleId, "?"),
          title: textOf(item.title, textOf(item.ruleId, "?")),
          renderedText: textOf(item.renderedText),
          workflowPath: textOf(item.workflowPath),
        }];
      })
    : [];
  const rawMetrics = isRecord(value.metrics) ? value.metrics : {};
  const metrics: Record<string, ReviewMetric | null> = {};
  for (const key of METRIC_KEYS) metrics[key] = normalizeMetric(rawMetrics[key]);
  return {
    reportId: textOf(value.reportId),
    generatedAt: textOf(value.generatedAt),
    findings,
    coverage: normalizeCoverage(value.coverage),
    metrics,
  };
}

function normalizePlan(value: unknown): ReviewPlan | null {
  if (!isRecord(value)) return null;
  const id = textOf(value.id);
  if (id.length === 0) return null;
  const diff = Array.isArray(value.diff)
    ? value.diff.flatMap((line): ReviewDiffLine[] => {
        if (!isRecord(line)) return [];
        const kind = line.kind === "removed" || line.kind === "added" ? line.kind : "context";
        return [{ kind, text: textOf(line.text) }];
      })
    : [];
  return {
    id,
    digest: textOf(value.digest),
    workflowPath: textOf(value.workflowPath),
    ruleId: textOf(value.ruleId),
    state: textOf(value.state, "unknown"),
    expiresAt: textOf(value.expiresAt),
    approvalExpiresAt: textOf(value.approvalExpiresAt),
    sourceValid: value.sourceValid === true,
    blockers: stringsOf(value.blockers),
    diff,
  };
}

function normalizeChange(value: unknown): ReviewChange | null {
  if (!isRecord(value)) return null;
  const changeId = textOf(value.changeId);
  if (changeId.length === 0) return null;
  return {
    changeId,
    workflowPath: textOf(value.workflowPath),
    state: textOf(value.state, "unknown"),
  };
}

function normalizeReview(value: unknown): ReviewData | null {
  if (!isRecord(value) || typeof value.root !== "string") return null;
  return {
    root: value.root,
    bindingId: typeof value.bindingId === "string" ? value.bindingId : null,
    localApplyEnabled: value.localApplyEnabled === true,
    report: normalizeReport(value.report),
    plans: Array.isArray(value.plans)
      ? value.plans.flatMap((item): ReviewPlan[] => {
          const plan = normalizePlan(item);
          return plan === null ? [] : [plan];
        })
      : [],
    changes: Array.isArray(value.changes)
      ? value.changes.flatMap((item): ReviewChange[] => {
          const change = normalizeChange(item);
          return change === null ? [] : [change];
        })
      : [],
  };
}

function actionFeedback(value: unknown, t: Translate): ActionFeedback {
  if (!isRecord(value)) return { state: t("metric.unknown"), reasons: [t("page.malformed")] };
  const state = textOf(value.state, t("metric.unknown"));
  const reasons = stringsOf(value.reasons);
  if (typeof value.reason === "string" && value.reason.length > 0 && !reasons.includes(value.reason)) {
    reasons.push(value.reason);
  }
  if (reasons.length === 0 && typeof value.message === "string" && value.message.length > 0) reasons.push(value.message);
  return { state, reasons };
}

function deniedState(state: string): boolean {
  return /denied|refus|block|fail|error|conflict|recovery/i.test(state);
}

function digestSuffix(digest: string): string {
  return digest.slice(-12);
}

function planExpired(expiresAt: string): boolean {
  const timestamp = Date.parse(expiresAt);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function metricValue(metric: ReviewMetric | null | undefined, key: string, t: Translate): string {
  if (metric === undefined || metric === null || metric.status !== "known" || metric.value === null) {
    return t("metric.noValue");
  }
  const unit = key === "modeledRoundedMinutes"
    ? t("unit.minutes")
    : key === "listPriceUsd" || key === "estimatedMarginalUsd" || key === "actualBilledUsd"
      ? t("unit.usd")
      : t("unit.seconds");
  return String(metric.value) + " " + unit;
}

function metricStatusKey(metric: ReviewMetric | null | undefined): "metric.known" | "metric.unknown" | "metric.notApplicable" {
  if (metric?.status === "known") return "metric.known";
  if (metric?.status === "not_applicable") return "metric.notApplicable";
  return "metric.unknown";
}

function coverageStatusKey(status: string): "status.complete" | "status.partial" | "status.unavailable" {
  if (status === "complete") return "status.complete";
  if (status === "partial") return "status.partial";
  return "status.unavailable";
}

function metaRow(label: string, value: string, key: string): unknown {
  return [
    React.createElement("span", { key: key + "-key", className: "ci-diet-meta-key" }, label),
    React.createElement("span", { key: key + "-value", className: "ci-diet-review-wrap" }, value),
  ];
}

function notice(title: string, body: string): unknown {
  return React.createElement(
    "div",
    { className: "ci-diet-notice" },
    React.createElement("h2", { className: "ci-diet-group-title" }, title),
    React.createElement("p", { className: "ci-diet-group-desc" }, body),
  );
}

function metricCard(metricKey: string, metric: ReviewMetric | null | undefined, t: Translate): unknown {
  const statusKey = metricStatusKey(metric);
  return React.createElement(
    "div",
    { key: metricKey, className: "ci-diet-review-metric" },
    React.createElement(
      "div",
      { className: "ci-diet-review-metric-head" },
      React.createElement("span", { className: "ci-diet-label" }, t("metric." + metricKey)),
      React.createElement("span", { className: "ci-diet-review-badge status-" + (metric?.status ?? "unknown") }, t(statusKey)),
    ),
    React.createElement("div", { className: "ci-diet-review-metric-value" }, metricValue(metric, metricKey, t)),
    React.createElement(
      "div",
      { className: "ci-diet-review-metric-detail" },
      React.createElement("span", null, t("metric.basis") + ": " + (metric?.basis || t("metric.none"))),
      React.createElement("span", null, t("metric.reason") + ": " + (metric?.reason || t("metric.none"))),
    ),
  );
}

export function ReviewPage(props: { ctx: ReviewContext }): unknown {
  const { ctx } = props;
  const t = translateWith(REVIEW_DICTIONARIES.en, ctx.locale?.bind(REVIEW_NS));
  const sessionId = ctx.useSessionId();
  const [phase, setPhase] = React.useState<"loading" | "ready" | "no-session" | "error">(
    sessionId === undefined ? "no-session" : "loading",
  );
  const [data, setData] = React.useState<ReviewData | null>(null);
  const [loadedSessionId, setLoadedSessionId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [feedback, setFeedback] = React.useState<ActionFeedback | null>(null);
  const [confirmations, setConfirmations] = React.useState<Record<string, string>>({});
  const [revertId, setRevertId] = React.useState("");
  const generationRef = React.useRef(0);
  const [, tick] = React.useState(0);
  React.useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  async function load(currentSession: string, generation: number, preserveError = false): Promise<void> {
    if (generationRef.current !== generation) return;
    setRefreshing(true);
    try {
      const response = await ctx.connection.rpc.call("/api", "ci-diet-review", {
        action: "load",
        sessionId: currentSession,
      });
      if (generationRef.current !== generation) return;
      if (!response.ok) {
        setData(null);
        setPhase("error");
        setError(response.error.message || t("page.loadFailed"));
        return;
      }
      const next = normalizeReview(response.value);
      if (next === null) {
        setData(null);
        setPhase("error");
        setError(t("page.malformed"));
        return;
      }
      setData(next);
      setLoadedSessionId(currentSession);
      setPhase("ready");
      if (!preserveError) setError(null);
    } catch (cause) {
      if (generationRef.current !== generation) return;
      setData(null);
      setPhase("error");
      setError(cause instanceof Error && cause.message.length > 0 ? cause.message : t("page.loadFailed"));
    } finally {
      if (generationRef.current === generation) setRefreshing(false);
    }
  }

  React.useEffect(() => {
    const generation = ++generationRef.current;
    setData(null);
    setLoadedSessionId(null);
    setError(null);
    setBusy(false);
    setRefreshing(false);
    setFeedback(null);
    setConfirmations({});
    setRevertId("");
    if (sessionId === undefined) {
      setPhase("no-session");
      return () => {
        if (generationRef.current === generation) generationRef.current += 1;
      };
    }
    setPhase("loading");
    void load(sessionId, generation);
    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [sessionId]);

  async function perform(action: ReviewAction, id?: string, confirmation?: string): Promise<void> {
    if (busy || sessionId === undefined) return;
    const generation = generationRef.current;
    setBusy(true);
    setError(null);
    setFeedback({ state: "running", reasons: [] });
    let preserveError = false;
    try {
      const payload: Record<string, unknown> = { action, sessionId };
      if (id !== undefined) payload.id = id;
      if (confirmation !== undefined) payload.confirmation = confirmation;
      const response = await ctx.connection.rpc.call("/api", "ci-diet-review", payload);
      if (generationRef.current !== generation) return;
      if (!response.ok) {
        preserveError = true;
        const message = response.error.message || t("page.loadFailed");
        setError(message);
        setFeedback({ state: "error", reasons: [message] });
      } else {
        setFeedback(actionFeedback(response.value, t));
      }
    } catch (cause) {
      if (generationRef.current !== generation) return;
      preserveError = true;
      const message = cause instanceof Error && cause.message.length > 0 ? cause.message : t("page.loadFailed");
      setError(message);
      setFeedback({ state: "error", reasons: [message] });
    }
    if (generationRef.current === generation) await load(sessionId, generation, preserveError);
    if (generationRef.current === generation) setBusy(false);
  }

  function refresh(): void {
    if (sessionId === undefined || busy) return;
    const generation = ++generationRef.current;
    setError(null);
    setPhase("loading");
    void load(sessionId, generation);
  }

  const bodyChildren: unknown[] = [
    React.createElement("h1", { key: "title", className: "ci-diet-title" }, t("page.title")),
    React.createElement("p", { key: "intro", className: "ci-diet-intro" }, t("page.intro")),
  ];

  if (feedback !== null && loadedSessionId === sessionId) {
    const isDenied = deniedState(feedback.state);
    bodyChildren.push(React.createElement(
      "div",
      {
        key: "feedback",
        className: "ci-diet-review-feedback" + (isDenied ? " is-error" : ""),
        role: isDenied ? "alert" : "status",
        "aria-live": "polite",
      },
      React.createElement(
        "strong",
        null,
        feedback.state === "running"
          ? t("action.running")
          : t(isDenied ? "action.denied" : "action.completed", { state: feedback.state }),
      ),
      feedback.reasons.length > 0
        ? React.createElement(
            "ul",
            { className: "ci-diet-review-reasons" },
            feedback.reasons.map((reason, index) => React.createElement("li", { key: index }, reason)),
          )
        : null,
    ));
  }

  if (error !== null) {
    bodyChildren.push(React.createElement("div", { key: "error", className: "ci-diet-review-error", role: "alert" }, error));
  }

  const visibleData = data !== null && loadedSessionId === sessionId ? data : null;
  if (sessionId === undefined) {
    bodyChildren.push(React.createElement("div", { key: "no-session" }, notice(t("page.noSessionTitle"), t("page.noSessionBody"))));
  } else if (visibleData === null && (phase === "loading" || data !== null)) {
    bodyChildren.push(React.createElement("div", { key: "loading", className: "ci-diet-notice" }, t("page.loading")));
  } else if (visibleData === null) {
    bodyChildren.push(React.createElement("div", { key: "failed" }, notice(t("page.noReportTitle"), t("page.noReportBody"))));
  } else {
    const review = visibleData;
    bodyChildren.push(React.createElement(
      "div",
      { key: "meta", className: "ci-diet-meta" },
      metaRow(t("page.workspace"), review.root, "root"),
      metaRow(t("page.binding"), review.bindingId ?? t("plan.none"), "binding"),
      metaRow(t("page.localApply"), review.localApplyEnabled ? t("page.on") : t("page.off"), "apply"),
    ));

    if (!review.localApplyEnabled) {
      bodyChildren.push(React.createElement(
        "div",
        { key: "apply-hint", className: "ci-diet-review-local-hint", role: "note" },
        t("page.localApplyHint"),
      ));
    }

    if (review.report === null) {
      bodyChildren.push(React.createElement("div", { key: "no-report" }, notice(t("page.noReportTitle"), t("page.noReportBody"))));
    } else {
      const report = review.report;
      const findings = report.findings.length === 0
        ? React.createElement("p", { className: "ci-diet-group-desc" }, t("findings.empty"))
        : report.findings.map((finding, index) => React.createElement(
            "article",
            { key: finding.ruleId + ":" + finding.workflowPath + ":" + index, className: "ci-diet-review-finding" },
            React.createElement(
              "div",
              { className: "ci-diet-badge" },
              React.createElement("span", null, finding.ruleId),
              React.createElement("span", null, finding.workflowPath),
            ),
            React.createElement("h3", { className: "ci-diet-group-title" }, finding.title),
            React.createElement("p", { className: "ci-diet-review-prose" }, finding.renderedText),
          ));
      const gaps = COVERAGE_KEYS
        .map((key) => ({ key, dimension: report.coverage[key] }))
        .filter((entry) => entry.dimension.status !== "complete");
      const coverage = gaps.length === 0
        ? React.createElement("p", { className: "ci-diet-group-desc" }, t("coverage.complete"))
        : gaps.map(({ key, dimension }) => React.createElement(
            "div",
            { key, className: "ci-diet-review-gap" },
            React.createElement(
              "div",
              { className: "ci-diet-review-gap-head" },
              React.createElement("span", { className: "ci-diet-label" }, t("coverage." + key)),
              React.createElement("span", { className: "ci-diet-review-badge" }, t(coverageStatusKey(dimension.status))),
            ),
            dimension.reasons.length === 0
              ? React.createElement("span", { className: "ci-diet-group-desc" }, t("coverage.noReason"))
              : React.createElement(
                  "ul",
                  { className: "ci-diet-review-reasons" },
                  dimension.reasons.map((reason, index) => React.createElement("li", { key: index }, reason)),
                ),
          ));
      bodyChildren.push(React.createElement(
        "section",
        { key: "report", className: "ci-diet-group" },
        React.createElement(
          "div",
          { className: "ci-diet-group-head" },
          React.createElement("h2", { className: "ci-diet-group-title" }, t("page.title")),
          React.createElement("p", { className: "ci-diet-group-desc" }, t("report.generated") + ": " + report.generatedAt),
          React.createElement("p", { className: "ci-diet-group-desc ci-diet-review-wrap" }, t("report.id") + ": " + report.reportId),
        ),
        React.createElement("h3", { className: "ci-diet-review-subhead" }, t("findings.title")),
        findings,
        React.createElement("h3", { className: "ci-diet-review-subhead" }, t("coverage.title")),
        coverage,
        React.createElement("h3", { className: "ci-diet-review-subhead" }, t("metrics.title")),
        React.createElement(
          "div",
          { className: "ci-diet-review-metrics" },
          METRIC_KEYS.map((key) => metricCard(key, report.metrics[key], t)),
        ),
      ));
    }

    const plans = review.plans.length === 0
      ? React.createElement("p", { className: "ci-diet-group-desc" }, t("page.noPlans"))
      : review.plans.map((plan) => {
          const entered = confirmations[plan.id] ?? "";
          const suffix = digestSuffix(plan.digest);
          const digestMatches = suffix.length > 0 && entered.trim() === suffix;
          const expired = planExpired(plan.expiresAt);
          const approvalExpired = plan.state === "approved" && planExpired(plan.approvalExpiresAt);
          const approvalBlocked = expired
            || (plan.state === "approved" && !approvalExpired)
            || !plan.sourceValid
            || plan.blockers.length > 0
            || !review.localApplyEnabled;
          const approveDisabled = busy || approvalBlocked || !digestMatches;
          const confirmDisabled = busy || approvalBlocked;
          const canApply = !busy && !expired && !approvalExpired && plan.state === "approved" && plan.sourceValid && plan.blockers.length === 0 && review.localApplyEnabled;
          const applyReason = !review.localApplyEnabled
            ? t("plan.localApplyOff")
            : expired
              ? t("plan.expired")
            : !plan.sourceValid
              ? t("plan.sourceBlocked")
              : plan.blockers.length > 0
                ? t("plan.blocked")
                : approvalExpired
                  ? t("plan.approvalExpired")
                : plan.state !== "approved"
                  ? t("plan.needsApproval")
                  : null;
          return React.createElement(
            "article",
            { key: plan.id, className: "ci-diet-review-plan" },
            React.createElement(
              "div",
              { className: "ci-diet-review-plan-head" },
              React.createElement("h3", { className: "ci-diet-group-title" }, plan.ruleId + " · " + plan.workflowPath),
              React.createElement(
                "div",
                { className: "ci-diet-badge" },
                React.createElement("span", null, t("plan.state") + ": " + plan.state),
                React.createElement(
                  "span",
                  { className: "ci-diet-review-badge " + (plan.sourceValid ? "status-complete" : "status-unavailable") },
                  t(plan.sourceValid ? "plan.sourceValid" : "plan.sourceChanged"),
                ),
              ),
            ),
            React.createElement("p", { className: "ci-diet-group-desc ci-diet-review-wrap" }, t("plan.digest") + ": " + plan.digest),
            React.createElement("p", { className: "ci-diet-group-desc" }, t("plan.expires") + ": " + plan.expiresAt),
            approvalExpired ? React.createElement("p", { role: "status" }, t("plan.approvalExpired")) : null,
            React.createElement(
              "div",
              { className: "ci-diet-review-blockers" },
              React.createElement("span", { className: "ci-diet-label" }, t("plan.blockers")),
              plan.blockers.length === 0
                ? React.createElement("span", { className: "ci-diet-group-desc" }, t("plan.none"))
                : React.createElement(
                    "ul",
                    { className: "ci-diet-review-reasons" },
                    plan.blockers.map((blocker, index) => React.createElement("li", { key: index }, blocker)),
                  ),
            ),
            React.createElement(
              "pre",
              { className: "ci-diet-review-diff", "aria-label": t("plan.workflow") },
              plan.diff.length === 0
                ? React.createElement("span", { className: "diff-context" }, t("plan.none"))
                : plan.diff.map((line, index) => React.createElement(
                    "span",
                    { key: index, className: "diff-" + line.kind },
                    (line.kind === "removed" ? "- " : line.kind === "added" ? "+ " : "  ") + line.text + "\n",
                  )),
            ),
            React.createElement(
              "div",
              { className: "ci-diet-review-approve" },
              React.createElement("label", { className: "ci-diet-label", htmlFor: "ci-diet-confirm-" + plan.id }, t("plan.confirmLabel")),
              React.createElement("input", {
                id: "ci-diet-confirm-" + plan.id,
                className: "ci-diet-input ci-diet-review-confirm",
                type: "text",
                value: entered,
                maxLength: 12,
                autoComplete: "off",
                spellCheck: false,
                disabled: confirmDisabled,
                onChange: (event: { target: { value: string } }) => setConfirmations((current) => ({ ...current, [plan.id]: event.target.value })),
              }),
              React.createElement("p", { className: "ci-diet-group-desc" }, t("plan.confirmHint")),
              entered.length > 0 && !digestMatches
                ? React.createElement("p", { className: "ci-diet-error" }, t("plan.digestMismatch"))
                : null,
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "ci-diet-discard",
                  disabled: approveDisabled,
                  onClick: () => { void perform("approve", plan.id, entered.trim()); },
                },
                t("plan.approve"),
              ),
            ),
            React.createElement(
              "div",
              { className: "ci-diet-review-apply" },
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "ci-diet-save",
                  disabled: !canApply,
                  onClick: () => { void perform("apply", plan.id); },
                },
                t("plan.apply"),
              ),
              applyReason !== null && !canApply
                ? React.createElement("span", { className: "ci-diet-group-desc" }, applyReason)
                : null,
            ),
          );
        });
    bodyChildren.push(React.createElement(
      "section",
      { key: "plans", className: "ci-diet-group" },
      React.createElement("h2", { className: "ci-diet-group-title" }, t("plans.title")),
      plans,
    ));

    const changes = review.changes.length === 0
      ? React.createElement("p", { className: "ci-diet-group-desc" }, t("page.noChanges"))
      : review.changes.map((change) => {
          const revertAllowed = change.state === "APPLIED" || change.state === "CONFLICT" || change.state === "RECOVERY_REQUIRED";
          const matches = revertId.trim() === change.changeId;
          return React.createElement(
            "div",
            { key: change.changeId, className: "ci-diet-review-change" },
            React.createElement("span", { className: "ci-diet-label ci-diet-review-wrap" }, change.changeId),
            React.createElement("span", { className: "ci-diet-group-desc" }, change.workflowPath + " · " + change.state),
            React.createElement(
              "button",
              {
                type: "button",
                className: "ci-diet-discard ci-diet-review-danger",
                disabled: busy || !revertAllowed || !matches,
                onClick: () => { void perform("revert", change.changeId, revertId.trim()); },
              },
              t("revert.action"),
            ),
          );
        });
    const matchingChange = review.changes.some((change) => change.changeId === revertId.trim());
    bodyChildren.push(React.createElement(
      "section",
      { key: "changes", className: "ci-diet-group" },
      React.createElement("h2", { className: "ci-diet-group-title" }, t("changes.title")),
      changes,
      React.createElement("h3", { className: "ci-diet-review-subhead" }, t("revert.title")),
      React.createElement("p", { className: "ci-diet-group-desc" }, t("revert.hint")),
      React.createElement("label", { className: "ci-diet-label", htmlFor: "ci-diet-revert-id" }, t("revert.input")),
      React.createElement("input", {
        id: "ci-diet-revert-id",
        className: "ci-diet-input ci-diet-review-confirm",
        type: "text",
        value: revertId,
        autoComplete: "off",
        spellCheck: false,
        disabled: busy,
        onChange: (event: { target: { value: string } }) => setRevertId(event.target.value),
      }),
      revertId.trim().length > 0 && !matchingChange
        ? React.createElement("p", { className: "ci-diet-error" }, t("revert.mismatch"))
        : null,
    ));
  }

  return React.createElement(
    "div",
    { className: "ci-diet-page ci-diet-review-page" },
    React.createElement("div", { className: "ci-diet-body ci-diet-review-body" }, bodyChildren),
    React.createElement(
      "div",
      { className: "ci-diet-actions ci-diet-review-footer" },
      React.createElement(
        "button",
        {
          type: "button",
          className: "ci-diet-discard",
          disabled: busy || sessionId === undefined,
          onClick: refresh,
        },
        t("page.refresh"),
      ),
      React.createElement(
        "span",
        { className: "ci-diet-status", role: "status" },
        busy ? t("action.running") : refreshing ? t("page.refreshing") : "",
      ),
    ),
  );
}

