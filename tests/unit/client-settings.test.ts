import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test, { before } from "node:test";
import vm from "node:vm";
import { RULE_CHOICES, SETTINGS_FIELDS, collectSettingsEdits } from "../../src/client/fields.ts";
import { DICTIONARIES, NS } from "../../src/client/i18n.ts";
import { CSS_TEXT, STYLE_ATTRIBUTE, installStyles } from "../../src/client/styles.ts";
import { REVIEW_DICTIONARIES, REVIEW_NS } from "../../src/client/review-i18n.ts";

const ROOT = join(import.meta.dirname, "..", "..");

// Every case loads a fresh VM and form state from the same immutable bundle.
// Compile it once for this suite rather than rebuilding identical inputs per case.
before(() => {
  execFileSync(process.execPath, [join(ROOT, "scripts", "build-client.mjs")], { cwd: ROOT, stdio: "ignore" });
});

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
      const merged: Record<string, unknown> = { ...props };
      if (children.length > 0) merged.children = children.length === 1 ? children[0] : children;
      return { type, props: merged };
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
    uiSession: { adapter: { current: { getSnapshot: () => ({ key: "current-dsh-session" }), subscribe: () => () => {} } } },
    connection: { rpc: { call: async () => ({ ok: true, value: null }) } },
    effect(run: () => unknown) { return run(); },
  };
  plugin.apply(ctx);
  return { id: entry.id, plugin, sections, registrations, languages };
}

test("the client bundle registers settings and browser review sections", () => {
  const loaded = loadBundle();
  assert.equal(loaded.id, "dsh-ci-diet");
  assert.deepEqual(Array.from(loaded.plugin.inject), ["slots", "locale", "configForms", "connection", "uiSession"]);
  assert.equal(loaded.sections.length, 2);
  const options = loaded.sections[0]!.options;
  assert.equal(options.name, "settings.section");
  assert.equal(options.id, "ci-diet");
  assert.equal(options.order, 91);
  assert.equal(options.locale, NS);
  assert.equal((options.label as () => string)(), "CI Diet");
  const injected = (options.inject as () => { form: unknown })();
  assert.equal(typeof injected.form, "object");
  assert.equal(loaded.registrations.length, 2);
  assert.equal(loaded.registrations[0]!.namespace, NS);
  assert.equal(typeof loaded.sections[0]!.component, "function");
  assert.equal(loaded.sections[1]!.options.id, "ci-diet-reports");
  assert.equal(loaded.registrations[1]!.namespace, REVIEW_NS);
  assert.deepEqual(loaded.languages.map((language) => language.id), ["ko", "hi", "es", "fr"]);
  assert.ok(loaded.languages.every((language) => language.fallback === "en"));
});

test("review dictionaries have the same complete nonempty key set", () => {
  const keys = Object.keys(REVIEW_DICTIONARIES.en).sort();
  for (const [locale, dictionary] of Object.entries(REVIEW_DICTIONARIES)) {
    assert.deepEqual(Object.keys(dictionary).sort(), keys, locale);
    assert.ok(Object.values(dictionary).every((text) => text.trim().length > 0));
  }
});

test("review reads current session from the public UI scope adapter", () => {
  const loaded = loadBundle(fakeReact().react);
  const injected = (loaded.sections[1]!.options.inject as () => { ctx: { useSessionId(): string | undefined } })();
  assert.equal(injected.ctx.useSessionId(), "current-dsh-session");
});

