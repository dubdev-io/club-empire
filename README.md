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

**`npm run build` sets Vite's `base` to `/club-empire/`**, the GitHub Pages
project subpath — without it every asset 404s under that path. The dev server
is unaffected and still serves from `/`. `CLUB_EMPIRE_BASE` overrides both, for
a host that serves from the root:

```bash
CLUB_EMPIRE_BASE=/ npm run build
```

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

| chunk            | raw        | gzipped    | fetched on a normal load |
| ---------------- | ---------- | ---------- | ------------------------ |
| pixi             | 511.7 kB   | 145.4 kB   | yes                      |
| react            | 218.8 kB   | 68.3 kB    | yes                      |
| app              | 66.1 kB    | 20.5 kB    | yes                      |
| rolldown-runtime | 0.7 kB     | 0.4 kB     | yes                      |
| CSS              | 17.5 kB    | 3.6 kB     | yes                      |
| index.html       | 2.9 kB     | 1.3 kB     | yes                      |
| **normal load**  | **818 kB** | **239 kB** |                          |
| overlay          | 8.1 kB     | 3.6 kB     | **no — `?debug=1` only** |

**239 kB transferred against the 4 MB hard ceiling** — 5.8% of it. The only
file in `dist/` that is not code is a 237-byte favicon: every sprite is a
PixiJS path rasterised at boot and every sound is a Web Audio oscillator, so
the ~660 kB atlas and ~720 kB audio the brief budgeted are both unspent. See
`CREDITS.md`.

The `overlay` chunk is not in the `modulepreload` list and is never requested
without the flag. Checked rather than assumed: `dist/` served under
`/club-empire/` and loaded in Chrome at 390x844, the request log for a
flag-free load contains no `overlay-*.js` and `document.querySelectorAll('.ce-debug')`
is empty. See the next section.

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

Being dev-only is exactly why these cannot carry a device measurement: Vite
eliminates every one of them from `dist`, so a published build has none of
them. `?debug=1` and `?debug=1&stress=1` below are the two routes that survive
into production, and they are the ones QA and the owner use.

## Measured against the acceptance criteria

| Criterion | Measured | How |
| --- | --- | --- |
| 1 — economy within ±20% | 13/13 rows | `npm run sim:autobuy` |
| 8 — frame budget | CPU-side 0.73 ms avg / 1.21 ms p95 of 16.6 ms, at 30 guests + 9 bartenders + 4 queues | `npm run measure:frames` |
| 9 — ≤ 4 MB transferred | 239 kB gzipped | `npm run build` |
| 12 — asset licences | zero third-party assets | `CREDITS.md` |

Criterion 8's **GPU side is unverified**: this container has no GPU, WebGL runs
on SwiftShader, and no honest fps number for a Pixel 6a can come from here. The
CPU-side figure is the half that does transfer.

## Measuring the frame rate — `?debug=1`

Add `?debug=1` to any build, dev or published, and a read-out appears in the
top-left corner. It works the same on the deployed URL as on the dev server,
because the number that matters is the one off a real phone.

```
https://<host>/club-empire/?debug=1            # the overlay, normal play
https://<host>/club-empire/?debug=1&stress=1   # the overlay, DUB-6 C1 scene
```

**Without the flag it costs nothing.** The overlay is loaded by a dynamic
`import()` that only runs when `debug=1` is present, so it is its own chunk, it
is not preloaded, and the browser never fetches it in normal play. No DOM node,
no listener and no `requestAnimationFrame` hook exists without the flag.

While a measurement is running the panel is transparent to touch — only its two
buttons take a tap — so cash bubbles underneath it are still tappable. It does
cover the HUD's cash and Last Call readouts, which is the trade for keeping it
clear of everything below.

### Fields

QA reads these off the overlay for the DUB-6 C1 frame-budget numbers. **The
names are a contract: do not rename one without saying so on DUB-6.**

| field                 | meaning                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `build`               | short commit SHA, substituted at build time; `dev` on the dev server  |
| `scene`               | `normal`, or `stress` under `stress=1`                                |
| `state`               | `live`, or `FROZEN` after a 60 s run or a copy                        |
| `date` / `time`       | when the reading was taken, UTC                                       |
| `fps`                 | frames in the trailing 1 s                                            |
| `fps_p1_worst`        | the slowest 1% of frames in the window, as fps (the p99 frame time)   |
| `frame_ms_mean`       | mean wall time between frames, over the window                        |
| `frame_ms_max`        | the single worst frame in the window                                  |
| `refresh_cap_hz`      | highest `fps` seen — says whether iOS capped at 120, 60, or 30 (Low Power Mode) |
| **`busy_pct`**        | **main-thread busy ms per second of wall clock, as a percentage. DUB-6's gating figure** |
| `busy_ms_per_s`       | the same figure unnormalised, for arithmetic                          |
| `busy_window_s`       | wall clock the duty cycle was measured over                           |
| `draw_calls`          | `gl.draw*` calls in the last frame; `n/a` if the context is not WebGL |
| `guests_rendered`     | dancers plus every queued guest. §11 caps this at 30                  |
| `bartenders_rendered` | visible bartenders — one per owned lane on an open station            |
| `queues_rendered`     | queues with at least one guest: the three bars and the door           |
| `particles_rendered`  | `particles_canvas` + `particles_dom`. §11 caps this at 60             |
| `particles_canvas`    | transient Pixi sprites — cash bubbles, VIP rings, the hint ring       |
| `particles_dom`       | confetti `<span>`s in the React layer. Max 12, 0 under reduced motion |
| `dpr`                 | `window.devicePixelRatio`                                             |
| `canvas_px`           | canvas backing-store size. A 3x phone draws ~9x the pixels of a 1x one |
| `canvas_css`          | canvas CSS size                                                       |
| `heap_mb`             | `performance.memory` — **Chrome only, `n/a` on Safari**, never guessed |
| `elapsed_s`           | time in the current measurement window                                |
| `window_frames`       | frames sampled in the window                                          |
| `sim_ms_p95` …        | per-system p95 from `FrameProbe` — which system spent the budget      |

