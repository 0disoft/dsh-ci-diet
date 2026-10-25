import { Buffer } from "node:buffer";
import { sha256Hex } from "../../shared/cdj1.ts";
import type { ByteEdit } from "../contracts/schema.ts";
import type { WorkflowDefinition, WorkflowJob, WorkflowStep } from "../workflow/model.ts";
import { parseWorkflow } from "../workflow/parse.ts";
import { PROPOSED_RETENTION_DAYS, TIMEOUT_MINUTES_MAX, TIMEOUT_MINUTES_MIN } from "../policy/constants.ts";

export { PROPOSED_RETENTION_DAYS } from "../policy/constants.ts";

export interface EditError {
  readonly code:
    | "EDIT_NOT_APPLICABLE"
    | "EDIT_AMBIGUOUS"
    | "EDIT_OVERLAP"
    | "EDIT_RANGE_INVALID"
    | "EDIT_RESULT_INVALID";
  readonly detail: string;
}

export interface EditResult {
  readonly edit: ByteEdit | null;
  readonly error: EditError | null;
}

export function concurrencyGroup(repositoryId: string, workflowPath: string): string {
  const unique = sha256Hex(repositoryId + "\n" + workflowPath).slice(0, 16);
  return "ci-diet-" + unique + "-pr-${{ github.event.pull_request.number || github.run_id }}";
}

