/**
 * Shared domain policy values.
 *
 * These are product limits, not user settings: the frozen contract fixes some
 * of them, and the rest are safety bounds that must agree wherever they are
 * enforced. Callers should import from here instead of redefining a literal.
 */

export const DAY_MS = 86_400_000;

/** Artifact retention proposed by CD008; also the longest consumer window a claim may name. */
export const PROPOSED_RETENTION_DAYS = 7;

export const PLAN_TTL_SECONDS = 7 * 24 * 60 * 60;

/** How old a protection or retention snapshot may be when a plan or apply uses it. */
export const POLICY_MAX_AGE_SECONDS = 600;
export const POLICY_MAX_AGE_MS = POLICY_MAX_AGE_SECONDS * 1000;

/** Approval nonce lifetime when the caller does not pass the configured value. */
export const DEFAULT_APPROVAL_TTL_SECONDS = 600;

/** Human attestation lifetime when the caller does not pass the configured value. */
export const DEFAULT_ATTESTATION_TTL_DAYS = 30;
export const DEFAULT_ATTESTATION_TTL_SECONDS = DEFAULT_ATTESTATION_TTL_DAYS * 24 * 60 * 60;

export const WRITER_LEASE_STALE_MS = 10 * 60_000;
export const LEASE_CLAIM_STALE_MS = 60_000;
export const CLAIM_POLL_MS = 20;
export const STORE_WRITE_LOCK_WAIT_MS = 10_000;
export const APPROVE_LOCK_WAIT_MS = 250;

/** Overall bound for one history sync, including retries and backoff. */
export const DEFAULT_SYNC_DEADLINE_MS = 5 * 60_000;

export const HISTORY_LOOKBACK_DAYS_MIN = 1;
export const HISTORY_CONCURRENT_REQUESTS_MIN = 1;
export const HISTORY_CONCURRENT_REQUESTS_MAX = 4;
export const HISTORY_LOOKBACK_DAYS_MAX = 30;

export const TIMEOUT_MINUTES_MIN = 1;
export const TIMEOUT_MINUTES_MAX = 360;

export const CONSUMER_MIN_DAYS_MIN = 1;
export const CONSUMER_MIN_DAYS_MAX = PROPOSED_RETENTION_DAYS;
