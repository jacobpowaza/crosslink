/**
 * Decodes a QR code rendered by `qrcode`'s SVG renderer back to its text.
 *
 * The point is to test what a phone camera sees rather than what the host
 * meant to encode. Re-encoding the expected string and comparing SVG strings
 * would pass even if the payload handed to the encoder were `CL-P001`, because
 * both sides would be wrong in the same way; decoding the drawn modules cannot.
 *
 * There is deliberately no new dependency here. `qrcode` — already a
 * dependency of the host SDK — ships the tables a decoder needs (block layout
 * per version and EC level, mask functions, codeword totals), so this reuses
 * them and adds only the reading: modules out of the SVG path, format info,
 * unmask, zigzag codeword scan, de-interleave, and byte-mode parse. Error
 * correction is not applied: the input is a matrix this repository generated,
 * so a damaged read is a bug to surface, not noise to repair.
 */
import { createRequire } from "node:module";

/** The EC level object `qrcode`'s tables are keyed by. */
interface QrEcLevel {
  bit: number;
}

// `qrcode` ships no types for its internals, so they are required and given
// the narrow shapes this file uses rather than imported as `any`.
const load = createRequire(import.meta.url);
const ECLevel = load("qrcode/lib/core/error-correction-level.js") as Record<
  "L" | "M" | "Q" | "H",
  QrEcLevel
>;
const ECCode = load("qrcode/lib/core/error-correction-code.js") as {
  getBlocksCount(version: number, level: QrEcLevel): number;
  getTotalCodewordsCount(version: number, level: QrEcLevel): number;
};
const Utils = load("qrcode/lib/core/utils.js") as {
  getSymbolTotalCodewords(version: number): number;
};