function bufferOf(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

function lineStartOf(buffer: Buffer, offset: number): number {
  let index = Math.min(Math.max(offset, 0), buffer.length);
  while (index > 0 && buffer[index - 1] !== 0x0a) index -= 1;
  return index;
}

function lineEndOf(buffer: Buffer, offset: number): number {
  let index = Math.min(Math.max(offset, 0), buffer.length);
  while (index < buffer.length && buffer[index] !== 0x0a) index += 1;
  return index;
}

function indentAt(buffer: Buffer, offset: number): string {
  const start = lineStartOf(buffer, offset);
  let index = start;
  while (buffer[index] === 0x20) index += 1;
  return " ".repeat(index - start);
}

/** Indentation of a step's mapping keys, derived from the enclosing sequence entry line. */
function stepKeyIndent(buffer: Buffer, step: WorkflowStep): string {
  const anchor = step.range?.startByte ?? step.usesRange?.startByte ?? null;
  if (anchor !== null) {
    let lineStart = lineStartOf(buffer, anchor);
    for (let hops = 0; hops < 8; hops += 1) {
      const line = buffer.subarray(lineStart, lineEndOf(buffer, lineStart)).toString("utf8");
      const entry = /^([ ]*)-([ \t]|$)/.exec(line);
      if (entry !== null) return (entry[1] ?? "") + "  ";
      if (lineStart === 0) break;
      lineStart = lineStartOf(buffer, Math.max(0, lineStart - 2));
    }
  }
  if (step.usesRange !== null) return indentAt(buffer, step.usesRange.startByte) + "  ";
  return "  ";
}

function newlineStyle(text: string): string {
  const lf = (text.match(/\n/g) ?? []).length;
  const crlf = (text.match(/\r\n/g) ?? []).length;
  return crlf > 0 && crlf * 2 >= lf ? "\r\n" : "\n";
}

function endOfPreviousContentLine(buffer: Buffer, offset: number): number {
  let end = Math.min(Math.max(offset, 0), buffer.length);
  while (end > 0) {
    while (end > 0 && (buffer[end - 1] === 0x0a || buffer[end - 1] === 0x0d)) end -= 1;
    const start = lineStartOf(buffer, end);
    if (end > start) return end;
    end = start;
  }
  return 0;
}

/** End of the last non-blank line that belongs to one job. */
function jobRegionEnd(buffer: Buffer, workflow: WorkflowDefinition, job: WorkflowJob): number {
  const index = workflow.jobs.findIndex((candidate) => candidate.key === job.key);
  const next = index === -1 ? undefined : workflow.jobs[index + 1];
  if (next !== undefined) {
    return endOfPreviousContentLine(buffer, lineStartOf(buffer, next.keyRange.startByte));
  }
  return endOfPreviousContentLine(buffer, buffer.length);
}

export function planConcurrencyEdit(
  text: string,
  workflow: WorkflowDefinition,
  repositoryId: string,
): EditResult {
  const buffer = bufferOf(text);
  const group = concurrencyGroup(repositoryId, workflow.path);
  const newline = newlineStyle(text);
  const prefix = buffer.length === 0 || buffer[buffer.length - 1] === 0x0a ? "" : newline;
  const replacement = prefix + "concurrency:" + newline + "  group: " + group + newline + "  cancel-in-progress: true" + newline;
  return {
    edit: {
      kind: "insertMapping",
      startByte: buffer.length,
      endByte: buffer.length,
      replacementUtf8: replacement,
      semanticPath: "concurrency",
      ruleId: "CD001",
    },
    error: null,
  };
}

export function planTimeoutEdit(text: string, workflow: WorkflowDefinition, job: WorkflowJob, minutes: number): EditResult {
  if (job.reusableWorkflow !== null) {
    return { edit: null, error: { code: "EDIT_NOT_APPLICABLE", detail: "timeout-minutes is not supported on a reusable workflow caller" } };
  }
  if (!Number.isSafeInteger(minutes) || minutes < TIMEOUT_MINUTES_MIN || minutes > TIMEOUT_MINUTES_MAX) {
    return { edit: null, error: { code: "EDIT_NOT_APPLICABLE", detail: "timeout minutes must be an integer between " + TIMEOUT_MINUTES_MIN + " and " + TIMEOUT_MINUTES_MAX } };
  }
  const buffer = bufferOf(text);
  const newline = newlineStyle(text);
  if (job.timeoutRange !== null) {
    return {
      edit: {
        kind: "replaceScalar",
        startByte: job.timeoutRange.startByte,
        endByte: job.timeoutRange.endByte,
        replacementUtf8: String(minutes),
        semanticPath: "jobs." + job.key + ".timeout-minutes",
        ruleId: "CD005",
      },
      error: null,
    };
  }
  const indent = indentAt(buffer, job.keyRange.startByte);
  const end = jobRegionEnd(buffer, workflow, job);
  const replacement = newline + indent + "  timeout-minutes: " + String(minutes);
  return {
    edit: {
      kind: "insertScalar",
      startByte: end,
      endByte: end,
      replacementUtf8: replacement,
      semanticPath: "jobs." + job.key + ".timeout-minutes",
      ruleId: "CD005",
    },
    error: null,
  };
}

export function planRetentionEdit(text: string, job: WorkflowJob, step: WorkflowStep, days: number = PROPOSED_RETENTION_DAYS): EditResult {
  if (!Number.isSafeInteger(days) || days < 1) {
    return { edit: null, error: { code: "EDIT_NOT_APPLICABLE", detail: "retention days must be a positive integer" } };
  }
  const buffer = bufferOf(text);
  const newline = newlineStyle(text);
  const semanticPath = "jobs." + job.key + ".steps[" + step.index + "].with.retention-days";
  const existing = step.withEntries.find((entry) => entry.key === "retention-days");
  if (existing !== undefined) {
    if (existing.kind !== "literal" || existing.valueRange === null) {
      return { edit: null, error: { code: "EDIT_NOT_APPLICABLE", detail: "existing retention-days is an expression and stays report-only" } };
    }
    const current = Number(existing.literal);
    if (!Number.isSafeInteger(current) || current < 0) {
      return { edit: null, error: { code: "EDIT_NOT_APPLICABLE", detail: "existing retention-days is not an integer" } };
    }
    // 0 means the repository default, which is normally far above the proposal,
    // so it must be lowered like any larger literal (rules.md:195-199).
    if (current >= 1 && current <= days) {
      return { edit: null, error: { code: "EDIT_NOT_APPLICABLE", detail: "existing retention-days is already at or below the proposal" } };
    }
    return {
      edit: {
        kind: "replaceScalar",
        startByte: existing.valueRange.startByte,
        endByte: existing.valueRange.endByte,
        replacementUtf8: String(days),
        semanticPath,
        ruleId: "CD008",
      },
      error: null,
    };
  }
  if (step.withPresent) {
    if (step.withFlow === true) {
      return { edit: null, error: { code: "EDIT_NOT_APPLICABLE", detail: "flow-style with mapping is report-only" } };
    }
    const last = step.withEntries.length === 0 ? null : (step.withEntries[step.withEntries.length - 1] ?? null);
    if (last === null) {
      return { edit: null, error: { code: "EDIT_AMBIGUOUS", detail: "with mapping has no scalar entries" } };
    }
    if (last.valueRange === null) {
      return { edit: null, error: { code: "EDIT_AMBIGUOUS", detail: "last with entry has no single-line value range" } };
    }
    const indent = indentAt(buffer, last.keyRange.startByte);
    const end = lineEndOf(buffer, last.valueRange.endByte);
    return {
      edit: {
        kind: "insertScalar",
        startByte: end,
        endByte: end,
        replacementUtf8: newline + indent + "retention-days: " + String(days),
        semanticPath,
        ruleId: "CD008",
      },
      error: null,
    };
  }
  if (step.usesRange === null) {
    return { edit: null, error: { code: "EDIT_NOT_APPLICABLE", detail: "upload step has no uses line" } };
  }
  const indent = stepKeyIndent(buffer, step);
  const end = lineEndOf(buffer, step.usesRange.endByte);
  const replacement =
    newline + indent + "with:" + newline + indent + "  retention-days: " + String(days);
  return {
    edit: {
      kind: "insertParentMapping",
      startByte: end,
      endByte: end,
      replacementUtf8: replacement,
      semanticPath,
      ruleId: "CD008",
    },
    error: null,
  };
}

export interface AppliedEdits {
  readonly text: string;
  readonly hash: string;
}

export function applyEdits(text: string, edits: readonly ByteEdit[]): AppliedEdits {
  const ordered = [...edits].sort((a, b) => (a.startByte === b.startByte ? a.endByte - b.endByte : a.startByte - b.startByte));
  const buffer = bufferOf(text);
  let previousEnd = -1;
  let previousStart = -1;
  for (const edit of ordered) {
    if (edit.startByte > edit.endByte) throw new Error("EDIT_RANGE_INVALID: start after end");
    if (edit.startByte < previousEnd || edit.startByte === previousStart) {
      throw new Error("EDIT_OVERLAP: edits must not overlap");
    }
    if (edit.endByte > buffer.length) throw new Error("EDIT_RANGE_INVALID: edit past end of file");
    previousEnd = edit.endByte;
    previousStart = edit.startByte;
  }
  const chunks: Buffer[] = [];
  let cursor = 0;
  for (const edit of ordered) {
    chunks.push(buffer.subarray(cursor, edit.startByte));
    chunks.push(Buffer.from(edit.replacementUtf8, "utf8"));
    cursor = edit.endByte;
  }
  chunks.push(buffer.subarray(cursor));
  const result = Buffer.concat(chunks);
  const resultText = result.toString("utf8");
  return { text: resultText, hash: "sha256:" + sha256Hex(resultText) };
}

/** Add only the two setup-node inputs; never insert steps or skip npm ci. */
export function planNpmCacheEdit(text: string, job: WorkflowJob, step: WorkflowStep): EditResult {
  if (step.flow || step.withFlow || step.withEntries.some((e) => ["cache", "cache-dependency-path", "package-manager-cache"].includes(e.key))) {
    return { edit: null, error: { code: "EDIT_NOT_APPLICABLE", detail: "cache settings already exist or use flow syntax" } };
  }
  const buffer = bufferOf(text);
  const newline = newlineStyle(text);
  const indent = stepKeyIndent(buffer, step);
  // Insert before the first existing with key, avoiding multiline scalar tails.
  const first = step.withEntries[0];
  let end: number;
  let replacement: string;
  if (step.withPresent) {
    if (first === undefined) return { edit: null, error: { code: "EDIT_AMBIGUOUS", detail: "empty with mapping" } };
    end = lineStartOf(buffer, first.keyRange.startByte);
    const keyIndent = indentAt(buffer, first.keyRange.startByte);
    replacement = keyIndent + "cache: npm" + newline + keyIndent + "cache-dependency-path: package-lock.json" + newline;
  } else {
    if (step.usesRange === null) return { edit: null, error: { code: "EDIT_NOT_APPLICABLE", detail: "setup step has no uses line" } };
    end = lineEndOf(buffer, step.usesRange.endByte);
    // lineEndOf points after the CR on Windows; leave the original CRLF intact.
    if (buffer[end - 1] === 0x0d) end -= 1;
    replacement = newline + indent + "with:" + newline + indent + "  cache: npm" + newline + indent + "  cache-dependency-path: package-lock.json";
  }
  return { edit: { kind: step.withPresent ? "insertScalar" : "insertParentMapping", startByte: end, endByte: end,
    replacementUtf8: replacement, semanticPath: "jobs." + job.key + ".steps[" + step.index + "].with.cache", ruleId: "CD006" }, error: null };
}

export function semanticCheck(
  original: WorkflowDefinition,
  resultText: string,
  edit: ByteEdit,
  expected: { readonly group?: string; readonly minutes?: number; readonly days?: number },
): string | null {
  const reparsed = parseWorkflow(original.path, resultText);
  if (reparsed.parseError !== null || reparsed.unsupported.length > 0) return "EDIT_RESULT_INVALID: result does not parse";
  if (edit.ruleId === "CD001") {
    if (reparsed.concurrency === null) return "EDIT_RESULT_INVALID: concurrency missing";
    if (expected.group !== undefined && reparsed.concurrency.group !== expected.group) {
      return "EDIT_RESULT_INVALID: concurrency group mismatch";
    }
    if (reparsed.concurrency.cancelInProgress !== true) {
      return "EDIT_RESULT_INVALID: cancel-in-progress must be true";
    }
    return null;
  }
  const jobKey = /^jobs\.([^.]+)\./.exec(edit.semanticPath);
  if (jobKey === null || jobKey[1] === undefined) return "EDIT_RESULT_INVALID: semantic path is not a job path";
  const job = reparsed.jobs.find((candidate) => candidate.key === jobKey[1]);
  if (job === undefined) return "EDIT_RESULT_INVALID: edited job disappeared";
  if (edit.ruleId === "CD005") {
    if (!Number.isInteger(job.timeoutMinutes) || job.timeoutMinutes === null || job.timeoutMinutes < TIMEOUT_MINUTES_MIN || job.timeoutMinutes > TIMEOUT_MINUTES_MAX) return "EDIT_RESULT_INVALID: timeout out of bounds";
    if (expected.minutes !== undefined && job.timeoutMinutes !== expected.minutes) return "EDIT_RESULT_INVALID: timeout minutes mismatch";
    return null;
  }
  if (edit.ruleId === "CD006") {
    const index = /^jobs\.[^.]+\.steps\[(\d+)\]\.with\.cache$/.exec(edit.semanticPath)?.[1];
    const step = index === undefined ? undefined : job.steps[Number(index)];
    if (!/^actions\/setup-node@v[34](?:\.\d+){0,2}$/.test(step?.uses ?? "")) return "EDIT_RESULT_INVALID: unsupported cache action";
    if (step?.withEntries.find((e) => e.key === "cache")?.literal !== "npm"
      || step.withEntries.find((e) => e.key === "cache-dependency-path")?.literal !== "package-lock.json") return "EDIT_RESULT_INVALID: npm cache inputs mismatch";
    return null;
  }
  const stepPath = /^jobs\.[^.]+\.steps\[(\d+)\]\.with\.retention-days$/.exec(edit.semanticPath);
  const stepIndex = stepPath === null ? -1 : Number(stepPath[1]);
  const step = job.steps.find((candidate) => candidate.index === stepIndex);
  if (step === undefined) return "EDIT_RESULT_INVALID: edited step disappeared";
  const retention = step.withEntries.find((entry) => entry.key === "retention-days");
  if (retention === undefined || retention.kind !== "literal") {
    return "EDIT_RESULT_INVALID: retention-days missing";
  }
  const days = Number(retention.literal);
  if (!Number.isInteger(days) || days < 1 || days > PROPOSED_RETENTION_DAYS) return "EDIT_RESULT_INVALID: retention out of bounds";
  if (expected.days !== undefined && retention.literal !== String(expected.days)) {
    return "EDIT_RESULT_INVALID: retention-days mismatch";
  }
  return null;
}
