import * as React from "react";
import { SETTINGS_FIELDS, SETTINGS_GROUPS, collectSettingsEdits } from "./fields.ts";
import type { SettingField } from "./fields.ts";
import { DICTIONARIES, NS } from "./i18n.ts";

const FORM_NAMESPACE = "ciDiet.bootstrap";

type Translate = (key: string, params?: Record<string, string | number>) => string;
type Draft = Record<string, string | boolean>;
type Errors = Record<string, string>;

interface FormSnapshot {
  readonly status: "loading" | "ready" | "unavailable";
  readonly value?: Record<string, unknown> | undefined;
  readonly user?: unknown;
  readonly revision?: number | undefined;
  readonly writable: boolean;
}

interface ConfigForm {
  getSnapshot(): FormSnapshot;
  subscribe(listener: () => void): () => void;
  mutate(ops: readonly { op: "set"; path: string[]; value: unknown }[], expectedRevision?: number): Promise<boolean>;
  unset(field: string): Promise<boolean>;
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

const COLORS = {
  text: "var(--dsw-alias-text, #e6e6e6)",
  muted: "var(--dsw-alias-text-secondary, #9aa0a6)",
  border: "var(--dsw-alias-border, #3a3a3a)",
  panel: "var(--dsw-alias-bg-elevated, #1f1f1f)",
  accent: "var(--dsw-alias-accent, #4f8cff)",
  danger: "var(--dsw-alias-danger, #ff6b6b)",
} as const;

const S = {
  page: { display: "flex", flexDirection: "column", gap: "18px", padding: "4px 2px 84px", color: COLORS.text },
  title: { margin: 0, fontSize: "22px", fontWeight: 650 },
  intro: { margin: 0, color: COLORS.muted, lineHeight: 1.55 },
  meta: { display: "grid", gridTemplateColumns: "max-content 1fr", gap: "6px 14px", padding: "12px 14px", border: "1px solid " + COLORS.border, borderRadius: "10px", background: COLORS.panel, fontSize: "13px", lineHeight: 1.5 },
  metaKey: { color: COLORS.muted, whiteSpace: "nowrap" },
  group: { display: "flex", flexDirection: "column", gap: "10px", border: "1px solid " + COLORS.border, borderRadius: "12px", padding: "14px 16px", background: COLORS.panel },
  groupTitle: { margin: 0, fontSize: "15px", fontWeight: 600 },
  groupDesc: { margin: 0, color: COLORS.muted, fontSize: "13px", lineHeight: 1.5 },
  row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "14px", padding: "8px 0", borderTop: "1px solid " + COLORS.border },
  rowText: { display: "flex", flexDirection: "column", gap: "3px", minWidth: 0 },
  label: { fontSize: "13.5px" },
  badge: { color: COLORS.muted, fontSize: "11px" },
  input: { width: "180px", padding: "6px 8px", borderRadius: "7px", border: "1px solid " + COLORS.border, background: "transparent", color: COLORS.text, fontSize: "13px" },
  error: { color: COLORS.danger, fontSize: "11.5px" },
  actions: { position: "fixed", left: 0, right: 0, bottom: 0, display: "flex", alignItems: "center", gap: "10px", padding: "12px 24px", borderTop: "1px solid " + COLORS.border, background: COLORS.panel, zIndex: 20 },
  button: { padding: "7px 14px", borderRadius: "8px", border: "1px solid " + COLORS.border, background: "transparent", color: COLORS.text, cursor: "pointer", fontSize: "13px" },
  primary: { padding: "7px 14px", borderRadius: "8px", border: "1px solid " + COLORS.accent, background: COLORS.accent, color: "#fff", cursor: "pointer", fontSize: "13px" },
  status: { color: COLORS.muted, fontSize: "12px" },
  notice: { padding: "16px", border: "1px solid " + COLORS.border, borderRadius: "12px", background: COLORS.panel, color: COLORS.muted, lineHeight: 1.55 },
} as const;

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
      style: {
        position: "relative",
        width: "40px",
        height: "22px",
        borderRadius: "999px",
        border: "1px solid " + (checked ? COLORS.accent : COLORS.border),
        background: checked ? COLORS.accent : "transparent",
        cursor: disabled ? "default" : "pointer",
        flex: "none",
        padding: 0,
      },
    },
    React.createElement("span", {
      style: {
        position: "absolute",
        top: "2px",
        left: checked ? "20px" : "2px",
        width: "16px",
        height: "16px",
        borderRadius: "50%",
        background: checked ? "#fff" : COLORS.muted,
        transition: "left 120ms ease",
      },
    }),
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
  const [errors, setErrors] = React.useState<Errors>({});
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const disabled = !snapshot.writable || saving;

  const edit = (key: string, value: string | boolean) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setSaved(false);
    setFailed(false);
  };

  const reset = async (key: string) => {
    if (form === undefined || disabled) return;
    setSaving(true);
    setFailed(false);
    setSaved(false);
    try {
      const accepted = await form.unset(key);
      if (!accepted) setFailed(true);
      else {
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
        setSaved(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (form === undefined || disabled) return;
    const batch = collectSettingsEdits(draft, t);
    setErrors({ ...batch.errors });
    if (Object.keys(batch.errors).length > 0) return;
    const ops = batch.ops.map((op) => ({ op: "set" as const, path: op.path, value: op.value }));
    if (ops.length === 0) return;
    setSaving(true);
    setFailed(false);
    try {
      const accepted = await form.mutate(ops, snapshot.revision);
      if (accepted) {
        setDraft({});
        setSaved(true);
      } else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  if (snapshot.status === "loading") return React.createElement("div", { style: S.notice }, t("page.loading"));
  if (snapshot.status === "unavailable" || form === undefined) return React.createElement("div", { style: S.notice }, t("page.unavailable"));
  const readOnly = !snapshot.writable;

  const body = SETTINGS_GROUPS.map((group) => {
    const rows = SETTINGS_FIELDS.filter((field) => field.group === group).map((field) => {
      const raw = draft[field.key] !== undefined ? draft[field.key] : snapshot.value?.[field.key];
      const overridden = isOverridden(snapshot.user, field.key);
      const label = t("field." + field.key);
      const control = field.kind === "switch"
        ? switchControl(label, raw === true, disabled || readOnly, () => edit(field.key, raw !== true))
        : React.createElement("input", {
            id: "ci-diet-" + field.key,
            type: field.kind === "number" ? "number" : "text",
            value: raw === undefined || raw === null ? "" : String(raw),
            min: field.min,
            max: field.max,
            step: field.kind === "number" ? 1 : undefined,
            disabled: disabled || readOnly,
            onChange: (event: { target: { value: string } }) => edit(field.key, event.target.value),
            style: S.input,
            "aria-label": label,
          });
      return React.createElement(
        "div",
        { key: field.key, style: S.row },
        React.createElement(
          "div",
          { style: S.rowText },
          React.createElement("label", { htmlFor: "ci-diet-" + field.key, style: S.label }, label),
          overridden
            ? React.createElement(
                "span",
                { style: S.badge },
                t("page.overridden"),
                " · ",
                React.createElement(
                  "button",
                  {
                    type: "button",
                    onClick: () => { void reset(field.key); },
                    disabled: disabled || readOnly,
                    style: { ...S.button, padding: "1px 6px", fontSize: "11px" },
                  },
                  t("page.reset"),
                ),
              )
            : null,
          errors[field.key] ? React.createElement("span", { style: S.error }, errors[field.key]) : null,
        ),
        control,
      );
    });
    return React.createElement(
      "section",
      { key: group, style: S.group },
      React.createElement("div", null,
        React.createElement("h3", { style: S.groupTitle }, t("group." + group + ".title")),
        React.createElement("p", { style: S.groupDesc }, t("group." + group + ".desc")),
      ),
      rows,
    );
  });

  return React.createElement(
    "div",
    { style: S.page },
    React.createElement("h2", { style: S.title }, t("page.title")),
    React.createElement("p", { style: S.intro }, t("page.intro")),
    React.createElement(
      "div",
      { style: S.meta },
      React.createElement("div", { style: S.metaKey }, t("page.scopeLabel")),
      React.createElement("div", null, t("page.scope")),
      React.createElement("div", { style: S.metaKey }, t("page.appliesLabel")),
      React.createElement("div", null, t("page.applies")),
    ),
    readOnly ? React.createElement("div", { style: S.notice }, t("page.readOnly")) : null,
    ...body,
    React.createElement(
      "div",
      { style: S.actions },
      React.createElement("button", { type: "button", style: S.primary, disabled: disabled || readOnly, onClick: () => { void save(); } }, saving ? t("page.saving") : t("page.save")),
      React.createElement("button", {
        type: "button",
        style: S.button,
        disabled: disabled || readOnly || Object.keys(draft).length === 0,
        onClick: () => { setDraft({}); setErrors({}); setSaved(false); setFailed(false); },
      }, t("page.discard")),
      failed ? React.createElement("span", { style: S.status, role: "alert" }, t("page.saveFailed")) : null,
      !failed && saved ? React.createElement("span", { style: S.status, role: "status" }, t("page.saved")) : null,
    ),
  );
}

interface ClientContext {
  readonly slots: { inject(name: string, register: () => unknown): unknown; register(options: Record<string, unknown>, component: unknown): unknown };
  readonly locale?: { bind(namespace: string): Translate; register(namespace: string, dictionaries: unknown): () => void } | undefined;
  readonly configForms: { get(namespace: string): ConfigForm };
  effect?(run: () => unknown): unknown;
}

const plugin = {
  inject: ["slots", "locale", "configForms"],
  apply(ctx: ClientContext): void {
    const t = ctx.locale === undefined ? translateWith(EN) : ctx.locale.bind(NS);
    if (ctx.locale !== undefined && ctx.effect !== undefined) {
      ctx.effect(() => ctx.locale!.register(NS, DICTIONARIES));
    }
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