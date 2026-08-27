/**
 * Per-machine dev tokens for self-hosted Crosslink services.
 *
 * `npm run stack` and the host SDK both fall back to the tokens stored in
 * `.crosslink-data/dev-tokens.json` (created on first use, mode 0600). This
 * closes the default local relay/signaling services so only processes on this
 * machine — which share the file — can authenticate as a host. Explicit
 * configuration (env vars or config objects) always wins over these fallbacks,
 * and the SDK only applies them when talking to localhost services.
 *
 * Stack config: signaling and relay write their actual ports to
 * `.crosslink-data/stack.json` on startup so apps can auto-discover them
 * without hardcoding ports.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hostname as osHostname } from "node:os";

export interface DevTokens {
  relayToken: string;
  signalingToken: string;
}

const DEV_TOKENS_FILE = "dev-tokens.json";
const DEFAULT_DIR = ".crosslink-data";

function isDevTokens(value: unknown): value is DevTokens {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.relayToken === "string" && typeof v.signalingToken === "string";
}

/**
 * Locate the .crosslink-data directory across monorepo workspaces and sub-apps.
 */
export function findCrosslinkDataDir(customDir?: string): string {
  if (customDir && customDir !== DEFAULT_DIR) {
    return path.resolve(customDir);
  }
  if (process.env.CROSSLINK_DATA_DIR) {
    return path.resolve(process.env.CROSSLINK_DATA_DIR);
  }
  // Walk up from cwd to find an existing .crosslink-data, or the workspace root (.git or package.json with workspaces)
  let curr = path.resolve(process.cwd());
  let rootWithPackage: string | null = null;
  while (true) {
    const candidate = path.join(curr, DEFAULT_DIR);
    if (existsSync(candidate)) {
      return candidate;
    }
    const pkgPath = path.join(curr, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (pkg.workspaces || pkg.name === "crosslink-monorepo") {
          rootWithPackage = curr;
        }
      } catch {}
    }
    const gitPath = path.join(curr, ".git");
    if (existsSync(gitPath) && !rootWithPackage) {
      rootWithPackage = curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  if (rootWithPackage) {
    return path.join(rootWithPackage, DEFAULT_DIR);
  }
  return path.resolve(DEFAULT_DIR);
}

/** Stable per-machine dev tokens; generated once per data dir. */
export function loadOrCreateDevTokens(dir = DEFAULT_DIR): DevTokens {
  const root = findCrosslinkDataDir(dir);
  const file = path.join(root, DEV_TOKENS_FILE);
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (isDevTokens(parsed)) return parsed;
    } catch {
      // Unreadable or corrupted file: regenerate below.
    }
  }
  const tokens: DevTokens = {
    relayToken: randomBytes(32).toString("base64url"),
    signalingToken: randomBytes(32).toString("base64url")
  };
  mkdirSync(root, { recursive: true });
  writeFileSync(file, JSON.stringify(tokens, null, 2) + "\n", { mode: 0o600 });
  return tokens;
}

function urlHost(url: string): string | null {
  try {
    return new URL(url.replace(/^ws/i, "http")).hostname;
  } catch {
    return null;
  }
}

/**
 * True when a URL points at loopback or the local machine (dev defaults),
 * where dev-token fallbacks are safe to apply.
 */
export function isLocalUrl(url: string): boolean {
  const host = urlHost(url);
  if (!host) return false;
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host === osHostname()
  );
}

// ─── stack config ───────────────────────────────────────────────────────────

export interface StackConfig {
  signaling: { port: number };
  relay: { port: number };
}

const STACK_FILE = "stack.json";

function isStackConfig(value: unknown): value is StackConfig {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof (v as any).signaling?.port === "number" &&
    typeof (v as any).relay?.port === "number"
  );
}

/**
 * Read the stack config written by signaling/relay CLIs. Returns null when no
 * config exists or it is unreadable — callers should fall back to defaults.
 */
export function loadStackConfig(dir = DEFAULT_DIR): StackConfig | null {
  const root = findCrosslinkDataDir(dir);
  const file = path.join(root, STACK_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (isStackConfig(parsed)) return parsed;
  } catch {}
  return null;
}

/**
 * Write (or merge) the stack config. Services call this on startup so that
 * apps can discover the actual ports without hardcoding them.
 */
export function writeStackConfig(
  patch: Partial<StackConfig>,
  dir = DEFAULT_DIR
): StackConfig {
  const root = findCrosslinkDataDir(dir);
  mkdirSync(root, { recursive: true });
  const file = path.join(root, STACK_FILE);

  let existing: Partial<StackConfig> = {};
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (isStackConfig(parsed) || (typeof parsed === "object" && parsed !== null)) {
        existing = parsed as Partial<StackConfig>;
      }
    } catch {}
  }

  const merged: StackConfig = {
    signaling: { port: patch.signaling?.port ?? existing.signaling?.port ?? 8081 },
    relay: { port: patch.relay?.port ?? existing.relay?.port ?? 8082 },
  };

  writeFileSync(file, JSON.stringify(merged, null, 2) + "\n");
  return merged;
}

/**
 * Resolve signaling and relay URLs, checking (in order):
 *   1. Explicit config values / env vars
 *   2. Stack config written by running services (.crosslink-data/stack.json)
 *   3. null (no external infrastructure configured — pairing must use LAN/local)
 */
export function resolveServiceUrls(opts: {
  signalingUrl?: string;
  relayUrl?: string;
  signalingEnv?: string;
  relayEnv?: string;
  dir?: string;
}): { signalingUrl: string; relayUrl: string } | null {
  // Explicit values always win
  if (opts.signalingUrl && opts.relayUrl) {
    return { signalingUrl: opts.signalingUrl, relayUrl: opts.relayUrl };
  }

  // Try stack config (written by signaling/relay CLIs)
  const stack = loadStackConfig(opts.dir);
  const defaultHost = "http://127.0.0.1";

  const signalingUrl =
    opts.signalingUrl ??
    opts.signalingEnv ??
    (stack ? `${defaultHost}:${stack.signaling.port}` : "");

  const relayUrl =
    opts.relayUrl ??
    opts.relayEnv ??
    (stack ? `${defaultHost}:${stack.relay.port}` : "");

  // No framework-provided public URLs. Crosslink requires $0 and fully
  // local hosting — pairing works through the local stack (npm run stack)
  // or direct LAN connections without any external infrastructure.
  if (!signalingUrl && !relayUrl) {
    return null;
  }

  return { signalingUrl, relayUrl };
}
