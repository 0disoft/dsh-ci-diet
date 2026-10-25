import { GitHubError } from "./errors.ts";
import { branchSegment, contentsSegments, ownerRepoPath } from "./endpoints.ts";
import type { EndpointRequest } from "./endpoints.ts";
import type { Family } from "./budget.ts";
import type { GhResponse, GhTransport } from "./transport.ts";

export interface GitHubRepository {
  readonly id: number;
  readonly full_name: string;
  readonly default_branch: string;
  readonly private: boolean;
}

export interface GitHubWorkflow {
  readonly id: number;
  readonly name: string;
  readonly path: string;
  readonly state: string;
}

export interface GitHubPullReference {
  readonly number: number;
  readonly base?: { readonly sha: string };
  readonly head?: { readonly sha: string };
}

export interface GitHubRun {
  readonly id: number;
  readonly name: string | null;
  /** Present when GitHub links the run to a listed workflow. */
  readonly workflow_id?: number;
  readonly path: string;
  readonly head_sha: string;
  readonly head_branch: string | null;
  readonly event: string;
  readonly status: string | null;
  readonly conclusion: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly run_attempt: number;
  readonly pull_requests?: readonly GitHubPullReference[];
}

export interface GitHubJob {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly labels?: readonly string[];
  readonly runner_name?: string | null;
}

export interface GitHubArtifact {
  readonly id: number;
  readonly name: string;
  readonly size_in_bytes: number;
  readonly created_at: string;
  readonly expires_at: string | null;
}

export interface GitHubPullFile {
  readonly filename: string;
  readonly status: string;
  readonly previous_filename?: string;
}

export interface RetentionPolicy {
  readonly days: number;
  readonly maximum_allowed_days: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly hasNext: boolean;
  readonly totalCount: number | null;
}

export interface WorkflowContent {
  readonly path: string;
  readonly sha: string;
  readonly text: string;
}

export const MAX_CONTENT_BYTES = 512 * 1024;

function nextLink(header: string | undefined): boolean {
  return header !== undefined && /rel="next"/.test(header);
}

function totalCount(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as { total_count?: unknown }).total_count;
  return typeof value === "number" ? value : null;
}

/** Missing or malformed lists are collection failures, never confirmed empty evidence. */
function pageOf<T>(response: GhResponse, key: string | null): Page<T> {
  const body = response.body;
  const items: unknown = key === null ? body
    : body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)[key] : undefined;
  if (!Array.isArray(items)) {
    throw new GitHubError("NETWORK_ERROR", "GitHub returned an invalid " + (key ?? "pull-files") + " list", response.status);
  }
  return { items: items as T[], hasNext: nextLink(response.headers.link), totalCount: key === null ? null : totalCount(body) };
}

/** Typed reads over the allowlisted transport; every method returns raw API data. */
export class GitHubClient {
  readonly owner: string;
  readonly repo: string;
  private readonly transport: GhTransport;
  private readonly base: string;

  constructor(transport: GhTransport, owner: string, repo: string) {
    this.transport = transport;
    this.owner = owner;
    this.repo = repo;
    this.base = ownerRepoPath(owner, repo);
  }

  private async get(request: EndpointRequest, family: Family): Promise<GhResponse> {
    const response = await this.transport.get(request, family);
    return response;
  }

  async repository(): Promise<GitHubRepository> {
    const response = await this.get({ path: this.base }, "discovery");
    return response.body as GitHubRepository;
  }

  async workflows(page: number, perPage: number): Promise<Page<GitHubWorkflow>> {
    const response = await this.get(
      { path: this.base + "/actions/workflows", query: { page: String(page), per_page: String(perPage) } },
      "discovery",
    );
    return pageOf<GitHubWorkflow>(response, "workflows");
  }

  async runs(
    options: { page: number; perPage: number; createdAfter?: string; createdBefore?: string; branch?: string; event?: string; status?: string },
  ): Promise<Page<GitHubRun>> {
    const query: Record<string, string> = { page: String(options.page), per_page: String(options.perPage) };
    if (options.createdAfter !== undefined && options.createdBefore !== undefined) {
      query.created = options.createdAfter + ".." + options.createdBefore;
    } else if (options.createdAfter !== undefined) {
      query.created = ">=" + options.createdAfter;
    } else if (options.createdBefore !== undefined) {
      query.created = "<=" + options.createdBefore;
    }
    if (options.branch !== undefined) query.branch = options.branch;
    if (options.event !== undefined) query.event = options.event;
    if (options.status !== undefined) query.status = options.status;
    const response = await this.get(
      { path: this.base + "/actions/runs", query },
      "discovery",
    );
    return pageOf<GitHubRun>(response, "workflow_runs");
  }