function reviewHarness(call: (payload: Record<string, unknown>) => Promise<unknown>) {
  const fake = fakeReact();
  let effectIndex = 0;
  const effects: { deps: readonly unknown[]; cleanup?: void | (() => void) }[] = [];
  const pending: (() => void)[] = [];
  fake.react.useRef = (initial: unknown) => (fake.react.useState as (value: unknown) => unknown[])({ current: initial })[0];
  fake.react.useEffect = (run: () => void | (() => void), deps: readonly unknown[]) => {
    const index = effectIndex++;
    const previous = effects[index];
    if (previous !== undefined && deps.every((dep, i) => dep === previous.deps[i])) return;
    pending.push(() => { previous?.cleanup?.(); effects[index] = { deps, cleanup: run() }; });
  };
  const component = loadBundle(fake.react).sections[1]!.component;
  let session = "session-one";
  const ctx = { useSessionId: () => session, connection: { rpc: { call: async (_channel: string, endpoint: string, payload: Record<string, unknown>) => {
    assert.equal(endpoint, "ci-diet-review"); return { ok: true, value: await call(payload) };
  } } } };
  return {
    render() { effectIndex = 0; return renderPage(fake.react, component, { ctx }); },
    async settle() { while (pending.length > 0) pending.shift()!(); await new Promise((resolve) => setImmediate(resolve)); },
    session(next: string) { session = next; },
  };
}

const REVIEW_PLAN = { id: "p_review", digest: "sha256:123456789abc", workflowPath: ".github/workflows/ci.yml", ruleId: "CD001",
  state: "preview", expiresAt: "2099-01-01T00:00:00Z", sourceValid: true, blockers: [], diff: [{ kind: "added", text: "concurrency: ci" }] };

test("review UI sends typed approval separately from apply and disables stale plans", async () => {
  const calls: Record<string, unknown>[] = [];
  let stale = false;
  const h = reviewHarness(async (payload) => {
    calls.push(payload);
    if (payload.action !== "load") return { state: "approved" };
    return { root: "C:/workspace", bindingId: "b_one", localApplyEnabled: true, report: null,
      plans: [{ ...REVIEW_PLAN, sourceValid: !stale, blockers: stale ? ["SOURCE_HASH_MISMATCH"] : [] }], changes: [] };
  });
  h.render(); await h.settle();
  let tree = h.render();
  const input = findElement(tree, (element) => element.type === "input")!;
  assert.ok(input);
  (input.props.onChange as (event: unknown) => void)({ target: { value: "123456789abc" } });
  tree = h.render();
  const approve = findElement(tree, (element) => element.type === "button" && element.props.children === REVIEW_DICTIONARIES.en["plan.approve"])!;
  assert.ok(approve);
  assert.equal(approve.props.disabled, false);
  (approve.props.onClick as () => void)(); await h.settle();
  assert.equal(calls.filter((call) => call.action === "approve").length, 1);
  assert.equal(calls.some((call) => call.action === "apply"), false);
  assert.equal(calls.find((call) => call.action === "approve")!.confirmation, "123456789abc");
  stale = true;
  const refresh = findElement(h.render(), (element) => element.type === "button" && element.props.children === REVIEW_DICTIONARIES.en["page.refresh"])!;
  (refresh.props.onClick as () => void)(); await h.settle();
  const staleApprove = findElement(h.render(), (element) => element.type === "button" && element.props.children === REVIEW_DICTIONARIES.en["plan.approve"])!;
  assert.equal(staleApprove.props.disabled, true);
});

test("review discards an older session response when current chat changes", async () => {
  let finish: (value: unknown) => void = () => {};
  const h = reviewHarness(async (payload) => payload.sessionId === "session-one"
    ? new Promise((resolve) => { finish = resolve; })
    : { root: "new-workspace", bindingId: null, localApplyEnabled: false, report: null, plans: [], changes: [] });
  h.render(); await h.settle();
  h.session("session-two"); h.render(); await h.settle();
  finish({ root: "old-workspace", bindingId: null, localApplyEnabled: false, report: null, plans: [], changes: [] });
  await h.settle();
  const rendered = JSON.stringify(h.render());
  assert.ok(rendered.includes("new-workspace"));
  assert.equal(rendered.includes("old-workspace"), false);
});

