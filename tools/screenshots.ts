/**
 * Capture every one of the required states, at the review viewports.
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
import { Cdp, pageTarget, sleep } from './cdp.ts';

const BASE_URL = process.env.CLUB_URL ?? 'http://127.0.0.1:5173';
const OUT_DIR = process.env.CLUB_SHOTS ?? 'screenshots';

interface Viewport {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly mobile: boolean;
  /**
   * The shape to seed, load and drive the state in, before turning to
   * `width`x`height` for the capture.
   *
   * Only `landscape` needs this, and it needs it because of what landscape
   * *is* in this game: `App.tsx` returns `RotatePrompt` above everything else,
   * so at 844x390 there is no HUD, no bottom bar and no Settings sheet to
   * reach into. A shot that depends on a setting has to set it in portrait
   * first and then turn the phone — which is also the only order a player can
   * do it in.
   */
  readonly reachedAt?: { readonly width: number; readonly height: number };
}

/**
 * The design viewport, the desktop size that must not be *broken*, and a phone
 * on its side.
 *
 * `landscape` is 390x844 turned, which is exactly the shape `ROTATE_QUERY`
 * (`(min-aspect-ratio: 1/1) and (max-height: 599px)`) is written for — short
 * and wide, where the portrait layout cannot be shown and the prompt is the
 * only honest answer. It is deliberately **not** run against the full state
 * list: every state renders the same rotate prompt there, so twenty identical
 * screenshots would cost minutes and prove one thing. Shots opt in by name
 * (see `Shot.viewports`), and only the two rotate-prompt shots do.
 */
const VIEWPORTS: readonly Viewport[] = [
  { name: 'mobile', width: 390, height: 844, scale: 2, mobile: true },
  { name: 'desktop', width: 1440, height: 900, scale: 1, mobile: false },
  {
    name: 'landscape',
    width: 844,
    height: 390,
    scale: 2,
    mobile: true,
    reachedAt: { width: 390, height: 844 },
  },
];

/** Where a shot is captured unless it says otherwise: the two review sizes. */
const REVIEW_VIEWPORTS = ['mobile', 'desktop'] as const;

/**
 * How long to wait after turning the viewport, before capturing.
 *
 * `useLandscape` goes through a `matchMedia` change event into React state, so
 * the prompt is a render behind the metrics override; and the glyph's own 2s
 * loop needs a moment to be running rather than at its first frame.
 */
const TURN_SETTLE_MS = 700;

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
  /**
   * Which viewports this state is worth capturing at. Defaults to the two
   * review sizes; `['landscape']` is the opt-in for a state that only exists
   * with the phone on its side.
   */
  readonly viewports?: readonly string[];
  /**
   * Checked in the page immediately before the shutter, with the viewport
   * already turned. Throws to fail the run; otherwise returns a short line
   * that is logged beside the filename.
   *
   * Only worth it where the thing being photographed is hard to read *off* the
   * photograph. A frozen glyph and a glyph caught at 0° on its way round look
   * identical in a PNG, so `26-rotate-prompt-still` would pass silently if the
   * fix regressed — the one shot whose whole job is to show the fix. Reading
   * `animationPlayState` is what makes it a check rather than a picture.
   */
  readonly expect?: string;
}

const FRESH = `localStorage.removeItem(${JSON.stringify(SAVE_STORAGE_KEY)});`;

/**
 * Hold a finger on the first `.cta` whose label starts with `prefix`.
 *
 * A real `pointerdown`, dispatched at the element React delegates from, so the
 * captured press is the button's own state. Deliberately never followed by a
 * `pointerup`: the state has to survive until the screenshot, which is also
 * what a finger resting on the glass does.
 *
 * Interpolated into a `drive` as `setTimeout(${PRESS_CTA}('...'), 400)` because
 * the sheet it reaches into is opened by that same `drive` and React has not
 * committed it yet.
 */
const PRESS_CTA = `((prefix) => () => {
  const button = [...document.querySelectorAll('.cta')].find(
    (el) => (el.querySelector('.cta__label')?.textContent ?? '').startsWith(prefix),
  );
  if (!button) throw new Error('no .cta labelled ' + prefix);
  button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, isPrimary: true }));
})`;

