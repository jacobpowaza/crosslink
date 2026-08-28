import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const docs = path.join(root, "docs");
const config = JSON.parse(await readFile(path.join(docs, "docs.json"), "utf8"));
const failures = [];
const navigationPages = [];

function collectPages(value) {
  if (Array.isArray(value)) {
    for (const item of value) typeof item === "string" ? navigationPages.push(item) : collectPages(item);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "pages" || key === "groups" || key === "tabs" || key === "anchors") collectPages(item);
    }
  }
}
collectPages(config.navigation);

async function exists(file) {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

for (const page of navigationPages) {
  if (page.startsWith("http://") || page.startsWith("https://")) continue;
  const candidates = [path.join(docs, `${page}.mdx`), path.join(docs, `${page}.md`)];
  if (!(await exists(candidates[0])) && !(await exists(candidates[1]))) {
    failures.push(`navigation page does not exist: ${page}`);
  }
}

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await walk(full));
    else if (/\.mdx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

const pages = await walk(docs);
const routeSet = new Set(pages.map((file) => path.relative(docs, file).replace(/\.mdx?$/, "").split(path.sep).join("/")));
for (const file of pages) {
  const body = await readFile(file, "utf8");
  const links = [...body.matchAll(/(?:href=["']|\]\()([^#?"')\s]+)(?:[?#][^"')\s]*)?["')]?/g)].map((match) => match[1]);
  for (const link of links) {
    if (!link || /^(?:https?:|mailto:|tel:)/.test(link)) continue;
    if (/\.(?:png|jpe?g|svg|webp|gif|mp4)$/.test(link)) {
      const asset = link.startsWith("/") ? path.join(docs, link) : path.resolve(path.dirname(file), link);
      if (!(await exists(asset))) failures.push(`${path.relative(root, file)}: missing asset ${link}`);
      continue;
    }
    if (path.extname(link) && !/\.mdx?$/.test(link)) continue;
    const route = link.replace(/^\//, "").replace(/\.mdx?$/, "");
    const relativeRoute = link.startsWith("/")
      ? route
      : path.relative(docs, path.resolve(path.dirname(file), route)).split(path.sep).join("/");
    if (!routeSet.has(relativeRoute)) failures.push(`${path.relative(root, file)}: missing page ${link}`);
  }
}

for (const redirect of config.redirects ?? []) {
  const target = String(redirect.destination ?? "").replace(/^\//, "");
  if (!routeSet.has(target)) failures.push(`redirect destination does not exist: ${redirect.destination}`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`docs OK: ${pages.length} pages, ${navigationPages.length} navigation entries`);
