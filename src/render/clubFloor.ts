import { Container, Sprite } from 'pixi.js';
import { DESIGN_HEIGHT, DESIGN_WIDTH, TICK_SECONDS } from '../sim/constants.ts';
import type { GeneratedTextures } from './textures.ts';

/** Hard cap on guest sprites. The pool is allocated once, at this size. */
const GUEST_CAPACITY = 48;

const FLOOR_TOP = 300;
const FLOOR_BOTTOM = DESIGN_HEIGHT - 140;
const FLOOR_LEFT = 24;
const FLOOR_RIGHT = DESIGN_WIDTH - 24;

const GUEST_COLORS = [0xff4f9a, 0x4fd2ff, 0xffd84f, 0xb04fff, 0x4fff9e] as const;

/** Unlit dance-floor tile. */
const FLOOR_TINT = 0x241043;
const FLOOR_ALPHA = 0.7;

/**
 * Placeholder club scene.
 *
 * This exists to prove the render pipeline, not to look good: a dark room, a
 * pulsing dance floor, a DJ booth, and a pool of guests milling about. It is
 * written the way the real scene will have to be written:
 *
 *  - every sprite is pooled and allocated at boot; `tick`/`render` allocate
 *    nothing at all, so there is no garbage to collect mid-frame;
 *  - positions live in `Float32Array`s rather than per-guest objects, which
 *    keeps the update loop a flat numeric pass;
 *  - logic advances only in `tick()` (fixed step), and `render(alpha)`
 *    interpolates between the previous and current tick positions, so motion
 *    is smooth at any frame rate without the motion *speed* depending on it;
 *  - all sprites share one white texture and differ only by `tint`, so the
 *    floor draws in a single batch.
 */
export class ClubFloor {
  readonly view: Container;

  private readonly guests: Sprite[] = [];
  private readonly prevX = new Float32Array(GUEST_CAPACITY);
  private readonly prevY = new Float32Array(GUEST_CAPACITY);
  private readonly curX = new Float32Array(GUEST_CAPACITY);
  private readonly curY = new Float32Array(GUEST_CAPACITY);
  private readonly velX = new Float32Array(GUEST_CAPACITY);
  private readonly velY = new Float32Array(GUEST_CAPACITY);

  /** Pool watermark: guests `[0, activeCount)` are live and visible. */
  private activeCount = 0;

  private readonly floorTiles: Sprite[] = [];
  /** Index of the tile currently lit by the beat. */
  private litTile = 0;
  private readonly djLight: Sprite;

  private tickCount = 0;
  /** Deterministic PRNG state — no `Math.random()`, so motion is replayable. */
  private rngState = 0x9e3779b9;

  constructor(textures: GeneratedTextures) {
    this.view = new Container();

    // --- static room -------------------------------------------------------
    const room = addSprite(this.view, textures.block, 0x140b24);
    room.setSize(DESIGN_WIDTH, DESIGN_HEIGHT);

    const backWall = addSprite(this.view, textures.block, 0x1d1033);
    backWall.position.set(0, 0);
    backWall.setSize(DESIGN_WIDTH, FLOOR_TOP - 40);

    const bar = addSprite(this.view, textures.block, 0x2a1748);
    bar.position.set(FLOOR_LEFT, FLOOR_TOP - 56);
    bar.setSize(FLOOR_RIGHT - FLOOR_LEFT, 40);

    // --- dance floor: 6x8 tiles, one shared texture, tinted ---------------
    const tileCols = 6;
    const tileRows = 8;
    const tileW = (FLOOR_RIGHT - FLOOR_LEFT) / tileCols;
    const tileH = (FLOOR_BOTTOM - FLOOR_TOP) / tileRows;
    for (let row = 0; row < tileRows; row += 1) {
      for (let col = 0; col < tileCols; col += 1) {
        const tile = addSprite(this.view, textures.block, FLOOR_TINT);
        tile.position.set(FLOOR_LEFT + col * tileW + 1, FLOOR_TOP + row * tileH + 1);
        tile.setSize(tileW - 2, tileH - 2);
        tile.alpha = FLOOR_ALPHA;
        this.floorTiles.push(tile);
      }
    }

    // --- DJ booth ----------------------------------------------------------
    const booth = addSprite(this.view, textures.block, 0x3a1f63);
    booth.anchor.set(0.5, 1);
    booth.position.set(DESIGN_WIDTH / 2, FLOOR_TOP - 60);
    booth.setSize(140, 44);

    this.djLight = addSprite(this.view, textures.disc, 0xff4f9a);
    this.djLight.anchor.set(0.5);
    this.djLight.position.set(DESIGN_WIDTH / 2, FLOOR_TOP - 90);
    this.djLight.setSize(120, 120);
    this.djLight.alpha = 0.35;
    this.djLight.blendMode = 'add';

    // --- guest pool: allocated once, never grown --------------------------
    for (let i = 0; i < GUEST_CAPACITY; i += 1) {
      const guest = addSprite(this.view, textures.disc, GUEST_COLORS[i % GUEST_COLORS.length]!);
      guest.anchor.set(0.5);
      guest.setSize(14, 14);
      guest.visible = false;
      this.guests.push(guest);
    }

    this.setGuestCount(18);
  }

