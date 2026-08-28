export { createCrosslinkServer, CrosslinkServer, composeCrosslinkHost } from "./server.js";
export type {
  ApplicationBranding,
  MobileAppConfig,
  CrosslinkServerConfig,
  OfflineConfig,
  PwaConfig,
  PairingNetworkMode,
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
  buildInstallManifestUrl,
  buildInstallStartUrl,
  INSTALL_HANDOFF_QUERY_KEY,
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

/* -------------------------------------------------------------
   Crosslink-owned HTTP surfaces. `createCrosslinkServer` mounts
   the bootstrap automatically when `mobile.entry` is set; these
   exports are for hosts that already run their own server and
   want to mount the same handlers themselves.
   ------------------------------------------------------------- */
export {
  createBootstrapHandler,
  injectBootstrap,
  renderInjectedHead,
  bootstrapPrecacheAssets,
  isSecureContextRequest,
  type BootstrapHostView,
  type BootstrapHandlerOptions
} from "./mobile/bootstrap-host.js";
export {
  createControlHandler,
  isLoopbackRequest,
  type ControlHostView,
  type ControlEvent,
  type ControlHandlerOptions
} from "./mobile/control-host.js";
export { renderBootScript, type BootPayload } from "./mobile/boot-script.js";
export { readBrowserBundle, renderIconPng, renderMarkSvg } from "./mobile/assets.js";
export {
  writeStaticBootstrap,
  STATIC_PRECACHE,
  type StaticBootstrapOptions,
  type StaticBootstrapResult
} from "./mobile/static-bootstrap.js";
