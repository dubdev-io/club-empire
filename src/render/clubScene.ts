/**
 * The club floor.
 *
 * Reads `ClubState` directly and never writes to it. The coupling is
 * deliberate: passing a fresh input object into `render` sixty times a second
 * is an allocation sixty times a second, and the whole point of the mutable
 * `ClubState` is that the renderer can read it for free.
 *
 * Three rules this file holds to:
 *
 *  - **Every sprite is pooled and created in the constructor.** `tick` and
 *    `render` allocate nothing at all — no closures, no objects, no array
 *    methods. GC stutter in an idle game's update loop is the one performance
 *    problem a player definitely notices, because the counter is always moving.
 *  - **Logic in `tick` (fixed step), interpolation in `render(alpha)`.** Guest
 *    motion speed cannot depend on frame rate.
 *  - **Structure changes in `syncProgress`.** That allocates, and is called on
 *    purchase only — a few hundred times across a whole run.
 *
 * The floor is also the game's only tutorial. The queue at the door and the
 * idle bartender are the two things that tell the player which side of the
 * `min()` is binding, so neither is decoration and neither is allowed to be
 * approximated: both are read straight off `ClubFlow`.
 */

import { Container, Sprite, type Texture } from 'pixi.js';
import {
  MAX_RENDERED_GUESTS,
  MAX_LANES,
  MAX_STATION_LEVEL,
  STATION_DEFS,
  type StationKey,
} from '../config/economy.ts';
import type { ClubState } from '../sim/clubState.ts';
import { starsAtOrBelow } from '../config/economy.ts';
import { TICK_SECONDS } from '../sim/constants.ts';
import {
  BACK_WALL,
  BUBBLE_TOUCH,
  DANCE_FLOOR,
  DANCE_FLOOR_COLS,
  DANCE_FLOOR_ROWS,
  DOOR,
  DOOR_QUEUE_MAX,
  DOOR_QUEUE_ORIGIN,
  DOOR_QUEUE_STEP,
  OUTLINE_SIZE,
  STATION_QUEUE_MAX,
  STATION_QUEUE_STEP,
  backBarArea,
  bubblePosition,
  centreOf,
  hitTest,
  lanePosition,
  stationQueueOrigin,
  stationSlot,
} from './layout.ts';
import {
  BEAT_TINTS,
  BG_RAISED,
  BG_ROOM,
  BG_SURFACE,
  CASH_GREEN,
  FLOOR_TILE_REST,
  GOLD_VIP,
  GUEST_TINTS,
  INK_DISABLED,
  INK_SECONDARY,
  NEON_CYAN,
  NEON_MAGENTA,
  NEON_VIOLET,
  WARN_AMBER,
  mixTint,
} from './palette.ts';
import type { GeneratedTextures } from './textures.ts';

export type SceneHit =
  | { readonly kind: 'bubble'; readonly index: number }
  | { readonly kind: 'station'; readonly station: StationKey }
  | { readonly kind: 'locked-station'; readonly station: StationKey };

/** Bottles on the back bar at level 1 and at level 30. Progress you can see from the floor. */
const BOTTLES_MIN = 2;
const BOTTLES_MAX = 10;

/** How many guests a station's queue shows per guest/second of unmet demand. */
const QUEUE_PER_GUEST_PER_SECOND = 4;

/** Beats per second of the dance floor at rest, and while Last Call is firing. */
const BEAT_HZ = 2;
const BEAT_HZ_LAST_CALL = 4;

/**
 * How much of the floor each beat lights, and how fast a lit tile fades.
 *
 * Seven of thirty tiles a beat with a 0.56 decay settles at roughly half the
 * floor carrying some light at any moment — a room, not a cursor. Last Call
 * lights ten, which together with the doubled `BEAT_HZ_LAST_CALL` is what makes
 * the buff read on the floor and not only in the HUD.
 */
const BEAT_TILES = 7;
const BEAT_TILES_LAST_CALL = 10;
const BEAT_DECAY = 0.62;
/** Below this, a fading tile is snapped back to rest instead of trailing forever. */
const BEAT_ENERGY_FLOOR = 0.04;
/**
 * How far toward the accent a tile at full energy travels.
 *
 * Deliberately short of 1. At 1 a lit tile is the flat accent colour and the
 * floor reads as a board of solid panels — the opposite failure to the single
 * lit square it replaced, and it swallows the guest silhouettes standing on it.
 * Under a half the tile stays a floor panel that light is falling on, which is
 * what §10's "colour, silhouette and a little additive glow do all the work"
 * actually describes. Last Call pushes further, because the buff has to read.
 */
const BEAT_MIX_PEAK = 0.42;
const BEAT_MIX_PEAK_LAST_CALL = 0.6;
/**
 * Resting tile opacity over the floor slab.
 *
 * Under 1 so the slab shows through the tile and the gaps read as panel joints
 * in a lit surface. At 1 over the room void the gaps read as holes, which is
 * what made the floor look like a wireframe in design review.
 */
const FLOOR_TILE_ALPHA = 0.82;

/** Guest walking speed on the dance floor, design px/second. */
const WALK_SPEED = 26;

interface StationArt {
  readonly key: StationKey;
  readonly root: Container;
  readonly counter: Sprite;
  readonly backBar: Sprite;
  readonly bottles: Sprite[];
  readonly shelves: Sprite[];
  readonly neonSign: Sprite;
  readonly pips: Sprite[];
  /** One per possible lane. Body + head, so a bartender reads at 28 px. */
  readonly bartenders: { body: Sprite; head: Sprite }[];
  readonly queue: { body: Sprite; head: Sprite }[];
  readonly lockGlyph: Container;
  /**
   * How many of this station's lanes are actually working, fractional.
   *
   * Cached here by `syncProgress` rather than looked up per frame. A
   * `flow.stations.find(f => f.key === …)` in `render` allocates a closure
   * every frame for every station, which is exactly the kind of invisible
   * per-frame garbage this file exists to avoid.
   */
  busyLanes: number;
}

export class ClubScene {
  readonly view: Container;

