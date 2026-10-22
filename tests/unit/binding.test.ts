import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readGithubRemote } from "../../src/core/scan/binding.ts";
import type { CommandRunOptions, CommandRunner } from "../../src/core/scan/binding.ts";

function runnerReturning(stdout: string): CommandRunner {
  return { run: () => ({ stdout, stderr: "" }) };
}

describe("readGithubRemote", () => {
  it("parses a GitHub origin through the command runner seam", () => {
    const root = process.cwd();
    const remote = readGithubRemote(root, {
      commandRunner: runnerReturning("git@github.com:0disoft/dsh-ci-diet.git\n"),
    });
    assert.deepEqual(remote, { owner: "0disoft", repository: "dsh-ci-diet", fullName: "0disoft/dsh-ci-diet" });
  });

  it("returns null when the origin is missing", () => {
    const failing: CommandRunner = {
      run() {
        throw new Error("No such remote: origin");
      },
    };
    assert.equal(readGithubRemote(process.cwd(), { commandRunner: failing }), null);
  });

  it("returns null for a remote that is not hosted on GitHub", () => {
    const remote = readGithubRemote(process.cwd(), {
      commandRunner: runnerReturning("https://gitlab.com/team/repo.git\n"),
    });
    assert.equal(remote, null);
  });

  it("asks the runner for an argv-only git command without a shell", () => {
    const calls: { argv: readonly string[]; options: CommandRunOptions }[] = [];
    const recording: CommandRunner = {
      run(argv, options) {
        calls.push({ argv, options });
        return { stdout: "https://github.com/0disoft/dsh-ci-diet\n", stderr: "" };
      },
    };
    const root = process.cwd();
    readGithubRemote(root, { commandRunner: recording });
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call);
    assert.deepEqual(call.argv, ["-C", root, "remote", "get-url", "origin"]);
    assert.equal(call.options.cwd, root);
    assert.equal(call.options.timeoutMs, 10_000);
    assert.equal("shell" in call.options, false);
  });
});
