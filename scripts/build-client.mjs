#!/usr/bin/env node
/** Build the lazy-CJS client half from src/client and wrap it for window.__ModuleLoader__. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsc = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const buildDir = fileURLToPath(new URL("../.client-build", import.meta.url));
const outDir = fileURLToPath(new URL("../client", import.meta.url));

rmSync(buildDir, { recursive: true, force: true });
execFileSync(process.execPath, [tsc, "-p", fileURLToPath(new URL("../tsconfig.client.json", import.meta.url))], { cwd: root, stdio: ["ignore", "inherit", "inherit"] });

const moduleNames = ["fields", "i18n", "styles", "review-i18n", "review", "index"];
const modules = moduleNames.map((name) => {
  const code = readFileSync(fileURLToPath(new URL("../.client-build/" + name + ".js", import.meta.url)), "utf8");
  return ["  __define(" + JSON.stringify(name) + ", function (module, exports, require) {", code, "  });", ""].join("\n");
}).join("\n");

const bundle = [
  "/* Built by scripts/build-client.mjs. Source: src/client. */",
  "window.__ModuleLoader__.load({",
  '  id: "dsh-ci-diet",',
  "  factory(require) {",
  "    var __factories = Object.create(null);",
  "    var __cache = Object.create(null);",
  "    function __define(name, factory) { __factories[name] = factory; }",
  "    function __load(name) {",
  "      if (__cache[name] !== undefined) return __cache[name].exports;",
  "      var module = { exports: {} };",
  "      __cache[name] = module;",
  "      function __local(id) {",
  '        if (id.charAt(0) !== ".") return require(id);',
  "        var relative = id.slice(2);",
  '        var suffix = ".js";',
  "        if (relative.length >= suffix.length && relative.slice(-suffix.length) === suffix) relative = relative.slice(0, -suffix.length);",
  "        return __load(relative);",
  "      }",
  "      __factories[name](module, module.exports, __local);",
  "      return module.exports;",
  "    }",
  modules,
  '    var entry = __load("index");',
  "    return entry.default !== undefined ? entry.default : entry;",
  "  },",
  "});",
  "",
].join("\n");
mkdirSync(outDir, { recursive: true });
writeFileSync(fileURLToPath(new URL("../client/index.js", import.meta.url)), bundle, "utf8");
writeFileSync(fileURLToPath(new URL("../client/index.d.ts", import.meta.url)), [
  "/** DSH Web client half for the CI Diet settings section. */",
  "declare const plugin: { readonly inject: readonly string[]; apply(ctx: unknown): void };",
  "export default plugin;",
  "",
].join("\n"), "utf8");
console.log("built client/index.js (" + bundle.length + " bytes, " + moduleNames.length + " modules)");
