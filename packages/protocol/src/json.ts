/**
 * Canonical JSON: deterministic serialization used wherever bytes must be
 * stable across implementations — transcript hashing, signatures, fixtures.
 *
 * Rules:
 *  - object keys sorted lexicographically (by UTF-16 code unit)
 *  - no insignificant whitespace
 *  - undefined-valued object keys omitted
 *  - non-finite numbers and BigInt rejected (not representable interoperably)
 */

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonicalJson: non-finite number");
    }
    return String(value);
  }
  if (t === "bigint") {
    throw new TypeError("canonicalJson: bigint not allowed");
  }
  if (t === "string") return JSON.stringify(value as string);
  if (Array.isArray(value)) {
    let out = "[";
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out += ",";
      out += serialize(value[i]);
    }
    return out + "]";
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    let out = "{";
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) out += ",";
      out += `${JSON.stringify(keys[i])}:${serialize(obj[keys[i]])}`;
    }
    return out + "}";
  }
  throw new TypeError(`canonicalJson: unsupported type ${t}`);
}
