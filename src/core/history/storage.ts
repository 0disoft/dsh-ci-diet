import type { WorkflowDefinition } from "../workflow/model.ts";
import type { HistoryBundle, HistoryPull, HistoryRun } from "./model.ts";

/** JSON representation: Map entries must be explicit or JSON.stringify drops them. */
interface InlineHistoryRecord extends Omit<HistoryBundle, "pulls"> {
  readonly pulls: unknown;
}

interface IndexedHistoryRecord extends Omit<InlineHistoryRecord, "runs"> {
  readonly storageVersion: 2;
  readonly definitions: readonly WorkflowDefinition[];
  readonly runs: readonly (Omit<HistoryRun, "definition"> & { readonly definition: number | null })[];
}

export type HistoryRecord = InlineHistoryRecord | IndexedHistoryRecord;

export function historyRecord(history: HistoryBundle): HistoryRecord {
  const definitions: WorkflowDefinition[] = [];
  const byIdentity = new Map<WorkflowDefinition, number>();
  const byContent = new Map<string, number>();
  let resolved = 0;
  const runs = history.runs.map((run) => {
    const definition = run.definition;
    if (definition === null) return { ...run, definition: null };
    resolved++;
    let index = byIdentity.get(definition);
    if (index === undefined) {
      // Different commits can contain the same workflow. Compare the entire
      // parsed value, not just its SHA, to preserve paths and parser metadata.
      const key = JSON.stringify(definition);
      index = byContent.get(key);
      if (index === undefined) {
        index = definitions.length;
        definitions.push(definition);
        byContent.set(key, index);
      }
      byIdentity.set(definition, index);
    }
    return { ...run, definition: index };
  });
  const inline = { ...history, pulls: [...history.pulls] };
  return definitions.length < resolved ? { ...inline, storageVersion: 2, definitions, runs } : inline;
}

function inlineRecord(record: HistoryRecord): InlineHistoryRecord {
  if (!("storageVersion" in record)) return record;
  if (record.storageVersion !== 2 || !Array.isArray(record.definitions) || !Array.isArray(record.runs)) {
    throw new Error("invalid history storage format");
  }
  const { storageVersion: _version, definitions, runs, ...rest } = record;
  if (definitions.some((value) => value === null || typeof value !== "object" || Array.isArray(value))) {
    throw new Error("invalid workflow definition table");
  }
  return { ...rest, runs: runs.map((run) => {
    const index = run.definition;
    if (index === null) return { ...run, definition: null };
    if (!Number.isSafeInteger(index) || index < 0 || index >= definitions.length || definitions[index] === undefined) {
      throw new Error("invalid workflow definition reference");
    }
    return { ...run, definition: definitions[index]! };
  }) };
}

export function historyFromRecord(stored: HistoryRecord): HistoryBundle {
  const record = inlineRecord(stored);
  const entries = record.pulls;
  if (entries !== null && typeof entries === "object" && !Array.isArray(entries) && Object.keys(entries).length === 0) {
    // Older writers serialized every Map as {}. Lost PRs require another sync;
    // do not keep claiming complete changed-files evidence when its count is unknown/nonzero.
    const changedFiles = record.coverage.changedFiles;
    return { ...record, pulls: new Map(), coverage: { ...record.coverage,
      changedFiles: changedFiles.expected === 0 ? changedFiles : { ...changedFiles,
        status: "unavailable", fetched: 0, reasons: [...new Set([...changedFiles.reasons, "LEGACY_PULLS_UNAVAILABLE"])],
      },
    } };
  }
  if (!Array.isArray(entries)) throw new Error("invalid pull request entries");
  const pulls = new Map<number, HistoryPull>();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error("invalid pull request entry");
    const [number, value] = entry as [unknown, unknown];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 || pulls.has(number)
      || value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid pull request identity");
    const pull = value as Record<string, unknown>;
    if (pull.number !== number || typeof pull.baseBranch !== "string" || typeof pull.headBranch !== "string"
      || (pull.files !== null && (!Array.isArray(pull.files) || !pull.files.every((file) => typeof file === "string")))) {
      throw new Error("invalid pull request fields");
    }
    pulls.set(number, value as HistoryPull);
  }
  return { ...record, pulls };
}
