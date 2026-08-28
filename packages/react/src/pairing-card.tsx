/**
 * React binding for the canonical Crosslink pairing card.
 *
 * A thin adapter on purpose. `createPairingCard` is the pairing UI for every
 * Crosslink application, and it is framework-independent DOM; this component
 * owns nothing but the mount point and the effect that ties the card's lifetime
 * to the component's. Re-rendering the pairing screen with React elements would
 * produce a second implementation to keep in step with the vanilla one — the
 * duplication the shared card exists to remove.
 */
import { createElement, useEffect, useRef, type CSSProperties } from "react";
import {
  createPairingCard,
  type PairingCard,
  type PairingCardOptions,
  type PairingSession
} from "@crosslink/sdk-browser";

export interface CrosslinkPairingCardProps
  extends Omit<PairingCardOptions, "target" | "onSession" | "onDeviceConnected" | "onError"> {
  className?: string;
  style?: CSSProperties;
  onSession?: (session: PairingSession) => void;
  onDeviceConnected?: (deviceId?: string) => void;
  onError?: (error: Error) => void;
}

export function CrosslinkPairingCard(props: CrosslinkPairingCardProps): ReturnType<typeof createElement> {
  const { className, style, ...options } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<PairingCard | null>(null);

  // Callbacks go through a ref so an inline arrow prop — the normal way to
  // write these — does not tear down and rebuild the card on every render,
  // which would mint a new pairing code each time the parent re-rendered.
  const callbacks = useRef({
    onSession: props.onSession,
    onDeviceConnected: props.onDeviceConnected,
    onError: props.onError
  });
  callbacks.current = {
    onSession: props.onSession,
    onDeviceConnected: props.onDeviceConnected,
    onError: props.onError
  };

  const { source, appName, appIcon, blurb, networkMode, refreshLeadSeconds } = options;
  const brand = options.brand;

  useEffect(() => {
    const target = hostRef.current;
    if (!target) return;
    const card = createPairingCard({
      target,
      source,
      appName,
      appIcon,
      brand,
      blurb,
      networkMode,
      refreshLeadSeconds,
      onSession: (session) => callbacks.current.onSession?.(session),
      onDeviceConnected: (deviceId) => callbacks.current.onDeviceConnected?.(deviceId),
      onError: (error) => callbacks.current.onError?.(error)
    });
    cardRef.current = card;
    return () => {
      card.destroy();
      cardRef.current = null;
    };
  }, [
    source,
    appName,
    appIcon,
    brand?.accentColor,
    brand?.backgroundColor,
    brand?.textColor,
    brand?.appearance,
    blurb,
    networkMode,
    refreshLeadSeconds
  ]);

  return createElement("div", { ref: hostRef, className, style });
}


