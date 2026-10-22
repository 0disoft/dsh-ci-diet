import { execFile } from "node:child_process";
import { GitHubError } from "./errors.ts";
import { renderPath } from "./endpoints.ts";
import type { EndpointRequest } from "./endpoints.ts";
import type { Family, RequestBudget } from "./budget.ts";

export const API_VERSION = "2026-03-10";
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_RETRIES = 2;

export interface GhResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True when gh was killed before it could answer, e.g. by the execFile timeout. */
  readonly timedOut?: boolean;
}

export type GhRunner = (args: readonly string[], timeoutMs?: number, signal?: AbortSignal) => Promise<GhResult>;

export interface GhResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly etag: string | null;
  readonly notified304: boolean;
}

export interface TransportOptions {
  readonly budget: RequestBudget;
  readonly runner?: GhRunner;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly cache?: boolean;
  readonly signal?: AbortSignal;
}

const ACCEPT = "Accept: application/vnd.github+json";
const VERSION = "X-GitHub-Api-Version: " + API_VERSION;

/** Largest delay a Node timer represents without overflowing. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("the operation was aborted");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError(signal);
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    return new Promise((resolveDelay) => {
      setTimeout(resolveDelay, milliseconds);
    });
  }
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolveDelay, rejectDelay) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      rejectDelay(abortError(signal));
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Real runner: resolves the gh binary from PATH and never uses a shell. */
export const ghCliRunner: GhRunner = (args, timeoutMs = DEFAULT_TIMEOUT_MS, signal) =>
  new Promise((resolveRun, rejectRun) => {
    execFile(
      "gh",
      [...args],
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, signal },
      (error, stdout, stderr) => {
        if (error === null) {
          resolveRun({ exitCode: 0, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean };
        if (failure.code === "ABORT_ERR" || failure.name === "AbortError") {
          rejectRun(signal === undefined ? new Error("gh invocation aborted") : abortError(signal));
          return;
        }
        if (failure.code === "ENOENT") {
          resolveRun({ exitCode: 127, stdout: String(stdout), stderr: "gh was not found on PATH" });
          return;
        }
        if (failure.killed === true) {
          resolveRun({ exitCode: 1, stdout: String(stdout), stderr: String(stderr), timedOut: true });
          return;
        }
        const status = typeof failure.code === "number" ? Number(failure.code) : 1;
        resolveRun({ exitCode: Number.isInteger(status) ? status : 1, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/** Read the installed gh version for provenance. Returns null when gh is missing. */
export async function readGhVersion(runner: GhRunner = ghCliRunner, signal?: AbortSignal): Promise<string | null> {
  throwIfAborted(signal);
  try {
    const result = await runner(["--version"], DEFAULT_TIMEOUT_MS, signal);
    if (result.exitCode !== 0) return null;
    const match = /^gh version ([^\s]+)/m.exec(result.stdout);
    return match === null ? null : match[1] ?? null;
  } catch {
    if (signal?.aborted === true) throw abortError(signal);
    return null;
  }
}

function parseResponse(stdout: string): { status: number; headers: Record<string, string>; text: string } {
  const normalized = stdout.replace(/\r\n/g, "\n");
  const separator = normalized.indexOf("\n\n");
  if (separator === -1) return { status: 0, headers: {}, text: normalized };
  const block = normalized.slice(0, separator);
  const text = normalized.slice(separator + 2);
  const lines = block.split("\n");
  const statusLine = lines[0] ?? "";
  const match = /^HTTP\/[0-9.]+\s+([0-9]{3})/.exec(statusLine);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status: match === null ? 0 : Number(match[1]), headers, text };
}

function clampDelay(milliseconds: number): number {
  if (!Number.isFinite(milliseconds)) return 0;
  return Math.min(Math.max(0, Math.trunc(milliseconds)), MAX_TIMER_DELAY_MS);
}

/** Parse Retry-After: whole seconds or an HTTP-date; anything else is ignored. */
function parseRetryAfter(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (/^[0-9]+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isSafeInteger(seconds)) return null;
    // Preserve the server's pause; only clamp to what a timer can represent.
    return clampDelay(seconds * 1000);
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return clampDelay(at - Date.now());
}

function retryAfterFromHeaders(headers: Readonly<Record<string, string>>): number | null {
  const direct = parseRetryAfter(headers["retry-after"]);
  if (direct !== null) return direct;
  const reset = headers["x-ratelimit-reset"];
  if (reset === undefined) return null;
  const seconds = Number(reset.trim());
  if (!Number.isFinite(seconds)) return null;
  return clampDelay(seconds * 1000 - Date.now());
}

function classify(status: number, headers: Readonly<Record<string, string>>, text: string): GitHubError {
  const remaining = headers["x-ratelimit-remaining"];
  const reset = headers["x-ratelimit-reset"];
  const detail = text.trim().slice(0, 400);
  if (status === 401) return new GitHubError("AUTH_REQUIRED", "GitHub rejected the stored credentials; run gh auth login", 401, detail);
  if (status === 403 && remaining === "0") {
    const suffix = reset === undefined ? "" : " (resets at " + reset + ")";
    return new GitHubError("RATE_LIMITED", "GitHub primary rate limit exhausted" + suffix, 403, detail, retryAfterFromHeaders(headers));
  }
  if (status === 403) {
    const retryAfter = retryAfterFromHeaders(headers);
    // Secondary limits arrive as 403 with Retry-After (or a descriptive body) while
    // the primary quota still has headroom, so they must not be reported as a token problem.
    if (retryAfter !== null || /secondary rate limit/i.test(text)) {
      return new GitHubError("RATE_LIMITED", "GitHub secondary rate limit hit", 403, detail, retryAfter);
    }
    return new GitHubError("PERMISSION_DENIED", "the token cannot read this resource", 403, detail);
  }
  if (status === 404) return new GitHubError("NOT_FOUND", "resource not found or not accessible", 404, detail);
  if (status === 429) return new GitHubError("RATE_LIMITED", "GitHub secondary rate limit hit", 429, detail, retryAfterFromHeaders(headers));
  return new GitHubError("NETWORK_ERROR", "unexpected GitHub response: HTTP " + String(status), status, detail);
}

const MAX_BACKOFF_MS = 30_000;

/**
 * Retry only failures a second attempt can plausibly fix: rate limits and
 * secondary limits, transient gateway errors, and network-level failures
 * (status 0 or no HTTP status at all). Deterministic client errors such as
 * 400 and 422 are surfaced on the first attempt instead of burning quota.
 */
function isRetryable(failure: GitHubError): boolean {
  if (failure.code === "RATE_LIMITED") return true;
  const status = failure.status;
  if (status === 429 || status === 502 || status === 503 || status === 504) return true;
  return failure.code === "NETWORK_ERROR" && (status === 0 || status === null);
}

function retryDelay(failure: GitHubError, attempt: number): number {
  // A server-supplied Retry-After wins over our own backoff schedule.
  if (failure.retryAfterMs !== null) return failure.retryAfterMs;
  return Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
}

/** Read-only GitHub.com transport: allowlisted GETs through the user`s gh credentials. */
export class GhTransport {
  private readonly budget: RequestBudget;
  private readonly runner: GhRunner;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly cache: boolean;
  private readonly signal: AbortSignal | undefined;
  private readonly etags = new Map<string, { etag: string; response: GhResponse }>();

  constructor(options: TransportOptions) {
    this.budget = options.budget;
    this.runner = options.runner ?? ghCliRunner;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.sleep = options.sleep ?? delay;
    this.cache = options.cache ?? true;
    this.signal = options.signal;
  }

  async get(request: EndpointRequest, family: Family): Promise<GhResponse> {
    throwIfAborted(this.signal);
    const rendered = renderPath(request);
    const cached = this.cache ? this.etags.get(rendered) : undefined;
    let lastError: GitHubError | null = null;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      throwIfAborted(this.signal);
      this.budget.consume(family);
      try {
        const response = await this.dispatch(rendered, cached?.etag ?? null);
        if (response.notified304 && cached !== undefined) return { ...cached.response, status: 304 };
        if (this.cache && response.etag !== null) this.etags.set(rendered, { etag: response.etag, response });
        return response;
      } catch (error) {
        if (this.signal?.aborted === true) throw abortError(this.signal);
        const failure = error instanceof GitHubError ? error : new GitHubError("NETWORK_ERROR", String(error));
        lastError = failure;
        if (!isRetryable(failure) || attempt === this.retries) break;
        const wait = retryDelay(failure, attempt);
        await this.sleep(wait, this.signal);
        throwIfAborted(this.signal);
      } finally {
        this.budget.settle();
      }
    }
    throw lastError ?? new GitHubError("NETWORK_ERROR", "request failed without a reason");
  }

  private async dispatch(path: string, etag: string | null): Promise<GhResponse> {
    throwIfAborted(this.signal);
    const args = ["api", "--hostname", "github.com", "--method", "GET", "--include", "-H", ACCEPT, "-H", VERSION];
    if (etag !== null) args.push("-H", "If-None-Match: " + etag);
    args.push(path);
    let result: GhResult;
    try {
      result = await this.runner(args, this.timeoutMs, this.signal);
    } catch (error) {
      if (this.signal?.aborted === true) throw abortError(this.signal);
      throw new GitHubError("NETWORK_ERROR", "gh invocation failed: " + String(error));
    }
    if (result.exitCode === 127) throw new GitHubError("GH_NOT_INSTALLED", "gh CLI is not installed or not on PATH", null, result.stderr.trim());
    if (result.timedOut === true) throw new GitHubError("NETWORK_ERROR", "gh timed out after " + String(this.timeoutMs) + "ms", 0);
    const parsed = parseResponse(result.stdout);
    if (parsed.status === 304) {
      return { status: 304, headers: parsed.headers, body: null, etag, notified304: true };
    }
    if (parsed.status >= 200 && parsed.status < 300) {
      let body: unknown = null;
      if (parsed.text.trim() !== "") {
        try {
          body = JSON.parse(parsed.text);
        } catch {
          throw new GitHubError("NETWORK_ERROR", "GitHub returned a non-JSON body", parsed.status, parsed.text.slice(0, 200));
        }
      }
      return { status: parsed.status, headers: parsed.headers, body, etag: parsed.headers["etag"] ?? null, notified304: false };
    }
    throw classify(parsed.status, parsed.headers, result.stderr.trim() !== "" ? result.stderr : parsed.text);
  }
}
