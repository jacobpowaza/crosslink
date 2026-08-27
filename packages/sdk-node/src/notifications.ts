/**
 * Host-side notification helper.
 *
 * Wraps the Crosslink event system to send typed notifications to all
 * connected and subscribed clients. Notifications travel over the existing
 * encrypted session — no extra transport needed.
 */
import { randomBytes } from "node:crypto";
import type { CrosslinkServer } from "./server.js";
import {
  NOTIFICATION_EVENT,
  type NotificationPayload,
  type NotificationChannelDef,
} from "@crosslink/core";

export interface NotificationServiceOptions {
  /** Channels this service will publish on. */
  channels?: NotificationChannelDef[];
}

export class NotificationService {
  private readonly channels = new Map<string, NotificationChannelDef>();

  constructor(
    private readonly server: CrosslinkServer,
    opts: NotificationServiceOptions = {}
  ) {
    for (const ch of opts.channels ?? []) {
      this.channels.set(ch.id, ch);
    }
  }

  /** Register a channel for sending notifications on. */
  addChannel(def: NotificationChannelDef): void {
    this.channels.set(def.id, def);
  }

  /** Send a notification to all subscribed clients. */
  send(channel: string, title: string, body: string, data?: Record<string, unknown>): void {
    const payload: NotificationPayload = {
      id: randomBytes(8).toString("hex"),
      channel,
      title,
      body,
      data,
      timestamp: Date.now(),
    };
    this.server.emit(NOTIFICATION_EVENT, payload);
  }

  /** Convenience: send with a URL action. */
  sendWithUrl(
    channel: string,
    title: string,
    body: string,
    url: string,
    data?: Record<string, unknown>
  ): void {
    const payload: NotificationPayload = {
      id: randomBytes(8).toString("hex"),
      channel,
      title,
      body,
      url,
      data,
      timestamp: Date.now(),
    };
    this.server.emit(NOTIFICATION_EVENT, payload);
  }
}