  /** Grow or shrink the live guest set without allocating. */
  setGuestCount(count: number): void {
    const target = Math.max(0, Math.min(GUEST_CAPACITY, Math.floor(count)));

    for (let i = this.activeCount; i < target; i += 1) {
      this.spawnGuest(i);
    }
    for (let i = target; i < this.activeCount; i += 1) {
      this.guests[i]!.visible = false;
    }
    this.activeCount = target;
  }

  private spawnGuest(index: number): void {
    const x = FLOOR_LEFT + this.random() * (FLOOR_RIGHT - FLOOR_LEFT);
    const y = FLOOR_TOP + this.random() * (FLOOR_BOTTOM - FLOOR_TOP);
    this.curX[index] = x;
    this.curY[index] = y;
    this.prevX[index] = x;
    this.prevY[index] = y;
    this.velX[index] = (this.random() - 0.5) * 70;
    this.velY[index] = (this.random() - 0.5) * 70;

    const guest = this.guests[index]!;
    guest.position.set(x, y);
    guest.visible = true;
  }

  /**
   * Fixed-step scene logic. Called once per economy tick, never per frame.
   * Allocation-free: numeric reads and writes into pre-sized arrays only.
   */
  tick(): void {
    this.tickCount += 1;

    const count = this.activeCount;
    for (let i = 0; i < count; i += 1) {
      this.prevX[i] = this.curX[i]!;
      this.prevY[i] = this.curY[i]!;

      let x = this.curX[i]! + this.velX[i]! * TICK_SECONDS;
      let y = this.curY[i]! + this.velY[i]! * TICK_SECONDS;

      if (x < FLOOR_LEFT) {
        x = FLOOR_LEFT;
        this.velX[i] = -this.velX[i]!;
      } else if (x > FLOOR_RIGHT) {
        x = FLOOR_RIGHT;
        this.velX[i] = -this.velX[i]!;
      }
      if (y < FLOOR_TOP) {
        y = FLOOR_TOP;
        this.velY[i] = -this.velY[i]!;
      } else if (y > FLOOR_BOTTOM) {
        y = FLOOR_BOTTOM;
        this.velY[i] = -this.velY[i]!;
      }

      this.curX[i] = x;
      this.curY[i] = y;
    }

    // Beat: one tile lights up per tick, so 10 "beats" a second. Only the two
    // tiles that changed are touched — unlighting the previous one and
    // lighting the next — rather than re-walking all 48 every tick.
    const previous = this.floorTiles[this.litTile]!;
    previous.tint = FLOOR_TINT;
    previous.alpha = FLOOR_ALPHA;

    this.litTile = this.tickCount % this.floorTiles.length;
    const lit = this.floorTiles[this.litTile]!;
    lit.tint = GUEST_COLORS[this.tickCount % GUEST_COLORS.length]!;
    lit.alpha = 1;
  }

  /**
   * Per-frame render pass. `alpha` is the fraction of the way to the next
   * tick, so sprites move smoothly at 120 fps while the logic still runs at
   * 10 Hz. Allocation-free.
   */
  render(alpha: number): void {
    const count = this.activeCount;
    for (let i = 0; i < count; i += 1) {
      const guest = this.guests[i]!;
      guest.position.set(
        this.prevX[i]! + (this.curX[i]! - this.prevX[i]!) * alpha,
        this.prevY[i]! + (this.curY[i]! - this.prevY[i]!) * alpha,
      );
    }

    this.djLight.alpha = 0.25 + 0.22 * (1 - alpha);
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }

  /** xorshift32 — deterministic, allocation-free, good enough for placeholder art. */
  private random(): number {
    let x = this.rngState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x >>> 0;
    return this.rngState / 0xffffffff;
  }
}

function addSprite(parent: Container, texture: Sprite['texture'], tint: number): Sprite {
  const sprite = new Sprite(texture);
  sprite.tint = tint;
  parent.addChild(sprite);
  return sprite;
}
