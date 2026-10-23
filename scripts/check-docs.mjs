#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Public documentation guard.
//
// 1. Every relative link in a public markdown file must resolve on disk.
// 2. Detailed documentation is English; the six READMEs are localized.
//    Their language links and executable examples must stay in sync.
// 3. Every specification file must be registered in the specification index,
//    and the index must link each of them.
// 4. Public documents must not point at excluded material (design packs,
//    review notes, prompts).

const root = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));

const READMES = ["README.md", "README.ko.md", "README.zh-Hans.md", "README.hi.md", "README.es.md", "README.fr.md"];
const LOCALIZED_READMES = new Set(READMES);
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

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".tmp", ".review-bundles"]);

async function listMarkdown(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) files.push(...await listMarkdown(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files.sort();
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

  if (!LOCALIZED_READMES.has(name) && /[\uac00-\ud7a3]/.test(text)) {
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
  // Commands, flags, versions, and paths must not drift between translations.
  // Keep explanatory prose outside fences so it can be translated freely.
  const fencedExamples = (text) => [...text.replaceAll("\r\n", "\n").matchAll(/^```[^\n]*\n([\s\S]*?)^```\s*$/gm)]
    .map((match) => match[1].trim());
  const sourceExamples = fencedExamples(readmeText);
  for (const name of READMES) {
    if (!(await exists(join(root, name)))) {
      fail(name, 0, "expected localized README is missing");
      continue;
    }
    const text = await readFile(join(root, name), "utf8");
    const top = text.split(/\r?\n/).slice(0, 8).join("\n");
    for (const target of READMES) {
      if (!top.includes(`](${target})`)) fail(name, 1, `language navigation must link ${target} near the title`);
    }
    if (JSON.stringify(fencedExamples(text)) !== JSON.stringify(sourceExamples)) {
      fail(name, 0, "fenced examples differ from README.md; keep commands and paths identical");
    }
    if (!(linkTargets.get(name)?.has(normalize("docs/spec/README.md")))) {
      fail(name, 0, "README must link the English specification index");
    }
  }
} else {
  fail("README.md", 0, "source README is missing");
}

for (const failure of failures) console.error(`FAIL ${failure}`);
if (failures.length > 0) {
  console.error(`\ndocs check failed: ${failures.length} problem(s)`);
  process.exit(1);
}

console.log(
  `docs ok: ${counts.files} files, ${counts.links} links, ${counts.specEntries} spec entries, ${READMES.length} READMEs with matching examples, 0 hangul outside allowlist`,
);
