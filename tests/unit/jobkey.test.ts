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

test("attributes each leg of a single-job matrix workflow", () => {
  const text = [
    "on: push",
    "jobs:",
    "  test:",
    "    strategy:",
    "      matrix:",
    "        os: [ubuntu-latest, windows-2022]",
    "        node: [18, 20]",
    "    runs-on: $" + "{{ matrix.os }}",
    "    steps:",
    "      - run: echo ok",
    "",
  ].join("\n");
  const workflowJobs = parseWorkflow("single-matrix.yml", text).jobs;
  const linux = recoverJobKey("test (ubuntu-latest, 18)", workflowJobs);
  assert.ok(linux);
  assert.equal(linux.key, "test");
  assert.equal(linux.level, "matrix-expanded");
  assert.deepEqual(linux.matrix, { os: "ubuntu-latest", node: 18 });
  const windows = recoverJobKey("test (windows-2022, 20)", workflowJobs);
  assert.ok(windows);
  assert.deepEqual(windows.matrix, { os: "windows-2022", node: 20 });
  assert.equal(recoverJobKey("Platform (ubuntu-latest, 24.x)", workflowJobs), null);
});

test("keeps a non-matrix single job on the single-job level", async () => {
  const workflowJobs = await jobs("single-job.yml");
  const match = recoverJobKey("Platform (ubuntu-latest, 24.x)", workflowJobs);
  assert.ok(match);
  assert.equal(match.key, "build");
  assert.equal(match.level, "single-job");
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

test("refuses a duplicate matrix rendering that cannot be attributed", () => {
  const text = [
    "on: push",
    "jobs:",
    "  build:",
    "    name: CI $" + "{{ matrix.os }}",
    "    strategy:",
    "      matrix:",
    "        os: [ubuntu-latest]",
    "        arch: [x64, arm64]",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo ok",
    "",
  ].join("\n");
  const workflowJobs = parseWorkflow("matrix-duplicate-name.yml", text).jobs;
  assert.equal(recoverJobKey("CI ubuntu-latest", workflowJobs), null);
});

test("refuses two jobs that share one literal name", () => {
  const text = [
    "on: push",
    "jobs:",
    "  first:",
    "    name: shared",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo one",
    "  second:",
    "    name: shared",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo two",
    "",
  ].join("\n");
  const workflowJobs = parseWorkflow("duplicate-name.yml", text).jobs;
  assert.equal(recoverJobKey("shared", workflowJobs), null);
  assert.equal(recoverJobKey("first", workflowJobs)?.key, "first");
});

test("refuses a job key that a matrix rendering can also explain", () => {
  const text = [
    "on: push",
    "jobs:",
    "  build:",
    "    name: $" + "{{ matrix.os }}",
    "    strategy:",
    "      matrix:",
    "        os: [lint]",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo ok",
    "  lint:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo ok",
    "",
  ].join("\n");
  const workflowJobs = parseWorkflow("matrix-literal-precedence.yml", text).jobs;
  assert.equal(recoverJobKey("lint", workflowJobs), null);
});

test("refuses a name that is both a job key and another job name", () => {
  const text = [
    "on: push",
    "jobs:",
    "  build:",
    "    name: Other",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo build",
    "  other:",
    "    name: build",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo other",
    "",
  ].join("\n");
  const workflowJobs = parseWorkflow("key-name-collision.yml", text).jobs;
  assert.equal(recoverJobKey("build", workflowJobs), null);
  assert.equal(recoverJobKey("Other", workflowJobs)?.key, "build");
});

test("refuses one literal name shared by every matrix leg", () => {
  const text = [
    "on: push",
    "jobs:",
    "  tests:",
    "    name: Shared",
    "    strategy:",
    "      matrix:",
    "        os: [ubuntu-latest, windows-2022]",
    "    runs-on: ${{ matrix.os }}",
    "    steps:",
    "      - run: echo ok",
    "",
  ].join("\n");
  const workflowJobs = parseWorkflow("shared-matrix-name.yml", text).jobs;
  assert.equal(recoverJobKey("Shared", workflowJobs), null);
});