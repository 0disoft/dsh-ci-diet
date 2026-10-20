/** Domain vocabulary shared by the analysis pipeline and the frozen contracts. */

export type RuleId = "CD001" | "CD002" | "CD003" | "CD004" | "CD005" | "CD008";

export const RULE_IDS: readonly RuleId[] = ["CD001", "CD002", "CD003", "CD004", "CD005", "CD008"];

export type AxisName =
  | "history"
  | "workflowDefinitions"
  | "changedFiles"
  | "protectionRules"
  | "retentionPolicy";

export const AXIS_NAMES: readonly AxisName[] = [
  "history",
  "workflowDefinitions",
  "changedFiles",
  "protectionRules",
  "retentionPolicy",
];

export type DimensionStatus = "complete" | "partial" | "unavailable";

export type CoverageLevel = "full" | "subset" | "degrade" | "skip";
