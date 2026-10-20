import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubError } from "../../src/adapters/github/errors.ts";
import { contentsSegments, ownerRepoPath, renderPath } from "../../src/adapters/github/endpoints.ts";
import { RequestBudget } from "../../src/adapters/github/budget.ts";
import { GhTransport } from "../../src/adapters/github/transport.ts";
import type { GhResult, GhRunner } from "../../src/adapters/github/transport.ts";
import { GitHubClient } from "../../src/adapters/github/client.ts";

function budget(): RequestBudget {
  return new RequestBudget({ discovery: 5, jobs: 5, definitions: 5, policyAndFiles: 5 });
}

function httpResponse(status: number, body: unknown, headers: Record<string, string> = {}): string {
  const lines = ["HTTP/2.0 " + status + " " + (status === 200 ? "OK" : "Error"), "content-type: application/json"];
  for (const [key, value] of Object.entries(headers)) lines.push(key + ": " + value);
  return lines.join("\n") + "\n\n" + (body === null ? "" : JSON.stringify(body));
}

function runnerFrom(...responses: Array<string | Error>): { runner: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: GhRunner = async (args) => {
    calls.push([...args]);
    const next = responses.shift();
    if (next === undefined) throw new Error("no canned response left");
    if (next instanceof Error) throw next;
    return { exitCode: 0, stdout: next, stderr: "" } satisfies GhResult;
  };
  return { runner, calls };
}

describe("read-only endpoint allowlist", () => {
  it("accepts the documented repository resources", () => {
    const base = ownerRepoPath("0disoft", "dsh-ci-diet");
    assert.equal(renderPath({ path: base }), "/repos/0disoft/dsh-ci-diet");
    assert.equal(
      renderPath({ path: base + "/actions/runs", query: { per_page: "100", page: "2" } }),
      "/repos/0disoft/dsh-ci-diet/actions/runs?page=2&per_page=100",
    );
    assert.equal(renderPath({ path: base + "/actions/runs/42/attempts/1/jobs", query: { filter: "all" } }), base + "/actions/runs/42/attempts/1/jobs?filter=all");
    const contentsPath = base + "/contents/" + contentsSegments(".github/workflows/ci.yml");
    assert.equal(renderPath({ path: contentsPath, query: { ref: "abc123" } }), base + "/contents/.github/workflows/ci.yml?ref=abc123");
    assert.throws(() => renderPath({ path: base + "/contents/.github/workflows/ci.yml", query: {} }), /missing query key/);
  });

  it("rejects paths and query keys outside the allowlist", () => {
    const base = ownerRepoPath("0disoft", "dsh-ci-diet");
    assert.throws(() => renderPath({ path: base + "/actions/runs/42/jobs" }), /read-only allowlist/);
    assert.throws(() => renderPath({ path: base + "/actions/runs", query: { since: "2026-01-01" } }), /query key not allowed/);
    assert.throws(() => renderPath({ path: base + "/issues" }), /read-only allowlist/);
    assert.throws(() => ownerRepoPath("..", "repo"), /invalid repository/);
    assert.throws(() => ownerRepoPath("owner", "repo name"), /invalid repository/);
    assert.throws(() => contentsSegments("../secrets"), /invalid contents path/);
    assert.throws(() => contentsSegments("docs/../.github/workflows/ci.yml"), /invalid contents path/);
    assert.equal(contentsSegments("docs/design notes/a.yml"), "docs/design%20notes/a.yml");
  });
});


describe("github client", () => {
  it("fetches a nested workflow file as path segments", async () => {
    const text = "name: CI\non: push\n";
    const { runner, calls } = runnerFrom(
      httpResponse(200, { sha: "abc123", content: Buffer.from(text, "utf8").toString("base64"), encoding: "base64" }),
    );
    const transport = new GhTransport({ budget: budget(), runner, retries: 0 });
    const client = new GitHubClient(transport, "0disoft", "dsh-ci-diet");
    const content = await client.contents(".github/workflows/ci.yml", "abc123");
    assert.equal(content?.text, text);
    assert.equal(content?.sha, "abc123");
    const requestPath = calls[0]?.at(-1) ?? "";
    assert.match(requestPath, /\/contents\/\.github\/workflows\/ci\.yml\?ref=abc123$/);
  });

  it("rejects traversal in a contents path", async () => {
    const { runner } = runnerFrom();
    const transport = new GhTransport({ budget: budget(), runner, retries: 0 });
    const client = new GitHubClient(transport, "0disoft", "dsh-ci-diet");
    await assert.rejects(client.contents("../secrets", "main"), /invalid contents path/);
  });
});

