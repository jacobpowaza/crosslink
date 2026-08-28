/**
 * Host SDK behaviour: permission policy at pairing time, per-use consent at
 * call time, grant lifecycle, secret storage, and status reporting.
 *
 * The transport is an in-memory pipe fed to `acceptExternalTransport`, which
 * is the same path a WebRTC or LAN transport takes, so the CLX1 handshake and
 * the RPC router are exercised for real without opening a socket.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes, bytesToBase64 } from "@crosslink/protocol";
import {
  ClientLink,
  DeviceIdentity,
  DEVICE_LINK_RPC_METHOD,
  GROUP_CAPABILITIES,
  MemoryLogSink,
  buildPairingUri,
  createClaim,
  createMemoryPair,
  parsePairingUri,
  processChallenge,
  signClaim,
  type ConsentRequest,
  type CrosslinkTransport,
  type PairedAppRecord,
  type PairingApproval,
  type PairingApprovalRequest
} from "@crosslink/core";
import { createCrosslinkServer, type CrosslinkServer } from "./server.js";
import { MemorySecretStore } from "./keychain.js";
import { buildInstallManifestUrl, buildInstallStartUrl } from "./bootstrap.js";

const APP_ID = "com.example.host";

const running: CrosslinkServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.stop().catch(() => {})));
});

// Router discovery is mocked: the point under test is that a runtime switch to
// `remote` opens remote access at all, not what this machine's router answers —
// and a test must never negotiate a real port mapping on the developer's router.
vi.mock("@crosslink/nat-map", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@crosslink/nat-map")>();
  return {
    ...actual,
    openNatMapping: vi.fn(async (opts: { internalPort: number; externalPort?: number; publicHost?: string }) => {
      const result = {
        protocol: "none" as const,
        mapped: false,
        manual: true,
        internalPort: opts.internalPort,
        externalPort: opts.externalPort ?? opts.internalPort,
        externalAddress: opts.publicHost,
        reachable: Boolean(opts.publicHost),
        confidence: "manual" as const,
        lifetimeSeconds: 0,
        cgnat: false,
        attempts: [],
        message: "manual forward (test)"
      };
      return { result, renew: async () => result, release: async () => {} };
    })
  };
});

describe("remote access enabled after startup", () => {
  it("opens remote access on a `remote` pairing code even when the host started in auto", async () => {
    const server = await startServer({
      networkMode: "auto",
      lan: { enabled: true, bind: "all" }
    });
    // The user flips "reachable from anywhere" in a settings panel: config
    // changes on a host that is already running.
    server.config.remote = { portForwarded: true, publicHost: "home.example.net", externalPort: 8787 };
    server.config.networkMode = "remote";

    const info = await server.getPairingCode(undefined, "remote");
    const wan = info.endpoints?.find((e) => e.kind === "wan");
    expect(wan?.url).toBe("ws://home.example.net:8787");
    expect(server.getRemoteDiagnostics()?.confidence).toBe("manual");
  });
});

function storageDir(): string {
  return mkdtempSync(path.join(tmpdir(), "crosslink-server-"));
}

type ServerConfig = Parameters<typeof createCrosslinkServer>[0];

async function startServer(overrides: Partial<ServerConfig> = {}): Promise<CrosslinkServer> {
  const server = createCrosslinkServer({
    application: { id: APP_ID, name: "Host Under Test", version: "1.0.0" },
    capabilities: [
      { id: "notes.read", title: "Read notes", risk: "low", defaultGranted: true },
      { id: "notes.write", title: "Write notes", risk: "medium" },
      { id: "files.delete", title: "Delete files", risk: "high" },
      {
        id: "shell.exec",
        title: "Run a command",
        description: "Runs a shell command on this computer",
        risk: "high",
        confirmEachUse: true
      }
    ],
    storageDir: storageDir(),
    lan: { enabled: false },
    networkMode: "local-only",
    secretStore: new MemorySecretStore(),
    security: {
      pairingRateLimitMs: 0
    },
    ...overrides,
    ...(overrides.security ? {
      security: {
        pairingRateLimitMs: 0,
        ...overrides.security
      }
    } : {})
  });

  server
    .expose("notes.list", () => ["alpha"], { capability: "notes.read" })
    .expose("notes.create", (p) => ({ created: true, input: p }), { capability: "notes.write" })
    .expose("files.remove", () => ({ removed: true }), { capability: "files.delete" })
    .expose("shell.run", (p) => ({ ran: p }), { capability: "shell.exec" })
    .expose("ping", () => "pong");

  running.push(server);
  await server.start();
  return server;
}

/**
 * Runs the real pairing exchange against the server's pairing manager, with
 * the signaling service replaced by a direct function call - the blobs and
 * signatures are identical either way.
 */
