import { digestOf } from "../../shared/cdj1.ts";
import type { PricingSnapshot } from "../contracts/schema.ts";
import type { AxisName, CoverageLevel, DimensionStatus, RuleId } from "../model/domain.ts";
import { COVERAGE_POLICY_JSON, PRICING_SNAPSHOT_JSON } from "./contracts.generated.ts";

export interface CoveragePolicy {
  readonly schemaVersion: number;
  readonly requiredCurrentDefinition: string;
  readonly levels: Readonly<Record<CoverageLevel, string>>;
  readonly compositionOrder: readonly CoverageLevel[];
  readonly writeEligibility: Readonly<Record<CoverageLevel, string>>;
  readonly axes: readonly AxisName[];
  readonly rules: Readonly<
    Record<RuleId, Readonly<Record<AxisName, Readonly<Record<DimensionStatus, CoverageLevel>>>>>
  >;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/**
 * Parse and verify the embedded price snapshot.
 *
 * The snapshot is the contract file itself, so its content hash must match
 * the CDJ1 digest of the fields it freezes. A mismatch is a build defect and
 * must never degrade into a silently different price table.
 */
export function loadPricingSnapshot(json: string): PricingSnapshot {
  const snapshot = JSON.parse(json) as PricingSnapshot;
  const expected = digestOf({
    pricingSnapshotId: snapshot.pricingSnapshotId,
    observedAt: snapshot.observedAt,
    rows: snapshot.rows,
  });
  if (expected !== snapshot.contentHash) {
    throw new Error("pricing snapshot contentHash mismatch: " + expected + " != " + snapshot.contentHash);
  }
  return deepFreeze(snapshot);
}

export function loadCoveragePolicy(json: string): CoveragePolicy {
  const policy = JSON.parse(json) as CoveragePolicy;
  for (const level of policy.compositionOrder) {
    if (!(level in policy.levels)) throw new Error("coverage policy is missing level " + level);
  }
  return deepFreeze(policy);
}

/** Frozen GitHub Actions list prices; installation never refreshes them. */
export const PRICING_SNAPSHOT: PricingSnapshot = loadPricingSnapshot(PRICING_SNAPSHOT_JSON);

export const PRICING_CONTENT_HASH: string = PRICING_SNAPSHOT.contentHash;

/** Authority for composed coverage levels and write eligibility. */
export const COVERAGE_POLICY: CoveragePolicy = loadCoveragePolicy(COVERAGE_POLICY_JSON);

export function pricePerMinuteMicro(sku: string): number | null {
  for (const row of PRICING_SNAPSHOT.rows) {
    if (row.sku === sku) return row.usdPerMinuteMicro;
  }
  return null;
}
