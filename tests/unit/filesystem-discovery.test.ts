import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { discoverWorkflows } from "../../src/core/scan/discover.ts";
import { runStaticScan } from "../../src/core/scan/scan.ts";
import type { FileSystem, FileSystemEntry } from "../../src/core/support/filesystem.ts";

const ROOT = process.platform === "win32" ? "C:\\repo" : "/repo";
const DIRECTORY = join(ROOT, ".github", "workflows");

function entry(name: string, kind: "file" | "link" | "directory"): FileSystemEntry {
  return {
    name,
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "link",
  };
}

function memoryFs(
  files: Readonly<Record<string, string>>,
  options: {
    entries?: readonly FileSystemEntry[];
    realpaths?: Readonly<Record<string, string>>;
    readdirError?: NodeJS.ErrnoException;
  } = {},
): FileSystem {
  const lookup = (path: string): string | undefined => {
    if (files[path] !== undefined) return files[path];
    const base = path.split(/[\\/]/).pop() ?? "";
    return files[base];
  };
  return {
    realpath: (path) => options.realpaths?.[path] ?? path,
    readdir: (path) => {
      if (options.readdirError !== undefined) throw options.readdirError;
      assert.equal(path, DIRECTORY);
      return options.entries ?? [];
    },
    stat: (path) => ({ size: Buffer.byteLength(lookup(path) ?? "", "utf8") }),
    readFile: (path) => {
      const text = lookup(path);
      if (text === undefined) throw Object.assign(new Error("ENOENT: " + path), { code: "ENOENT" });
      return text;
    },
  };
}

test("discovery reads workflow text through the injected filesystem", () => {
  const fs = memoryFs({ "ci.yml": "on: pull_request\n" }, { entries: [entry("ci.yml", "file")] });
  const result = discoverWorkflows(ROOT, { fs });
  assert.equal(result.root, ROOT);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.workflows.length, 1);
  assert.equal(result.workflows[0]?.path, ".github/workflows/ci.yml");
  assert.equal(result.workflows[0]?.text, "on: pull_request\n");
  assert.equal(result.workflows[0]?.bytes, 17);
});

test("discovery applies the size cap before reading the file", () => {
  const fs = memoryFs({ "large.yml": "0123456789" }, { entries: [entry("large.yml", "file")] });
  const result = discoverWorkflows(ROOT, { fs, maxBytes: 9 });
  assert.equal(result.workflows.length, 0);
  assert.deepEqual(result.skipped.map((item) => item.reason), ["WORKFLOW_TOO_LARGE"]);
});

test("discovery rejects symlinks and files that resolve outside the root", () => {
  const absolute = join(DIRECTORY, "ci.yml");
  const fs = memoryFs({ "ci.yml": "on: push\n" }, {
    entries: [entry("ci.yml", "file"), entry("linked.yml", "link")],
    realpaths: { [absolute]: join(ROOT, "..", "outside", "ci.yml") },
  });
  const result = discoverWorkflows(ROOT, { fs });
  assert.equal(result.workflows.length, 0);
  assert.deepEqual(result.skipped.map((item) => item.reason), ["WORKFLOW_OUTSIDE_ROOT", "WORKFLOW_NOT_A_FILE"]);
});

for (const target of process.platform === "win32"
  ? ["D:\\outside\\ci.yml", "\\\\other-host\\share\\ci.yml"]
  : ["/outside/ci.yml"]) {
  test("discovery refuses external realpaths before stat or read: " + target, () => {
    const fs = memoryFs({ "ci.yml": "on: push\n" }, {
      entries: [entry("ci.yml", "file")],
      realpaths: { [join(DIRECTORY, "ci.yml")]: target },
    });
    let stats = 0;
    let reads = 0;
    const result = discoverWorkflows(ROOT, { fs: { ...fs,
      stat: path => { stats += 1; return fs.stat(path); },
      readFile: (path, encoding) => { reads += 1; return fs.readFile(path, encoding); },
    } });
    assert.equal(result.workflows.length, 0);
    assert.deepEqual(result.skipped, [{ path: ".github/workflows/ci.yml", reason: "WORKFLOW_OUTSIDE_ROOT" }]);
    assert.equal(stats, 0, "do not stat an external file");
    assert.equal(reads, 0, "do not read an external file");
  });
}

test("a static scan uses the same filesystem and command seams", () => {
  const fs = memoryFs({ "ci.yml": "on: pull_request\njobs: {}\n" }, { entries: [entry("ci.yml", "file")] });
  const result = runStaticScan({
    workspaceRoot: ROOT,
    generatedAt: "2026-10-20T00:00:00.000Z",
    fs,
    commandRunner: { run: () => ({ stdout: "git@github.com:owner/repo.git\n" }) },
  });
  assert.equal(result.binding.repositoryFullName, "owner/repo");
  assert.equal(result.workflows.length, 1);
  assert.equal(result.report.bindingId, result.binding.bindingId);
});

test("a missing workflows directory is empty and complete", () => {
  const error = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const result = discoverWorkflows(ROOT, { fs: memoryFs({}, { readdirError: error }) });
  assert.deepEqual(result.workflows, []);
  assert.deepEqual(result.skipped, []);
});
