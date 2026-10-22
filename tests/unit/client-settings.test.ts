import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { SETTINGS_FIELDS, collectSettingsEdits } from "../../src/client/fields.ts";
import { DICTIONARIES, NS } from "../../src/client/i18n.ts";

const ROOT = join(import.meta.dirname, "..", "..");

function buildBundle(): void {
  execFileSync(process.execPath, [join(ROOT, "scripts", "build-client.mjs")], { cwd: ROOT, stdio: "ignore" });
}

interface SectionRegistration {
  readonly options: Record<string, unknown>;
  readonly component: unknown;
}

interface LoadedBundle {
  readonly id: string;
  readonly plugin: { readonly inject: readonly string[]; apply(ctx: unknown): void };
  readonly sections: SectionRegistration[];
  readonly registrations: { namespace: string; dictionaries: unknown }[];
  readonly languages: { id: string; label: string; fallback: string }[];
}

interface FakeElement {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
}

function fakeReact(): { react: Record<string, unknown>; values: unknown[] } {
  const values: unknown[] = [];
  let index = 0;
  const react = {
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): FakeElement {
      return { type, props: { ...(props ?? {}), ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) } };
    },
    useState<T>(initial: T): [T, (next: T | ((current: T) => T)) => void] {
      const slot = index++;
      if (slot >= values.length) values[slot] = initial;
      const set = (next: T | ((current: T) => T)): void => {
        const current = values[slot] as T;
        values[slot] = typeof next === "function" ? (next as (value: T) => T)(current) : next;
      };
      return [values[slot] as T, set];
    },
    useSyncExternalStore(_subscribe: unknown, get: () => unknown): unknown {
      return get();
    },
    reset(): void {
      index = 0;
    },
  };
  return { react, values };
}

function renderPage(react: Record<string, unknown>, component: unknown, props: Record<string, unknown>): FakeElement {
  (react.reset as () => void)();
  return (component as (input: Record<string, unknown>) => FakeElement)(props);
}

function findElement(node: unknown, predicate: (element: FakeElement) => boolean): FakeElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (node === null || typeof node !== "object") return undefined;
  const element = node as FakeElement;
  if (predicate(element)) return element;
  return findElement(element.props.children, predicate);
}

function loadBundle(fake?: Record<string, unknown>): LoadedBundle {
  const captured: { id: string; factory(require: (id: string) => unknown): unknown }[] = [];
  const sandbox = { window: { __ModuleLoader__: { load(entry: unknown) { captured.push(entry as never); } } } };
  vm.runInNewContext(readFileSync(join(ROOT, "client", "index.js"), "utf8"), sandbox);
  assert.equal(captured.length, 1);
  const entry = captured[0]!;
  const sections: SectionRegistration[] = [];
  const registrations: { namespace: string; dictionaries: unknown }[] = [];
  const languages: { id: string; label: string; fallback: string }[] = [];
  const form = { getSnapshot: () => ({ status: "ready", writable: true }), subscribe: () => () => {}, mutate: async () => true, unset: async () => true };
  const plugin = entry.factory((id: string) => {
    if (id === "react") return fake ?? { createElement: () => null, useState: () => [undefined, () => {}], useSyncExternalStore: () => ({ status: "loading", writable: false }) };
    throw new Error("unexpected require " + id);
  }) as LoadedBundle["plugin"];
  const ctx = {
    slots: {
      inject(name: string, run: () => unknown) {
        assert.equal(name, "settings.section");
        return run();
      },
      register(options: Record<string, unknown>, component: unknown) {
        sections.push({ options, component });
        return "registered";
      },
    },
    locale: {
      bind() {
        return (key: string) => (key === "nav" ? "CI Diet" : key);
      },
      register(namespace: string, dictionaries: unknown) {
        registrations.push({ namespace, dictionaries });
        return () => {};
      },
      getLocale() {
        return { locales: [{ id: "en" }, { id: "zh" }] };
      },
      addLanguage(language: { id: string; label: string; fallback: string }) {
        languages.push(language);
        return () => {};
      },
    },
    configForms: { get: () => form },
    effect(run: () => unknown) { return run(); },
  };
  plugin.apply(ctx);
  return { id: entry.id, plugin, sections, registrations, languages };
}

test("the client bundle registers one settings section for the package", () => {
  buildBundle();
  const loaded = loadBundle();
  assert.equal(loaded.id, "dsh-ci-diet");
  assert.deepEqual(Array.from(loaded.plugin.inject), ["slots", "locale", "configForms"]);
  assert.equal(loaded.sections.length, 1);
  const options = loaded.sections[0]!.options;
  assert.equal(options.name, "settings.section");
  assert.equal(options.id, "ci-diet");
  assert.equal(options.order, 91);
  assert.equal(options.locale, NS);
  assert.equal((options.label as () => string)(), "CI Diet");
  const injected = (options.inject as () => { form: unknown })();
  assert.equal(typeof injected.form, "object");
  assert.equal(loaded.registrations.length, 1);
  assert.equal(loaded.registrations[0]!.namespace, NS);
  assert.equal(typeof loaded.sections[0]!.component, "function");
  assert.deepEqual(loaded.languages.map((language) => language.id), ["ko", "hi", "es", "fr"]);
  assert.ok(loaded.languages.every((language) => language.fallback === "en"));
});

