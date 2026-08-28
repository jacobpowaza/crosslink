export interface ConformanceCase {
  name: string;
  obj: unknown;
  canonical: string;
  frame_hex: string;
}

export interface InvalidConformanceCase {
  name: string;
  utf8: string;
  error: string;
}

export interface ConformanceCorpus {
  version: number;
  cases: ConformanceCase[];
  invalid: InvalidConformanceCase[];
}

/** Minimal surface every language SDK implements before transport concerns. */
export interface ProtocolAdapter {
  canonicalJson(value: unknown): string;
  encodeFrame(value: object): Uint8Array;
  decodeMessage(bytes: Uint8Array): unknown;
  errorCode(error: unknown): string | undefined;
}

export interface ConformanceFailure {
  case: string;
  operation: "canonical" | "frame" | "decode" | "negative";
  expected: string;
  actual: string;
}

export interface ConformanceReport {
  passed: number;
  failed: number;
  failures: ConformanceFailure[];
}

export function runConformance(
  adapter: ProtocolAdapter,
  corpus: ConformanceCorpus
): ConformanceReport {
  if (corpus.version !== 1) throw new Error(`unsupported conformance corpus ${corpus.version}`);
  const failures: ConformanceFailure[] = [];
  let passed = 0;
  for (const fixture of corpus.cases) {
    passed += check(failures, fixture.name, "canonical", fixture.canonical, () =>
      adapter.canonicalJson(fixture.obj)
    );
    passed += check(failures, fixture.name, "frame", fixture.frame_hex, () =>
      toHex(adapter.encodeFrame(fixture.obj as object))
    );
    passed += check(failures, fixture.name, "decode", fixture.canonical, () =>
      adapter.canonicalJson(adapter.decodeMessage(new TextEncoder().encode(fixture.canonical)))
    );
  }
  for (const fixture of corpus.invalid) {
    try {
      adapter.decodeMessage(new TextEncoder().encode(fixture.utf8));
      failures.push({
        case: fixture.name,
        operation: "negative",
        expected: fixture.error,
        actual: "accepted"
      });
    } catch (error) {
      const actual = adapter.errorCode(error) ?? "unknown";
      if (actual === fixture.error) passed += 1;
      else failures.push({
        case: fixture.name,
        operation: "negative",
        expected: fixture.error,
        actual
      });
    }
  }
  return { passed, failed: failures.length, failures };
}

function check(
  failures: ConformanceFailure[],
  name: string,
  operation: ConformanceFailure["operation"],
  expected: string,
  action: () => string
): number {
  try {
    const actual = action();
    if (actual === expected) return 1;
    failures.push({ case: name, operation, expected, actual });
  } catch (error) {
    failures.push({ case: name, operation, expected, actual: `threw: ${String(error)}` });
  }
  return 0;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