async function pairDevice(
  server: CrosslinkServer,
  requestedCaps?: string[]
): Promise<{ identity: DeviceIdentity; record: PairedAppRecord }> {
  const pairing = (server as unknown as { pairing: import("@crosslink/core").HostPairingManager })
    .pairing;
  const identity = (server as unknown as { identity: DeviceIdentity }).identity;

  const clientIdentity = DeviceIdentity.create();
  const session = pairing.beginSession();
  const parsed = parsePairingUri(
    buildPairingUri({
      endpoints: [{ kind: "sig", url: "https://signal.test" }],
      code: session.code,
      appId: APP_ID,
      appName: "Host Under Test",
      hostPubEdB64: bytesToBase64(identity.edPublicKey)
    })
  );
  const psid = pairing.resolveCode(parsed.code);
  if (!psid) throw new Error("pairing code did not resolve");

  const { claim, state } = createClaim(clientIdentity, parsed, "Test Device", requestedCaps);
  signClaim(clientIdentity, claim, psid);

  const challenge = await new Promise<Record<string, unknown>>((resolve) => {
    void pairing.handleClaim(claim, (f) => resolve(f as Record<string, unknown>));
  });
  if (challenge.kind === "pair_error") {
    throw Object.assign(new Error("pairing refused"), { detail: challenge.error });
  }

  const { complete, record } = await processChallenge(
    clientIdentity,
    parsed,
    state,
    challenge,
    () => true
  );
  await new Promise<void>((resolve, reject) => {
    try {
      pairing.handleComplete(complete, () => resolve());
    } catch (err) {
      reject(err);
    }
  });
  return { identity: clientIdentity, record };
}

async function connectDevice(
  server: CrosslinkServer,
  clientIdentity: DeviceIdentity,
  record: PairedAppRecord
): Promise<ClientLink> {
  const hostIdentity = (server as unknown as { identity: DeviceIdentity }).identity;
  const link = new ClientLink({
    identity: clientIdentity,
    appId: APP_ID,
    hostRecord: () => ({
      ...record,
      pubEdB64: bytesToBase64(hostIdentity.edPublicKey),
      pubXB64: bytesToBase64(hostIdentity.xPublicKey)
    }),
    candidates: [
      {
        kind: "memory",
        connect: async (): Promise<CrosslinkTransport> => {
          const [clientSide, hostSide] = createMemoryPair();
          server.acceptExternalTransport(hostSide);
          return clientSide;
        }
      }
    ],
    requestTimeoutMs: 3000
  });
  await link.connect();
  return link;
}

/* ------------------------------------------------------------------ */