Four of these need a note.

**`busy_pct` is the one to gate on, not `fps`.** QA measured the container
frame rate moving 3.4x on `deviceScaleFactor` alone with the build held
constant, so it cannot carry a build-to-build regression signal. The sim is
fixed-step at 10 Hz with catch-up, so work per frame is proportional to frame
duration by construction and work per wall-clock second is the invariant. DUB-6
gates at **≤ 18 % at 1x and ≤ 72 % at 4x**, with a 1.3x regression gate on the
duty cycle. `fps` stays on the overlay because on the owner's iPhone it is a
real device number and that is the whole point of DUB-9 — but it only means
something read next to `dpr` and `canvas_px`.

"Start 60 s measurement" resets the duty-cycle window too, so `busy_pct` and
`fps` in one report always describe the same stretch of time. The window closes
at the last rendered frame rather than at the moment you read it, so the figure
does not drift while the panel sits frozen.

`dpr` and `canvas_px` will disagree on a 3x phone, and that is correct:
`createStage` caps the renderer resolution at 2 (see "Performance rules this
code follows"). On a 390x844 iPhone at `dpr 3.00` the backing store is
`780x1688`, not `1170x2532` — so the GPU is being asked for 4x the CSS pixels,
not 9x. Both numbers are on the overlay precisely so a reader can see the cap
rather than assume it.

**`particles_rendered` is split across two renderers, which is why there are
three fields.** Phase 1 has no Pixi particle emitter: `particles_canvas` is
just the cash bubbles, their VIP rings and the hint ring, and tops out at about
4. The star-celebration confetti is not canvas at all — it is twelve
CSS-animated `<span>`s in the React overlay layer, so `particles_dom` is what
counts it and a GL-side probe reads zero for it even mid-celebration. Checking
§11's 60-particle cap against the canvas alone is a false pass, which is
exactly what happened on DUB-6. Both halves are counted, never estimated,
because QA cross-checks these against an independent GL index-count probe.

The day a Pixi emitter *is* added, only `particles_canvas` moves — that is the
reason the breakdown is on the overlay rather than folded into one number.

### The two buttons

- **Start 60 s measurement** — resets the window, collects for 60 s, then
  freezes so the numbers can be read with the phone on the table.
- **Copy report** — writes the whole block to the clipboard, inside the tap
  handler (iOS Safari refuses a clipboard write after an `await`). It also
  freezes the panel and makes the on-screen text selectable, because clipboard
  permission on iOS fails quietly and the fallback has to be the real text.

### `stress=1` — the certification scene

`?debug=1&stress=1` boots straight into the scene DUB-6's criterion C1 is
specified at: **25 guests, 9 bartenders, 3 queues**. Same state on every load —
all three bars open with three lanes each and the Door at L8, the Booth one
level short of maxed so the next-purchase outline is still drawn, cash at 0, a
fixed RNG seed, and the crowd pinned at four guests per bar queue plus thirteen
dancers.

`stress=1` is only honoured alongside `debug=1`, and the stress scene **never
reads or writes `localStorage`** — opening it on the phone you also play on
cannot cost you your club.

The club state and the crowd arithmetic are covered by
`src/game/stressScene.test.ts`. The sprite side cannot be: `ClubScene` needs a
WebGL context and the tests run on node. So it was checked by loading the
**built** bundle twice in Chrome at 390x844 and reading the overlay back:

```
guests_rendered 25   bartenders_rendered 9   queues_rendered 3   draw_calls 9
```

— identical on both loads, which is the determinism the preset is for. 9 draw
calls for a late-game floor is the batching holding: every sprite shares one
generated texture. The one number that still has to come off real silicon is
the frame rate itself.

## Publishing

`.github/workflows/pages.yml` runs `npm ci`, typecheck, tests and build, then
deploys `dist/` to GitHub Pages.

**https://dubdev-io.github.io/club-empire/**

```
https://dubdev-io.github.io/club-empire/?debug=1            # the overlay
https://dubdev-io.github.io/club-empire/?debug=1&stress=1   # the C1 scene
```

Pages was refused when the workflow was first written — `POST /repos/dubdev-io/club-empire/pages`
returned `422 {"message":"Your current plan does not support GitHub Pages for
this repository."}`, because the repo was private and the org's plan allows
Pages on public repos only. The repo has since been made public, the same call
returns 201, and the site is enabled.

One wrinkle while the review is in flight: `main` is still the empty initial
commit, because the game lives in a stack of open PRs. So the workflow also
deploys `DUB-9-debug-overlay` directly, to give DUB-8 a URL before the stack
merges. **That branch trigger is scaffolding and should be deleted at merge** —
it is marked as such in the workflow.

`vite.config.ts` sets `base` to `/club-empire/` for builds only, so the dev
server keeps serving from `/`. Override with `CLUB_EMPIRE_BASE` to host
somewhere else.
