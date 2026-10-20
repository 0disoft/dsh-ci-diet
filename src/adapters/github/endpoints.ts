import { GitHubError } from "./errors.ts";

const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9_./-]+$/;
const PATH_SEGMENT = /^[A-Za-z0-9_.@ -]+$/;

/** One allowed GET request: a path template plus the query keys it accepts. */
interface EndpointRule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly query: readonly string[];
  readonly requiredQuery?: readonly string[];
}

const REPO = String.raw`^/repos/[^/]+/[^/]+`;

const RULES: readonly EndpointRule[] = [
  { name: "repository", pattern: new RegExp(REPO + "$"), query: [] },
  { name: "workflows", pattern: new RegExp(REPO + "/actions/workflows$"), query: ["per_page", "page"] },
  {
    name: "runs",
    pattern: new RegExp(REPO + "/actions/runs$"),
    query: ["per_page", "page", "status", "created", "branch", "event", "head_sha"],
  },
  { name: "run-jobs", pattern: new RegExp(REPO + "/actions/runs/[0-9]+/attempts/[0-9]+/jobs$"), query: ["per_page", "page", "filter"] },
  { name: "artifacts", pattern: new RegExp(REPO + "/actions/artifacts$"), query: ["per_page", "page"] },
  { name: "artifact-retention", pattern: new RegExp(REPO + "/actions/permissions/artifact-and-log-retention$"), query: [] },
  { name: "contents", pattern: new RegExp(REPO + "/contents/[^/]+$"), query: ["ref"], requiredQuery: ["ref"] },
  { name: "pull", pattern: new RegExp(REPO + "/pulls/[0-9]+$"), query: [] },
  { name: "pull-files", pattern: new RegExp(REPO + "/pulls/[0-9]+/files$"), query: ["per_page", "page"] },
  { name: "compare", pattern: new RegExp(REPO + "/compare/[^/]+$"), query: ["per_page", "page"] },
  { name: "branch-rules", pattern: new RegExp(REPO + "/rules/branches/[^/]+$"), query: [] },
  { name: "branch-protection", pattern: new RegExp(REPO + "/branches/[^/]+/protection$"), query: [] },
];

export interface EndpointRequest {
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
}

export function ownerRepoPath(owner: string, repo: string): string {
  for (const value of [owner, repo]) {
    if (!SEGMENT.test(value) || value === "." || value === "..") {
      throw new GitHubError("INVALID_ENDPOINT", "invalid repository owner or name: " + value);
    }
  }
  return "/repos/" + owner + "/" + repo;
}

export function branchSegment(branch: string): string {
  if (!BRANCH.test(branch) || branch.includes("..")) {
    throw new GitHubError("INVALID_ENDPOINT", "invalid branch name: " + branch);
  }
  return encodeURIComponent(branch);
}

export function contentsSegments(path: string): string {
  const parts = path.split("/");
  if (parts.length === 0) throw new GitHubError("INVALID_ENDPOINT", "empty contents path");
  return parts.map((part) => {
    if (!PATH_SEGMENT.test(part) || part === "." || part === "..") {
      throw new GitHubError("INVALID_ENDPOINT", "invalid contents path: " + path);
    }
    return encodeURIComponent(part);
  }).join("/");
}

export function validateRequest(request: EndpointRequest): EndpointRule {
  const query = request.query ?? {};
  for (const rule of RULES) {
    if (!rule.pattern.test(request.path)) continue;
    for (const key of Object.keys(query)) {
      if (!rule.query.includes(key)) {
        throw new GitHubError("INVALID_ENDPOINT", "query key not allowed for " + rule.name + ": " + key);
      }
    }
    for (const key of rule.requiredQuery ?? []) {
      if (query[key] === undefined) throw new GitHubError("INVALID_ENDPOINT", "missing query key for " + rule.name + ": " + key);
    }
    return rule;
  }
  throw new GitHubError("INVALID_ENDPOINT", "path is not on the read-only allowlist: " + request.path);
}

/** Render a validated request to the single argv element passed to gh. */
export function renderPath(request: EndpointRequest): string {
  validateRequest(request);
  const query = request.query ?? {};
  const keys = Object.keys(query).sort();
  if (keys.length === 0) return request.path;
  const pairs = keys.map((key) => key + "=" + encodeURIComponent(query[key] ?? ""));
  return request.path + "?" + pairs.join("&");
}
