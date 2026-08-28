/**
 * React bindings for Crosslink.
 *
 * Thin by design: the client is framework-agnostic and already owns pairing,
 * reconnection and transport selection, so these hooks only subscribe to it.
 * They add no state machine of their own, and nothing here polls — the client
 * publishes state changes and `useSyncExternalStore` renders on them, so a
 * connection that goes down is reflected on the same tick rather than up to
 * half a second later.
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from "react";
import {
  CrosslinkClient,
  createCrosslinkClient,
  type ConnectionState,
  type CrosslinkClientOptions,
  type PairedAppRecord,
  type RpcClient
} from "@crosslink/sdk-browser";

/** States in which an authenticated RPC channel exists. */
const CONNECTED_STATES: readonly ConnectionState[] = ["direct", "crosslink-relayed", "turn-relayed"];

export function isConnected(state: ConnectionState): boolean {
  return CONNECTED_STATES.includes(state);
}

export interface CrosslinkContextValue {
  client: CrosslinkClient;
  state: ConnectionState;
  /** Present exactly when `state` is a connected one. */
  rpc: RpcClient | null;
  pairedApps: PairedAppRecord[];
  connected: boolean;
}

const CrosslinkContext = createContext<CrosslinkContextValue | null>(null);

export interface CrosslinkProviderProps {
  children: ReactNode;
  /** An existing client. Takes precedence over `options`. */
  client?: CrosslinkClient;
  /** Options used to create a client when one is not supplied. */
  options?: CrosslinkClientOptions;
  onAuthorized?: (rpc: RpcClient, client: CrosslinkClient) => void;
  onUnauthorized?: (state: ConnectionState) => void;
}

export function CrosslinkProvider({
  children,
  client: externalClient,
  options,
  onAuthorized,
  onUnauthorized
}: CrosslinkProviderProps): ReactNode {
  const [client] = useState(() => externalClient ?? createCrosslinkClient(options ?? {}));
  const state = useCrosslinkClientState(client);
  const connected = isConnected(state);

  // The callbacks are read through a ref so that a caller passing inline
  // arrow functions — the normal thing to do — does not re-fire the effect on
  // every render and report the same transition repeatedly.
  const callbacks = useRef({ onAuthorized, onUnauthorized });
  callbacks.current = { onAuthorized, onUnauthorized };

  const rpc = useMemo(() => {
    if (!connected) return null;
    try {
      return client.rpc();
    } catch {
      return null;
    }
  }, [client, connected, state]);

  useEffect(() => {
    if (rpc) callbacks.current.onAuthorized?.(rpc, client);
    else if (state === "revoked" || state === "unauthorized") {
      callbacks.current.onUnauthorized?.(state);
    }
  }, [client, rpc, state]);

  const value = useMemo<CrosslinkContextValue>(
    () => ({ client, state, rpc, connected, pairedApps: client.listApps() }),
    [client, state, rpc, connected]
  );

  return createElement(CrosslinkContext.Provider, { value }, children);
}

export function useCrosslink(): CrosslinkContextValue {
  const ctx = useContext(CrosslinkContext);
  if (!ctx) throw new Error("useCrosslink must be used inside a <CrosslinkProvider>");
  return ctx;
}

export function useCrosslinkState(): ConnectionState {
  return useCrosslink().state;
}

/** The RPC channel while one exists, or null. */
export function useCrosslinkRpc(): RpcClient | null {
  return useCrosslink().rpc;
}

/**
 * Subscribes to a host event for as long as the component is mounted and the
 * connection is up. Resubscribes automatically after a reconnect, because the
 * subscription belongs to the session that just went away.
 */
export function useCrosslinkEvent<T = unknown>(
  eventName: string,
  onEvent: (payload: T) => void
): void {
  const { rpc } = useCrosslink();
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!rpc) return;
    const unsubscribe = rpc.subscribe(eventName, ((payload: T) => handler.current(payload)) as never);
    return () => {
      unsubscribe();
    };
  }, [rpc, eventName]);
}

/**
 * Calls a host method and tracks its lifecycle.
 *
 * A call started before the connection is up is refused rather than queued
 * here — the client already queues and replays calls across a reconnect, and a
 * second queue in the view layer would reorder them.
 */
export function useCrosslinkCall<T = unknown>(): {
  call(method: string, params?: unknown): Promise<T>;
  pending: boolean;
  error: Error | null;
} {
  const { rpc } = useCrosslink();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);

  const call = useCallback(
    async (method: string, params?: unknown): Promise<T> => {
      if (!rpc) throw new Error("not connected");
      setPending(true);
      setError(null);
      try {
        return await rpc.call<T>(method, params as never);
      } catch (err) {
        if (mounted.current) setError(err as Error);
        throw err;
      } finally {
        if (mounted.current) setPending(false);
      }
    },
    [rpc]
  );

  return { call, pending, error };
}

/** Subscribes to a client's state without needing a provider. */
export function useCrosslinkClientState(client: CrosslinkClient): ConnectionState {
  const subscribe = useCallback(
    (notify: () => void) => client.onStateChange(() => notify()),
    [client]
  );
  const snapshot = useCallback(() => client.state, [client]);
  // Server rendering has no client connection; "offline" is the honest answer
  // and matches what the first client render sees before anything connects.
  return useSyncExternalStore(subscribe, snapshot, () => "offline" as ConnectionState);
}

export type { ConnectionState, CrosslinkClientOptions, PairedAppRecord, RpcClient };
export { CrosslinkClient };
