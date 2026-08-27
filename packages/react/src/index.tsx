import React, { createContext, useContext, useEffect, useState, useCallback, useSyncExternalStore } from "react";
import {
  CrosslinkClient,
  createCrosslinkClient,
  type CrosslinkClientOptions,
  type ConnectionState,
  type RpcClient,
  type PairedAppRecord,
} from "@crosslink/sdk-browser";

export interface CrosslinkContextValue {
  client: CrosslinkClient;
  status: ConnectionState;
  rpc?: RpcClient;
  pairedApps: PairedAppRecord[];
  error?: string | null;
}

const CrosslinkContext = createContext<CrosslinkContextValue | null>(null);

export interface CrosslinkProviderProps {
  children: React.ReactNode;
  /** Existing client instance, or options to create one. */
  client?: CrosslinkClient;
  /** Options to create a new client if `client` is not provided. */
  options?: CrosslinkClientOptions;
  /** Called when authorization is established. */
  onAuthorized?: (rpc: RpcClient, client: CrosslinkClient) => void;
  /** Called when authorization is lost (revoked, offline, reset). */
  onUnauthorized?: () => void;
}

/**
 * CrosslinkProvider creates or accepts a CrosslinkClient and makes it
 * available to the React tree. It does not assume anything about the
 * developer's app structure — it simply provides connectivity primitives.
 */
export function CrosslinkProvider({
  children,
  client: externalClient,
  options,
  onAuthorized,
  onUnauthorized,
}: CrosslinkProviderProps) {
  const [client] = useState<CrosslinkClient>(() => {
    if (externalClient) return externalClient;
    return createCrosslinkClient(options ?? {});
  });

  const [status, setStatus] = useState<ConnectionState>(client.state);
  const [rpc, setRpc] = useState<RpcClient | undefined>(undefined);
  const [pairedApps, setPairedApps] = useState<PairedAppRecord[]>(client.listApps());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = client["onStateChange"]
      ? () => {}
      : undefined;

    // We need to observe state changes. The core SDK uses `onStateChange`
    // in options, not a public event emitter. We'll wrap the client's
    // state observation by polling or by overriding the client's state
    // observer if exposed. Since `CrosslinkClient` exposes `.state` but
    // not an event emitter directly, we use a simple polling approach
    // for framework-agnostic observation.
    const interval = setInterval(() => {
      const s = client.state;
      setStatus(s);
      if (s === "direct" || s === "crosslink-relayed" || s === "lan") {
        try {
          const r = client.rpc();
          setRpc(r);
          onAuthorized?.(r, client);
        } catch {
          setRpc(undefined);
          onUnauthorized?.();
        }
      } else {
        setRpc(undefined);
        if (s === "revoked" || s === "unauthorized") {
          onUnauthorized?.();
        }
      }
      setPairedApps(client.listApps());
    }, 500);

    return () => {
      clearInterval(interval);
    };
  }, [client, onAuthorized, onUnauthorized]);

  const value: CrosslinkContextValue = {
    client,
    status,
    rpc,
    pairedApps,
    error,
  };

  return React.createElement(CrosslinkContext.Provider, { value }, children);
}

/**
 * useCrosslink returns the Crosslink client and derived state.
 * It is the primary hook for React applications consuming Crosslink.
 */
export function useCrosslink(): CrosslinkContextValue {
  const ctx = useContext(CrosslinkContext);
  if (!ctx) {
    throw new Error("useCrosslink must be used within a CrosslinkProvider");
  }
  return ctx;
}

/**
 * useCrosslinkStatus provides the current connection state.
 */
export function useCrosslinkStatus(): ConnectionState {
  return useCrosslink().status;
}

/**
 * useCrosslinkMessage allows subscribing to host events.
 * Returns [subscribe, unsubscribe] pair.
 */
export function useCrosslinkMessage<T = unknown>(
  eventName: string,
  onEvent: (payload: T) => void
): [subscribe: () => () => void, subscribeNow: () => () => void] {
  const { client, rpc } = useCrosslink();

  const subscribe = useCallback(() => {
    if (!rpc) return () => {};
    try {
      return rpc.subscribe(eventName, onEvent as never);
    } catch {
      return () => {};
    }
  }, [client, rpc, eventName, onEvent]);

  const subscribeNow = useCallback(() => {
    return subscribe();
  }, [subscribe]);

  return [subscribe, subscribeNow];
}

export type { CrosslinkClientOptions, ConnectionState, RpcClient, PairedAppRecord };
