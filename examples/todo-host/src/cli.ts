#!/usr/bin/env node
/**
 * Todo Host — capability tiers, consent prompts and notifications.
 *
 * Nothing to configure:
 *   node examples/todo-host/src/cli.ts
 *   # scan the QR from a phone on the same Wi-Fi
 *
 * Reachable from another network (asks the router for an inbound port):
 *   node examples/todo-host/src/cli.ts --remote
 *
 * A signaling/relay pair is optional, for phones that cannot reach this
 * machine directly:
 *   npm run stack
 *   CROSSLINK_SIGNALING_URL=http://127.0.0.1:8081 \
 *   CROSSLINK_RELAY_URL=http://127.0.0.1:8082 \
 *   node examples/todo-host/src/cli.ts
 */
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCrosslinkServer, NotificationService } from "@crosslink/sdk-node";
import QRCode from "qrcode";
import { randomUUID } from "node:crypto";

const args = new Set(process.argv.slice(2));

// Optional, and unset by default. A phone pairs and connects over the address
// in the QR with no service in the middle; a signaling/relay pair only adds a
// route for phones that cannot reach this machine directly.
const signalingUrl = process.env.CROSSLINK_SIGNALING_URL;
const relayUrl = process.env.CROSSLINK_RELAY_URL;

// `--remote` asks the router for an inbound port (UPnP / NAT-PMP / PCP) so a
// phone on another network can dial this host directly. If the router refuses,
// the host says so rather than pretending; it never advertises a private
// address as if it were a public one.
const networkMode = args.has("--remote") ? "remote" : "auto";

/* ------------------------------------------------------------------ */
/* data model                                                          */
/* ------------------------------------------------------------------ */

interface Todo {
  id: string;
  title: string;
  done: boolean;
  createdAt: number;
  completedAt?: number;
}

const todos = new Map<string, Todo>([
  ["welcome", { id: "welcome", title: "Welcome to Crosslink Todo!", done: false, createdAt: Date.now() }]
]);

/* ------------------------------------------------------------------ */
/* server setup                                                        */
/* ------------------------------------------------------------------ */

const server = createCrosslinkServer({
  application: {
    id: "com.example.todo",
    name: "Todo List",
    version: "1.0.0",
    shortName: "Todo",
    accentColor: "#6366f1",
    backgroundColor: "#0f0f14",
    appearance: "dark"
  },
  // The developer's mobile page, and nothing else. Crosslink serves it along
  // with the manifest, the service worker, the icons, the browser SDK and its
  // own pairing, install, offline and revoked screens.
  mobile: {
    entry: path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "mobile",
      "index.html"
    )
  },
  capabilities: [
    { id: "todos.read", title: "View your todos", risk: "low", defaultGranted: true },
    { id: "todos.write", title: "Create and edit todos", risk: "medium" },
    {
      id: "todos.delete",
      title: "Delete todos",
      description: "Permanently removes a todo",
      risk: "high",
      // A grant here is a licence to ask, not a standing permission: every
      // delete stops at a prompt on this terminal.
      confirmEachUse: true,
    },
  ],
  // Applied before the user is ever asked. A client may request anything;
  // only what survives this can be offered, and the prompt can narrow it
  // further but never widen it.
  permissions: {
    allow: ["todos.read", "todos.write", "todos.delete"],
    maxAutoGrantRisk: "low",
    requireApproval: "high",
    maxDevices: 10,
  },
  networkMode,
  signalingUrl,
  relayUrl,
  lan: { enabled: true, bind: "all" },
  pairing: {
    autoApprove: args.has("--yes"),
    approve: async (req) => {
      console.log(`\n  Pairing request from "${req.deviceName}" — SAS ${req.sas}`);
      console.log(`  Caps on offer: ${req.requestedCaps.join(", ") || "(none)"}`);
      if (req.requiresExplicitApproval.length > 0) {
        console.log(`  Needs your explicit yes: ${req.requiresExplicitApproval.join(", ")}`);
      }
      if (req.deniedCaps.length > 0) {
        console.log(
          `  Refused by policy: ${req.deniedCaps.map((d) => `${d.id} (${d.reason})`).join(", ")}`
        );
      }
      const answer = await prompt("  Approve? [y]es / [r]ead-only / [N]o: ");
      // Returning an array grants only that subset.
      if (answer === "r") return ["todos.read"];
      return answer === "y" || answer === "yes";
    },
  },
  // Asked before every invocation of a confirmEachUse capability.
  onConsentRequest: async (req) => {
    console.log(`\n  "${req.title}" requested by ${req.deviceId.slice(0, 20)}…`);
    console.log(`  ${JSON.stringify(req.input)}`);
    const answer = await prompt("  Allow? [o]nce / [s]ession / [a]lways / [N]o: ");
    if (answer === "o") return "once";
    if (answer === "s") return "session";
    if (answer === "a") return "always";
    return false;
  },
});

/** Reads one line from stdin, cooperating with the command loop below. */
const pendingPrompts: Array<(answer: string) => void> = [];
function prompt(text: string): Promise<string> {
  process.stdout.write(text);
  return new Promise((resolve) => pendingPrompts.push(resolve));
}

/* ------------------------------------------------------------------ */
/* notification service                                                 */
/* ------------------------------------------------------------------ */