test("the action bar sits outside the scrolling page body", () => {
  const fake = fakeReact();
  const loaded = loadBundle(fake.react);
  const form = {
    getSnapshot: () => ({ status: "ready", writable: true, revision: 1, value: { rules: ["CD001"], stateDir: "" } }),
    subscribe: () => () => {},
    mutate: async () => true,
  };
  const tree = renderPage(fake.react, loaded.sections[0]!.component, { form, t: (key: string) => key });
  const page = findElement(tree, (element) => element.props.className === "ci-diet-page");
  assert.ok(page !== undefined, "the page frame is missing");
  const children = page.props.children as FakeElement[];
  assert.ok(Array.isArray(children), "the page frame needs its body and footer");
  const bodyIndex = children.findIndex((child) => child.props.className === "ci-diet-body");
  const actionsIndex = children.findIndex((child) => child.props.className === "ci-diet-actions");
  assert.ok(bodyIndex >= 0, "the scrolling body is missing");
  assert.equal(actionsIndex, bodyIndex + 1, "the action bar must be a sibling after the body");
  assert.equal(findElement(children[bodyIndex], (element) => element.props.className === "ci-diet-actions"), undefined);
});

test("the page saves against the revision it started editing", async () => {
  const fake = fakeReact();
  const loaded = loadBundle(fake.react);
  let revision = 1;
  const calls: { ops: readonly unknown[]; revision: number | undefined }[] = [];
  let unsetCalls = 0;
  const form = {
    getSnapshot: () => ({
      status: "ready",
      writable: true,
      revision,
      value: { rules: ["CD001", "CD002", "CD004"], stateDir: "" },
      user: { stateDir: "D:/legacy" },
    }),
    subscribe: () => () => {},
    mutate: async (ops: readonly unknown[], expected?: number) => { calls.push({ ops, revision: expected }); return true; },
    unset: async () => { unsetCalls += 1; return true; },
  };
  const component = loaded.sections[0]!.component;
  const props = { form, t: (key: string) => key };
  let tree = renderPage(fake.react, component, props);
  const rule = findElement(tree, (element) => element.props["aria-label"] === "field.ruleCD005");
  assert.ok(rule !== undefined, "the rule checkbox is missing");
  (rule.props.onChange as () => void)();
  tree = renderPage(fake.react, component, props);
  revision = 2;
  tree = renderPage(fake.react, component, props);
  const reset = findElement(tree, (element) => element.type === "button" && element.props.children === "page.reset");
  assert.ok(reset !== undefined, "the reset button is missing");
  (reset.props.onClick as () => void)();
  tree = renderPage(fake.react, component, props);
  const save = findElement(tree, (element) => element.type === "button" && element.props.children === "page.save");
  assert.ok(save !== undefined, "the save button is missing");
  (save.props.onClick as () => void)();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.revision, 1);
  assert.equal(unsetCalls, 0);
  const ops = calls[0]!.ops as { op: string; path: readonly string[]; value: unknown }[];
  const set = ops.find((op) => op.path[0] === "rules");
  assert.deepEqual(Array.from(set?.value as readonly string[]), ["CD001", "CD002", "CD004", "CD005"]);
  const unset = ops.find((op) => op.op === "unset");
  assert.equal(unset?.op, "unset");
  assert.deepEqual(Array.from(unset?.path as string[]), ["stateDir"]);
});

test("editing a field replaces its staged reset", async () => {
  const fake = fakeReact();
  const loaded = loadBundle(fake.react);
  const calls: { ops: readonly unknown[] }[] = [];
  const form = {
    getSnapshot: () => ({ status: "ready", writable: true, revision: 1, value: { stateDir: "" }, user: { stateDir: "D:/legacy" } }),
    subscribe: () => () => {},
    mutate: async (ops: readonly unknown[]) => { calls.push({ ops }); return true; },
  };
  const component = loaded.sections[0]!.component;
  const props = { form, t: (key: string) => key };
  let tree = renderPage(fake.react, component, props);
  const reset = findElement(tree, (element) => element.type === "button" && element.props.children === "page.reset");
  assert.ok(reset !== undefined, "the reset button is missing");
  (reset.props.onClick as () => void)();
  tree = renderPage(fake.react, component, props);
  const input = findElement(tree, (element) => element.type === "input" && element.props["aria-label"] === "field.stateDir");
  assert.ok(input !== undefined, "the state directory input is missing");
  (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "D:/new" } });
  tree = renderPage(fake.react, component, props);
  const save = findElement(tree, (element) => element.type === "button" && element.props.children === "page.save");
  assert.ok(save !== undefined, "the save button is missing");
  (save.props.onClick as () => void)();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 1);
  const ops = calls[0]!.ops as { op: string; path: readonly string[]; value: unknown }[];
  assert.equal(ops.some((op) => op.op === "unset"), false);
  assert.deepEqual(Array.from(ops, (op) => [op.op, Array.from(op.path), op.value]), [["set", ["stateDir"], "D:/new"]]);
});

