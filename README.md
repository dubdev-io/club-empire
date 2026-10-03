# Club Empire

Portrait browser idle game: a nightclub tycoon. Phase 1 is playable — one club,
three bar stations, serving lanes, the door, cash bubbles, Last Call, queues,
save/load and offline earnings.

**The one rule the whole design rests on:**

```
income/s = SUM over stations [ min(guests routed to it, lanes / serveTime) * drinkPrice(level) ]
```

Station level buys cash per guest; lanes and the door buy guests per second. The
`min()` couples them, and when it binds a **queue** appears on the floor — at
the bar, or at the door. That queue is the entire tutorial: it tells the player
which half of the product to spend on without a word of text. There is exactly
one implementation of the rule (`computeFlow` in `src/config/economy.ts`), and
the queues drawn on the canvas are read off it rather than approximated, so the
picture and the economy cannot disagree.

## Install, run, build

Requires Node 20 or newer.

```bash
# 1. Install — reproducible, from package-lock.json
npm ci

# 2. Run the dev server — http://localhost:5173, hot reload
npm run dev

# 3. Build — static production output into dist/
npm run build

# ...and to check the built output locally — http://localhost:4173
npm run preview
```

Quality gates:

```bash
npm run typecheck   # tsc --noEmit, strict
npm run lint        # eslint, type-aware
npm test            # vitest run
```

Verification tools:

```bash
npm run sim:economy      # the economy MODEL against the §4.4 table (DUB-4)
npm run sim:autobuy      # the SHIPPING game against the same table
node tools/autobuy.ts --tap   # ...with a player collecting every bubble

npm run shots            # all ten states at 390x844 and 1440x900
npm run measure:frames   # per-system frame time at the §11 entity ceiling
```

`sim:economy` and `sim:autobuy` read the same table from `src/config/pacing.ts`.
The first runs a closed-form model, the second runs the real `ClubState` through
the real purchase functions — so a divergence between the signed-off model and
the shipping game shows up as two different sets of numbers rather than as two
tools that both pass.

`shots` and `measure:frames` need a dev server and a headless Chrome with remote
debugging:

```bash
npm run dev &
google-chrome --headless=new --remote-debugging-port=9222 --no-sandbox \
  --enable-unsafe-swiftshader about:blank &
```

The production build is static files in `dist/`. There is no backend, no
server and no database.

### Viewing it as a phone

The design size is **390×844 portrait**. In desktop Chrome, open DevTools →
device toolbar → iPhone 14 (390×844). The canvas scales uniformly from the
design size, so any other viewport is letterboxed rather than stretched.

## Layout

```
index.html              #game-root (Pixi canvas) + #ui-root (React), layered
src/
  main.tsx              entry: mounts React, then boots the Pixi runtime
  config/
    economy.ts          ← THE ONE CONFIG MODULE: every balance number, and the min()
    pacing.ts           the §4.4 table, shared by both verification tools
  game/
    runtime.ts          ← the one requestAnimationFrame loop lives here
    audio.ts            every sound, synthesised — no audio files
    frameProbe.ts       per-system frame timing, allocation-free
  sim/                  pure logic, no DOM, no Pixi — all of it unit-tested
    constants.ts        tick rate, catch-up clamp, design size, autosave cadence
    fixedStepLoop.ts    ← THE SIMULATION TICK
    clubState.ts        ← THE CLUB: mutable state, purchases, bubbles, Last Call
    offline.ts          elapsed-time-since-last-seen, clamped and sign-safe
    offlineEarnings.ts  the §5 rule: 50%, capped at 10 min, no doubling
  save/
    schema.ts           save versions, validation, migration chain
    storage.ts          localStorage read/write that never throws
  state/
    store.ts            Zustand store — the UI's read model, split fast/structural
  render/
    stage.ts            Pixi app, design-size scaling, safe-area, resize
    layout.ts           where everything is, in 390x844 design space
    clubScene.ts        ← THE FLOOR: pooled, allocation-free, reads ClubFlow
    palette.ts          the §10 tokens as ints, checked against tokens.css
    textures.ts         every sprite, generated at boot — no asset files
    safeArea.ts         reads env(safe-area-inset-*) as numbers
  ui/                   React: every panel, counter, sheet and card is DOM
  styles/
    tokens.css          ← THE §10 DESIGN TOKENS. No colour literal lives elsewhere
    global.css          layering, safe-area variables, mobile scroll locks
tools/
  economy-sim.ts        the economy model vs the §4.4 table
  autobuy.ts            the shipping game vs the §4.4 table (criterion 1)
  screenshots.ts        all ten states, both viewports, over CDP
  frametime.ts          per-system frame time at the §11 ceiling (criterion 8)
```

