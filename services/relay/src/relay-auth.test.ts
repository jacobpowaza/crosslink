/**
 * Relay authentication and channel multiplexing.
 *
 * Multiplexing is what makes "paired but off-network" work for more than one
 * device at a time: without it the second device to dial a host's relay
 * channel is refused outright.
 */
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createRelayServer, STREAM_HEADER_BYTES, type RelayServer } from "./index.js";

const servers: RelayServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function startRelay(
  options: Parameters<typeof createRelayServer>[0] = {}
): Promise<{ server: RelayServer; base: string }> {
  const server = await createRelayServer({ port: 0, ...options });
  servers.push(server);
  return { server, base: `http://127.0.0.1:${server.port}` };
}

/**
 * Buffers everything a socket receives from the moment it is created.
 *
 * The relay sends `host_ready` the instant a host attaches, which can land
 * before a listener attached after `await waitOpen` would see it; buffering
 * from construction removes that race from the tests entirely.
 */
class Tap {
  private readonly ops: Record<string, unknown>[] = [];
  private readonly binaries: Buffer[] = [];
  private readonly wakeups: Array<() => void> = [];

  constructor(readonly ws: WebSocket) {
    ws.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) this.binaries.push(raw as Buffer);
      else {
        try {
          this.ops.push(JSON.parse(raw.toString()) as Record<string, unknown>);
        } catch {
          /* not a control frame we care about */
        }
      }
      for (const wake of this.wakeups.splice(0)) wake();
    });
  }

  static connect(url: string, options?: { headers: Record<string, string> }): Tap {
    return new Tap(new WebSocket(url, options));
  }

  open(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      const timer = setTimeout(() => reject(new Error("timeout waiting for open")), timeoutMs);
      this.ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      this.ws.once("close", (code, reason) => {
        clearTimeout(timer);
        reject(new Error(`closed before open: ${code} ${reason.toString()}`));
      });
    });
  }

  /** Resolves with the first buffered or future message matching `op`. */
  async op(name: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = this.ops.findIndex((m) => m.op === name);
      if (idx >= 0) return this.ops.splice(idx, 1)[0];
      if (Date.now() >= deadline) throw new Error(`timeout waiting for ${name}`);
      await this.tick(deadline - Date.now());
    }
  }

  async binary(timeoutMs = 5000): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.binaries.length > 0) return this.binaries.shift()!;
      if (Date.now() >= deadline) throw new Error("timeout waiting for binary");
      await this.tick(deadline - Date.now());
    }
  }

  /** Binary frames seen so far, without consuming them. */
  get seenBinaries(): readonly Buffer[] {
    return this.binaries;
  }

  close(): void {
    this.ws.close();
  }

  private tick(remainingMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.min(25, Math.max(1, remainingMs)));
      this.wakeups.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once("close", (code) => resolve(code)));
}

