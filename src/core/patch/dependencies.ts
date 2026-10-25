import { npmCacheDependencies, downloadCacheTargets } from "../rules/npm-cache.ts";
import { createHash } from "node:crypto";
import { existsSync, opendirSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { WorkflowDefinition, WorkflowJob, WorkflowStep } from "../workflow/model.ts";

/** Files a workflow runs from the repository, pinned by content hash. */
export interface DependencyRef {
  readonly ref: string;
  readonly sha256: string;
}

/** What the dependency scan could pin, and what it could not resolve. */
export interface DependencyCollection {
  readonly dependencies: readonly DependencyRef[];
  /** Repository paths the workflow names but the scan could not hash. */
  readonly unresolved: readonly string[];
}

const MAX_DEPENDENCY_BYTES = 2 * 1024 * 1024;
const MAX_ACTION_FILES = 500;
/** A local action directory is a dependency like any file: cap its total bytes. */
const MAX_ACTION_TOTAL_BYTES = 8 * 1024 * 1024;
const ACTION_SKIP_DIRS = new Set([".git", "node_modules"]);

/** Commands whose first non-flag argument is a script path. */
const INTERPRETERS = new Set([
  "node",
  "nodejs",
  "bun",
  "deno",
  "tsx",
  "ts-node",
  "python",
  "python3",
  "py",
  "sh",
  "bash",
  "zsh",
  "pwsh",
  "powershell",
  "ruby",
  "perl",
  "php",
]);

/** Interpreter flags that take a separate value token (a module, loader, or file). */
const FLAGS_WITH_VALUE = new Set([
  "-r",
  "--require",
  "--loader",
  "--experimental-loader",
  "--import",
  "--env-file",
  "-I",
  "-W",
  "-X",
]);

const MODULE_FLAGS = new Set(["-m", "--module"]);
const INLINE_FLAGS = new Set(["-e", "--eval", "-c", "-p", "--print"]);

/** Whether a flag value names a repository file rather than a package or literal. */
function flagValuePath(value: string): string | null {
  if (value === "" || value.includes("://")) return null;
  if (value.startsWith("./") || value.startsWith("../") || value.startsWith("/")) return value;
  if (value.startsWith("@")) return null;
  if (value.includes("/") || /\.[A-Za-z0-9]{1,6}$/.test(value)) return value;
  return null;
}
const SHELL_SOURCE_COMMANDS = new Set([".", "source"]);
const NPM_SCRIPT_COMMANDS = new Set(["run", "run-script", "test", "t", "tst", "start", "stop", "restart"]);
const NPM_SCRIPT_FLAGS = new Set(["--silent", "-s", "--if-present", "--ignore-scripts", "--foreground-scripts", "--json"]);
/** Reserved command heads need shell grammar, not the linear argv/cwd model. */
const SHELL_CONTROL_WORDS = new Set([
  "if", "then", "elif", "else", "fi", "for", "select", "while", "until",
  "do", "done", "case", "esac", "function", "{", "}", "!", "time",
]);

function toPosix(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/");
}

function normalizeBase(base: string): string | null {
  const text = base;
  if (text === "" || text === ".") return "";
  if (text.includes("${{")) return null;
  if (text.includes("://") || isAbsolute(text)) return null;
  const segments: string[] = [];
  for (const segment of text.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function joinRelative(base: string, candidate: string): string {
  if (base === "") return candidate;
  if (candidate.startsWith("/")) return candidate;
  return base + "/" + candidate;
}

function insideRoot(realRoot: string, real: string): boolean {
  return real === realRoot || real.startsWith(realRoot + sep);
}

function resolveFile(realRoot: string, base: string, candidate: string): string | null {
  if (candidate === "") return null;
  if (isAbsolute(candidate) || candidate.includes("://")) return null;
  const target = join(realRoot, base, candidate);
  if (!existsSync(target)) return null;
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    return null;
  }
  if (!insideRoot(realRoot, real)) return null;
  try {
    const info = statSync(real);
    if (!info.isFile() || info.size > MAX_DEPENDENCY_BYTES) return null;
  } catch {
    return null;
  }
  return real;
}

function resolveDirectory(realRoot: string, base: string, candidate: string): string | null {
  if (candidate === "" || isAbsolute(candidate) || candidate.includes("://")) return null;
  const target = join(realRoot, base, candidate);
  if (!existsSync(target)) return null;
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    return null;
  }
  if (!insideRoot(realRoot, real)) return null;
  try {
    if (!statSync(real).isDirectory()) return null;
  } catch {
    return null;
  }
  return real;
}

/** Hash the bytes on disk, not their UTF-8 decoding: binary files must not collide. */
function hashFile(realPath: string): string | null {
  try {
    return "sha256:" + createHash("sha256").update(readFileSync(realPath)).digest("hex");
  } catch {
    return null;
  }
}

/** Static shell words: delimiters inside quotes belong to the same argument.
 * Ambiguous words and unsupported cwd isolation must never pin a decoy file.
 */
function commandSegments(run: string): string[][] | null {
  const segments: string[][] = [];
  let words: string[] = [], word = "";
  let quote: string | null = null;
  let started = false, closedQuote = false;
  let isolatedCommands = false;
  let conditionalCommand = false, chainHasCd = false, chainHasFallback = false;
  let conditionalCwd = false, ambiguousCwd = false;
  const finishWord = (): void => {
    // Literal assignments before the command are environment, not argv[0].
    // Keep quoted assignment-looking words and arguments after the command:
    // they are ordinary shell words, not prefixes to strip.
    const assignment = words.length === 0 && !closedQuote && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
    if (started && !assignment) words.push(word);
    word = "";
    started = false;
    closedQuote = false;
  };
  const finishCommand = (): boolean => {
    finishWord();
    const complete = words.length > 0;
    if (complete) {
      // Pure && chains may follow cd linearly: a later command runs only if
      // every preceding command succeeded. An unconditional continuation cannot.
      if (conditionalCwd && !conditionalCommand) ambiguousCwd = true;
      if (words[0] === "cd") {
        if (chainHasFallback) ambiguousCwd = true;
        if (conditionalCommand) conditionalCwd = true;
        chainHasCd = true;
      }
      segments.push(words);
    }
    words = [];
    return complete;
  };
  for (let i = 0; i < run.length; i += 1) {
    const char = run[i]!;
    if (quote !== null) {
      if (char === quote) { quote = null; closedQuote = true; }
      else if (char === "\\" || char === "`" || (quote === '"' && char === "$")) return null;
      else word += char;
      continue;
    }
    // Grouped commands need a shell AST; never treat their cwd as linear.
    if (char === "(" || char === ")") return null;
    if (char === "|" || char === "&") {
      const logical = run[i + 1] === char;
      if (logical) i += 1;
      else isolatedCommands = true; // Pipelines/background jobs may isolate cd.
      finishCommand();
      // A conditional cd may not run. A fallback after cd may run in either
      // directory. Neither case has a single statically provable cwd.
      if (logical && char === "|") {
        chainHasFallback = true;
        if (chainHasCd) ambiguousCwd = true;
      }
      conditionalCommand = logical;
      continue;
    }
    if (char === "\n" || char === ";") {
      // A newline/comment after && or || continues its pending command.
      if (finishCommand() || char === ";") {
        conditionalCommand = false; chainHasCd = false; chainHasFallback = false;
      }
      continue;
    }
    if (/\s/.test(char)) { finishWord(); continue; }
    if (char === "#" && !started) {
      while (i + 1 < run.length && run[i + 1] !== "\n") i += 1;
      continue;
    }
    if (closedQuote || char === "\\" || char === "`" || char === "$") return null;
    if (char === '"' || char === "'") {
      if (started) return null;
      quote = char;
      started = true;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote !== null) return null;
  finishCommand();
  // Never return a complete-looking subset when a reserved word hides the
  // actual executable (e.g. `then node build.js`) or branches the cwd.
  if (segments.some((words) => SHELL_CONTROL_WORDS.has(words[0] ?? ""))) return null;
  if (ambiguousCwd) return null;
  if (isolatedCommands && segments.some((words) => words[0] === "cd")) return null;
  return segments;
}

function baseName(token: string): string {
  const normalized = token.split("/").pop() ?? token;
  return normalized.replace(/\.(exe|cmd|bat)$/i, "");
}

function stepBase(
  workflow: WorkflowDefinition,
  job: WorkflowJob,
  step: WorkflowStep,
): string | null {
  const declared = step.otherEntries.find((entry) => entry.key === "working-directory");
  if (declared !== undefined) {
    if (declared.kind !== "literal" || declared.literal === null) return null;
    return normalizeBase(declared.literal);
  }
  const raw = job.defaultWorkingDirectory ?? workflow.defaultWorkingDirectory ?? "";
  return normalizeBase(raw);
}

interface DependencySink {
  /** True when the named file resolved inside the workspace; callers use it instead of resolving twice. */
  add(base: string, candidate: string): boolean;
  miss(base: string, candidate: string): void;
  unresolved(message: string): void;
  addActionDirectory(base: string, candidate: string): void;
  result(): DependencyCollection;
}

/** One extra entry distinguishes a full budget from a truncated listing. */
function actionEntries(directory: string, remaining: number): Dirent[] {
  const handle = opendirSync(directory, { bufferSize: Math.min(32, remaining + 1) });
  try {
    const entries: Dirent[] = [];
    while (entries.length <= remaining) {
      const entry = handle.readSync();
      if (entry === null) break;
      entries.push(entry);
    }
    return entries;
  } finally {
    handle.closeSync();
  }
}

function createDependencySink(realRoot: string): DependencySink {
  const found = new Map<string, string>();
  const unresolved = new Set<string>();
  const scannedActions = new Set<string>();
  const add = (base: string, candidate: string): boolean => {
    const real = resolveFile(realRoot, base, candidate);
    if (real === null) return false;
    const relativePath = toPosix(relative(realRoot, real));
    if (relativePath === "" || relativePath.startsWith("..")) return false;
    if (found.has(relativePath)) return true;
    const hash = hashFile(real);
    if (hash === null) return false;
    found.set(relativePath, hash);
    return true;
  };
  const miss = (base: string, candidate: string): void => {
    const display = joinRelative(base, candidate);
    unresolved.add(display.startsWith("./") ? display.slice(2) : display);
  };
  const addActionDirectory = (base: string, candidate: string): void => {
    const dir = resolveDirectory(realRoot, base, candidate);
    if (dir === null) {
      miss(base, candidate);
      return;
    }
    // The sink lasts for one collection. Reuse both pinned files and unresolved
    // results for aliases of an action already scanned in this collection.
    if (scannedActions.has(dir)) return;
    scannedActions.add(dir);
    const dirDisplay = toPosix(relative(realRoot, dir)) || ".";
    const stack: string[] = [dir];
    let collected = 0;
    let visited = 0;
    let totalBytes = 0;
    let truncated = false;
    let byteLimit = false;
    walk: while (stack.length > 0) {
      if (visited >= MAX_ACTION_FILES) {
        truncated = true;
        break;
      }
      const current = stack.pop() as string;
      let entries;
      try {
        // Bound enumeration itself, not only hashing after a full allocation.
        entries = actionEntries(current, MAX_ACTION_FILES - visited);
      } catch {
        unresolved.add(toPosix(relative(realRoot, current)) + " (unreadable directory)");
        continue;
      }
      for (const entry of entries) {
        if (visited >= MAX_ACTION_FILES) {
          truncated = true;
          break walk;
        }
        visited += 1;
        // Dirent classifies links separately from files/directories. Silently
        // skipping one would leave its executable target outside the approval
        // hash. Keep it unresolved until bounded link traversal is supported.
        if (entry.isSymbolicLink()) {
          unresolved.add(toPosix(relative(realRoot, join(current, entry.name))) + " (symbolic link)");
          continue;
        }
        if (entry.isDirectory()) {
          if (!ACTION_SKIP_DIRS.has(entry.name)) stack.push(join(current, entry.name));
          continue;
        }
        if (!entry.isFile()) continue;
        const real = join(current, entry.name);
        const relativePath = toPosix(relative(realRoot, real));
        if (found.has(relativePath)) {
          // A script or another action may already have pinned this file.
          collected += 1;
          continue;
        }
        let size: number;
        try {
          size = statSync(real).size;
        } catch {
          unresolved.add(relativePath + " (unreadable file)");
          continue;
        }
        // The same per-file cap as a script: an action must not smuggle in a
        // blob the user never reviewed.
        if (size > MAX_DEPENDENCY_BYTES) {
          unresolved.add(relativePath + " (file too large)");
          continue;
        }
        if (totalBytes + size > MAX_ACTION_TOTAL_BYTES) {
          byteLimit = true;
          break walk;
        }
        const hash = hashFile(real);
        if (hash === null) {
          unresolved.add(relativePath + " (unreadable file)");
          continue;
        }
        found.set(relativePath, hash);
        totalBytes += size;
        collected += 1;
      }
    }
    if (truncated) unresolved.add(dirDisplay + " (file limit reached)");
    if (byteLimit) unresolved.add(dirDisplay + " (byte limit reached)");
    if (collected === 0) unresolved.add(dirDisplay);
  };
  return {
    add,
    miss,
    unresolved: (message: string) => unresolved.add(message),
    addActionDirectory,
    result: () => ({
      dependencies: [...found.entries()]
        .map(([ref, sha256]) => ({ ref, sha256 }))
        .sort((left, right) => (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0)),
      unresolved: [...unresolved].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    }),
  };
}

/** Record the files a script segment names, and the ones it cannot resolve. */
function collectRunSegment(
  realRoot: string,
  sink: DependencySink,
  base: string,
  segment: readonly string[],
): void {
  const add = sink.add;
  const miss = sink.miss;
  const head = segment[0] ?? "";
  if (head === "cd" && segment[1] !== undefined) return;
  if (head.startsWith("./") || head.startsWith("../")) {
    if (!add(base, head)) miss(base, head);
    return;
  }
  if (SHELL_SOURCE_COMMANDS.has(head)) {
    const script = segment[1];
    if (script !== undefined && !add(base, script)) miss(base, script);
    return;
  }
  if (baseName(head) === "bun" && segment[1] === "install" && segment.length === 3 && segment[2] === "--frozen-lockfile") {
    for (const ref of ["package.json", "bun.lock"]) if (!add(base, ref)) miss(base, ref);
    return;
  }
  if (baseName(head) === "bun" && ["run", "test"].includes(segment[1] ?? "")) {
    collectRunSegment(realRoot, sink, base, ["npm", ...segment.slice(1)]);
    return;
  }
  if (baseName(head) === "npm") {
    const separator = segment.indexOf("--");
    const args = segment.slice(1, separator < 0 ? undefined : separator);
    if (args.some((arg) => NPM_SCRIPT_COMMANDS.has(arg))) {
      // Prefix/workspace selection needs npm's configuration resolver. Never
      // fingerprint a convenient package in the original cwd instead.
      if (args.some((arg) => arg.startsWith("-") && !NPM_SCRIPT_FLAGS.has(arg))) {
        sink.unresolved("npm (unsupported script options)");
        return;
      }
      // npm can find a package above the step cwd; parent manifests can also
      // control workspace membership. Pin each existing ancestor, bounded by
      // the repository root. Keep the ordinary argument collection below.
      let directory = base;
      for (;;) {
        if (existsSync(join(realRoot, directory, "package.json")) && !add(directory, "package.json")) {
          miss(directory, "package.json");
        }
        if (directory === "") break;
        const slash = directory.lastIndexOf("/");
        directory = slash < 0 ? "" : directory.slice(0, slash);
      }
    }
  }
  const interpreter = INTERPRETERS.has(baseName(head)) ? baseName(head) : null;
  if (interpreter === null) {
    for (const token of segment) {
      if (token.includes("/")) add(base, token);
    }
    return;
  }
  const flagValue = (value: string): void => {
    const target = flagValuePath(value);
    if (target === null) return;
    const resolved = add(base, target);
    if (!resolved && (target.startsWith("./") || target.startsWith("../") || target.startsWith("/"))) miss(base, target);
  };
  let index = 1;
  let moduleMode = false;
  let inline = false;
  while (index < segment.length) {
    const token = segment[index] as string;
    if (INLINE_FLAGS.has(token)) {
      inline = true;
      break;
    }
    if (MODULE_FLAGS.has(token)) {
      moduleMode = true;
      index += 1;
      break;
    }
    const equals = token.startsWith("--") ? token.indexOf("=") : -1;
    if (equals > 2) {
      const name = token.slice(0, equals);
      if (FLAGS_WITH_VALUE.has(name)) flagValue(token.slice(equals + 1));
      index += 1;
      continue;
    }
    if (FLAGS_WITH_VALUE.has(token)) {
      const value = segment[index + 1];
      if (value !== undefined) flagValue(value);
      index += 2;
      continue;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  if (inline || moduleMode) {
    for (let extra = index; extra < segment.length; extra += 1) {
      const token = segment[extra] as string;
      if (token.includes("/")) add(base, token);
    }
    return;
  }
  const script = segment[index];
  if (script === undefined) return;
  if (!add(base, script)) miss(base, script);
  for (let extra = index + 1; extra < segment.length; extra += 1) {
    const token = segment[extra] as string;
    if (token.includes("/")) add(base, token);
  }
}

/** Walk the shell commands one step runs, following `cd` and interpreter flags. */
function collectRunScript(
  realRoot: string,
  sink: DependencySink,
  workflow: WorkflowDefinition,
  job: WorkflowJob,
  step: WorkflowStep,
): void {
  if (step.run === null) return;
  const base = stepBase(workflow, job, step);
  if (base === null) {
    sink.unresolved("jobs." + job.key + ".steps[" + step.index + "] (dynamic working-directory)");
    return;
  }
  if (step.run.includes("${{")) {
    sink.unresolved("jobs." + job.key + ".steps[" + step.index + "] (dynamic run script)");
    return;
  }
  const segments = commandSegments(step.run);
  if (segments === null) {
    sink.unresolved("jobs." + job.key + ".steps[" + step.index + "] (unsupported shell syntax)");
    return;
  }
  let working = base;
  for (const segment of segments) {
    const head = segment[0] ?? "";
    if (head === "cd") {
      const args = segment.slice(1);
      if (args[0] === "--") args.shift();
      const target = args.length === 1 ? args[0] : undefined;
      const next = target === undefined || target.startsWith("-") || /^~|[$`\\]/.test(target)
        ? null : normalizeBase(joinRelative(working, target));
      if (next === null) {
        // Never hash a same-named file in the old directory after losing cwd.
        // Apply treats any unresolved dependency as a reason to reject approval.
        sink.unresolved("jobs." + job.key + ".steps[" + step.index + "] (unresolved cd working-directory)");
        return;
      }
      working = next;
      continue;
    }
    collectRunSegment(realRoot, sink, working, segment);
  }
}

/** Pin every repository file the workflow runs from, or explain what was missed. */
export function collectDependencies(
  workspaceRoot: string,
  workflow: WorkflowDefinition,
): DependencyCollection {
  let realRoot: string;
  try {
    realRoot = realpathSync(workspaceRoot);
  } catch {
    return { dependencies: [], unresolved: ["<workspace>"] };
  }
  const sink = createDependencySink(realRoot);
  for (const target of downloadCacheTargets(workflow, realRoot)) {
    const manifests = npmCacheDependencies(realRoot, target);
    if (manifests === null) sink.unresolved("cache manifest or lockfile missing");
    else for (const manifest of manifests) { if (!sink.add("", manifest.ref)) sink.miss("", manifest.ref); }
  }
  for (const job of workflow.jobs) {
    for (const step of job.steps) {
      if (step.uses !== null && step.uses.startsWith("./")) {
        // Local actions resolve from the repository root, not the step working directory.
        sink.addActionDirectory("", step.uses.slice(2));
      }
      collectRunScript(realRoot, sink, workflow, job, step);
    }
  }
  return sink.result();
}
