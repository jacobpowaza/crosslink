/**
 * Browser-side notification handler.
 *
 * Subscribes to the Crosslink notification event over an established session
 * and surfaces payloads via the Web Notifications API (or a custom handler).
 * Falls back gracefully when Notifications are unavailable (e.g. SSR, denied
 * permission).
 */
import type { RpcClient } from "@crosslink/core";
import { NOTIFICATION_EVENT, type NotificationPayload } from "@crosslink/core";

export interface NotificationHandlerOptions {
  /** If true, automatically request Notification.permission on construction. */
  autoRequestPermission?: boolean;
  /** Custom handler; when provided, bypasses the Web Notifications API. */
  onNotification?(payload: NotificationPayload): void;
  /** Called when a notification is clicked (Web Notifications click event). */
  onClick?(payload: NotificationPayload): void;
}

export class NotificationHandler {
  private unsub?: () => void;
  private seen = new Set<string>();

  constructor(private readonly options: NotificationHandlerOptions = {}) {}

  /**
   * Begin listening for notifications over an RPC client.
   * Returns an unsubscribe function.
   */
  start(rpc: RpcClient): () => void {
    if (this.options.autoRequestPermission && typeof Notification !== "undefined") {
      Notification.requestPermission();
    }

    this.unsub = rpc.subscribe(
      NOTIFICATION_EVENT as never,
      ((payload: NotificationPayload) => {
        if (!payload.id || this.seen.has(payload.id)) return;
        this.seen.add(payload.id);
        this.deliver(payload);
      }) as never
    );
    return () => this.stop();
  }

  stop(): void {
    this.unsub?.();
    this.unsub = undefined;
  }

  private deliver(payload: NotificationPayload): void {
    if (this.options.onNotification) {
      this.options.onNotification(payload);
      return;
    }
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;

    const n = new Notification(payload.title, {
      body: payload.body,
      tag: payload.id,
      icon: payload.url
    });
    n.onclick = () => {
      this.options.onClick?.(payload);
      if (payload.url) window.open(payload.url, "_blank");
      n.close();
    };
  }
}
