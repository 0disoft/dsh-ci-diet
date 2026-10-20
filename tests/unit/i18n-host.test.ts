import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { readDshLocalePreference, resolveRequestedLocale } from "../../src/shared/i18n/host.ts";

let root = "";

function profile(name: string, preference: string | null): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const body =
    preference === null
      ? "- id: tools\n  name: \"@deepseek-ai/dsh-tools\"\n"
      : [
          "- id: locale",
          "  name: \"@deepseek-ai/dsh-client-locale\"",
          "  config:",
          "    preference: " + preference,
          ""
        ].join("\n");
  writeFileSync(join(dir, "cordis.patch.yml"), body, "utf8");
  return dir;
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "ci-diet-locale-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("DSH locale preference", () => {
  it("reads the locale plugin config from the profile patch", () => {
    const dir = profile("ko-profile", "ko");
    assert.equal(readDshLocalePreference({ DSH_PROFILE_DIR: dir }), "ko");
  });

  it("returns null when the patch has no locale plugin", () => {
    const dir = profile("plain-profile", null);
    assert.equal(readDshLocalePreference({ DSH_PROFILE_DIR: dir }), null);
  });

  it("falls back to settings.yaml when the profile patch has no preference", () => {
    const home = join(root, "home-settings");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "settings.yaml"), "locale:\n  preference: fr\n", "utf8");
    assert.equal(readDshLocalePreference({ DSH_HOME: home }), "fr");
  });

  it("resolves DSH_HOME plus DSH_PROFILE when DSH_PROFILE_DIR is absent", () => {
    const home = join(root, "home-profile");
    mkdirSync(join(home, "profiles", "web"), { recursive: true });
    writeFileSync(
      join(home, "profiles", "web", "cordis.patch.yml"),
      "- id: locale\n  name: \"@deepseek-ai/dsh-client-locale\"\n  config:\n    preference: es\n",
      "utf8"
    );
    assert.equal(
      resolveRequestedLocale(null, { DSH_HOME: home, DSH_PROFILE: "web" }),
      "es"
    );
  });
});

describe("locale selection order", () => {
  it("prefers an explicit --lang over the host preference", () => {
    const dir = profile("explicit", "ko");
    const env = { DSH_PROFILE_DIR: dir, LANG: "fr_FR.UTF-8" };
    assert.equal(resolveRequestedLocale("hi-IN", env), "hi");
  });

  it("uses the host preference over environment variables", () => {
    const dir = profile("host-first", "ko");
    assert.equal(resolveRequestedLocale(null, { DSH_PROFILE_DIR: dir, LANG: "fr_FR.UTF-8" }), "ko");
  });

  it("sends an unsupported explicit tag to English, not to the host preference", () => {
    const dir = profile("unsupported", "ko");
    assert.equal(resolveRequestedLocale("de-DE", { DSH_PROFILE_DIR: dir }), "en");
  });

  it("falls back to LC_ALL and LANG when DSH has no preference", () => {
    assert.equal(resolveRequestedLocale(null, { LC_ALL: "fr_CA.UTF-8" }), "fr");
    assert.equal(resolveRequestedLocale(null, { LANG: "es_MX.UTF-8" }), "es");
    assert.equal(resolveRequestedLocale(null, {}), "en");
  });
});