describe("permission policy at pairing time", () => {
  it("auto-approve grants low risk only, by default", async () => {
    const server = await startServer({ pairing: { autoApprove: true } });
    const { record } = await pairDevice(server, ["notes.read", "notes.write"]);

    // A host left in auto-approve mode must not hand out write access.
    expect(record.grantedCaps).toEqual(["notes.read"]);
  });

  it("auto-approve can be widened deliberately, but never to high risk", async () => {
    const server = await startServer({
      pairing: { autoApprove: true },
      permissions: { maxAutoGrantRisk: "high" }
    });
    const { record } = await pairDevice(server, ["notes.write", "files.delete"]);

    expect(record.grantedCaps).toEqual(["notes.write"]);
  });

  it("honours a deny list even when the user approves", async () => {
    const approve = vi.fn((_request: PairingApprovalRequest): PairingApproval => true);
    const server = await startServer({
      pairing: { approve },
      permissions: { deny: ["notes.write"], maxAutoGrantRisk: "high", requireApproval: "none" }
    });
    const { record } = await pairDevice(server, ["notes.read", "notes.write"]);

    expect(record.grantedCaps).toEqual(["notes.read"]);
    const request = approve.mock.calls[0]![0];
    expect(request.deniedCaps).toEqual([{ id: "notes.write", reason: "deny-list" }]);
  });

  it("lets the approval hook grant a subset", async () => {
    const server = await startServer({
      pairing: { approve: () => ["notes.read"] },
      permissions: { maxAutoGrantRisk: "high", requireApproval: "none" }
    });
    const { record } = await pairDevice(server, ["notes.read", "notes.write"]);

    expect(record.grantedCaps).toEqual(["notes.read"]);
  });

  it("cannot be widened past the policy by the approval hook", async () => {
    // The prompt narrows an offer; it must not be able to add to it.
    const server = await startServer({
      pairing: { approve: () => ["notes.read", "files.delete", "shell.exec"] },
      permissions: { allow: ["notes.read"], requireApproval: "none" }
    });
    const { record } = await pairDevice(server, ["notes.read"]);

    expect(record.grantedCaps).toEqual(["notes.read"]);
  });

  it("refuses the pairing when the user declines", async () => {
    const server = await startServer({ pairing: { approve: () => false } });
    await expect(pairDevice(server, ["notes.read"])).rejects.toThrow(/pairing refused/);
    expect(server.listDevices()).toHaveLength(0);
  });

  it("refuses to pair at all when no approval hook is configured", async () => {
    // Silence is not consent: a host with neither a hook nor auto-approve
    // cannot obtain permission, so it must not grant any.
    const server = await startServer({});
    await expect(pairDevice(server, ["notes.read"])).rejects.toThrow(/pairing refused/);
  });

  it("shows the user what was requested, what needs approval and what was refused", async () => {
    const approve = vi.fn((_request: PairingApprovalRequest): PairingApproval => true);
    const server = await startServer({ pairing: { approve } });
    await pairDevice(server, ["notes.read", "files.delete", "made.up"]);

    const request = approve.mock.calls[0]![0];
    expect(request.deviceName).toBe("Test Device");
    expect(request.sas).toMatch(/\S/);
    expect(request.requestedCaps).toContain("notes.read");
    expect(request.requiresExplicitApproval).toContain("files.delete");
    expect(request.deniedCaps).toContainEqual({ id: "made.up", reason: "unknown-capability" });
  });

  it("pushes an approval notification before asking for the decision", async () => {
    const order: string[] = [];
    const notifyApprovalRequest = vi.fn(async (request: PairingApprovalRequest) => {
      order.push(`notify:${request.deviceName}`);
    });
    const server = await startServer({
      pairing: {
        notifyApprovalRequest,
        approve: () => {
          order.push("approve");
          return true;
        }
      }
    });
    const emitted = vi.fn();
    server.on("pairingApprovalRequested", emitted);

    await pairDevice(server, ["notes.read"]);

    expect(order).toEqual(["notify:Test Device", "approve"]);
    expect(notifyApprovalRequest).toHaveBeenCalledOnce();
    expect(emitted).toHaveBeenCalledOnce();
  });

  it("still requires the approval decision when notification delivery fails", async () => {
    const approve = vi.fn(() => false);
    const server = await startServer({
      pairing: {
        notifyApprovalRequest: () => Promise.reject(new Error("push unavailable")),
        approve
      }
    });

    await expect(pairDevice(server, ["notes.read"])).rejects.toThrow(/pairing refused/);
    expect(approve).toHaveBeenCalledOnce();
    expect(server.listDevices()).toHaveLength(0);
  });

  it("falls back to the registry defaults when the client requests nothing", async () => {
    const server = await startServer({ pairing: { autoApprove: true } });
    const { record } = await pairDevice(server);
    expect(record.grantedCaps).toEqual(["notes.read"]);
  });

  it("enforces a device limit", async () => {
    const server = await startServer({
      pairing: { autoApprove: true },
      permissions: { maxDevices: 1 }
    });
    await pairDevice(server, ["notes.read"]);

    const { record } = await pairDevice(server, ["notes.read"]);
    expect(record.grantedCaps).toEqual([]);
  });
});

describe("capability enforcement at call time", () => {
  it("allows a granted method and refuses an ungranted one", async () => {
    const server = await startServer({ pairing: { autoApprove: true } });
    const { identity, record } = await pairDevice(server, ["notes.read"]);
    const link = await connectDevice(server, identity, record);

    expect(await link.call("notes.list")).toEqual(["alpha"]);
    await expect(link.call("notes.create", { title: "x" })).rejects.toMatchObject({
      code: ErrorCodes.CAPABILITY_DENIED
    });
    link.close();
  }, 15000);

  it("allows methods that require no capability", async () => {
    const server = await startServer({ pairing: { autoApprove: true } });
    const { identity, record } = await pairDevice(server, []);
    const link = await connectDevice(server, identity, record);

    expect(await link.call("ping")).toBe("pong");
    link.close();
  }, 15000);

  it("applies a capability change to the live session", async () => {
    const server = await startServer({
      pairing: { autoApprove: true },
      permissions: { maxAutoGrantRisk: "medium" }
    });
    const { identity, record } = await pairDevice(server, ["notes.read"]);
    const link = await connectDevice(server, identity, record);

    await expect(link.call("notes.create", { title: "x" })).rejects.toMatchObject({
      code: ErrorCodes.CAPABILITY_DENIED
    });

    server.setDeviceCaps(identity.deviceId, ["notes.read", "notes.write"]);
    expect(await link.call("notes.create", { title: "x" })).toMatchObject({ created: true });
    link.close();
  }, 15000);

  it("refuses to set a capability the registry does not define", async () => {
    const server = await startServer({ pairing: { autoApprove: true } });
    const { identity } = await pairDevice(server, ["notes.read"]);

    expect(() => server.setDeviceCaps(identity.deviceId, ["not.a.capability"])).toThrow(
      /unknown capability/
    );
  });

  it("cuts off a revoked device mid-session", async () => {
    const server = await startServer({ pairing: { autoApprove: true } });
    const { identity, record } = await pairDevice(server, ["notes.read"]);
    const link = await connectDevice(server, identity, record);
    expect(await link.call("notes.list")).toEqual(["alpha"]);

    expect(server.revokeDevice(identity.deviceId)).toBe(true);
    await vi.waitFor(() => expect(link.currentState).toBe("revoked"), { timeout: 10000 });
    expect(server.grantedCapabilities(identity.deviceId)).toEqual([]);
  }, 20000);

  it("expires grants once the policy TTL passes", async () => {
    const server = await startServer({
      pairing: { autoApprove: true },
      permissions: { grantTtlMs: 120 }
    });
    const { identity, record } = await pairDevice(server, ["notes.read"]);
    const link = await connectDevice(server, identity, record);
    expect(await link.call("notes.list")).toEqual(["alpha"]);

    await new Promise((r) => setTimeout(r, 200));
    await expect(link.call("notes.list")).rejects.toMatchObject({
      code: ErrorCodes.GRANT_EXPIRED
    });
    link.close();
  }, 15000);
});

