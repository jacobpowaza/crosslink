import { CrosslinkError, ErrorCodes, bytesToBase64, type Json } from "@crosslink/protocol";
import { randomBytes } from "./crypto/primitives.js";
import { noopLogger, type Logger } from "./logger.js";

export const GROUP_CAPABILITIES = {
  create: "crosslink.group.create",
  join: "crosslink.group.join",
  introduce: "crosslink.group.introduce",
  send: "crosslink.group.send",
  receive: "crosslink.group.receive"
} as const;

export interface GroupSessionOptions {
  hasCapability(deviceId: string, capability: string): boolean;
  deliver(deviceId: string, event: "introduction" | "message", payload: Json): void;
  maxGroups?: number;
  maxMembersPerGroup?: number;
  maxPayloadBytes?: number;
  inviteTtlMs?: number;
  logger?: Logger;
}

interface Member {
  deviceId: string;
  participantId: string;
}

interface Invite {
  token: string;
  groupId: string;
  createdBy: string;
  targetDeviceId?: string;
  expiresAt: number;
}

interface Introduction {
  id: string;
  groupId: string;
  a: string;
  b: string;
}

interface Group {
  id: string;
  ownerDeviceId: string;
  members: Map<string, Member>;
  introductions: Map<string, Introduction>;
  createdAt: number;
}

/**
 * Host-owned group state. Peers never receive network coordinates or identity
 * keys and never connect to one another; all messages remain encrypted on
 * their existing host sessions and the host routes only introduced edges.
 */
export class GroupSessionManager {
  private readonly groups = new Map<string, Group>();
  private readonly invites = new Map<string, Invite>();
  private readonly log: Logger;

  constructor(private readonly options: GroupSessionOptions) {
    this.log = options.logger ?? noopLogger;
  }

  create(ownerDeviceId: string): { groupId: string; participantId: string } {
    this.require(ownerDeviceId, GROUP_CAPABILITIES.create);
    if (this.groups.size >= (this.options.maxGroups ?? 1000)) {
      throw new CrosslinkError(ErrorCodes.RATE_LIMITED, "group capacity reached");
    }
    const id = randomId();
    const member = this.newMember(ownerDeviceId);
    this.groups.set(id, {
      id,
      ownerDeviceId,
      members: new Map([[ownerDeviceId, member]]),
      introductions: new Map(),
      createdAt: Date.now()
    });
    this.log.info("group.created", { groupId: id, owner: ownerDeviceId });
    return { groupId: id, participantId: member.participantId };
  }

  invite(
    groupId: string,
    createdBy: string,
    targetDeviceId?: string
  ): { token: string; expiresAt: number } {
    this.require(createdBy, GROUP_CAPABILITIES.introduce);
    const group = this.memberGroup(groupId, createdBy);
    if (group.ownerDeviceId !== createdBy) {
      throw new CrosslinkError(ErrorCodes.CAPABILITY_DENIED, "only the group owner can invite peers");
    }
    const token = randomId(24);
    const expiresAt = Date.now() + (this.options.inviteTtlMs ?? 5 * 60_000);
    this.invites.set(token, { token, groupId, createdBy, targetDeviceId, expiresAt });
    return { token, expiresAt };
  }

  join(token: string, deviceId: string): { groupId: string; participantId: string } {
    this.require(deviceId, GROUP_CAPABILITIES.join);
    const invite = this.invites.get(token);
    this.invites.delete(token);
    if (!invite || invite.expiresAt <= Date.now()) {
      throw new CrosslinkError(ErrorCodes.UNAUTHORIZED, "group invitation is invalid or expired");
    }
    if (invite.targetDeviceId && invite.targetDeviceId !== deviceId) {
      throw new CrosslinkError(ErrorCodes.UNAUTHORIZED, "group invitation belongs to another device");
    }
    const group = this.requiredGroup(invite.groupId);
    const existing = group.members.get(deviceId);
    if (existing) return { groupId: group.id, participantId: existing.participantId };
    if (group.members.size >= (this.options.maxMembersPerGroup ?? 16)) {
      throw new CrosslinkError(ErrorCodes.RATE_LIMITED, "group member limit reached");
    }
    const member = this.newMember(deviceId);
    group.members.set(deviceId, member);
    this.log.info("group.joined", { groupId: group.id, device: deviceId });
    return { groupId: group.id, participantId: member.participantId };
  }