  private readonly state: ClubState;
  private readonly textures: GeneratedTextures;

  // --- room ---------------------------------------------------------------
  private readonly floorTiles: Sprite[] = [];
  private readonly crowdStrips: Sprite[] = [];
  private readonly djGlow: Sprite;
  private readonly doorFrame: Sprite;
  private readonly doorGlow: Sprite;
  private readonly doorQueue: { body: Sprite; head: Sprite }[] = [];
  private readonly doorWarning: Sprite;

  // --- stations -----------------------------------------------------------
  private readonly stations: StationArt[] = [];

  // --- dancers ------------------------------------------------------------
  /**
   * One pool for every rendered guest in the room, sized to the §11 cap of 30.
   *
   * Queue members and dancers come out of the *same* pool, so the cap is
   * enforced structurally rather than by hoping the two never peak together.
   * Queues are the diagnostic so they are served first; dancers get what is
   * left.
   */
  private readonly dancerBodies: Sprite[] = [];
  private readonly dancerHeads: Sprite[] = [];
  private readonly dancerRings: Sprite[] = [];
  private readonly prevX = new Float32Array(MAX_RENDERED_GUESTS);
  private readonly prevY = new Float32Array(MAX_RENDERED_GUESTS);
  private readonly curX = new Float32Array(MAX_RENDERED_GUESTS);
  private readonly curY = new Float32Array(MAX_RENDERED_GUESTS);
  private readonly targetX = new Float32Array(MAX_RENDERED_GUESTS);
  private readonly targetY = new Float32Array(MAX_RENDERED_GUESTS);
  private readonly bobPhase = new Float32Array(MAX_RENDERED_GUESTS);
  private activeDancers = 0;

  // --- bubbles ------------------------------------------------------------
  private readonly bubbleBodies: Sprite[] = [];
  private readonly bubbleRings: Sprite[] = [];

  // --- the §4.4b next-purchase outline ------------------------------------
  private readonly outline: Container;
  private readonly outlineDashes: Sprite[] = [];
  private readonly outlineSolid: Sprite[] = [];
  private readonly outlineFill: Sprite;

  // --- hints --------------------------------------------------------------
  private readonly hintRing: Sprite;

  private tickCount = 0;
  private beatIndex = 0;
  /** Walk cursor for which tile the next beat lights. */
  private litTile = 0;
  /**
   * Per-tile beat energy, 1 the instant a tile is lit and decaying each beat.
   *
   * This is what makes the floor read as lights rather than as a cursor: a beat
   * seeds a scatter of tiles and the previously-lit ones fade out behind it
   * instead of snapping back to rest. Two typed arrays, written on the beat
   * only (a few times a second) — the per-frame path does not touch them.
   */
  private readonly tileEnergy = new Float32Array(DANCE_FLOOR_COLS * DANCE_FLOOR_ROWS);
  /** The accent each tile is fading from, so a trail keeps the colour it was lit with. */
  private readonly tileTint = new Uint32Array(DANCE_FLOOR_COLS * DANCE_FLOOR_ROWS);
  private reducedMotion = false;
  private rngState = 0x6d2b79f5;
  /** Dotted->solid crossfade position for the next-purchase outline, 0..1. */
  private affordableT = 0;

  /**
   * Called on every dance-floor beat.
   *
   * The audio bed hangs off this rather than keeping its own 120 BPM timer, so
   * "the dance floor pulses on the audio beat" is true by construction instead
   * of being two clocks that agree at boot and drift apart over a twenty-minute
   * session.
   */
  onBeat: ((index: number) => void) | null = null;

