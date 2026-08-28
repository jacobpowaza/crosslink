import { describe, expect, it } from "vitest";
import { ErrorCodes, type Json } from "@crosslink/protocol";
import { GROUP_CAPABILITIES, GroupSessionManager } from "./groups.js";

function harness(overrides: Partial<ConstructorParameters<typeof GroupSessionManager>[0]> = {}) {
  const grants = new Map<string, Set<string>>();
  const deliveries: Array<{ deviceId: string; event: string; payload: Json }> = [];
  const grant = (deviceId: string, ...caps: string[]) => grants.set(deviceId, new Set(caps));
  const manager = new GroupSessionManager({
    hasCapability: (deviceId, capability) => grants.get(deviceId)?.has(capability) ?? false,
    deliver: (deviceId, event, payload) => deliveries.push({ deviceId, event, payload }),
    ...overrides
  });
  return { manager, grant, deliveries };
}

const OWNER_CAPS = [
  GROUP_CAPABILITIES.create,
  GROUP_CAPABILITIES.join,
  GROUP_CAPABILITIES.introduce,
  GROUP_CAPABILITIES.send,
  GROUP_CAPABILITIES.receive
];
const MEMBER_CAPS = [
  GROUP_CAPABILITIES.join,
  GROUP_CAPABILITIES.send,
  GROUP_CAPABILITIES.receive
];

describe("capability-gated star groups", () => {
  it("introduces two members with opaque participant ids and routes through the host", () => {
    const { manager, grant, deliveries } = harness();
    grant("owner", ...OWNER_CAPS);
    grant("phone", ...MEMBER_CAPS);

    const owner = manager.create("owner");
    const invite = manager.invite(owner.groupId, "owner", "phone");
    const phone = manager.join(invite.token, "phone");
    expect(manager.members(owner.groupId, "owner")).toEqual(expect.arrayContaining([
      { participantId: owner.participantId, self: true },
      { participantId: phone.participantId, self: false }
    ]));

    const introduction = manager.introduce(owner.groupId, "owner", phone.participantId);
    expect(deliveries.filter((delivery) => delivery.event === "introduction")).toHaveLength(2);
    const wirePayloads = JSON.stringify(deliveries.map((delivery) => delivery.payload));
    expect(wirePayloads).not.toContain('"owner"');
    expect(wirePayloads).not.toContain('"phone"');

    manager.send(owner.groupId, introduction.introductionId, "owner", { text: "hello" });
    expect(deliveries.at(-1)).toMatchObject({
      deviceId: "phone",
      event: "message",
      payload: { fromParticipantId: owner.participantId, payload: { text: "hello" } }
    });
  });

  it("refuses routing without an explicit introduction edge", () => {
    const { manager, grant } = harness();
    grant("owner", ...OWNER_CAPS);
    expect(() => manager.send("missing", "missing", "owner", null)).toThrow(/unknown group/);
  });

  it("requires the target to hold receive authority", () => {
    const { manager, grant } = harness();
    grant("owner", ...OWNER_CAPS);
    grant("phone", GROUP_CAPABILITIES.join);
    const owner = manager.create("owner");
    const phone = manager.join(manager.invite(owner.groupId, "owner").token, "phone");

    expect(() => manager.introduce(owner.groupId, "owner", phone.participantId)).toMatchErrorCode(
      ErrorCodes.CAPABILITY_DENIED
    );
  });

  it("makes targeted invitations single-use and device-bound", () => {
    const { manager, grant } = harness();
    grant("owner", ...OWNER_CAPS);
    grant("phone", ...MEMBER_CAPS);
    grant("attacker", ...MEMBER_CAPS);
    const owner = manager.create("owner");
    const invite = manager.invite(owner.groupId, "owner", "phone");

    expect(() => manager.join(invite.token, "attacker")).toMatchErrorCode(ErrorCodes.UNAUTHORIZED);
    expect(() => manager.join(invite.token, "phone")).toMatchErrorCode(ErrorCodes.UNAUTHORIZED);
  });

  it("bounds group membership before allocating another participant", () => {
    const { manager, grant } = harness({ maxMembersPerGroup: 1 });
    grant("owner", ...OWNER_CAPS);
    grant("phone", ...MEMBER_CAPS);
    const owner = manager.create("owner");
    const invite = manager.invite(owner.groupId, "owner");
    expect(() => manager.join(invite.token, "phone")).toMatchErrorCode(ErrorCodes.RATE_LIMITED);
  });
});

declare module "vitest" {
  interface Assertion<T = any> {
    toMatchErrorCode(code: string): T;
  }
}

expect.extend({
  toMatchErrorCode(received: () => unknown, code: string) {
    try {
      received();
      return { pass: false, message: () => `expected function to throw ${code}` };
    } catch (error) {
      const actual = (error as { code?: string }).code;
      return {
        pass: actual === code,
        message: () => `expected error code ${code}, received ${String(actual)}`
      };
    }
  }
});
