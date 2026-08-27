/**
 * Protocol-level error codes. These travel on the wire and must remain stable;
 * new codes may be appended, existing ones never repurposed.
 */
export const ErrorCodes = {
  PARSE_ERROR: "parse_error",
  INVALID_MESSAGE: "invalid_message",
  VERSION_UNSUPPORTED: "version_unsupported",
  UNAUTHORIZED: "unauthorized",
  CAPABILITY_DENIED: "capability_denied",
  METHOD_NOT_FOUND: "method_not_found",
  VALIDATION_FAILED: "validation_failed",
  PAYLOAD_TOO_LARGE: "payload_too_large",
  RATE_LIMITED: "rate_limited",
  DEVICE_REVOKED: "device_revoked",
  SESSION_EXPIRED: "session_expired",
  PAIRING_EXPIRED: "pairing_expired",
  PAIRING_INVALID: "pairing_invalid",
  HOST_OFFLINE: "host_offline",
  TIMEOUT: "timeout",
  CANCELLED: "cancelled",
  INTERNAL: "internal",
  NOT_CONNECTED: "not_connected",
  PEER_LOST: "peer_lost",
  /** the capability is granted but the grant has lapsed and must be renewed */
  GRANT_EXPIRED: "grant_expired",
  /** the host user declined a per-use confirmation prompt */
  CONSENT_DENIED: "consent_denied",
  /** the host could not obtain a per-use confirmation in time */
  CONSENT_TIMEOUT: "consent_timeout",
  /** host permission policy forbids this, independent of what was granted */
  POLICY_DENIED: "policy_denied"
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export const ALL_ERROR_CODES: readonly string[] = Object.values(ErrorCodes);

export interface WireError {
  code: string;
  message: string;
  data?: unknown;
}

export class CrosslinkError extends Error {
  readonly code: ErrorCode | string;
  readonly data?: unknown;

  constructor(code: ErrorCode | string, message: string, data?: unknown) {
    super(message);
    this.name = "CrosslinkError";
    this.code = code;
    this.data = data;
  }

  toWire(): WireError {
    return { code: this.code, message: this.message, data: this.data };
  }

  static from(err: unknown): CrosslinkError {
    if (err instanceof CrosslinkError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new CrosslinkError(ErrorCodes.INTERNAL, message);
  }

  /** True for codes that must never leak internal detail across the wire. */
  static isInternal(code: string): boolean {
    return (
      code === ErrorCodes.INTERNAL ||
      code === ErrorCodes.PARSE_ERROR ||
      code === ErrorCodes.INVALID_MESSAGE
    );
  }
}
