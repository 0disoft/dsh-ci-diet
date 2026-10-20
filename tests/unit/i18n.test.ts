import assert from "node:assert/strict";
import { test } from "node:test";

import { en, type MessageKey } from "../../src/shared/i18n/en.ts";
import { ko } from "../../src/shared/i18n/ko.ts";
import { zhHans } from "../../src/shared/i18n/zh-Hans.ts";
import {
  DEFAULT_LOCALE,
  LOCALES,
  createTranslator,
  missingKeys,
  resolveLocale,
  resolveLocaleFromEnv,
  t,
  translatedKeys
} from "../../src/shared/i18n/index.ts";

const enKeys = Object.keys(en) as MessageKey[];

function placeholders(value: string): string[] {
  const found: string[] = [];
  const pattern = /\{([A-Za-z0-9_]+)\}/g;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(value)) !== null) {
    found.push(match[1] ?? "");
  }
  return found.sort();
}

test("English is the key source of truth", () => {
  assert.deepEqual(LOCALES, ["en", "ko", "zh-Hans"]);
  assert.equal(DEFAULT_LOCALE, "en");
  assert.ok(enKeys.length > 0);
  for (const key of enKeys) {
    assert.notEqual(en[key].trim(), "", "empty English message: " + key);
  }
});

test("Korean translates every English key exactly once", () => {
  assert.deepEqual(missingKeys("ko"), []);
  assert.deepEqual(translatedKeys("ko"), [...enKeys].sort());
  assert.deepEqual(Object.keys(ko).sort(), [...enKeys].sort());
});

test("Korean keeps the same interpolation placeholders as English", () => {
  for (const key of enKeys) {
    assert.deepEqual(placeholders(ko[key]), placeholders(en[key]), "placeholder drift: " + key);
  }
});

test("Simplified Chinese is a slot with no invented translations", () => {
  for (const key of Object.keys(zhHans) as MessageKey[]) {
    assert.ok(key in en, "unknown key in zh-Hans: " + key);
    assert.equal(typeof zhHans[key], "string");
  }
});

test("Untranslated keys fall back to English, never to an empty string", () => {
  for (const key of enKeys) {
    if (key in zhHans) continue;
    assert.equal(t(key, undefined, "zh-Hans"), en[key]);
  }
});

test("Explicit locale selects its dictionary", () => {
  const english = t("ui.nav.overview", undefined, "en");
  const korean = t("ui.nav.overview", undefined, "ko");
  assert.equal(english, "Overview");
  assert.equal(korean, "개요");
  assert.notEqual(korean, english);
});

test("Interpolation fills named placeholders and leaves unknown ones intact", () => {
  assert.equal(t("ui.scan.running", { runs: 42 }, "en"), "Scanning 42 runs...");
  assert.equal(t("ui.scan.done", { runs: 3, findings: 7 }, "ko"), "스캔 완료: 실행 3건, 발견 7건.");
  assert.equal(t("ui.scan.running", {}, "en"), "Scanning {runs} runs...");
  assert.equal(t("ui.scan.running", undefined, "en"), "Scanning {runs} runs...");
});

test("createTranslator keeps the locale bound", () => {
  const koT = createTranslator("ko");
  assert.equal(koT("rule.CD005.title"), "job 타임아웃 없음");
  assert.equal(koT("error.AUTH_REQUIRED"), "인증이 필요합니다.");
});

test("resolveLocale follows a fixed priority order", () => {
  const cases: Array<[Array<string | null | undefined>, string]> = [
    [["ko-KR"], "ko"],
    [["ko_KR.UTF-8"], "ko"],
    [["zh-Hans", "en"], "zh-Hans"],
    [["zh-CN"], "zh-Hans"],
    [["zh-TW"], "en"],
    [["de-DE"], "en"],
    [[], "en"],
    [[null, undefined, ""], "en"],
    [["de-DE", "ko"], "ko"]
  ];
  for (const [input, expected] of cases) {
    assert.equal(resolveLocale(...input), expected, "input: " + JSON.stringify(input));
  }
});

test("resolveLocaleFromEnv reads LC_ALL before LANG", () => {
  assert.equal(resolveLocaleFromEnv({ LC_ALL: "ko_KR.UTF-8", LANG: "en_US.UTF-8" }), "ko");
  assert.equal(resolveLocaleFromEnv({ LANG: "ko_KR.UTF-8" }), "ko");
  assert.equal(resolveLocaleFromEnv({ LANG: "C" }), "en");
  assert.equal(resolveLocaleFromEnv({}), "en");
});
