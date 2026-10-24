import { Buffer } from "node:buffer";
import type { ByteEdit } from "../contracts/schema.ts";

export interface DiffLine {
  readonly kind: "context" | "removed" | "added";
  readonly text: string;
}

function lineStartsOf(buffer: Buffer): number[] {
  const starts: number[] = [0];
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x0a) starts.push(index + 1);
  }
  return starts;
}

/** Index of the line containing a byte offset, clamped to the last line. */
function lineIndexAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * Render the byte edits as a small line diff for humans. The plan stores byte
 * ranges, so each hunk expands the edit to the whole affected line and keeps a
 * few context lines. It is deterministic and never needs the result bytes.
 */
export function renderEditDiff(text: string, edits: readonly ByteEdit[], contextLines = 3): DiffLine[] {
  const buffer = Buffer.from(text, "utf8");
  const starts = lineStartsOf(buffer);
  const lineStart = (line: number): number => starts[line] ?? buffer.length;
  const lineEnd = (line: number): number => (line + 1 < starts.length ? (starts[line + 1] ?? buffer.length) - 1 : buffer.length);
  const lineText = (line: number): string => buffer.subarray(lineStart(line), lineEnd(line)).toString("utf8");
  const ordered = [...edits].sort((a, b) => (a.startByte === b.startByte ? a.endByte - b.endByte : a.startByte - b.startByte));
  const lines: DiffLine[] = [];
  let lastLine = -1;
  const context = (from: number, to: number): void => {
    for (let line = Math.max(from, 0); line <= to && line < starts.length; line += 1) {
      if (line <= lastLine) continue;
      lines.push({ kind: "context", text: lineText(line) });
      lastLine = line;
    }
  };
  for (const edit of ordered) {
    if (edit.startByte < 0 || edit.startByte > edit.endByte || edit.endByte > buffer.length) {
      throw new Error("EDIT_RANGE_INVALID: edit is outside the source bytes");
    }
    const first = lineIndexAt(starts, Math.min(edit.startByte, buffer.length));
    const last = lineIndexAt(starts, edit.startByte === edit.endByte ? edit.startByte : Math.min(edit.endByte - 1, buffer.length));
    // Only newline-terminated text inserts whole lines before the original
    // line. A prefix without a newline modifies that line instead.
    const insertOnly = edit.startByte === edit.endByte && edit.startByte === lineStart(first)
      && edit.replacementUtf8.endsWith("\n");
    const oldLines: string[] = [];
    if (!insertOnly) {
      for (let line = first; line <= last; line += 1) oldLines.push(lineText(line));
    }
    const prefix = buffer.subarray(lineStart(first), edit.startByte).toString("utf8");
    const suffix = buffer.subarray(edit.endByte, lineEnd(last)).toString("utf8");
    // The final newline separates the inserted lines from the untouched line;
    // it does not introduce an extra empty added line.
    const combined = insertOnly ? edit.replacementUtf8.slice(0, -1) : prefix + edit.replacementUtf8 + suffix;
    const newLines = combined.split("\n");
    context(first - contextLines, first - 1);
    let start = 0;
    while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
      context(first + start, first + start);
      start += 1;
    }
    for (let index = start; index < oldLines.length; index += 1) lines.push({ kind: "removed", text: oldLines[index] ?? "" });
    for (let index = start; index < newLines.length; index += 1) lines.push({ kind: "added", text: newLines[index] ?? "" });
    lastLine = insertOnly ? first - 1 : last;
    context(lastLine + 1, lastLine + contextLines);
  }
  return lines;
}
