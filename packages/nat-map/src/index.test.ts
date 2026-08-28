import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { tryNatMapping, verifyExternalReachability } from "./index.js";

describe("tryNatMapping", () => {
  it("never throws, and resolves mapped:false/reachable:false/confidence:none with attempts and a message when nothing answers", async () => {
    const result = await tryNatMapping({
      internalPort: 45123,
      protocol: "upnp",
      skipStun: true,
      timeoutMs: 200
    });

    expect(result.mapped).toBe(false);
    expect(result.reachable).toBe(false);
    expect(result.confidence).toBe("none");
    expect(result.attempts.length).toBeGreaterThan(0);
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.protocol).toBe("none");
  }, 10000);

  it("advertises a configured public host as a manual endpoint when no protocol answers", async () => {
    const result = await tryNatMapping({
      internalPort: 45123,
      externalPort: 8787,
      publicHost: "home.example.net",
      protocol: "upnp",
      skipStun: true,
      timeoutMs: 200
    });

    expect(result.mapped).toBe(false);
    expect(result.manual).toBe(true);
    expect(result.reachable).toBe(true);
    expect(result.confidence).toBe("manual");
    expect(result.externalAddress).toBe("home.example.net");
    expect(result.externalPort).toBe(8787);
  }, 10000);

  it("does not invent a manual endpoint when assumeForwarded has no public address to use", async () => {
    const result = await tryNatMapping({
      internalPort: 45123,
      assumeForwarded: true,
      protocol: "upnp",
      skipStun: true,
      timeoutMs: 200
    });

    expect(result.reachable).toBe(false);
    expect(result.confidence).toBe("none");
    expect(result.externalAddress).toBeUndefined();
  }, 10000);
});

describe("verifyExternalReachability", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  it("returns reachable:false with a detail string against a closed local port", async () => {
    // Bind and immediately close to obtain a port nothing is listening on.
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const result = await verifyExternalReachability(`http://127.0.0.1:${port}/`, 500);
    expect(result.reachable).toBe(false);
    expect(typeof result.detail).toBe("string");
    expect(result.detail.length).toBeGreaterThan(0);
  });

  it("returns reachable:true against a live local HTTP server", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;

    const result = await verifyExternalReachability(`http://127.0.0.1:${port}/`, 1500);
    expect(result.reachable).toBe(true);
    expect(result.detail).toContain("200");
  });
});
