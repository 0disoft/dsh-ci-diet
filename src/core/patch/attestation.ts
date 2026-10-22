import { digestOf } from "../../shared/cdj1.ts";
import type { Attestation } from "../contracts/schema.ts";
import { assertValidDocument } from "../contracts/validate.ts";

export interface AttestationInput {
  readonly bindingId: string;
  readonly workflowPath: string;
  readonly scope: "workflow" | "job" | "step";
  readonly jobKey: string | null;
  readonly stepKey: string | null;
  readonly workflowHash: string;
  readonly dependencyHash: string;
  readonly claims: Attestation["claims"];
  readonly evidenceRefs?: readonly string[];
  readonly issuedBy: { readonly channel: "human-ui" | "human-cli"; readonly subjectId: string };
  readonly now: Date;
  readonly ttlSeconds?: number;
}

export function createAttestation(input: AttestationInput): Attestation {
  if (input.scope === "workflow" && (input.jobKey !== null || input.stepKey !== null)) {
    throw new Error("ATTESTATION_SCOPE_INSUFFICIENT: workflow scope has no job or step");
  }
  if (input.scope === "job" && (input.jobKey === null || input.stepKey !== null)) {
    throw new Error("ATTESTATION_SCOPE_INSUFFICIENT: job scope needs a job key and no step key");
  }
  if (input.scope === "step" && (input.jobKey === null || input.stepKey === null)) {
    throw new Error("ATTESTATION_SCOPE_INSUFFICIENT: step scope needs a job key and a step key");
  }
  const attestedAt = input.now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const expiresAt = new Date(input.now.getTime() + (input.ttlSeconds ?? 30 * 24 * 60 * 60) * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  const base = {
    schemaVersion: 2,
    provenance: "observed",
    revision: 1,
    bindingId: input.bindingId,
    workflowPath: input.workflowPath,
    scope: input.scope,
    jobKey: input.jobKey,
    stepKey: input.stepKey,
    workflowHash: input.workflowHash,
    dependencyHash: input.dependencyHash,
    dependencies: [],
    claims: {
      ...input.claims,
      reviewedOpaqueNodes: [...input.claims.reviewedOpaqueNodes],
    },
    evidenceRefs: [...(input.evidenceRefs ?? [])],
    issuedBy: { ...input.issuedBy },
    attestedAt,
    expiresAt,
    revokedAt: null,
  };
  const attestationId = "a_" + digestOf(base).slice("sha256:".length, "sha256:".length + 24);
  const attestation = { ...base, attestationId } as Attestation;
  assertValidDocument("Attestation", attestation);
  return attestation;
}