const notifications = new NotificationService(server, {
  channels: [
    { id: "todos", title: "Todo Updates" },
    { id: "alerts", title: "Alerts" },
  ],
});

const notify = (title: string, body: string) => {
  notifications.send("todos", title, body);
};

/* ------------------------------------------------------------------ */
/* RPC methods                                                          */
/* ------------------------------------------------------------------ */

server
  .expose("todos.list", () => [...todos.values()].sort((a, b) => b.createdAt - a.createdAt), {
    capability: "todos.read",
  })
  .expose("todos.get", (input) => {
    const todo = todos.get(String((input as { id?: string })?.id ?? ""));
    if (!todo) throw Object.assign(new Error("todo not found"), { code: "NOT_FOUND" });
    return todo;
  }, { capability: "todos.read" })
  .expose(
    "todos.create",
    (input) => {
      const { title = "Untitled" } = (input ?? {}) as { title?: string };
      const todo: Todo = {
        id: randomUUID().slice(0, 8),
        title: String(title).slice(0, 200),
        done: false,
        createdAt: Date.now(),
      };
      todos.set(todo.id, todo);
      notify("New Todo", `"${todo.title}" was added`);
      return todo;
    },
    {
      capability: "todos.write",
      inputSchema: {
        type: "object",
        required: ["title"],
        properties: { title: { type: "string", minLen: 1, maxLen: 200 } },
      },
    }
  )
  .expose("todos.complete", (input) => {
    const id = String((input as { id?: string })?.id ?? "");
    const todo = todos.get(id);
    if (!todo) throw Object.assign(new Error("todo not found"), { code: "NOT_FOUND" });
    todo.done = true;
    todo.completedAt = Date.now();
    notify("Todo Completed", `"${todo.title}" is done!`);
    return todo;
  }, { capability: "todos.write" })
  .expose("todos.uncomplete", (input) => {
    const id = String((input as { id?: string })?.id ?? "");
    const todo = todos.get(id);
    if (!todo) throw Object.assign(new Error("todo not found"), { code: "NOT_FOUND" });
    todo.done = false;
    todo.completedAt = undefined;
    return todo;
  }, { capability: "todos.write" })
  .expose("todos.delete", (input) => {
    const id = String((input as { id?: string })?.id ?? "");
    const todo = todos.get(id);
    const title = todo?.title ?? id;
    const ok = todos.delete(id);
    if (ok) notify("Todo Deleted", `"${title}" was removed`);
    return { deleted: ok };
  }, { capability: "todos.delete" })
  .expose("app.info", () => ({
    name: "Todo List",
    appId: "com.example.todo",
    version: "1.0.0",
    mode: networkMode,
    todoCount: todos.size,
    doneCount: [...todos.values()].filter((t) => t.done).length,
  }))
  .declareEvent("todos.changed");

/* ------------------------------------------------------------------ */
/* start                                                                */
/* ------------------------------------------------------------------ */

await server.start();

console.log(`Todo Host ready — ${networkMode}.`);
console.log(`  fingerprint ${server.fingerprintHex.slice(0, 32)}...`);
for (const endpoint of server.connectionEndpoints()) {
  console.log(`  ${endpoint.kind.padEnd(11)} ${endpoint.url}`);
}
const remote = server.getRemoteDiagnostics();
if (remote && !remote.reachable) console.log(`  remote      ${remote.message}`);
console.log("  commands    code | devices | revoke <id> | consent | quit\n");

async function printPairingCode(): Promise<void> {
  const info = await server.getPairingCode();
  console.log(`\n  Pairing code: ${info.code}   (expires in 2 minutes)`);
  if (info.qrSvg && process.stdout.isTTY) {
    const qr = await QRCode.toString(info.uri!, { type: "terminal", small: true });
    console.log(qr);
  } else if (info.uri) {
    console.log(`  or open this URI on the client:\n  ${info.uri}`);
  }
  console.log();
}

await printPairingCode();
setInterval(async () => {
  try {
    await printPairingCode();
  } catch {
    /* host shutting down */
  }
}, 110_000).unref();

/* ------------------------------------------------------------------ */
/* CLI commands                                                          */
/* ------------------------------------------------------------------ */

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", async (line) => {
  const waiting = pendingPrompts.shift();
  if (waiting) {
    waiting(line.trim().toLowerCase());
    return;
  }
  const [cmd, ...rest] = line.trim().split(/\s+/);
  try {
    if (cmd === "code") {
      await printPairingCode();
    } else if (cmd === "devices") {
      for (const d of server.listDevices()) {
        console.log(
          `  ${d.revokedAt ? "!" : "*"} ${d.name}  ${d.deviceId.slice(0, 20)}...  caps=[${server
            .grantedCapabilities(d.deviceId)
            .join(",")}]`
        );
      }
    } else if (cmd === "revoke" && rest[0]) {
      console.log(server.revokeDevice(rest[0]) ? "  revoked" : "  not found");
    } else if (cmd === "consent") {
      server.clearConsent();
      console.log("  cleared remembered consent; every use will prompt again");
    } else if (cmd === "quit") {
      await server.stop();
      process.exit(0);
    } else if (cmd) {
      console.log("  commands: code | devices | revoke <id> | consent | quit");
    }
  } catch (err) {
    console.error("  error:", (err as Error).message);
  }
});

process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await server.stop();
  process.exit(0);
});