test("the draft batch stages resets as unset operations in field order", () => {
  const message = (key: string) => key;
  assert.deepEqual(collectSettingsEdits({}, message, ["historyMaxRuns", "stateDir"]).ops, [
    { op: "unset", path: ["stateDir"] },
    { op: "unset", path: ["historyMaxRuns"] },
  ]);
  assert.deepEqual(collectSettingsEdits({ rules: ["CD001"] }, message, ["stateDir"]).ops, [
    { op: "unset", path: ["stateDir"] },
    { op: "set", path: ["rules"], value: ["CD001"] },
  ]);
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

test("every field and rule label has a dictionary entry", () => {
  const dictionary = DICTIONARIES.en as Record<string, string>;
  for (const field of SETTINGS_FIELDS) {
    assert.ok(dictionary["field." + field.key] !== undefined, "missing label for " + field.key);
  }
  for (const id of RULE_CHOICES) {
    assert.ok(dictionary["field.rule" + id] !== undefined, "missing rule label for " + id);
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
test("the section styles follow the host theme instead of a local palette", () => {
  assert.match(CSS_TEXT, /\.ci-diet-body \{[^}]*flex: 1 1 auto[^}]*overflow-y: auto/);
  assert.match(CSS_TEXT, /\.ci-diet-actions \{[^}]*flex: 0 0 auto/);
  assert.equal(/position:\s*(sticky|fixed)/.test(CSS_TEXT), false, "the page must not stick to the settings viewport");
  assert.match(CSS_TEXT, /settings-card-fill/);
  assert.match(CSS_TEXT, /settings-card-stroke/);
  assert.match(CSS_TEXT, /button-primary-fill/);
  assert.match(CSS_TEXT, /label-primary-foreground/);
  assert.match(CSS_TEXT, /border-l2/);
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(CSS_TEXT), false, "the stylesheet must not carry fallback colours");
});

test("the stylesheet installs once and cleans up its own tag", () => {
  const installed: { textContent: string; readonly attributes: Record<string, string>; removed: boolean; remove(): void; setAttribute(name: string, value: string): void } = {
    textContent: "",
    attributes: {},
    removed: false,
    remove() { this.removed = true; },
    setAttribute(name, value) { this.attributes[name] = value; },
  };
  let current: typeof installed | null = null;
  const doc = {
    head: { appendChild(node: typeof installed) { current = node; } },
    querySelector() { return current; },
    createElement() { return installed; },
  };
  const cleanup = installStyles(doc);
  assert.equal(current, installed);
  assert.equal(installed.textContent, CSS_TEXT);
  assert.ok(STYLE_ATTRIBUTE in installed.attributes);
  const secondCleanup = installStyles(doc);
  assert.equal(installed.removed, false);
  cleanup();
  assert.equal(installed.removed, true);
  secondCleanup();
});

test("the draft discard action is named as a discarding action in every language", () => {
  assert.equal(DICTIONARIES.en["page.discard"], "Discard changes");
  assert.equal(DICTIONARIES.ko["page.discard"], "변경 취소");
  assert.notEqual(DICTIONARIES.ko["page.discard"], "되돌리기");
  assert.equal(DICTIONARIES.zh["page.discard"], "放弃更改");
  assert.equal(DICTIONARIES["zh-Hans"]["page.discard"], "放弃更改");
});
