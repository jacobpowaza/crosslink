#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] ?? "--dry-run";

if (mode !== "--dry-run" && mode !== "--publish") {
  throw new Error("Usage: node scripts/publish-packages.mjs [--dry-run|--publish]");
}

const rootManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const workspaceDirs = [];

for (const pattern of rootManifest.workspaces) {
  if (!pattern.endsWith("/*")) throw new Error(`Unsupported workspace pattern: ${pattern}`);
  const parent = pattern.slice(0, -2);
  const entries = await readdir(path.join(root, parent), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) workspaceDirs.push(path.join(parent, entry.name));
  }
}

const workspaces = [];
for (const directory of workspaceDirs.sort()) {
  try {
    const manifest = JSON.parse(await readFile(path.join(root, directory, "package.json"), "utf8"));
    workspaces.push({ directory, manifest });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const byName = new Map(workspaces.map((workspace) => [workspace.manifest.name, workspace]));
const dependencyFields = ["dependencies", "optionalDependencies", "peerDependencies"];

for (const { directory, manifest } of workspaces) {
  for (const field of dependencyFields) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      const dependency = byName.get(name);
      if (!dependency) continue;
      const expected = `^${dependency.manifest.version}`;
      if (range !== expected) {
        throw new Error(`${directory}: ${field}.${name} must be ${expected}, found ${range}`);
      }
    }
  }
}

const publicPackages = workspaces.filter(({ manifest }) => manifest.private !== true);
const publicNames = new Set(publicPackages.map(({ manifest }) => manifest.name));
const publicVersions = new Set(publicPackages.map(({ manifest }) => manifest.version));
if (publicVersions.size !== 1) {
  throw new Error(`Public packages must share one version, found: ${[...publicVersions].join(", ")}`);
}
for (const { directory, manifest } of publicPackages) {
  if (!manifest.repository || !manifest.homepage || !manifest.bugs) {
    throw new Error(`${directory}: repository, homepage, and bugs metadata are required`);
  }
  if (manifest.publishConfig?.access !== "public") {
    throw new Error(`${directory}: publishConfig.access must be public`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(`${directory}: public packages must declare an explicit files allowlist`);
  }
}
const remaining = new Map(publicPackages.map((workspace) => [workspace.manifest.name, workspace]));
const ordered = [];

while (remaining.size > 0) {
  const ready = [...remaining.values()]
    .filter(({ manifest }) =>
      dependencyFields.every((field) =>
        Object.keys(manifest[field] ?? {}).every((name) => !publicNames.has(name) || !remaining.has(name))
      )
    )
    .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));

  if (ready.length === 0) {
    throw new Error(`Circular public package dependencies: ${[...remaining.keys()].join(", ")}`);
  }
  for (const workspace of ready) {
    ordered.push(workspace);
    remaining.delete(workspace.manifest.name);
  }
}

console.log(`Package order (${ordered.length}):`);
ordered.forEach(({ manifest }, index) => console.log(`${index + 1}. ${manifest.name}@${manifest.version}`));

function exportTargets(value, targets = []) {
  if (typeof value === "string" && value.startsWith("./")) targets.push(value.slice(2));
  else if (value && typeof value === "object") {
    for (const nested of Object.values(value)) exportTargets(nested, targets);
  }
  return targets;
}

function dryRun({ directory, manifest }) {
  const result = spawnSync("npm", ["publish", "--dry-run", "--json"], {
    cwd: path.join(root, directory),
    encoding: "utf8"
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  let report;
  try {
    const parsed = JSON.parse(result.stdout);
    report = parsed[manifest.name] ?? parsed;
  } catch {
    process.stderr.write(result.stdout);
    throw new Error(`${manifest.name}: npm did not return a JSON dry-run report`);
  }

  const packedFiles = new Set(report.files.map(({ path: packedPath }) => packedPath));
  const required = new Set(["package.json", ...exportTargets(manifest.exports)]);
  if (manifest.bin) {
    for (const target of Object.values(manifest.bin)) required.add(target.replace(/^\.\//, ""));
  }
  if (manifest.main) required.add(manifest.main.replace(/^\.\//, ""));
  if (manifest.types) required.add(manifest.types.replace(/^\.\//, ""));
  const missing = [...required].filter((requiredPath) => !packedFiles.has(requiredPath));
  if (missing.length > 0) throw new Error(`${manifest.name}: tarball is missing ${missing.join(", ")}`);
  if (![...packedFiles].some((packedPath) => /^readme(?:\.[^/]+)?$/i.test(packedPath))) {
    throw new Error(`${manifest.name}: tarball is missing a package README`);
  }
  if (![...packedFiles].some((packedPath) => /^(?:license|licence)(?:\.[^/]+)?$/i.test(packedPath))) {
    throw new Error(`${manifest.name}: tarball is missing its license text`);
  }

  const alwaysAllowed = /^(?:package\.json|readme(?:\.[^/]+)?|(?:license|licence)(?:\.[^/]+)?)$/i;
  const allowedRoots = manifest.files.map((entry) => entry.replace(/^\.\//, "").replace(/\/$/, ""));
  const unexpected = [...packedFiles].filter(
    (packedPath) =>
      !alwaysAllowed.test(packedPath) &&
      !allowedRoots.some((allowedRoot) => packedPath === allowedRoot || packedPath.startsWith(`${allowedRoot}/`))
  );
  if (unexpected.length > 0) {
    throw new Error(`${manifest.name}: tarball contains files outside its allowlist: ${unexpected.join(", ")}`);
  }

  const sensitive = report.files.filter(({ path: packedPath }) =>
    /(^|\/)(\.env(?:\.|$)|[^/]+\.(?:pem|key|p12|pfx))$/i.test(packedPath)
  );
  if (sensitive.length > 0) {
    throw new Error(`${manifest.name}: tarball contains sensitive-looking files: ${sensitive.map((file) => file.path).join(", ")}`);
  }

  console.log(`✓ ${manifest.name}: ${report.entryCount} files, ${report.size} bytes packed`);
}

for (const workspace of ordered) dryRun(workspace);

if (mode === "--publish") {
  for (const { directory, manifest } of ordered) {
    console.log(`Publishing ${manifest.name}@${manifest.version}...`);
    const result = spawnSync("npm", ["publish", "--access", "public"], {
      cwd: path.join(root, directory),
      stdio: "inherit"
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
} else {
  console.log("Dry-run complete; nothing was published.");
}