  constructor(textures: GeneratedTextures, state: ClubState) {
    this.view = new Container();
    this.textures = textures;
    this.state = state;

    // --- room: back wall, crowd, DJ -------------------------------------
    const room = sprite(this.view, textures.block, BG_ROOM);
    room.setSize(390, 844);

    const wall = sprite(this.view, textures.block, BG_SURFACE);
    wall.position.set(BACK_WALL.x, BACK_WALL.y);
    wall.setSize(BACK_WALL.width, BACK_WALL.height);

    // Three tiles of one 160px strip. §11: a busier room costs one sprite,
    // not more entities.
    for (let i = 0; i < 3; i += 1) {
      const strip = sprite(this.view, textures.crowd, BG_RAISED);
      strip.position.set(i * 130 - 10, BACK_WALL.y + 92);
      strip.setSize(160, 44);
      strip.alpha = 0.85;
      this.crowdStrips.push(strip);
    }

    const booth = sprite(this.view, textures.block, BG_RAISED);
    booth.anchor.set(0.5, 1);
    booth.position.set(265, BACK_WALL.y + 96);
    booth.setSize(96, 34);

    this.djGlow = sprite(this.view, textures.glow, NEON_MAGENTA);
    this.djGlow.anchor.set(0.5);
    this.djGlow.position.set(265, BACK_WALL.y + 64);
    this.djGlow.setSize(190, 190);
    this.djGlow.alpha = 0.85;
    this.djGlow.blendMode = 'add';

    // --- door -------------------------------------------------------------
    this.doorGlow = sprite(this.view, textures.glow, NEON_CYAN);
    this.doorGlow.anchor.set(0.5);
    this.doorGlow.position.set(DOOR.x + DOOR.width / 2, DOOR.y + DOOR.height / 2);
    this.doorGlow.setSize(150, 150);
    this.doorGlow.alpha = 0.6;
    this.doorGlow.blendMode = 'add';

    this.doorFrame = sprite(this.view, textures.block, NEON_CYAN);
    this.doorFrame.position.set(DOOR.x, DOOR.y);
    this.doorFrame.setSize(DOOR.width, DOOR.height);
    this.doorFrame.alpha = 0.5;

    const doorMouth = sprite(this.view, textures.block, BG_SURFACE);
    doorMouth.position.set(DOOR.x + 5, DOOR.y + 5);
    doorMouth.setSize(DOOR.width - 10, DOOR.height - 5);

    // A sill on the floor side, so the entrance reads as something guests walk
    // out of rather than a window cut into the wall.
    const doorSill = sprite(this.view, textures.block, NEON_CYAN);
    doorSill.position.set(DOOR.x - 4, DOOR.y + DOOR.height - 3);
    doorSill.setSize(DOOR.width + 8, 3);
    doorSill.alpha = 0.8;

    // The door queue trails away from the entrance along the back wall. Static
    // positions: a queue is read, not animated, and a line of people shuffling
    // would pull the eye away from the dance floor.
    for (let i = 0; i < DOOR_QUEUE_MAX; i += 1) {
      const pair = this.makeGuest(this.view, 13);
      const x = DOOR_QUEUE_ORIGIN.x + i * DOOR_QUEUE_STEP;
      pair.body.position.set(x, DOOR_QUEUE_ORIGIN.y);
      pair.head.position.set(x, DOOR_QUEUE_ORIGIN.y - 22);
      this.doorQueue.push(pair);
    }

    // Shape, not text — the *word* that §9 requires alongside the glyph is in
    // the HUD banner, which is DOM and can be read by a screen reader.
    this.doorWarning = sprite(this.view, textures.wedge, WARN_AMBER);
    this.doorWarning.anchor.set(0.5, 1);
    this.doorWarning.position.set(DOOR.x + DOOR.width / 2, DOOR.y - 6);
    this.doorWarning.setSize(22, 17);
    this.doorWarning.visible = false;

    // --- dance floor ------------------------------------------------------
    // A slab under the tiles. It exists to stop the seams between tiles reading
    // as the most salient thing on the screen: over bare room void the gaps are
    // holes and the floor is a wireframe, over a slab they are panel joints in
    // a lit surface. One sprite, no per-frame cost — §11's "a busier room costs
    // one sprite, not more entities".
    //
    // An additive wash over the top was tried and cut. It was invisible against
    // a floor that now lights half its tiles, and it cost 0.27 ms avg / 0.8 ms
    // p95 of draw submission for one full-floor additive quad. Fill rate is the
    // scarce resource on the device class criterion 8 targets, so a blend that
    // buys nothing does not get to spend it.
    const slab = sprite(this.view, textures.block, BG_SURFACE);
    slab.position.set(DANCE_FLOOR.x - 4, DANCE_FLOOR.y - 4);
    slab.setSize(DANCE_FLOOR.width + 8, DANCE_FLOOR.height + 8);

    const tileW = DANCE_FLOOR.width / DANCE_FLOOR_COLS;
    const tileH = DANCE_FLOOR.height / DANCE_FLOOR_ROWS;
    for (let row = 0; row < DANCE_FLOOR_ROWS; row += 1) {
      for (let col = 0; col < DANCE_FLOOR_COLS; col += 1) {
        const tile = sprite(this.view, textures.block, FLOOR_TILE_REST);
        // A 1.5 px joint rather than 3: half the seam, half the grid.
        tile.position.set(DANCE_FLOOR.x + col * tileW + 0.75, DANCE_FLOOR.y + row * tileH + 0.75);
        tile.setSize(tileW - 1.5, tileH - 1.5);
        tile.alpha = FLOOR_TILE_ALPHA;
        this.floorTiles.push(tile);
      }
    }

    // --- stations ---------------------------------------------------------
    for (const def of STATION_DEFS) {
      this.stations.push(this.makeStation(def.key));
    }

    // --- dancers ----------------------------------------------------------
    for (let i = 0; i < MAX_RENDERED_GUESTS; i += 1) {
      const body = sprite(this.view, textures.capsule, GUEST_TINTS[i % GUEST_TINTS.length]!);
      body.anchor.set(0.5, 1);
      body.setSize(13, 22);
      body.visible = false;

      const head = sprite(this.view, textures.disc, GUEST_TINTS[(i + 2) % GUEST_TINTS.length]!);
      head.anchor.set(0.5, 1);
      head.setSize(9, 9);
      head.visible = false;

      // VIPs are told apart by shape and accessory, not hue: a gold collar
      // ring and a taller silhouette. §10 is explicit that colour alone does
      // not carry it, and a colour-blind player has to be able to see the
      // guest worth six times as much.
      const ring = sprite(this.view, textures.ring, GOLD_VIP);
      ring.anchor.set(0.5);
      ring.setSize(16, 16);
      ring.visible = false;

      this.dancerBodies.push(body);
      this.dancerHeads.push(head);
      this.dancerRings.push(ring);
      this.spawnDancer(i);
    }

    // `spawnDancer` makes each one visible, so after seeding the pool every
    // sprite is on screen. Telling `setDancerCount` the pool is currently full
    // is what makes its hide-loop run on the first call; without this the
    // guests above the target stayed visible, frozen at their spawn positions,
    // because the loop ran from an `activeDancers` of 0.
    this.activeDancers = MAX_RENDERED_GUESTS;

    // --- the next-purchase outline ---------------------------------------
    this.outline = new Container();
    this.view.addChild(this.outline);

    // Fill first so the outline draws on top of it.
    this.outlineFill = sprite(this.outline, textures.block, NEON_CYAN);
    this.outlineFill.anchor.set(0.5, 1);
    this.outlineFill.alpha = 0.2;

    this.buildOutlineFrame();

    // --- the one-time hint ring ------------------------------------------
    this.hintRing = sprite(this.view, textures.ring, GOLD_VIP);
    this.hintRing.anchor.set(0.5);
    this.hintRing.setSize(62, 62);
    this.hintRing.visible = false;

    // --- bubbles ----------------------------------------------------------
    // Added last so they are on top of everything: they are the most-tapped
    // object in the game and must never be occluded by a guest.
    for (let i = 0; i < state.bubbles.length; i += 1) {
      const body = sprite(this.view, textures.coin, CASH_GREEN);
      body.anchor.set(0.5);
      body.setSize(34, 34);
      body.visible = false;

      const ring = sprite(this.view, textures.ring, GOLD_VIP);
      ring.anchor.set(0.5);
      ring.setSize(44, 44);
      ring.visible = false;

      this.bubbleBodies.push(body);
      this.bubbleRings.push(ring);
    }

    this.syncProgress();
  }