  async attemptJobs(runId: number, attempt: number, page: number, perPage: number): Promise<Page<GitHubJob>> {
    const response = await this.get(
      {
        path: this.base + "/actions/runs/" + runId + "/attempts/" + attempt + "/jobs",
        query: { page: String(page), per_page: String(perPage), filter: "all" },
      },
      "jobs",
    );
    return pageOf<GitHubJob>(response, "jobs");
  }

  async artifacts(page: number, perPage: number): Promise<Page<GitHubArtifact>> {
    const response = await this.get(
      { path: this.base + "/actions/artifacts", query: { page: String(page), per_page: String(perPage) } },
      "policyAndFiles",
    );
    return pageOf<GitHubArtifact>(response, "artifacts");
  }

  async retentionPolicy(): Promise<RetentionPolicy> {
    const response = await this.get(
      { path: this.base + "/actions/permissions/artifact-and-log-retention" },
      "policyAndFiles",
    );
    return response.body as RetentionPolicy;
  }

  async contents(path: string, ref: string): Promise<WorkflowContent | null> {
    const response = await this.get(
      { path: this.base + "/contents/" + contentsSegments(path), query: { ref } },
      "definitions",
    );
    const body = response.body as { sha?: string; content?: string; encoding?: string } | null;
    if (body?.content === undefined || body.encoding !== "base64") return null;
    const buffer = Buffer.from(body.content.replace(/\s/g, ""), "base64");
    if (buffer.byteLength > MAX_CONTENT_BYTES) return null;
    return { path, sha: body.sha ?? ref, text: buffer.toString("utf8") };
  }

  /** Compare immutable refs; GitHub exposes at most 300 files, so the cap is unknown. */
  async changedFilesAt(baseSha: string, headSha: string): Promise<readonly string[] | null> {
    if (![baseSha, headSha].every((sha) => /^[a-f0-9]{40}$/i.test(sha))) return null;
    const response = await this.get({ path: this.base + "/compare/" + baseSha + "..." + headSha,
      query: { per_page: "1", page: "1" } }, "policyAndFiles");
    const body = response.body as { files?: GitHubPullFile[]; base_commit?: { sha?: string } } | null;
    if (!Array.isArray(body?.files) || body.files.length >= 300 || body.base_commit?.sha !== baseSha) return null;
    const files: string[] = [];
    for (const file of body.files) {
      if (typeof file.filename !== "string" || (file.previous_filename !== undefined && typeof file.previous_filename !== "string")) return null;
      files.push(file.filename);
      if (file.previous_filename !== undefined) files.push(file.previous_filename);
    }
    return files;
  }

  async pull(number: number): Promise<{ number: number; baseBranch: string; headBranch: string }> {
    const response = await this.get(
      { path: this.base + "/pulls/" + number },
      "policyAndFiles",
    );
    const body = response.body as { base?: { ref?: string }; head?: { ref?: string } } | null;
    return { number, baseBranch: body?.base?.ref ?? "", headBranch: body?.head?.ref ?? "" };
  }

  async pullFiles(number: number, page: number, perPage: number): Promise<Page<GitHubPullFile>> {
    const response = await this.get(
      { path: this.base + "/pulls/" + number + "/files", query: { page: String(page), per_page: String(perPage) } },
      "policyAndFiles",
    );
    return pageOf<GitHubPullFile>(response, null);
  }

  async branchRules(branch: string): Promise<unknown[]> {
    const response = await this.get({ path: this.base + "/rules/branches/" + branchSegment(branch) }, "policyAndFiles");
    // Only a successful array establishes the rule count. Unlike classic
    // protection, a 404 here is not evidence that no branch rules apply.
    if (!Array.isArray(response.body)) {
      throw new GitHubError("NETWORK_ERROR", "GitHub returned a non-array branch-rules response", response.status);
    }
    return response.body;
  }

  async branchProtection(branch: string): Promise<unknown | null> {
    try {
      const response = await this.get({ path: this.base + "/branches/" + branchSegment(branch) + "/protection" }, "policyAndFiles");
      return response.body;
    } catch (error) {
      if (error instanceof GitHubError && error.code === "NOT_FOUND") return null;
      throw error;
    }
  }
}
