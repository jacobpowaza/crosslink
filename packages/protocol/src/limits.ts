/**
 * Wire limits. Every implementation MUST enforce these by default;
 * operators may tighten but not loosen beyond documented maxima.
 */
export const Limits = {
  DEFAULT_MAX_FRAME_BYTES: 4 * 1024 * 1024,
  MAX_FRAME_BYTES_HARD: 16 * 1024 * 1024,
  DEFAULT_CHUNK_BYTES: 256 * 1024,
  DEFAULT_REQUEST_TIMEOUT_MS: 30_000,
  DEFAULT_MAX_INFLIGHT: 32,
  DEFAULT_RATE_PER_SEC: 50,
  PAIRING_CODE_TTL_MS: 120_000,
  HEARTBEAT_INTERVAL_MS: 15_000,
  HEARTBEAT_TIMEOUT_MS: 45_000,
  CLOCK_SKEW_MS: 120_000
} as const;