  /**
   * Force the §11 worst case: every guest sprite live, every queue full.
   *
   * Acceptance criterion 8 is specified at "25 guests, 9 bartenders, 3 queues",
   * and normal play rarely reaches it — a well-built club has short queues by
   * definition. Measuring the budget at a state the player never sees would be
   * measuring the wrong thing in the easy direction, so this pins the scene at
   * the ceiling the design permits and leaves it there.
   *
   * Called only from the dev frame-time hook. It overrides what `syncProgress`
   * computed, so any purchase afterwards resets it.
   */
  stressTest(): { guests: number; bartenders: number; queues: number } {
    let queued = 0;
    let queues = 0;

    for (const art of this.stations) {
      let any = false;
      for (const pair of art.queue) {
        pair.body.visible = true;
        pair.head.visible = true;
        queued += 1;
        any = true;
      }
      if (any) queues += 1;
    }
    for (const pair of this.doorQueue) {
      pair.body.visible = true;
      pair.head.visible = true;
      queued += 1;
    }

    // Dancers take what the queues left, exactly as `syncProgress` does. The
    // point is to pin the scene at the §11 ceiling of 30 rendered guests, not
    // to exceed it — a frame time measured at 55 guests would be measuring a
    // state the game is not allowed to reach.
    this.activeDancers = MAX_RENDERED_GUESTS;
    this.setDancerCount(Math.max(0, MAX_RENDERED_GUESTS - queued));

    let bartenders = 0;
    for (const art of this.stations) {
      for (const pair of art.bartenders) if (pair.body.visible) bartenders += 1;
    }

    return { guests: queued + this.activeDancers, bartenders, queues };
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    if (reduced) {
      // Park every animated transform at its resting value so nothing is left
      // frozen mid-shake.
      this.djGlow.alpha = 0.3;
      for (const strip of this.crowdStrips) strip.y = BACK_WALL.y + 92;
    }
  }

  // -------------------------------------------------------------------------
  // Structure — purchase-time only, allowed to allocate
  // -------------------------------------------------------------------------

  /**
   * Rebuild everything that depends on what the player owns.
   *
   * Called after any purchase and after a restore. Allocates (it reads
   * `ClubFlow`), which is exactly why it is not called from `tick`.
   */
  syncProgress(): void {
    const flow = this.state.derived.flow;

    let queued = 0;

    for (const art of this.stations) {
      const st = this.state.stations.find((s) => s.key === art.key)!;
      const stationFlow = flow.stations.find((f) => f.key === art.key);

      art.root.alpha = st.unlocked ? 1 : 0.42;
      art.lockGlyph.visible = !st.unlocked;

      // Back-bar stock scales with level, so a L30 bar is visibly a different
      // object from a L1 one without opening a menu (§10).
      const levelFraction = (st.level - 1) / (MAX_STATION_LEVEL - 1);
      const bottles = st.unlocked
        ? Math.round(BOTTLES_MIN + levelFraction * (BOTTLES_MAX - BOTTLES_MIN))
        : 0;
      for (let i = 0; i < art.bottles.length; i += 1) {
        art.bottles[i]!.visible = i < bottles;
      }

      const stars = st.unlocked ? starsAtOrBelow(st.level) : 0;
      for (let i = 0; i < art.pips.length; i += 1) {
        const pip = art.pips[i]!;
        const earned = i < stars;
        pip.tint = earned ? GOLD_VIP : INK_DISABLED;
        pip.alpha = earned ? 1 : 0.5;
      }
      // The neon sign is the ★ reward made physical — it appears on the floor
      // at the first star and brightens with each one.
      art.neonSign.visible = stars > 0;
      art.neonSign.alpha = 0.45 + 0.18 * stars;

      for (let lane = 0; lane < MAX_LANES; lane += 1) {
        const present = st.unlocked && lane < st.lanes;
        art.bartenders[lane]!.body.visible = present;
        art.bartenders[lane]!.head.visible = present;
      }

      art.busyLanes =
        stationFlow && stationFlow.capacityPerSecond > 0
          ? (stationFlow.servedPerSecond / stationFlow.capacityPerSecond) * st.lanes
          : 0;

      // A saturated station has guests waiting; an idle one has bartenders
      // with nothing to do. Both come straight off the flow — the floor does
      // not invent a queue the economy does not have.
      const waiting =
        stationFlow && stationFlow.saturated
          ? Math.min(
              STATION_QUEUE_MAX,
              Math.max(1, Math.round(flow.turnedAwayPerSecond * QUEUE_PER_GUEST_PER_SECOND) + 1),
            )
          : 0;

      for (let i = 0; i < art.queue.length; i += 1) {
        const show = i < waiting && queued < MAX_RENDERED_GUESTS;
        art.queue[i]!.body.visible = show;
        art.queue[i]!.head.visible = show;
        if (show) queued += 1;
      }
    }

    // Door queue: guests arriving that no station can take.
    const turnedAway = flow.turnedAwayPerSecond;
    const doorWaiting =
      turnedAway > 0.001
        ? Math.min(DOOR_QUEUE_MAX, Math.max(1, Math.round(turnedAway * QUEUE_PER_GUEST_PER_SECOND)))
        : 0;
    for (let i = 0; i < this.doorQueue.length; i += 1) {
      const show = i < doorWaiting && queued < MAX_RENDERED_GUESTS;
      this.doorQueue[i]!.body.visible = show;
      this.doorQueue[i]!.head.visible = show;
      if (show) queued += 1;
    }
    this.doorWarning.visible = doorWaiting > 0;

    // Whatever the queues did not use goes to the dance floor. One guest
    // sprite per 0.35 guests/s served reads as "busy" without pretending the
    // room holds more people than §11 allows.
    const wantDancers = Math.round(flow.servedPerSecond / 0.35) + 3;
    this.setDancerCount(Math.min(MAX_RENDERED_GUESTS - queued, wantDancers));

    this.placeOutline();
  }

