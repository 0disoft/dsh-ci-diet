import assert from "node:assert/strict";
import { test } from "node:test";
import { createAttestation } from "../../src/core/patch/attestation.ts";

const HASH = "sha256:" + "a".repeat(64);

function makeAttestation() {
  const claims = {
    ciOnly: true,
    replaceSafe: true,
    artifactPurpose: "temporary" as const,
    consumerMinDays: 1,
    reviewedOpaqueNodes: ["steps[0]"],
  };
  const issuedBy = { channel: "human-cli" as const, subjectId: "tester" };
  return {
    claims,
    issuedBy,
    attestation: createAttestation({
      bindingId: "b_" + "1".repeat(24),
      workflowPath: ".github/workflows/ci.yml",
      scope: "workflow",
      jobKey: null,
      stepKey: null,
      workflowHash: HASH,
      dependencyHash: HASH,
      claims,
      evidenceRefs: ["test:attestation"],
      issuedBy,
      now: new Date("2026-10-20T00:00:00.000Z"),
    }),
  };
}

test("createAttestation copies claims and issuedBy instead of aliasing them", () => {
  const { claims, issuedBy, attestation: created } = makeAttestation();
  claims.reviewedOpaqueNodes.push("steps[1]");
  issuedBy.subjectId = "other";
  assert.deepEqual(created.claims.reviewedOpaqueNodes, ["steps[0]"]);
  assert.equal(created.issuedBy.subjectId, "tester");
});

test("mutating a returned attestation does not reach the caller's input", () => {
  const { claims, issuedBy, attestation: created } = makeAttestation();
  created.claims.reviewedOpaqueNodes.push("steps[2]");
  created.issuedBy.subjectId = "returned";
  assert.deepEqual(claims.reviewedOpaqueNodes, ["steps[0]"]);
  assert.equal(issuedBy.subjectId, "tester");
});
