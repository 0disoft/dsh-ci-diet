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

  constructor(code: GitHubErrorCode, message: string, status: number | null = null, detail: string | null = null) {
    super(message);
    this.name = "GitHubError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/** True when a retry could plausibly succeed without new credentials. */
export function isTransient(error: unknown): boolean {
  return error instanceof GitHubError && (error.code === "NETWORK_ERROR" || error.status === 502 || error.status === 503 || error.status === 504);
}
