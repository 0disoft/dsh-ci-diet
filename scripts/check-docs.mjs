#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Public documentation guard.
//
// 1. Every relative link in a public markdown file must resolve on disk.
// 2. Public documentation is English; only the Korean README mirror may
//    contain Hangul.
// 3. Every specification file must be registered in the specification index,
//    and the index must link each of them.
// 4. Public documents must not point at excluded material (design packs,
//    review notes, prompts).

const root = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));

const KOREAN_ALLOWLIST = new Set(["README.ko.md"]);
const FORBIDDEN_TERMS = [
  { term: "docs/design", reason: "design packs stay outside the public repository" },
  { term: "_design/", reason: "local design archive must not leak into public docs" },
  { term: "docs/agents", reason: "internal agent notes are not shipped" },
];
const SPEC_INDEX = "docs/spec/README.md";
const SPEC_FILES = [
  "docs/spec/README.md",
  "docs/spec/rules.md",
  "docs/spec/cost-model.md",
  "docs/spec/patch-model.md",
  "docs/spec/storage.md",
  "docs/spec/decisions.md",
];

const failures = [];
const counts = { files: 0, links: 0, specEntries: 0, hangul: 0 };

function fail(file, line, message) {
  failures.push(`${file}:${line}: ${message}`);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function rel(path) {
  return relative(root, path).split(sep).join("/");
}

async function listMarkdown(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
    .sort();
}

function isExternal(target) {
  return /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target) || target.startsWith("//");
}

function stripFragment(target) {
  const hash = target.indexOf("#");
  return hash === -1 ? target : target.slice(0, hash);
}

const files = await listMarkdown(root);
const linkTargets = new Map();

for (const file of files) {
  const name = rel(file);
  const text = await readFile(file, "utf8");
  const lines = text.split(/\r?\n/);
  counts.files += 1;

  if (!KOREAN_ALLOWLIST.has(name) && /[\uac00-\ud7a3]/.test(text)) {
    counts.hangul += 1;
    fail(name, 1, "public documentation must be English (Hangul found)");
  }

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    for (const { term, reason } of FORBIDDEN_TERMS) {
      if (line.includes(term)) fail(name, lineNumber, `forbidden reference "${term}": ${reason}`);
    }

    const pattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    for (const match of line.matchAll(pattern)) {
      const raw = match[1];
      if (isExternal(raw)) continue;
      const target = stripFragment(raw);
      if (!target) continue;
      counts.links += 1;
      const resolved = normalize(join(dirname(file), target));
      const insideRoot = !rel(resolved).startsWith("..");
      if (!insideRoot) {
        fail(name, lineNumber, `link escapes the repository: ${raw}`);
        continue;
      }
      if (!(await exists(resolved))) {
        fail(name, lineNumber, `link target missing: ${raw}`);
      }
      if (!linkTargets.has(name)) linkTargets.set(name, new Set());
      linkTargets.get(name).add(normalize(target));
    }
  }
}

for (const spec of SPEC_FILES) {
  if (!(await exists(join(root, spec)))) fail(spec, 0, "expected specification file is missing");
}

const indexPath = join(root, SPEC_INDEX);
if (await exists(indexPath)) {
  const indexText = await readFile(indexPath, "utf8");
  const indexLinks = linkTargets.get(SPEC_INDEX) ?? new Set();
  for (const spec of SPEC_FILES) {
    if (spec === SPEC_INDEX) continue;
    const name = spec.slice("docs/spec/".length);
    if (!indexLinks.has(name)) fail(SPEC_INDEX, 0, `specification index does not link ${name}`);
    else counts.specEntries += 1;
    if (!indexText.includes(name)) fail(SPEC_INDEX, 0, `specification index does not name ${name}`);
  }
  if (!indexText.includes("## Document map")) fail(SPEC_INDEX, 0, "specification index must keep a Document map section");
}

const rootReadme = join(root, "README.md");
if (await exists(rootReadme)) {
  const readmeText = await readFile(rootReadme, "utf8");
  if (!readmeText.includes("docs/spec/README.md")) {
    fail("README.md", 0, "README must link the specification index");
  }
}

for (const failure of failures) console.error(`FAIL ${failure}`);
if (failures.length > 0) {
  console.error(`\ndocs check failed: ${failures.length} problem(s)`);
  process.exit(1);
}

console.log(
  `docs ok: ${counts.files} files, ${counts.links} links, ${counts.specEntries} spec entries, 0 hangul outside allowlist`,
);