/**
 * Flip a Settings toggle by its label, through the control a player taps.
 *
 * `setSettings` would be shorter and would miss the point. DUB-49 was two
 * sources of truth for reduced motion that disagreed, and the row that failed —
 * toggle `on`, OS preference unset — cannot be reached by CDP media emulation
 * at all. The toggle has to be the thing that moves, and it has to move the way
 * a thumb moves it: `Toggle` fires on `pointerdown`.
 *
 * Interpolated into a `drive` the same way `PRESS_CTA` is, because the Settings
 * sheet it reaches into is opened by that same `drive`.
 */
const TAP_TOGGLE = `((label) => () => {
  const toggle = [...document.querySelectorAll('.toggle')].find(
    (el) => (el.querySelector('.toggle__label')?.textContent ?? '') === label,
  );
  if (!toggle) throw new Error('no .toggle labelled ' + label);
  toggle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, isPrimary: true }));
})`;

/**
 * Read the rotate prompt's glyph — is it there, and is it moving?
 *
 * The angle comes out of the computed `transform` via `DOMMatrixReadOnly`
 * rather than off the string, because a running animation reports an
 * interpolated matrix and `rotate(0deg)` reports `none`. Both have to be
 * comparable, since "upright" is the assertion.
 *
 * Interpolated into an `expect`, where it runs with the viewport already
 * turned.
 */
