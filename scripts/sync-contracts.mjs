#!/usr/bin/env node
// Compare the contracts and examples in this repository with the frozen
// design pack. Localized prose is compared structurally; everything else
// must match exactly.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const packArg = argv.find((value) => value.startsWith("--pack="));
const packRoot = resolve(
  packArg
    ? packArg.slice("--pack=".length)
    : process.env.CI_DIET_DESIGN_PACK ??
      join(repoRoot, "..", "..", "..", "..", "_design", "ci-diet", "v0.2.1", "ci-diet-design-v0.2.1")
);

// Pointers whose string value is localized prose. Everything else is exact.
const LOCALIZED = new Map([
  ["contracts/coverage-policy.json", ["/levels/full", "/levels/subset", "/levels/degrade", "/levels/skip"]],
  ["examples/finding-evaluation.json", ["/reason"]],
  ["examples/partial-progress.json", ["/budget/wireRequestCount/reason"]]
]);

// Translated markdown: compare existence and parseability only.
const PROSE_ONLY = new Set(["examples/README.md"]);

// Files that exist only in this repository.
const REPO_ONLY = new Set(["contracts/UPSTREAM.md"]);

const errors = [];
const listFiles = (dir, prefix) => {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = prefix + "/" + name;
    if (statSync(full).isDirectory()) out.push(...listFiles(full, rel));
    else out.push(rel);
  }
  return out.sort();
};

const dig = (rel, side) => {
  const base = side === "repo" ? repoRoot : packRoot;
  return readFileSync(join(base, ...rel.split("/")));
};

const dropPointer = (root, pointer) => {
  const parts = pointer.split("/").slice(1);
  let node = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    node = node?.[parts[i]];
    if (node === undefined || node === null) return false;
  }
  const last = parts[parts.length - 1];
  if (node === null || typeof node !== "object" || !(last in node)) return false;
  delete node[last];
  return true;
};

const diff = (left, right, path, out) => {
  if (out.length >= 20) return;
  if (left === right) return;
  const isObject = (value) => value !== null && typeof value === "object";
  if (!isObject(left) || !isObject(right) || Array.isArray(left) !== Array.isArray(right)) {
    out.push(path + ": " + JSON.stringify(left) + " != " + JSON.stringify(right));
    return;
  }
  if (Array.isArray(left)) {
    if (left.length !== right.length) {
      out.push(path + ": array length " + left.length + " != " + right.length);
      return;
    }
    for (let i = 0; i < left.length; i += 1) diff(left[i], right[i], path + "/" + i, out);
    return;
  }
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (!(key in left) || !(key in right)) {
      out.push(path + "/" + key + ": missing on one side");
      continue;
    }
    diff(left[key], right[key], path + "/" + key, out);
  }
};

const compareTree = (area) => {
  const repoFiles = listFiles(join(repoRoot, area), area).filter((rel) => !REPO_ONLY.has(rel));
  const packFiles = listFiles(join(packRoot, area), area);
  let compared = 0;
  for (const rel of packFiles) {
    if (!repoFiles.includes(rel)) {
      errors.push(rel + ": missing in this repository");
      continue;
    }
  }
  for (const rel of repoFiles) {
    if (!packFiles.includes(rel)) {
      errors.push(rel + ": not present in the design pack");
      continue;
    }
    compared += 1;
    if (PROSE_ONLY.has(rel)) continue;
    const repoBytes = dig(rel, "repo");
    const packBytes = dig(rel, "pack");
    if (rel.endsWith(".json") && LOCALIZED.has(rel)) {
      const repoCopy = JSON.parse(repoBytes.toString("utf8"));
      const packCopy = JSON.parse(packBytes.toString("utf8"));
      for (const pointer of LOCALIZED.get(rel)) {
        if (!dropPointer(repoCopy, pointer)) errors.push(rel + pointer + ": localized pointer missing in this repository");
        if (!dropPointer(packCopy, pointer)) errors.push(rel + pointer + ": localized pointer missing in the design pack");
      }
      const drift = [];
      diff(repoCopy, packCopy, rel, drift);
      errors.push(...drift);
      continue;
    }
    if (!repoBytes.equals(packBytes)) {
      errors.push(rel + ": bytes changed; localize it explicitly or restore the pack copy");
    }
  }
  return compared;
};

const count = compareTree("contracts") + compareTree("examples");
if (errors.length > 0) {
  console.error("contract drift: " + errors.length + " problem(s)");
  for (const line of errors) console.error("  " + line);
  process.exitCode = 1;
} else {
  console.log("contracts match the frozen pack (" + count + " files, " + LOCALIZED.size + " localized files)");
}
