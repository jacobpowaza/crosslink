/**
 * Static assets the Crosslink bootstrap serves from the host process.
 *
 * Two of them cannot come from the application: the browser SDK bundle that
 * runs the bootstrap, and an icon for the installed app. The bundle ships with
 * `@crosslink/sdk-browser`; the icon is generated when the application did not
 * supply one, so an application with no artwork still installs to a home screen
 * with something recognisable on it rather than a blank tile.
 */
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { crosslinkLogoSvg, resolveCrosslinkTheme } from "@crosslink/sdk-browser";

const require = createRequire(import.meta.url);

let cachedBundle: string | null = null;

/**
 * The browser SDK as a single classic script defining `window.CrosslinkSDK`.
 *
 * Serving it from the host is what removes the bundler step from an
 * application's mobile page: the page is HTML the developer wrote, and the
 * framework code it needs arrives with it.
 */
export async function readBrowserBundle(): Promise<string> {
  if (cachedBundle !== null) return cachedBundle;
  const pkgPath = require.resolve("@crosslink/sdk-browser/package.json");
  const bundlePath = path.join(path.dirname(pkgPath), "dist", "crosslink.global.js");
  try {
    cachedBundle = await readFile(bundlePath, "utf8");
  } catch (err) {
    throw new Error(
      `Crosslink could not read its browser bundle at ${bundlePath}. ` +
        `Build @crosslink/sdk-browser (npm run build) so the mobile bootstrap can be served. ` +
        `Underlying error: ${(err as Error).message}`
    );
  }
  return cachedBundle;
}

/* ------------------------------- icons ------------------------------- */

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/**
 * A solid-colour PNG tile at the requested size.
 *
 * Deliberately not a rasterised wordmark: rasterising an SVG needs a rendering
 * dependency, and the framework is supposed to install with none. The tile
 * carries the application's accent so the home-screen icon still belongs to
 * the application; the Crosslink identity is carried by the screens, which is
 * where it can be drawn as vector art.
 */
export function renderIconPng(size: number, color: string): Buffer {
  const brand = resolveCrosslinkTheme({ accentColor: color });
  const hex = brand.accentColor.replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);

  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * stride;
    raw[row] = 0; // no per-row filter
    for (let x = 0; x < size; x += 1) {
      const px = row + 1 + x * 4;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

/** The Crosslink wordmark as a standalone SVG document, tinted for a theme. */
export function renderMarkSvg(accentColor?: string, backgroundColor?: string): string {
  const brand = resolveCrosslinkTheme({ accentColor, backgroundColor });
  return `<?xml version="1.0" encoding="UTF-8"?>\n${crosslinkLogoSvg({
    width: "100%",
    color: brand.logoColor
  })}`;
}
