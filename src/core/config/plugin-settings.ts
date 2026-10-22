import { DEFAULT_CONFIG } from "../data/default-config.ts";
import { mergeConfig } from "../config/load.ts";
import { assertValidDocument } from "../contracts/validate.ts";
import { RULE_IDS } from "../model/domain.ts";
import type { RuleId } from "../model/domain.ts";
import { DEFAULT_ENABLED_RULES } from "../rules/index.ts";
import type { Config } from "../contracts/schema.ts";

/** Flat, live-editable settings exposed by the DSH configuration form. */
export interface PluginSettingsValues {
  readonly networkEnabled: boolean;
  readonly stateDir: string;
  readonly ruleCd001: boolean;
  readonly ruleCd002: boolean;
  readonly ruleCd003: boolean;
  readonly ruleCd004: boolean;
  readonly ruleCd005: boolean;
  readonly ruleCd008: boolean;
  readonly historyLookbackDays: number;
  readonly historyMaxRuns: number;
  readonly historyMaxRequests: number;
  readonly historyConcurrentRequests: number;
  readonly historyRequestTimeoutMs: number;
  readonly storageStoreMaxBytes: number;
  readonly storageWorkflowMaxBytes: number;
  readonly storageCacheMaxBytes: number;
  readonly storageCacheDays: number;
  readonly storageReportDays: number;
  readonly storagePlanDays: number;
  readonly billingEnabled: boolean;
  readonly billingIncludedMinutes: number;
  readonly billingAccountMinutesUsed: number;
}

/** The engine configuration and enabled rules one tool call runs with. */
export interface EngineSettings {
  readonly config: Config;
  readonly enabledRules: readonly RuleId[];
  readonly networkEnabled: boolean;
  readonly stateDir: string;
}

/** Rule names as they appear in workflow settings, keyed by the contract id. */
export const RULE_SETTING_KEYS: Readonly<Record<RuleId, keyof PluginSettingsValues>> = {
  CD001: "ruleCd001",
  CD002: "ruleCd002",
  CD003: "ruleCd003",
  CD004: "ruleCd004",
  CD005: "ruleCd005",
  CD008: "ruleCd008",
};

/** Shipped defaults, shared by the DSH schema and the settings page. */
export function defaultPluginSettings(): PluginSettingsValues {
  const enabled = new Set(DEFAULT_ENABLED_RULES);
  return {
    networkEnabled: DEFAULT_CONFIG.networkEnabled,
    stateDir: "",
    ruleCd001: enabled.has("CD001"),
    ruleCd002: enabled.has("CD002"),
    ruleCd003: enabled.has("CD003"),
    ruleCd004: enabled.has("CD004"),
    ruleCd005: enabled.has("CD005"),
    ruleCd008: enabled.has("CD008"),
    historyLookbackDays: DEFAULT_CONFIG.history.lookbackDays,
    historyMaxRuns: DEFAULT_CONFIG.history.maxRuns,
    historyMaxRequests: DEFAULT_CONFIG.history.maxRequests,
    historyConcurrentRequests: DEFAULT_CONFIG.history.concurrentRequests,
    historyRequestTimeoutMs: DEFAULT_CONFIG.history.requestTimeoutMs,
    storageStoreMaxBytes: DEFAULT_CONFIG.storage.storeMaxBytes,
    storageWorkflowMaxBytes: DEFAULT_CONFIG.storage.workflowMaxBytes,
    storageCacheMaxBytes: DEFAULT_CONFIG.storage.cacheMaxBytes,
    storageCacheDays: DEFAULT_CONFIG.storage.cacheDays,
    storageReportDays: DEFAULT_CONFIG.storage.reportDays,
    storagePlanDays: DEFAULT_CONFIG.storage.planDays,
    billingEnabled: DEFAULT_CONFIG.billing !== undefined,
    billingIncludedMinutes: DEFAULT_CONFIG.billing?.includedMinutes ?? 0,
    billingAccountMinutesUsed: DEFAULT_CONFIG.billing?.accountMinutesUsed ?? 0,
  };
}

/**
 * Build the same nested Config the CLI validates through a config file, so the
 * settings page cannot drift from the frozen contract or the shipped defaults.
 */
export function engineSettingsOf(values: PluginSettingsValues): EngineSettings {
  const enabledRules = RULE_IDS.filter((ruleId) => values[RULE_SETTING_KEYS[ruleId]] === true);
  if (enabledRules.length === 0) throw new Error("at least one analysis rule must stay enabled");
  const override = {
    networkEnabled: values.networkEnabled,
    history: {
      lookbackDays: values.historyLookbackDays,
      maxRuns: values.historyMaxRuns,
      maxRequests: values.historyMaxRequests,
      concurrentRequests: values.historyConcurrentRequests,
      requestTimeoutMs: values.historyRequestTimeoutMs,
    },
    storage: {
      storeMaxBytes: values.storageStoreMaxBytes,
      workflowMaxBytes: values.storageWorkflowMaxBytes,
      cacheMaxBytes: values.storageCacheMaxBytes,
      cacheDays: values.storageCacheDays,
      reportDays: values.storageReportDays,
      planDays: values.storagePlanDays,
    },
    ...(values.billingEnabled
      ? { billing: { includedMinutes: values.billingIncludedMinutes, accountMinutesUsed: values.billingAccountMinutesUsed } }
      : {}),
  };
  const config = mergeConfig(DEFAULT_CONFIG, override);
  assertValidDocument("Config", config);
  return { config, enabledRules, networkEnabled: values.networkEnabled, stateDir: values.stateDir };
}