  /** Move the §4.4b outline to whatever the next purchase is. */
  private placeOutline(): void {
    const next = this.state.derived.nextPurchase;
    if (next === null) {
      this.outline.visible = false;
      return;
    }
    this.outline.visible = true;

    let anchor: { x: number; y: number };
    if (next.kind === 'door') {
      anchor = centreOf(DOOR);
    } else if (next.kind === 'lane') {
      anchor = lanePosition(next.station, next.lane);
      anchor = { x: anchor.x, y: anchor.y - 14 };
    } else {
      anchor = centreOf(stationSlot(next.station));
    }
    this.outline.position.set(anchor.x, anchor.y);
  }

  private setDancerCount(count: number): void {
    const target = Math.max(0, Math.min(MAX_RENDERED_GUESTS, count));
    for (let i = this.activeDancers; i < target; i += 1) this.spawnDancer(i);
    for (let i = target; i < this.activeDancers; i += 1) {
      this.dancerBodies[i]!.visible = false;
      this.dancerHeads[i]!.visible = false;
      this.dancerRings[i]!.visible = false;
    }
    this.activeDancers = target;
  }

  // -------------------------------------------------------------------------
  // Fixed-step logic — allocation-free
  // -------------------------------------------------------------------------

  tick(): void {
    this.tickCount += 1;

    const lastCall = this.state.lastCallRemaining > 0;

    // --- guests walk straight lines to a waypoint (§11: no physics) -------
    const count = this.activeDancers;
    const speed = (lastCall ? WALK_SPEED * 1.45 : WALK_SPEED) * TICK_SECONDS;
    for (let i = 0; i < count; i += 1) {
      this.prevX[i] = this.curX[i]!;
      this.prevY[i] = this.curY[i]!;

      const dx = this.targetX[i]! - this.curX[i]!;
      const dy = this.targetY[i]! - this.curY[i]!;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance <= speed) {
        this.curX[i] = this.targetX[i]!;
        this.curY[i] = this.targetY[i]!;
        this.pickWaypoint(i);
      } else {
        this.curX[i] = this.curX[i]! + (dx / distance) * speed;
        this.curY[i] = this.curY[i]! + (dy / distance) * speed;
      }
    }

    // --- nudge-aside avoidance -------------------------------------------
    // One pass against the *next* guest only, not an O(n^2) sweep. With 30
    // entities a full pass is 435 distance checks a tick for a visual nicety
    // nobody would notice; this costs 30 and still stops guests stacking.
    for (let i = 0; i < count; i += 1) {
      const j = (i + 1) % count;
      if (j === i) break;
      const dx = this.curX[j]! - this.curX[i]!;
      const dy = this.curY[j]! - this.curY[i]!;
      if (dx * dx + dy * dy < 100) {
        this.curX[i] = clamp(
          this.curX[i]! - (dx >= 0 ? 1.2 : -1.2),
          DANCE_FLOOR.x + 8,
          DANCE_FLOOR.x + DANCE_FLOOR.width - 8,
        );
      }
    }

