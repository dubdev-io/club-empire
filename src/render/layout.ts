/**
 * Where everything is, in 390x844 design space.
 *
 * One table, read by both the renderer and the hit-testing, so a sprite and
 * its touch target cannot drift apart — which is the usual way a canvas game
 * ends up with a button that looks tappable 6 px from where it is.
 *
 * The vertical order is a deliberate consequence of §9's thumb rules rather
 * than a drawing decision:
 *
 *  - **Stations sit at y 592..716**, inside the bottom 35% (y >= 550). They are
 *    the most-tapped thing in the game — fifteen upgrades in the first minute —
 *    so they have to be where the thumb already is.
 *  - **The door sits at the back, y 186..250.** It is upgraded from a sheet,
 *    not by tapping the floor, so it is free to live in the top band where
 *    §9 says to put things that are read rather than tapped. Its queue is the
 *    diagnostic, and a queue only needs to be seen.
 *  - **Nothing tappable above y 211** (the top 25%), which is reserved for the
 *    HUD to be read against.
 *
 * So the room reads front-to-back as counters → dance floor → entrance, which
 * is also how these clubs are actually laid out from the owner's side of the
 * bar.
 */

import { DESIGN_HEIGHT, DESIGN_WIDTH } from '../sim/constants.ts';
import type { StationKey } from '../config/economy.ts';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The §9 floor for any touch target. Nothing is allowed to be smaller. */
export const MIN_TOUCH = 44;

/** Cash bubbles get a bigger box than their sprite — the most-tapped object in the game. */
export const BUBBLE_TOUCH = 60;

/** Everything above this is for reading, never tapping (§9: top 25%). */
export const READ_ONLY_BELOW_Y = DESIGN_HEIGHT * 0.25;

/** Primary actions live at or below this line (§9: bottom 35%). */
export const THUMB_ZONE_FROM_Y = DESIGN_HEIGHT * 0.65;

// --- bands ------------------------------------------------------------------

/** Back wall: crowd silhouette, neon sign, DJ booth. */
export const BACK_WALL: Rect = { x: 0, y: 120, width: DESIGN_WIDTH, height: 190 };

/** The entrance. Queue trails to the right of it, along the back wall. */
export const DOOR: Rect = { x: 20, y: 186, width: 86, height: 62 };

/** Where guests turned away at the door stand. */
export const DOOR_QUEUE_ORIGIN = { x: 118, y: 218 } as const;
export const DOOR_QUEUE_STEP = 22;
export const DOOR_QUEUE_MAX = 7;

/** The only animated-colour surface in the room. */
export const DANCE_FLOOR: Rect = { x: 32, y: 300, width: 326, height: 240 };
export const DANCE_FLOOR_COLS = 6;
export const DANCE_FLOOR_ROWS = 5;

/**
 * Where cash bubbles may appear.
 *
 * Inset from the dance floor so a 60x60 touch box never hangs off the room,
 * and kept entirely below `READ_ONLY_BELOW_Y` so the most-tapped object in the
 * game is never in the band §9 reserves for reading.
 */
export const BUBBLE_FIELD: Rect = { x: 52, y: 316, width: 286, height: 208 };

// --- stations ---------------------------------------------------------------

export const STATION_SLOT_WIDTH = 110;
export const STATION_SLOT_HEIGHT = 124;
export const STATION_SLOT_Y = 592;

/** Left edge of each slot. 18 / 140 / 262 — 12 px gaps, well over the 8 px minimum. */
const STATION_SLOT_X: Record<StationKey, number> = {
  tap: 18,
  cocktail: 140,
  booth: 262,
};

export function stationSlot(key: StationKey): Rect {
  return {
    x: STATION_SLOT_X[key],
    y: STATION_SLOT_Y,
    width: STATION_SLOT_WIDTH,
    height: STATION_SLOT_HEIGHT,
  };
}

/** Where a station's bartenders stand, left to right along the counter. */
export function lanePosition(key: StationKey, lane: number): { x: number; y: number } {
  const slot = stationSlot(key);
  // Three evenly spaced positions inside the slot, inset so the outer two are
  // not flush with the edge.
  const step = slot.width / 3;
  return {
    x: slot.x + step * (lane - 0.5),
    y: slot.y + slot.height - 26,
  };
}

/** Where guests waiting for this station stand, above its counter. */
export function stationQueueOrigin(key: StationKey): { x: number; y: number } {
  const slot = stationSlot(key);
  return { x: slot.x + 14, y: STATION_SLOT_Y - 30 };
}

export const STATION_QUEUE_STEP = 17;
export const STATION_QUEUE_MAX = 6;

/** Where the back-bar stock stacks. Grows upward with level — progress visible on the floor. */
export function backBarArea(key: StationKey): Rect {
  const slot = stationSlot(key);
  return { x: slot.x + 8, y: slot.y + 10, width: slot.width - 16, height: 60 };
}

// --- the next-purchase outline (§4.4b) --------------------------------------

/**
 * The dotted outline is one object that moves to whatever the next purchase is,
 * so it needs one size that works at every anchor. 92x68 fits inside a station
 * slot, over the door, and around an empty lane position.
 */
export const OUTLINE_SIZE = { width: 92, height: 68 } as const;

export function centreOf(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Is `(px, py)` inside `rect`, grown to at least `MIN_TOUCH` on both axes? */
export function hitTest(rect: Rect, px: number, py: number, minimum = MIN_TOUCH): boolean {
  const width = Math.max(rect.width, minimum);
  const height = Math.max(rect.height, minimum);
  const x = rect.x - (width - rect.width) / 2;
  const y = rect.y - (height - rect.height) / 2;
  return px >= x && px <= x + width && py >= y && py <= y + height;
}

/** Map a bubble's normalised `(u, v)` onto the bubble field. */
export function bubblePosition(u: number, v: number): { x: number; y: number } {
  return {
    x: BUBBLE_FIELD.x + u * BUBBLE_FIELD.width,
    y: BUBBLE_FIELD.y + v * BUBBLE_FIELD.height,
  };
}