/** Parses `qrcode`'s SVG output into a square matrix of 1 (dark) / 0 (light). */
export function qrSvgToMatrix(svg: string): number[][] {
  const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  if (!viewBox) throw new Error("not a qrcode SVG: no viewBox");
  const size = Number(viewBox[1]);
  const grid: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));

  // The renderer emits one path of horizontal runs: `M<x> <y>.5h<len>`, where
  // the half-pixel y is the centre of the module row and the stroke is one
  // module wide.
  const dark = /<path stroke="[^"]*" d="([^"]*)"/.exec(svg);
  if (!dark) throw new Error("not a qrcode SVG: no module path");
  let x = 0;
  let y = 0;
  const tokens = dark[1].match(/[MmHh][-\d. ]+/g) ?? [];
  for (const token of tokens) {
    const command = token[0];
    const numbers = token
      .slice(1)
      .trim()
      .split(/[ ,]+/)
      .map(Number);
    if (command === "M") {
      x = numbers[0];
      y = Math.floor(numbers[1]);
    } else if (command === "m") {
      x += numbers[0];
      y += Math.round(numbers[1]);
    } else if (command === "h" || command === "H") {
      const length = command === "h" ? numbers[0] : numbers[0] - x;
      for (let i = 0; i < length; i += 1) grid[y][x + i] = 1;
      x += length;
    }
  }

  // The SVG carries a quiet zone. Its width is the first drawn module's
  // column: the top-left finder starts flush against the symbol's edge.
  const margin = firstColumn(dark[1]);
  const count = size - margin * 2;
  if (count < 21 || (count - 17) % 4 !== 0) {
    throw new Error(`SVG does not contain a QR symbol (derived size ${count})`);
  }
  const matrix: number[][] = [];
  for (let row = 0; row < count; row += 1) {
    matrix.push(grid[row + margin].slice(margin, margin + count));
  }
  return matrix;
}

/** Column the first module is drawn in, which is the quiet-zone width. */
function firstColumn(path: string): number {
  const first = /^M(-?[\d.]+)/.exec(path.trim());
  if (!first) throw new Error("not a qrcode SVG: module path has no origin");
  return Number(first[1]);
}

const FORMAT_INFO_BITS = [
  0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0, 0x77c4, 0x72f3, 0x7daa, 0x789d,
  0x662f, 0x6318, 0x6c41, 0x6976, 0x1689, 0x13be, 0x1ce7, 0x19d0, 0x0762, 0x0255, 0x0d0c, 0x083b,
  0x355f, 0x3068, 0x3f31, 0x3a06, 0x24b4, 0x2183, 0x2eda, 0x2bed
];

/** EC level bits as they appear in format information, in table order. */
const FORMAT_EC_LEVELS = [ECLevel.M, ECLevel.L, ECLevel.H, ECLevel.Q];

function readFormatInfo(matrix: number[][]): { ecLevel: QrEcLevel; mask: number } {
  const size = matrix.length;
  let bits = 0;
  // Copy 1, read anticlockwise around the top-left finder.
  for (let i = 0; i <= 5; i += 1) bits = (bits << 1) | matrix[8][i];
  bits = (bits << 1) | matrix[8][7];
  bits = (bits << 1) | matrix[8][8];
  bits = (bits << 1) | matrix[7][8];
  for (let i = 5; i >= 0; i -= 1) bits = (bits << 1) | matrix[i][8];

  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < FORMAT_INFO_BITS.length; index += 1) {
    const distance = hammingDistance(bits, FORMAT_INFO_BITS[index]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  if (bestDistance > 3) throw new Error("format information is unreadable");
  return { ecLevel: FORMAT_EC_LEVELS[best >> 3], mask: best & 0b111 };
}

function hammingDistance(a: number, b: number): number {
  let value = a ^ b;
  let count = 0;
  while (value !== 0) {
    count += value & 1;
    value >>>= 1;
  }
  return count;
}

/** Every position occupied by function patterns, which carry no data. */
function functionModuleMap(version: number, size: number): boolean[][] {
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (row: number, col: number): void => {
    if (row >= 0 && row < size && col >= 0 && col < size) reserved[row][col] = true;
  };

  for (const [baseRow, baseCol] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0]
  ]) {
    for (let r = -1; r <= 7; r += 1) for (let c = -1; c <= 7; c += 1) mark(baseRow + r, baseCol + c);
  }
  for (let i = 0; i < size; i += 1) {
    mark(6, i);
    mark(i, 6);
  }
  // Alignment patterns sit at every pairing of the version's centre
  // coordinates except the three that would land on a finder. A centre on the
  // timing row or column is a real pattern (v7's (6,22), for instance), so the
  // exclusion has to name the corners rather than test for reserved modules.
  const centres = alignmentCoordinates(version);
  const first = centres[0];
  const last = centres[centres.length - 1];
  for (const row of centres) {
    for (const col of centres) {
      const onFinder =
        (row === first && col === first) ||
        (row === first && col === last) ||
        (row === last && col === first);
      if (onFinder) continue;
      for (let r = -2; r <= 2; r += 1) for (let c = -2; c <= 2; c += 1) mark(row + r, col + c);
    }
  }
  // Format information: one copy around the top-left finder (row 8 and
  // column 8, nine modules each), and one split between row 8 on the right and
  // column 8 at the bottom — eight modules each, plus the always-dark module
  // at (size-8, 8), which the bottom run already covers.
  for (let i = 0; i <= 8; i += 1) {
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i <= 7; i += 1) {
    mark(8, size - 1 - i);
    mark(size - 1 - i, 8);
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        mark(size - 11 + j, i);
        mark(i, size - 11 + j);
      }
    }
  }
  return reserved;
}

/** Alignment-pattern centres for a version, per the standard's formula. */
function alignmentCoordinates(version: number): number[] {
  if (version === 1) return [];
  const intervals = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const total = size - 13;
  const step = intervals === 2 ? total : Math.ceil(total / (2 * (intervals - 1))) * 2;
  const coordinates = [6];
  for (let i = intervals - 1; i >= 1; i -= 1) coordinates.push(size - 7 - (intervals - 1 - i) * step);
  return coordinates.sort((a, b) => a - b);
}

/**
 * The eight mask formulas. `qrcode` keeps its copy module-private, so this is
 * the one piece of the standard the decoder restates rather than reuses.
 */
