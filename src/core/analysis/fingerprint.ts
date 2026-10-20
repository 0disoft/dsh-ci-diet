import { digestOf } from "../../shared/cdj1.ts";

/**
 * Stable identity of a finding.
 *
 * Suppressions and human evaluations bind to this fingerprint, so it must
 * change when the rule version, workflow content, or rule identity changes.
 * `identity` is rule-specific and must hold only canonical JSON values.
 */
export function findingFingerprint(input: {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly workflowPath: string;
  readonly workflowHash: string;
  readonly identity: unknown;
}): string {
  return digestOf({
    ruleId: input.ruleId,
    ruleVersion: input.ruleVersion,
    workflowPath: input.workflowPath,
    workflowHash: input.workflowHash,
    identity: input.identity,
  });
}

/** findingId stays readable while remaining unique per fingerprint. */
export function findingIdFromFingerprint(fingerprint: string): string {
  return "f_" + fingerprint.replace(/^sha256:/, "").slice(0, 24);
}
