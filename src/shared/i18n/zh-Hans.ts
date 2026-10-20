import type { MessageKey } from "./en.ts";

// Simplified Chinese is a translation slot only for now.
// Untranslated keys fall back to English, so this must stay Partial.
export const zhHans: Partial<Record<MessageKey, string>> = {};
