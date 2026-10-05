import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The ★ pip's non-colour signal, pinned at the source.
 *
 * The pip is a WebGL sprite, so the thing that actually proves it reads is a
 * greyscale capture — and that is what the ticket was verified with. What a
 * capture cannot do is *stay* true: the two failure modes here are both silent
 * and both invisible to `tsc`.
 *
 *  1. The filled and hollow stars drift apart, because someone retunes one
 *     vertex path and not the other. They share `starPath` precisely so this
 *     cannot happen; nothing but a test keeps them sharing it.
 *  2. The outline's `alignment: 1` is dropped or set to a centred stroke. Pixi
 *     bakes a texture from the drawn *bounds*, and a centred 4 px stroke hangs
 *     2 px outside the path, so the hollow star would come out in a wider box
 *     and render ~12% smaller than its filled neighbour at the same
 *     `setSize`. It would still look like a star, which is what makes it a
 *     regression nobody notices.
 *
 * Read from source for the same reason `palette.test.ts` does: the invariant is
 * "these two declarations agree", and that is a property of the file, not of a
 * value the module exports. The suite is `environment: 'node'` with no GL
 * context, so there is no texture to measure at runtime.
 */

const TEXTURES = readFileSync(fileURLToPath(new URL('./textures.ts', import.meta.url)), 'utf8');
const CLUB_SCENE = readFileSync(fileURLToPath(new URL('./clubScene.ts', import.meta.url)), 'utf8');

/**
 * Source of the `const <name> = bake(...)` declaration, up to the blank line
 * that ends it. Deliberately crude — it only has to be sharp enough to tell
 * "this bake draws its own path" from "this bake calls the shared one".
 */
function bakeSource(name: string): string {
  const start = TEXTURES.indexOf(`const ${name} = bake(`);
  expect(start, `textures.ts should declare a baked \`${name}\``).toBeGreaterThan(-1);
  const end = TEXTURES.indexOf('\n\n', start);
  return TEXTURES.slice(start, end === -1 ? undefined : end);
}

describe('the ★ pip textures', () => {
  it('exposes a hollow star alongside the filled one', () => {
    expect(TEXTURES).toMatch(/readonly starOutline: Texture;/);
    expect(TEXTURES).toMatch(/^\s*starOutline,$/m);
  });

  it('traces both stars through one shared path, so the silhouettes cannot drift', () => {
    // `starPoint` is the vertex generator. If either bake calls it directly,
    // that bake owns a second copy of the path and the two can diverge.
    for (const name of ['star', 'starOutline']) {
      expect(bakeSource(name), `${name} should go through starPath, not starPoint`).not.toMatch(
        /starPoint\(/,
      );
      expect(bakeSource(name)).toMatch(/starPath\(g\)/);
    }
    // And exactly one place is allowed to walk the vertices.
    const pathHelper = TEXTURES.slice(TEXTURES.indexOf('const starPath ='));
    const callers = TEXTURES.match(/starPoint\(/g) ?? [];
    // Two in `starPath` (moveTo + lineTo), one in the function's own declaration.
    expect(callers).toHaveLength(3);
    expect(pathHelper).toContain('starPoint(0)');
  });

  it('strokes the outline inside the path, so it bakes to the filled star’s box', () => {
    const outline = bakeSource('starOutline');
    expect(outline).toMatch(/\.stroke\(\{[^}]*\balignment:\s*1\b/);
  });

  it('keeps the stroke thin enough to leave the star hollow', () => {
    // Taken inwards, the stroke eats the body from both sides at once, and the
    // body inside the waist is only ~13 units across. At width 4 the ☆ baked as
    // a near-solid star with a notch in it — measured at 18.0% ink against the
    // filled pip's 22.6%, where the shipped width 2 reads 11.4% against 23.8%.
    const width = /\.stroke\(\{[^}]*\bwidth:\s*([\d.]+)/.exec(bakeSource('starOutline'))?.[1];
    expect(width, 'starOutline should declare a stroke width').toBeDefined();
    expect(Number(width)).toBeLessThanOrEqual(2.5);
  });
});

describe('the station tile pips', () => {
  it('pick a texture per pip, not only a tint', () => {
    // The defect this closes: three filled stars separated by `tint` alone, at
    // 2.12:1, which is colour-alone signalling and under the 3:1 non-text
    // minimum. The tint stays — it just stops being the only signal.
    expect(CLUB_SCENE).toMatch(
      /pip\.texture\s*=\s*earned\s*\?\s*this\.textures\.star\s*:\s*this\.textures\.starOutline;/,
    );
    expect(CLUB_SCENE).toMatch(/pip\.tint\s*=\s*earned\s*\?\s*GOLD_VIP\s*:\s*INK_DISABLED;/);
  });
});
