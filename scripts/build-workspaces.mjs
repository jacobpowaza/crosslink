import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";

const root = process.cwd();
const rootPkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

const packageDirs = rootPkg.workspaces.flatMap((pattern) =>
  globSync(pattern, { cwd: root }).map((dir) => path.join(root, dir))
);

const packages = new Map();
for (const dir of packageDirs) {
  const pkgPath = path.join(dir, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  } catch {
    continue;
  }
  packages.set(pkg.name, {
    name: pkg.name,
    dir,
    deps: Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((dep) => packages.has(dep) || dep.startsWith("@crosslink/")),
  });
}

// Topological sort by internal @crosslink/* dependencies.
const ordered = [];
const visited = new Set();
const visiting = new Set();

function visit(name) {
  const pkg = packages.get(name);
  if (!pkg || visited.has(name)) return;
  if (visiting.has(name)) {
    throw new Error(`Circular workspace dependency detected involving ${name}`);
  }
  visiting.add(name);
  for (const dep of pkg.deps) {
    if (packages.has(dep)) visit(dep);
  }
  visiting.delete(name);
  visited.add(name);
  ordered.push(pkg);
}

for (const name of packages.keys()) visit(name);

for (const pkg of ordered) {
  const result = spawnSync("npm", ["run", "build", "--if-present", "-w", pkg.name], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
