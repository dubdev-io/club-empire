/**
 * Capture every one of the ten required states, at both review viewports.
 *
 *   npm run shots                 # dev server must already be running
 *   CLUB_URL=http://host:5173 node tools/screenshots.ts
 *
 * Design review is not deferrable: the designer asked for screenshots at
 * 390x844 and 1440x900, or a preview URL. This produces the screenshots.
 *
 * Driven over the Chrome DevTools Protocol with **no new dependency** — Node 24
 * has a global `WebSocket`, and CDP is a JSON protocol over it. A screenshot
 * harness is not worth a `puppeteer` install in a repo whose whole point is a
 * small reproducible build, and the brief is explicit about not adding
 * dependencies casually.
 *
 * Every state is reached through a **real code path**, never by faking the UI:
 *
 *  - first-run      -> `localStorage` cleared
 *  - save-corrupt   -> garbage written into the save key
 *  - offline-return -> a valid save with an old `lastSeenAt`
 *  - queue-overflow -> the Door raised without buying lanes
 *  - club-complete  -> every purchase bought, through the purchase functions
 *  - reduced-motion -> CDP media emulation, as the OS would set it
 *
 * So a screenshot that looks right is evidence the path works, not evidence
 * that a component renders.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { SAVE_STORAGE_KEY } from '../src/save/schema.ts';

const BASE_URL = process.env.CLUB_URL ?? 'http://127.0.0.1:5173';
const DEBUG_URL = process.env.CLUB_CDP ?? 'http://127.0.0.1:9222';
const OUT_DIR = process.env.CLUB_SHOTS ?? 'screenshots';

/** The design viewport, and the desktop size that must not be *broken*. */
const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, scale: 2, mobile: true },
  { name: 'desktop', width: 1440, height: 900, scale: 1, mobile: false },
] as const;

// ---------------------------------------------------------------------------
// A minimal CDP client
// ---------------------------------------------------------------------------

interface CdpTarget {
  webSocketDebuggerUrl: string;
  type: string;
  url: string;
}

class Cdp {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String((event as MessageEvent).data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (message.id === undefined) return;
      const waiter = this.pending.get(message.id);
      if (waiter === undefined) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }

  static async connect(wsUrl: string): Promise<Cdp> {
    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`cannot connect to ${wsUrl}`)), {
        once: true,
      });
    });
    return new Cdp(socket);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      // CDP has no timeout of its own, and a hung call here would hang the
      // whole script with no indication of which step stalled.
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 30_000);
    });
  }

  /** Evaluate in the page and return the JSON-serialised result. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.send<{
      result: { value?: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      );
    }
    return result.result.value as T;
  }

  close(): void {
    this.socket.close();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// The states
// ---------------------------------------------------------------------------

interface Shot {
  readonly name: string;
  /** What this proves, for the handoff note. */
  readonly note: string;
  /** Run before the page loads — seeds `localStorage`. */
  readonly seed?: string;
  /** Run after the game has booted. */
  readonly drive?: string;
  readonly reducedMotion?: boolean;
  /** Extra settle time, for states with an animation worth catching. */
  readonly settleMs?: number;
}

const FRESH = `localStorage.removeItem(${JSON.stringify(SAVE_STORAGE_KEY)});`;

/**
 * A mid-run club, as a v3 save.
 *
 * Written through `localStorage` rather than built by clicking, so the
 * offline-return shot also exercises the load-and-migrate path.
 */
function seededSave(lastSeenAt: number): string {
  const save = {
    version: 3,
    lastSeenAt,
    elapsedTicks: 4_200,
    club: {
      cash: 24_500,
      totalEarned: 180_000,
      doorLevel: 5,
      stations: [
        { key: 'tap', unlocked: true, level: 30, lanes: 3 },
        { key: 'cocktail', unlocked: true, level: 22, lanes: 2 },
        { key: 'booth', unlocked: false, level: 1, lanes: 0 },
      ],
      lastCallMeter: 0.32,
      lastCallFiredCount: 4,
      bubblesCollected: 190,
      elapsedSeconds: 420,
      purchaseCount: 58,
      completeSeen: false,
      hintBubblePending: false,
      hintStationPending: false,
    },
    settings: { audio: true, reducedMotion: 'auto', haptics: true },
  };
  return `localStorage.setItem(${JSON.stringify(SAVE_STORAGE_KEY)}, ${JSON.stringify(
    JSON.stringify(save),
  )});`;
}