  introduce(groupId: string, requester: string, targetParticipantId: string): {
    introductionId: string;
    peerParticipantId: string;
  } {
    this.require(requester, GROUP_CAPABILITIES.introduce);
    const group = this.memberGroup(groupId, requester);
    const requesterMember = group.members.get(requester)!;
    const target = [...group.members.values()].find(
      (member) => member.participantId === targetParticipantId
    );
    if (!target || target.deviceId === requester) {
      throw new CrosslinkError(ErrorCodes.VALIDATION_FAILED, "target is not another group member");
    }
    this.require(target.deviceId, GROUP_CAPABILITIES.receive);
    const existing = [...group.introductions.values()].find((intro) =>
      (intro.a === requester && intro.b === target.deviceId) ||
      (intro.b === requester && intro.a === target.deviceId)
    );
    const introduction: Introduction = existing ?? {
      id: randomId(),
      groupId,
      a: requester,
      b: target.deviceId
    };
    group.introductions.set(introduction.id, introduction);
    this.options.deliver(requester, "introduction", {
      groupId,
      introductionId: introduction.id,
      peerParticipantId: target.participantId
    });
    this.options.deliver(target.deviceId, "introduction", {
      groupId,
      introductionId: introduction.id,
      peerParticipantId: requesterMember.participantId
    });
    return { introductionId: introduction.id, peerParticipantId: target.participantId };
  }

  send(groupId: string, introductionId: string, fromDeviceId: string, payload: Json): void {
    this.require(fromDeviceId, GROUP_CAPABILITIES.send);
    const group = this.memberGroup(groupId, fromDeviceId);
    const introduction = group.introductions.get(introductionId);
    if (!introduction || (introduction.a !== fromDeviceId && introduction.b !== fromDeviceId)) {
      throw new CrosslinkError(ErrorCodes.CAPABILITY_DENIED, "peer has not been introduced");
    }
    const encoded = JSON.stringify(payload);
    if (new TextEncoder().encode(encoded).length > (this.options.maxPayloadBytes ?? 64 * 1024)) {
      throw new CrosslinkError(ErrorCodes.PAYLOAD_TOO_LARGE, "group message exceeds payload limit");
    }
    const to = introduction.a === fromDeviceId ? introduction.b : introduction.a;
    this.require(to, GROUP_CAPABILITIES.receive);
    const sender = group.members.get(fromDeviceId)!;
    this.options.deliver(to, "message", {
      groupId,
      introductionId,
      fromParticipantId: sender.participantId,
      payload
    });
  }

  leave(groupId: string, deviceId: string): boolean {
    const group = this.groups.get(groupId);
    if (!group || !group.members.delete(deviceId)) return false;
    for (const [id, intro] of group.introductions) {
      if (intro.a === deviceId || intro.b === deviceId) group.introductions.delete(id);
    }
    if (group.ownerDeviceId === deviceId || group.members.size === 0) this.groups.delete(groupId);
    return true;
  }

  leaveAll(deviceId: string): void {
    for (const groupId of [...this.groups.keys()]) this.leave(groupId, deviceId);
  }

  members(groupId: string, requester: string): Array<{ participantId: string; self: boolean }> {
    const group = this.memberGroup(groupId, requester);
    return [...group.members.values()].map((member) => ({
      participantId: member.participantId,
      self: member.deviceId === requester
    }));
  }

  private requiredGroup(groupId: string): Group {
    const group = this.groups.get(groupId);
    if (!group) throw new CrosslinkError(ErrorCodes.VALIDATION_FAILED, "unknown group");
    return group;
  }

  private memberGroup(groupId: string, deviceId: string): Group {
    const group = this.requiredGroup(groupId);
    if (!group.members.has(deviceId)) {
      throw new CrosslinkError(ErrorCodes.CAPABILITY_DENIED, "device is not a group member");
    }
    return group;
  }

  private require(deviceId: string, capability: string): void {
    if (!this.options.hasCapability(deviceId, capability)) {
      throw new CrosslinkError(ErrorCodes.CAPABILITY_DENIED, `group action requires ${capability}`);
    }
  }

  private newMember(deviceId: string): Member {
    return { deviceId, participantId: randomId(12) };
  }
}

function randomId(bytes = 16): string {
  return bytesToBase64(randomBytes(bytes));
}
