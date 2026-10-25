import { homedir } from "node:os";
import { join } from "node:path";

/** Default local state root, shared by the CLI and the DSH plugin. */
export function defaultStateDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const local = env.LOCALAPPDATA;
  if (local !== undefined && local !== "") return join(local, "CI-Diet", "profiles", "default");
  return join(homedir(), ".local", "state", "ci-diet", "profiles", "default");
}
