import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { nodeFileSystem } from "../support/filesystem.ts";
import type { FileSystem } from "../support/filesystem.ts";
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

export interface CommandResult {
  readonly stdout: string;
  readonly stderr?: string;
}

export interface CommandRunOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/** Seam over local command execution so tests can inject git output or failure. */
export interface CommandRunner {
  run(argv: readonly string[], options: CommandRunOptions): CommandResult;
}

const DEFAULT_REMOTE_TIMEOUT_MS = 10_000;

const defaultCommandRunner: CommandRunner = {
  run(argv, options) {
    try {
      return {
        stdout: execFileSync("git", argv, {
          cwd: options.cwd,
          encoding: "utf8",
          windowsHide: true,
          timeout: options.timeoutMs,
          stdio: ["ignore", "pipe", "pipe"],
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
      };
    } catch (error) {
      // Keep git's own explanation: a missing binary, a timeout, and a
      // non-GitHub remote all used to look like "no origin".
      const stderr = typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr.trim()
        : "";
      const message = stderr.length > 0 ? stderr : error instanceof Error ? error.message : String(error);
      throw new Error(message, { cause: error });
    }
  },
};

export interface ReadGithubRemoteOptions {
  readonly commandRunner?: CommandRunner;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type GithubRemoteLookup =
  | { readonly kind: "github"; readonly remote: GithubRemote }
  | { readonly kind: "none" }
  | { readonly kind: "error"; readonly error: unknown };

/** Distinguish an absent origin from a git failure so callers can explain both. */
export function lookupGithubRemote(workspaceRoot: string, options: ReadGithubRemoteOptions = {}): GithubRemoteLookup {
  const runner = options.commandRunner ?? defaultCommandRunner;
  try {
    const result = runner.run(["-C", workspaceRoot, "remote", "get-url", "origin"], {
      cwd: workspaceRoot,
      timeoutMs: options.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const remote = parseGithubRemote(result.stdout.trim());
    return remote === null ? { kind: "none" } : { kind: "github", remote };
  } catch (error) {
    // A plain directory or a repository without origin simply has no GitHub
    // remote; other git failures keep their cause for the caller to explain.
    const message = error instanceof Error ? error.message : String(error);
    if (/not a git repository|no such remote|does not appear to be a git repository/i.test(message)) return { kind: "none" };
    return { kind: "error", error };
  }
}

export function readGithubRemote(workspaceRoot: string, options: ReadGithubRemoteOptions = {}): GithubRemote | null {
  const lookup = lookupGithubRemote(workspaceRoot, options);
  return lookup.kind === "github" ? lookup.remote : null;
}

export function rootIdentityHash(workspaceRoot: string, fs: FileSystem = nodeFileSystem): string {
  return digestOf({ workspaceRoot: fs.realpath(workspaceRoot) });
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
export function createLocalBinding(
  workspaceRoot: string,
  generatedAt: string,
  options: {
    readonly repositoryFullName?: string;
    readonly fs?: FileSystem;
    readonly commandRunner?: CommandRunner;
  } = {},
): LocalBindingResult {
  const fs = options.fs ?? nodeFileSystem;
  const root = fs.realpath(workspaceRoot);
  const override = options.repositoryFullName === undefined ? null : parseGithubRemote("https://github.com/" + options.repositoryFullName);
  const lookup = override === null
    ? lookupGithubRemote(root, options.commandRunner === undefined ? {} : { commandRunner: options.commandRunner })
    : null;
  const remote = override ?? (lookup?.kind === "github" ? lookup.remote : null);
  const warnings: string[] = [];
  const identity = rootIdentityHash(root, fs);

  let repositoryId: string;
  let repositoryFullName: string;
  if (override !== null && options.repositoryFullName !== undefined) {
    repositoryId = "git:" + sha256Hex(options.repositoryFullName.toLowerCase()).slice(0, 32);
    repositoryFullName = options.repositoryFullName;
  } else if (remote !== null) {
    repositoryId = "git:" + sha256Hex(remote.fullName.toLowerCase()).slice(0, 32);
    repositoryFullName = remote.fullName;
  } else {
    warnings.push(lookup?.kind === "error" ? "GITHUB_REMOTE_UNAVAILABLE" : "GITHUB_REMOTE_NOT_FOUND");
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