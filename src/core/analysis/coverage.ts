import type { Coverage, Dimension } from "../contracts/schema.ts";
import { COVERAGE_POLICY } from "../data/index.ts";
import { AXIS_NAMES } from "../model/domain.ts";
import type { AxisName, CoverageLevel, DimensionStatus, RuleId } from "../model/domain.ts";

export interface MissingAxis {
  readonly axis: AxisName;
  readonly status: DimensionStatus;
  readonly reasons: readonly string[];
}

export interface CoverageComposition {
  readonly level: CoverageLevel;
  readonly missingAxes: readonly MissingAxis[];
  readonly reasons: readonly string[];
  readonly writeAllowed: boolean;
}

export interface CompositionOptions {
  /** A rule that needs the current definition cannot run when it did not parse. */
  readonly currentDefinitionParsed?: boolean;
  /** Subset writes still require complete evidence for the edited job. */
  readonly editedJobEvidenceComplete?: boolean;
}

/**
 * Compose per-axis evidence status into the rule's coverage level.
 *
 * The policy file is the authority: every present role is looked up there and
 * the most restrictive result wins (full < subset < degrade < skip).
 */
export function composeCoverage(
  coverage: Coverage,
  ruleId: RuleId,
  options: CompositionOptions = {},
): CoverageComposition {
  const missingAxes: MissingAxis[] = [];
  const reasons: string[] = [];
  let levelIndex = 0;

  for (const axis of AXIS_NAMES) {
    const dimension: Dimension = coverage[axis];
    if (dimension.status === "complete") continue;
    missingAxes.push({ axis, status: dimension.status, reasons: [...dimension.reasons] });
    reasons.push("MISSING_" + axis.toUpperCase() + "_" + dimension.status.toUpperCase());
    const mapped = COVERAGE_POLICY.rules[ruleId][axis][dimension.status];
    levelIndex = Math.max(levelIndex, COVERAGE_POLICY.compositionOrder.indexOf(mapped));
  }

  if (options.currentDefinitionParsed === false) {
    levelIndex = COVERAGE_POLICY.compositionOrder.length - 1;
    reasons.push("CURRENT_DEFINITION_UNPARSABLE");
  }

  const level = COVERAGE_POLICY.compositionOrder[levelIndex] ?? "skip";
  const eligibility = COVERAGE_POLICY.writeEligibility[level];
  const writeAllowed =
    eligibility === "always" ||
    (eligibility === "requires-complete-edit-evidence" && options.editedJobEvidenceComplete === true);

  return { level, missingAxes, reasons, writeAllowed };
}

/**
 * Build a Coverage document where every axis is complete unless overridden.
 *
 * `scope` should describe what was actually looked at; it is required to be
 * non-empty by the contract, so an empty string would be a bug.
 */
export function buildCoverage(
  meta: { apiVersion: string; ghVersion: string; requestedFrom: string; requestedTo: string },
  overrides: Partial<Record<AxisName, Partial<Dimension>>>,
): Coverage {
  const dimensions = {} as Record<AxisName, Dimension>;
  for (const axis of AXIS_NAMES) {
    const override = overrides[axis] ?? {};
    dimensions[axis] = {
      status: override.status ?? "complete",
      scope: override.scope ?? "not requested",
      fetched: override.fetched ?? 0,
      expected: override.expected ?? null,
      reasons: override.reasons ?? [],
      missingScopes: override.missingScopes ?? [],
    };
  }
  return {
    apiVersion: meta.apiVersion,
    ghVersion: meta.ghVersion,
    requestedFrom: meta.requestedFrom,
    requestedTo: meta.requestedTo,
    ...dimensions,
  };
}
