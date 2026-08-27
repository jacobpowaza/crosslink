#!/usr/bin/env node
/**
 * Notes Host - a small but complete Crosslink app demonstrating:
 *   - capability tiers (read / write / high-risk delete)
 *   - streaming (notes.export)
 *   - events (notes.changed fan-out)
 *   - device administration from the terminal (code/devices/cap/revoke)
 */
import { createInterface } from "node:readline";
import { createCrosslinkServer, type DeviceSummary } from "@crosslink/sdk-node";
import QRCode from "qrcode";
import { randomUUID } from "node:crypto";

const signalingUrl = process.env.CROSSLINK_SIGNALING_URL;
const relayUrl = process.env.CROSSLINK_RELAY_URL;

interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: number;
}
const notes = new Map<string, Note>([
  ["seed-1", { id: "seed-1", title: "Welcome", body: "Paired via Crosslink!", createdAt: Date.now() }]
]);

const server = createCrosslinkServer({
  application: { id: "com.example.notes", name: "Notes", version: "1.0.0" },
  capabilities: [
    { id: "notes.read", title: "Read your notes", description: "List and fetch notes", risk: "low" },
    { id: "notes.write", title: "Create and edit notes", risk: "medium" },
    { id: "notes.delete", title: "Delete notes permanently", risk: "high" }
  ],
  signalingUrl,
  relayUrl,
  lan: { enabled: true, bind: "loopback" },
  pairing: {
    autoApprove: process.argv.includes("--yes"),
    approve: async (req) => {
      console.log(`\nPairing request from "${req.deviceName}" — SAS ${req.sas}`);
      console.log(`  caps: ${req.requestedCaps.join(", ") || "(none)"}`);
      return req.requestedCaps.every((c) => c !== "notes.delete");
    }
  }
});

const touch = () => server.emit("notes.changed", { at: Date.now() });

server
  .expose("notes.list", () => [...notes.values()].sort((a, b) => b.createdAt - a.createdAt), {
    capability: "notes.read"
  })
  .expose("notes.get", (input) => {
    const note = notes.get(String((input as { id?: string })?.id ?? ""));
    if (!note) throw Object.assign(new Error("note not found"), { code: "NOT_FOUND" });
    return note;
  }, { capability: "notes.read" })
  .expose(
    "notes.create",
    (input) => {
      const { title = "Untitled", body = "" } = (input ?? {}) as { title?: string; body?: string };
      const note: Note = { id: randomUUID().slice(0, 8), title: String(title).slice(0, 200), body: String(body).slice(0, 10_000), createdAt: Date.now() };
      notes.set(note.id, note);
      touch();
      return note;
    },
    {
      capability: "notes.write",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string", maxLen: 200 }, body: { type: "string", maxLen: 10_000 } }
      }
    }
  )
  .expose("notes.export", (_input, ctx) => {
    // Streaming RPC: progress chunks per note, then a final summary.
    let i = 0;
    for (const note of notes.values()) {
      ctx.emitProgress({ id: note.id, title: note.title, createdAt: note.createdAt });
      i += 1;
    }
    return { exported: i };
  }, { capability: "notes.read" })
  .expose("notes.delete", (input) => {
    const id = String((input as { id?: string })?.id ?? "");
    const ok = notes.delete(id);
    if (ok) touch();
    return { deleted: ok };
  }, { capability: "notes.delete" })
  .declareEvent("notes.changed");

await server.start();

console.log("Notes host ready:", JSON.stringify(server.status().transports));
console.log("Commands: code | devices | cap <deviceId> <caps|-> | revoke <deviceId> | quit\n");

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", async (line) => {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  try {
    if (cmd === "code") {
      const info = await server.getPairingCode();
      console.log(`Pairing code: ${info.code}`);
      if (info.uri) console.log(await QRCode.toString(info.uri, { type: "terminal", small: true }));
    } else if (cmd === "devices") {
      for (const d of server.listDevices() as DeviceSummary[]) {
        console.log(
          `  ${d.revokedAt ? "✗" : "✓"} ${d.name}  ${d.deviceId.slice(0, 20)}…  caps=[${d.caps.join(",")}]`
        );
      }
    } else if (cmd === "cap" && rest[0]) {
      const caps = rest[1] === "-" ? [] : rest.slice(1);
      server.setDeviceCaps(rest[0], caps);
      console.log("updated");
    } else if (cmd === "revoke" && rest[0]) {
      console.log(server.revokeDevice(rest[0]) ? "revoked" : "not found");
    } else if (cmd === "quit") {
      await server.stop();
      process.exit(0);
    } else if (cmd) {
      console.log("commands: code | devices | cap <id> <caps|-> | revoke <id> | quit");
    }
  } catch (err) {
    console.error("error:", (err as Error).message);
  }
});

process.on("SIGINT", async () => {
  await server.stop();
  process.exit(0);
});
