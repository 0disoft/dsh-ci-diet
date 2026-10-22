import { randomUUID } from "node:crypto";

/**
 * The patch layer never reads the wall clock or mints an id directly: a caller
 * can pass a pinned clock or a deterministic id source, so lease takeover and
 * expiry boundaries are testable without waiting or racing real time.
 */
export interface Clock {
  now(): Date;
}

/** Unique-id source: full UUIDs and the short suffixes used in lease tokens. */
export interface IdSource {
  uuid(): string;
  suffix(length?: number): string;
}

/** Optional trailing seams accepted by patch operations; omitted fields use production values. */
export interface RuntimeSeams {
  readonly clock?: Clock;
  readonly ids?: IdSource;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export const systemIds: IdSource = {
  uuid: () => randomUUID(),
  suffix: (length = 8) => {
    const size = Number.isFinite(length) ? Math.max(1, Math.min(32, Math.trunc(length))) : 8;
    return randomUUID().replace(/-/g, "").slice(0, size);
  },
};

export function clockOf(seams?: RuntimeSeams): Clock {
  return seams?.clock ?? systemClock;
}

export function idsOf(seams?: RuntimeSeams): IdSource {
  return seams?.ids ?? systemIds;
}

/**
 * Boundary rule for the whole patch layer: a record is expired once the clock
 * has reached its expiry timestamp, so an approval, plan, attestation, or nonce
 * expiring exactly at `now` is already invalid.
 */
export function isExpired(nowMs: number, expiresAtMs: number): boolean {
  return nowMs >= expiresAtMs;
}

/**
 * Freshness rule for policy snapshots: fresh means the absolute age is at most
 * `maxAgeMs`. Absolute age makes a future-dated snapshot stale exactly like a
 * back-dated one, and a snapshot exactly `maxAgeMs` old is still fresh.
 */
export function isStale(nowMs: number, observedAtMs: number, maxAgeMs: number): boolean {
  return Math.abs(nowMs - observedAtMs) > maxAgeMs;
}
