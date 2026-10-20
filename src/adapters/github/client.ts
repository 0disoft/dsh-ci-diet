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
}

export interface GitHubRun {
  readonly id: number;
  readonly name: string | null;
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
    const body = response.body as { workflows?: GitHubWorkflow[]; total_count?: number } | null;
    return { items: body?.workflows ?? [], hasNext: nextLink(response.headers.link), totalCount: totalCount(body) };
  }

  async runs(
    options: { page: number; perPage: number; createdAfter?: string; branch?: string; event?: string; status?: string },
  ): Promise<Page<GitHubRun>> {
    const query: Record<string, string> = { page: String(options.page), per_page: String(options.perPage) };
    if (options.createdAfter !== undefined) query.created = ">=" + options.createdAfter;
    if (options.branch !== undefined) query.branch = options.branch;
    if (options.event !== undefined) query.event = options.event;
    if (options.status !== undefined) query.status = options.status;
    const response = await this.get(
      { path: this.base + "/actions/runs", query },
      "discovery",
    );
    const body = response.body as { workflow_runs?: GitHubRun[]; total_count?: number } | null;
    return { items: body?.workflow_runs ?? [], hasNext: nextLink(response.headers.link), totalCount: totalCount(body) };
  }

  async attemptJobs(runId: number, attempt: number, page: number, perPage: number): Promise<Page<GitHubJob>> {
    const response = await this.get(
      {
        path: this.base + "/actions/runs/" + runId + "/attempts/" + attempt + "/jobs",
        query: { page: String(page), per_page: String(perPage), filter: "all" },
      },
      "jobs",
    );
    const body = response.body as { jobs?: GitHubJob[]; total_count?: number } | null;
    return { items: body?.jobs ?? [], hasNext: nextLink(response.headers.link), totalCount: totalCount(body) };
  }

  async artifacts(page: number, perPage: number): Promise<Page<GitHubArtifact>> {
    const response = await this.get(
      { path: this.base + "/actions/artifacts", query: { page: String(page), per_page: String(perPage) } },
      "policyAndFiles",
    );
    const body = response.body as { artifacts?: GitHubArtifact[]; total_count?: number } | null;
    return { items: body?.artifacts ?? [], hasNext: nextLink(response.headers.link), totalCount: totalCount(body) };
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
    const items = Array.isArray(response.body) ? (response.body as GitHubPullFile[]) : [];
    return { items, hasNext: nextLink(response.headers.link), totalCount: null };
  }

  async branchRules(branch: string): Promise<unknown[]> {
    try {
      const response = await this.get({ path: this.base + "/rules/branches/" + branchSegment(branch) }, "policyAndFiles");
      return Array.isArray(response.body) ? response.body : [];
    } catch (error) {
      if (error instanceof GitHubError && error.code === "NOT_FOUND") return [];
      throw error;
    }
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