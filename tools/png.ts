/**
 * A PNG reader, because CDP hands back a PNG and we need the pixels.
 *
 * Shared by `contrast.ts`, which wants the colour of a glyph, and by
 * `screenshots.ts --state-diff`, which wants to know whether two renders of the
 * same button differ at all (DUB-50). Both ask the same question of Chrome —
 * `Page.captureScreenshot` with a `clip` — and neither wants its own decoder.
 *
 * No dependency: `node:zlib` is the only thing a PNG's IDAT needs, and the rest
 * is unfiltering scanlines.
 */

import { inflateSync } from 'node:zlib';

export interface Bitmap {
  readonly width: number;
  readonly height: number;
  /** RGB triplets, row-major, alpha dropped — a screenshot is already flat. */
  readonly rgb: Uint8Array;
}

/** Decode a non-interlaced 8-bit RGB/RGBA PNG. That is all Chrome emits here. */
export function decodePng(png: Buffer): Bitmap {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');

  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];

  for (let at = 8; at + 8 <= png.length;) {
    const length = png.readUInt32BE(at);
    const type = png.toString('ascii', at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    at += 12 + length; // length + type + data + CRC

    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colourType = body[9];
      const interlace = body[12];
      if (depth !== 8 || interlace !== 0 || (colourType !== 2 && colourType !== 6)) {
        throw new Error(
          `unsupported PNG: depth ${depth}, colour type ${colourType}, interlace ${interlace}`,
        );
      }
      channels = colourType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 3);
  // One scanline of reconstructed bytes, kept for the Up/Average/Paeth filters.
  let previous = new Uint8Array(stride);
  let current = new Uint8Array(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));

    for (let i = 0; i < stride; i += 1) {
      const x = line[i]!;
      const a = i >= channels ? current[i - channels]! : 0;
      const b = previous[i]!;
      const c = i >= channels ? previous[i - channels]! : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = x;
          break;
        case 1:
          value = x + a;
          break;
        case 2:
          value = x + b;
          break;
        case 3:
          value = x + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`unknown PNG filter ${String(filter)}`);
      }
      current[i] = value & 0xff;
    }

    for (let x = 0; x < width; x += 1) {
      const from = x * channels;
      const to = (y * width + x) * 3;
      out[to] = current[from]!;
      out[to + 1] = current[from + 1]!;
      out[to + 2] = current[from + 2]!;
    }

    const swap = previous;
    previous = current;
    current = swap;
  }

  return { width, height, rgb: out };
}
