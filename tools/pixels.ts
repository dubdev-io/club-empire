/**
 * The pixel half of `contrast.ts`: decode a screenshot, and pull the glyph
 * colour and the surface colour out of it.
 *
 * Its own module so it can be tested without a browser. Everything here is a
 * pure function of bytes, which is exactly the part of the harness whose
 * answer has to be defensible — `contrast.ts` owns the CDP driving, this owns
 * the arithmetic.
 */

import { inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// A PNG reader, because CDP hands back a PNG and we need the pixels
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// WCAG
// ---------------------------------------------------------------------------

export type Rgb = readonly [number, number, number];

/** WCAG 2.x relative luminance of an 8-bit sRGB triplet. */
export function luminance([r, g, b]: Rgb): number {
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export const hex = ([r, g, b]: Rgb): string =>
  `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

export interface Sample {
  readonly text: Rgb;
  readonly surface: Rgb;
  /** How many pixels the patch holds in total. */
  readonly pixels: number;
  /**
   * How many of them carry the glyph colour. Printed, so the number is
   * checkable. Zero means no colour cleared `glyphFloor` — the patch holds no
   * text, which is a broken probe rather than a contrast result.
   */
  readonly textPixels: number;
}

/**
 * How much of the patch the glyph colour has to cover to be believed.
 *
 * Without a floor the reported ratio is set by whichever single pixel happens
 * to sit furthest from the surface in luminance, and a lone antialiased pixel
 * on a glyph's edge qualifies. On the real MAXED badge the chosen colour covers
 * 15343 of 86016 sampled pixels — about 18% — so a floor three orders of
 * magnitude below that changes no honest measurement and rejects the stray
 * pixel. 0.05% of a 390x844 @4x badge clip is 43 pixels; the 16-pixel minimum
 * keeps it meaningful on a very small clip.
 */
export const glyphFloor = (pixels: number): number => Math.max(16, Math.round(pixels * 0.0005));

/**
 * Pick the glyph colour and the surface colour out of a patch of text.
 *
 * The surface is the most common pixel: a text box is mostly background. The
 * glyph is the pixel furthest from it in luminance — the interior of a stem,
 * where antialiasing has not diluted the colour. Taking the extreme rather than
 * an average is deliberate: WCAG asks about the text colour as specified, and
 * an average over a glyph's soft edge would flatter every ratio.
 *
 * "Furthest" is taken over the colours that clear `glyphFloor` only, so the
 * extreme is a stem interior rather than one antialiased outlier (DUB-54).
 */
export function sample(bitmap: Bitmap): Sample {
  const counts = new Map<number, number>();
  for (let i = 0; i < bitmap.rgb.length; i += 3) {
    const key = (bitmap.rgb[i]! << 16) | (bitmap.rgb[i + 1]! << 8) | bitmap.rgb[i + 2]!;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let surfaceKey = 0;
  let best = -1;
  for (const [key, count] of counts) {
    if (count > best) {
      best = count;
      surfaceKey = key;
    }
  }
  const surface: Rgb = [(surfaceKey >> 16) & 0xff, (surfaceKey >> 8) & 0xff, surfaceKey & 0xff];
  const surfaceLuminance = luminance(surface);

  const pixels = bitmap.width * bitmap.height;
  const floor = glyphFloor(pixels);

  let text = surface;
  let textPixels = 0;
  let furthest = 0;
  for (const [key, count] of counts) {
    if (count < floor) continue;
    const pixel: Rgb = [(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff];
    const distance = Math.abs(luminance(pixel) - surfaceLuminance);
    if (distance > furthest) {
      furthest = distance;
      text = pixel;
      textPixels = count;
    }
  }

  return { text, surface, pixels, textPixels };
}

