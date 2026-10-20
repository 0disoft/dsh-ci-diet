import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { CanonicalJsonError, canonicalJson, digestOf } from "../../src/shared/cdj1.ts";

const readJson = (relative: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")) as Record<string, unknown>;

test("CDJ1 reproduces the pricing snapshot content hash", () => {
  const pricing = readJson("../../contracts/pricing-2026-10-20.json");
  const body = {
    pricingSnapshotId: pricing.pricingSnapshotId,
    observedAt: pricing.observedAt,
    rows: pricing.rows
  };
  assert.equal(digestOf(body), pricing.contentHash);
  assert.equal(
    digestOf(body),
    "sha256:acc8d110d8f7fb00135ae8a908f82ad05c3a6d978fd427c73c28dec95e8fc3a9"
  );
});

test("CDJ1 reproduces the example patch plan digest", () => {
  const plan = readJson("../../examples/patch-plan.json");
  assert.equal(digestOf(plan.payload), plan.planDigest);
  assert.equal(
    digestOf(plan.payload),
    "sha256:d8984479190b5dd011bdce7017bcd340b848d54332817b5ee9501c107214d775"
  );
});

test("CDJ1 reproduces the empty dependency hash", () => {
  assert.equal(
    digestOf({ dependencies: [] }),
    "sha256:81059fe6210ccee4e3349c0f34c12d180f995150128a913d63b65b7937c6b152"
  );
  const plan = readJson("../../examples/patch-plan.json");
  const payload = plan.payload as { dependencies: unknown; dependencyHash: unknown };
  assert.equal(digestOf({ dependencies: payload.dependencies }), payload.dependencyHash);
});

test("CDJ1 sorts keys and keeps array order", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }), "{\"a\":[2,{\"c\":3,\"d\":4}],\"b\":1}");
  assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
  assert.equal(canonicalJson({ "Z": 1, "a": 2, "_": 3 }), "{\"Z\":1,\"_\":3,\"a\":2}");
  assert.equal(canonicalJson({ s: "한글 \"quoted\" \n" }), "{\"s\":\"한글 \\\"quoted\\\" \\n\"}");
  assert.equal(canonicalJson(null), "null");
  assert.equal(canonicalJson(true), "true");
  assert.equal(canonicalJson(-7), "-7");
});

test("CDJ1 rejects values that are not safe JSON", () => {
  const cases: [string, unknown][] = [
    ["$.n", { n: 1.5 }],
    ["$.n", { n: Number.NaN }],
    ["$.n", { n: Number.POSITIVE_INFINITY }],
    ["$.n", { n: 2 ** 60 }],
    ["$.big", { big: 2n }],
    ["$.u", { u: undefined }],
    ["$.f", { f: () => 1 }],
    ["$.d", { d: new Date(0) }],
    ["$.m", { m: new Map() }],
    ["$[\"키\"]", { "키": 1 }],
    // eslint-disable-next-line no-sparse-arrays -- a sparse array must be rejected by CDJ1
    ["$.a[1]", { a: [1, , 3] }]
  ];
  for (const [path, value] of cases) {
    assert.throws(
      () => canonicalJson(value),
      (error: unknown) => error instanceof CanonicalJsonError && error.path === path,
      path
    );
  }
});