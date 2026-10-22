import { readFileSync } from "node:fs";
import { assertValidDocument } from "../contracts/validate.ts";
import type { Config } from "../contracts/schema.ts";
import { DEFAULT_CONFIG } from "../data/default-config.ts";

/** A configuration file that could not be read, parsed, or validated. */
export class ConfigFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigFileError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Overlay a partial configuration on the defaults. Objects merge recursively;
 * arrays and scalars replace. The result is validated as a complete Config, so
 * an unknown or out-of-range key still fails before anything runs.
 */
export function mergeConfig(base: Config, override: unknown): Config {
  if (!isRecord(override)) throw new ConfigFileError("CONFIG_INVALID: the configuration must be a JSON object");
  const merged = structuredClone(base) as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    merged[key] = isRecord(current) && isRecord(value) ? mergeRecord(current, value) : value;
  }
  return merged as unknown as Config;
}

function mergeRecord(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    merged[key] = isRecord(current) && isRecord(value) ? mergeRecord(current, value) : value;
  }
  return merged;
}

/** Load a partial Config file and merge it over the shipped defaults. */
export function loadConfigFile(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigFileError("CONFIG_UNREADABLE: " + path + ": " + (error instanceof Error ? error.message : String(error)));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigFileError("CONFIG_INVALID: " + path + ": " + (error instanceof Error ? error.message : String(error)));
  }
  const merged = mergeConfig(DEFAULT_CONFIG, parsed);
  try {
    assertValidDocument("Config", merged);
  } catch (error) {
    throw new ConfigFileError("CONFIG_INVALID: " + path + ": " + (error instanceof Error ? error.message : String(error)));
  }
  return merged;
}
