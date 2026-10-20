import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWorkflow } from "../../src/core/workflow/parse.ts";
import { applyEdits, planConcurrencyEdit, planTimeoutEdit } from "../../src/core/patch/edits.ts";
import { semanticProblems } from "../../src/core/patch/semantic.ts";

const PATH = ".github/workflows/ci.yml";
const WORKFLOW = [
  "on: pull_request",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: npm test",
  "        env:",
  "          MODE: fast",
].join("\n");

function editWithPermissionTamper(): { problems: string[] } {
  const definition = parseWorkflow(PATH, WORKFLOW);
  const edit = planConcurrencyEdit(WORKFLOW, definition, "git:" + "a".repeat(32));
  if (edit.edit === null) throw new Error("fixture edit failed");
  const applied = applyEdits(WORKFLOW, [edit.edit]);
  const tampered = "permissions:\n  contents: write\n" + applied.text;
  return {
    problems: semanticProblems({
      original: definition,
      originalText: WORKFLOW,
      resultText: tampered,
      edits: [edit.edit],
    }),
  };
}

test("accepts a concurrency insertion that changes only the planned leaves", () => {
  const definition = parseWorkflow(PATH, WORKFLOW);
  const edit = planConcurrencyEdit(WORKFLOW, definition, "git:" + "a".repeat(32));
  if (edit.edit === null) throw new Error("fixture edit failed");
  const applied = applyEdits(WORKFLOW, [edit.edit]);
  assert.deepEqual(
    semanticProblems({
      original: definition,
      originalText: WORKFLOW,
      resultText: applied.text,
      edits: [edit.edit],
    }),
    [],
  );
});

test("reports a top-level permission added beside the planned edit", () => {
  const { problems } = editWithPermissionTamper();
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /added outside the allowed edit paths: permissions\.contents/);
});

test("reports a changed env value inside an existing step", () => {
  const definition = parseWorkflow(PATH, WORKFLOW);
  const job = definition.jobs[0];
  if (job === undefined) throw new Error("fixture job missing");
  const edit = planTimeoutEdit(WORKFLOW, definition, job, 15);
  if (edit.edit === null) throw new Error("fixture edit failed");
  const applied = applyEdits(WORKFLOW, [edit.edit]);
  const tampered = applied.text.replace("MODE: fast", "MODE: slow");
  const problems = semanticProblems({
    original: definition,
    originalText: WORKFLOW,
    resultText: tampered,
    edits: [edit.edit],
  });
  assert.equal(problems.length, 1);
  assert.match(
    problems[0]!,
    /changed outside the allowed edit paths: jobs\.build\.steps\[0\]\.env\.MODE/,
  );
});

test("reports an extra job field added with a timeout edit", () => {
  const definition = parseWorkflow(PATH, WORKFLOW);
  const job = definition.jobs[0];
  if (job === undefined) throw new Error("fixture job missing");
  const edit = planTimeoutEdit(WORKFLOW, definition, job, 15);
  if (edit.edit === null) throw new Error("fixture edit failed");
  const applied = applyEdits(WORKFLOW, [edit.edit]);
  const tampered = applied.text.replace(
    "    runs-on: ubuntu-latest",
    "    runs-on: ubuntu-latest\n    environment: production",
  );
  const problems = semanticProblems({
    original: definition,
    originalText: WORKFLOW,
    resultText: tampered,
    edits: [edit.edit],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /added outside the allowed edit paths: jobs\.build\.environment/);
});

test("reports a deleted empty mapping beside the planned edit", () => {
  const originalText = "permissions: {}\n" + WORKFLOW;
  const definition = parseWorkflow(PATH, originalText);
  const edit = planConcurrencyEdit(originalText, definition, "git:" + "a".repeat(32));
  if (edit.edit === null) throw new Error("fixture edit failed");
  const applied = applyEdits(originalText, [edit.edit]);
  const tampered = applied.text.replace("permissions: {}\n", "");
  const problems = semanticProblems({
    original: definition,
    originalText,
    resultText: tampered,
    edits: [edit.edit],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /missing outside the allowed edit paths: permissions/);
});

test("reports an added empty sequence beside the planned edit", () => {
  const definition = parseWorkflow(PATH, WORKFLOW);
  const job = definition.jobs[0];
  if (job === undefined) throw new Error("fixture job missing");
  const edit = planTimeoutEdit(WORKFLOW, definition, job, 15);
  if (edit.edit === null) throw new Error("fixture edit failed");
  const applied = applyEdits(WORKFLOW, [edit.edit]);
  const tampered = applied.text.replace(
    "    runs-on: ubuntu-latest",
    "    runs-on: ubuntu-latest\n    env: []",
  );
  const problems = semanticProblems({
    original: definition,
    originalText: WORKFLOW,
    resultText: tampered,
    edits: [edit.edit],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /added outside the allowed edit paths: jobs\.build\.env/);
});

test("reports a parent node changed to null even when it contains an allowed leaf", () => {
  const definition = parseWorkflow(PATH, WORKFLOW);
  const job = definition.jobs[0];
  if (job === undefined) throw new Error("fixture job missing");
  const edit = planTimeoutEdit(WORKFLOW, definition, job, 15);
  if (edit.edit === null) throw new Error("fixture edit failed");
  const applied = applyEdits(WORKFLOW, [edit.edit]);
  const tampered = applied.text.replace(
    "    steps:\n      - run: npm test\n        env:\n          MODE: fast\n",
    "    steps: null\n",
  );
  const problems = semanticProblems({
    original: definition,
    originalText: WORKFLOW,
    resultText: tampered,
    edits: [edit.edit],
  });
  assert.ok(problems.length >= 1, problems.join(";"));
  assert.match(problems.join(";"), /changed outside the allowed edit paths: jobs\.build\.steps/);
});
