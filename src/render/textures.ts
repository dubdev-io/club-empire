import { Graphics, type Renderer, type Texture } from 'pixi.js';

/**
 * Programmer art, generated at boot.
 *
 * Every sprite in the shell comes from one of these two white textures and is
 * coloured with `tint`. White-plus-tint means every sprite shares a texture,
 * so Pixi can put the whole club floor into a single batched draw call — the
 * thing mobile GPUs actually care about. It also means zero asset bytes: no
 * downloaded or purchased art in this repo.
 */
export interface GeneratedTextures {
  /** 1x1 white pixel. Scaled into rectangles for floors, walls and bars. */
  readonly block: Texture;
  /** 32px white disc. Guests, lights, the DJ. */
  readonly disc: Texture;
  destroy(): void;
}

export function createTextures(renderer: Renderer): GeneratedTextures {
  const blockSource = new Graphics().rect(0, 0, 8, 8).fill(0xffffff);
  const discSource = new Graphics().circle(16, 16, 16).fill(0xffffff);

  const block = renderer.generateTexture({ target: blockSource, resolution: 1 });
  const disc = renderer.generateTexture({ target: discSource, resolution: 2 });

  blockSource.destroy();
  discSource.destroy();

  return {
    block,
    disc,
    destroy: () => {
      block.destroy(true);
      disc.destroy(true);
    },
  };
}