async function allocate(
  base: string,
  token?: string
): Promise<{ channel_id: string; token: string }> {
  const res = await fetch(`${base}/channels`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { channel_id: string; token: string };
}

const wsBase = (base: string): string => base.replace("http", "ws");

const hostUrl = (
  base: string,
  channel: { channel_id: string; token: string },
  extra = ""
): string =>
  `${wsBase(base)}/ws?channel=${channel.channel_id}&role=h&mux=1&token=${channel.token}${extra}`;

const clientUrl = (base: string, channel: { channel_id: string }, extra = ""): string =>
  `${wsBase(base)}/ws?channel=${channel.channel_id}&role=c${extra}`;

/** Connects a multiplexing host and waits for the relay to acknowledge it. */
async function connectHost(
  base: string,
  channel: { channel_id: string; token: string },
  extra = ""
): Promise<Tap> {
  const host = Tap.connect(hostUrl(base, channel, extra));
  await host.open();
  await host.op("host_ready");
  return host;
}

/** Attaches a client and returns it with the stream id the host was told. */
async function attachClient(
  base: string,
  channel: { channel_id: string },
  host: Tap,
  extra = ""
): Promise<{ client: Tap; stream: number }> {
  const client = Tap.connect(clientUrl(base, channel, extra));
  await client.open();
  const stream = (await host.op("peer_up")).stream as number;
  return { client, stream };
}

/** Frames a payload the way a multiplexing host must. */
function frameFor(stream: number, payload: string): Buffer {
  const framed = Buffer.concat([Buffer.alloc(STREAM_HEADER_BYTES), Buffer.from(payload)]);
  framed.writeUInt32BE(stream, 0);
  return framed;
}

describe("relay auth token", () => {
  it("protects operational stats with the configured operator token", async () => {
    const { base } = await startRelay({ authToken: "s3cret" });
    const denied = await fetch(`${base}/stats`);
    expect(denied.status).toBe(401);
    expect(denied.headers.get("content-security-policy")).toContain("default-src 'none'");

    const allowed = await fetch(`${base}/stats`, {
      headers: { authorization: "Bearer s3cret" }
    });
    expect(allowed.status).toBe(200);
  });

  it("allows channel creation when no token is configured", async () => {
    const { base } = await startRelay();
    expect((await fetch(`${base}/channels`, { method: "POST" })).status).toBe(201);
  });

  it("rejects channel creation without the token", async () => {
    const { base } = await startRelay({ authToken: "s3cret" });
    const res = await fetch(`${base}/channels`, { method: "POST" });

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("rejects the wrong token", async () => {
    const { base } = await startRelay({ authToken: "s3cret" });
    const res = await fetch(`${base}/channels`, {
      method: "POST",
      headers: { authorization: "Bearer nope" }
    });
    expect(res.status).toBe(401);
  });

  it("accepts the right token", async () => {
    const { base } = await startRelay({ authToken: "s3cret" });
    const channel = await allocate(base, "s3cret");
    expect(channel.channel_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("rejects a host websocket without the service token", async () => {
    const { base } = await startRelay({ authToken: "s3cret" });
    const channel = await allocate(base, "s3cret");

    const ws = new WebSocket(hostUrl(base, channel));
    expect(await closeCode(ws)).toBe(4401);
  });

  it("accepts a host websocket presenting the token as a header", async () => {
    const { base } = await startRelay({ authToken: "s3cret" });
    const channel = await allocate(base, "s3cret");

    const host = Tap.connect(hostUrl(base, channel), {
      headers: { authorization: "Bearer s3cret" }
    });
    await host.open();
    expect(await host.op("host_ready")).toMatchObject({ mux: true });
    host.close();
  });

  it("accepts a host websocket presenting the token as a query parameter", async () => {
    const { base } = await startRelay({ authToken: "s3cret" });
    const channel = await allocate(base, "s3cret");
    const host = await connectHost(base, channel, "&auth=s3cret");
    host.close();
  });

  it("still requires the per-channel host token", async () => {
    // The service token says "you may use this relay"; the channel token says
    // "you are the host of this channel". Neither substitutes for the other.
    const { base } = await startRelay({ authToken: "s3cret" });
    const channel = await allocate(base, "s3cret");

    const ws = new WebSocket(
      `${wsBase(base)}/ws?channel=${channel.channel_id}&role=h&mux=1&token=wrong&auth=s3cret`
    );
    expect(await closeCode(ws)).toBe(4403);
  });

  it("leaves clients open when only the host token is configured", async () => {
    const { base } = await startRelay({ authToken: "s3cret" });
    const channel = await allocate(base, "s3cret");
    const host = await connectHost(base, channel, "&auth=s3cret");

    const { client } = await attachClient(base, channel, host);
    expect(await client.op("peer_up")).toBeTruthy();

    host.close();
    client.close();
  });

  it("rejects clients when a client token is configured and missing", async () => {
    const { base } = await startRelay({ clientAuthToken: "client-secret" });
    const channel = await allocate(base);

    const ws = new WebSocket(clientUrl(base, channel));
    expect(await closeCode(ws)).toBe(4401);
  });

  it("accepts clients presenting the configured client token", async () => {
    const { base } = await startRelay({ clientAuthToken: "client-secret" });
    const channel = await allocate(base);
    const host = await connectHost(base, channel);

    const { client } = await attachClient(base, channel, host, "&auth=client-secret");
    host.close();
    client.close();
  });

  it("reports the auth posture on /health", async () => {
    const { base } = await startRelay({ authToken: "s3cret" });
    const health = (await (await fetch(`${base}/health`)).json()) as { auth: string };
    expect(health.auth).toBe("required");
  });

  it("rejects an unknown channel regardless of auth", async () => {
    const { base } = await startRelay();
    const ws = new WebSocket(`${wsBase(base)}/ws?channel=deadbeef&role=c`);
    expect(await closeCode(ws)).toBe(4404);
  });
});

describe("relay multiplexing", () => {
  it("assigns a distinct stream id to each client", async () => {
    const { base } = await startRelay();
    const channel = await allocate(base);
    const host = await connectHost(base, channel);

    const a = await attachClient(base, channel, host);
    const b = await attachClient(base, channel, host);

    expect(a.stream).toBeGreaterThan(0);
    expect(b.stream).not.toBe(a.stream);

    host.close();
    a.client.close();
    b.client.close();
  });

  it("routes each client's frames to the host under its own stream id", async () => {
    const { base } = await startRelay();
    const channel = await allocate(base);
    const host = await connectHost(base, channel);

    const a = await attachClient(base, channel, host);
    const b = await attachClient(base, channel, host);

    a.client.ws.send(Buffer.from("hello from A"), { binary: true });
    const framedA = await host.binary();
    expect(framedA.readUInt32BE(0)).toBe(a.stream);
    expect(framedA.subarray(STREAM_HEADER_BYTES).toString()).toBe("hello from A");

    b.client.ws.send(Buffer.from("hello from B"), { binary: true });
    const framedB = await host.binary();
    expect(framedB.readUInt32BE(0)).toBe(b.stream);
    expect(framedB.subarray(STREAM_HEADER_BYTES).toString()).toBe("hello from B");

    host.close();
    a.client.close();
    b.client.close();
  });

  it("delivers a host reply only to the addressed client", async () => {
    const { base } = await startRelay();
    const channel = await allocate(base);
    const host = await connectHost(base, channel);

    const a = await attachClient(base, channel, host);
    const b = await attachClient(base, channel, host);

    host.ws.send(frameFor(a.stream, "only for A"), { binary: true });
    expect((await a.client.binary()).toString()).toBe("only for A");

    // Cross-delivery here would leak one device's ciphertext to another.
    await new Promise((r) => setTimeout(r, 100));
    expect(b.client.seenBinaries).toHaveLength(0);

    host.close();
    a.client.close();
    b.client.close();
  });

  it("strips the stream header before the client sees the frame", async () => {
    const { base } = await startRelay();
    const channel = await allocate(base);
    const host = await connectHost(base, channel);
    const { client, stream } = await attachClient(base, channel, host);

    host.ws.send(frameFor(stream, "payload"), { binary: true });
    expect((await client.binary()).toString()).toBe("payload");

    host.close();
    client.close();
  });

  it("drops a frame addressed to a stream that has gone away", async () => {
    const { base } = await startRelay();
    const channel = await allocate(base);
    const host = await connectHost(base, channel);
    const { client, stream } = await attachClient(base, channel, host);

    client.close();
    await host.op("peer_down");

    // The host must not be disconnected for addressing a stale stream: races
    // between a close and an in-flight reply are normal.
    host.ws.send(frameFor(stream, "too late"), { binary: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(host.ws.readyState).toBe(WebSocket.OPEN);

    host.close();
  });

  it("tells the host which stream went away", async () => {
    const { base } = await startRelay();
    const channel = await allocate(base);
    const host = await connectHost(base, channel);
    const { client, stream } = await attachClient(base, channel, host);

    client.close();
    expect((await host.op("peer_down")).stream).toBe(stream);

    host.close();
  });

  it("tells every client when the host disappears", async () => {
    const { base } = await startRelay();
    const channel = await allocate(base);
    const host = await connectHost(base, channel);

    const a = await attachClient(base, channel, host);
    const b = await attachClient(base, channel, host);

    host.close();
    // A client waiting out a heartbeat instead would take far longer to
    // notice its host is gone and start re-dialling.
    expect(await a.client.op("peer_down")).toBeTruthy();
    expect(await b.client.op("peer_down")).toBeTruthy();

    a.client.close();
    b.client.close();
  });

  it("refuses clients past the configured limit", async () => {
    const { base } = await startRelay({ maxClientsPerChannel: 1 });
    const channel = await allocate(base);
    const host = await connectHost(base, channel);
    const first = await attachClient(base, channel, host);

    const second = new WebSocket(clientUrl(base, channel));
    expect(await closeCode(second)).toBe(4429);

    host.close();
    first.client.close();
  });

  it("tells a reconnecting host about clients that are already attached", async () => {
    const { base } = await startRelay();
    const channel = await allocate(base);
    const host = await connectHost(base, channel);
    const { client, stream } = await attachClient(base, channel, host);

    host.close();
    await new Promise((r) => setTimeout(r, 50));

    // Without this replay the surviving client's stream would be orphaned:
    // its frames would arrive for a stream the host has never heard of.
    const revived = await connectHost(base, channel);
    expect((await revived.op("peer_up")).stream).toBe(stream);

    revived.close();
    client.close();
  });

  it("closes a host that sends a frame with no stream header", async () => {
    const { base } = await startRelay();
    const channel = await allocate(base);
    const host = await connectHost(base, channel);

    host.ws.send(Buffer.from([1, 2]), { binary: true });
    expect(await closeCode(host.ws)).toBe(4400);
  });

  it("keeps single-client behaviour for a host that does not opt in", async () => {
    const { base } = await startRelay();
    const channel = await allocate(base);

    const host = Tap.connect(
      `${wsBase(base)}/ws?channel=${channel.channel_id}&role=h&token=${channel.token}`
    );
    await host.open();
    expect(await host.op("host_ready")).toMatchObject({ mux: false });

    const first = Tap.connect(clientUrl(base, channel));
    await first.open();
    await host.op("peer_up");

    const second = new WebSocket(clientUrl(base, channel));
    expect(await closeCode(second)).toBe(4409);

    // Frames are relayed verbatim, with no stream prefix.
    first.ws.send(Buffer.from("raw"), { binary: true });
    expect((await host.binary()).toString()).toBe("raw");

    host.close();
    first.close();
  });

  it("counts attached clients in /stats", async () => {
    const { base, server } = await startRelay();
    const channel = await allocate(base);
    const host = await connectHost(base, channel);
    const { client } = await attachClient(base, channel, host);

    expect(server.stats().clients).toBe(1);
    expect(server.stats().active).toBe(1);

    host.close();
    client.close();
  });
});
