import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { digestOf, sha256Hex } from "../../shared/cdj1.ts";
import type { RepositoryBinding } from "../contracts/schema.ts";

export interface GithubRemote {
  readonly owner: string;
  readonly repository: string;
  readonly fullName: string;
}

const REMOTE_PATTERNS: readonly RegExp[] = [
  /^https?:\/\/(?:[^@/]+@)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i,
  /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i,
  /^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i,
];

export function parseGithubRemote(url: string): GithubRemote | null {
  const trimmed = url.trim();
  for (const pattern of REMOTE_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (!match) continue;
    const owner = match[1];
    const repository = match[2];
    if (owner === undefined || repository === undefined) return null;
    return { owner, repository, fullName: owner + "/" + repository };
  }
  return null;
}

export function readGithubRemote(workspaceRoot: string): GithubRemote | null {
  try {
    const url = execFileSync("git", ["-C", workspaceRoot, "remote", "get-url", "origin"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return parseGithubRemote(url);
  } catch {
    return null;
  }
}

export function rootIdentityHash(workspaceRoot: string): string {
  return digestOf({ workspaceRoot: realpathSync.native(workspaceRoot) });
}

export interface LocalBindingResult {
  readonly binding: RepositoryBinding;
  readonly warnings: readonly string[];
}

/**
 * Create the offline Binding used by a static scan.
 *
 * A static scan never talks to the API, so the numeric repository id is not
 * known. The contract only requires a non-empty string, so an offline binding
 * records `git:<hash of the remote>` when an origin exists and
 * `local:<hash of the workspace>` otherwise. Sync upgrades the binding after
 * the API confirms the repository.
 */
export function createLocalBinding(workspaceRoot: string, generatedAt: string): LocalBindingResult {
  const root = realpathSync.native(workspaceRoot);
  const remote = readGithubRemote(root);
  const warnings: string[] = [];
  const identity = rootIdentityHash(root);

  let repositoryId: string;
  let repositoryFullName: string;
  if (remote !== null) {
    repositoryId = "git:" + sha256Hex(remote.fullName.toLowerCase()).slice(0, 32);
    repositoryFullName = remote.fullName;
  } else {
    warnings.push("GITHUB_REMOTE_NOT_FOUND");
    repositoryId = "local:" + identity.slice("sha256:".length, "sha256:".length + 32);
    repositoryFullName = "local/" + basename(root);
  }

  const bindingId = "b_" + sha256Hex(repositoryId + "\n" + root + "\n" + identity).slice(0, 24);
  return {
    binding: {
      schemaVersion: 2,
      provenance: "observed",
      bindingId,
      repositoryId,
      repositoryFullName,
      host: "github.com",
      workspaceRoot: root,
      rootIdentityHash: identity,
      stateScope: bindingId,
      createdAt: generatedAt,
    },
    warnings,
  };
}
