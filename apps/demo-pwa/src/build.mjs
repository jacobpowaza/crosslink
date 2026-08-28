#!/usr/bin/env node
/**
 * Generates this demo's publishable Crosslink bootstrap.
 *
 * The output is the durable origin an installed Crosslink app should own: a
 * static site with the service worker, the manifest, the icons, the browser SDK
 * and Crosslink's onboarding screens already in it. Publish `dist/` to any free
 * static host and point a host's `pairing.bootstrapUrl` at the result.
 *
 * The point of the demo is what is *not* here. There is no service worker in
 * this repository, no manifest, no icon pipeline and no bundler config —
 * Crosslink emits all of it from the application metadata below, which is the
 * same metadata the host declares.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeStaticBootstrap } from "@crosslink/sdk-node";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "..", "dist");

const result = await writeStaticBootstrap({
  outDir,
  entry: path.resolve(here, "..", "mobile", "index.html"),
  assets: [path.resolve(here, "..", "mobile", "style.css")],
  application: {
    id: "com.example.notes",
    name: "Crosslink Notes",
    shortName: "Notes",
    accentColor: "#38bdf8",
    backgroundColor: "#0b1120",
    appearance: "dark",
    capabilities: ["notes.read", "notes.write"]
  }
});

console.log(`Crosslink bootstrap written to ${result.outDir}`);
for (const file of result.files) console.log(`  ${file}`);
console.log(
  "\nPublish this directory to any free static host (GitHub Pages, Codeberg Pages, …)\n" +
    "and set pairing.bootstrapUrl on your host to the published URL."
);
