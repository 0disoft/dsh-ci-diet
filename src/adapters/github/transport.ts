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
}

export type GhRunner = (args: readonly string[]) => Promise<GhResult>;

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
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly cache?: boolean;
}

const ACCEPT = "Accept: application/vnd.github+json";
const VERSION = "X-GitHub-Api-Version: " + API_VERSION;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

/** Real runner: resolves the gh binary from PATH and never uses a shell. */
export const ghCliRunner: GhRunner = (args) =>
  new Promise((resolveRun) => {
    execFile("gh", [...args], { timeout: DEFAULT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error === null) {
        resolveRun({ exitCode: 0, stdout: String(stdout), stderr: String(stderr) });
        return;
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        resolveRun({ exitCode: 127, stdout: String(stdout), stderr: "gh was not found on PATH" });
        return;
      }
      const status = typeof (error as { code?: unknown }).code === "number" ? Number((error as { code?: unknown }).code) : 1;
      resolveRun({ exitCode: Number.isInteger(status) ? status : 1, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** Read the installed gh version for provenance. Returns null when gh is missing. */
export async function readGhVersion(runner: GhRunner = ghCliRunner): Promise<string | null> {
  try {
    const result = await runner(["--version"]);
    if (result.exitCode !== 0) return null;
    const match = /^gh version ([^\s]+)/m.exec(result.stdout);
    return match === null ? null : match[1] ?? null;
  } catch {
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

function classify(status: number, headers: Readonly<Record<string, string>>, text: string): GitHubError {
  const remaining = headers["x-ratelimit-remaining"];
  const reset = headers["x-ratelimit-reset"];
  const detail = text.trim().slice(0, 400);
  if (status === 401) return new GitHubError("AUTH_REQUIRED", "GitHub rejected the stored credentials; run gh auth login", 401, detail);
  if (status === 403 && remaining === "0") {
    const suffix = reset === undefined ? "" : " (resets at " + reset + ")";
    return new GitHubError("RATE_LIMITED", "GitHub primary rate limit exhausted" + suffix, 403, detail);
  }
  if (status === 403) return new GitHubError("PERMISSION_DENIED", "the token cannot read this resource", 403, detail);
  if (status === 404) return new GitHubError("NOT_FOUND", "resource not found or not accessible", 404, detail);
  if (status === 429) return new GitHubError("RATE_LIMITED", "GitHub secondary rate limit hit", 429, detail);
  return new GitHubError("NETWORK_ERROR", "unexpected GitHub response: HTTP " + String(status), status, detail);
}

function retryDelay(status: number, headers: Readonly<Record<string, string>>, attempt: number): number {
  const retryAfter = headers["retry-after"];
  const parsed = retryAfter === undefined ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(parsed) && parsed >= 0) return Math.min(parsed * 1000, 30_000);
  return Math.min(500 * 2 ** attempt, 8_000);
}

/** Read-only GitHub.com transport: allowlisted GETs through the user`s gh credentials. */
export class GhTransport {
  private readonly budget: RequestBudget;
  private readonly runner: GhRunner;
  private readonly retries: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly cache: boolean;
  private readonly etags = new Map<string, { etag: string; response: GhResponse }>();

  constructor(options: TransportOptions) {
    this.budget = options.budget;
    this.runner = options.runner ?? ghCliRunner;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.sleep = options.sleep ?? delay;
    this.cache = options.cache ?? true;
  }

  async get(request: EndpointRequest, family: Family): Promise<GhResponse> {
    const rendered = renderPath(request);
    const cached = this.cache ? this.etags.get(rendered) : undefined;
    let lastError: GitHubError | null = null;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      this.budget.consume(family);
      try {
        const response = await this.dispatch(rendered, cached?.etag ?? null);
        if (response.notified304 && cached !== undefined) return { ...cached.response, status: 304 };
        if (this.cache && response.etag !== null) this.etags.set(rendered, { etag: response.etag, response });
        return response;
      } catch (error) {
        const failure = error instanceof GitHubError ? error : new GitHubError("NETWORK_ERROR", String(error));
        lastError = failure;
        const transient = failure.status === 429 || failure.status === 502 || failure.status === 503 || failure.status === 504;
        if (!transient || attempt === this.retries) break;
        const wait = retryDelay(failure.status ?? 0, {}, attempt);
        await this.sleep(wait);
      } finally {
        this.budget.settle();
      }
    }
    throw lastError ?? new GitHubError("NETWORK_ERROR", "request failed without a reason");
  }

  private async dispatch(path: string, etag: string | null): Promise<GhResponse> {
    const args = ["api", "--hostname", "github.com", "--method", "GET", "--include", "-H", ACCEPT, "-H", VERSION];
    if (etag !== null) args.push("-H", "If-None-Match: " + etag);
    args.push(path);
    let result: GhResult;
    try {
      result = await this.runner(args);
    } catch (error) {
      throw new GitHubError("NETWORK_ERROR", "gh invocation failed: " + String(error));
    }
    if (result.exitCode === 127) throw new GitHubError("GH_NOT_INSTALLED", "gh CLI is not installed or not on PATH", null, result.stderr.trim());
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
