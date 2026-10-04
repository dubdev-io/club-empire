/**
 * The §10 tokens as numbers, for the WebGL layer.
 *
 * This is the one sanctioned duplication of a design token. A Pixi `tint` is a
 * 24-bit integer and there is no way to read a CSS custom property per frame
 * without a `getComputedStyle` call, which is a layout flush — so the canvas
 * keeps its own copy.
 *
 * **If you change a colour, change it in `src/styles/tokens.css` first and
 * mirror it here.** Every constant below names the token it mirrors so the pair
 * is greppable, and `palette.test.ts` parses the CSS and fails if the two ever
 * disagree — which is what stops this file quietly becoming a second palette.
 */

/** --bg-room */
export const BG_ROOM = 0x0b0a14;
/** --bg-surface */
export const BG_SURFACE = 0x171527;
/** --bg-raised */
export const BG_RAISED = 0x231f3a;
/** --ink-primary */
export const INK_PRIMARY = 0xf4f1ff;
/** --ink-secondary */
export const INK_SECONDARY = 0xa9a2c9;
/** --ink-disabled */
export const INK_DISABLED = 0x6b6590;
/** --neon-magenta */
export const NEON_MAGENTA = 0xff3d9a;
/** --neon-cyan */
export const NEON_CYAN = 0x2fe4e0;
/** --neon-violet */
export const NEON_VIOLET = 0x8b5cf6;
/** --gold-vip */
export const GOLD_VIP = 0xffc94a;
/** --cash-green */
export const CASH_GREEN = 0x4ade80;
/** --warn-amber */
export const WARN_AMBER = 0xfbbf24;
/** --danger */
export const DANGER = 0xf87171;

/**
 * Guest body colours.
 *
 * Drawn from the accent tokens rather than invented, so the room cannot drift
 * away from the palette. Guests are told apart by **shape and accessory**
 * (§10) — a VIP has a different silhouette and a gold ring — so these only
 * have to keep the crowd from looking uniform, and none of them carries
 * meaning on its own.
 */
export const GUEST_TINTS = [NEON_MAGENTA, NEON_CYAN, NEON_VIOLET, INK_SECONDARY, CASH_GREEN] as const;

/** Dance-floor tile at rest. --bg-raised; the beat tints it toward an accent. */
export const FLOOR_TILE_REST = BG_RAISED;

/**
 * Beat colours the dance floor cycles through. The only animated-colour surface
 * in the room.
 *
 * Gold is deliberately **not** in the rotation, for two reasons that only
 * became visible once the floor lit more than one tile at a time (craft fix A).
 * Blended part-way into the dark base it lands on olive-brown — the one muddy
 * colour the palette can produce — and §10 assigns gold to *VIP guests, stars
 * and cash*, so a gold floor puts the money colour under the gold cash bubble
 * the player is trying to find. Magenta is the token the table actually names
 * for "dance floor pulse".
 */
export const BEAT_TINTS = [NEON_MAGENTA, NEON_VIOLET, NEON_CYAN] as const;

/**
 * Blend two tints channel-wise, `t` of the way from `from` to `to`.
 *
 * This does not invent a colour. It interpolates *between two §10 tokens* —
 * the same thing an alpha crossfade between two token-tinted sprites produces —
 * and exists so a fading dance-floor tile can travel back to rest instead of
 * popping. Both endpoints come from this file, so criterion 5 still holds:
 * there is no third hex anywhere.
 *
 * `t` outside 0..1 is clamped, because a decay curve that overshoots by a
 * rounding error must not wrap a channel and flash the wrong colour.
 */
export function mixTint(from: number, to: number, t: number): number {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const fromR = (from >> 16) & 0xff;
  const fromG = (from >> 8) & 0xff;
  const fromB = from & 0xff;
  const r = Math.round(fromR + (((to >> 16) & 0xff) - fromR) * k);
  const g = Math.round(fromG + (((to >> 8) & 0xff) - fromG) * k);
  const b = Math.round(fromB + ((to & 0xff) - fromB) * k);
  return (r << 16) | (g << 8) | b;
}
