# Credits

Every asset shipped in the bundle is listed here with its licence, author and
source URL, recorded at the moment it is added (DUB-5 acceptance criterion 12).

The design brief permits non-commercial licences **because the game is private
and unpublished**. That permission only stays auditable if this file is
complete, so no asset lands without a row here.

## Art

| Asset | Licence | Author | Source |
| --- | --- | --- | --- |
| `public/favicon.svg` | Original work for this project — no third-party licence | dubdev.io (Game Developer) | Authored in-repo; three primitives in the §10 tokens `--bg-room`, `--neon-cyan`, `--neon-magenta` |
| Every sprite in the club (`src/render/textures.ts`) | Original work for this project — no third-party licence | dubdev.io (Game Developer) | Generated at runtime. No image file exists: each shape is a PixiJS `Graphics` path rasterised once at boot into a white texture and coloured with `tint`. Guests, bartenders, bottles, the dance floor, the cash bubble, the ★ pips, the padlock, the dotted outline, the crowd silhouette and the light glow are all built this way. |

**There is no atlas, and no image bytes ship at all.** The brief budgeted ~660 KB
for one; this spends none of it. Nothing here is traced from, derived from or
inspired by a shipped game — the shapes are circles, rounded rectangles, a
five-pointed star and a triangle.

## Audio

| Asset | Licence | Author | Source |
| --- | --- | --- | --- |
| Every sound (`src/game/audio.ts`) | Original work for this project — no third-party licence | dubdev.io (Game Developer) | Synthesised at runtime with the Web Audio API. No audio file exists: the kick, hat, bassline, coin, upgrade blip, ★ arpeggio and the Last Call filter sweep are oscillators and envelopes built in code when the player first touches the screen. |

**No audio bytes ship either.** The brief budgeted ~720 KB; this spends none of
it. No sample, loop or stem from any source, free or otherwise.

## Fonts

None. Phase 1 is system-stack only (§10) — no webfont, so nothing to credit.

## Summary

Total third-party asset bytes in the bundle: **zero**. Every visual and audible
element is generated in code in this repository. Nothing is licensed from
anywhere, so there is nothing whose licence could become a problem if the game
is ever published — the non-commercial permission the brief grants has not been
used.

If that ever changes, add the row *in the same commit* that adds the asset.
