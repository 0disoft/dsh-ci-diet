import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseDocument } from "yaml";
import type { Node } from "yaml";
import { byteRangeOf, parseWorkflow } from "../../src/core/workflow/index.ts";
import { createByteRangeReader } from "../../src/core/workflow/byte-ranges.ts";

const FIXTURES = new URL("../fixtures/workflows/", import.meta.url);

test("indexed byte ranges match UTF-8 prefixes including split and lone surrogates", () => {
  for (const text of ["", "ascii\r\n", "é हिंदी 한국어", "a🚀b", "\ud800x\udc00", "🚀\ud800🚀\udc00"]) {
    const rangeOf = createByteRangeReader(text, Buffer.byteLength(text, "utf8"));
    assert.equal(rangeOf(null), null);
    assert.equal(rangeOf(undefined), null);
    for (let start = 0; start <= text.length; start += 1) {
      for (let end = start; end <= text.length; end += 1) {
        const node = { range: [start, end, end] } as Node;
        assert.deepEqual(rangeOf(node), byteRangeOf(text, node), JSON.stringify({ text, start, end }));
      }
    }
  }
});

test("workflow parsing does not repeatedly measure source prefixes", (t) => {
  const text = "name: CI 한글 🚀\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n"
    + Array.from({ length: 200 }, (_, i) => "      - uses: actions/upload-artifact@v4\n        with:\n          name: 결과-" + i + "\n          path: dist\n          retention-days: 30\n").join("");
  const original = Buffer.byteLength;
  let measuredUnits = 0;
  t.mock.method(Buffer, "byteLength", (...args: Parameters<typeof Buffer.byteLength>) => {
    if (typeof args[0] === "string") measuredUnits += args[0].length;
    return original(...args);
  });
  const workflow = parseWorkflow("ci.yml", text);
  assert.equal(workflow.parseError, null);
  assert.equal(workflow.jobs[0]?.steps.length, 200);
  assert.ok(measuredUnits <= text.length * 2, "UTF-8 length measurement must stay linear in source length, not node count");
  const range = workflow.jobs[0]!.steps[199]!.withEntries.find((entry) => entry.key === "retention-days")!.valueRange;
  assert.ok(range);
  assert.equal(slice(text, range), "30");
});

async function fixture(name: string): Promise<string> {
  return readFile(new URL(name, FIXTURES), "utf8");
}

function slice(text: string, range: { startByte: number; endByte: number }): string {
  return Buffer.from(text, "utf8").subarray(range.startByte, range.endByte).toString("utf8");
}

test("parses jobs, triggers, timeouts, and matrix axes", async () => {
  const text = await fixture("matrix-name.yml");
  const workflow = parseWorkflow(".github/workflows/ci.yml", text);
  assert.equal(workflow.name, "CI");
  assert.deepEqual(workflow.triggers, ["push", "pull_request"]);
  assert.equal(workflow.parseError, null);
  assert.deepEqual(workflow.unsupported, []);
  assert.equal(workflow.jobs.length, 2);
  const job = workflow.jobs[0];
  assert.ok(job);
  assert.equal(job.key, "tests");
  assert.equal(job.displayName, "${{ matrix.runner.name }}");
  assert.equal(job.timeoutMinutes, 30);
  assert.equal(slice(text, job.keyRange), "tests");
  const timeout = job.timeoutRange;
  assert.ok(timeout);
  assert.equal(slice(text, timeout), "30");
  const matrix = job.matrix;
  assert.ok(matrix);
  assert.equal(matrix.axes.length, 2);
  assert.equal(matrix.axes[0]?.name, "runner");
  assert.equal(matrix.axes[0]?.values.length, 3);
  assert.equal(matrix.axes[1]?.name, "run-all");
  assert.equal(matrix.dynamic, false);
  assert.equal(matrix.exclude.length, 1);
});