## Where the balance numbers live

**`src/config/economy.ts`** — all of them, and nothing else does. Prices, costs,
growth rates, the guest mix, Last Call, offline earnings, the design-side entity
caps. Every value is the one verified in DUB-4 against the §4.4 pacing table.

`src/sim/constants.ts` is the only other constants file and the split is strict:
`config/economy.ts` changes how the game **plays**, `sim/constants.ts` changes how
it **runs** (tick rate, catch-up clamp, design size, autosave cadence).

That module also owns the throughput rule the whole design rests on:

```
income/s = SUM over stations [ min(guests routed, lanes / serveTime) * drinkPrice(level) ]
```

Station level buys cash per guest; lanes and the Door buy guests per second. The
`min()` couples them, and it is why a queue at the bar means "buy a lane" and a
queue at the door means "buy the Door". `src/config/economy.test.ts` has tests
whose only job is to fail if that `min()` is ever simplified away.

`tools/economy-sim.ts` imports from this module rather than keeping its own copy,
so the model that was signed off and the game that ships cannot drift apart:

```
npm run sim:economy        # exits non-zero if any §4.4 row falls outside ±20%
```

**After changing any number in `config/economy.ts`, run that.** It currently
reports 13/13 rows passing and club complete at 11,783/s.

## Where the simulation tick lives

**`src/sim/fixedStepLoop.ts`**, driven from `src/game/runtime.ts`.

`requestAnimationFrame` does exactly two things: hand the frame delta to
`FixedStepLoop.advance()`, and render. Every economy mutation happens inside
`advance()`, in whole 100 ms steps (10 ticks/second). Nothing downstream can
make income depend on frame rate.

Two details are load-bearing and should not be "simplified" away:

1. **Ticks are derived by division, not repeated subtraction.** The textbook
   accumulator (`while (acc >= step) { acc -= step; tick(); }`) drifts. It was
   measured here losing a tick — 599 instead of 600 over 60 simulated seconds
   at 120 fps, while 30 fps got all 600. The tick count now comes from
   `floor(total / tickMs)`.
2. **The running total is a compensated (Kahan–Babuška–Neumaier) sum**, so the
   total does not accumulate its own error over a long session.

`src/sim/fixedStepLoop.test.ts` locks this down at 30/60/90/120/144 fps over
600 simulated seconds, plus a jittery-frame case.

Render smoothness comes from `loop.alpha` — the fraction of the way to the
next tick — which `ClubFloor.render()` uses to interpolate sprite positions.
Motion stays smooth at high frame rates without motion *speed* depending on
them.

## Saves

`localStorage` key `club-empire:save`, written every 15 s and on
`visibilitychange` (the only reliable "app is going away" signal on mobile;
iOS does not fire `beforeunload` on app switch).

Every save carries its own `version`. On load, `src/save/schema.ts` validates
the shape field by field, then applies migrations one version at a time.
Anything it cannot handle is discarded and the game starts fresh — it never
throws. A save from a *newer* version is refused but left on disk, because the
player may simply have a stale bundle cached.

To add a schema version: add the new `SaveVN` interface, bump
`CURRENT_SAVE_VERSION`, add `migrations[N-1]`, and extend `validateSave`.

## Offline time

