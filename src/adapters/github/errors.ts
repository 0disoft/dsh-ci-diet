/** Failure modes of the read-only GitHub adapter. */
export type GitHubErrorCode =
  | "GH_NOT_INSTALLED"
  | "AUTH_REQUIRED"
  | "PERMISSION_DENIED"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "NETWORK_ERROR"
  | "INVALID_ENDPOINT"
  | "BUDGET_EXHAUSTED";

export class GitHubError extends Error {
  readonly code: GitHubErrorCode;
  readonly status: number | null;
  readonly detail: string | null;
  /** Server-requested pause before a retry, when GitHub supplied one. */
  readonly retryAfterMs: number | null;

  constructor(code: GitHubErrorCode, message: string, status: number | null = null, detail: string | null = null, retryAfterMs: number | null = null, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GitHubError";
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
  }
}

/** True when a retry could plausibly succeed without new credentials. */
export function isTransient(error: unknown): boolean {
  if (!(error instanceof GitHubError)) return false;
  if (error.code === "NETWORK_ERROR") return true;
  if (error.code === "RATE_LIMITED") return true;
  return error.status === 502 || error.status === 503 || error.status === 504;
}