const READ_GLYPH = `(() => {
  const glyph = document.querySelector('.fatal__rotate-glyph');
  if (!glyph) {
    throw new Error('no rotate prompt at ' + window.innerWidth + 'x' + window.innerHeight);
  }
  const style = getComputedStyle(glyph);
  const m = new DOMMatrixReadOnly(style.transform === 'none' ? 'matrix(1,0,0,1,0,0)' : style.transform);
  return {
    root: document.documentElement.className,
    animation: style.animationName,
    playState: style.animationPlayState,
    degrees: Math.round((Math.atan2(m.b, m.a) * 180) / Math.PI),
    viewport: window.innerWidth + 'x' + window.innerHeight,
  };
})`;

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
    // The same dead end one sheet over. Every lane bought with the stations at
    // Lv 7, so all three cards are saturated with no lane left to buy — the
    // state where the old line said "Add a lane" directly above a row reading
    // "3 LANES". Reachable mid-run, which is why it is captured apart from the
    // full build-out shot below.
    name: '16-bars-dead-end',
    note: 'BARS sheet dead end — every lane bought, levels mid-run, no lane left to advise',
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
      window.__clubStore.getState().openSheet('bars');
    `,
    settleMs: 900,
  },
  {
    // Full build-out with the completion card dismissed: all three stations at
    // Lv 30 with three lanes. This is the shot design review asked for by name,
    // because it is the one state that proves the Bars sheet no longer puts
    // three amber warnings behind the CLUB COMPLETE card.
    name: '17-bars-full-buildout',
    note: 'BARS sheet after club complete — three terminal cards, no ⚠ and no imperative',
    seed: FRESH,
    drive: `
      window.__club.buyAll();
      const s = window.__clubStore.getState();
      s.setShowComplete(false);
      s.setStar(null);
      s.openSheet('bars');
    `,
    settleMs: 900,
  },
  {
    // The completion card on the path a player actually takes to it. `buyAll`
    // reaches the same state with no sheet open, which is exactly the case that
    // cannot show the bug: the last purchase in the game is Booth lane 3, and it
    // is bought from the BARS sheet. So this drive buys everything *except* that
    // lane, opens the sheet, and buys it — leaving the card over the finished
    // room rather than over a list of rows.
    name: '18-complete-over-sheet',
    note: 'club complete fired from the BARS sheet — the real last purchase, sheet dismissed',
    seed: FRESH,
    drive: `
      const S = () => window.__clubStore.getState();
      window.__club.grant(1e12);
      S().actions.unlockStation('cocktail');
      S().actions.unlockStation('booth');
      for (let i = 0; i < 8; i++) S().actions.upgradeDoor();
      for (const key of ['tap', 'cocktail', 'booth']) {
        for (let i = 0; i < 30; i++) S().actions.upgradeStation(key);
      }
      for (const key of ['tap', 'cocktail']) {
        for (let i = 0; i < 2; i++) S().actions.buyLane(key);
      }
      S().actions.buyLane('booth');
      S().setStar(null);
      S().openSheet('bars');
      S().actions.buyLane('booth');
    `,
    settleMs: 900,
  },
  {
    // The other end of 14 and 15, and the half the economy could not show me.
    //
    // A fresh club serves 0.50/s against 0.90/s arriving, so 44% of the door is
    // turned away at second zero — a real queue, under the 50% share the Hud
    // gates its banner on. The dead end at 14/15 is visible by reading the
    // economy; this one was only visible by opening the sheet on a new save,
    // which is why it needs a permanent shot rather than a test alone.
    //
    // No `drive` beyond opening the sheet on purpose: any purchase at all would
    // stop being the first state a player sees.
    name: '19-door-fresh',
    note: 'DOOR sheet on a brand-new club — 44% turned away, advice given, no amber alarm',
    seed: FRESH,
    drive: `window.__clubStore.getState().openSheet('door');`,
    settleMs: 700,
  },
  {
    // 20/21/22 are a set: the same BARS sheet at rest and then with a finger
    // held on a button, which is the comparison DUB-38 turns on. Put 20 and 21
    // side by side on the old code and the button *disappears* — it repainted
    // to `--bg-raised`, the colour of the card it sits in, and dropped its
    // `--bg-raised` border at the same moment.
    //
    // The press is dispatched as a real `pointerdown` on a real button, so what
    // is captured is the component's own state, not a class poked in by the
    // harness. No `pointerup` follows, so the state holds for the capture — the
    // same thing a finger resting on the glass does.
    name: '20-cta-rest',
    note: 'BARS sheet, fresh club, nothing affordable — the buy buttons at rest, for 21 to be read against',
    seed: FRESH,
    drive: `
      const s = window.__clubStore.getState();
      s.setStar(null);
      s.openSheet('bars');
    `,
    settleMs: 700,
  },
  {
    // `+ Lane 2` and not `Upgrade to Lv 2`: a fresh club has earned ~£30 by the
    // time the sheet is open, and the first upgrade costs £5, so the upgrade is
    // *affordable* on second zero. The lane at £400 is the locked one, and it
    // is the state this ticket is about — a tap that buys nothing.
    name: '21-cta-pressed-locked',
    note: 'the same sheet with a finger down on the locked + Lane — scale, ring, and the price flash (DUB-38)',
    seed: FRESH,
    drive: `
      const s = window.__clubStore.getState();
      s.setStar(null);
      s.openSheet('bars');
      setTimeout(${PRESS_CTA}('+ Lane'), 400);
    `,
    settleMs: 1200,
  },
  {
    // The other half of the rule: the press has to read on a filled accent
    // button too, where a ring in `--ink-primary` would be ~1.3:1 on cyan and
    // the scale is doing the work on its own.
    name: '22-cta-pressed-affordable',
    note: 'a finger down on an affordable (filled) buy button — the press reads there as well',
    seed: FRESH,
    drive: `
      window.__club.grant(60000);
      const s = window.__clubStore.getState();
      s.setStar(null);
      s.openSheet('bars');
      setTimeout(${PRESS_CTA}('Upgrade to Lv'), 400);
    `,
    settleMs: 1200,
  },
  {
    // The third kind of dead-end tap, and the one the DUB-42 rebase created.
    //
    // A maxed row is `aria-disabled` but *not* `disabled`, so it is still
    // tappable and §9 still wants an answer. It gets one: the handlers are
    // attached unconditionally, so `cta--pressed` lands here too and the row
    // takes the scale and the ring. It cannot take the price flash — a maxed
    // row has a `.cta__done` badge where the price would be.
    //
    // This is the state to read against 11-club-complete, which is the same
    // rows at rest. DUB-42 moved the `aria-disabled` dim off the button and
    // onto the label so the gold badge clears AA; this shot is the check that
    // the press does not undo that *at rest* — only while a finger is down.
    name: '23-cta-pressed-maxed',
    note: 'a finger down on a maxed row — scale and ring, no price flash, DUB-42 badge treatment intact',
    seed: FRESH,
    drive: `
      window.__club.buyAll();
      const s = window.__clubStore.getState();
      s.setStar(null);
      // buyAll() finishes the club, so the CLUB COMPLETE modal raises over the
      // sheet. Dismissed the same way [KEEP PLAYING] dismisses it.
      s.setShowComplete(false);
      s.openSheet('bars');
      setTimeout(${PRESS_CTA}('Lv 30'), 400);
    `,
    settleMs: 1200,
  },
  {
    /*
     * The two rows of DUB-49 that the OS preference alone gets wrong, each one
     * reached by tapping the real toggle.
     *
     * 24 is the accessibility failure: reduced motion switched *on* in Settings
     * with no OS preference set. The three rules that used to key off a bare
     * `@media (prefers-reduced-motion: reduce)` never saw that toggle, so the
     * sheet slid in, the card scaled in, and the button shrank under the thumb
     * for a player who had asked for none of it. No `reducedMotion: true` here
     * deliberately — media emulation would hide the bug by answering for the
     * toggle.
     *
     * The sheet left open behind the press is the point as much as the button
     * is: it is the surface whose entrance animation is the other half of the
     * fix, and `html.is-still` is what suppresses it.
     */
    name: '24-motion-on-via-settings',
    note: 'reduced motion ON through the Settings toggle, OS preference unset — sheet, card and press all still (DUB-49 row 1)',
    seed: FRESH,
    drive: `
      const s = window.__clubStore.getState();
      window.__club.grant(60000);
      s.setStar(null);
      s.openSheet('settings');
      setTimeout(${TAP_TOGGLE}('Reduced motion'), 300);
      setTimeout(() => window.__clubStore.getState().openSheet('bars'), 600);
      setTimeout(${PRESS_CTA}('Upgrade to Lv'), 1000);
    `,
    settleMs: 1600,
  },
  {
    /*
     * The mirror, and the smaller of the two: reduced motion switched explicitly
     * *off* against an OS that asks to reduce. The press scale has to come back
     * — on an affordable (filled) button it is the only button-local press
     * treatment there is, so suppressing it against the player's word leaves
     * their thumb with no answer at all.
     *
     * `reducedMotion: true` *and* the toggle off is the combination: the media
     * query says reduce, the player says no, and the player wins.
     */
    name: '25-motion-off-via-settings',
    note: 'reduced motion OFF through the Settings toggle against an OS that asks to reduce — the press scale comes back (DUB-49 row 2)',
    seed: FRESH,
    reducedMotion: true,
    drive: `
      const s = window.__clubStore.getState();
      window.__club.grant(60000);
      s.setStar(null);
      s.openSheet('settings');
      setTimeout(${TAP_TOGGLE}('Reduced motion'), 300);
      setTimeout(() => window.__clubStore.getState().openSheet('bars'), 600);
      setTimeout(${PRESS_CTA}('Upgrade to Lv'), 1000);
    `,
    settleMs: 1600,
  },
  {
    /*
     * The screen that had never been photographed (DUB-89).
     *
     * Thirteen states times two viewports and `RotatePrompt` appeared in none
     * of them, because both viewports were portrait-or-desktop and the prompt
     * only exists below 600 px of height at an aspect ratio over 1. That is
     * also why DUB-66 had to argue about `.fatal__rotate-glyph` by reading the
     * stylesheet: there was nothing to look at.
     *
     * Default settings and no OS preference, so this is the glyph doing what it
     * is supposed to do — `rotate-hint`, running. It is the baseline shot 26 is
     * read against, and the only one of the pair that shows the animation the
     * ticket is about.
     */
    name: '25-rotate-prompt',
    note: 'rotate prompt at 844x390 — a 390x844 phone turned, default settings: glyph leaning and animating',
    seed: FRESH,
    viewports: ['landscape'],
    settleMs: 400,
    expect: `
      const g = ${READ_GLYPH}();
      if (g.animation !== 'rotate-hint') throw new Error('glyph is not animating: ' + g.animation);
      if (g.playState !== 'running') throw new Error('glyph animation is ' + g.playState);
      return 'glyph ' + g.animation + '/' + g.playState + ' at ' + g.degrees + 'deg, root "' + g.root + '", ' + g.viewport;
    `,
  },
  {
    /*
     * The DUB-49 fix on the one screen where it matters most, made visible.
     *
     * A 2s infinite 90° loop on a screen with nothing to tap is the WCAG 2.2.2
     * case in its purest form: the player cannot dismiss it, cannot play past
     * it, and cannot stop it. `html.is-still` freezes it upright, and the copy
     * carries the instruction on its own.
     *
     * Reached in the only order a player can reach it: the toggle tapped in
     * Settings at 390x844, *then* the phone turned. The sheet does not exist at
     * 844x390 — `App.tsx` returns the prompt above the whole HUD — so there is
     * no turning first and tapping after. `reducedMotion` is left unemulated on
     * purpose, for the same reason shot 23 leaves it: emulating the media query
     * would answer for the toggle and prove nothing about it.
     */
    name: '26-rotate-prompt-still',
    note: 'rotate prompt with reduced motion ON through the Settings toggle, OS preference unset — glyph frozen upright, the DUB-49 fix (DUB-89)',
    seed: FRESH,
    viewports: ['landscape'],
    drive: `
      window.__clubStore.getState().openSheet('settings');
      setTimeout(${TAP_TOGGLE}('Reduced motion'), 300);
    `,
    settleMs: 900,
    expect: `
      const pref = window.__clubStore.getState().settings.reducedMotion;
      if (pref !== 'on') throw new Error('the toggle did not land on; store says ' + pref);
      const g = ${READ_GLYPH}();
      if (!document.documentElement.classList.contains('is-still')) {
        throw new Error('root is not is-still: "' + g.root + '"');
      }
      if (g.animation !== 'none') throw new Error('glyph is still animating: ' + g.animation);
      if (g.degrees !== 0) throw new Error('glyph is not upright: ' + g.degrees + 'deg');
      return 'glyph frozen upright (0deg, animation none), root "' + g.root + '", toggle ' + pref + ', ' + g.viewport;
    `,
  },
];

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/**
 * Optional name filters from argv: `node tools/screenshots.ts 20-cta 21-cta`.
 *
 * The full set is twenty-odd states at two viewports, plus the landscape pair,
 * and takes a few minutes.
 * Re-capturing one pair after a one-line CSS change should not cost that, and
 * a reviewer comparing two shots wants them taken minutes apart, not runs
 * apart. No argument still means everything, so CI and `npm run shots` are
 * unchanged.
 */
function selectedShots(): readonly Shot[] {
  const filters = process.argv.slice(2);
  if (filters.length === 0) return SHOTS;

  const chosen = SHOTS.filter((shot) => filters.some((f) => shot.name.includes(f)));
  if (chosen.length === 0) throw new Error(`no shot matches ${filters.join(', ')}`);
  return chosen;
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const shots = selectedShots();

  const cdp = await Cdp.connect(await pageTarget());
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });

  const manifest: { viewport: string; name: string; note: string; file: string }[] = [];

  const setMetrics = async (viewport: Viewport, size: { width: number; height: number }): Promise<void> => {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: size.width,
      height: size.height,
      deviceScaleFactor: viewport.scale,
      mobile: viewport.mobile,
    });
  };

  for (const viewport of VIEWPORTS) {
    const here = shots.filter((shot) =>
      (shot.viewports ?? REVIEW_VIEWPORTS).includes(viewport.name),
    );
    if (here.length === 0) continue;

    for (const shot of here) {
      // Seeding, loading and driving happen in `reachedAt` when the viewport
      // has one, so the state is set in the shape the player can set it in.
      await setMetrics(viewport, viewport.reachedAt ?? viewport);

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

      // Now turn the phone. After the drive, because the Settings sheet the
      // drive reaches into is gone the moment the prompt takes the screen.
      if (viewport.reachedAt !== undefined) {
        await setMetrics(viewport, viewport);
        await sleep(TURN_SETTLE_MS);
      }

      const confirmed =
        shot.expect === undefined ? undefined : await cdp.evaluate<string>(shot.expect);

      const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      });

      const file = `${viewport.name}-${shot.name}.png`;
      await writeFile(`${OUT_DIR}/${file}`, Buffer.from(data, 'base64'));
      manifest.push({ viewport: viewport.name, name: shot.name, note: shot.note, file });
      console.log(
        `  ${viewport.name.padEnd(9)} ${shot.name.padEnd(24)} -> ${file}` +
          (confirmed === undefined ? '' : `\n              ${confirmed}`),
      );
    }
  }

  // Only a full run owns the manifest. A filtered run that rewrote it would
  // leave a two-entry index next to twenty PNGs.
  if (shots.length === SHOTS.length) {
    await writeFile(`${OUT_DIR}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  cdp.close();
  console.log(`\n${manifest.length} screenshots in ${OUT_DIR}/`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