test("maps yaml char offsets to utf8 byte offsets", async () => {
  const text = await fixture("korean-comments.yml");
  const workflow = parseWorkflow("workflow.yml", text);
  const job = workflow.jobs[0];
  assert.ok(job);
  assert.equal(job.key, "빌드");
  assert.equal(job.displayName, "테스트 실행");
  assert.equal(slice(text, job.keyRange), "빌드");
  const startIndex = text.indexOf("빌드:");
  assert.equal(job.keyRange.startByte, Buffer.byteLength(text.slice(0, startIndex), "utf8"));
  const doc = parseDocument(text);
  const jobsNode = doc.get("jobs") as { items?: { key: Node }[] } | null;
  const node = jobsNode?.items?.[0]?.key ?? null;
  assert.ok(node);
  assert.deepEqual(byteRangeOf(text, node), job.keyRange);
});

test("reports multiple documents as unsupported", async () => {
  const workflow = parseWorkflow("workflow.yml", await fixture("multiple-documents.yml"));
  assert.equal(workflow.parseError, null);
  assert.deepEqual(workflow.unsupported.map((item) => item.code), ["multiple-documents"]);
  assert.equal(workflow.jobs.length, 1);
});

test("reports anchors and aliases as unsupported", async () => {
  const workflow = parseWorkflow("workflow.yml", await fixture("alias.yml"));
  const codes = workflow.unsupported.map((item) => item.code).sort();
  assert.deepEqual(codes, ["alias", "anchor"]);
  assert.equal(workflow.parseError, null);
});

test("reports duplicate keys without failing the parse", async () => {
  const workflow = parseWorkflow("workflow.yml", await fixture("duplicate-keys.yml"));
  assert.equal(workflow.parseError, null);
  assert.deepEqual(workflow.unsupported.map((item) => item.code), ["duplicate-key"]);
  assert.equal(workflow.jobs.length, 1);
});

test("reports custom tags as unsupported", async () => {
  const workflow = parseWorkflow("workflow.yml", await fixture("custom-tag.yml"));
  assert.deepEqual(workflow.unsupported.map((item) => item.code), ["custom-tag"]);
  assert.equal(workflow.parseError, null);
});

test("keeps syntax errors as parse errors", () => {
  const workflow = parseWorkflow("workflow.yml", "a: [1, 2\n");
  assert.ok(workflow.parseError);
  assert.equal(typeof workflow.parseError.line, "number");
  assert.equal(workflow.jobs.length, 0);
});

test("rejects a root that is not a mapping", () => {
  const workflow = parseWorkflow("workflow.yml", "- one\n- two\n");
  assert.ok(workflow.parseError);
  assert.equal(workflow.parseError.message, "workflow root must be a mapping");
});

test("hashes the utf8 bytes it parsed", () => {
  const text = "name: Hash\non: push\n";
  const workflow = parseWorkflow("workflow.yml", text);
  const expected = "sha256:" + createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
  assert.equal(workflow.sha256, expected);
  assert.equal(workflow.bytes, Buffer.byteLength(text, "utf8"));
});

test("finds a top-level concurrency block", async () => {
  const text = await fixture("matrix-name.yml") + "concurrency:\n  group: ci-${{ github.ref }}\n  cancel-in-progress: true\n";
  const workflow = parseWorkflow("workflow.yml", text);
  assert.ok(workflow.concurrency);
  assert.equal(workflow.concurrency.group, "ci-${{ github.ref }}");
  assert.equal(workflow.concurrency.cancelInProgress, true);
  assert.equal(workflow.unsupported.length, 0);
});

test("reports a non-mapping jobs block without mutating caller state", () => {
  const workflow = parseWorkflow("workflow.yml", "on: push\njobs: [one]\n");
  assert.deepEqual(workflow.unsupported.map((item) => item.code), ["jobs-not-a-mapping"]);
  assert.equal(workflow.jobs.length, 0);
});
