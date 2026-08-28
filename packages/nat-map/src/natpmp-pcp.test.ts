import dgram from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";
import { NATPMP_PORT, natPmpExternalAddress, natPmpMapTcp } from "./natpmp.js";
import { PCP_PORT, pcpMapTcp } from "./pcp.js";

// natPmpExternalAddress/natPmpMapTcp/pcpMapTcp all hardcode their protocol's
// port (NATPMP_PORT and PCP_PORT are both 5351 — RFC 6887) — there is no port
// parameter to redirect them, so the fake server must bind exactly there on
// loopback. NAT-PMP and PCP tests are kept in this one file (rather than
// split across natpmp.test.ts / pcp.test.ts) so vitest never runs two files
// that both try to bind 127.0.0.1:5351 concurrently.
async function bindFakeServer(port: number): Promise<dgram.Socket> {
  const socket = dgram.createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, "127.0.0.1", () => resolve());
  });
  return socket;
}

describe("natpmp", () => {
  const sockets: dgram.Socket[] = [];
  afterEach(() => {
    for (const s of sockets.splice(0)) {
      try {
        s.close();
      } catch {
        /* already closed */
      }
    }
  });

  it("sends an exact 2-byte [0,0] external-address request and parses the router's chosen address", async () => {
    const socket = await bindFakeServer(NATPMP_PORT);
    sockets.push(socket);

    let received: Buffer | null = null;
    socket.on("message", (msg, rinfo) => {
      received = Buffer.from(msg);
      const reply = new Uint8Array(12);
      reply[0] = 0; // version
      reply[1] = 128; // response opcode = request opcode | 0x80
      reply[2] = 0;
      reply[3] = 0; // result code 0 = success
      reply[4] = 0x00;
      reply[5] = 0x00;
      reply[6] = 0x00;
      reply[7] = 0x2a; // seconds since epoch, arbitrary
      reply[8] = 203;
      reply[9] = 0;
      reply[10] = 113;
      reply[11] = 5; // external address 203.0.113.5
      socket.send(reply, rinfo.port, rinfo.address);
    });

    const address = await natPmpExternalAddress("127.0.0.1", 1000);

    expect(received).not.toBeNull();
    expect(Array.from(received!)).toEqual([0, 0]);
    expect(address).toBe("203.0.113.5");
  });

  it("sends a 12-byte map request with correct opcode, ports and lifetime, and returns the router's chosen external port", async () => {
    const socket = await bindFakeServer(NATPMP_PORT);
    sockets.push(socket);

    let received: Buffer | null = null;
    socket.on("message", (msg, rinfo) => {
      received = Buffer.from(msg);
      const reply = new Uint8Array(16);
      reply[0] = 0;
      reply[1] = 130; // 2 | 0x80
      reply[2] = 0;
      reply[3] = 0; // success
      reply[4] = reply[5] = reply[6] = 0;
      reply[7] = 1; // seconds since epoch
      reply[8] = 0x1f;
      reply[9] = 0x90; // internal port echoed = 8080
      // Router hands back a DIFFERENT external port than what we suggested.
      reply[10] = 0x27;
      reply[11] = 0x10; // external port = 10000
      reply[12] = 0x00;
      reply[13] = 0x00;
      reply[14] = 0x0e;
      reply[15] = 0x10; // lifetime = 3600
      socket.send(reply, rinfo.port, rinfo.address);
    });

    const mapping = await natPmpMapTcp("127.0.0.1", 8080, 9999, 3600, 1000);

    expect(received).not.toBeNull();
    const req = received!;
    expect(req.length).toBe(12);
    expect(req[0]).toBe(0); // version
    expect(req[1]).toBe(2); // opcode = map TCP
    expect(req[2]).toBe(0);
    expect(req[3]).toBe(0); // reserved
    expect((req[4] << 8) | req[5]).toBe(8080); // internal port
    expect((req[6] << 8) | req[7]).toBe(9999); // suggested external port
    const lifetime =
      (req[8] * 0x1000000) + ((req[9] << 16) | (req[10] << 8) | req[11]);
    expect(lifetime).toBe(3600);

    expect(mapping).not.toBeNull();
    expect(mapping!.internalPort).toBe(8080);
    // The router's chosen port differs from the suggestion — the caller must
    // use this value, not the one it suggested.
    expect(mapping!.externalPort).toBe(10000);
    expect(mapping!.lifetimeSeconds).toBe(3600);
  });

  it("throws with the mapped human-readable reason for a non-zero result code (2 = not authorized)", async () => {
    const socket = await bindFakeServer(NATPMP_PORT);
    sockets.push(socket);

    socket.on("message", (_msg, rinfo) => {
      const reply = new Uint8Array(16);
      reply[0] = 0;
      reply[1] = 130;
      reply[2] = 0;
      reply[3] = 2; // not authorized
      socket.send(reply, rinfo.port, rinfo.address);
    });

    await expect(natPmpMapTcp("127.0.0.1", 8080, 8080, 3600, 1000)).rejects.toThrow(
      /not authorized/i
    );
  });

  it("resolves null on timeout when the router never answers", async () => {
    // Nothing is bound on NATPMP_PORT for this test — aim at loopback with a
    // short timeout and no responder.
    const result = await natPmpMapTcp("127.0.0.1", 8080, 8080, 3600, 150);
    expect(result).toBeNull();
  });
});