`src/sim/offline.ts` reports elapsed real time since `lastSeenAt`, clamped to
a maximum (default 8 h) and never negative — a device clock moved backwards
reports `0` with `clockWentBackwards: true`. It deliberately does **not**
convert time into money; that formula belongs to the design brief.

## Performance rules this code follows

- **16.6 ms frame budget**, measured on a mid-range Android, not a desktop.
- **No allocation in the update loop.** `FixedStepLoop.advance`,
  `stepEconomy`, `ClubFloor.tick` and `ClubFloor.render` allocate nothing:
  positions live in `Float32Array`s, sprites come from a pool sized at boot,
  and the UI snapshot is one reused object.
- **One draw batch for the floor.** Every sprite shares one generated white
  texture and differs only by `tint`.
- **Device pixel ratio capped at 2.** A 3x ratio triples fill-rate cost for a
  difference nobody can see on a phone.
- **Input is handled on `pointerdown`,** never behind a tween — a tap changes
  the screen in the frame it arrives.

## Bundle size

Production JS, gzipped (`npm run build`):

| chunk            | raw        | gzipped    |
| ---------------- | ---------- | ---------- |
| pixi             | 511.7 kB   | 143.7 kB   |
| react            | 218.8 kB   | 67.5 kB    |
| app              | 62.5 kB    | 19.2 kB    |
| rolldown-runtime | 0.7 kB     | 0.5 kB     |
| CSS              | 17.4 kB    | 3.6 kB     |
| index.html       | 2.9 kB     | 1.3 kB     |
| **total**        | **814 kB** | **236 kB** |

**236 kB transferred against the 4 MB hard ceiling** — 5.8% of it. The only
file in `dist/` that is not code is a 237-byte favicon: every sprite is a
PixiJS path rasterised at boot and every sound is a Web Audio oscillator, so
the ~660 kB atlas and ~720 kB audio the brief budgeted are both unspent. See
`CREDITS.md`.

`npm run build` emits **no sourcemaps**: they were 3.4 MB of host payload and
published readable source for no benefit to the player. Use `npm run build:debug`
(`CLUB_EMPIRE_SOURCEMAP=true`) when you need a readable stack trace off a real
device; that build is ~4.0 MB on disk and must not be the one that gets hosted.

## Dev-only helpers

Stripped from the production bundle by `import.meta.env.DEV`, so the shipping
game has no way to set its own cash.

| Call | What it does |
| --- | --- |
| `window.__clubDebug()` | Current stage layout: screen size, resolution, world transform |
| `window.__club.state()` | The live `ClubState` |
| `window.__club.frames()` | Per-system frame-time distribution (p95, not mean) |
| `window.__club.benchTick()` | Isolated cost of one sim tick and one scene tick |
| `window.__club.stress()` | Pin the scene at the §11 ceiling: 30 guests, 9 bartenders, every queue full |
| `window.__club.autoBuy()` | Buy the cheapest purchase as soon as it is affordable |
| `window.__club.buyAll()` | Jump straight to full build-out, through the real purchase functions |
| `window.__club.floodDoor()` | Raise the Door without lanes, to force the queue-overflow state |
| `window.__club.grant(n)` | Add cash |
| `window.__clubStore` | The Zustand store, for driving UI states by hand |
| `?noboot=1` | Load the page without starting the game, so storage can be seeded |

## Measured against the acceptance criteria

| Criterion | Measured | How |
| --- | --- | --- |
| 1 — economy within ±20% | 13/13 rows | `npm run sim:autobuy` |
| 8 — frame budget | CPU-side 0.73 ms avg / 1.21 ms p95 of 16.6 ms, at 30 guests + 9 bartenders + 4 queues | `npm run measure:frames` |
| 9 — ≤ 4 MB transferred | 236 kB gzipped | `npm run build` |
| 12 — asset licences | zero third-party assets | `CREDITS.md` |

Criterion 8's **GPU side is unverified**: this container has no GPU, WebGL runs
on SwiftShader, and no honest fps number for a Pixel 6a can come from here. The
CPU-side figure is the half that does transfer.