describe("group sessions", () => {
  it("routes only a capability-gated introduced star edge", async () => {
    const groupCaps = Object.values(GROUP_CAPABILITIES);
    const server = await startServer({
      groups: { enabled: true, maxMembersPerGroup: 4 },
      pairing: { approve: () => true },
      permissions: { maxAutoGrantRisk: "high", requireApproval: "none" }
    });
    const ownerPair = await pairDevice(server, groupCaps);
    const phonePair = await pairDevice(server, groupCaps);
    const owner = await connectDevice(server, ownerPair.identity, ownerPair.record);
    const phone = await connectDevice(server, phonePair.identity, phonePair.record);
    const messages: unknown[] = [];
    phone.subscribe("crosslink.group.message", (payload) => messages.push(payload));

    const created = await owner.call("crosslink.group.create") as {
      groupId: string;
      participantId: string;
    };
    const invite = await owner.call("crosslink.group.invite", {
      groupId: created.groupId,
      targetDeviceId: phonePair.identity.deviceId
    }) as { token: string };
    await phone.call("crosslink.group.join", { token: invite.token });
    const members = await owner.call("crosslink.group.members", {
      groupId: created.groupId
    }) as Array<{ participantId: string; self: boolean }>;
    const target = members.find((member) => !member.self)!;
    const introduced = await owner.call("crosslink.group.introduce", {
      groupId: created.groupId,
      targetParticipantId: target.participantId
    }) as { introductionId: string };

    await owner.call("crosslink.group.send", {
      groupId: created.groupId,
      introductionId: introduced.introductionId,
      payload: { text: "host routed" }
    });
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toMatchObject({ payload: { text: "host routed" } });

    await expect(phone.call("crosslink.group.send", {
      groupId: created.groupId,
      introductionId: "not-an-edge",
      payload: "blocked"
    })).rejects.toThrow(/not been introduced/);
    owner.close();
    phone.close();
  }, 15000);
});

describe("per-use consent", () => {
  async function consentServer(
    prompt: NonNullable<ServerConfig["onConsentRequest"]>
  ): Promise<CrosslinkServer> {
    return startServer({
      pairing: { approve: () => true },
      permissions: { requireApproval: "none", maxAutoGrantRisk: "high" },
      onConsentRequest: prompt
    });
  }

  it("prompts before each use and passes the request payload", async () => {
    const prompt = vi.fn((_request: ConsentRequest) => "once" as const);
    const server = await consentServer(prompt);
    const { identity, record } = await pairDevice(server, ["shell.exec"]);
    const link = await connectDevice(server, identity, record);

    expect(await link.call("shell.run", { cmd: "ls" })).toEqual({ ran: { cmd: "ls" } });
    await link.call("shell.run", { cmd: "pwd" });

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[0]![0]).toMatchObject({
      capability: "shell.exec",
      method: "shell.run",
      title: "Run a command",
      description: "Runs a shell command on this computer",
      risk: "high",
      input: { cmd: "ls" }
    });
    link.close();
  }, 15000);

  it("refuses the call when the user declines, despite the grant", async () => {
    const server = await consentServer(() => false);
    const { identity, record } = await pairDevice(server, ["shell.exec"]);
    const link = await connectDevice(server, identity, record);

    await expect(link.call("shell.run", { cmd: "rm -rf /" })).rejects.toMatchObject({
      code: ErrorCodes.CONSENT_DENIED
    });
    link.close();
  }, 15000);

  it("stops asking after an 'always' answer, and asks again once cleared", async () => {
    const prompt = vi.fn((_request: ConsentRequest) => "always" as const);
    const server = await consentServer(prompt);
    const { identity, record } = await pairDevice(server, ["shell.exec"]);
    const link = await connectDevice(server, identity, record);

    await link.call("shell.run", { cmd: "a" });
    await link.call("shell.run", { cmd: "b" });
    expect(prompt).toHaveBeenCalledTimes(1);

    server.clearConsent(identity.deviceId);
    await link.call("shell.run", { cmd: "c" });
    expect(prompt).toHaveBeenCalledTimes(2);
    link.close();
  }, 15000);

  it("refuses a confirmEachUse method when no prompt is configured", async () => {
    const server = await startServer({
      pairing: { approve: () => true },
      permissions: { requireApproval: "none", maxAutoGrantRisk: "high" }
    });
    const { identity, record } = await pairDevice(server, ["shell.exec"]);
    const link = await connectDevice(server, identity, record);

    await expect(link.call("shell.run", { cmd: "ls" })).rejects.toMatchObject({
      code: ErrorCodes.CONSENT_DENIED
    });
    link.close();
  }, 15000);

  it("does not prompt for ordinary capabilities", async () => {
    const prompt = vi.fn((_request: ConsentRequest) => "once" as const);
    const server = await consentServer(prompt);
    const { identity, record } = await pairDevice(server, ["notes.read"]);
    const link = await connectDevice(server, identity, record);

    await link.call("notes.list");
    expect(prompt).not.toHaveBeenCalled();
    link.close();
  }, 15000);
});