const SHOTS: readonly Shot[] = [
  {
    name: '01-boot',
    note: 'boot / loading — club silhouette, spinner, progress bar',
    seed: FRESH,
    drive: `window.__clubStore.getState().setBooting(true, 0.45);`,
  },
  {
    name: '02-first-run',
    note: 'first run — empty club, pulsing ring on the first cash bubble, no modal',
    seed: FRESH,
    settleMs: 1400,
  },
  {
    name: '03-playing',
    note: 'playing — a club part-way through, bubbles on the floor, Last Call part-filled',
    seed: FRESH,
    drive: `
      window.__club.grant(40000);
      for (let i = 0; i < 18; i++) window.__clubStore.getState().actions.upgradeStation('tap');
      window.__clubStore.getState().actions.buyLane('tap');
      window.__clubStore.getState().actions.unlockStation('cocktail');
      window.__clubStore.getState().actions.upgradeDoor();
      window.__clubStore.getState().actions.upgradeDoor();
      window.__club.state().lastCallMeter = 0.56;
    `,
    settleMs: 1600,
  },
  {
    name: '04-queue-overflow',
    note: 'queue overflow — Door raised without lanes: queue at the door, warning banner, DOOR badge',
    seed: FRESH,
    drive: `window.__club.floodDoor();`,
    settleMs: 1200,
  },
  {
    name: '05-bars-sheet',
    note: 'BARS sheet — level and lane per station, served-vs-capacity, ★ progress',
    seed: FRESH,
    drive: `
      window.__club.grant(60000);
      for (let i = 0; i < 14; i++) window.__clubStore.getState().actions.upgradeStation('tap');
      window.__clubStore.getState().actions.unlockStation('cocktail');
      // Fourteen upgrades crosses Lv 10, so a 800 ms ★ fires while settle is
      // 700 ms — a race that covered the sheet in roughly half of all runs.
      // Cleared explicitly, the same way 07 and 11 already do; the ★ has its
      // own shot and does not belong on top of this one.
      window.__clubStore.getState().setStar(null);
      window.__clubStore.getState().openSheet('bars');
    `,
    settleMs: 700,
  },
  {
    name: '06-door-sheet',
    note: 'DOOR sheet — arrivals vs capacity, the min() made legible',
    seed: FRESH,
    drive: `window.__club.floodDoor(); window.__clubStore.getState().openSheet('door');`,
    settleMs: 700,
  },
  {
    name: '07-station-maxed',
    note: 'station maxed — Tap Bar at L30 ★★★, MAXED badge, attention moves on',
    seed: FRESH,
    drive: `
      window.__club.grant(1e7);
      for (let i = 0; i < 40; i++) window.__clubStore.getState().actions.upgradeStation('tap');
      window.__clubStore.getState().setStar(null);
      window.__clubStore.getState().openSheet('bars');
    `,
    settleMs: 900,
  },
  {
    name: '08-star-celebration',
    note: '★ celebration — ×2 drink price, flash and confetti, auto-dismissing',
    seed: FRESH,
    drive: `
      window.__club.grant(1e7);
      for (let i = 0; i < 8; i++) window.__clubStore.getState().actions.upgradeStation('tap');
      window.__clubStore.getState().actions.upgradeStation('tap');
    `,
    settleMs: 260,
  },
  {
    name: '09-offline-return',
    note: 'offline return — "the night carried on", capped at 10 min, COLLECT in the thumb zone',
    seed: seededSave(Date.now() - 2 * 3600_000 - 14 * 60_000),
    settleMs: 1100,
  },
  {
    name: '10-save-corrupt',
    note: 'save corrupt — readable banner and [Start fresh], never a white screen',
    seed: `localStorage.setItem(${JSON.stringify(SAVE_STORAGE_KEY)}, '{"version":3,"lastSeen');`,
    settleMs: 1100,
  },
  {
    name: '11-club-complete',
    note: 'club complete — stats, ★★★, "Phase 2: a second venue", [KEEP PLAYING]',
    seed: FRESH,
    drive: `window.__club.buyAll(); window.__clubStore.getState().setStar(null);`,
    settleMs: 900,
  },
  {
    name: '12-settings-audio-off',
    note: 'settings / audio off — the only two toggles in scope, plus a two-step reset',
    seed: FRESH,
    drive: `
      const s = window.__clubStore.getState();
      s.setSettings({ audio: false, reducedMotion: 'off', haptics: false });
      s.openSheet('settings');
    `,
    settleMs: 700,
  },
  {
    name: '13-reduced-motion',
    note: 'reduced motion — the ★ celebration as a static flash and a number, feedback not removed',
    seed: FRESH,
    reducedMotion: true,
    drive: `
      window.__club.grant(1e7);
      for (let i = 0; i < 9; i++) window.__clubStore.getState().actions.upgradeStation('tap');
      window.__clubStore.getState().actions.upgradeStation('tap');
    `,
    settleMs: 300,
  },
  {
    // Every lane bought and the Door maxed, but the stations still at Lv 7.
    // Door Lv 8 arrives at 3.225/s against 3.167/s of lane capacity, so 0.058/s
    // is turned away permanently — and the sheet's diagnosis fires on an
    // absolute threshold, so it advises "more lanes" when every `laneCost` and
    // `unlockCost` is already `null`. Captured because the fix has to be looked
    // at, not reasoned about.
    name: '14-door-dead-end',
    note: 'DOOR sheet dead end — every lane bought, levels mid-run, and it still says "more lanes"',
    seed: FRESH,
    drive: `
      const s = window.__clubStore.getState();
      window.__club.grant(1e9);
      s.actions.unlockStation('cocktail');
      s.actions.unlockStation('booth');
      for (const key of ['tap', 'cocktail', 'booth']) {
        for (let i = 0; i < 2; i++) window.__clubStore.getState().actions.buyLane(key);
      }
      for (let i = 0; i < 8; i++) window.__clubStore.getState().actions.upgradeDoor();
      for (const key of ['tap', 'cocktail', 'booth']) {
        for (let i = 0; i < 6; i++) window.__clubStore.getState().actions.upgradeStation(key);
      }
      window.__clubStore.getState().setStar(null);
      window.__clubStore.getState().openSheet('door');
    `,
    settleMs: 900,
  },
  {
    // The same dead end at full build-out, with the completion card dismissed
    // so the sheet is readable. This is the state the player is left in
    // forever, so it is the one the end-state copy has to be judged on.
    name: '15-door-full-buildout',
    note: 'DOOR sheet after club complete — the permanent 0.06/s residual, nothing left to buy',
    seed: FRESH,
    drive: `
      window.__club.buyAll();
      const s = window.__clubStore.getState();
      s.setShowComplete(false);
      s.setStar(null);
      s.openSheet('door');
    `,
    settleMs: 900,
  },
  {
    // Second zero of a brand-new save, which is the state 14 and 15 do not
    // cover: 0.90/s arriving against 0.50/s served, so the `min()` binds and
    // 44% of guests are turned away — below `QUEUE_WARNING_SHARE`, which is why
    // the HUD banner and the DOOR badge both stay quiet here. The sheet used to
    // be the only surface that went amber, on the first screen of every run,
    // for a lane the player cannot afford for another three and a half minutes.
    name: '16-door-fresh',
    note: 'DOOR sheet on a fresh club — the min() already binds at 44%, below the alarm threshold',
    seed: FRESH,
    drive: `window.__clubStore.getState().openSheet('door');`,
    settleMs: 700,
  },
];

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function pageTarget(): Promise<string> {
  const response = await fetch(`${DEBUG_URL}/json/list`);
  const targets = (await response.json()) as CdpTarget[];
  const page = targets.find((t) => t.type === 'page');
  if (page === undefined) throw new Error('no page target; is Chrome running with --remote-debugging-port?');
  return page.webSocketDebuggerUrl;
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const cdp = await Cdp.connect(await pageTarget());
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });

  const manifest: { viewport: string; name: string; note: string; file: string }[] = [];

  for (const viewport of VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.scale,
      mobile: viewport.mobile,
    });

    for (const shot of SHOTS) {
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [
          { name: 'prefers-reduced-motion', value: shot.reducedMotion === true ? 'reduce' : 'no-preference' },
        ],
      });

      // Seed on the no-boot page, then navigate to the real one.
      //
      // Seeding on a page with a running game does not work: navigating away
      // fires `pagehide`, the outgoing game writes its own save, and the seed
      // is overwritten before the next load reads it. That is not a theory —
      // it is how the offline-return shot came out showing the club from the
      // shot before it.
      await cdp.send('Page.navigate', { url: `${BASE_URL}/?noboot=1` });
      await sleep(400);
      if (shot.seed !== undefined) await cdp.evaluate(`${shot.seed} return true;`);

      await cdp.send('Page.navigate', { url: `${BASE_URL}/` });

      // Wait for the runtime rather than a fixed delay: the boot shot
      // deliberately catches the loading state, and everything else needs the
      // canvas up.
      const needsRuntime = shot.name !== '01-boot';
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await sleep(100);
        const ready = await cdp
          .evaluate<boolean>(
            `return Boolean(window.__clubStore) && (${String(!needsRuntime)} || Boolean(window.__club));`,
          )
          .catch(() => false);
        if (ready) break;
      }

      if (shot.drive !== undefined) await cdp.evaluate(`${shot.drive} return true;`);
      await sleep(shot.settleMs ?? 400);

      const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      });

      const file = `${viewport.name}-${shot.name}.png`;
      await writeFile(`${OUT_DIR}/${file}`, Buffer.from(data, 'base64'));
      manifest.push({ viewport: viewport.name, name: shot.name, note: shot.note, file });
      console.log(`  ${viewport.name.padEnd(8)} ${shot.name.padEnd(22)} -> ${file}`);
    }
  }

  await writeFile(`${OUT_DIR}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  cdp.close();
  console.log(`\n${manifest.length} screenshots in ${OUT_DIR}/`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