function maskAt(pattern: number, i: number, j: number): boolean {
  switch (pattern) {
    case 0: return (i + j) % 2 === 0;
    case 1: return i % 2 === 0;
    case 2: return j % 3 === 0;
    case 3: return (i + j) % 3 === 0;
    case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5: return ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6: return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    case 7: return (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
    default: throw new Error(`bad mask pattern ${pattern}`);
  }
}

/** Reads the interleaved codeword stream in the standard zigzag order. */
function readCodewords(matrix: number[][], mask: number, reserved: boolean[][]): number[] {
  const size = matrix.length;
  const codewords: number[] = [];
  let current = 0;
  let bits = 0;
  let upwards = true;

  let col = size - 1;
  while (col > 0) {
    // Column 6 is the vertical timing pattern; the pairs step over it.
    if (col === 6) col -= 1;
    for (let step = 0; step < size; step += 1) {
      const row = upwards ? size - 1 - step : step;
      for (const c of [col, col - 1]) {
        if (reserved[row][c]) continue;
        const bit = matrix[row][c] ^ (maskAt(mask, row, c) ? 1 : 0);
        current = (current << 1) | bit;
        bits += 1;
        if (bits === 8) {
          codewords.push(current);
          current = 0;
          bits = 0;
        }
      }
    }
    upwards = !upwards;
    col -= 2;
  }
  return codewords;
}

/** Undoes block interleaving, returning the data codewords in message order. */
function deinterleave(codewords: number[], version: number, ecLevel: QrEcLevel): number[] {
  const totalCodewords = Utils.getSymbolTotalCodewords(version);
  const ecTotal = ECCode.getTotalCodewordsCount(version, ecLevel);
  const dataTotal = totalCodewords - ecTotal;
  const blocks = ECCode.getBlocksCount(version, ecLevel);
  const shortBlockSize = Math.floor(dataTotal / blocks);
  const longBlocks = dataTotal % blocks;

  const sizes = Array.from({ length: blocks }, (_, index) =>
    index < blocks - longBlocks ? shortBlockSize : shortBlockSize + 1
  );
  const data: number[][] = sizes.map(() => []);
  let cursor = 0;
  for (let column = 0; column < Math.max(...sizes); column += 1) {
    for (let block = 0; block < blocks; block += 1) {
      if (column >= sizes[block]) continue;
      data[block].push(codewords[cursor]);
      cursor += 1;
    }
  }
  return data.flat();
}

/** Alphanumeric mode's 45-character alphabet, in code order. */
const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

/** Character-count bit widths per mode, by version band. */
function countBits(mode: number, version: number): number {
  const band = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  if (mode === 1) return [10, 12, 14][band];
  if (mode === 2) return [9, 11, 13][band];
  if (mode === 4) return [8, 16, 16][band];
  throw new Error(`unsupported QR mode ${mode}`);
}

/**
 * Reads the message out of the data codewords.
 *
 * `qrcode` splits a string into whichever segment modes encode it most
 * compactly, so a URL routinely arrives as byte + alphanumeric + numeric
 * segments rather than one byte segment. Decoding all three is what makes the
 * round trip an actual decode rather than a check of the encoder's own view.
 */
function parseMessage(data: number[], version: number): string {
  const bits: number[] = [];
  for (const byte of data) for (let i = 7; i >= 0; i -= 1) bits.push((byte >> i) & 1);

  let cursor = 0;
  const take = (count: number): number => {
    let value = 0;
    for (let i = 0; i < count; i += 1) value = (value << 1) | (bits[cursor + i] ?? 0);
    cursor += count;
    return value;
  };

  let out = "";
  let segments = 0;
  while (cursor + 4 <= bits.length) {
    const mode = take(4);
    // Mode 0 is the terminator; anything else unrecognised means the remaining
    // bits are padding, which is not part of the message.
    if (mode !== 1 && mode !== 2 && mode !== 4) {
      if (segments === 0) throw new Error(`unsupported QR mode ${mode}`);
      break;
    }
    const length = take(countBits(mode, version));
    if (mode === 4) {
      const bytes: number[] = [];
      for (let i = 0; i < length; i += 1) bytes.push(take(8));
      out += new TextDecoder().decode(Uint8Array.from(bytes));
    } else if (mode === 2) {
      let remaining = length;
      while (remaining >= 2) {
        const pair = take(11);
        out += ALPHANUMERIC[Math.floor(pair / 45)] + ALPHANUMERIC[pair % 45];
        remaining -= 2;
      }
      if (remaining === 1) out += ALPHANUMERIC[take(6)];
    } else {
      let remaining = length;
      while (remaining >= 3) {
        out += String(take(10)).padStart(3, "0");
        remaining -= 3;
      }
      if (remaining === 2) out += String(take(7)).padStart(2, "0");
      else if (remaining === 1) out += String(take(4));
    }
    segments += 1;
  }
  return out;
}

/** Decodes an SVG QR produced by `qrcode` back to the string it encodes. */
export function decodeQrSvg(svg: string): string {
  const matrix = qrSvgToMatrix(svg);
  const size = matrix.length;
  const version = (size - 17) / 4;
  const { ecLevel, mask } = readFormatInfo(matrix);
  const reserved = functionModuleMap(version, size);
  const codewords = readCodewords(matrix, mask, reserved);
  const data = deinterleave(codewords, version, ecLevel);
  return parseMessage(data, version);
}
