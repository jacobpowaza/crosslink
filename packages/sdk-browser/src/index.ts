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
   Optional framework integrations: pairing UI, bootstrap screens,
   offline shell, service-worker generator. These are independent
   of any frontend framework and can be used with React, Vue,
   Svelte, vanilla JS, etc., or replaced entirely by the developer.
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
  type MobileBootstrapState,
  type MobileBootstrapOptions,
  type OnboardingConfig,
  generateServiceWorker,
  DEFAULT_SERVICE_WORKER,
  DEFAULT_SERVICE_WORKER_CONFIG,
  createServiceWorkerConfig,
  type ServiceWorkerConfig
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
