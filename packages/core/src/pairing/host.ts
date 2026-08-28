/**
 * Host-side pairing state machine.
 *
 * Pairing frames travel over a control pipe (signaling-relayed opaque blobs or
 * a direct LAN socket). Every frame is individually signed; codes are
 * single-use and short-lived; trust comes from fingerprint pinning plus the
 * Short Authentication String shown on both devices.
 */
import {
  CrosslinkError,
  ErrorCodes,
  Limits,
  base64ToBytes,
  bytesToBase64,
} from "@crosslink/protocol";
import type { CapabilityRegistry, DeviceGrants } from "../capabilities.js";

/** Incorrect direct-pairing code guesses tolerated inside the window. */
const MAX_FAILED_RESOLVES = 8;
const FAILED_RESOLVE_WINDOW_MS = 60_000;

import { randomBytes, verifySignature } from "../crypto/primitives.js";
import type { DeviceIdentity } from "../identity.js";
import { noopLogger, type Logger } from "../logger.js";
import { PermissionEngine, type PermissionPolicy, type PolicyDecision } from "../permissions.js";
import { shortAuthString } from "../sas.js";
import { deviceIdFromPublicKey } from "./device-id.js";
import {
  createPairingSession,
  normalizePairingCode,
  pairingTranscriptBytes,
  type HostDeviceStore,
  type PairingSessionState,
  type TrustedDeviceRecord,
} from "./types.js";

/**
 * What the host user is being asked to decide. `requestedCaps` is what the
 * *policy* is willing to hand over, not the raw client request - anything the
 * policy refused is reported in `deniedCaps` for display only.
 */
export interface PairingApprovalRequest {
  sas: string;
  deviceName: string;
  deviceId: string;
  /** capabilities the policy permits, pending this decision */
  requestedCaps: string[];
  /** subset of `requestedCaps` the policy insists a human decide on */
  requiresExplicitApproval: string[];
  /** what the policy refused outright, with reasons, for display */
  deniedCaps: Array<{ id: string; reason: string }>;
}

/**
 * `true`  - grant everything in `requestedCaps`.
 * `false` - refuse the pairing.
 * `string[]` / `{ caps }` - grant only this subset (intersected with policy).
 */
export type PairingApproval =
  | boolean
  | string[]
  | { approved: boolean; caps?: string[] };

export interface HostPairingOptions {
  identity: DeviceIdentity;
  appId: string;
  registry: CapabilityRegistry;
  store: HostDeviceStore;
  grants: DeviceGrants;
  ttlMs?: number;
  /** dev convenience: skip human confirmation. Never grants above policy. */
  autoApprove?: boolean;
  /**
   * Host-authored permission policy. Applied before the human sees anything,
   * so a client cannot widen its own request past what the host allows.
   */
  policy?: PermissionPolicy;
  logger?: Logger;
  /**
   * Human confirmation hook. Returning false refuses the pairing; returning an
   * array (or `{ caps }`) grants only that subset.
   */
  approve?(request: PairingApprovalRequest): PairingApproval | Promise<PairingApproval>;
}

interface LiveSession extends PairingSessionState {
  pending?: {
    claimNonce: string;
    challengeNonce: string;
    claimName: string;
    claimPubEd: string;
    claimPubX: string;
    grantedCaps: string[];
  };
  /**
   * Set when this session was minted for silent device-link continuation
   * (see `beginLinkSession`) rather than a human-witnessed pairing: the
   * claim is auto-approved with `caps` and the resulting device record is
   * tagged `linkedFrom`, so revoking `fromDeviceId` cascades to it.
   */
  linkOf?: { fromDeviceId: string; caps: string[] };
}

/**
 * Compares two strings without an early exit.
 *
 * Length is not secret here — a pairing code's length is fixed and public — so
 * only the contents are protected.
 */
