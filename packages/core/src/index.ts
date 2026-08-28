// Crosslink core — transport-agnostic engine.
export * from "./crypto/primitives.js";
export { DeviceIdentity, DEVICE_ID_PREFIX } from "./identity.js";
export { shortAuthString } from "./sas.js";
export { SessionCipher, type TrafficKeys, type Role } from "./session-cipher.js";
export {
  HANDSHAKE_VERSION,
  clientBeginSession,
  clientCompleteSession,
  hostCompleteSession,
  type TrustedPeerPubs,
  type ClientHandshakeState
} from "./handshake.js";
export {
  CapabilityRegistry,
  DeviceGrants,
  authorizeOrThrow,
  type CapabilityDef,
  type CapabilityRisk,
  type GrantOptions
} from "./capabilities.js";
export {
  noopLogger,
  consoleLogger,
  createLogger,
  redactFields,
  MemoryLogSink,
  LOG_LEVEL_ORDER,
  type Logger,
  type LogLevel,
  type LogFields,
  type LogRecord,
  type LogSink,
  type ConsoleLoggerOptions,
  type CreateLoggerOptions
} from "./logger.js";
export {
  PermissionEngine,
  ConsentBroker,
  DEFAULT_PERMISSION_POLICY,
  type PermissionPolicy,
  type PolicyContext,
  type PolicyDecision,
  type DenyReason,
  type ConsentBrokerOptions,
  type ConsentDecision,
  type ConsentPrompt,
  type ConsentRequest
} from "./permissions.js";
export { miniValidator, type MiniSchema, type Validator } from "./schema.js";
export {
  createMemoryPair,
  MemoryListener,
  type ConnectionKind,
  type CrosslinkTransport,
  type MemoryTransportOptions
} from "./transport.js";
export {
  CrosslinkSession,
  type SessionMeta,
  type SessionHandlers,
  type SessionOptions
} from "./session.js";
export {
  RpcRouter,
  newRequestId,
  type RpcRouterDeps,
  type ExposeOptions,
  type EventOptions,
  type RpcContext,
  type RpcHandler
} from "./rpc/server.js";
export { RpcClient, type CallOptions } from "./rpc/client.js";
export {
  HostAcceptor,
  type AcceptorDeps,
  type AcceptorCallbacks
} from "./connection/host-acceptor.js";
export {
  ClientLink,
  type ClientLinkOptions,
  type ConnectionState,
  type TransportCandidate
} from "./connection/client-link.js";
export {
  InMemoryHostDeviceStore,
  InMemoryClientAppStore,
  cascadeRevokeLinked,
  createPairingSession,
  generatePairingCode,
  normalizePairingCode,
  pairingTranscriptBytes,
  PAIRING_TRANSCRIPT,
  DEVICE_LINK_RPC_METHOD,
  type ClientAppStore,
  type HostDeviceStore,
  type PairedAppRecord,
  type PairingSessionState,
  type TrustedDeviceRecord
} from "./pairing/types.js";
export {
  HostPairingManager,
  type HostPairingOptions,
  type PairingApproval,
  type PairingApprovalRequest
} from "./pairing/host.js";
export {
  createClaim,
  signClaim,
  processChallenge,
  type ClientPairingConfirmRequest,
  type ClientPairingState
} from "./pairing/client.js";
export {
  buildPairingUri,
  normalPairingTarget,
  linkPairingTarget,
  parsePairingUri,
  fingerprint16,
  normalizeCode,
  unwrapBootstrapUri,
  BOOTSTRAP_FRAGMENT_KEY,
  PAIRING_URI_SCHEME,
  PAIRING_URI_VERSION,
  type ParsedPairingUri,
  type BuildPairingUriInput
} from "./pairing/uri.js";
export {
  ENDPOINT_KINDS,
  ENDPOINT_PREFERENCE,
  encodeEndpoints,
  decodeEndpoints,
  filterEndpoints,
  sortEndpoints,
  isValidEndpointUrl,
  isLoopbackHost,
  isHostDirectKind,
  HOST_DIRECT_KINDS,
  toWebSocketUrl,
  toHttpUrl,
  type EndpointKind,
  type PairingEndpoint
} from "./pairing/endpoints.js";
export {
  deviceIdFromPublicKey,
  fingerprintFromPublicKey
} from "./pairing/device-id.js";
export {
  NOTIFICATION_EVENT,
  type NotificationPayload,
  type NotificationChannelDef
} from "./notifications.js";
