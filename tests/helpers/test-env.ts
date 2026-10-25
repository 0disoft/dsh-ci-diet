import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const localState = mkdtempSync(join(tmpdir(), "ci-diet-test-state-"));
process.once("exit", () => {
  const target = resolve(localState);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("ci-diet-test-state-")) return;
  rmSync(target, { recursive: true, force: true });
});

/** Environment for CLI tests: English output, insulated from the host DSH profile. */
export function isolatedEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    LOCALAPPDATA: localState,
    ...extra
  };
  delete env.DSH_PROFILE_DIR;
  delete env.DSH_PROFILE;
  delete env.DSH_HOME;
  delete env.LC_MESSAGES;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
  }
  return env;
}
