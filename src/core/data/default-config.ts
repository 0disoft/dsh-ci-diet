import { DEFAULT_CONFIG_JSON } from "./contracts.generated.ts";
import { assertValidDocument } from "../contracts/validate.ts";
import type { Config } from "../contracts/schema.ts";

/**
 * Defaults fixed by `examples/default-config.json` (ADR-03).
 *
 * The JSON file is the authority; this module only parses and freezes it. A
 * change to the numbers is a user-visible behaviour change and needs an ADR.
 */
export const DEFAULT_CONFIG: Config = JSON.parse(DEFAULT_CONFIG_JSON) as Config;

assertValidDocument("Config", DEFAULT_CONFIG);

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

freeze(DEFAULT_CONFIG);
