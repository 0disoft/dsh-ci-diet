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
  it("preserves an unreadable branch-rules response instead of reporting zero rules", async () => {
    const { runner, calls } = runnerFrom(httpResponse(404, { message: "Not Found" }));
    const transport = new GhTransport({ budget: budget(), runner, retries: 0 });
    const client = new GitHubClient(transport, "owner", "repo");
    await assert.rejects(client.branchRules("main"),
      (error: unknown) => error instanceof GitHubError && error.code === "NOT_FOUND");
    assert.equal(calls.length, 1);
  });

  for (const body of [null, { message: "unexpected response" }]) {
    it("rejects a non-array branch-rules response: " + JSON.stringify(body), async () => {
      const { runner, calls } = runnerFrom(httpResponse(200, body));
      const transport = new GhTransport({ budget: budget(), runner, retries: 0 });
      const client = new GitHubClient(transport, "owner", "repo");
      await assert.rejects(client.branchRules("main"),
        (error: unknown) => error instanceof GitHubError && error.code === "NETWORK_ERROR");
      assert.equal(calls.length, 1);
    });
  }

  it("accepts a confirmed empty branch-rules array", async () => {
    const { runner } = runnerFrom(httpResponse(200, []));
    const client = new GitHubClient(new GhTransport({ budget: budget(), runner }), "owner", "repo");
    assert.deepEqual(await client.branchRules("main"), []);
  });

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

  it("caps the global budget with maxRequests and never raises it above the quotas", () => {
    const limits = { discovery: 10, jobs: 10, definitions: 10, policyAndFiles: 10 };
    const capped = new RequestBudget(limits, 5);
    assert.equal(capped.limit, 5);
    assert.equal(capped.remaining, 5);
    for (let index = 0; index < 5; index += 1) {
      capped.consume("discovery");
      capped.settle();
    }
    assert.equal(capped.remaining, 0);
    assert.throws(() => capped.consume("jobs"), (error: unknown) => error instanceof GitHubError && error.code === "BUDGET_EXHAUSTED");
    assert.equal(new RequestBudget(limits, 500).limit, 40);
    assert.equal(new RequestBudget(limits).limit, 40);
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
      // A permission 403 keeps the primary quota headers; a reset timestamp alone
      // must not turn it into a rate limit that waits (or fails) for hours.
      [httpResponse(403, { message: "Resource not accessible" }, { "x-ratelimit-remaining": "4999", "x-ratelimit-reset": "4102444800" }), "PERMISSION_DENIED"],
      [httpResponse(404, { message: "Not Found" }), "NOT_FOUND"],
    ];
    for (const [stdout, expected] of cases) {
      const { runner } = runnerFrom(stdout);
      // Rate-limited responses are transient now, so pin retries to isolate classification.
      const transport = new GhTransport({ budget: budget(), runner, retries: 0 });
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

  it("bounds cached response bytes and keeps recent 304 reuse", async () => {
    const calls: string[][] = [];
    const runner: GhRunner = async (args) => {
      calls.push([...args]);
      return { exitCode: 0, stderr: "", stdout: args.some((arg) => arg.startsWith("If-None-Match:"))
        ? httpResponse(304, null)
        : httpResponse(200, { payload: "x".repeat(1024 * 1024) }, { etag: '"large"' }) };
    };
    const transport = new GhTransport({ budget: new RequestBudget({ discovery: 0, jobs: 10, definitions: 0, policyAndFiles: 0 }), runner });
    const request = (page: number) => ({ path: "/repos/owner/repo/actions/runs/1/attempts/1/jobs", query: { page: String(page) } });
    for (let page = 1; page <= 6; page += 1) await transport.get(request(page), "jobs");
    assert.equal((await transport.get(request(6), "jobs")).status, 304);
    assert.equal((await transport.get(request(1), "jobs")).status, 200, "old bodies must be evicted before retained data exceeds 4 MiB");
    assert.ok(!calls.at(-1)!.some((arg) => arg.startsWith("If-None-Match:")));
  });

  it("bounds tiny cache entries, refreshes recency on 304, and fetches evictions normally", async () => {
    const runner: GhRunner = async (args) => ({ exitCode: 0, stderr: "", stdout: args.some((arg) => arg.startsWith("If-None-Match:"))
      ? httpResponse(304, null) : httpResponse(200, { id: 7 }, { etag: '"tiny"' }) });
    const transport = new GhTransport({ budget: new RequestBudget({ discovery: 0, jobs: 40, definitions: 0, policyAndFiles: 0 }), runner });
    const request = (page: number) => ({ path: "/repos/owner/repo/actions/runs/1/attempts/1/jobs", query: { page: String(page) } });
    for (let page = 1; page <= 32; page += 1) await transport.get(request(page), "jobs");
    assert.equal((await transport.get(request(1), "jobs")).status, 304);
    await transport.get(request(33), "jobs");
    assert.equal((await transport.get(request(1), "jobs")).status, 304, "304 reuse refreshes recency");
    assert.equal((await transport.get(request(2), "jobs")).status, 200, "least recently used entry is evicted");
  });

  it("does not cache an oversized response or retain an obsolete ETag after an uncacheable replacement", async () => {
    const { runner, calls } = runnerFrom(
      httpResponse(200, { id: 7 }, { etag: '"old"' }),
      httpResponse(200, { payload: "x".repeat(4 * 1024 * 1024) }, { etag: '"oversized"' }),
      httpResponse(200, { id: 8 }),
      httpResponse(200, { id: 9 }, { etag: '"new"' }),
      httpResponse(200, { id: 10 }),
      httpResponse(200, { id: 11 }),
    );
    const transport = new GhTransport({ budget: new RequestBudget({ discovery: 6, jobs: 0, definitions: 0, policyAndFiles: 0 }), runner });
    for (let index = 0; index < 6; index += 1) await transport.get({ path: "/repos/owner/repo" }, "discovery");
    assert.ok(calls[1]!.includes('If-None-Match: "old"'));
    assert.ok(!calls[2]!.some((arg) => arg.startsWith("If-None-Match:")));
    assert.ok(calls[4]!.includes('If-None-Match: "new"'));
    assert.ok(!calls[5]!.some((arg) => arg.startsWith("If-None-Match:")));
  });

  it("reports a missing gh binary", async () => {
    const runner: GhRunner = async () => ({ exitCode: 127, stdout: "", stderr: "not found" });
    const transport = new GhTransport({ budget: budget(), runner });
    await assert.rejects(transport.get({ path: "/repos/owner/repo" }, "discovery"), (error: unknown) => error instanceof GitHubError && error.code === "GH_NOT_INSTALLED");
  });

  it("waits for Retry-After on a 429 instead of using exponential backoff", async () => {
    const { runner, calls } = runnerFrom(httpResponse(429, { message: "secondary" }, { "retry-after": "30" }), httpResponse(200, { ok: true }));
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
    assert.deepEqual(waits, [30_000]);
  });

  it("parses an HTTP-date Retry-After and ignores invalid values", async () => {
    const future = new Date(Date.now() + 3_600_000).toUTCString();
    const dateWaits: number[] = [];
    const dateRunner = runnerFrom(httpResponse(429, null, { "retry-after": future }), httpResponse(200, { ok: true }));
    const dateTransport = new GhTransport({
      budget: budget(),
      runner: dateRunner.runner,
      sleep: async (milliseconds) => {
        dateWaits.push(milliseconds);
      },
    });
    await dateTransport.get({ path: "/repos/owner/repo" }, "discovery");
    assert.equal(dateWaits.length, 1);
    assert.ok((dateWaits[0] ?? 0) > 3_500_000, "the server-requested pause must not be capped at 30s");

    const invalidWaits: number[] = [];
    const invalidRunner = runnerFrom(httpResponse(429, null, { "retry-after": "not-a-date" }), httpResponse(200, { ok: true }));
    const invalidTransport = new GhTransport({
      budget: budget(),
      runner: invalidRunner.runner,
      sleep: async (milliseconds) => {
        invalidWaits.push(milliseconds);
      },
    });
    await invalidTransport.get({ path: "/repos/owner/repo" }, "discovery");
    assert.deepEqual(invalidWaits, [500]);
  });

  it("preserves a Retry-After longer than 30 seconds", async () => {
    const { runner } = runnerFrom(httpResponse(429, null, { "retry-after": "120" }), httpResponse(200, { ok: true }));
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
    assert.deepEqual(waits, [120_000]);
  });

  it("fails fast on a Retry-After longer than the configured bound", async () => {
    const { runner, calls } = runnerFrom(httpResponse(429, null, { "retry-after": "86400" }), httpResponse(200, { ok: true }));
    const waits: number[] = [];
    const transport = new GhTransport({ budget: budget(), runner, sleep: async (milliseconds) => { waits.push(milliseconds); } });
    await assert.rejects(
      transport.get({ path: "/repos/owner/repo" }, "discovery"),
      (error: unknown) => error instanceof GitHubError && error.code === "RATE_LIMITED",
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });

  it("classifies an unauthenticated gh response as a credential problem", async () => {
    const runner: GhRunner = async () => ({ exitCode: 0, stdout: "To get started with GitHub CLI, run: gh auth login", stderr: "" });
    const transport = new GhTransport({ budget: budget(), runner });
    await assert.rejects(
      transport.get({ path: "/repos/owner/repo" }, "discovery"),
      (error: unknown) => error instanceof GitHubError && error.code === "AUTH_REQUIRED",
    );
  });

  it("retries a secondary-limit 403 signaled by Retry-After", async () => {
    const { runner, calls } = runnerFrom(
      httpResponse(403, { message: "You have exceeded a secondary rate limit" }, { "retry-after": "2", "x-ratelimit-remaining": "100" }),
      httpResponse(200, { ok: true }),
    );
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
    assert.deepEqual(waits, [2_000]);
  });

  it("does not dispatch when the signal is already aborted", async () => {
    const { runner, calls } = runnerFrom(httpResponse(200, { ok: true }));
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const transport = new GhTransport({ budget: budget(), runner, signal: controller.signal });
    await assert.rejects(transport.get({ path: "/repos/owner/repo" }, "discovery"), /stop/);
    assert.equal(calls.length, 0);
  });

  it("stops a retry pause when the signal aborts", async () => {
    const { runner, calls } = runnerFrom(httpResponse(429, null, { "retry-after": "600" }), httpResponse(200, { ok: true }));
    const controller = new AbortController();
    const transport = new GhTransport({ budget: budget(), runner, signal: controller.signal });
    setTimeout(() => controller.abort(new Error("cancelled")), 20);
    await assert.rejects(transport.get({ path: "/repos/owner/repo" }, "discovery"), /cancelled/);
    assert.equal(calls.length, 1);
  });

  it("retries a status-0 network failure", async () => {
    const { runner, calls } = runnerFrom("", httpResponse(200, { ok: true }));
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
  });

  it("retries a timed-out gh invocation and forwards the request timeout", async () => {
    const timeouts: Array<number | undefined> = [];
    const stdout = httpResponse(200, { ok: true });
    const runner: GhRunner = async (_args, timeoutMs) => {
      timeouts.push(timeoutMs);
      if (timeouts.length === 1) return { exitCode: 1, stdout: "", stderr: "", timedOut: true };
      return { exitCode: 0, stdout, stderr: "" };
    };
    const transport = new GhTransport({ budget: budget(), runner, timeoutMs: 5_000, sleep: async () => {} });
    const response = await transport.get({ path: "/repos/owner/repo" }, "discovery");
    assert.equal(response.status, 200);
    assert.deepEqual(timeouts, [5_000, 5_000]);
  });

  it("does not retry an authentication failure", async () => {
    const { runner, calls } = runnerFrom(httpResponse(401, { message: "Bad credentials" }), httpResponse(200, { ok: true }));
    const waits: number[] = [];
    const transport = new GhTransport({
      budget: budget(),
      runner,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });
    await assert.rejects(transport.get({ path: "/repos/owner/repo" }, "discovery"));
    assert.equal(calls.length, 1);
    assert.equal(waits.length, 0);
  });

  it("does not retry deterministic 4xx responses such as 400 and 422", async () => {
    for (const status of [400, 422] as const) {
      const { runner, calls } = runnerFrom(httpResponse(status, { message: "request rejected" }), httpResponse(200, { ok: true }));
      const waits: number[] = [];
      const transport = new GhTransport({
        budget: budget(),
        runner,
        sleep: async (milliseconds) => {
          waits.push(milliseconds);
        },
      });
      await assert.rejects(
        transport.get({ path: "/repos/owner/repo" }, "discovery"),
        (error: unknown) => error instanceof GitHubError && error.code === "NETWORK_ERROR" && error.status === status,
      );
      assert.equal(calls.length, 1, "HTTP " + String(status) + " must be attempted once");
      assert.equal(waits.length, 0);
    }
  });

  it("still retries 502 and 503 gateway failures", async () => {
    for (const status of [502, 503] as const) {
      const { runner, calls } = runnerFrom(httpResponse(status, null), httpResponse(200, { ok: true }));
      const transport = new GhTransport({ budget: budget(), runner, sleep: async () => {} });
      const response = await transport.get({ path: "/repos/owner/repo" }, "discovery");
      assert.equal(response.status, 200);
      assert.equal(calls.length, 2);
    }
  });
});
