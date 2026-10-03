# Club Empire — technical shell

Portrait browser idle game: a nightclub tycoon. **This repository currently
contains no gameplay.** It is the technical foundation the game loop will run
on — canvas, UI layering, a frame-rate-independent simulation tick, versioned
saves, and offline time. The design brief (DUB-2) owns the economy formulas.

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
  game/
    runtime.ts          ← the one requestAnimationFrame loop lives here
  sim/                  pure logic, no DOM, no Pixi — all of it unit-tested
    constants.ts        tick rate, catch-up clamp, design size, autosave cadence
    fixedStepLoop.ts    ← THE SIMULATION TICK
    economy.ts          placeholder economy state and its one-tick step
    offline.ts          elapsed-time-since-last-seen, clamped and sign-safe
  save/
    schema.ts           save versions, validation, migration chain
    storage.ts          localStorage read/write that never throws
  state/
    store.ts            Zustand store — the UI's read model
  render/
    stage.ts            Pixi app, design-size scaling, safe-area, resize
    clubFloor.ts        placeholder scene; pooled, allocation-free
    textures.ts         programmer art generated at boot (no asset files)
    safeArea.ts         reads env(safe-area-inset-*) as numbers
  ui/                   React: every panel, counter and button is DOM
  styles/global.css     layering, safe-area variables, mobile scroll locks
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

| chunk           | raw       | gzipped   |
| --------------- | --------- | --------- |
| pixi            | 511.7 kB  | 145.4 kB  |
| react           | 218.9 kB  | 68.3 kB   |
| app             | 13.1 kB   | 5.1 kB    |
| rolldown-runtime| 0.7 kB    | 0.4 kB    |
| **total JS**    | **744 kB**| **219 kB**|

Plus 2.3 kB CSS (0.95 kB gzipped) and a 0.2 kB favicon. Budget for this stage is
300 kB gzipped. The only asset file is the favicon — the placeholder art is
generated at runtime.

`npm run build` emits **no sourcemaps**: they were 3.4 MB of host payload and
published readable source for no benefit to the player. Use `npm run build:debug`
(`CLUB_EMPIRE_SOURCEMAP=true`) when you need a readable stack trace off a real
device; that build is ~4.0 MB on disk and must not be the one that gets hosted.

## Dev-only helper

In a dev build, `window.__clubDebug()` returns the current stage layout
(screen size, resolution, world transform). It is stripped from production.
