import { afterEach, describe, expect, it } from "vitest";
import { createRelayServer, type RelayServer } from "../../../services/relay/src/index.js";
import { RelayChannel } from "./relay-host.js";

describe("regional relay allocation", () => {
  const servers: RelayServer[] = [];
  afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

  it("falls through an unavailable region and connects to the next one", async () => {
    const relay = await createRelayServer({ port: 0 });
    servers.push(relay);
    const healthy = `http://127.0.0.1:${relay.port}`;

    const channel = await RelayChannel.allocateAny([
      "http://127.0.0.1:1",
      healthy
    ]);
    expect(channel.info.url).toBe(healthy);
    await channel.connect();
    expect(channel.connected).toBe(true);
    channel.close();
  });

  it("does not hide an authentication failure by trying another region", async () => {
    const protectedRelay = await createRelayServer({ port: 0, authToken: "right" });
    const fallbackRelay = await createRelayServer({ port: 0 });
    servers.push(protectedRelay, fallbackRelay);

    await expect(RelayChannel.allocateAny([
      `http://127.0.0.1:${protectedRelay.port}`,
      `http://127.0.0.1:${fallbackRelay.port}`
    ], { authToken: "wrong" })).rejects.toThrow(/auth token/);
  });
});
