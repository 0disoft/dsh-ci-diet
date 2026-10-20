/**
 * CI Diet JSON canonicalization, version CDJ1.
 *
 * Object keys are sorted in ASCII code order, arrays keep their order, and the
 * result is compact JSON with no whitespace. Only JSON values are accepted:
 * null, boolean, string, safe integers, arrays, and plain objects whose keys
 * are printable ASCII. Every digest in the product is sha256 over a CDJ1
 * string, so this module has to stay byte-for-byte stable.
 */
import { createHash } from "node:crypto";

export type CanonicalJsonValue =
  | null
  | boolean
  | string
  | number
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

/** Raised when a value cannot be represented as CDJ1. */
export class CanonicalJsonError extends TypeError {
  readonly path: string;

  constructor(message: string, path: string) {
    super(message);
    this.name = "CanonicalJsonError";
    this.path = path;
  }
}

const ASCII_KEY = /^[\x20-\x7e]+$/;

function fail(path: string, message: string): never {
  throw new CanonicalJsonError(path + ": " + message, path);
}

function canonical(value: unknown, path: string): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      fail(path, "only safe integers are allowed, got " + String(value));
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        fail(path + "[" + index + "]", "sparse arrays are not JSON");
      }
      parts.push(canonical(value[index], path + "[" + index + "]"));
    }
    return "[" + parts.join(",") + "]";
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(path, "only plain objects are allowed, got " + prototype?.constructor?.name);
    }
    const keys = Object.keys(value).sort();
    const parts: string[] = [];
    for (const key of keys) {
      if (!ASCII_KEY.test(key)) {
        fail(path + "[" + JSON.stringify(key) + "]", "keys must be printable ASCII");
      }
      parts.push(JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key], path + "." + key));
    }
    return "{" + parts.join(",") + "}";
  }
  return fail(path, "unsupported JSON type " + typeof value);
}

/** Serialize a value as a CDJ1 string. Throws CanonicalJsonError otherwise. */
export function canonicalJson(value: unknown): string {
  return canonical(value, "$");
}

/** Lowercase hex sha256 of the UTF-8 bytes of a string. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** sha256 digest of a value in CDJ1 form, prefixed the way contracts store it. */
export function digestOf(value: unknown): string {
  return "sha256:" + sha256Hex(canonicalJson(value));
}
