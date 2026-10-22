import * as React from "react";
import { RULE_CHOICES, SETTINGS_FIELDS, SETTINGS_GROUPS, collectSettingsEdits } from "./fields.ts";
import type { SettingsDraftValue } from "./fields.ts";
import { CLIENT_LANGUAGES, DICTIONARIES, NS } from "./i18n.ts";
import { installStyles } from "./styles.ts";

const FORM_NAMESPACE = "ciDiet.bootstrap";

type Translate = (key: string, params?: Record<string, string | number>) => string;
type Draft = Record<string, SettingsDraftValue>;
type Errors = Record<string, string>;

interface FormSnapshot {
  readonly status: "loading" | "ready" | "unavailable";
  readonly value?: Record<string, unknown> | undefined;
  readonly user?: unknown;
  readonly revision?: number | undefined;
  readonly writable: boolean;
}

type SettingsPathOp =
  | { readonly op: "set"; readonly path: string[]; readonly value: unknown }
  | { readonly op: "unset"; readonly path: string[] };

interface ConfigForm {
  getSnapshot(): FormSnapshot;
  subscribe(listener: () => void): () => void;
  mutate(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<boolean>;
}

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
    if (Object.keys(batch.errors).length > 0) return;
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
  if (snapshot.status === "unavailable" || form === undefined) return React.createElement("div", { className: "ci-diet-notice" }, t("page.unavailable"));
  const readOnly = !snapshot.writable;

  const body = SETTINGS_GROUPS.map((group) => {
    const rows = SETTINGS_FIELDS.filter((field) => field.group === group).map((field) => {
      const raw = draft[field.key] !== undefined ? draft[field.key] : snapshot.value?.[field.key];
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
              value: raw === undefined || raw === null ? "" : String(raw),
              min: field.min,
              max: field.max,
              step: field.kind === "number" ? 1 : undefined,
              disabled: disabled || readOnly,
              onChange: (event: { target: { value: string } }) => edit(field.key, event.target.value),
              className: "ci-diet-input",
              "aria-label": label,
            });
      return React.createElement(
        "div",
        { key: field.key, className: "ci-diet-row" },
        React.createElement(
          "div",
          { className: "ci-diet-row-text" },
          React.createElement("label", { htmlFor: "ci-diet-" + field.key, className: "ci-diet-label" }, label),
          overridden
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
          errors[field.key] ? React.createElement("span", { className: "ci-diet-error" }, errors[field.key]) : null,
        ),
        control,
      );
    });
    return React.createElement(
      "section",
      { key: group, className: "ci-diet-group" },
      React.createElement("div", { className: "ci-diet-group-head" },
        React.createElement("h3", { className: "ci-diet-group-title" }, t("group." + group + ".title")),
        React.createElement("p", { className: "ci-diet-group-desc" }, t("group." + group + ".desc")),
      ),
      rows,
    );
  });

  return React.createElement(
    "div",
    { className: "ci-diet-page" },
    React.createElement("h2", { className: "ci-diet-title" }, t("page.title")),
    React.createElement("p", { className: "ci-diet-intro" }, t("page.intro")),
    React.createElement(
      "div",
      { className: "ci-diet-meta" },
      React.createElement("div", { className: "ci-diet-meta-key" }, t("page.scopeLabel")),
      React.createElement("div", null, t("page.scope")),
      React.createElement("div", { className: "ci-diet-meta-key" }, t("page.appliesLabel")),
      React.createElement("div", null, t("page.applies")),
    ),
    readOnly ? React.createElement("div", { className: "ci-diet-notice" }, t("page.readOnly")) : null,
    ...body,
    React.createElement(
      "div",
      { className: "ci-diet-actions" },
      React.createElement("button", { type: "button", className: "ci-diet-save", disabled: disabled || readOnly, onClick: () => { void save(); } }, saving ? t("page.saving") : t("page.save")),
      React.createElement("button", {
        type: "button",
        className: "ci-diet-discard",
        disabled: disabled || readOnly || (Object.keys(draft).length === 0 && resets.length === 0),
        onClick: () => { setDraft({}); setResets([]); setErrors({}); setSaved(false); setFailed(false); setConflict(false); setPinnedRevision(null); },
      }, t("page.discard")),
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
  readonly configForms: { get(namespace: string): ConfigForm };
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
  inject: ["slots", "locale", "configForms"],
  apply(ctx: ClientContext): void {
    const t = ctx.locale === undefined ? translateWith(EN) : ctx.locale.bind(NS);
    if (ctx.locale !== undefined && ctx.effect !== undefined) {
      ctx.effect(() => {
        const dispose = ctx.locale!.register(NS, DICTIONARIES);
        return dispose;
      });
    }
    registerLanguages(ctx.locale);
    if (ctx.effect !== undefined) ctx.effect(() => installStyles());
    else installStyles();
    const register = () => ctx.slots.inject("settings.section", () => ctx.slots.register({
      name: "settings.section",
      id: "ci-diet",
      order: 91,
      label: () => t("nav"),
      locale: NS,
      inject: () => ({ form: ctx.configForms.get(FORM_NAMESPACE) }),
    }, SettingsPage));
    if (ctx.effect !== undefined) ctx.effect(register);
    else register();
  },
};

export { SettingsPage, translateWith };
export default plugin;