function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export class HostPairingManager {
  private sessions = new Map<string, LiveSession>();
  private readonly permissions: PermissionEngine;
  private readonly log: Logger;

  constructor(private readonly options: HostPairingOptions) {
    this.log = (options.logger ?? noopLogger).child({
      component: "pairing-host",
      appId: options.appId
    });
    this.permissions = new PermissionEngine(options.registry, options.policy ?? {}, this.log);
  }

  /** The policy in force, for diagnostics and for grant-expiry decisions. */
  get permissionEngine(): PermissionEngine {
    return this.permissions;
  }

  private failedResolves: number[] = [];

  beginSession(): PairingSessionState {
    const session = createPairingSession(this.options.ttlMs ?? Limits.PAIRING_CODE_TTL_MS);
    this.sessions.set(session.psid, { ...session });
    return session;
  }

  /**
   * Mints a single-use device-link continuation session for a device that is
   * already trusted and currently connected. `code` here is an opaque token
   * standing in for the 9-digit human code — no one ever reads or types it,
   * it just has to round-trip through `resolveCode`/`pair_claim` unchanged.
   *
   * The claim is auto-granted exactly the caps `fromDeviceId` currently holds
   * (intersected with whatever the new device actually requests), with no
   * approval hook consulted — the human already approved once, when
   * `fromDeviceId` paired.
   */
  beginLinkSession(fromDeviceId: string, ttlMs = 5 * 60_000): PairingSessionState {
    const fromRecord = this.options.store.get(fromDeviceId);
    if (!fromRecord || fromRecord.revokedAt !== undefined) {
      throw new CrosslinkError(ErrorCodes.UNAUTHORIZED, "device is not currently trusted");
    }
    const token = bytesToBase64(randomBytes(24));
    const session: PairingSessionState = {
      psid: bytesToBase64(randomBytes(16)),
      code: token,
      expiresAt: Date.now() + ttlMs,
      used: false
    };
    this.sessions.set(session.psid, {
      ...session,
      linkOf: { fromDeviceId, caps: [...fromRecord.caps] }
    });
    return session;
  }

  /**
   * Maps a raw user-entered code to a live session id, or null.
   *
   * The comparison is constant-time and every live session is examined even
   * after a match. `===` on strings stops at the first differing character, so
   * timing it leaks the code prefix by prefix — which turns a ~30-bit secret
   * into nine one-digit guesses.
   */
  resolveCode(rawCode: string): string | null {
    const wanted = normalizePairingCode(rawCode);
    const trimmed = rawCode.trim();
    const now = Date.now();
    let found: string | null = null;
    for (const [psid, session] of this.sessions) {
      const codeMatches = timingSafeEqualStrings(session.code, wanted) ||
        timingSafeEqualStrings(session.code, trimmed);
      if (codeMatches && !session.used && session.expiresAt > now && found === null) {
        found = psid;
      }
    }
    return found;
  }

  /**
   * Resolves a user-entered code for pairing directly over a host socket, with
   * global brute-force throttling.
   *
   * The brokered path is protected by the signaling service, which never sees a
   * code in the clear (it matches a hash) and rate-limits resolution. A direct
   * socket has nothing in front of it, and a 9-digit code is only ~30 bits — so
   * the throttle lives here, counting failures across every connection rather
   * than per connection, since opening more sockets is free for an attacker.
   */
  resolveCodeForDirectPairing(rawCode: string): string {
    const now = Date.now();
    this.failedResolves = this.failedResolves.filter((t) => now - t < FAILED_RESOLVE_WINDOW_MS);
    if (this.failedResolves.length >= MAX_FAILED_RESOLVES) {
      throw new CrosslinkError(
        ErrorCodes.PAIRING_INVALID,
        "too many incorrect pairing codes; generate a new code and try again"
      );
    }
    const psid = this.resolveCode(rawCode);
    if (!psid) {
      this.failedResolves.push(now);
      this.log.warn("pairing.direct-resolve-failed", { failures: this.failedResolves.length });
      throw new CrosslinkError(ErrorCodes.PAIRING_EXPIRED, "pairing code not found or expired");
    }
    return psid;
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  /** Handles pair_claim; replies pair_challenge or pair_error via `reply`. */
  async handleClaim(claim: Record<string, unknown>, reply: (frame: object) => void): Promise<void> {
    try {
      await this.processClaim(claim, reply);
    } catch (err) {
      reply({
        kind: "pair_error",
        error: wireError(err)
      });
    }
  }

  private async processClaim(
    claim: Record<string, unknown>,
    reply: (frame: object) => void
  ): Promise<void> {
    if (claim.kind !== "pair_claim") {
      throw new CrosslinkError(ErrorCodes.INVALID_MESSAGE, "expected pair_claim frame");
    }
    const psid = String(claim.ps ?? "");
    const live = this.sessions.get(psid);
    if (!live || live.used || live.expiresAt <= Date.now()) {
      throw new CrosslinkError(ErrorCodes.PAIRING_EXPIRED, "pairing session unknown or expired");
    }
    if (live.pending) {
      throw new CrosslinkError(ErrorCodes.PAIRING_INVALID, "pairing session already claimed");
    }

    const name = sanitizeDeviceName(String(claim.name ?? ""));
    const devId = String(claim.dev ?? "");
    const pubEdB64 = String(claim.pub_ed ?? "");
    const pubXB64 = String(claim.pub_x ?? "");
    const nonce = String(claim.nonce ?? "");
    const capsReq = Array.isArray(claim.caps_req) ? claim.caps_req.map(String) : undefined;

    if (!pubEdB64 || !pubXB64 || !nonce || !devId) {
      throw new CrosslinkError(ErrorCodes.INVALID_MESSAGE, "missing claim fields");
    }
    const pubEdBytes = base64ToBytes(pubEdB64);

    const transcript = pairingTranscriptBytes("claim", [
      psid,
      devId,
      name,
      pubEdB64,
      pubXB64,
      nonce,
      capsReq ?? null
    ]);
    if (!verifySignature(base64ToBytes(claim.sig as string), transcript, pubEdBytes)) {
      throw new CrosslinkError(ErrorCodes.UNAUTHORIZED, "claim signature invalid");
    }

    let grantedCaps: string[];
    if (live.linkOf) {
      // Silent continuation of an already-trusted device: no policy prompt,
      // no human approval — just narrow to whatever the new device asked for.
      const requestedSet = capsReq ? new Set(capsReq) : null;
      grantedCaps = requestedSet
        ? live.linkOf.caps.filter((c) => requestedSet.has(c))
        : [...live.linkOf.caps];
      this.log.info("pairing.link-approved", {
        device: devId,
        from: live.linkOf.fromDeviceId,
        granted: grantedCaps
      });
    } else {
      const decision = this.evaluatePolicy(capsReq, devId, name);
      const offered = [...decision.granted, ...decision.needsApproval];

      const sas = shortAuthString(this.options.appId, this.options.identity.edPublicKey, pubEdBytes);
      grantedCaps = await this.decideGrant(decision, offered, {
        sas,
        deviceName: name,
        deviceId: devId,
        requestedCaps: offered,
        requiresExplicitApproval: decision.needsApproval,
        deniedCaps: decision.denied.map((d) => ({ id: d.id, reason: d.reason }))
      });

      this.log.info("pairing.approved", {
        device: devId,
        name,
        requested: capsReq ?? null,
        granted: grantedCaps,
        denied: decision.denied
      });
    }

    const challengeNonce = bytesToBase64(randomBytes(32));
    live.pending = {
      claimNonce: nonce,
      challengeNonce,
      claimName: name,
      claimPubEd: pubEdB64,
      claimPubX: pubXB64,
      grantedCaps
    };

    const sig = bytesToBase64(
      this.options.identity.sign(
        pairingTranscriptBytes("challenge", [
          psid,
          nonce,
          bytesToBase64(this.options.identity.edPublicKey),
          bytesToBase64(this.options.identity.xPublicKey),
          challengeNonce,
          grantedCaps
        ])
      )
    );

    reply({
      kind: "pair_challenge",
      ps: psid,
      claim_nonce: nonce,
      host_pub_ed: bytesToBase64(this.options.identity.edPublicKey),
      host_pub_x: bytesToBase64(this.options.identity.xPublicKey),
      nonce: challengeNonce,
      granted_caps: grantedCaps,
      sig
    });
  }

  /**
   * Handles pair_complete; replies pair_done via `reply` and returns the new
   * trusted-device record. Throws (after replying pair_error) on failure.
   */
  handleComplete(
    complete: Record<string, unknown>,
    reply: (frame: object) => void
  ): TrustedDeviceRecord {
    let record: TrustedDeviceRecord;
    try {
      record = this.processComplete(complete);
    } catch (err) {
      reply({ kind: "pair_error", error: wireError(err) });
      throw err;
    }
    reply({ kind: "pair_done", ps: String(complete.ps ?? "") });
    return record;
  }

  private processComplete(complete: Record<string, unknown>): TrustedDeviceRecord {
    const psid = String(complete.ps ?? "");
    const live = this.sessions.get(psid);
    if (!live || !live.pending || live.used || live.expiresAt <= Date.now()) {
      throw new CrosslinkError(ErrorCodes.PAIRING_EXPIRED, "no pending pairing for this session");
    }
    const pending = live.pending;

    const completeChallengeNonce = String(complete.challenge_nonce ?? "");
    if (completeChallengeNonce !== pending.challengeNonce) {
      throw new CrosslinkError(ErrorCodes.UNAUTHORIZED, "challenge nonce does not match pairing session");
    }

    const transcript = pairingTranscriptBytes("complete", [
      psid,
      pending.claimNonce,
      completeChallengeNonce
    ]);
    const ok = verifySignature(
      base64ToBytes(String(complete.sig ?? "")),
      transcript,
      base64ToBytes(pending.claimPubEd)
    );
    if (!ok) {
      throw new CrosslinkError(ErrorCodes.UNAUTHORIZED, "completion signature invalid");
    }

    live.used = true;
    delete live.pending;

    const record: TrustedDeviceRecord = {
      deviceId: deviceIdFromPublicKey(base64ToBytes(pending.claimPubEd)),
      name: pending.claimName,
      pubEd: pending.claimPubEd,
      pubX: pending.claimPubX,
      caps: [...pending.grantedCaps],
      addedAt: Date.now(),
      ...(live.linkOf ? { linkedFrom: live.linkOf.fromDeviceId } : {})
    };
    this.options.store.upsert(record);
    this.options.grants.drop(record.deviceId);
    this.options.grants.grant(record.deviceId, record.caps, {
      expiresAt: this.permissions.grantExpiryFrom(record.addedAt)
    });
    this.log.info("pairing.completed", {
      device: record.deviceId,
      name: record.name,
      caps: record.caps,
      expiresAt: this.permissions.grantExpiryFrom(record.addedAt)
    });

    return record;
  }

  /**
   * Runs the client's request through the host policy. A client that requests
   * nothing gets the registry's `defaultGranted` set, not everything.
   */
  private evaluatePolicy(
    requested: string[] | undefined,
    deviceId: string,
    deviceName: string
  ): PolicyDecision {
    const source = requested ?? this.options.registry.defaultGrantedIds();
    return this.permissions.evaluate(source, {
      deviceId,
      deviceName,
      autoApprove: this.options.autoApprove === true,
      pairedDeviceCount: this.options.store
        .list()
        .filter((d) => d.revokedAt === undefined && d.deviceId !== deviceId).length
    });
  }

  /**
   * Asks the host user (unless auto-approving) and narrows the offer to what
   * they actually agreed to. The result can only ever be a subset of what the
   * policy already permitted - a human cannot widen a policy from a prompt.
   */
  private async decideGrant(
    decision: PolicyDecision,
    offered: string[],
    request: PairingApprovalRequest
  ): Promise<string[]> {
    if (this.options.autoApprove) {
      // Auto-approval never satisfies a capability the policy flagged for a
      // human; evaluatePolicy has already moved those into `denied`.
      if (decision.needsApproval.length > 0) {
        throw new CrosslinkError(
          ErrorCodes.PAIRING_INVALID,
          "capabilities require explicit approval but the host is in auto-approve mode"
        );
      }
      return decision.granted;
    }

    if (!this.options.approve) {
      this.log.warn("pairing.no-approve-hook", { device: request.deviceId });
      throw new CrosslinkError(
        ErrorCodes.PAIRING_INVALID,
        "no approval hook configured; pairing refused"
      );
    }

    const answer = await this.options.approve(request);
    const approved =
      typeof answer === "boolean"
        ? answer
        : Array.isArray(answer)
          ? true
          : answer.approved;
    if (!approved) {
      this.log.info("pairing.rejected-by-user", { device: request.deviceId });
      throw new CrosslinkError(ErrorCodes.PAIRING_INVALID, "pairing rejected by host user");
    }

    const chosen = Array.isArray(answer)
      ? answer
      : typeof answer === "object" && answer.caps
        ? answer.caps
        : offered;
    // Intersect: a prompt may narrow the offer, never widen it.
    const offeredSet = new Set(offered);
    return chosen.filter((id) => offeredSet.has(id));
  }
}

function wireError(err: unknown): { code: string; message: string } {
  const cle = CrosslinkError.from(err);
  return CrosslinkError.isInternal(cle.code)
    ? { code: ErrorCodes.PAIRING_INVALID, message: "invalid pairing exchange" }
    : { code: cle.code, message: cle.message.slice(0, 200) };
}

function sanitizeDeviceName(name: string): string {
  const cleaned = name.replace(/[^\w\s.'-]/g, "").trim();
  return (cleaned || "device").slice(0, 64);
}
