import { DEFAULT_CONFIG } from "../data/default-config.ts";
import { mergeConfig } from "../config/load.ts";
import { assertValidDocument } from "../contracts/validate.ts";
import { RULE_IDS } from "../model/domain.ts";
import type { RuleId } from "../model/domain.ts";
import { DEFAULT_ENABLED_RULES } from "../rules/index.ts";
import type { Config } from "../contracts/schema.ts";

/** Flat, live-editable settings exposed by the DSH configuration form. */
export interface PluginSettingsValues {
  readonly preflightEnabled: boolean;
  readonly networkEnabled: boolean;
  readonly localApplyEnabled: boolean;
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
  readonly billingIncludedMinutes: number | null;
  readonly billingAccountMinutesUsed: number | null;
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
    preflightEnabled: true,
    // DSH history collection is opt-out; the standalone CLI keeps its explicit
    // --network contract and its offline default.
    networkEnabled: true,
    localApplyEnabled: true,
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
    billingIncludedMinutes: DEFAULT_CONFIG.billing?.includedMinutes ?? null,
    billingAccountMinutesUsed: DEFAULT_CONFIG.billing?.accountMinutesUsed ?? null,
  };
}

/** Reject unknown ids and an empty selection, and canonicalize duplicates away. */
function enabledRulesOf(selected: readonly RuleId[]): readonly RuleId[] {
  if (!Array.isArray(selected)) throw new Error("analysis rules must be a list");
  const unique = new Set<string>();
  for (const ruleId of selected) {
    if (!(RULE_IDS as readonly string[]).includes(ruleId)) throw new Error("unknown analysis rule: " + String(ruleId));
    // The host array schema cannot express uniqueness; the engine drops the
    // repeat and returns the contract order, so a duplicate save is harmless.
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
  for (const minutes of [values.billingIncludedMinutes, values.billingAccountMinutesUsed]) {
    if (minutes !== null && (!Number.isSafeInteger(minutes) || minutes < 0)) {
      throw new Error("account minutes must be null or a nonnegative safe integer");
    }
  }
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
    ...(values.billingIncludedMinutes !== null && values.billingAccountMinutesUsed !== null
      ? { billing: { includedMinutes: values.billingIncludedMinutes, accountMinutesUsed: values.billingAccountMinutesUsed } }
      : {}),
  };
  const config = mergeConfig(DEFAULT_CONFIG, override);
  assertValidDocument("Config", config);
  return { config, enabledRules, networkEnabled: values.networkEnabled, stateDir: values.stateDir };
}