describe("identity and secrets", () => {
  it("keeps the identity seed in the secret store, not on disk", async () => {
    const secretStore = new MemorySecretStore();
    const dir = storageDir();
    const server = await startServer({ secretStore, storageDir: dir });

    expect(await secretStore.get("host.identity.seed")).toBeTruthy();
    expect(server.fingerprintHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps the same identity across restarts", async () => {
    const secretStore = new MemorySecretStore();
    const dir = storageDir();

    const first = await startServer({ secretStore, storageDir: dir });
    const fingerprint = first.fingerprintHex;
    await first.stop();

    const second = await startServer({ secretStore, storageDir: dir });
    expect(second.fingerprintHex).toBe(fingerprint);
  });

  it("keeps paired devices across restarts", async () => {
    const secretStore = new MemorySecretStore();
    const dir = storageDir();

    const first = await startServer({
      secretStore,
      storageDir: dir,
      pairing: { autoApprove: true }
    });
    const { identity } = await pairDevice(first, ["notes.read"]);
    await first.stop();

    const second = await startServer({
      secretStore,
      storageDir: dir,
      pairing: { autoApprove: true }
    });
    expect(second.listDevices().map((d) => d.deviceId)).toContain(identity.deviceId);
    expect(second.grantedCapabilities(identity.deviceId)).toEqual(["notes.read"]);
  });

  it("does not renew a grant expiry just because the host restarted", async () => {
    const secretStore = new MemorySecretStore();
    const dir = storageDir();
    const permissions = { grantTtlMs: 50 } as const;

    const first = await startServer({
      secretStore,
      storageDir: dir,
      pairing: { autoApprove: true },
      permissions
    });
    const { identity } = await pairDevice(first, ["notes.read"]);
    await first.stop();
    await new Promise((r) => setTimeout(r, 80));

    const second = await startServer({
      secretStore,
      storageDir: dir,
      pairing: { autoApprove: true },
      permissions
    });
    // The TTL is measured from when the device was paired, not from boot.
    expect(second.grantedCapabilities(identity.deviceId)).toEqual([]);
  });

  it("reports the secret backend and permission posture in status()", async () => {
    const server = await startServer({ permissions: { maxAutoGrantRisk: "medium" } });
    const status = server.status() as {
      secrets: { backend: string };
      permissions: { capabilities: Array<{ id: string; confirmEachUse: boolean }> };
    };

    expect(status.secrets.backend).toBe("memory");
    expect(status.permissions.capabilities).toContainEqual(
      expect.objectContaining({ id: "shell.exec", confirmEachUse: true })
    );
  });
});

describe("device management", () => {
  it("lists, renames and revokes devices", async () => {
    const server = await startServer({ pairing: { autoApprove: true } });
    const { identity } = await pairDevice(server, ["notes.read"]);

    expect(server.listDevices()).toHaveLength(1);
    server.renameDevice(identity.deviceId, "Kitchen Tablet");
    expect(server.listDevices()[0].name).toBe("Kitchen Tablet");

    expect(server.revokeDevice(identity.deviceId)).toBe(true);
    expect(server.listDevices()[0].revokedAt).toBeGreaterThan(0);
    // A second revoke is a no-op, not an error.
    expect(server.revokeDevice(identity.deviceId)).toBe(false);
  });

  it("refuses a revoked device a fresh connection", async () => {
    const server = await startServer({ pairing: { autoApprove: true } });
    const { identity, record } = await pairDevice(server, ["notes.read"]);
    server.revokeDevice(identity.deviceId);

    await expect(connectDevice(server, identity, record)).rejects.toMatchObject({
      code: ErrorCodes.DEVICE_REVOKED
    });
  }, 15000);

  it("revokes every device at once", async () => {
    const server = await startServer({ pairing: { autoApprove: true } });
    await pairDevice(server, ["notes.read"]);
    await pairDevice(server, ["notes.read"]);

    server.revokeAllDevices();
    expect(server.listDevices().every((d) => d.revokedAt !== undefined)).toBe(true);
  });
});

describe("device link (Add to Home Screen continuation)", () => {
  it("mints a link URI over RPC, completes it with inherited caps, and cascades revoke", async () => {
    const server = await startServer({
      pairing: { autoApprove: true },
      networkMode: "lan-and-relay",
      signalingUrl: "https://signal.crosslink.app",
      relayUrl: "https://relay.crosslink.app",
      lan: { enabled: false }
    });
    const { identity: id1, record: rec1 } = await pairDevice(server, ["notes.read"]);
    const link1 = await connectDevice(server, id1, rec1);

    const { uri } = (await link1.call(DEVICE_LINK_RPC_METHOD)) as { uri: string; expiresAt: number };
    const parsed = parsePairingUri(uri);
    expect(parsed.link).toBe(true);

    const pairing = (server as unknown as { pairing: import("@crosslink/core").HostPairingManager })
      .pairing;
    const psid = pairing.resolveCode(parsed.code);
    if (!psid) throw new Error("link code did not resolve");

    const clientIdentity2 = DeviceIdentity.create();
    const { claim, state } = createClaim(clientIdentity2, parsed, "Installed Icon");
    signClaim(clientIdentity2, claim, psid);
    const challenge = await new Promise<Record<string, unknown>>((resolve) => {
      void pairing.handleClaim(claim, (f) => resolve(f as Record<string, unknown>));
    });
    if (challenge.kind === "pair_error") {
      throw Object.assign(new Error("link refused"), { detail: challenge.error });
    }

    const { complete, record: record2 } = await processChallenge(
      clientIdentity2,
      parsed,
      state,
      challenge,
      () => true
    );
    await new Promise<void>((resolve, reject) => {
      try {
        pairing.handleComplete(complete, () => resolve());
      } catch (err) {
        reject(err);
      }
    });

    expect(record2.grantedCaps).toEqual(["notes.read"]);
    expect(record2.fingerprint).toBe(rec1.fingerprint);
    const link2 = await connectDevice(server, clientIdentity2, record2);
    expect(await link2.call("notes.list")).toEqual(["alpha"]);

    expect(server.revokeDevice(id1.deviceId)).toBe(true);
    const linked = server.listDevices().find((d) => d.deviceId === clientIdentity2.deviceId);
    expect(linked?.revokedAt).toBeDefined();
    await vi.waitFor(() => expect(link2.currentState).toBe("revoked"), { timeout: 10000 });
    expect(server.grantedCapabilities(clientIdentity2.deviceId)).toEqual([]);
  }, 15000);
});

describe("logging", () => {
  it("records the host lifecycle under stable event ids", async () => {
    const sink = new MemoryLogSink();
    const server = await startServer({ logger: sink.logger(), pairing: { autoApprove: true } });
    const { identity, record } = await pairDevice(server, ["notes.read"]);
    const link = await connectDevice(server, identity, record);
    await link.call("notes.list");
    link.close();

    const events = sink.records.map((r) => r.event);
    expect(events).toContain("server.started");
    expect(events).toContain("pairing.completed");
    expect(events).toContain("device.connected");
    expect(events).toContain("acceptor.session-established");
  }, 15000);

  it("logs a denial with the capabilities the device actually holds", async () => {
    const sink = new MemoryLogSink();
    const server = await startServer({ logger: sink.logger(), pairing: { autoApprove: true } });
    const { identity, record } = await pairDevice(server, ["notes.read"]);
    const link = await connectDevice(server, identity, record);

    await expect(link.call("notes.create", { title: "x" })).rejects.toThrow();

    const denial = sink.records.find((r) => r.event === "rpc.denied");
    expect(denial?.fields).toMatchObject({
      method: "notes.create",
      code: ErrorCodes.CAPABILITY_DENIED,
      granted: ["notes.read"]
    });
    link.close();
  }, 15000);

  it("never writes the identity seed into a log record", async () => {
    const secretStore = new MemorySecretStore();
    const sink = new MemoryLogSink();
    await startServer({ logger: sink.logger(), secretStore });

    const seed = await secretStore.get("host.identity.seed");
    expect(JSON.stringify(sink.records)).not.toContain(seed);
  });
});

describe("hosted bootstrap", () => {
  it("generates unique install metadata whose start URL carries only the opaque handoff id", () => {
    const handoffId = "opaque-install-handoff-token-1234567890";
    const manifestUrl = buildInstallManifestUrl("/manifest.webmanifest", handoffId, 123456789);
    const startUrl = buildInstallStartUrl("/mobile.html", handoffId);

    expect(manifestUrl).toBe(
      `/manifest.webmanifest?crosslink_install=${encodeURIComponent(handoffId)}&v=123456789`
    );
    expect(startUrl).toBe(`/mobile.html?crosslink_install=${encodeURIComponent(handoffId)}`);
    expect(startUrl).not.toContain("crosslink%3A%2F%2Fpair");
    expect(startUrl).not.toContain("l=1");
  });

  it("includes a bootstrapUri when pairing.bootstrapUrl is set", async () => {
    const server = await startServer({
      pairing: { autoApprove: true, bootstrapUrl: "https://my-pwa.netlify.app" },
      networkMode: "lan-and-relay",
      signalingUrl: "https://signal.crosslink.app",
      relayUrl: "https://relay.crosslink.app",
      lan: { enabled: false },
    });
    const info = await server.getPairingCode();
    expect(info.bootstrapUri).toBeTruthy();
    expect(info.bootstrapUri).toMatch(/^https:\/\/my-pwa\.netlify\.app#pair=/);
    // The bootstrap URI decodes to a valid crosslink:// manifest URI
    const fragment = info.bootstrapUri!.split("#")[1];
    const params = new URLSearchParams(fragment);
    const embedded = params.get("pair");
    expect(embedded).toMatch(/^crosslink:\/\/pair\?/);
    expect(info.qrSvg).toBeTruthy();
  }, 10000);

  it("falls back to a crosslink:// QR when no bootstrapUrl is set", async () => {
    const server = await startServer({
      networkMode: "lan-and-relay",
      signalingUrl: "https://signal.crosslink.app",
      relayUrl: "https://relay.crosslink.app",
      lan: { enabled: false },
    });
    const info = await server.getPairingCode();
    // No bootstrap URL means no bootstrapUri and the QR is the raw manifest
    expect(info.bootstrapUri).toBeFalsy();
    expect(info.qrSvg).toBeTruthy();
  }, 10000);
});

describe("connectivity", () => {
  it("reports local-only when no relay/signaling is configured", async () => {
    const server = await startServer({ lan: { enabled: true, bind: "all" } });
    const status = server.getConnectivity();
    expect(status.lan).toBe(true);
    expect(status.relay).toBe(false);
    expect(status.signaling).toBe(false);
    expect(status.reach).toBe("local-only");
    expect(status.message).toContain("Wi-Fi");
  });

  it("reports offline when nothing is configured", async () => {
    const server = await startServer({ lan: { enabled: false } });
    const status = server.getConnectivity();
    expect(status.lan).toBe(false);
    expect(status.relay).toBe(false);
    expect(status.signaling).toBe(false);
    expect(status.reach).toBe("offline");
    expect(status.message).toContain("No inbound path");
  });

  it("reports internet reachability when a tunnel is configured", async () => {
    const server = await startServer({
      networkMode: "auto",
      lan: { enabled: true, bind: "all" },
      tunnelUrl: "https://crosslink-test.trycloudflare.com",
    });
    const status = server.getConnectivity();
    expect(status.reach).toBe("relayed");
    expect(status.message).toContain("anywhere");
    expect(status.transports.tunnel).toBe("https://crosslink-test.trycloudflare.com");
  });

  it("emits connectivity event on startup", async () => {
    const events: string[] = [];
    const server = createCrosslinkServer({
      application: { id: APP_ID, name: "Test", version: "1.0" },
      storageDir: storageDir(),
      lan: { enabled: true, bind: "all" },
      networkMode: "local-only",
      secretStore: new MemorySecretStore(),
      pairing: { autoApprove: true },
    });
    server.on("connectivity", (status) => events.push(status.reach));
    await server.start();
    await server.stop();
    expect(events).toContain("local-only");
  });

  it("reports webrtc as enabled when configured", async () => {
    const mockPeer = {
      createDataChannel: () => ({
        readyState: "open",
        binaryType: "arraybuffer",
        send: () => {},
        close: () => {},
        onmessage: null,
        onopen: null,
        onclose: null,
        onerror: null,
      }),
      createOffer: async () => ({ type: "offer", sdp: "" }),
      createAnswer: async () => ({ type: "answer", sdp: "" }),
      setLocalDescription: async () => {},
      setRemoteDescription: async () => {},
      close: () => {},
      localDescription: null,
    };
    const server = await startServer({
      lan: { enabled: false },
      webrtc: {
        createPeer: () => mockPeer as never,
      },
    });
    const status = server.getConnectivity();
    expect(status.webrtc).toBe(true);
  });
});

describe("networkMode", () => {
  it("respects local-only mode by not connecting relay/signaling", async () => {
    const server = await startServer({
      networkMode: "local-only",
      signalingUrl: "https://signal.crosslink.app",
      relayUrl: "https://relay.crosslink.app",
      lan: { enabled: true, bind: "all" },
    });
    const status = server.getConnectivity();
    expect(status.lan).toBe(true);
    expect(status.relay).toBe(false);
    expect(status.signaling).toBe(false);
  });

  it("filters the routes advertised by a runtime pairing-mode selection", async () => {
    const server = await startServer({
      networkMode: "auto",
      tunnelUrl: "https://chat.example.test",
      signalingUrl: "https://signal.crosslink.app",
      relayUrl: "https://relay.crosslink.app",
      lan: { enabled: true, bind: "all" },
    });

    expect(server.connectionEndpoints("local-only").map((endpoint) => endpoint.kind)).toEqual(["lan"]);
    expect(server.connectionEndpoints("lan-and-relay").map((endpoint) => endpoint.kind)).toEqual([
      "lan",
      "sig",
      "relay",
    ]);
    expect(server.connectionEndpoints("remote").map((endpoint) => endpoint.kind)).toContain("tunnel");

    const localPair = await server.getPairingCode(undefined, "local-only");
    expect(localPair.endpoints?.map((endpoint) => endpoint.kind)).toEqual(["lan"]);
  });
});

describe("security", () => {
  it("enforces maxActivePairingSessions limit", async () => {
    const server = await startServer({
      networkMode: "lan-and-relay",
      security: { maxActivePairingSessions: 2 },
      signalingUrl: "https://signal.crosslink.app",
      lan: { enabled: false },
    });
    // First two should succeed
    await server.getPairingCode();
    await server.getPairingCode();
    // Third should fail
    await expect(server.getPairingCode()).rejects.toThrow(/too many active pairing/);
  });

  it("cleans up expired sessions before checking limits", async () => {
    const server = await startServer({
      networkMode: "lan-and-relay",
      security: { maxActivePairingSessions: 1 },
      pairing: { ttlMs: 1 }, // 1ms TTL — expires immediately
      signalingUrl: "https://signal.crosslink.app",
      lan: { enabled: false },
    });
    const info = await server.getPairingCode();
    // Wait for the session to expire
    await new Promise((r) => setTimeout(r, 10));
    // Should be able to create a new one since the old one expired
    const info2 = await server.getPairingCode();
    expect(info2.code).toBeTruthy();
    expect(info2.code).not.toBe(info.code);
  });

  it("enforces pairingRateLimitMs globally and per IP", async () => {
    const server = await startServer({
      networkMode: "lan-and-relay",
      security: { pairingRateLimitMs: 100 },
      signalingUrl: "https://signal.crosslink.app",
      lan: { enabled: false },
    });
    // First should succeed
    await server.getPairingCode("1.2.3.4");
    // Second from same IP should fail
    await expect(server.getPairingCode("1.2.3.4")).rejects.toThrow(/rate limit exceeded/);
    // From a different IP should succeed
    await server.getPairingCode("5.6.7.8");
    // Wait for the window to pass
    await new Promise((r) => setTimeout(r, 120));
    // Now it should succeed
    await server.getPairingCode("1.2.3.4");
  });

  it("enforces localNetworkOnly on incoming transports", async () => {
    const server = await startServer({
      security: { localNetworkOnly: true },
      lan: { enabled: false },
    });

    const mockLocalTransport = {
      kind: "lan" as const,
      remoteAddress: "192.168.1.100",
      send: () => {},
      close: vi.fn(),
      onData: () => {},
      onClose: () => {},
    };
    const mockRemoteTransport = {
      kind: "lan" as const,
      remoteAddress: "8.8.8.8",
      send: () => {},
      close: vi.fn(),
      onData: () => {},
      onClose: () => {},
    };
    const mockRelayTransport = {
      kind: "crosslink-relayed" as const,
      send: () => {},
      close: vi.fn(),
      onData: () => {},
      onClose: () => {},
    };

    // Accept local -> shouldn't close it
    (server as any).acceptTransport(mockLocalTransport);
    expect(mockLocalTransport.close).not.toHaveBeenCalled();

    // Accept remote -> should close it immediately
    (server as any).acceptTransport(mockRemoteTransport);
    expect(mockRemoteTransport.close).toHaveBeenCalledWith("local-network-only-enforced");

    // Accept relay -> should close it immediately
    (server as any).acceptTransport(mockRelayTransport);
    expect(mockRelayTransport.close).toHaveBeenCalledWith("local-network-only-enforced");
  });
});

describe("mDNS discovery", () => {
  it("starts and stops mdns advertisement when configured", async () => {
    const server = createCrosslinkServer({
      application: { id: APP_ID, name: "Test Host", version: "1.0.0" },
      storageDir: storageDir(),
      lan: { enabled: true },
      networkMode: "local-only",
      mdns: { enabled: true, name: "Custom Name" },
      secretStore: new MemorySecretStore(),
    });
    await server.start();
    expect((server as any).mdnsBrowser).toBeDefined();
    await server.stop();
    expect((server as any).mdnsBrowser).toBeUndefined();
  });
});
