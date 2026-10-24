import type { HistoryBundle, HistoryPull } from "./model.ts";

/** JSON representation: Map entries must be explicit or JSON.stringify drops them. */
export interface HistoryRecord extends Omit<HistoryBundle, "pulls"> {
  readonly pulls: unknown;
}

export function historyRecord(history: HistoryBundle): HistoryRecord {
  return { ...history, pulls: [...history.pulls] };
}

export function historyFromRecord(record: HistoryRecord): HistoryBundle {
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
