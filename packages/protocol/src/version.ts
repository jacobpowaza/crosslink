/**
 * Crosslink protocol versioning.
 *
 * Versions are MAJOR.MINOR strings. Implementations MUST negotiate the highest
 * mutually supported version during hello and MUST refuse to operate below
 * MIN_SECURE_VERSION (no silent downgrade).
 */
export const PROTOCOL_VERSION = "1.0";
export const MIN_SECURE_VERSION = "1.0";

export const SUPPORTED_VERSIONS: readonly string[] = [PROTOCOL_VERSION];

const VERSION_RE = /^(\d+)\.(\d+)$/;

export function parseVersion(v: unknown): { major: number; minor: number } | null {
  if (typeof v !== "string") return null;
  const m = VERSION_RE.exec(v);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new TypeError(`invalid version: ${JSON.stringify([a, b])}`);
  return pa.major !== pb.major ? pa.major - pb.major : pa.minor - pb.minor;
}

/** Highest version supported by both lists, or null when incompatible. */
export function negotiateVersions(
  offered: readonly string[],
  supported: readonly string[]
): string | null {
  const mutual = [...offered]
    .filter((v) => supported.includes(v))
    .sort(compareVersions);
  return mutual.length ? mutual[mutual.length - 1] : null;
}

export function versionAtLeast(v: string, floor: string): boolean {
  return compareVersions(v, floor) >= 0;
}
