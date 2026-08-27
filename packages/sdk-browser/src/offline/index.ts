/**
 * Crosslink Offline Shell — Framework-level offline/fail-state system for PWAs.
 *
 * @packageDocumentation
 */
export {
  CrosslinkOfflineShell,
  createOfflineUI,
  updateOfflineStatus,
  removeOfflineUI,
  DEFAULT_OFFLINE_CONFIG,
  type OfflineConfig,
  type OfflineShellOptions,
  type OfflineConnectionState,
  type HostReachabilityResult
} from "./offline-shell.js";

export {
  CrosslinkMobileBootstrap,
  isStandalone,
  resetDeviceStorage,
  injectBootstrapStyles,
  type MobileBootstrapState,
  type MobileBootstrapOptions,
  type OnboardingConfig
} from "./mobile-bootstrap.js";

export {
  generateServiceWorker,
  DEFAULT_SERVICE_WORKER,
  DEFAULT_SERVICE_WORKER_CONFIG,
  createServiceWorkerConfig,
  type ServiceWorkerConfig
} from "./service-worker.js";