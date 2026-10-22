import assert from "node:assert/strict";
import test from "node:test";
import type { ByteEdit } from "../../src/core/contracts/schema.ts";
import { applyEdits } from "../../src/core/patch/edits.ts";
import { renderEditDiff } from "../../src/core/patch/diff.ts";

function edit(startByte: number, endByte: number, replacementUtf8: string): ByteEdit {
  return {
    kind: endByte === startByte ? "insertScalar" : "replaceScalar",
    startByte,
    endByte,
    replacementUtf8,
    semanticPath: "jobs.test.steps",
    ruleId: "CD001",
  };
}

function render(text: string, edits: readonly ByteEdit[]): string {
  return renderEditDiff(text, edits)
    .map((line) => (line.kind === "removed" ? "- " : line.kind === "added" ? "+ " : "  ") + line.text)
    .join("\n");
}

test("renders a scalar replacement on its whole line with context", () => {
  const text = "jobs:\n  test:\n    steps:\n      - uses: actions/upload-artifact@v4\n        with:\n          retention-days: 30\n";
  const rendered = render(text, [edit(text.indexOf("30"), text.indexOf("30") + 2, "7")]);
  assert.match(rendered, /^ +- uses: actions\/upload-artifact@v4$/m);
  assert.match(rendered, /^- +retention-days: 30$/m);
  assert.match(rendered, /^\+ +retention-days: 7$/m);
  assert.equal(rendered.includes("retention-days: 30\n- "), false);
});

test("renders a pure insertion without removing the unchanged line", () => {
  const text = "name: ci\non: push\n";
  const offset = text.indexOf("\n");
  const rendered = render(text, [edit(offset, offset, "\nconcurrency:\n  group: ci")]);
  assert.match(rendered, /^  name: ci$/m);
  assert.match(rendered, /^\+ concurrency:$/m);
  assert.match(rendered, /^\+   group: ci$/m);
  assert.equal(rendered.includes("- name: ci"), false);
});

test("applies sorted edits and keeps the result equal to the byte application", () => {
  const text = "a: 1\nb: 2\nc: 3\n";
  const edits = [edit(text.indexOf("3"), text.indexOf("3") + 1, "9"), edit(0, 1, "z")];
  const rendered = render(text, edits);
  assert.ok(rendered.indexOf("- a: 1") < rendered.indexOf("- c: 3"));
  assert.match(rendered, /^\+ z: 1$/m);
  assert.match(rendered, /^\+ c: 9$/m);
  assert.equal(applyEdits(text, edits).text, "z: 1\nb: 2\nc: 9\n");
});

test("rejects an edit outside the source bytes", () => {
  assert.throws(() => renderEditDiff("a: 1\n", [edit(2, 99, "x")]), /EDIT_RANGE_INVALID/);
});