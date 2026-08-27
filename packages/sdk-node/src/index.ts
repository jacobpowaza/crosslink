export { createCrosslinkServer, CrosslinkServer } from "./server.js";
export type {
  CrosslinkServerConfig,
  PairingCodeInfo,
  DeviceSummary,
  ServerEvents,
  ConnectivityStatus,
} from "./server.js";
export {
  FileHostDeviceStore,
  JsonStore,
  loadOrCreateIdentity,
  loadOrCreateIdentitySecurely,
  IDENTITY_SEED_KEY,
  type SecureIdentityResult
} from "./storage.js";
export {
  openSecretStore,
  EncryptedFileSecretStore,
  PlaintextFileSecretStore,
  MemorySecretStore,
  type SecretStore,
  type SecretStoreKind,
  type SecretStoreOptions
} from "./keychain.js";
export { startLanListener, firstLanAddress, resolveLanHost } from "./lan.js";
export { SignalingLink, sha256Hex } from "./signaling-client.js";
export type { SignalingPresence, SignalingLinkOptions } from "./signaling-client.js";
export { RelayChannel } from "./relay-host.js";
export type { RelayChannelInfo, RelayChannelOptions } from "./relay-host.js";
export {
  buildBootstrapUri,
  assertBootstrapUrl,
} from "./bootstrap.js";
export type { BootstrapOptions } from "./bootstrap.js";
// Unwrap/parse helpers are shared with the browser SDK; re-export for
// convenience so host apps don't need a second import.
export { unwrapBootstrapUri, BOOTSTRAP_FRAGMENT_KEY } from "@crosslink/core";
export { NotificationService, type NotificationServiceOptions } from "./notifications.js";
export {
  advertiseMdns,
  browseMdns,
  type MdnsOptions,
  type MdnsHost,
  type MdnsBrowser,
} from "./mdns.js";
