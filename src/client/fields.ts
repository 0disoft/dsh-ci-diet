/** Settings groups and controls rendered by the CI Diet settings page. */
export type SettingGroupId = "general" | "rules" | "history" | "storage" | "billing";
export type SettingKind = "switch" | "number" | "text" | "rules";

/** Analysis rules a human can enable, in contract order. */
export const RULE_CHOICES = ["CD001", "CD002", "CD003", "CD004", "CD005", "CD006", "CD008"] as const;

export interface SettingField {
  readonly key: string;
  readonly group: SettingGroupId;
  readonly kind: SettingKind;
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
}

export const SETTINGS_FIELDS: readonly SettingField[] = [
  { key: "networkEnabled", group: "general", kind: "switch" },
  { key: "stateDir", group: "general", kind: "text" },

  { key: "rules", group: "rules", kind: "rules" },

  { key: "historyLookbackDays", group: "history", kind: "number", min: 1, max: 30, integer: true },
  { key: "historyMaxRuns", group: "history", kind: "number", min: 1, integer: true },
  { key: "historyMaxRequests", group: "history", kind: "number", min: 1, integer: true },
  { key: "historyConcurrentRequests", group: "history", kind: "number", min: 1, max: 4, integer: true },
  { key: "historyRequestTimeoutMs", group: "history", kind: "number", min: 1, integer: true },

  { key: "storageStoreMaxBytes", group: "storage", kind: "number", min: 0, integer: true },
  { key: "storageWorkflowMaxBytes", group: "storage", kind: "number", min: 0, integer: true },
  { key: "storageCacheMaxBytes", group: "storage", kind: "number", min: 0, integer: true },
  { key: "storageCacheDays", group: "storage", kind: "number", min: 0, integer: true },
  { key: "storageReportDays", group: "storage", kind: "number", min: 0, integer: true },
  { key: "storagePlanDays", group: "storage", kind: "number", min: 0, integer: true },

  { key: "billingEnabled", group: "billing", kind: "switch" },
  { key: "billingIncludedMinutes", group: "billing", kind: "number", min: 0, integer: true },
  { key: "billingAccountMinutesUsed", group: "billing", kind: "number", min: 0, integer: true },
];

export const SETTINGS_GROUPS: readonly SettingGroupId[] = ["general", "rules", "history", "storage", "billing"];
export type SettingsDraftEdit =
  | { readonly op: "set"; readonly path: string[]; readonly value: unknown }
  | { readonly op: "unset"; readonly path: string[] };

export interface SettingsEditBatch {
  readonly ops: readonly SettingsDraftEdit[];
  readonly errors: Readonly<Record<string, string>>;
}

export type SettingsDraftValue = string | number | boolean | readonly string[];

/** Validate a staged draft exactly like the page and produce one atomic edit batch. */
export function collectSettingsEdits(
  draft: Readonly<Record<string, SettingsDraftValue>>,
  message: (key: string, params?: Record<string, string | number>) => string,
  resets: readonly string[] = [],
): SettingsEditBatch {
  const ops: SettingsDraftEdit[] = [];
  const errors: Record<string, string> = {};
  for (const field of SETTINGS_FIELDS) {
    const key = field.key;
    // A reset stays in the draft so it is saved with the same pinned revision
    // as every other edit instead of writing to the host immediately.
    if (resets.includes(key)) {
      ops.push({ op: "unset", path: [key] });
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(draft, key)) continue;
    const raw = draft[key]!;
    if (field.kind === "rules") {
      const selected = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
      const unknown = selected.filter((id) => !(RULE_CHOICES as readonly string[]).includes(id));
      if (unknown.length > 0) {
        errors[key] = message("page.unknownRule", { rule: unknown[0]! });
        continue;
      }
      if (selected.length === 0) {
        errors[key] = message("page.noRules");
        continue;
      }
      ops.push({ op: "set", path: [key], value: RULE_CHOICES.filter((id) => selected.includes(id)) });
      continue;
    }
    if (field.kind === "switch") {
      ops.push({ op: "set", path: [key], value: raw === true });
      continue;
    }
    if (field.kind === "text") {
      ops.push({ op: "set", path: [key], value: String(raw) });
      continue;
    }
    const text = String(raw).trim();
    const value = Number(text);
    if (text === "" || !Number.isFinite(value)) {
      errors[key] = message("page.invalidNumber");
      continue;
    }
    if (field.integer === true && !Number.isInteger(value)) {
      errors[key] = message("page.invalidInteger");
      continue;
    }
    if (field.min !== undefined && value < field.min) {
      errors[key] = message("page.tooSmall", { min: field.min });
      continue;
    }
    if (field.max !== undefined && value > field.max) {
      errors[key] = message("page.tooLarge", { max: field.max });
      continue;
    }
    ops.push({ op: "set", path: [key], value });
  }
  return { ops, errors };
}
