/**
 * The arithmetic the contrast harness reports is a number people act on, so
 * the part of it that is a pure function of bytes is pinned here. The browser
 * driving in `contrast.ts` is verified by running the tool; this covers the
 * decision `sample()` makes about *which* pixel is the glyph (DUB-54).
 */

import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { Bitmap, Rgb } from './pixels.ts';
import { contrast, decodePng, glyphFloor, luminance, sample } from './pixels.ts';

/** A flat patch of `surface` with `count` pixels of `ink` painted into it. */
function patch(width: number, height: number, surface: Rgb, ink: readonly [Rgb, number][]): Bitmap {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    rgb[i * 3] = surface[0];
    rgb[i * 3 + 1] = surface[1];
    rgb[i * 3 + 2] = surface[2];
  }
  let at = 0;
  for (const [colour, count] of ink) {
    for (let n = 0; n < count; n += 1, at += 1) {
      rgb[at * 3] = colour[0];
      rgb[at * 3 + 1] = colour[1];
      rgb[at * 3 + 2] = colour[2];
    }
  }
  return { width, height, rgb };
}

const NAVY: Rgb = [0x17, 0x15, 0x27];
const AMBER: Rgb = [0xff, 0xc9, 0x4a];
const WHITE: Rgb = [0xff, 0xff, 0xff];

describe('luminance and contrast', () => {
  it('matches the WCAG reference figures', () => {
    expect(luminance([0, 0, 0])).toBe(0);
    expect(luminance(WHITE)).toBeCloseTo(1, 10);
    expect(contrast(WHITE, [0, 0, 0])).toBeCloseTo(21, 10);
    expect(contrast(NAVY, NAVY)).toBe(1);
  });

  it('is the measured MAXED badge figure for amber on the sheet surface', () => {
    // The number DUB-42 shipped and DUB-54 re-measured independently. If this
    // moves, either a token changed or the formula did.
    expect(contrast(AMBER, NAVY)).toBeCloseTo(11.68, 2);
  });
});

describe('glyphFloor', () => {
  it('is a fraction of the patch, never below a usable handful', () => {
    expect(glyphFloor(86016)).toBe(43);
    expect(glyphFloor(100)).toBe(16);
  });
});

describe('sample', () => {
  it('reads the glyph and the surface off a patch, and says how many pixels', () => {
    const bitmap = patch(128, 128, NAVY, [[AMBER, 2000]]);
    const got = sample(bitmap);

    expect(got.surface).toEqual(NAVY);
    expect(got.text).toEqual(AMBER);
    expect(got.pixels).toBe(128 * 128);
    expect(got.textPixels).toBe(2000);
    expect(contrast(got.text, got.surface)).toBeCloseTo(11.68, 2);
  });

  it('ignores a stray antialiased pixel further from the surface than the glyph', () => {
    // This is the hardening DUB-54 asked for. White is further from the navy
    // surface than the amber glyph is, so without the coverage floor these
    // eight pixels would set the reported ratio for the whole probe.
    const bitmap = patch(128, 128, NAVY, [
      [AMBER, 2000],
      [WHITE, 8],
    ]);
    const got = sample(bitmap);

    expect(got.text).toEqual(AMBER);
    expect(got.textPixels).toBe(2000);
  });

  it('reports no glyph rather than a ratio when nothing clears the floor', () => {
    // A clip that landed on empty surface. Reporting 1.00:1 here as if it were
    // a contrast failure is exactly the authoritative-but-wrong number the
    // ticket is about, so `textPixels: 0` lets the caller say NO GLYPH instead.
    const bitmap = patch(128, 128, NAVY, [[AMBER, 4]]);
    const got = sample(bitmap);

    expect(got.textPixels).toBe(0);
    expect(got.text).toEqual(got.surface);
  });

  it('takes the stem interior, not the average over a soft edge', () => {
    // A glyph with a large halo: the half-lit edge is more numerous than the
    // core, but the core is the colour WCAG asks about.
    const halo: Rgb = [0x8b, 0x6f, 0x38];
    const bitmap = patch(128, 128, NAVY, [
      [AMBER, 500],
      [halo, 3000],
    ]);

    expect(sample(bitmap).text).toEqual(AMBER);
  });
});

describe('decodePng', () => {
  it('round-trips an uncompressed RGB PNG through the filters it supports', () => {
    // Built here rather than checked in as a fixture: the point is the filter
    // reconstruction, and a hand-built PNG makes the expected pixels obvious.
    const width = 3;
    const height = 2;
    const pixels: Rgb[] = [NAVY, AMBER, WHITE, WHITE, NAVY, AMBER];
    const png = buildPng(width, height, pixels);

    const got = decodePng(png);
    expect(got.width).toBe(width);
    expect(got.height).toBe(height);
    expect([...got.rgb]).toEqual(pixels.flatMap((p) => [...p]));
  });
});

/** A minimal non-interlaced 8-bit RGB PNG with filter 0 on every scanline. */
function buildPng(width: number, height: number, pixels: readonly Rgb[]): Buffer {
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const p = pixels[y * width + x]!;
      raw[row + 1 + x * 3] = p[0];
      raw[row + 2 + x * 3] = p[1];
      raw[row + 3 + x * 3] = p[2];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  // 10 compression, 11 filter, 12 interlace all stay 0.

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
