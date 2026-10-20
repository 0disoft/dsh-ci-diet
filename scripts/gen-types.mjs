/** Regenerate the TypeScript mirror of contracts/ci-diet.schema.json. */
import { mkdir, readFile, writeFile } from "node:fs/promises";

const schemaUrl = new URL("../contracts/ci-diet.schema.json", import.meta.url);
const outputUrl = new URL("../src/core/contracts/schema.ts", import.meta.url);
const check = process.argv.includes("--check");

const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
const defs = schema.$defs ?? {};

const refName = (ref) => {
  const name = ref.split("/").pop();
  if (!name || !(name in defs)) throw new Error("unresolved $ref " + ref);
  return name;
};

const literal = (value) => JSON.stringify(value);

function objectShape(node) {
  const properties = node.properties ?? {};
  const required = new Set(node.required ?? []);
  const parts = Object.entries(properties).map(([key, value]) =>
    "  " + JSON.stringify(key) + (required.has(key) ? "" : "?") + ": " + typeOf(value) + ";");
  if (node.additionalProperties === true) parts.push("  [key: string]: unknown;");
  else if (node.additionalProperties && typeof node.additionalProperties === "object") {
    parts.push("  [key: string]: " + typeOf(node.additionalProperties) + ";");
  }
  if (parts.length === 0) return "Record<string, never>";
  return "{\n" + parts.join("\n") + "\n}";
}

const isConditionalOnly = (node) =>
  Object.keys(node).every((key) => key === "if" || key === "then" || key === "else");

function typeOf(node) {
  if (!node || typeof node !== "object") throw new Error("unsupported schema node " + literal(node));
  if (node.$ref) return refName(node.$ref);
  if ("const" in node) return literal(node.const);
  if (Array.isArray(node.enum)) return node.enum.map(literal).join(" | ");
  if (Array.isArray(node.oneOf)) return node.oneOf.map(typeOf).join(" | ");
  if (Array.isArray(node.anyOf)) return node.anyOf.map(typeOf).join(" | ");
  if (Array.isArray(node.allOf)) {
    const parts = node.allOf.filter((entry) => !isConditionalOnly(entry)).map(typeOf);
    const base = { ...node };
    delete base.allOf;
    const baseType = base.type || base.properties || base.items || base.$ref || base.enum ? typeOf(base) : null;
    const all = baseType ? [baseType, ...parts] : parts;
    if (all.length === 0) return "unknown";
    return all.join(" & ");
  }
  const type = node.type ?? (node.properties ? "object" : node.items ? "array" : undefined);
  if (Array.isArray(type)) return type.map((entry) => typeOf({ ...node, type: entry })).join(" | ");
  switch (type) {
    case "object":
      return objectShape(node);
    case "array":
      if (node.prefixItems) {
        const tuple = node.prefixItems.map(typeOf);
        const rest = node.items && typeof node.items === "object" ? typeOf(node.items) : null;
        return "[" + tuple.join(", ") + (rest ? ", ..." + rest + "[]" : "") + "]";
      }
      if (node.items === undefined) return "unknown[]";
      const element = typeOf(node.items);
      return (element.includes("|") ? "(" + element + ")" : element) + "[]";
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    default:
      throw new Error("unsupported schema node " + literal(Object.keys(node)));
  }
}

const header = [
  "/* eslint-disable */",
  "/** Generated from contracts/ci-diet.schema.json by scripts/gen-types.mjs.",
  " * Do not edit by hand: run bun run gen:types after an intentional contract change.",
  " *",
  " * Structural mirror only. Validation keywords (pattern, minLength, format,",
  " * minimum, maxItems, uniqueItems, if/then/else) are enforced by Ajv against the",
  " * JSON Schema, not by these types. Conditional schemas appear as their broader",
  " * base shape, so a value that satisfies these types may still fail validation.",
  " */",
  ""
].join("\n");

const body = [];
for (const [name, node] of Object.entries(defs)) {
  body.push("export type " + name + " = " + typeOf(node) + ";");
}
if (Array.isArray(schema.oneOf)) {
  body.push("");
  body.push("export type CiDietContract = " + schema.oneOf.map(typeOf).join(" | ") + ";");
}
const output = header + body.join("\n") + "\n";

if (output.includes("$ref")) throw new Error("unresolved reference in generated types");

if (check) {
  const current = await readFile(outputUrl, "utf8").catch(() => "");
  if (current !== output) {
    console.error("generated types are stale: run bun run gen:types and commit src/core/contracts/schema.ts");
    process.exit(1);
  }
  console.log("types match contracts/ci-diet.schema.json (" + Object.keys(defs).length + " definitions)");
} else {
  await mkdir(new URL("../src/core/contracts/", import.meta.url), { recursive: true });
  await writeFile(outputUrl, output);
  console.log("wrote src/core/contracts/schema.ts (" + output.split("\n").length + " lines, " + Object.keys(defs).length + " definitions)");
}
