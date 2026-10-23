import { resolve } from "node:path";
import { executeCli } from "../../src/cli/index.ts";
import { isolatedEnv } from "./test-env.ts";

/** Exercise production command handling without reloading Node/Ajv for every assertion. */
export async function runCli(args: readonly string[], cwd = resolve(import.meta.dirname, "../..")) {
  let stdout = "", stderr = "";
  const status = await executeCli(args, { cwd, env: isolatedEnv(),
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });
  return { status, stdout, stderr };
}
