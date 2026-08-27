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
    claimName: string;
    claimPubEd: string;
    claimPubX: string;
    grantedCaps: string[];
  };
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

  beginSession(): PairingSessionState {
    const session = createPairingSession(this.options.ttlMs ?? Limits.PAIRING_CODE_TTL_MS);
    this.sessions.set(session.psid, { ...session });
    return session;
  }

  /** Maps a raw user-entered code to a live session id, or null. */
  resolveCode(rawCode: string): string | null {
    const wanted = normalizePairingCode(rawCode);
    for (const [psid, session] of this.sessions) {
      if (
        (session.code === wanted || session.code === rawCode.trim()) &&
        !session.used &&
        session.expiresAt > Date.now()
      ) {
        return psid;
      }
    }
    return null;
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

    const decision = this.evaluatePolicy(capsReq, devId, name);
    const offered = [...decision.granted, ...decision.needsApproval];

    const sas = shortAuthString(this.options.appId, this.options.identity.edPublicKey, pubEdBytes);
    const grantedCaps = await this.decideGrant(decision, offered, {
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

    const challengeNonce = bytesToBase64(randomBytes(32));
    live.pending = {
      claimNonce: nonce,
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

    const transcript = pairingTranscriptBytes("complete", [
      psid,
      pending.claimNonce,
      String(complete.challenge_nonce ?? "")
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
      addedAt: Date.now()
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
