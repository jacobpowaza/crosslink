import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const failures = [];
const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n");
const forbidden = tracked.filter((file) =>
  /(^|\/)(\.env(?:\..+)?|\.crosslink-data)(\/|$)|\.(?:pem|p12|key)$/i.test(file)
);
if (forbidden.length) failures.push(`tracked secret material: ${forbidden.join(", ")}`);

const electron = await readFile("examples/electron-chat/src/main.ts", "utf8");
for (const required of [
  "contextIsolation: true",
  "nodeIntegration: false",
  "sandbox: true",
  "webSecurity: true",
  "setPermissionRequestHandler",
  "Content-Security-Policy",
  "untrusted IPC sender",
  "autoApprove: false"
]) {
  if (!electron.includes(required)) failures.push(`Electron baseline missing: ${required}`);
}

for (const service of ["services/signaling/src/cli.ts", "services/relay/src/cli.ts"]) {
  const source = await readFile(service, "utf8");
  if (!source.includes("auth REQUIRED")) failures.push(`${service}: public service auth is not fail-closed`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("security baseline OK: secrets, Electron isolation, and public service auth");
