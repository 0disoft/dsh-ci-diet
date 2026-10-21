#!/usr/bin/env node
// Run the unit suite with an explicit file list.
//
// `node --test "tests/unit/*.test.ts"` exits 0 when the glob matches nothing,
// so a renamed or deleted test file could turn CI green while running zero
// tests. This wrapper fails loudly instead, and it covers nested directories.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = join(repoRoot, "tests", "unit");

const collect = (dir) => {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collect(full));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(full);
  }
  return files;
};

let files;
try {
  files = collect(testRoot)
    .map((file) => relative(repoRoot, file).split(sep).join("/"))
    .sort();
} catch (error) {
  console.error(`test:core: cannot read ${testRoot}: ${error.message}`);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`test:core: no *.test.ts files under ${testRoot}; refusing to report a passing run`);
  process.exit(1);
}

console.log(`test:core: running ${files.length} test files`);
const result = spawnSync(process.execPath, ["--test", ...files], { cwd: repoRoot, stdio: "inherit" });
if (result.error !== undefined) {
  console.error(`test:core: cannot start node --test: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