describe("request budget", () => {
  it("consumes one token per dispatch and reports remaining", () => {
    const ledger = budget();
    ledger.consume("discovery");
    ledger.settle();
    const snapshot = ledger.snapshot();
    assert.equal(snapshot.dispatchAttempts, 1);
    assert.equal(snapshot.remaining, 19);
    assert.equal(snapshot.families.discovery.used, 1);
    assert.equal(snapshot.families.discovery.remaining, 4);
    assert.equal(snapshot.wireRequestCount.status, "unknown");
  });

  it("refuses to overdraw a family", () => {
    const ledger = new RequestBudget({ discovery: 1, jobs: 1, definitions: 1, policyAndFiles: 1 });
    ledger.consume("discovery");
    ledger.settle();
    assert.throws(() => ledger.consume("discovery"), (error: unknown) => error instanceof GitHubError && error.code === "BUDGET_EXHAUSTED");
  });

  it("donates unused tokens when a family finishes", () => {
    const ledger = new RequestBudget({ discovery: 1, jobs: 1, definitions: 1, policyAndFiles: 1 });
    ledger.consume("definitions");
    ledger.settle();
    ledger.finish("definitions");
    const snapshot = ledger.snapshot();
    assert.equal(snapshot.families.definitions.state, "finished");
    assert.equal(snapshot.families.definitions.donated, 0);
    assert.equal(snapshot.families.policyAndFiles.borrowed, 0);
    assert.equal(snapshot.families.policyAndFiles.remaining, 1);
  });
});

describe("gh transport", () => {
  it("issues a single allowlisted GET with the pinned API version", async () => {
    const { runner, calls } = runnerFrom(httpResponse(200, { id: 1 }));
    const transport = new GhTransport({ budget: budget(), runner });
    const response = await transport.get({ path: "/repos/owner/repo", }, "discovery");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { id: 1 });
    const args = calls[0] ?? [];
    assert.deepEqual(args.slice(0, 6), ["api", "--hostname", "github.com", "--method", "GET", "--include"]);
    assert.ok(args.includes("X-GitHub-Api-Version: 2026-03-10"));
    assert.ok(args.includes("Accept: application/vnd.github+json"));
    assert.equal(args[args.length - 1], "/repos/owner/repo");
  });

  it("maps auth, permission, and not-found responses", async () => {
    const cases: Array<[string, string]> = [
      [httpResponse(401, { message: "Bad credentials" }), "AUTH_REQUIRED"],
      [httpResponse(403, { message: "Forbidden" }), "PERMISSION_DENIED"],
      [httpResponse(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" }), "RATE_LIMITED"],
      [httpResponse(404, { message: "Not Found" }), "NOT_FOUND"],
    ];
    for (const [stdout, expected] of cases) {
      const { runner } = runnerFrom(stdout);
      const transport = new GhTransport({ budget: budget(), runner });
      await assert.rejects(transport.get({ path: "/repos/owner/repo" }, "discovery"), (error: unknown) => error instanceof GitHubError && error.code === expected);
    }
  });

  it("retries transient failures with backoff", async () => {
    const { runner, calls } = runnerFrom(httpResponse(502, null), httpResponse(200, { ok: true }));
    const waits: number[] = [];
    const transport = new GhTransport({
      budget: budget(),
      runner,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });
    const response = await transport.get({ path: "/repos/owner/repo" }, "discovery");
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(waits.length, 1);
    assert.ok((waits[0] ?? 0) > 0);
  });

  it("reuses an ETag cache entry on 304", async () => {
    const { runner, calls } = runnerFrom(httpResponse(200, { id: 7 }, { etag: "W/\"abc\"" }), httpResponse(304, null));
    const transport = new GhTransport({ budget: budget(), runner });
    const first = await transport.get({ path: "/repos/owner/repo" }, "discovery");
    assert.equal(first.etag, "W/\"abc\"");
    const second = await transport.get({ path: "/repos/owner/repo" }, "discovery");
    assert.equal(second.status, 304);
    assert.deepEqual(second.body, { id: 7 });
    assert.ok((calls[1] ?? []).includes("If-None-Match: W/\"abc\""));
  });

  it("reports a missing gh binary", async () => {
    const runner: GhRunner = async () => ({ exitCode: 127, stdout: "", stderr: "not found" });
    const transport = new GhTransport({ budget: budget(), runner });
    await assert.rejects(transport.get({ path: "/repos/owner/repo" }, "discovery"), (error: unknown) => error instanceof GitHubError && error.code === "GH_NOT_INSTALLED");
  });
});
