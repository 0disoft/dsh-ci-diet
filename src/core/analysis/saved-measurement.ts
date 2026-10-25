import type { AppliedChange } from "../contracts/schema.ts";
import { isDeepStrictEqual } from "node:util";
import { measureChangeEffect, type ChangeEffect } from "./change-effect.ts";

export interface SavedMeasurement {
  readonly measuredAt: string;
  readonly bindingId: string;
  readonly effect: ChangeEffect;
}

/** Cached metrics must still match the journal and recompute from bounded samples. */
export function savedMeasurementOf(change: AppliedChange, value: unknown): SavedMeasurement | null {
  try {
    const saved = value as SavedMeasurement, effect = saved.effect;
    if (!Number.isFinite(Date.parse(saved.measuredAt)) || saved.bindingId !== change.bindingId
      || effect.changeId !== change.changeId || effect.planDigest !== change.planDigest
      || ![effect.before.runs, effect.after.runs].every((runs) => Array.isArray(runs) && runs.length >= 1 && runs.length <= 10)) return null;
    const recomputed = measureChangeEffect(change, effect.before.runs, effect.after.runs);
    // V1 repeated the observations and step diffs in every pair. Keep its raw
    // samples and verify all aggregate fields, deriving only the new pairs.
    // Rendering upgrades the returned value without writing to the cache.
    const candidate = effect.schemaVersion === 1
      ? { ...effect, schemaVersion: 2, comparisons: recomputed.comparisons }
      : effect;
    return isDeepStrictEqual(recomputed, candidate) ? { ...saved, effect: recomputed } : null;
  } catch { return null; }
}