    // --- the beat ---------------------------------------------------------
    // Reduced motion keeps the floor lit but stops it strobing: the colour
    // still changes, it just changes four times slower and without the alpha
    // pulse. The feedback is never simply removed (criterion 6).
    const hz = this.reducedMotion ? 1 : lastCall ? BEAT_HZ_LAST_CALL : BEAT_HZ;
    const ticksPerBeat = Math.max(1, Math.round(1 / (hz * TICK_SECONDS)));
    if (this.tickCount % ticksPerBeat === 0) {
      this.beatIndex += 1;
      this.advanceBeat(lastCall);
    }
  }

  /**
   * Light a scatter of dance floor and fade the previous scatter out behind it.
   *
   * Design review (craft fix A) called the old one-tile version a wireframe
   * grid rather than a dance floor, and it was right: 29 dark cells and a
   * single lit square reads as a cursor on a table. §10 gives this element one
   * job — *"the only animated-colour surface, and it carries most of the 'this
   * is a club' feeling"* — so it needs most of the floor participating.
   *
   * This stays off the frame budget. All 30 tiles are already drawn every frame
   * whatever their tint, so lighting more of them changes ~30 property writes a
   * few times a second and not the draw-call count or the entity count. The
   * whole function runs on the beat, never per frame.
   */
  private advanceBeat(lastCall: boolean): void {
    const tiles = this.floorTiles;
    const tint = BEAT_TINTS[this.beatIndex % BEAT_TINTS.length]!;

    // Everything currently lit fades a step rather than snapping back to rest.
    for (let i = 0; i < tiles.length; i += 1) {
      this.tileEnergy[i] = this.tileEnergy[i]! * BEAT_DECAY;
    }

    // A pseudo-random walk rather than a raster scan — a sweeping row reads as
    // a loading bar, a scatter reads as lights. Step 7 is coprime with 30, so
    // the cursor visits every tile rather than orbiting a subset.
    const seeds = lastCall ? BEAT_TILES_LAST_CALL : BEAT_TILES;
    for (let n = 0; n < seeds; n += 1) {
      this.litTile = (this.litTile + 7 + ((this.beatIndex + n) % 5)) % tiles.length;
      this.tileEnergy[this.litTile] = 1;
      this.tileTint[this.litTile] = tint;
    }

    // Reduced motion keeps the colour change and drops the brightness pulse:
    // the floor still tells you there is a beat, it just does not strobe.
    // Criterion 6 — the feedback is replaced, never removed.
    const pulse = this.reducedMotion ? 0 : lastCall ? 0.18 : 0.12;
    const peak = lastCall ? BEAT_MIX_PEAK_LAST_CALL : BEAT_MIX_PEAK;
    for (let i = 0; i < tiles.length; i += 1) {
      const energy = this.tileEnergy[i]!;
      const tile = tiles[i]!;
      if (energy <= BEAT_ENERGY_FLOOR) {
        this.tileEnergy[i] = 0;
        tile.tint = FLOOR_TILE_REST;
        tile.alpha = FLOOR_TILE_ALPHA;
      } else {
        tile.tint = mixTint(FLOOR_TILE_REST, this.tileTint[i]!, energy * peak);
        tile.alpha = FLOOR_TILE_ALPHA + energy * pulse;
      }
    }

    if (this.onBeat !== null) this.onBeat(this.beatIndex);
  }

  private pickWaypoint(index: number): void {
    this.targetX[index] = DANCE_FLOOR.x + 10 + this.random() * (DANCE_FLOOR.width - 20);
    this.targetY[index] = DANCE_FLOOR.y + 10 + this.random() * (DANCE_FLOOR.height - 20);
  }

  private spawnDancer(index: number): void {
    const x = DANCE_FLOOR.x + 10 + this.random() * (DANCE_FLOOR.width - 20);
    const y = DANCE_FLOOR.y + 10 + this.random() * (DANCE_FLOOR.height - 20);
    this.curX[index] = x;
    this.curY[index] = y;
    this.prevX[index] = x;
    this.prevY[index] = y;
    this.bobPhase[index] = this.random() * Math.PI * 2;
    this.pickWaypoint(index);

    // 8% of the crowd are VIPs, matching the arrival mix. Deterministic per
    // index so a guest does not change class when the pool resizes.
    const vip = index % 12 === 5;
    const body = this.dancerBodies[index]!;
    body.visible = true;
    body.setSize(vip ? 15 : 13, vip ? 26 : 22);
    this.dancerHeads[index]!.visible = true;
    this.dancerRings[index]!.visible = vip;
    if (vip) this.dancerBodies[index]!.tint = GOLD_VIP;
  }

  // -------------------------------------------------------------------------
  // Per-frame — allocation-free
  // -------------------------------------------------------------------------

  render(alpha: number, frameDeltaMs: number): void {
    const state = this.state;
    const lastCall = state.lastCallRemaining > 0;

    // --- guests -----------------------------------------------------------
    const count = this.activeDancers;
    const bobAmount = this.reducedMotion ? 0 : lastCall ? 3.2 : 1.6;
    for (let i = 0; i < count; i += 1) {
      const x = this.prevX[i]! + (this.curX[i]! - this.prevX[i]!) * alpha;
      const y = this.prevY[i]! + (this.curY[i]! - this.prevY[i]!) * alpha;
      const bob =
        bobAmount === 0
          ? 0
          : Math.sin((this.tickCount + alpha) * 0.55 + this.bobPhase[i]!) * bobAmount;

      const body = this.dancerBodies[i]!;
      body.position.set(x, y + bob);
      this.dancerHeads[i]!.position.set(x, y - body.height + bob + 2);
      const ring = this.dancerRings[i]!;
      if (ring.visible) ring.position.set(x, y - body.height + bob - 1);
    }

    // --- bubbles ----------------------------------------------------------
    for (let i = 0; i < this.bubbleBodies.length; i += 1) {
      const slot = state.bubbles[i]!;
      const body = this.bubbleBodies[i]!;
      const ring = this.bubbleRings[i]!;

      if (!slot.active) {
        body.visible = false;
        ring.visible = false;
        continue;
      }

      const { x, y } = bubblePosition(slot.u, slot.v);
      // A 180 ms pop in, then a slow hover. Reduced motion lands it at full
      // size immediately — the bubble still appears, it just does not spring.
      const pop = this.reducedMotion ? 1 : Math.min(1, slot.age / 0.18);
      const eased = 1 - (1 - pop) * (1 - pop);
      const hover = this.reducedMotion ? 0 : Math.sin(slot.age * 2.4) * 2.5;
      const size = 34 * (0.4 + 0.6 * eased);

      body.visible = true;
      body.setSize(size, size);
      body.tint = slot.vip ? GOLD_VIP : CASH_GREEN;
      body.position.set(x, y + hover);

      ring.visible = slot.vip;
      if (slot.vip) {
        ring.setSize(size + 12, size + 12);
        ring.position.set(x, y + hover);
      }
    }

    // --- the §4.4b progress fill -----------------------------------------
    this.renderOutline(frameDeltaMs);

    // --- the one-time hint ring ------------------------------------------
    this.renderHint(alpha);

    // --- bartenders: busy bob, idle still --------------------------------
    for (let s = 0; s < this.stations.length; s += 1) {
      const art = this.stations[s]!;
      const busyLanes = art.busyLanes;

      for (let lane = 0; lane < MAX_LANES; lane += 1) {
        const pair = art.bartenders[lane]!;
        if (!pair.body.visible) continue;

        const busy = lane < busyLanes;
        const base = lanePosition(art.key, lane + 1);
        // An idle bartender is dimmed and still. That is the other half of the
        // diagnostic: a queue says "buy capacity", an idle bartender says
        // "stop buying capacity".
        const bob =
          busy && !this.reducedMotion
            ? Math.abs(Math.sin((this.tickCount + alpha) * 0.42 + lane)) * 2.6
            : 0;
        pair.body.position.set(base.x, base.y - bob);
        pair.head.position.set(base.x, base.y - pair.body.height - bob + 2);
        pair.body.alpha = busy ? 1 : 0.4;
        pair.head.alpha = busy ? 1 : 0.4;
      }
    }

    // --- room ambience ----------------------------------------------------
    if (!this.reducedMotion) {
      const pulse = Math.sin((this.tickCount + alpha) * 0.22);
      this.djGlow.alpha = (lastCall ? 1 : 0.8) + pulse * 0.12;
      this.djGlow.setSize(190 + pulse * 16, 190 + pulse * 16);
      // A single-sprite parallax drift; §11's answer to a busier room.
      for (let i = 0; i < this.crowdStrips.length; i += 1) {
        this.crowdStrips[i]!.y = BACK_WALL.y + 92 + Math.sin((this.tickCount + alpha) * 0.1 + i) * 1.6;
      }
    } else {
      this.djGlow.alpha = lastCall ? 1 : 0.8;
    }

    this.doorGlow.alpha = 0.5 + Math.min(0.45, state.derived.flow.arrivalsPerSecond * 0.12);
  }

  private renderOutline(frameDeltaMs: number): void {
    const next = this.state.derived.nextPurchase;
    if (next === null) {
      this.outline.visible = false;
      return;
    }

    const affordable = this.state.cash >= next.cost;
    const progress = clamp(next.cost > 0 ? this.state.cash / next.cost : 1, 0, 1);

    // Fill from the bottom of the frame's inner box, --neon-cyan at 20% alpha,
    // every frame. The fill visibly accelerates when the player taps, which is
    // the whole reason §4.4b prefers it to a countdown: an ETA teaches you to
    // put the phone down.
    const innerHeight = OUTLINE_SIZE.height - 6;
    this.outlineFill.setSize(OUTLINE_SIZE.width - 6, Math.max(0.5, innerHeight * progress));
    this.outlineFill.position.set(0, innerHeight / 2);
    // Always --neon-cyan at 20%, affordable or not. §4.4b moves the *outline*
    // and the price label on affordability, not the fill — and a fill that
    // flips to --cash-green at full height stops being a progress signal and
    // starts being a green block over the station art.
    this.outlineFill.alpha = 0.2;

    // Dotted -> solid on affordability over 180 ms, driven by the real frame
    // delta. Crossfading the dashed frame against a solid twin is how a
    // `border-style` transition is done when there is no border to animate.
    const step = frameDeltaMs / 180;
    this.affordableT = clamp(this.affordableT + (affordable ? step : -step), 0, 1);
    const t = this.affordableT;

    const tint = affordable ? CASH_GREEN : NEON_CYAN;
    for (let i = 0; i < this.outlineDashes.length; i += 1) {
      const dash = this.outlineDashes[i]!;
      dash.alpha = 1 - t;
      dash.tint = tint;
    }
    for (let i = 0; i < this.outlineSolid.length; i += 1) {
      const edge = this.outlineSolid[i]!;
      edge.alpha = t;
      edge.tint = tint;
    }
  }

  private renderHint(alpha: number): void {
    const state = this.state;

    // One pulsing ring at a time, and only the first one still pending. The
    // whole of the game's guidance: no modal, no text wall, dismissed by being
    // tapped.
    let target: { x: number; y: number } | null = null;
    let size = 62;

    let firstBubble = -1;
    for (let i = 0; i < state.bubbles.length; i += 1) {
      if (state.bubbles[i]!.active) {
        firstBubble = i;
        break;
      }
    }

    if (state.hintBubblePending && firstBubble >= 0) {
      const slot = state.bubbles[firstBubble]!;
      target = bubblePosition(slot.u, slot.v);
      size = BUBBLE_TOUCH;
    } else if (state.hintStationPending) {
      const slot = stationSlot('tap');
      target = centreOf(slot);
      size = 96;
    }

    if (target === null) {
      this.hintRing.visible = false;
      return;
    }

    this.hintRing.visible = true;
    this.hintRing.position.set(target.x, target.y);
    // Reduced motion gets a static ring at full opacity rather than no ring —
    // removing the only piece of guidance in the game would be a different
    // product for those players.
    if (this.reducedMotion) {
      this.hintRing.setSize(size, size);
      this.hintRing.alpha = 0.9;
    } else {
      const pulse = (Math.sin((this.tickCount + alpha) * 0.3) + 1) / 2;
      this.hintRing.setSize(size + pulse * 14, size + pulse * 14);
      this.hintRing.alpha = 0.55 + pulse * 0.45;
    }
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  /**
   * What is at `(x, y)` in design space.
   *
   * Bubbles win over stations when the boxes overlap: a bubble is transient and
   * a station is not, so a tap meant for a bubble that upgraded a bar instead
   * is the more annoying mistake. Every box is grown to at least 44x44, and
   * bubbles to 60x60, regardless of sprite size (§9).
   */
  pick(x: number, y: number): SceneHit | null {
    for (let i = 0; i < this.state.bubbles.length; i += 1) {
      const slot = this.state.bubbles[i]!;
      if (!slot.active) continue;
      const { x: bx, y: by } = bubblePosition(slot.u, slot.v);
      const box = {
        x: bx - BUBBLE_TOUCH / 2,
        y: by - BUBBLE_TOUCH / 2,
        width: BUBBLE_TOUCH,
        height: BUBBLE_TOUCH,
      };
      if (hitTest(box, x, y, BUBBLE_TOUCH)) return { kind: 'bubble', index: i };
    }

    for (const st of this.state.stations) {
      if (hitTest(stationSlot(st.key), x, y)) {
        return st.unlocked
          ? { kind: 'station', station: st.key }
          : { kind: 'locked-station', station: st.key };
      }
    }

    return null;
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }

  // -------------------------------------------------------------------------
  // Construction helpers
  // -------------------------------------------------------------------------

  private makeStation(key: StationKey): StationArt {
    const slot = stationSlot(key);
    const root = new Container();
    this.view.addChild(root);

    const backBar = sprite(root, this.textures.block, BG_SURFACE);
    backBar.position.set(slot.x, slot.y);
    backBar.setSize(slot.width, slot.height - 18);

    const bar = backBarArea(key);

    // Two shelves, drawn first so the bottles stand *on* them. Without these
    // the bottles read as hanging from the top of the slot rather than being
    // stock on a back bar, which is the one thing they exist to communicate.
    const shelves: Sprite[] = [];
    for (let row = 0; row < 2; row += 1) {
      const shelf = sprite(root, this.textures.block, BG_RAISED);
      shelf.position.set(bar.x, bar.y + 30 + row * 28);
      shelf.setSize(bar.width, 2);
      shelves.push(shelf);
    }

    const bottles: Sprite[] = [];
    for (let i = 0; i < BOTTLES_MAX; i += 1) {
      // Two rows of five, so stock reads as a stocked shelf rather than a bar
      // chart. Filled bottom shelf first: a half-stocked bar should look
      // half-stocked, not top-heavy.
      const col = i % 5;
      const row = i < 5 ? 1 : 0;
      const bottle = sprite(root, this.textures.bottle, i % 2 === 0 ? NEON_VIOLET : NEON_CYAN);
      bottle.anchor.set(0.5, 1);
      bottle.position.set(bar.x + 10 + col * 19, bar.y + 30 + row * 28);
      bottle.setSize(9, 22);
      bottle.alpha = 0.95;
      bottle.visible = false;
      bottles.push(bottle);
    }

    const neonSign = sprite(root, this.textures.block, NEON_MAGENTA);
    neonSign.anchor.set(0.5, 0);
    neonSign.position.set(slot.x + slot.width / 2, slot.y + 4);
    neonSign.setSize(slot.width - 34, 4);
    neonSign.blendMode = 'add';
    neonSign.visible = false;

    // The counter, at the front. Bartenders stand behind it.
    const counter = sprite(root, this.textures.block, BG_RAISED);
    counter.position.set(slot.x, slot.y + slot.height - 18);
    counter.setSize(slot.width, 18);

    const bartenders: { body: Sprite; head: Sprite }[] = [];
    for (let lane = 0; lane < MAX_LANES; lane += 1) {
      bartenders.push(this.makeGuest(root, 14, INK_SECONDARY));
    }

    const queue: { body: Sprite; head: Sprite }[] = [];
    const origin = stationQueueOrigin(key);
    for (let i = 0; i < STATION_QUEUE_MAX; i += 1) {
      const pair = this.makeGuest(root, 12);
      pair.body.position.set(origin.x + i * STATION_QUEUE_STEP, origin.y);
      pair.head.position.set(origin.x + i * STATION_QUEUE_STEP, origin.y - 20);
      queue.push(pair);
    }

    // ★ pips, above the counter so they read as the bar's rating.
    const pips: Sprite[] = [];
    for (let i = 0; i < 3; i += 1) {
      const pip = sprite(root, this.textures.star, INK_DISABLED);
      pip.anchor.set(0.5);
      pip.position.set(slot.x + slot.width / 2 + (i - 1) * 16, slot.y + slot.height - 9);
      pip.setSize(12, 12);
      pips.push(pip);
    }

    // A locked station gets a padlock as well as reduced opacity: §9 forbids
    // signalling state by opacity or colour alone, and an empty dark rectangle
    // reads as a rendering bug rather than as something to buy.
    const lockGlyph = new Container();
    root.addChild(lockGlyph);
    const lockCentre = { x: slot.x + slot.width / 2, y: slot.y + slot.height / 2 };

    const lockBody = sprite(lockGlyph, this.textures.block, INK_SECONDARY);
    lockBody.anchor.set(0.5, 0);
    lockBody.position.set(lockCentre.x, lockCentre.y);
    lockBody.setSize(28, 22);

    const lockShackle = sprite(lockGlyph, this.textures.ring, INK_SECONDARY);
    lockShackle.anchor.set(0.5, 0.5);
    lockShackle.position.set(lockCentre.x, lockCentre.y - 2);
    lockShackle.setSize(20, 20);

    // The shackle is a full ring; the body covers its lower half, leaving the
    // upward arc a padlock needs. One fewer baked texture than a dedicated
    // padlock shape.
    lockGlyph.addChild(lockBody);
    lockGlyph.visible = false;

    return {
      key,
      root,
      counter,
      backBar,
      bottles,
      shelves,
      neonSign,
      pips,
      bartenders,
      queue,
      lockGlyph,
      busyLanes: 0,
    };
  }

  /** A guest: capsule body plus a disc head. Two sprites, one batch. */
  private makeGuest(
    parent: Container,
    width: number,
    tint?: number,
  ): { body: Sprite; head: Sprite } {
    const index = this.rngState % GUEST_TINTS.length;
    const body = sprite(parent, this.textures.capsule, tint ?? GUEST_TINTS[index]!);
    body.anchor.set(0.5, 1);
    body.setSize(width, width * 1.7);
    body.visible = false;

    const head = sprite(parent, this.textures.disc, tint ?? INK_SECONDARY);
    head.anchor.set(0.5, 1);
    head.setSize(width * 0.7, width * 0.7);
    head.visible = false;

    // Advance the colour cursor so successive guests differ.
    this.random();
    return { body, head };
  }

  /** The dotted frame and its solid twin, both centred on the outline's origin. */
  private buildOutlineFrame(): void {
    const halfW = OUTLINE_SIZE.width / 2;
    const halfH = OUTLINE_SIZE.height / 2;
    const dashLength = 7;
    const gap = 5;

    const addDash = (x: number, y: number, w: number, h: number): void => {
      const dash = sprite(this.outline, this.textures.dash, NEON_CYAN);
      dash.anchor.set(0.5);
      dash.position.set(x, y);
      dash.setSize(w, h);
      this.outlineDashes.push(dash);
    };

    for (let x = -halfW; x <= halfW; x += dashLength + gap) {
      addDash(x, -halfH, dashLength, 2);
      addDash(x, halfH, dashLength, 2);
    }
    for (let y = -halfH; y <= halfH; y += dashLength + gap) {
      addDash(-halfW, y, 2, dashLength);
      addDash(halfW, y, 2, dashLength);
    }

    const addEdge = (x: number, y: number, w: number, h: number): void => {
      const edge = sprite(this.outline, this.textures.block, CASH_GREEN);
      edge.anchor.set(0.5);
      edge.position.set(x, y);
      edge.setSize(w, h);
      edge.alpha = 0;
      this.outlineSolid.push(edge);
    };
    addEdge(0, -halfH, OUTLINE_SIZE.width, 2);
    addEdge(0, halfH, OUTLINE_SIZE.width, 2);
    addEdge(-halfW, 0, 2, OUTLINE_SIZE.height);
    addEdge(halfW, 0, 2, OUTLINE_SIZE.height);
  }

  /** xorshift32 — deterministic, allocation-free. Placement only. */
  private random(): number {
    let x = this.rngState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x >>> 0;
    return this.rngState / 0x100000000;
  }
}

function sprite(parent: Container, texture: Texture, tint: number): Sprite {
  const s = new Sprite(texture);
  s.tint = tint;
  parent.addChild(s);
  return s;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

