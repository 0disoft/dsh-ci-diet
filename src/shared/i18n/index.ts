import { en, type MessageKey } from "./en.ts";
import { ko } from "./ko.ts";
import { zhHans } from "./zh-Hans.ts";

/** Locales we ship. Order matters only for documentation. */
export const LOCALES = ["en", "ko", "zh-Hans"] as const;
export type Locale = (typeof LOCALES)[number];
export type { MessageKey };
export type MessageParams = Readonly<Record<string, string | number>>;
export type Translator = (key: MessageKey, params?: MessageParams) => string;

export const DEFAULT_LOCALE: Locale = "en";

const dictionaries: Record<Locale, Partial<Record<MessageKey, string>>> = {
  en,
  ko,
  "zh-Hans": zhHans
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

function normalizeTag(tag: string): string {
  const withoutEncoding = tag.split(".")[0]?.split("@")[0] ?? "";
  return withoutEncoding.trim().replaceAll("_", "-").toLowerCase();
}

/**
 * Map one locale tag to a supported locale, or null when the tag is not one we ship.
 * Chinese tags we cannot serve (for example zh-TW) return null so the next
 * candidate wins, and a lone zh-TW ends up on the default locale.
 */
function matchLocale(tag: string): Locale | null {
  const normalized = normalizeTag(tag);
  if (normalized === "") return null;
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  if (normalized === "ko" || normalized.startsWith("ko-")) return "ko";
  if (
    normalized === "zh" ||
    normalized.startsWith("zh-hans") ||
    normalized.startsWith("zh-cn") ||
    normalized.startsWith("zh-sg")
  ) {
    return "zh-Hans";
  }
  return null;
}

/**
 * Pick the first supported locale from the candidates, in priority order.
 * Callers pass, for example, the --lang flag, the host locale, then LANG.
 */
export function resolveLocale(...candidates: Array<string | null | undefined>): Locale {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const matched = matchLocale(candidate);
    if (matched !== null) return matched;
  }
  return DEFAULT_LOCALE;
}

/** Resolve from the usual Unix locale variables. Empty or unknown values fall back. */
export function resolveLocaleFromEnv(
  env: Readonly<Record<string, string | undefined>>
): Locale {
  return resolveLocale(env.LC_ALL, env.LC_MESSAGES, env.LANG);
}

function interpolate(template: string, params?: MessageParams): string {
  if (params === undefined) return template;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match: string, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Translate one key. A key that a locale has not translated falls back to
 * English, so a partial dictionary can never render an empty string.
 */
export function t(
  key: MessageKey,
  params?: MessageParams,
  locale: Locale = DEFAULT_LOCALE
): string {
  const template = dictionaries[locale][key] ?? en[key];
  return interpolate(template, params);
}

export function createTranslator(locale: Locale): Translator {
  return (key, params) => t(key, params, locale);
}

/** Keys a locale actually translates, sorted. Useful for coverage checks. */
export function translatedKeys(locale: Locale): MessageKey[] {
  return (Object.keys(dictionaries[locale]) as MessageKey[]).sort();
}

export function missingKeys(locale: Locale): MessageKey[] {
  const present = new Set(translatedKeys(locale));
  return (Object.keys(en) as MessageKey[]).filter((key) => !present.has(key));
}
