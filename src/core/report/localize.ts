import type { Finding } from "../contracts/schema.ts";
import { isMessageKey, t, type Locale } from "../../shared/i18n/index.ts";

/** Display text for one finding in one locale. */
export interface LocalizedFinding {
  readonly title: string;
  readonly text: string;
}

/**
 * Render a finding for display without touching stored data. The stored English
 * title and renderedText stay canonical: message keys are only a display layer,
 * and an unknown or absent key falls back to the stored English text.
 */
export function localizedFinding(finding: Finding, locale: Locale): LocalizedFinding {
  const message = finding.message;
  if (message === undefined) return { title: finding.title, text: finding.renderedText };
  const title = isMessageKey(message.titleKey)
    ? t(message.titleKey, message.params, locale)
    : finding.title;
  const text = isMessageKey(message.textKey)
    ? t(message.textKey, message.params, locale)
    : finding.renderedText;
  return { title, text };
}
