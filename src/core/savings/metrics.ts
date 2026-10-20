import type { CountMetric, Metric, SecondsMetric, StringMetric, UsdMetric } from "../contracts/schema.ts";

type MetricStatus = Metric["status"];

function build<T extends Metric>(
  status: MetricStatus,
  value: number | string | null,
  basis: string,
  reason: string | null,
): T {
  return { status, value, basis, reason } as T;
}

export function knownCount(value: number, basis: string): CountMetric {
  return build<CountMetric>("known", value, basis, null);
}

export function knownSeconds(value: number, basis: string): SecondsMetric {
  return build<SecondsMetric>("known", value, basis, null);
}

export function knownString(value: string, basis: string): StringMetric {
  return build<StringMetric>("known", value, basis, null);
}

export function knownUsd(value: string, basis: string): UsdMetric {
  return build<UsdMetric>("known", value, basis, null);
}

export function unknownCount(basis: string, reason: string): CountMetric {
  return build<CountMetric>("unknown", null, basis, reason);
}

export function unknownSeconds(basis: string, reason: string): SecondsMetric {
  return build<SecondsMetric>("unknown", null, basis, reason);
}

export function unknownString(basis: string, reason: string): StringMetric {
  return build<StringMetric>("unknown", null, basis, reason);
}

export function unknownUsd(basis: string, reason: string): UsdMetric {
  return build<UsdMetric>("unknown", null, basis, reason);
}

// The contract requires a non-empty reason for every non-known status, so the
// explanation is carried in both `basis` (what was measured) and `reason`
// (why it does not apply).
export function notApplicableSeconds(basis: string): SecondsMetric {
  return build<SecondsMetric>("not_applicable", null, basis, basis);
}

export function notApplicableCount(basis: string): CountMetric {
  return build<CountMetric>("not_applicable", null, basis, basis);
}

export function notApplicableUsd(basis: string): UsdMetric {
  return build<UsdMetric>("not_applicable", null, basis, basis);
}

/** USD from integer microUSD, always six decimals. */
export function formatUsd(microUsd: number): string {
  if (!Number.isSafeInteger(microUsd)) throw new Error("usd amount must be an integer microUSD value");
  const sign = microUsd < 0 ? "-" : "";
  const abs = Math.abs(microUsd);
  const whole = Math.floor(abs / 1_000_000);
  const fraction = String(abs % 1_000_000).padStart(6, "0");
  return sign + whole + "." + fraction;
}

/** Seconds rendered with at most three decimals and no float noise. */
export function secondsFromMillis(millis: number): number {
  return Math.round(millis / 10) / 100;
}
