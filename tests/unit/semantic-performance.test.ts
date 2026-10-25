import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { ByteEdit } from "../../src/core/contracts/schema.ts";
import { applyEdits, planTimeoutEdit } from "../../src/core/patch/edits.ts";
import { semanticProblems } from "../../src/core/patch/semantic.ts";
import { parseWorkflow } from "../../src/core/workflow/parse.ts";

const MARKER = "CI_DIET_PERF_MARKER";
const PATH = ".github/workflows/ci.yml";
const SOURCE = "on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    env:\n"
  + "      " + MARKER + ": unchanged\n"
  + Array.from({ length: 1000 }, (_, i) => "      VALUE_" + i + ": value-" + i + "\n").join("")
  + "    timeout-minutes: 20\n    steps:\n      - run: echo test\n";

function inspect(t: TestContext, resultText: string, edits: readonly ByteEdit[]) {
  const original = parseWorkflow(PATH, SOURCE);
  const keys = Object.keys;
  let enumerations = 0;
  const mock = t.mock.method(Object, "keys", (value: object) => {
    if (Object.hasOwn(value, MARKER)) enumerations++;
    return keys(value);
  });
  try {
    const problems = semanticProblems({ original, originalText: SOURCE, resultText, edits });
    return { problems, enumerations };
  } finally {
    mock.mock.restore();
  }
}

test("semantic comparison enumerates each unchanged mapping only once per side", (t) => {
  const definition = parseWorkflow(PATH, SOURCE);
  const edit = planTimeoutEdit(SOURCE, definition, definition.jobs[0]!, 15).edit!;
  const result = inspect(t, applyEdits(SOURCE, [edit]).text, [edit]);
  assert.deepEqual(result.problems, []);
  t.diagnostic("enumerations of a 1001-key unchanged env mapping: " + result.enumerations);
  assert.equal(result.enumerations, 2);
});

test("cached comparison bounds repeated work while reporting a changed sibling at the end of a large mapping", (t) => {
  const definition = parseWorkflow(PATH, SOURCE);
  const edit = planTimeoutEdit(SOURCE, definition, definition.jobs[0]!, 15).edit!;
  const result = inspect(t, applyEdits(SOURCE, [edit]).text.replace("VALUE_999: value-999", "VALUE_999: changed"), [edit]);
  assert.deepEqual(result.problems, ["changed outside the allowed edit paths: jobs.test.env.VALUE_999"]);
  t.diagnostic("enumerations with an undeclared env change: " + result.enumerations);
  assert.equal(result.enumerations, 4, "one equality check and one diagnostic traversal per side");
});

test("semantic differences keep independent paths after the traversal stack is reused", (t) => {
  const definition = parseWorkflow(PATH, SOURCE);
  const edit = planTimeoutEdit(SOURCE, definition, definition.jobs[0]!, 15).edit!;
  const text = applyEdits(SOURCE, [edit]).text
    .replace("VALUE_1: value-1", "VALUE_1: changed")
    .replace("run: echo test", "run: echo changed");
  assert.deepEqual(inspect(t, text, [edit]).problems, [
    "changed outside the allowed edit paths: jobs.test.env.VALUE_1",
    "changed outside the allowed edit paths: jobs.test.steps[0].run",
  ]);
});
