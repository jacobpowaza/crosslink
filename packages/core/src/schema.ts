/**
 * Minimal runtime schema validation for inputs crossing the trust boundary.
 *
 * Compile-time types are never enough for data arriving over the network.
 * This validator covers common shapes; applications may instead supply any
 * custom validate function (Zod, JSON Schema + Ajv, Protocol Buffers, ...).
 */
import { CrosslinkError, ErrorCodes } from "@crosslink/protocol";

export type MiniSchema =
  | { type: "string"; minLen?: number; maxLen?: number; pattern?: string }
  | { type: "number"; min?: number; max?: number; int?: boolean }
  | { type: "boolean" }
  | { type: "array"; items?: MiniSchema; maxItems?: number }
  | { type: "object"; properties?: Record<string, MiniSchema>; required?: string[] }
  | { type: "any" };

export type Validator = (value: unknown) => CrosslinkError | null;

export function miniValidator(schema: MiniSchema): Validator {
  assertKnownSchemaKeys(schema, "$");
  return (value) => check(schema, value, "$");
}

const KNOWN_KEYS: Record<string, readonly string[]> = {
  string: ["type", "minLen", "maxLen", "pattern"],
  number: ["type", "min", "max", "int"],
  boolean: ["type"],
  array: ["type", "items", "maxItems"],
  object: ["type", "properties", "required"],
  any: ["type"]
};

/**
 * Rejects a schema containing keys this validator does not implement.
 *
 * A misspelled constraint — `maxLength` where the field is `maxLen` — otherwise
 * validates nothing at all, silently, and the input it was meant to bound
 * crosses the trust boundary unchecked. Failing at registration turns that into
 * an error the developer sees once, rather than a hole nobody sees at all.
 */
function assertKnownSchemaKeys(schema: MiniSchema, path: string): void {
  const known = KNOWN_KEYS[schema.type];
  if (!known) {
    throw new TypeError(`unknown schema type at ${path}: ${String((schema as { type: string }).type)}`);
  }
  for (const key of Object.keys(schema)) {
    if (!known.includes(key)) {
      throw new TypeError(
        `unknown key "${key}" in ${schema.type} schema at ${path} ` +
          `(expected one of: ${known.join(", ")})`
      );
    }
  }
  if (schema.type === "array" && schema.items) {
    assertKnownSchemaKeys(schema.items, `${path}[]`);
  }
  if (schema.type === "object" && schema.properties) {
    for (const [name, sub] of Object.entries(schema.properties)) {
      assertKnownSchemaKeys(sub, `${path}.${name}`);
    }
  }
}

function check(schema: MiniSchema, value: unknown, path: string): CrosslinkError | null {
  switch (schema.type) {
    case "any":
      return null;
    case "string": {
      if (typeof value !== "string") return fail(path, "expected string");
      if (schema.minLen !== undefined && value.length < schema.minLen) {
        return fail(path, `shorter than ${schema.minLen}`);
      }
      if (schema.maxLen !== undefined && value.length > schema.maxLen) {
        return fail(path, `longer than ${schema.maxLen}`);
      }
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
        return fail(path, "pattern mismatch");
      }
      return null;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return fail(path, "expected finite number");
      }
      if (schema.int && !Number.isInteger(value)) return fail(path, "expected integer");
      if (schema.min !== undefined && value < schema.min) return fail(path, `below ${schema.min}`);
      if (schema.max !== undefined && value > schema.max) return fail(path, `above ${schema.max}`);
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : fail(path, "expected boolean");
    case "array": {
      if (!Array.isArray(value)) return fail(path, "expected array");
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return fail(path, `more than ${schema.maxItems} items`);
      }
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          const err = check(schema.items, value[i], `${path}[${i}]`);
          if (err) return err;
        }
      }
      return null;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return fail(path, "expected object");
      }
      const obj = value as Record<string, unknown>;
      const props = schema.properties ?? {};
      for (const key of Object.keys(obj)) {
        if (!(key in props)) {
          return fail(`${path}.${key}`, "unexpected property");
        }
      }
      for (const [key, sub] of Object.entries(props)) {
        if (obj[key] === undefined) continue;
        const err = check(sub, obj[key], `${path}.${key}`);
        if (err) return err;
      }
      for (const key of schema.required ?? []) {
        if (obj[key] === undefined) return fail(`${path}.${key}`, "missing required property");
      }
      return null;
    }
  }
}

function fail(path: string, why: string): CrosslinkError {
  return new CrosslinkError(ErrorCodes.VALIDATION_FAILED, `${path}: ${why}`);
}
