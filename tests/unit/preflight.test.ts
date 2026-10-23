import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { PreToolDecision, ToolExecution } from "@deepseek-ai/dsh-tools";
import { deploymentDirectories, registerPreflight } from "../../src/dsh/host/preflight.ts";

test("preflight recognizes literal deployment commands and resolves explicit directory changes", () => {
  const cwd = resolve("repo");
  for (const command of ["git push origin main", "npm publish", "pnpm publish", "bun publish", "wrangler deploy", "npx wrangler deploy", "npm run deploy", "git add x && git commit -m 'fix' && git push"]) assert.deepEqual(deploymentDirectories(command, cwd), [cwd], command);
  assert.deepEqual(deploymentDirectories("cd 'my repo' && git push", cwd), [join(cwd, "my repo")]);
  assert.deepEqual(deploymentDirectories("git -C 'other repo' push", cwd), [join(cwd, "other repo")]);
  assert.deepEqual(deploymentDirectories("# git push\ngit status", cwd), []);
  for (const command of ["echo 'git push'", "git commit -m 'npm publish'", "git push --dry-run", "git push --help", "git --git-dir x push", "bash -c 'git push'", "node deploy.js", "cat <<EOF\ngit push\nEOF", "echo $(git push)", "cd missing; git push", "git checkout other && git push", "npm run build && git push"]) assert.deepEqual(deploymentDirectories(command, cwd), [], command);
});

function harness(root: string) {
  let enabled = true;
  let stateless = true;
  let listener!: (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>;
  const agent = { session: {} };
  const ctx = {
    on(_event: string, fn: typeof listener) { listener = fn; },
    get: () => ({ get: () => root }),
    tools: { get: () => ({ parameters: { properties: stateless ? { workdir: {} } : {} } }) },
  };
  registerPreflight(ctx as never, () => ({ enabled, rules: ["CD001", "CD006"], maxWorkflowBytes: 524288 }), () => "Review CI opportunities; retry this command to continue without changes.");
  return { agent, setEnabled: (value: boolean) => { enabled = value; }, setStateless: (value: boolean) => { stateless = value; },
    invoke: (args: Record<string, unknown>, prior: PreToolDecision = { kind: "allow" }, owner: object = agent) => listener({ name: "bash", arguments: args, agent: owner, signal: new AbortController().signal } as ToolExecution, async () => prior) };
}

test("deployment reminder is read-only, once per session/source and preserves other decisions", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true, stdio: "pipe", timeout: 5000 });
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  const file = join(root, ".github/workflows/pr.yml");
  const source = "on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n";
  writeFileSync(file, source);
  const host = harness(root);
  const args = { command: "git push origin main" };
  assert.deepEqual(await host.invoke(args, { kind: "deny", reason: "existing policy" }), { kind: "deny", reason: "existing policy" });
  assert.deepEqual(await host.invoke(args, { kind: "ask", reason: "existing approval" }), { kind: "ask", reason: "existing approval" });
  host.setStateless(false);
  assert.equal((await host.invoke(args)).kind, "allow");
  host.setStateless(true);
  host.setEnabled(false);
  assert.equal((await host.invoke(args)).kind, "allow");
  host.setEnabled(true);
  const first = await host.invoke(args);
  assert.equal(first.kind, "deny");
  if (first.kind === "deny") assert.match(first.reason, /CD001/);
  assert.equal(readFileSync(file, "utf8"), source);
  assert.equal((await host.invoke(args)).kind, "allow");
  assert.equal((await host.invoke(args, { kind: "allow" }, { session: {} })).kind, "deny");
  writeFileSync(file, source + "# changed\n");
  assert.equal((await host.invoke(args)).kind, "deny");
  writeFileSync(file, source + "concurrency: test\n");
  assert.equal((await host.invoke(args)).kind, "allow");
  assert.equal((await host.invoke({ command: "git push", workdir: join(root, "missing") })).kind, "allow");
});
