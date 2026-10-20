import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseWorkflow, recoverJobKey } from "../../src/core/workflow/index.ts";

const FIXTURES = new URL("../fixtures/workflows/", import.meta.url);

async function jobs(name: string) {
  const text = await readFile(new URL(name, FIXTURES), "utf8");
  return parseWorkflow(name, text).jobs;
}

test("attributes a matrix-expanded display name", async () => {
  const workflowJobs = await jobs("matrix-name.yml");
  for (const name of ["Windows", "Linux", "macOS"]) {
    const match = recoverJobKey(name, workflowJobs);
    assert.ok(match, name);
    assert.equal(match.key, "tests");
    assert.equal(match.level, "matrix-expanded");
    assert.deepEqual(match.matrix?.runner, { name, os: name === "Linux" ? "namespace-profile-default" : name === "Windows" ? "windows-latest" : "macos-15" });
  }
  assert.equal(recoverJobKey("  Linux  ", workflowJobs)?.key, "tests");
  assert.equal(recoverJobKey("Ubuntu", workflowJobs), null);
});

test("applies include additions and exclude removals", async () => {
  const workflowJobs = await jobs("matrix-include.yml");
  assert.equal(recoverJobKey("Build ubuntu-latest 24", workflowJobs)?.key, "build");
  assert.equal(recoverJobKey("Build windows-latest 22", workflowJobs)?.key, "build");
  assert.equal(recoverJobKey("Build windows-latest 20", workflowJobs), null);
  assert.equal(recoverJobKey("Notify the team", workflowJobs)?.level, "name-literal");
  assert.equal(recoverJobKey("notify", workflowJobs)?.level, "key-equals-name");
});

test("never expands a computed matrix", async () => {
  const workflowJobs = await jobs("dynamic-matrix.yml");
  assert.equal(recoverJobKey("job", workflowJobs)?.level, "key-equals-name");
  assert.equal(recoverJobKey("calculate_matrix", workflowJobs)?.level, "key-equals-name");
  assert.equal(recoverJobKey("PR - test-x86_64-gnu", workflowJobs), null);
});

test("attributes a single-job workflow without guessing", async () => {
  const workflowJobs = await jobs("single-job.yml");
  const match = recoverJobKey("Platform (ubuntu-latest, 24.x)", workflowJobs);
  assert.ok(match);
  assert.equal(match.key, "build");
  assert.equal(match.level, "single-job");
});

test("returns null for empty job lists", () => {
  assert.equal(recoverJobKey("build", []), null);
});

test("refuses to expand past the combination cap", () => {
  const values = Array.from({ length: 20 }, (_, index) => index);
  const text = [
    "on: push",
    "jobs:",
    "  build:",
    "    name: ${{ matrix.a }}-${{ matrix.b }}",
    "    strategy:",
    "      matrix:",
    "        a: [" + values.join(", ") + "]",
    "        b: [" + values.join(", ") + "]",
    "    runs-on: ubuntu-latest",
    "  other:",
    "    runs-on: ubuntu-latest",
    "",
  ].join("\n");
  const workflowJobs = parseWorkflow("big.yml", text).jobs;
  assert.equal(workflowJobs.length, 2);
  assert.equal(recoverJobKey("0-0", workflowJobs), null);
});
