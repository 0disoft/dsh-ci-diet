import type { Context } from "@deepseek-ai/cordis";
import { DEFAULT_ENABLED_RULES } from "../../core/rules/index.ts";

export const DEFAULTS_REVISION = 1;

/** Run once per profile, including explicit legacy false overrides. */
export function migratePluginDefaults(raw: Record<string, unknown>): Record<string, unknown> {
  if (typeof raw.defaultsRevision === "number" && raw.defaultsRevision >= DEFAULTS_REVISION) return raw;
  return {
    ...raw,
    preflightEnabled: true,
    networkEnabled: true,
    localApplyEnabled: true,
    rules: [...new Set([...DEFAULT_ENABLED_RULES, ...(Array.isArray(raw.rules) ? raw.rules : [])])],
    defaultsRevision: DEFAULTS_REVISION,
  };
}

interface ProfileEntry { readonly fiber?: unknown }
interface ConfigEditor {
  entries(): ProfileEntry[];
  edit(entry: ProfileEntry, change: (raw: Record<string, unknown>) => Record<string, unknown>): Promise<void>;
}

/** Persist via DSH's locked, validated profile editor; never edit profile files directly. */
export function registerDefaultsMigration(ctx: Context, revision: () => number): void {
  if (typeof ctx.inject !== "function") return;
  ctx.inject(["configEditor"], (scope) => {
    const editor = scope.get("configEditor") as ConfigEditor;
    let pending = false;
    const run = () => {
      if (pending || ctx.fiber.state !== 2 || revision() >= DEFAULTS_REVISION) return;
      // Match this exact instance, not a hard-coded id or another installation.
      const entry = editor.entries().find((row) => row.fiber === ctx.fiber);
      if (entry === undefined) return;
      pending = true;
      // The callback reads the latest raw config inside the editor's file lock.
      // The revision and switches commit together; failed writes remain retryable.
      void editor.edit(entry, migratePluginDefaults).catch((error: unknown) => {
        scope.logger.warn("CI Diet defaults migration failed; existing settings retained: %s", String(error));
      }).finally(() => { pending = false; });
    };
    scope.on("internal/status", (fiber) => { if (fiber === ctx.fiber) run(); });
    run();
  });
}
