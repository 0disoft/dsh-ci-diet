/** Half-open interval in milliseconds relative to a job start. */
export interface MillisInterval {
  readonly startMillis: number;
  readonly endMillis: number;
}

/**
 * Clip an interval to [0, duration).
 *
 * Returns null for empty or fully out-of-range intervals so callers never
 * accidentally count a zero-length removal or a negative one.
 */
export function clipInterval(interval: MillisInterval, durationMillis: number): MillisInterval | null {
  if (durationMillis <= 0) return null;
  const start = Math.max(0, interval.startMillis);
  const end = Math.min(durationMillis, interval.endMillis);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (end <= start) return null;
  return { startMillis: start, endMillis: end };
}

export function unionLengthMillis(intervals: readonly MillisInterval[], durationMillis: number): number {
  const clipped: MillisInterval[] = [];
  for (const interval of intervals) {
    const clippedInterval = clipInterval(interval, durationMillis);
    if (clippedInterval) clipped.push(clippedInterval);
  }
  clipped.sort((a, b) => a.startMillis - b.startMillis || a.endMillis - b.endMillis);
  let total = 0;
  let currentStart = Number.NaN;
  let currentEnd = Number.NaN;
  for (const interval of clipped) {
    if (Number.isNaN(currentStart)) {
      currentStart = interval.startMillis;
      currentEnd = interval.endMillis;
      continue;
    }
    if (interval.startMillis <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.endMillis);
      continue;
    }
    total += currentEnd - currentStart;
    currentStart = interval.startMillis;
    currentEnd = interval.endMillis;
  }
  if (!Number.isNaN(currentStart)) total += currentEnd - currentStart;
  return total;
}

/** Whole paid minutes for a duration; zero seconds is zero minutes. */
export function minutesFromMillis(durationMillis: number): number {
  if (durationMillis <= 0) return 0;
  return Math.ceil(durationMillis / 60_000);
}

export interface JobScenario {
  readonly baselineMillis: number;
  readonly removedMillis: number;
  readonly scenarioMillis: number;
  readonly baselineMinutes: number;
  readonly scenarioMinutes: number;
}

export function jobScenario(durationMillis: number, intervals: readonly MillisInterval[]): JobScenario {
  const removedMillis = unionLengthMillis(intervals, durationMillis);
  const scenarioMillis = durationMillis - removedMillis;
  return {
    baselineMillis: durationMillis,
    removedMillis,
    scenarioMillis,
    baselineMinutes: minutesFromMillis(durationMillis),
    scenarioMinutes: minutesFromMillis(scenarioMillis),
  };
}