describe("pcp", () => {
  const sockets: dgram.Socket[] = [];
  afterEach(() => {
    for (const s of sockets.splice(0)) {
      try {
        s.close();
      } catch {
        /* already closed */
      }
    }
  });

  function readUint32BE(buf: Buffer, offset: number): number {
    return buf.readUInt32BE(offset);
  }

  it("sends a 60-byte MAP request with correct version/opcode/lifetime/address/protocol/ports", async () => {
    const socket = await bindFakeServer(PCP_PORT);
    sockets.push(socket);

    let received: Buffer | null = null;
    socket.on("message", (msg, rinfo) => {
      received = Buffer.from(msg);
      const nonce = received.subarray(24, 36);
      const reply = new Uint8Array(60);
      reply[0] = 2; // version
      reply[1] = 0x80 | 1; // response, opcode MAP
      reply[2] = 0;
      reply[3] = 0; // result code success
      // lifetime at offset 4
      reply[4] = 0x00;
      reply[5] = 0x00;
      reply[6] = 0x0e;
      reply[7] = 0x10; // 3600
      // epoch at offset 8..11 (part of the "client address" region reused for
      // epoch in the response header per RFC 6887 §7.2) — not asserted here.
      reply.set(nonce, 24);
      reply[36] = 6; // protocol TCP, echoed
      reply[40] = 0x1f;
      reply[41] = 0x90; // internal port 8080
      reply[42] = 0x27;
      reply[43] = 0x10; // external port 10000
      // external address, IPv4-mapped, at offset 44 (bytes 56-59 = IPv4)
      reply[44 + 10] = 0xff;
      reply[44 + 11] = 0xff;
      reply[56] = 203;
      reply[57] = 0;
      reply[58] = 113;
      reply[59] = 5;
      socket.send(reply, rinfo.port, rinfo.address);
    });

    const mapping = await pcpMapTcp("127.0.0.1", "192.168.1.50", 8080, 9999, 3600, 1000);

    expect(received).not.toBeNull();
    const req = received!;
    expect(req.length).toBe(60);
    expect(req[0]).toBe(2); // PCP version
    expect(req[1]).toBe(1); // opcode MAP, request (high bit clear)
    expect(readUint32BE(req, 4)).toBe(3600); // lifetime
    // client address is IPv4-mapped ::ffff:192.168.1.50 at offset 8 (16 bytes)
    for (let i = 0; i < 10; i += 1) expect(req[8 + i]).toBe(0);
    expect(req[18]).toBe(0xff);
    expect(req[19]).toBe(0xff);
    expect(req[20]).toBe(192);
    expect(req[21]).toBe(168);
    expect(req[22]).toBe(1);
    expect(req[23]).toBe(50);
    expect(req[36]).toBe(6); // protocol TCP
    expect((req[40] << 8) | req[41]).toBe(8080); // internal port
    expect((req[42] << 8) | req[43]).toBe(9999); // suggested external port

    expect(mapping).not.toBeNull();
    expect(mapping!.internalPort).toBe(8080);
    expect(mapping!.externalPort).toBe(10000);
    expect(mapping!.lifetimeSeconds).toBe(3600);
    expect(mapping!.externalAddress).toBe("203.0.113.5");
  });

  it("rejects a reply with the wrong nonce and resolves the reply whose nonce matches", async () => {
    const socket = await bindFakeServer(PCP_PORT);
    sockets.push(socket);

    socket.on("message", (msg, rinfo) => {
      const req = Buffer.from(msg);
      const correctNonce = req.subarray(24, 36);
      const wrongNonce = Buffer.alloc(12, 0xee);

      const buildReply = (nonce: Buffer): Uint8Array => {
        const reply = new Uint8Array(60);
        reply[0] = 2;
        reply[1] = 0x80 | 1;
        reply[2] = 0;
        reply[3] = 0;
        reply[7] = 0x10; // some lifetime
        reply.set(nonce, 24);
        reply[36] = 6;
        reply[40] = 0x1f;
        reply[41] = 0x90;
        reply[42] = 0x1f;
        reply[43] = 0x90;
        reply[44 + 10] = 0xff;
        reply[44 + 11] = 0xff;
        reply[56] = 198;
        reply[57] = 51;
        reply[58] = 100;
        reply[59] = 1;
        return reply;
      };

      // Wrong nonce first — the client's accept() must ignore this one.
      socket.send(buildReply(wrongNonce), rinfo.port, rinfo.address);
      setTimeout(() => {
        socket.send(buildReply(correctNonce), rinfo.port, rinfo.address);
      }, 30);
    });

    const mapping = await pcpMapTcp("127.0.0.1", "192.168.1.50", 8080, 8080, 16, 1500);
    expect(mapping).not.toBeNull();
    expect(mapping!.externalAddress).toBe("198.51.100.1");
  });

  it("throws with the RFC 6887 reason for a non-zero result code", async () => {
    const socket = await bindFakeServer(PCP_PORT);
    sockets.push(socket);

    socket.on("message", (msg, rinfo) => {
      const req = Buffer.from(msg);
      const nonce = req.subarray(24, 36);
      const reply = new Uint8Array(60);
      reply[0] = 2;
      reply[1] = 0x80 | 1;
      reply[3] = 3; // malformed request
      reply.set(nonce, 24);
      socket.send(reply, rinfo.port, rinfo.address);
    });

    await expect(
      pcpMapTcp("127.0.0.1", "192.168.1.50", 8080, 8080, 3600, 1000)
    ).rejects.toThrow(/malformed request/i);
  });

  it("resolves null on timeout when the gateway never answers", async () => {
    const result = await pcpMapTcp("127.0.0.1", "192.168.1.50", 8080, 8080, 3600, 150);
    expect(result).toBeNull();
  });
});
