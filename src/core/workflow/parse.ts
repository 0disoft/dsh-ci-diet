import { Buffer } from "node:buffer";
import { isAlias, isMap, isScalar, isSeq, parseAllDocuments } from "yaml";
import type { Document, Node, YAMLMap } from "yaml";
import { sha256Hex } from "../../shared/cdj1.ts";
import type { CanonicalJsonValue } from "../../shared/cdj1.ts";
import type {
  ByteRange,
  MatrixAxis,
  MatrixPlan,
  StepWithEntry,
  UnsupportedFeature,
  WorkflowConcurrency,
  WorkflowDefinition,
  WorkflowJob,
  WorkflowStep,
} from "./model.ts";

const MATRIX_EXPRESSION = /\$\{\{/;

/** Convert a yaml node range (UTF-16 code-unit offsets) into UTF-8 byte offsets. */
export function byteRangeOf(text: string, node: Node | null | undefined): ByteRange | null {
  const range = node?.range;
  if (!range) return null;
  const [start, valueEnd] = range;
  return {
    startByte: Buffer.byteLength(text.slice(0, start), "utf8"),
    endByte: Buffer.byteLength(text.slice(0, valueEnd), "utf8"),
  };
}

function errorLine(text: string, error: unknown): number | null {
  const candidate = error as {
    pos?: readonly [number, number];
    linePos?: readonly { line: number }[];
  };
  const firstLinePos = candidate.linePos?.[0];
  if (firstLinePos && typeof firstLinePos.line === "number") return firstLinePos.line;
  const start = candidate.pos?.[0];
  if (typeof start === "number") return text.slice(0, start).split("\n").length;
  return null;
}

function walk(node: Node | null | undefined, visit: (node: Node) => void): void {
  if (!node) return;
  visit(node);
  if (isMap(node)) {
    for (const pair of node.items) {
      walk(pair.key as Node, visit);
      walk(pair.value as Node | null, visit);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) walk(item as Node | null, visit);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function toCanonical(value: unknown): CanonicalJsonValue | undefined {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined;
  if (Array.isArray(value)) {
    const out: CanonicalJsonValue[] = [];
    for (const item of value) {
      const converted = toCanonical(item);
      if (converted === undefined) return undefined;
      out.push(converted);
    }
    return out;
  }
  if (isPlainObject(value)) {
    const out: Record<string, CanonicalJsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const converted = toCanonical(item);
      if (converted === undefined) return undefined;
      out[key] = converted;
    }
    return out;
  }
  return undefined;
}

function containsExpression(value: CanonicalJsonValue | undefined): boolean {
  if (typeof value === "string") return MATRIX_EXPRESSION.test(value);
  if (Array.isArray(value)) return value.some((item) => containsExpression(item));
  if (value && typeof value === "object") return Object.values(value).some((item) => containsExpression(item));
  return false;
}

function jsonOf(value: unknown): unknown {
  if (value && typeof value === "object" && "toJSON" in value) {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") return (toJSON as () => unknown).call(value);
  }
  return undefined;
}

function scalarText(node: Node | null | undefined): string | null {
  if (!node || !isScalar(node)) return null;
  const value = node.value;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function readMatrix(matrixNode: Node | null | undefined): MatrixPlan | null {
  if (matrixNode === null || matrixNode === undefined) return null;
  if (!isMap(matrixNode)) return { axes: [], include: [], exclude: [], dynamic: true };
  const axes: MatrixAxis[] = [];
  const include: Record<string, CanonicalJsonValue>[] = [];
  const exclude: Record<string, CanonicalJsonValue>[] = [];
  let dynamic = false;
  for (const pair of matrixNode.items) {
    const name = scalarText(pair.key as Node);
    if (name === null) {
      dynamic = true;
      continue;
    }
    const value = pair.value;
    if (name === "include" || name === "exclude") {
      if (!isSeq(value)) {
        dynamic = true;
        continue;
      }
      for (const item of value.items) {
        const converted = item && isMap(item) ? toCanonical(jsonOf(item)) : undefined;
        if (!converted || typeof converted !== "object" || Array.isArray(converted)) {
          dynamic = true;
          continue;
        }
        if (containsExpression(converted)) {
          dynamic = true;
          continue;
        }
        const entry = converted as Record<string, CanonicalJsonValue>;
        if (name === "include") include.push(entry);
        else exclude.push(entry);
      }
      continue;
    }
    if (!isSeq(value)) {
      dynamic = true;
      continue;
    }
    const values: CanonicalJsonValue[] = [];
    let axisDynamic = false;
    for (const item of value.items) {
      const converted = item ? toCanonical(jsonOf(item)) : undefined;
      if (converted === undefined) {
        axisDynamic = true;
        break;
      }
      if (containsExpression(converted)) {
        axisDynamic = true;
        break;
      }
      values.push(converted);
    }
    if (axisDynamic) {
      dynamic = true;
      continue;
    }
    axes.push({ name, values });
  }
  return { axes, include, exclude, dynamic };
}

function readStringList(node: Node | null | undefined): string[] {
  if (!node) return [];
  if (isScalar(node)) {
    const text = scalarText(node);
    return text === null ? [] : [text];
  }
  if (!isSeq(node)) return [];
  const out: string[] = [];
  for (const item of node.items) {
    const text = scalarText(item as Node);
    if (text !== null) out.push(text);
  }
  return out;
}

function readEntry(text: string, key: string, keyNode: Node, valueNode: Node | null): StepWithEntry {
  const keyRange = byteRangeOf(text, keyNode) ?? { startByte: 0, endByte: 0 };
  const valueRange = byteRangeOf(text, valueNode);
  if (valueNode !== null && isScalar(valueNode)) {
    const raw = (valueNode as { value?: unknown }).value;
    if (typeof raw === "string") {
      if (MATRIX_EXPRESSION.test(raw)) return { key, keyRange, kind: "expression", literal: null, valueRange };
      return { key, keyRange, kind: "literal", literal: raw, valueRange };
    }
    if (typeof raw === "number" || typeof raw === "boolean") {
      return { key, keyRange, kind: "literal", literal: String(raw), valueRange };
    }
  }
  return { key, keyRange, kind: "non-scalar", literal: null, valueRange };
}

function readSteps(text: string, stepsNode: Node | null | undefined): WorkflowStep[] {
  if (!stepsNode || !isSeq(stepsNode)) return [];
  const steps: WorkflowStep[] = [];
  for (const [index, item] of stepsNode.items.entries()) {
    const stepNode = item as Node | null;
    if (!stepNode || !isMap(stepNode)) {
      steps.push({
        index,
        name: null,
        uses: null,
        usesRange: null,
        run: null,
        withPresent: false,
        withEntries: [],
        otherEntries: [],
        withRange: null,
        withFlow: false,
        flow: false,
        range: byteRangeOf(text, stepNode),
      });
      continue;
    }
    const usesNode = stepNode.get("uses", true) as Node | null;
    const usesText = scalarText(usesNode);
    const withNode = stepNode.get("with", true) as Node | null;
    const otherEntries: StepWithEntry[] = [];
    for (const pair of stepNode.items) {
      const key = scalarText(pair.key as Node);
      if (key === null || key === "uses" || key === "run" || key === "name" || key === "with") continue;
      otherEntries.push(readEntry(text, key, pair.key as Node, pair.value as Node | null));
    }
    const withEntries: StepWithEntry[] = [];
    let withPresent = false;
    let withFlow = false;
    if (withNode) {
      withPresent = true;
      if (isMap(withNode)) {
        withFlow = (withNode as { flow?: boolean }).flow === true;
        for (const pair of withNode.items) {
          const key = scalarText(pair.key as Node);
          if (key === null) continue;
          withEntries.push(readEntry(text, key, pair.key as Node, pair.value as Node | null));
        }
      }
    }
    steps.push({
      index,
      name: scalarText(stepNode.get("name", true) as Node | null),
      uses: usesText !== null && !MATRIX_EXPRESSION.test(usesText) ? usesText : null,
      usesRange: byteRangeOf(text, usesNode),
      run: scalarText(stepNode.get("run", true) as Node | null),
      withPresent,
      withEntries,
      otherEntries,
      withRange: byteRangeOf(text, withNode),
      withFlow,
      flow: (stepNode as { flow?: boolean }).flow === true,
      range: byteRangeOf(text, stepNode),
    });
  }
  return steps;
}

function readEnvironment(text: string, node: Node | null | undefined): { name: string | null; range: ByteRange | null } {
  if (!node) return { name: null, range: null };
  if (isScalar(node)) return { name: scalarText(node), range: byteRangeOf(text, node) };
  if (isMap(node)) {
    const nameNode = node.get("name", true) as Node | null;
    return { name: scalarText(nameNode), range: byteRangeOf(text, node) };
  }
  return { name: null, range: byteRangeOf(text, node) };
}

interface JobsReadResult {
  readonly jobs: WorkflowJob[];
  readonly unsupported: UnsupportedFeature[];
}

function readJobs(text: string, jobsNode: Node | null | undefined): JobsReadResult {
  if (jobsNode === null || jobsNode === undefined) return { jobs: [], unsupported: [] };
  if (!isMap(jobsNode)) {
    return {
      jobs: [],
      unsupported: [{
        code: "jobs-not-a-mapping",
        detail: "jobs must be a mapping of job keys",
        range: null,
      }],
    };
  }
  const jobs: WorkflowJob[] = [];
  for (const pair of jobsNode.items) {
    const key = scalarText(pair.key as Node);
    if (key === null) continue;
    jobs.push(readJob(text, key, pair.key as Node, pair.value as Node | null));
  }
  return { jobs, unsupported: [] };
}

function readRunWorkingDirectory(node: Node | null | undefined): string | null {
  if (!node || !isMap(node)) return null;
  const run = node.get("run", true) as Node | null;
  if (!run || !isMap(run)) return null;
  return scalarText(run.get("working-directory", true) as Node | null);
}

function readJob(text: string, key: string, keyNode: Node, jobNode: Node | null | undefined): WorkflowJob {
  const job = jobNode && isMap(jobNode) ? jobNode : null;
  const nameNode = (job ? job.get("name", true) : null) as Node | null;
  const timeoutNode = (job ? job.get("timeout-minutes", true) : null) as Node | null;
  const strategyNode = (job ? job.get("strategy", true) : null) as Node | null;
  const matrixNode = strategyNode && isMap(strategyNode) ? (strategyNode.get("matrix", true) as Node | null) : null;
  const runsOnNode = (job ? job.get("runs-on", true) : null) as Node | null;
  const environment = readEnvironment(text, job ? (job.get("environment", true) as Node | null) : null);
  const reusableNode = (job ? job.get("uses", true) : null) as Node | null;
  const timeoutValue = timeoutNode && isScalar(timeoutNode) ? timeoutNode.value : null;
  const runsOnText = runsOnNode && isScalar(runsOnNode) ? scalarText(runsOnNode) : null;
  return {
    key,
    keyRange: byteRangeOf(text, keyNode) ?? { startByte: 0, endByte: 0 },
    displayName: scalarText(nameNode),
    displayNameRange: byteRangeOf(text, nameNode),
    timeoutMinutes: typeof timeoutValue === "number" && Number.isSafeInteger(timeoutValue) ? timeoutValue : null,
    timeoutRange: byteRangeOf(text, timeoutNode),
    matrix: readMatrix(matrixNode as Node | null),
    needs: readStringList(job ? (job.get("needs", true) as Node | null) : null),
    runsOn: runsOnText,
    runsOnRange: byteRangeOf(text, runsOnNode),
    environment: environment.name,
    environmentRange: environment.range,
    reusableWorkflow: scalarText(reusableNode),
    defaultWorkingDirectory: readRunWorkingDirectory(job ? (job.get("defaults", true) as Node | null) : null),
    steps: readSteps(text, job ? (job.get("steps", true) as Node | null) : null),
  };
}

function readTriggers(value: Node | null | undefined): string[] {
  if (!value) return [];
  if (isScalar(value)) {
    const text = scalarText(value);
    return text === null ? [] : [text];
  }
  if (isSeq(value)) {
    const out: string[] = [];
    for (const item of value.items) {
      const text = scalarText(item as Node);
      if (text !== null) out.push(text);
    }
    return out;
  }
  if (isMap(value)) {
    const out: string[] = [];
    for (const pair of value.items) {
      const text = scalarText(pair.key as Node);
      if (text !== null) out.push(text);
    }
    return out;
  }
  return [];
}

function readPullRequestTypes(onNode: Node | null | undefined): string[] | null {
  if (!onNode || !isMap(onNode)) return null;
  const prNode = onNode.get("pull_request", true) as Node | null;
  if (!prNode || !isMap(prNode)) return null;
  const typesNode = prNode.get("types", true) as Node | null;
  if (!typesNode) return null;
  return readStringList(typesNode);
}

function readConcurrency(text: string, value: Node | null | undefined): WorkflowConcurrency | null {
  if (!value) return null;
  const range = byteRangeOf(text, value);
  if (!range) return null;
  if (isScalar(value)) return { group: scalarText(value), cancelInProgress: null, queue: null, range };
  if (!isMap(value)) return null;
  const groupNode = value.get("group", true) as Node | null;
  const cancelNode = value.get("cancel-in-progress", true) as Node | null;
  const queueNode = value.get("queue", true) as Node | null;
  const cancel = cancelNode && isScalar(cancelNode) ? cancelNode.value : null;
  return {
    group: scalarText(groupNode),
    cancelInProgress: typeof cancel === "boolean" ? cancel : null,
    queue: scalarText(queueNode),
    range,
  };
}

export function parseWorkflow(path: string, text: string): WorkflowDefinition {
  const bytes = Buffer.from(text, "utf8");
  const sha256 = "sha256:" + sha256Hex(text);
  const documents = parseAllDocuments(text, { uniqueKeys: true, prettyErrors: false });
  const unsupported: UnsupportedFeature[] = [];
  const doc: Document | undefined = documents[0];
  if (!doc) {
    return {
      path,
      sha256,
      bytes: bytes.byteLength,
      name: null,
      triggers: [],
      pullRequestTypes: null,
      defaultWorkingDirectory: null,
      concurrency: null,
      jobs: [],
      unsupported,
      parseError: { message: "empty document", line: null },
    };
  }
  if (documents.length > 1) {
    unsupported.push({ code: "multiple-documents", detail: documents.length + " documents", range: null });
  }
  let parseError: { message: string; line: number | null } | null = null;
  for (const error of doc.errors) {
    if (error.code === "DUPLICATE_KEY") {
      unsupported.push({ code: "duplicate-key", detail: error.message, range: null });
    } else if (!parseError) {
      parseError = { message: error.message, line: errorLine(text, error) };
    }
  }
  walk(doc.contents as Node | null, (node) => {
    if (isAlias(node)) {
      unsupported.push({ code: "alias", detail: "yaml alias", range: byteRangeOf(text, node) });
    } else {
      const anchor = (node as { anchor?: string }).anchor;
      if (typeof anchor === "string" && anchor.length > 0) {
        unsupported.push({ code: "anchor", detail: "yaml anchor &" + anchor, range: byteRangeOf(text, node) });
      }
    }
    const tag = (node as { tag?: string }).tag;
    if (typeof tag === "string" && tag.length > 0 && !tag.startsWith("tag:yaml.org,2002:")) {
      unsupported.push({ code: "custom-tag", detail: "tag " + tag, range: byteRangeOf(text, node) });
    }
  });
  const root = doc.contents;
  if (!root || !isMap(root)) {
    if (!parseError) parseError = { message: "workflow root must be a mapping", line: null };
    return {
      path,
      sha256,
      bytes: bytes.byteLength,
      name: null,
      triggers: [],
      pullRequestTypes: null,
      defaultWorkingDirectory: null,
      concurrency: null,
      jobs: [],
      unsupported,
      parseError,
    };
  }
  const rootMap = root as YAMLMap;
  const onNode = rootMap.get("on", true) as Node | null;
  const jobsRead = readJobs(text, rootMap.get("jobs", true) as Node | null);
  return {
    path,
    sha256,
    bytes: bytes.byteLength,
    name: scalarText(rootMap.get("name", true)),
    triggers: readTriggers(onNode),
    pullRequestTypes: readPullRequestTypes(onNode),
    defaultWorkingDirectory: readRunWorkingDirectory(rootMap.get("defaults", true) as Node | null),
    concurrency: readConcurrency(text, rootMap.get("concurrency", true) as Node | null),
    jobs: jobsRead.jobs,
    unsupported: [...unsupported, ...jobsRead.unsupported],
    parseError,
  };
}