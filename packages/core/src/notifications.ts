/**
 * Notification types shared by host and client.
 *
 * Notifications travel over the existing Crosslink encrypted session as
 * typed event payloads — no extra transport needed. The host publishes
 * notifications via the RPC router; the client subscribes and surfaces
 * them through the platform-native notification API (Web Notifications,
 * mobile push, etc.).
 */

export interface NotificationPayload {
  /** Unique id for dedup / ack. */
  id: string;
  /** Channel / topic for filtering (e.g. "tasks", "alerts"). */
  channel: string;
  /** Human-readable title. */
  title: string;
  /** Body text. */
  body: string;
  /** Optional deep-link or action URL. */
  url?: string;
  /** Arbitrary metadata. */
  data?: Record<string, unknown>;
  /** Unix-ms timestamp; client fills if omitted. */
  timestamp: number;
}

export interface NotificationChannelDef {
  id: string;
  title: string;
  /** Default capability required to receive on this channel. */
  defaultCapability?: string;
}

/** Well-known event name used for notification fan-out. */
export const NOTIFICATION_EVENT = "crosslink.notification";