test("the page saves against the revision it started editing", async () => {
  buildBundle();
  const fake = fakeReact();
  const loaded = loadBundle(fake.react);
  let revision = 1;
  const calls: { ops: readonly unknown[]; revision: number | undefined }[] = [];
  const form = {
    getSnapshot: () => ({ status: "ready", writable: true, revision, value: { rules: ["CD001", "CD002", "CD004"] } }),
    subscribe: () => () => {},
    mutate: async (ops: readonly unknown[], expected?: number) => { calls.push({ ops, revision: expected }); return true; },
    unset: async () => true,
  };
  const component = loaded.sections[0]!.component;
  const props = { form, t: (key: string) => key };
  let tree = renderPage(fake.react, component, props);
  const rule = findElement(tree, (element) => element.props["aria-label"] === "field.ruleCD005");
  assert.ok(rule !== undefined, "the rule checkbox is missing");
  (rule.props.onChange as () => void)();
  tree = renderPage(fake.react, component, props);
  revision = 2;
  const save = findElement(tree, (element) => element.type === "button" && element.props.children === "page.save");
  assert.ok(save !== undefined, "the save button is missing");
  (save.props.onClick as () => void)();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.revision, 1);
  const set = (calls[0]!.ops as { op: string; path: readonly string[]; value: unknown }[]).find((op) => op.path[0] === "rules");
  assert.deepEqual(Array.from(set?.value as readonly string[]), ["CD001", "CD002", "CD004", "CD005"]);
});

test("all six languages expose the same non-empty keys", () => {
  const expected = Object.keys(DICTIONARIES.en).sort();
  assert.ok(expected.length >= 40, "dictionary is unexpectedly small: " + expected.length);
  for (const code of ["ko", "zh", "zh-Hans", "hi", "es", "fr"] as const) {
    const dictionary = DICTIONARIES[code] as Record<string, string>;
    assert.deepEqual(Object.keys(dictionary).sort(), expected, code + " has a different key set");
    for (const [key, value] of Object.entries(dictionary)) {
      assert.equal(typeof value, "string", code + "." + key);
      assert.ok(value.trim().length > 0, code + "." + key + " is empty");
      assert.equal(value, value.trim(), code + "." + key + " has surrounding whitespace");
    }
  }
});

test("field descriptors cover every live setting under a known group", () => {
  const keys = SETTINGS_FIELDS.map((field) => field.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const key of ["networkEnabled", "stateDir", "rules", "historyLookbackDays", "historyConcurrentRequests", "storageStoreMaxBytes", "storageReportDays", "billingIncludedMinutes", "billingAccountMinutesUsed"]) {
    assert.ok(keys.includes(key), "missing descriptor " + key);
  }
  for (const field of SETTINGS_FIELDS) {
    assert.ok(["general", "rules", "history", "storage", "billing"].includes(field.group));
    if (field.kind === "rules") assert.equal(field.key, "rules");
    if (field.kind === "number") assert.equal(typeof field.min, "number", field.key);
  }
});

test("the draft batch rejects contract violations before any write", () => {
  const message = (key: string, params: Record<string, string | number> = {}) => key + JSON.stringify(params);
  const batch = collectSettingsEdits({ historyLookbackDays: "31" }, message);
  assert.equal(batch.ops.length, 0);
  assert.match(batch.errors.historyLookbackDays!, /page\.tooLarge\{"max":30\}/);

  assert.equal(collectSettingsEdits({ historyConcurrentRequests: "0" }, message).errors.historyConcurrentRequests!.startsWith("page.tooSmall"), true);
  assert.equal(collectSettingsEdits({ historyConcurrentRequests: "2.5" }, message).errors.historyConcurrentRequests!.startsWith("page.invalidInteger"), true);
  assert.equal(collectSettingsEdits({ historyMaxRuns: "" }, message).errors.historyMaxRuns!.startsWith("page.invalidNumber"), true);
  assert.equal(collectSettingsEdits({ historyMaxRuns: "many" }, message).errors.historyMaxRuns!.startsWith("page.invalidNumber"), true);
  assert.deepEqual(collectSettingsEdits({ notASetting: "1" }, message).ops, []);
  assert.equal(collectSettingsEdits({ rules: [] }, message).errors.rules!.startsWith("page.noRules"), true);
  assert.match(collectSettingsEdits({ rules: ["CD999"] }, message).errors.rules!, /page\.unknownRule\{"rule":"CD999"\}/);
});

test("the draft batch keeps valid edits in field order and preserves switches", () => {
  const batch = collectSettingsEdits({ networkEnabled: true, rules: ["CD004", "CD001"], stateDir: "D:/state", historyMaxRuns: 50, billingIncludedMinutes: 2000 }, (key) => key);
  assert.deepEqual(batch.errors, {});
  assert.deepEqual(batch.ops, [
    { op: "set", path: ["networkEnabled"], value: true },
    { op: "set", path: ["stateDir"], value: "D:/state" },
    { op: "set", path: ["rules"], value: ["CD001", "CD004"] },
    { op: "set", path: ["historyMaxRuns"], value: 50 },
    { op: "set", path: ["billingIncludedMinutes"], value: 2000 },
  ]);
});