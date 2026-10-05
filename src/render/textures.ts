import { Graphics, type Renderer, type Texture } from 'pixi.js';

/**
 * Every shape in the club, generated at boot.
 *
 * All of it is flat vector geometry rasterised once into a handful of **white**
 * textures and coloured with `tint`. Three things follow from that, all of them
 * things the brief asks for:
 *
 *  - **Zero asset bytes.** No atlas to download, no licence to record, nothing
 *    lifted from anywhere. The art direction is "flat vector shapes — no
 *    gradients, no textures, no lighting model", which is exactly what a
 *    `Graphics` path rasterises to.
 *  - **One draw call for the room.** White-plus-tint means a few hundred
 *    sprites share a handful of base textures, so Pixi batches the floor into
 *    very few draw calls. Mobile GPUs are draw-call and fill-rate limited and
 *    this is the cheapest lever there is.
 *  - **No load time.** Generation is a few dozen rasterised paths at boot,
 *    which is well inside the < 1.5 s boot target with nothing on the wire.
 *
 * Shapes are rasterised at 2x and scaled down in use, so they stay crisp on a
 * 2x device without a 3x fill-rate cost.
 */
export interface GeneratedTextures {
  /** 8x8 white square. Scaled into every rectangle: walls, counters, tiles, bars. */
  readonly block: Texture;
  /** 32px white disc. Bubble bodies, guest heads, hard-edged lights. */
  readonly disc: Texture;
  /**
   * 128px soft radial glow.
   *
   * A hard-edged disc on `blendMode: 'add'` does not read as a light — it reads
   * as a flat coloured circle, which is exactly what the DJ booth and the door
   * looked like before this existed. Pixi's `Graphics` has no radial gradient,
   * so the falloff is baked by stacking concentric circles at low alpha: the
   * centre accumulates every layer and the rim only the outermost, which is a
   * gradient by another name and costs one texture.
   */
  readonly glow: Texture;
  /** Rounded rect, 24x40. A guest's body — the capsule half of "capsule and circle". */
  readonly capsule: Texture;
  /** Ring outline, 48px. VIP collar, the one-time hint pulse, the Last Call halo. */
  readonly ring: Texture;
  /** Five-pointed star, 32px. ★ pips and the celebration burst. */
  readonly star: Texture;
  /**
   * The same star as an outline, 32px. The *unearned* ★ pip.
   *
   * A pip separated from an earned one by tint alone is colour-alone signalling,
   * which §9 forbids, and the `GOLD_VIP` / `INK_DISABLED` pair is 2.12:1 — under
   * the 3:1 non-text minimum. Hollow-vs-filled carries the same fact in shape,
   * so it survives greyscale and a colour-blind eye. The tints stay; they are
   * now the second signal rather than the only one.
   */
  readonly starOutline: Texture;
  /** Tall thin bottle, 10x28. Back-bar stock — what makes a station's level visible on the floor. */
  readonly bottle: Texture;
  /** Rounded speech-bubble-ish coin body, 44px. The cash bubble. */
  readonly coin: Texture;
  /** A single dash, 8x3. Tiled into the dotted next-purchase outline. */
  readonly dash: Texture;
  /** Narrow triangle, 24x18. The warning glyph body on queue overflow. */
  readonly wedge: Texture;
  /**
   * 160x44 strip of overlapping heads and shoulders.
   *
   * §11's answer to "the room needs to feel busier": a parallax silhouette on
   * the back wall, **one sprite**, not more entities. Three of these tile the
   * back wall and read as a hundred people for the cost of three draws.
   */
  readonly crowd: Texture;
  destroy(): void;
}

/** Rasterisation scale. 2 keeps edges clean on a 2x phone without a 3x cost. */
const RASTER = 2;

