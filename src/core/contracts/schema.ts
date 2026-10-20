/* eslint-disable */
/** Generated from contracts/ci-diet.schema.json by scripts/gen-types.mjs.
 * Do not edit by hand: run bun run gen:types after an intentional contract change.
 *
 * Structural mirror only. Validation keywords (pattern, minLength, format,
 * minimum, maxItems, uniqueItems, if/then/else) are enforced by Ajv against the
 * JSON Schema, not by these types. Conditional schemas appear as their broader
 * base shape, so a value that satisfies these types may still fail validation.
 */
export type Metric = {
  "status": "known" | "unknown" | "not_applicable";
  "value": number | string | null;
  "basis": string;
  "reason": string | null;
};
export type Config = {
  "schemaVersion": 2;
  "networkEnabled": boolean;
  "localApplyEnabled": boolean;
  "history": {
  "lookbackDays": number;
  "maxRuns": number;
  "maxRequests": number;
  "concurrentRequests": number;
  "requestTimeoutMs": number;
  "additionalRetries": number;
  "quotas": {
  "discovery": number;
  "jobs": number;
  "definitions": number;
  "policyAndFiles": number;
};
};
  "apply": {
  "maxFilesPerPlan": 1;
  "allowedRules": ("CD001" | "CD005" | "CD008")[];
  "approvalTtlSeconds": 600;
  "policyMaxAgeSeconds": 600;
  "attestationMaxAgeDays": 30;
};
  "storage": {
  "storeMaxBytes": number;
  "warningPercent": 80;
  "workflowMaxBytes": number;
  "kvRecordMaxBytes": number;
  "cacheMaxBytes": number;
  "cacheDays": number;
  "reportDays": number;
  "planDays": number;
  "pruneAppliedBackups": false;
};
  "ui": {
  "languages": ["en","ko"];
  "progressPollMinMs": 500;
  "modelResultMaxBytes": 65536;
};
};
export type RepositoryBinding = {
  "schemaVersion": 2;
  "provenance": "synthetic" | "observed";
  "bindingId": string;
  "repositoryId": string;
  "repositoryFullName": string;
  "host": "github.com";
  "workspaceRoot": string;
  "rootIdentityHash": string;
  "stateScope": string;
  "createdAt": string;
};
export type Attestation = {
  "schemaVersion": 2;
  "provenance": "synthetic" | "observed";
  "attestationId": string;
  "revision": number;
  "bindingId": string;
  "workflowPath": string;
  "scope": "workflow" | "job" | "step";
  "jobKey": string | null;
  "stepKey": string | null;
  "workflowHash": string;
  "dependencyHash": string;
  "claims": {
  "ciOnly": boolean;
  "replaceSafe": boolean;
  "artifactPurpose": "temporary" | "release" | "unknown";
  "consumerMinDays": number | null;
  "reviewedOpaqueNodes": string[];
};
  "evidenceRefs": string[];
  "issuedBy": {
  "channel": "human-ui" | "human-cli";
  "subjectId": string;
};
  "attestedAt": string;
  "expiresAt": string;
  "revokedAt": string | null;
  "dependencies": {
  "ref": string;
  "sha256": string;
}[];
};
export type MissingScope = {
  "family": "discovery" | "jobs" | "definitions" | "policyAndFiles";
  "resource": string;
  "runId": string | null;
  "attempt": number | null;
  "path": string | null;
  "pullRequest": number | null;
  "branch": string | null;
  "from": string | null;
  "to": string | null;
  "reason": string;
  "resumable": boolean;
};
export type Dimension = {
  "status": "complete" | "partial" | "unavailable";
  "scope": string;
  "fetched": number;
  "expected": number | null;
  "reasons": string[];
  "missingScopes": MissingScope[];
};
export type Coverage = {
  "apiVersion": string;
  "ghVersion": string;
  "requestedFrom": string;
  "requestedTo": string;
  "history": Dimension;
  "workflowDefinitions": Dimension;
  "changedFiles": Dimension;
  "protectionRules": Dimension;
  "retentionPolicy": Dimension;
};
export type QuotaLedger = {
  "initialQuota": number;
  "borrowed": number;
  "donated": number;
  "used": number;
  "reserved": number;
  "remaining": number;
  "state": "pending" | "active" | "finished" | "unavailable";
};
export type BudgetLedger = {
  "limit": number;
  "dispatchAttempts": number;
  "reserved": number;
  "inFlight": number;
  "remaining": number;
  "wireRequestCount": CountMetric;
  "families": {
  "discovery": QuotaLedger;
  "jobs": QuotaLedger;
  "definitions": QuotaLedger;
  "policyAndFiles": QuotaLedger;
};
};
export type OperationProgress = {
  "schemaVersion": 2;
  "provenance": "synthetic" | "observed";
  "operationId": string;
  "bindingId": string;
  "kind": "scan" | "sync";
  "phase": string;
  "usedRequests": number;
  "inFlight": number;
  "fetchedRuns": number;
  "fetchedJobs": number;
  "bytesRead": number;
  "budget": BudgetLedger;
  "missingScopes": MissingScope[];
  "updatedAt": string;
  "terminalStatus": "running" | "complete" | "partial" | "failed" | "cancelled";
};
export type Finding = {
  "findingId": string;
  "fingerprint": string;
  "ruleId": "CD001" | "CD002" | "CD003" | "CD004" | "CD005" | "CD008";
  "ruleVersion": string;
  "title": string;
  "renderedText": string;
  "workflowPath": string;
  "workflowHash": string;
  "evidenceLevel": "observed" | "inferred" | "static";
  "patchability": "eligible" | "review-only" | "blocked";
  "evidenceRefs": string[];
  "assumptions": string[];
  "blockers": string[];
  "standaloneRunnerSeconds": SecondsMetric;
};
export type RuleResult = {
  "ruleId": "CD001" | "CD002" | "CD003" | "CD004" | "CD005" | "CD008";
  "ruleVersion": string;
  "inputHash": string;
  "outcome": "finding" | "candidate" | "no_finding" | "skipped";
  "reasons": string[];
  "findingIds": string[];
};
export type Removal = {
  "findingId": string;
  "startMillis": number;
  "endMillis": number;
};
export type JobInput = {
  "jobId": string;
  "durationMillis": number;
  "sku": StringMetric;
  "removals": Removal[];
};
export type PricingSnapshot = {
  "schemaVersion": 2;
  "pricingSnapshotId": string;
  "observedAt": string;
  "sourceUrl": string;
  "sourceRefs": string[];
  "rows": ({
  "sku": "actions_linux_slim" | "actions_linux" | "actions_linux_arm" | "actions_windows" | "actions_windows_arm" | "actions_macos";
  "target": string;
  "usdPerMinuteMicro": number;
  "evidenceRef": string;
})[];
  "contentHash": string;
};
export type AnalysisReport = {
  "schemaVersion": 2;
  "provenance": "synthetic" | "observed";
  "reportId": string;
  "bindingId": string;
  "engineVersion": string;
  "generatedAt": string;
  "coverage": Coverage;
  "inputHashes": string[];
  "findings": Finding[];
  "ruleResults": RuleResult[];
  "normalizedInputs": {
  "jobs": JobInput[];
  "sourceRefs": string[];
};
  "metrics": {
  "observedRunnerSeconds": SecondsMetric;
  "candidateRemovableSeconds": SecondsMetric;
  "modeledRoundedMinutes": CountMetric;
  "listPriceUsd": UsdMetric;
  "estimatedMarginalUsd": UsdMetric;
  "actualBilledUsd": UsdMetric;
  "queueSeconds": SecondsMetric;
  "executionSpanSeconds": SecondsMetric;
  "criticalPathWorkSeconds": SecondsMetric;
  "estimatedUserWaitReductionSeconds": SecondsMetric;
};
  "parentReportId": string | null;
  "pricingSnapshot": PricingSnapshot;
};
export type ByteEdit = {
  "kind": "insertScalar" | "replaceScalar" | "insertMapping" | "insertParentMapping";
  "startByte": number;
  "endByte": number;
  "replacementUtf8": string;
  "semanticPath": string;
  "ruleId": "CD001" | "CD005" | "CD008";
};
export type PolicySnapshot = {
  "kind": "protection" | "retention";
  "bindingId": string;
  "status": "known" | "unknown" | "not_applicable";
  "observedAt": string;
  "policyHash": string;
  "effectiveMaxDays": number | null;
  "requiredCheckNames": string[];
  "sourceRef": string;
};
export type PatchPayload = {
  "bindingId": string;
  "rootIdentityHash": string;
  "workflowPath": string;
  "engineVersion": string;
  "ruleIds": ("CD001" | "CD005" | "CD008")[];
  "sourceHash": string;
  "resultHash": string;
  "dependencyHash": string;
  "edits": ByteEdit[];
  "attestations": Attestation[];
  "policies": PolicySnapshot[];
  "blockers": string[];
  "createdAt": string;
  "expiresAt": string;
  "dependencies": {
  "ref": string;
  "sha256": string;
}[];
};
export type PatchPlan = {
  "schemaVersion": 2;
  "provenance": "synthetic" | "observed";
  "planId": string;
  "planDigest": string;
  "payload": PatchPayload;
  "status": PlanStatus;
};
export type PlanStatus = {
  "state": "draft" | "preview" | "approved";
  "revision": number;
  "previewedAt": string | null;
  "approvedAt": string | null;
  "approvalNonceId": string | null;
};
export type AppliedChange = {
  "schemaVersion": 2;
  "provenance": "synthetic" | "observed";
  "changeId": string;
  "bindingId": string;
  "planId": string;
  "planDigest": string;
  "workflowPath": string;
  "state": "PREPARED" | "APPLYING" | "APPLIED" | "REVERTED" | "CONFLICT" | "RECOVERY_REQUIRED" | "NOT_APPLIED";
  "before": {
  "path": string;
  "hash": string;
  "bytes": number;
};
  "after": {
  "path": string;
  "hash": string;
  "bytes": number;
};
  "approvalChannel": "human-ui" | "human-cli";
  "approvalReference": string;
  "updatedAt": string;
};
export type FindingEvaluation = {
  "schemaVersion": 2;
  "provenance": "synthetic" | "observed";
  "evaluationId": string;
  "findingId": string;
  "fingerprint": string;
  "bindingId": string;
  "verdict": "valid" | "false_positive" | "deferred";
  "reason": string;
  "at": string;
  "source": "human-ui" | "human-cli";
};
export type Suppression = {
  "schemaVersion": 2;
  "provenance": "synthetic" | "observed";
  "suppressionId": string;
  "bindingId": string;
  "fingerprint": string;
  "workflowHash": string;
  "reason": string;
  "createdAt": string;
  "expiresAt": string;
};
export type CapabilityReport = {
  "schemaVersion": 2;
  "provenance": "synthetic" | "observed";
  "capabilityReportId": string;
  "mode": "cli-only" | "web-readonly" | "web-write" | "read-only-degraded";
  "dshVersion": string | null;
  "nodeVersion": string | null;
  "generatorVersion": string | null;
  "runtimeStatus": "not_run" | "passed" | "partial" | "failed";
  "codegenStatus": "not_run" | "passed" | "failed";
  "fileStoreStatus": "not_run" | "passed" | "failed";
  "windowsReplaceStatus": "not_run" | "passed" | "failed";
  "webWriteRegistered": boolean;
  "evidenceRefs": string[];
  "blockers": string[];
};
export type ReleaseScope = {
  "schemaVersion": 2;
  "provenance": "synthetic" | "observed";
  "releaseVersion": string;
  "a0Status": "not_run" | "passed" | "partial" | "failed";
  "enabledRules": ("CD001" | "CD002" | "CD003" | "CD004" | "CD005" | "CD008")[];
  "patchVerifiedRules": ("CD001" | "CD005" | "CD008")[];
  "evidenceRefs": string[];
};
export type LocalEvent = {
  "schemaVersion": 2;
  "provenance": "synthetic" | "observed";
  "eventId": string;
  "kind": "report.created" | "report.opened" | "finding.evaluated" | "plan.created" | "apply.completed" | "revert.completed" | "operation.failed";
  "at": string;
  "localSubjectId": string;
  "referenceId": string;
  "errorCode": string | null;
};
export type ReportCard = {
  "schemaVersion": 2;
  "provenance": "synthetic" | "observed";
  "cardId": string;
  "engineVersion": string;
  "mode": "cli-only" | "web-readonly" | "web-write" | "read-only-degraded";
  "periodFrom": string;
  "periodTo": string;
  "reportsOpened": number;
  "distinctReportsOpened": number;
  "valid": number;
  "falsePositive": number;
  "deferred": number;
  "applied": number;
  "reverted": number;
  "reviewedByUser": true;
};
export type CountMetric = Metric & {
  "value"?: number | null;
};
export type UsdMetric = Metric & {
  "value"?: string | null;
};
export type StringMetric = Metric & {
  "value"?: string | null;
};
export type SecondsMetric = Metric & {
  "value"?: number | string | null;
};

export type CiDietContract = Config | RepositoryBinding | Attestation | Coverage | OperationProgress | AnalysisReport | PatchPlan | AppliedChange | FindingEvaluation | Suppression | CapabilityReport | ReleaseScope | LocalEvent | ReportCard;
