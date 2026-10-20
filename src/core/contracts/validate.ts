import { createRequire } from "node:module";
import { CI_DIET_SCHEMA_JSON } from "./schema-json.generated.ts";

export type DocumentKind =
  | "AnalysisReport"
  | "Config"
  | "PatchPlan"
  | "AppliedChange"
  | "Attestation"
  | "RepositoryBinding"
  | "FindingEvaluation"
  | "Suppression"
  | "CapabilityReport"
  | "Coverage"
  | "OperationProgress"
  | "PolicySnapshot"
  | "LocalEvent"
  | "ReportCard";

interface SchemaError {
  readonly instancePath: string;
  readonly keyword: string;
  readonly message?: string;
}

interface CompiledValidator {
  (value: unknown): boolean;
  errors?: readonly SchemaError[] | null;
}

interface AjvInstance {
  compile(schema: Record<string, unknown>): CompiledValidator;
}

type AjvConstructor = new (options?: Record<string, unknown>) => AjvInstance;
type FormatsInstall = (ajv: AjvInstance) => unknown;

// ajv@8 and ajv-formats@3 ship CommonJS with a `default` property mirror;
// createRequire returns the callable module directly under Node ESM.
// The contract targets JSON Schema 2020-12, so the 2020 entry point is
// required: the default ajv export only knows draft-07 meta-schemas.
const require = createRequire(import.meta.url);
const ajv2020 = require("ajv/dist/2020") as { Ajv2020?: AjvConstructor } | AjvConstructor;
const Ajv = (typeof ajv2020 === "function" ? ajv2020 : ajv2020.Ajv2020) as AjvConstructor;
const addFormats = require("ajv-formats") as FormatsInstall;

const root = JSON.parse(CI_DIET_SCHEMA_JSON) as {
  $schema?: string;
  $defs: Record<string, unknown>;
};

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
addFormats(ajv);

const validators = new Map<string, CompiledValidator>();

function validatorFor(kind: DocumentKind): CompiledValidator {
  const existing = validators.get(kind);
  if (existing) return existing;
  if (!root.$defs[kind]) throw new Error("unknown contract definition: " + kind);
  const compiled = ajv.compile({
    $schema: root.$schema,
    $defs: root.$defs,
    $ref: "#/$defs/" + kind,
  });
  validators.set(kind, compiled);
  return compiled;
}

function describeError(error: SchemaError): string {
  const location = error.instancePath === "" ? "/" : error.instancePath;
  return location + " " + error.keyword + " " + (error.message ?? "invalid");
}

/** Sorted validation errors for one contract document; empty means valid. */
export function validationErrors(kind: DocumentKind, value: unknown): string[] {
  const validate = validatorFor(kind);
  if (validate(value)) return [];
  return (validate.errors ?? []).map(describeError).sort();
}

/** A document that cannot be persisted because it breaks the frozen contract. */
export class ContractViolationError extends Error {
  readonly kind: DocumentKind;
  readonly errors: readonly string[];

  // No parameter properties: the CLI runs these files through Node's
  // strip-only TypeScript loader, which rejects non-erasable syntax.
  constructor(kind: DocumentKind, errors: readonly string[]) {
    super(kind + " violates the contract: " + errors.slice(0, 8).join("; "));
    this.name = "ContractViolationError";
    this.kind = kind;
    this.errors = errors;
  }
}

/** Throw instead of persisting a document that violates the frozen contract. */
export function assertValidDocument(kind: DocumentKind, value: unknown): void {
  const errors = validationErrors(kind, value);
  if (errors.length === 0) return;
  throw new ContractViolationError(kind, errors);
}