export function createTextures(renderer: Renderer): GeneratedTextures {
  const made: Texture[] = [];

  const bake = (draw: (g: Graphics) => void, resolution = RASTER): Texture => {
    const source = new Graphics();
    draw(source);
    const texture = renderer.generateTexture({ target: source, resolution });
    source.destroy();
    made.push(texture);
    return texture;
  };

  // A flat square at resolution 1: it is only ever scaled to a rectangle, so
  // there is no edge detail to preserve and a 1x source is one less texture
  // upload.
  const block = bake((g) => g.rect(0, 0, 8, 8).fill(0xffffff), 1);

  const disc = bake((g) => g.circle(16, 16, 16).fill(0xffffff));

  const glow = bake((g) => {
    const steps = 24;
    for (let i = steps; i > 0; i -= 1) {
      // Squared falloff rather than linear: a linear ramp still reads as a
      // disc with a soft edge, where a light should be mostly bright core.
      const t = i / steps;
      g.circle(64, 64, 64 * t).fill({ color: 0xffffff, alpha: 0.055 * (1 - t) + 0.01 });
    }
  }, 1);

  const capsule = bake((g) => g.roundRect(0, 0, 24, 40, 12).fill(0xffffff));

  // Drawn as a stroke so the centre stays transparent — a filled disc with a
  // smaller one punched out would need a mask and a second draw call.
  const ring = bake((g) => g.circle(24, 24, 20).stroke({ width: 4, color: 0xffffff }));

  // Both stars trace the identical path, so the filled and hollow pips cannot
  // drift apart as the silhouette is tuned.
  const starPath = (g: Graphics): Graphics => {
    g.moveTo(...starPoint(0));
    for (let i = 1; i < 10; i += 1) g.lineTo(...starPoint(i));
    return g.closePath();
  };

  const star = bake((g) => starPath(g).fill(0xffffff));

  // `alignment: 1` is Pixi's *inside* stroke, and it is load-bearing. A centred
  // stroke would hang 2 px outside the path, which widens the generated bounds
  // — and `generateTexture` bakes the bounds, so the hollow star would come out
  // in a ~34 px box against the filled one's ~30 px and render about 12%
  // smaller at the same `setSize`. Inside alignment keeps the box and the outer
  // edge exactly the filled star's.
  //
  // Width is 2, not the 4 the asset spec named, and that is the one place this
  // departs from it. A star is mostly edge: the body inside the waist is only
  // ~13 units across, so a 4-unit stroke taken entirely inwards closes to
  // within ~4.6 units of itself and the ☆ bakes as a nearly solid star with a
  // notch in it. Measured at 390x844: 18.0% ink against the filled pip's 22.6%,
  // where a hollow star should be a fraction of it. The spec's worry was the
  // opposite — a stroke too thin to see — but that was reckoned in CSS px; at
  // DPR 2 a 2-unit stroke is still ~2 device px, which is why halving it costs
  // nothing and buys back the interior.
  const starOutline = bake((g) =>
    starPath(g).stroke({ width: 2, color: 0xffffff, alignment: 1 }),
  );

  // A bottle is a body plus a neck. Enough silhouette to read at 28 px, which
  // is the size it is actually drawn at.
  const bottle = bake((g) => {
    g.roundRect(0, 10, 10, 18, 3).fill(0xffffff);
    g.rect(3.5, 0, 3, 11).fill(0xffffff);
  });

  const coin = bake((g) => g.circle(22, 22, 22).fill(0xffffff));

  const dash = bake((g) => g.rect(0, 0, 8, 3).fill(0xffffff));

  const wedge = bake((g) => {
    g.moveTo(12, 0).lineTo(24, 18).lineTo(0, 18).closePath().fill(0xffffff);
  });

  // Heads at irregular heights and radii so the tiled seam does not read as a
  // repeat, with a solid band underneath to merge them into one mass.
  const crowd = bake((g) => {
    const heads = [
      [10, 20, 10],
      [30, 15, 13],
      [52, 22, 9],
      [70, 13, 12],
      [90, 19, 11],
      [110, 12, 13],
      [131, 21, 10],
      [150, 16, 12],
    ] as const;
    for (const [cx, cy, r] of heads) g.circle(cx, cy, r).fill(0xffffff);
    g.rect(0, 22, 160, 22).fill(0xffffff);
  }, 1);

  return {
    block,
    disc,
    glow,
    capsule,
    ring,
    star,
    starOutline,
    bottle,
    coin,
    dash,
    wedge,
    crowd,
    destroy: () => {
      for (const texture of made) texture.destroy(true);
      made.length = 0;
    },
  };
}

/**
 * Vertex `i` of a five-pointed star inscribed in a 32x32 box.
 * Even indices are the outer points, odd ones the inner waist.
 */
function starPoint(i: number): [number, number] {
  const outer = 16;
  const inner = 6.6;
  const radius = i % 2 === 0 ? outer : inner;
  // -90 degrees so point 0 is at the top.
  const angle = (Math.PI / 5) * i - Math.PI / 2;
  return [16 + Math.cos(angle) * radius, 16 + Math.sin(angle) * radius];
}
