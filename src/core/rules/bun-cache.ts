import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { ByteEdit } from "../contracts/schema.ts";
import type { WorkflowDefinition } from "../workflow/model.ts";
import { directoryOf, npmCacheDependencies, type NpmCacheTarget } from "./npm-cache.ts";

/** Hosted runners and default Bun cache only. Custom configuration stays review-only. */
export function bunCacheTargets(workflow: WorkflowDefinition, root?: string, text?: string): NpmCacheTarget[] {
  if (workflow.parseError !== null || workflow.unsupported.length) return [];
  try {
    const raw = parse(text ?? readFileSync(join(root!, workflow.path), "utf8"));
    if (raw.env !== undefined) return [];
    return workflow.jobs.flatMap((job): NpmCacheTarget[] => {
      const config = raw.jobs[job.key];
      if (!/^(ubuntu|windows|macos)-(latest|[0-9.]+)$/.test(job.runsOn ?? "") || config.env !== undefined || config.container !== undefined
        || job.steps.some((s) => /cache/i.test(s.uses ?? "") || s.uses?.startsWith("./"))) return [];
      const setups = job.steps.filter((s) => /^oven-sh\/setup-bun@v2(?:\.\d+){0,2}$/.test(s.uses ?? ""));
      const installs = job.steps.filter((s) => s.run?.trim() === "bun install --frozen-lockfile");
      const step = setups[0], install = installs[0];
      const checkout = job.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
      if (setups.length !== 1 || installs.length !== 1 || !step || !install || !checkout || checkout.index >= step.index || step.index >= install.index
        || checkout.withEntries.some((e) => e.key !== "fetch-depth") || checkout.otherEntries.some((e) => e.key !== "id")
        || step.flow || step.otherEntries.some((e) => e.key !== "id") || step.range === null || step.usesRange === null
        || install.otherEntries.some((e) => !["id", "working-directory"].includes(e.key))
        || job.steps.slice(checkout.index + 1, install.index).some((s) => s !== step && !(/^actions\/setup-node@v[3-7]$/.test(s.uses ?? "")
          && s.otherEntries.length === 0 && s.withEntries.every((e) => e.key === "node-version")))) return [];
      const directory = directoryOf(workflow, job, install);
      if (directory === null) return [];
      const prefix = directory === "." ? "" : directory + "/";
      if (root !== undefined && ["bunfig.toml", prefix + "bunfig.toml", prefix + "bun.lockb"].some((f) => existsSync(join(root, f)))) return [];
      const target: NpmCacheTarget = { job, step, directory, manager: "bun", lockfile: prefix + "bun.lock" };
      return root !== undefined && npmCacheDependencies(root, target) === null ? [] : [target];
    });
  } catch { return []; }
}

/** One canonical byte edit adds a setup output ID (when needed) and a cache step. */
export function bunCacheEdit(text: string, target: NpmCacheTarget): ByteEdit | null {
  const { step, job, lockfile } = target;
  if (step.usesRange === null || step.range === null) return null;
  const bytes = Buffer.from(text), nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lineStart = (offset: number) => bytes.lastIndexOf(10, Math.max(0, offset - 1)) + 1;
  let start = bytes.indexOf(10, step.usesRange.endByte);
  if (start < 0) return null;
  start += 1;
  const next = job.steps[step.index + 1];
  if (next?.range === null || next?.range === undefined) return null;
  const end = lineStart(next.range.startByte);
  const setupLine = bytes.subarray(lineStart(step.usesRange.startByte), step.usesRange.startByte).toString();
  const indent = " ".repeat((/^ */.exec(setupLine)?.[0].length ?? 0) + (setupLine.includes("-") ? 2 : 0));
  const existing = step.otherEntries.find((e) => e.key === "id");
  let id = existing?.literal ?? "ci_diet_bun";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) return null;
  if (!existing) while (job.steps.some((s) => s.otherEntries.some((e) => e.key === "id" && e.literal === id))) id += "_";
  const cache = [indent.slice(2) + "- name: Cache Bun downloads", indent + "uses: actions/cache@v4", indent + "with:",
    indent + "  path: ~/.bun/install/cache",
    indent + "  key: ci-diet-bun-${{ runner.os }}-${{ runner.arch }}-${{ steps." + id + ".outputs.bun-version }}-${{ hashFiles('" + lockfile + "') }}", ""].join(nl);
  return { kind: "insertMapping", ruleId: "CD006", startByte: start, endByte: end,
    replacementUtf8: (existing ? "" : indent + "id: " + id + nl) + bytes.subarray(start, end).toString("utf8") + cache,
    semanticPath: "jobs." + job.key + ".steps[" + step.index + "].bun-cache" };
}

/** Never allow arbitrary steps or inputs through the cache insertion path. */
export function bunCacheResultValid(original: WorkflowDefinition, text: string, result: string, edit: ByteEdit): boolean {
  const target = bunCacheTargets(original, undefined, text).find((t) => edit.semanticPath === "jobs." + t.job.key + ".steps[" + t.step.index + "].bun-cache");
  const expected = target === undefined ? null : bunCacheEdit(text, target);
  if (expected === null || (Object.keys(expected) as (keyof ByteEdit)[]).some((key) => expected[key] !== edit[key])) return false;
  const bytes = Buffer.from(text);
  return Buffer.concat([bytes.subarray(0, edit.startByte), Buffer.from(edit.replacementUtf8), bytes.subarray(edit.endByte)]).toString("utf8") === result;
}
