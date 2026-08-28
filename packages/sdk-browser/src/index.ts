/* ================================================================
   Crosslink Browser SDK — Framework-independent core primitives
   ================================================================ */
export { CrosslinkClient } from "./client.js";
// Re-exported so a browser app can turn on structured logging without taking
// a direct dependency on @crosslink/core.
export {
  consoleLogger,
  createLogger,
  noopLogger,
  MemoryLogSink,
  type Logger,
  type LogLevel,
  type LogRecord
} from "@crosslink/core";
export { MockSocket } from "./mock-ws.js";
export type { CrosslinkClientOptions, PairingConfirmRequest } from "./client.js";
// Re-export framework-independent primitives from core for framework bindings
export {
  type ConnectionState,
  type RpcClient,
  type PairedAppRecord,
} from "@crosslink/core";
export {
  MemorySecureStorage,
  LocalStorageSecureStorage,
  JsonStore,
  type SecureStorage,
} from "./storage.js";
export {
  createSecureStorage,
  IndexedDbSecureStorage,
  HydratedSecureStorage,
  AsyncStorageAdapter,
  type AsyncSecureStorage,
  type CreateSecureStorageOptions,
  type SecureStorageResult
} from "./secure-storage.js";
export { SignalingPeer } from "./signaling-peer.js";
export { wsTransport, type WsLike } from "./ws.js";
export { NotificationHandler, type NotificationHandlerOptions } from "./notifications.js";
/* -------------------------------------------------------------
   Crosslink-owned UI: the pairing widget, the mobile bootstrap
   screens, the offline shell and the service-worker generator.
   These are framework-independent — React, Vue, Svelte and plain
   pages all mount the same implementation — and they are the
   experience Crosslink ships, not a starting point applications
   are expected to reimplement. What an application configures is
   its name, its icon and its colours.
   ------------------------------------------------------------- */
export {
  PairingCard,
  createPairingCard,
  injectPairingCardStyles,
  normalizeNetworkMode,
  type PairingCardOptions,
  type PairingCardState,
  type PairingCardTheme,
  type PairingCardEndpoint,
  type NetworkMode
} from "./ui/pairing-card.js";
export {
  createHttpPairingSource,
  CONTROL_ROUTES,
  type PairingSession,
  type PairingSource,
  type PairingSourceEvent
} from "./ui/pairing-source.js";
export {
  crosslinkLogoSvg,
  createCrosslinkLogo,
  resolveCrosslinkTheme,
  contrastRatio,
  parseColor,
  CROSSLINK_LOGO_PATH,
  CROSSLINK_LOGO_VIEWBOX,
  CROSSLINK_REPOSITORY,
  CROSSLINK_ATTRIBUTION_TEXT,
  CROSSLINK_ATTRIBUTION_LINK_TEXT,
  LOGO_MIN_CONTRAST,
  ATTRIBUTION_MIN_CONTRAST,
  type CrosslinkTheme,
  type ResolvedCrosslinkTheme,
  type CrosslinkLogoOptions
} from "./ui/branding.js";
export {
  PoweredByCrosslink,
  createPoweredByCrosslink,
  type PoweredByCrosslinkOptions,
  type PoweredByPlacement
} from "./ui/powered-by-crosslink.js";

export {
  CrosslinkOfflineShell,
  createOfflineUI,
  updateOfflineStatus,
  removeOfflineUI,
  DEFAULT_OFFLINE_CONFIG,
  type OfflineConfig,
  type OfflineShellOptions,
  type OfflineConnectionState,
  type HostReachabilityResult,
  CrosslinkMobileBootstrap,
  isStandalone,
  resetDeviceStorage,
  injectBootstrapStyles,
  INSTALL_HANDOFF_QUERY_KEY,
  INSTALL_HANDOFF_COOKIE,
  INSTALL_HANDOFF_CONTEXT_COOKIE,
  type MobileBootstrapState,
  type MobileBootstrapOptions,
  type OnboardingConfig,
  generateServiceWorker,
  DEFAULT_SERVICE_WORKER,
  DEFAULT_SERVICE_WORKER_CONFIG,
  createServiceWorkerConfig,
  type ServiceWorkerConfig,
  describeBootstrapEnvironment,
  type BootstrapEnvironment
} from "./offline/index.js";

/** Browser entry convenience: default storage = localStorage. */
import { LocalStorageSecureStorage } from "./storage.js";
import { CrosslinkClient, type CrosslinkClientOptions } from "./client.js";
import type { SecureStorage } from "./storage.js";

export function createCrosslinkClient(
  options: Omit<CrosslinkClientOptions, "storage"> & { storage?: SecureStorage } = {}
): CrosslinkClient {
  const storage =
    options.storage ??
    (typeof localStorage !== "undefined"
      ? new LocalStorageSecureStorage(localStorage)
      : undefined);
  return new CrosslinkClient({ ...options, storage });
}

/**
 * Preferred browser entry point: identity and paired-app records are encrypted
 * at rest under a non-extractable WebCrypto key. Use `createCrosslinkClient`
 * only when you are supplying your own storage or need a synchronous factory.
 */
export function createSecureCrosslinkClient(
  options: Omit<CrosslinkClientOptions, "storage"> & {
    allowPlaintextFallback?: boolean;
  } = {}
): Promise<CrosslinkClient> {
  return CrosslinkClient.create(options);
}
export {
  DirectPairingChannel,
  BrokeredPairingChannel,
  type PairingChannel,
  type PairingHostInfo,
  type ResolvedPairingSession
} from "./pairing-channel.js";
