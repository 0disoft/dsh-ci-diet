import * as React from "react";
import { RULE_CHOICES, SETTINGS_FIELDS, SETTINGS_GROUPS, collectSettingsEdits } from "./fields.ts";
import type { SettingGroupId, SettingsDraftValue } from "./fields.ts";
import { CLIENT_LANGUAGES, DICTIONARIES, NS } from "./i18n.ts";
import { installStyles } from "./styles.ts";
import { ReviewPage } from "./review.ts";
import { REVIEW_DICTIONARIES, REVIEW_NS } from "./review-i18n.ts";
import { SettingsConnection } from "./settings-connection.ts";
import type { ConfigForm, ConfigForms, FormSnapshot } from "./settings-connection.ts";

type Translate = (key: string, params?: Record<string, string | number>) => string;
type Draft = Record<string, SettingsDraftValue>;
type Errors = Record<string, string>;

const EN = DICTIONARIES.en as Record<string, string>;

function translateWith(dict: Record<string, string>): Translate {
  return (key, params = {}) => {
    const template = dict[key] ?? EN[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? ""));
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOverridden(user: unknown, key: string): boolean {
  return isRecord(user) && Object.prototype.hasOwnProperty.call(user, key);
}

function switchControl(label: string, checked: boolean, disabled: boolean, onToggle: () => void): unknown {
  return React.createElement(
    "button",
    {
      type: "button",
      role: "switch",
      "aria-checked": checked,
      "aria-label": label,
      disabled,
      onClick: onToggle,
      className: "ci-diet-switch",
    },
    React.createElement("span", { className: "ci-diet-thumb" }),
  );
}

function rulesControl(
  selected: readonly string[],
  disabled: boolean,
  labelFor: (id: string) => string,
  onToggle: (id: string) => void,
): unknown {
  return React.createElement(
    "div",
    { className: "ci-diet-rules" },
    RULE_CHOICES.map((id) => React.createElement(
      "label",
      { key: id, className: "ci-diet-rule" },
      React.createElement("input", {
        type: "checkbox",
        checked: selected.includes(id),
        disabled,
        onChange: () => onToggle(id),
        "aria-label": labelFor(id),
        className: "ci-diet-checkbox",
      }),
      labelFor(id),
    )),
  );
}

function SettingsPage(props: { form?: ConfigForm; t?: Translate }) {
  const { form } = props;
  const t = props.t ?? translateWith(EN);
  const emptySnapshot: FormSnapshot = { status: "loading", writable: false };
  const snapshot = form
    ? React.useSyncExternalStore(
        (listener: () => void) => form.subscribe(listener),
        () => form.getSnapshot(),
        () => form.getSnapshot(),
      )
    : emptySnapshot;
  const [draft, setDraft] = React.useState<Draft>({});
  const [resets, setResets] = React.useState<readonly string[]>([]);
  const [errors, setErrors] = React.useState<Errors>({});
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [pinnedRevision, setPinnedRevision] = React.useState<number | null>(null);
  const [conflict, setConflict] = React.useState(false);
  const [activeGroup, setActiveGroup] = React.useState<SettingGroupId>("general");
  const [showHelp, setShowHelp] = React.useState(false);

  const disabled = !snapshot.writable || saving;

  const edit = (key: string, value: SettingsDraftValue) => {
    setPinnedRevision((current) => current ?? snapshot.revision ?? null);
    setResets((current) => current.filter((item) => item !== key));
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setSaved(false);
    setFailed(false);
  };

  // Staging the reset instead of writing it now keeps the pinned revision
  // meaningful: the reset and every staged field land in one mutation.
  const reset = (key: string) => {
    if (form === undefined || disabled) return;
    setPinnedRevision((current) => current ?? snapshot.revision ?? null);
    setResets((current) => (current.includes(key) ? current : [...current, key]));
    setDraft((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setSaved(false);
    setFailed(false);
    setConflict(false);
  };

  const save = async () => {
    if (form === undefined || disabled) return;
    const batch = collectSettingsEdits(draft, t, resets);
    setErrors({ ...batch.errors });
    if (Object.keys(batch.errors).length > 0) {
      const invalidField = SETTINGS_FIELDS.find((field) => batch.errors[field.key] !== undefined);
      if (invalidField !== undefined) setActiveGroup(invalidField.group);
      return;
    }
    const ops = batch.ops.map((op) => (op.op === "set"
      ? { op: "set" as const, path: op.path, value: op.value }
      : { op: "unset" as const, path: op.path }));
    if (ops.length === 0) return;
    setSaving(true);
    setFailed(false);
    setConflict(false);
    try {
      const accepted = await form.mutate(ops, pinnedRevision ?? snapshot.revision);
      if (accepted) {
        setDraft({});
        setResets([]);
        setSaved(true);
        setPinnedRevision(null);
      } else {
        setFailed(true);
        setConflict(pinnedRevision !== null && snapshot.revision !== pinnedRevision);
      }
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  if (snapshot.status === "loading") return React.createElement("div", { className: "ci-diet-notice" }, t("page.loading"));
  if (snapshot.status === "unavailable" || form === undefined) return React.createElement("div", { className: "ci-diet-notice", role: "alert" },
    React.createElement("h2", null, t("connection.title")),
    React.createElement("p", null, t(snapshot.issue === undefined ? "page.unavailable" : "connection." + snapshot.issue, { ids: snapshot.entryIds?.join(", ") ?? "" })),
    form?.retry === undefined ? null : React.createElement("button", { type: "button", className: "ci-diet-discard", onClick: () => form.retry!() }, t("connection.retry")),
  );
  const readOnly = !snapshot.writable;

  const changedKeys = new Set([...Object.keys(draft), ...resets]);
  const valueOf = (key: string) => draft[key] !== undefined ? draft[key] : snapshot.value?.[key];
  const billingReady = ["billingIncludedMinutes", "billingAccountMinutesUsed"].every((key) => {
    if (resets.includes(key)) return false;
    const raw = valueOf(key);
    return (typeof raw === "number" || (typeof raw === "string" && raw.trim() !== ""))
      && Number.isSafeInteger(Number(raw)) && Number(raw) >= 0;
  });
  const recommendedReady = ["preflightEnabled", "networkEnabled", "localApplyEnabled"].every((key) => valueOf(key) === true)
    && ["CD001", "CD002", "CD004", "CD006", "CD008"].every((id) => {
      const rules = valueOf("rules");
      return Array.isArray(rules) && rules.includes(id);
    }) && !resets.some((key) => ["preflightEnabled", "networkEnabled", "localApplyEnabled", "rules"].includes(key));

  const body = SETTINGS_GROUPS.map((group) => {
    const rows = SETTINGS_FIELDS.filter((field) => field.group === group).map((field) => {
      const raw = valueOf(field.key);
      const overridden = isOverridden(snapshot.user, field.key);
      const label = t("field." + field.key);
      const selected = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
      const control = field.kind === "switch"
        ? switchControl(label, raw === true, disabled || readOnly, () => edit(field.key, raw !== true))
        : field.kind === "rules"
          ? rulesControl(selected, disabled || readOnly, (id) => t("field.rule" + id), (id) => {
              const next = selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id];
              edit(field.key, RULE_CHOICES.filter((entry) => next.includes(entry)));
            })
          : React.createElement("input", {
              id: "ci-diet-" + field.key,
              type: field.kind === "number" ? "number" : "text",
              value: raw === undefined || raw === null || (field.nullable && resets.includes(field.key)) ? "" : String(raw),
              min: field.min,
              max: field.max,
              step: field.kind === "number" ? 1 : undefined,
              disabled: disabled || readOnly,
              onChange: (event: { target: { value: string } }) => edit(field.key, event.target.value),
              className: "ci-diet-input",
              "aria-label": label,
              "aria-invalid": errors[field.key] !== undefined,
              "aria-describedby": errors[field.key] ? "ci-diet-error-" + field.key : undefined,
              placeholder: field.key === "stateDir" ? t("page.defaultLocation") : field.nullable ? t("billing.placeholder") : undefined,
            });
      return React.createElement(
        "div",
        { key: field.key, className: "ci-diet-row" },
        React.createElement(
          "div",
          { className: "ci-diet-row-text" },
          React.createElement("label", { htmlFor: "ci-diet-" + field.key, className: "ci-diet-label" }, label),
          field.kind === "switch" && field.group === "general"
            ? React.createElement("p", { className: "ci-diet-field-help" }, t("help." + field.key)) : null,
          resets.includes(field.key)
            ? React.createElement("span", { className: "ci-diet-badge" }, t("page.resetPending")) : null,
          overridden && !resets.includes(field.key)
            ? React.createElement(
                "span",
                { className: "ci-diet-badge" },
                t("page.overridden"),
                " · ",
                React.createElement(
                  "button",
                  {
                    type: "button",
                    onClick: () => { reset(field.key); },
                    disabled: disabled || readOnly,
                    className: "ci-diet-reset",
                  },
                  t("page.reset"),
                ),
              )
            : null,
          errors[field.key] ? React.createElement("span", { className: "ci-diet-error", id: "ci-diet-error-" + field.key, role: "alert" }, errors[field.key]) : null,
        ),
        control,
      );
    });
    return React.createElement(
      "section",
      { key: group, className: "ci-diet-group", role: "tabpanel", id: "ci-diet-panel-" + group,
        "aria-labelledby": "ci-diet-tab-" + group, hidden: activeGroup !== group, tabIndex: 0 },
      group === "general" ? React.createElement("p", {
        className: "ci-diet-recommended", "data-ready": recommendedReady,
      }, t(recommendedReady ? "page.recommendedReady" : "page.recommendedPartial")) : null,
      group !== "general" ? React.createElement("div", { className: "ci-diet-group-head" },
        React.createElement("h3", { className: "ci-diet-group-title" }, t("group." + group + ".title")),
        React.createElement("p", { className: "ci-diet-group-desc" }, t("group." + group + ".desc")),
      ) : null,
      group === "billing" ? React.createElement("p", { className: "ci-diet-notice", role: "status" }, t(billingReady ? "billing.ready" : "billing.missing")) : null,
      rows,
      group === "general" ? React.createElement("p", { className: "ci-diet-scope-note" }, t("page.scopeNote")) : null,
    );
  });

  return React.createElement(
    "div",
    { className: "ci-diet-page ci-diet-settings-page" },
    React.createElement("header", { className: "ci-diet-settings-header" },
      React.createElement("h2", { className: "ci-diet-title" }, t("page.title")),
      React.createElement("div", { className: "ci-diet-heading-row" },
        React.createElement("p", { className: "ci-diet-intro" }, t("page.intro")),
        React.createElement("button", { type: "button", className: "ci-diet-help",
          "aria-expanded": showHelp, "aria-controls": "ci-diet-settings-help",
          onClick: () => setShowHelp((current) => !current),
        }, t("page.help")),
      ),
    ),
    React.createElement("div", { className: "ci-diet-tabs", role: "tablist", "aria-label": t("page.tabLabel") },
      ...SETTINGS_GROUPS.map((group, index) => {
        const count = SETTINGS_FIELDS.filter((field) => field.group === group && changedKeys.has(field.key)).length;
        return React.createElement("button", {
          type: "button", role: "tab", className: "ci-diet-tab", id: "ci-diet-tab-" + group,
          "aria-controls": "ci-diet-panel-" + group, "aria-selected": activeGroup === group,
          tabIndex: activeGroup === group ? 0 : -1,
          onClick: () => setActiveGroup(group),
          onKeyDown: (event: { key: string; preventDefault(): void; currentTarget: {
            parentElement: { querySelectorAll(selector: string): { [index: number]: { focus(): void } } } | null;
          } }) => {
            const next = event.key === "Home" ? 0 : event.key === "End" ? SETTINGS_GROUPS.length - 1
              : event.key === "ArrowRight" ? (index + 1) % SETTINGS_GROUPS.length
              : event.key === "ArrowLeft" ? (index + SETTINGS_GROUPS.length - 1) % SETTINGS_GROUPS.length : null;
            if (next === null) return;
            event.preventDefault();
            setActiveGroup(SETTINGS_GROUPS[next]!);
            event.currentTarget.parentElement?.querySelectorAll('[role="tab"]')[next]?.focus();
          },
        }, t("tab." + group), count > 0 ? React.createElement("span", { className: "ci-diet-tab-count" }, count) : null);
      }),
    ),
    React.createElement(
      "div",
      { key: activeGroup, className: "ci-diet-body" },
      showHelp ? React.createElement("div", { className: "ci-diet-meta", id: "ci-diet-settings-help" },
        React.createElement("div", { className: "ci-diet-meta-key" }, t("page.scopeLabel")),
        React.createElement("div", null, t("page.scope")),
        React.createElement("div", { className: "ci-diet-meta-key" }, t("page.appliesLabel")),
        React.createElement("div", null, t("page.applies")),
      ) : null,
      readOnly ? React.createElement("div", { className: "ci-diet-notice" }, t("page.readOnly")) : null,
      ...body,
    ),
    React.createElement(
      "div",
      { className: "ci-diet-actions" },
      React.createElement("button", { type: "button", className: "ci-diet-save", disabled: disabled || readOnly || changedKeys.size === 0, onClick: () => { void save(); } }, saving ? t("page.saving") : t("page.save")),
      React.createElement("button", {
        type: "button",
        className: "ci-diet-discard",
        disabled: disabled || readOnly || (Object.keys(draft).length === 0 && resets.length === 0),
        onClick: () => { setDraft({}); setResets([]); setErrors({}); setSaved(false); setFailed(false); setConflict(false); setPinnedRevision(null); },
      }, t("page.discard")),
      changedKeys.size > 0 ? React.createElement("span", { className: "ci-diet-change-count" }, t("page.changes", { count: changedKeys.size })) : null,
      React.createElement("span", { className: "ci-diet-apply-note" }, t("page.applies")),
      Object.keys(errors).length > 0 ? React.createElement("span", { className: "ci-diet-status", role: "alert" }, t("page.validationFailed")) : null,
      failed ? React.createElement("span", { className: "ci-diet-status", role: "alert" }, t(conflict ? "page.conflict" : "page.saveFailed")) : null,
      !failed && saved ? React.createElement("span", { className: "ci-diet-status", role: "status" }, t("page.saved")) : null,
    ),
  );
}

interface ClientContext {
  readonly slots: { inject(name: string, register: () => unknown): unknown; register(options: Record<string, unknown>, component: unknown): unknown };
  readonly locale?: {
    bind(namespace: string): Translate;
    register(namespace: string, dictionaries: unknown): () => void;
    getLocale?(): { readonly locales: readonly { readonly id: string }[] };
    addLanguage?(language: { id: string; label: string; fallback: string }): () => void;
  } | undefined;
  readonly configForms: ConfigForms;
  readonly connection: { readonly rpc: { call(channel: string, endpoint: string, payload: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: { message: string } }> } };
  readonly uiSession: { readonly adapter: { readonly current: { getSnapshot(): { key: string | undefined }; subscribe(listener: () => void): () => void } } };
  effect?(run: () => unknown): unknown;
}

function registerLanguages(locale: ClientContext["locale"]): void {
  if (locale === undefined || locale.addLanguage === undefined || locale.getLocale === undefined) return;
  const known = new Set(locale.getLocale().locales.map((entry) => entry.id.toLowerCase()));
  for (const language of CLIENT_LANGUAGES) {
    if (known.has(language.id)) continue;
    locale.addLanguage({ id: language.id, label: language.label, fallback: "en" });
  }
}

const plugin = {
  inject: ["slots", "locale", "configForms", "connection", "uiSession"],
  apply(ctx: ClientContext): void {
    const t = ctx.locale === undefined ? translateWith(EN) : ctx.locale.bind(NS);
    if (ctx.locale !== undefined && ctx.effect !== undefined) {
      ctx.effect(() => {
        const dispose = ctx.locale!.register(NS, DICTIONARIES);
        return dispose;
      });
    }
    registerLanguages(ctx.locale);
    if (ctx.locale !== undefined) {
      const registerReviewLocale = () => ctx.locale!.register(REVIEW_NS, REVIEW_DICTIONARIES);
      if (ctx.effect !== undefined) ctx.effect(registerReviewLocale);
      else registerReviewLocale();
    }
    if (ctx.effect !== undefined) ctx.effect(() => installStyles());
    else installStyles();
    const settings = new SettingsConnection(ctx.configForms, ctx.connection);
    if (ctx.effect !== undefined) ctx.effect(() => () => settings.dispose());
    const register = () => ctx.slots.inject("settings.section", () => ctx.slots.register({
      name: "settings.section",
      id: "ci-diet",
      order: 91,
      label: () => t("nav"),
      locale: NS,
      inject: () => { settings.connect(); return { form: settings }; },
    }, SettingsPage));
    if (ctx.effect !== undefined) ctx.effect(register);
    else register();
    const reviewContext = {
      connection: ctx.connection,
      locale: ctx.locale,
      useSessionId: () => React.useSyncExternalStore(
        (listener) => ctx.uiSession.adapter.current.subscribe(listener),
        () => ctx.uiSession.adapter.current.getSnapshot().key,
      ),
    };
    const registerReview = () => ctx.slots.inject("settings.section", () => ctx.slots.register({
      name: "settings.section", id: "ci-diet-reports", order: 92,
      label: () => ctx.locale?.bind(REVIEW_NS)("nav") ?? "CI Diet Reports",
      locale: REVIEW_NS, inject: () => ({ ctx: reviewContext }),
    }, ReviewPage));
    if (ctx.effect !== undefined) ctx.effect(registerReview);
    else registerReview();
  },
};

export { SettingsPage, translateWith };
export default plugin;
