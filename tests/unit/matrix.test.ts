import assert from "node:assert/strict";
import { test } from "node:test";
import type { CanonicalJsonValue } from "../../src/shared/cdj1.ts";
import { expandMatrix, MAX_MATRIX_COMBINATIONS } from "../../src/core/workflow/matrix.ts";
import type { MatrixPlan } from "../../src/core/workflow/model.ts";

function plan(
  partial: Partial<MatrixPlan> & Pick<MatrixPlan, "axes">,
): MatrixPlan {
  return { include: [], exclude: [], dynamic: false, ...partial };
}

function row(
  values: Readonly<Record<string, CanonicalJsonValue>>,
): Record<string, CanonicalJsonValue> {
  return { ...values };
}

test("exclude applies before include so an include can add the row back", () => {
  const expanded = expandMatrix(
    plan({
      axes: [
        { name: "os", values: ["linux", "macos", "windows"] },
        { name: "node", values: [18, 20] },
      ],
      exclude: [{ os: "windows", node: 20 }],
      include: [{ os: "windows", node: 20, label: "win-20" }],
    }),
  );
  assert.ok(expanded);
  assert.equal(expanded.length, 6);
  assert.deepEqual(
    expanded.find((entry) => entry.os === "windows" && entry.node === 20),
    { os: "windows", node: 20, label: "win-20" },
  );
  assert.equal(
    expanded.filter((entry) => entry.os === "windows").length,
    2,
  );
});

test("include merges only axis-compatible rows and never rewrites axis values", () => {
  const expanded = expandMatrix(
    plan({
      axes: [{ name: "os", values: ["linux", "windows"] }],
      include: [{ os: "linux", experimental: true }],
    }),
  );
  assert.ok(expanded);
  assert.deepEqual(expanded, [
    { os: "linux", experimental: true },
    { os: "windows" },
  ]);
});

test("include entries with no axis key merge into every row", () => {
  const expanded = expandMatrix(
    plan({
      axes: [{ name: "os", values: ["linux", "windows"] }],
      include: [{ timeout: 5 }],
    }),
  );
  assert.ok(expanded);
  assert.deepEqual(expanded, [
    { os: "linux", timeout: 5 },
    { os: "windows", timeout: 5 },
  ]);
});

test("a later include overwrites a non-axis value an earlier include added", () => {
  const expanded = expandMatrix(
    plan({
      axes: [{ name: "os", values: ["linux"] }],
      include: [{ timeout: 5 }, { timeout: 6 }],
    }),
  );
  assert.ok(expanded);
  assert.deepEqual(expanded, [{ os: "linux", timeout: 6 }]);
});

test("a later include never merges into a row an earlier include added", () => {
  const expanded = expandMatrix(
    plan({
      axes: [{ name: "os", values: ["linux"] }],
      include: [
        { os: "windows", arch: "arm" },
        { os: "windows", arch: "x64" },
      ],
    }),
  );
  assert.ok(expanded);
  assert.deepEqual(expanded, [
    { os: "linux" },
    { os: "windows", arch: "arm" },
    { os: "windows", arch: "x64" },
  ]);
});

test("include rows count against the expansion cap", () => {
  const include = Array.from({ length: 4000 }, (_, index) => ({
    os: "image-" + String(index),
  }));
  assert.equal(
    expandMatrix(plan({ axes: [{ name: "os", values: ["linux"] }], include })),
    null,
  );
});

test("the cartesian cap and dynamic matrices still resolve to null", () => {
  const values = Array.from({ length: MAX_MATRIX_COMBINATIONS + 1 }, (_, index) => index);
  assert.equal(expandMatrix(plan({ axes: [{ name: "shard", values }] })), null);
  assert.equal(
    expandMatrix(plan({ axes: [{ name: "os", values: ["linux"] }], dynamic: true })),
    null,
  );
});

test("a matrix with no axes keeps include rows", () => {
  assert.deepEqual(
    expandMatrix(plan({ axes: [], include: [{ os: "linux" }, { os: "windows" }] })),
    [row({ os: "linux" }), row({ os: "windows" })],
  );
});

test("an exclude can shrink a 257-row product back under the cap", () => {
  const values = Array.from(
    { length: MAX_MATRIX_COMBINATIONS + 1 },
    (_, index) => index,
  );
  const expanded = expandMatrix(
    plan({ axes: [{ name: "shard", values }], exclude: [{ shard: 0 }] }),
  );
  assert.ok(expanded);
  assert.equal(expanded.length, MAX_MATRIX_COMBINATIONS);
  assert.equal(expanded.some((entry) => entry.shard === 0), false);
});

test("excludes resolved on a later axis can shrink a product under the cap", () => {
  const nodes = Array.from({ length: 129 }, (_, index) => index);
  const expanded = expandMatrix(
    plan({
      axes: [
        { name: "os", values: ["linux", "windows"] },
        { name: "node", values: nodes },
      ],
      exclude: [
        { os: "linux", node: 0 },
        { os: "windows", node: 0 },
      ],
    }),
  );
  assert.ok(expanded);
  assert.equal(expanded.length, MAX_MATRIX_COMBINATIONS);
});

test("a 257-row product with no exclude still resolves to null", () => {
  const values = Array.from(
    { length: MAX_MATRIX_COMBINATIONS + 1 },
    (_, index) => index,
  );
  assert.equal(
    expandMatrix(plan({ axes: [{ name: "shard", values }] })),
    null,
  );
});

test("include-only matrices accept 256 rows and reject 257", () => {
  const rows = (length: number) =>
    Array.from({ length }, (_, index) => ({ shard: index }));
  const accepted = expandMatrix(
    plan({ axes: [], include: rows(MAX_MATRIX_COMBINATIONS) }),
  );
  assert.ok(accepted);
  assert.equal(accepted.length, MAX_MATRIX_COMBINATIONS);
  assert.equal(
    expandMatrix(plan({ axes: [], include: rows(MAX_MATRIX_COMBINATIONS + 1) })),
    null,
  );
});

test("a dynamic include-only matrix resolves to null", () => {
  assert.equal(
    expandMatrix(plan({ axes: [], include: [{ os: "linux" }], dynamic: true })),
    null,
  );
});

test("exclude comparisons have a work cap even when the result fits 256 rows", () => {
  let comparisons = 0;
  const values = Array.from({ length: 256 }, (_, key) => ({ key }));
  const exclude = Array.from({ length: 512 }, () => ({
    shard: { get key() { comparisons += 1; return -1; } },
  }));
  const expanded = expandMatrix(plan({ axes: [{ name: "shard", values }], exclude }));
  assert.ok(comparisons <= 65_536, "exclude work must stop before all 131,072 comparisons");
  assert.equal(expanded, null, "an exhausted work budget must never return partial rows");
});

test("exclude entries are prepared once instead of once per candidate", () => {
  let entryReads = 0;
  const exclude = Array.from({ length: 256 }, () => ({
    get later() { entryReads += 1; return "never"; },
  }));
  const expanded = expandMatrix(plan({
    axes: [
      { name: "shard", values: Array.from({ length: 4096 }, (_, index) => index) },
      { name: "later", values: ["keep"] },
    ],
    exclude,
  }));
  assert.equal(expanded, null);
  assert.equal(entryReads, exclude.length);
});
