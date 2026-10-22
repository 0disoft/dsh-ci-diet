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
  /** Enabled analysis rules in display order; the host schema refuses an empty list. */
  readonly rules: readonly RuleId[];
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

/** Shipped defaults, shared by the DSH schema and the settings page. */
export function defaultPluginSettings(): PluginSettingsValues {
  return {
    networkEnabled: DEFAULT_CONFIG.networkEnabled,
    stateDir: "",
    rules: [...DEFAULT_ENABLED_RULES],
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

/** Reject rule ids the contract does not know, duplicates, and an empty selection. */
function enabledRulesOf(selected: readonly RuleId[]): readonly RuleId[] {
  if (!Array.isArray(selected)) throw new Error("analysis rules must be a list");
  const unique = new Set<string>();
  for (const ruleId of selected) {
    if (!(RULE_IDS as readonly string[]).includes(ruleId)) throw new Error("unknown analysis rule: " + String(ruleId));
    if (unique.has(ruleId)) throw new Error("analysis rule listed twice: " + ruleId);
    unique.add(ruleId);
  }
  if (unique.size === 0) throw new Error("at least one analysis rule must stay enabled");
  return RULE_IDS.filter((ruleId) => unique.has(ruleId));
}

/**
 * Build the same nested Config the CLI validates through a config file, so the
 * settings page cannot drift from the frozen contract or the shipped defaults.
 */
export function engineSettingsOf(values: PluginSettingsValues): EngineSettings {
  const enabledRules = enabledRulesOf(values.rules);
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
