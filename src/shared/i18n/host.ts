import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { resolveLocale, resolveLocaleFromEnv, type Locale } from "./index.ts";

/**
 * Locale selection order, used by both the CLI and the DSH host:
 * an explicit --lang, then the DSH locale preference, then the usual Unix
 * locale variables, then English. An explicit but unsupported --lang falls
 * back to English instead of to a host preference.
 */
export function resolveRequestedLocale(
  explicit: string | null | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env
): Locale {
  if (typeof explicit === "string" && explicit.trim() !== "") return resolveLocale(explicit);
  const host = readDshLocalePreference(env);
  if (host !== null) return resolveLocale(host);
  return resolveLocaleFromEnv(env);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readYaml(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Find a locale namespace object with a string preference anywhere in a document. */
function findLocalePreference(node: unknown, depth = 0): string | null {
  if (depth > 8) return null;
  const record = asRecord(node);
  if (record === null) {
    if (Array.isArray(node)) {
      for (const entry of node) {
        const found = findLocalePreference(entry, depth + 1);
        if (found !== null) return found;
      }
    }
    return null;
  }
  const locale = asRecord(record.locale);
  if (locale !== null && typeof locale.preference === "string" && locale.preference.trim() !== "") {
    return locale.preference;
  }
  const settings = asRecord(record.settings);
  if (settings !== null) {
    const found = findLocalePreference(settings, depth + 1);
    if (found !== null) return found;
  }
  for (const value of Object.values(record)) {
    const found = findLocalePreference(value, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/** Find a patch entry for the locale plugin and return its configured preference. */
function findPatchPreference(node: unknown, depth = 0): string | null {
  if (depth > 8) return null;
  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = findPatchPreference(entry, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  const record = asRecord(node);
  if (record === null) return null;
  const id = typeof record.id === "string" ? record.id : "";
  const name = typeof record.name === "string" ? record.name : "";
  const isLocalePlugin = id === "locale" || name === "@deepseek-ai/dsh-client-locale" || name.endsWith("/dsh-client-locale");
  const config = asRecord(record.config);
  if (isLocalePlugin && config !== null && typeof config.preference === "string" && config.preference.trim() !== "") {
    return config.preference;
  }
  for (const value of Object.values(record)) {
    const found = findPatchPreference(value, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Read the DSH locale preference without importing a browser-only locale
 * service. DSH stores the locale plugin config in the profile patch; the
 * settings file is checked as a second, smaller surface.
 */
export function readDshLocalePreference(
  env: Readonly<Record<string, string | undefined>> = process.env
): string | null {
  const dirs: string[] = [];
  if (env.DSH_PROFILE_DIR) dirs.push(env.DSH_PROFILE_DIR);
  if (env.DSH_HOME && env.DSH_PROFILE) dirs.push(join(env.DSH_HOME, "profiles", env.DSH_PROFILE));
  for (const dir of dirs) {
    const found = findPatchPreference(readYaml(join(dir, "cordis.patch.yml")));
    if (found !== null) return found;
  }
  if (env.DSH_HOME) {
    const found = findLocalePreference(readYaml(join(env.DSH_HOME, "settings.yaml")));
    if (found !== null) return found;
  }
  return null;
}
