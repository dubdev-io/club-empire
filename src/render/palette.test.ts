import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as palette from './palette.ts';

/**
 * The canvas palette must agree with the CSS tokens.
 *
 * `src/render/palette.ts` is the one sanctioned duplication of a design token —
 * a Pixi `tint` is an integer and there is no way to read a custom property per
 * frame. Duplication that nothing checks is duplication that drifts, so this
 * parses `tokens.css` and compares every pair. Acceptance criterion 5 says
 * every colour comes from the tokens; this is what makes that true of the
 * WebGL layer and not just the DOM.
 */

const TOKENS_CSS = readFileSync(
  fileURLToPath(new URL('../styles/tokens.css', import.meta.url)),
  'utf8',
);

/** Every `--name: #hex;` declaration in the tokens file. */
function readTokens(css: string): Map<string, number> {
  const out = new Map<string, number>();
  const pattern = /(--[a-z-]+)\s*:\s*#([0-9a-f]{6})\b/gi;
  for (const match of css.matchAll(pattern)) {
    out.set(match[1]!.toLowerCase(), Number.parseInt(match[2]!, 16));
  }
  return out;
}

const tokens = readTokens(TOKENS_CSS);

/** Mirrored constant -> the token it claims to mirror. */
const PAIRS: ReadonlyArray<readonly [keyof typeof palette, string]> = [
  ['BG_ROOM', '--bg-room'],
  ['BG_SURFACE', '--bg-surface'],
  ['BG_RAISED', '--bg-raised'],
  ['INK_PRIMARY', '--ink-primary'],
  ['INK_SECONDARY', '--ink-secondary'],
  ['INK_DISABLED', '--ink-disabled'],
  ['NEON_MAGENTA', '--neon-magenta'],
  ['NEON_CYAN', '--neon-cyan'],
  ['NEON_VIOLET', '--neon-violet'],
  ['GOLD_VIP', '--gold-vip'],
  ['CASH_GREEN', '--cash-green'],
  ['WARN_AMBER', '--warn-amber'],
  ['DANGER', '--danger'],
];

describe('the canvas palette mirrors the CSS tokens', () => {
  it('parsed the tokens file at all', () => {
    // Guards the guard: a regex that silently matches nothing would make every
    // assertion below vacuous.
    expect(tokens.size).toBeGreaterThanOrEqual(PAIRS.length);
  });

  it.each(PAIRS)('%s === %s', (constant, token) => {
    const expected = tokens.get(token);
    expect(expected, `${token} is missing from tokens.css`).toBeDefined();
    expect(palette[constant]).toBe(expected);
  });

  it('derives guest and beat colours from the tokens, not from new hexes', () => {
    // §10: the room is not allowed to drift away from the palette, and a
    // one-off "nearly magenta" is exactly how that starts.
    const allowed = new Set(tokens.values());
    for (const tint of [...palette.GUEST_TINTS, ...palette.BEAT_TINTS, palette.FLOOR_TILE_REST]) {
      expect(allowed.has(tint)).toBe(true);
    }
  });
});
