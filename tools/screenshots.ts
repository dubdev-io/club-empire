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
import { Cdp, pageTarget, sleep } from './cdp.ts';
import { type Bitmap, decodePng } from './png.ts';

const BASE_URL = process.env.CLUB_URL ?? 'http://127.0.0.1:5173';
const OUT_DIR = process.env.CLUB_SHOTS ?? 'screenshots';

/** The design viewport, and the desktop size that must not be *broken*. */
const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, scale: 2, mobile: true },
  { name: 'desktop', width: 1440, height: 900, scale: 1, mobile: false },
] as const;

// ---------------------------------------------------------------------------
// The keyboard
// ---------------------------------------------------------------------------

/**
 * A real key, delivered through the browser's own input pipeline.
 *
 * It has to be `Input.dispatchKeyEvent` and not a `KeyboardEvent` built in the
 * page: a synthetic event does not move focus, and the whole point of the focus
 * shots is where focus *went*. It also matters for `:focus-visible`, which
 * Chrome grants on a keyboard-driven focus change and withholds from a bare
 * programmatic `.focus()` — so a harness that cheated with `.focus()` would
 * photograph a state the player never sees.
 */
const KEYS = {
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
} as const;

async function key(cdp: Cdp, name: keyof typeof KEYS, type: 'keyDown' | 'keyUp'): Promise<void> {
  const spec = KEYS[name];
  await cdp.send('Input.dispatchKeyEvent', {
    type,
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
    ...('text' in spec && type === 'keyDown' ? { text: spec.text } : {}),
  });
}

/**
 * Press Tab until `document.activeElement` satisfies `predicate`.
 *
 * A fixed Tab count would be a hostage to document order — one banner showing
 * and the count is wrong, and the shot silently photographs the wrong button.
 * Walking the real tab ring and checking where it landed is both robust and the
 * verification the ticket asks for: if the ring never reaches the control, this
 * throws instead of producing a screenshot nobody looks twice at.
 *
 * On arrival the ring is measured, and a focus shot whose ring is missing or
 * clipped fails the run rather than being saved. The shot is the evidence, so it
 * must not be able to quietly photograph the thing the ticket says is fixed.
 */
async function tabTo(cdp: Cdp, predicate: string, limit = 40): Promise<void> {
  for (let press = 0; press < limit; press += 1) {
    await key(cdp, 'Tab', 'keyDown');
    await key(cdp, 'Tab', 'keyUp');
    await sleep(30);
    const arrived = await cdp.evaluate<boolean>(
      `const el = document.activeElement; return Boolean(el) && Boolean(${predicate});`,
    );
    if (!arrived) continue;

    const stop = await measureFocus(cdp);
    if (stop === null) throw new Error(`focus vanished on arriving at ${predicate}`);
    if (stop.ring === 0) {
      throw new Error(`no focus ring on ${stop.label}: :focus-visible did not match`);
    }
    if (stop.clearance < 0) {
      throw new Error(
        `focus ring on ${stop.label} is clipped by ${stop.clippedBy} ` +
          `(${stop.clearance}px, gap ${stop.gap}px)`,
      );
    }
    return;
  }
  throw new Error(`Tab never reached an element matching ${predicate} in ${limit} presses`);
}

// ---------------------------------------------------------------------------
// The focus ring, measured (DUB-50)
// ---------------------------------------------------------------------------

/**
 * What the browser actually drew around `document.activeElement`, and whether
 * anything is cutting it off.
 *
 * Two numbers that are easy to confuse, so both are reported:
 *
 *  - **`gap`** — px between the control's own edge and the nearest clipping
 *    edge, before the ring is considered at all. This is the number quoted in
 *    the ticket and in `ui.css`: `.sheet__body` had `padding: 0 var(--gutter)`,
 *    so the first and last control in every sheet measured a gap of 0.0.
 *  - **`clearance`** — the same thing after inflating the control's rect by the
 *    ring's reach (`outline-width` + `outline-offset`, read off the element, not
 *    off the tokens). This is the WCAG 2.4.11 answer: negative means some of the
 *    ring is being clipped away. 0.0 is legal — the ring ends exactly on the
 *    clipping edge.
 *
 * `ring` is read from the computed style rather than assumed, which makes this
 * the only check in the repo that can fail because `:focus-visible` did *not*
 * match: `focusRing.test.ts` reads the stylesheet as text and node has no CSSOM,
 * so "the rule exists" is all it can ever prove. Here a stop with `ring: 0` is
 * a stop with no ring, whatever the stylesheet says.
 *
 * Clipping is measured at the **padding box** of every ancestor whose overflow
 * clips (`auto`, `scroll`, `hidden`, `clip`), plus the viewport, which clips
 * everything. Overlap by a *sibling* is not measured — that is the other half
 * of 2.4.11 and it needs the pixels, i.e. QA and the shots.
 */
interface FocusStop {
  readonly label: string;
  /** `outline-width`, in px. `0` means nothing was drawn. */
  readonly ring: number;
  readonly offset: number;
  readonly gap: number;
  readonly clearance: number;
  readonly clippedBy: string;
  /** A dialog is open and this stop is outside it — see DUB-72. */
  readonly behindScrim: boolean;
  /** Index of the earlier stop this one repeats, if the ring has come round. */
  readonly seen: number | null;
}

const MEASURE_FOCUS = `
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;

  const describe = (node) => {
    const classes = node.classList.length ? '.' + [...node.classList].join('.') : '';
    const text = (node.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 24);
    return node.tagName.toLowerCase() + classes + (text ? ' \\u201c' + text + '\\u201d' : '');
  };

  const style = getComputedStyle(el);
  const ring = style.outlineStyle === 'none' ? 0 : parseFloat(style.outlineWidth) || 0;
  const offset = parseFloat(style.outlineOffset) || 0;
  const reach = ring > 0 ? ring + Math.max(offset, 0) : 0;

  const rect = el.getBoundingClientRect();
  const room = (clip, grow) => Math.min(
    rect.top - grow - clip.top,
    clip.bottom - (rect.bottom + grow),
    rect.left - grow - clip.left,
    clip.right - (rect.right + grow),
  );

  // Every clipping ancestor, at its padding box, plus the viewport.
  const clips = [[{ top: 0, left: 0, bottom: innerHeight, right: innerWidth }, 'viewport']];
  for (let node = el.parentElement; node; node = node.parentElement) {
    const cs = getComputedStyle(node);
    if (!/auto|scroll|hidden|clip/.test(cs.overflowX + ' ' + cs.overflowY)) continue;
    const r = node.getBoundingClientRect();
    clips.push([{
      top: r.top + parseFloat(cs.borderTopWidth),
      bottom: r.bottom - parseFloat(cs.borderBottomWidth),
      left: r.left + parseFloat(cs.borderLeftWidth),
      right: r.right - parseFloat(cs.borderRightWidth),
    }, describe(node)]);
  }

  let gap = Infinity;
  let clearance = Infinity;
  let clippedBy = 'viewport';
  for (const [clip, label] of clips) {
    gap = Math.min(gap, room(clip, 0));
    const after = room(clip, reach);
    if (after < clearance) { clearance = after; clippedBy = label; }
  }

  // Marked rather than matched by label: three bar buttons read alike, and the
  // walk has to know when the ring has come round rather than guess.
  const seen = el.dataset.focusAudit === undefined ? null : Number(el.dataset.focusAudit);

  const dialog = document.querySelector('[role="dialog"]');
  const round = (n) => Math.round(n * 10) / 10;
  return {
    label: describe(el),
    ring, offset,
    gap: round(gap),
    clearance: round(clearance),
    clippedBy,
    behindScrim: Boolean(dialog) && !dialog.contains(el),
    seen,
  };
`;

/** Measure wherever focus currently is. `null` when focus has left the page. */
async function measureFocus(cdp: Cdp): Promise<FocusStop | null> {
  return cdp.evaluate<FocusStop | null>(MEASURE_FOCUS);
}

/**
 * Tab once, measure, and claim the element so the walk can tell a cycle from a
 * coincidence.
 */
async function stepFocus(cdp: Cdp, index: number): Promise<FocusStop | null> {
  await key(cdp, 'Tab', 'keyDown');
  await key(cdp, 'Tab', 'keyUp');
  await sleep(40);

  const stop = await measureFocus(cdp);
  if (stop !== null && stop.seen === null) {
    await cdp.evaluate(`document.activeElement.dataset.focusAudit = '${index}'; return true;`);
  }
  return stop;
}

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
  /**
   * Walk the real tab ring until `document.activeElement` satisfies this
   * expression (`el` is bound to it). Run after `drive`, before the capture.
   */
  readonly tabTo?: string;
  /**
   * Hold a key down — never released — once focus has arrived. `Space` on a
   * focused `<button>` is the keyboard's press: Chrome sets `:active` on the
   * key *down* and only fires `click` on the way up, so the held state survives
   * the capture without the purchase going through.
   */
  readonly hold?: 'Space';
  /** Extra settle time, for states with an animation worth catching. */
  readonly settleMs?: number;
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
 * A finished club with the BARS sheet open — every row maxed (DUB-50).
 *
 * Shared by 23 and by 26/27/28 and by `--state-diff`, so that the row the diff
 * measures is provably the row the shots photograph. Two drives that merely
 * looked alike would make the diff's numbers evidence about a different button.
 *
 * `buyAll()` finishes the club, which raises the CLUB COMPLETE modal over the
 * sheet; `setShowComplete(false)` dismisses it the way [KEEP PLAYING] does.
 */
const MAXED_BARS_SHEET = `
  window.__club.buyAll();
  const s = window.__clubStore.getState();
  s.setStar(null);
  s.setShowComplete(false);
  s.openSheet('bars');
`;

/**
 * The maxed buy row, as a `tabTo` predicate.
 *
 * Keyed on `.cta--maxed` rather than on the label text: the label is copy and
 * DUB-55 is rewriting it, while the class is the thing `ui.css` keys the
 * `opacity: 1` opt-out off and so is the thing this is actually about.
 */
const MAXED_CTA = `el.classList.contains('cta') && el.classList.contains('cta--maxed')`;

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
      ${MAXED_BARS_SHEET}
      setTimeout(${PRESS_CTA}('Lv 30'), 400);
    `,
    settleMs: 1200,
  },
  {
    // 24/25 are the focus pair (DUB-50), and they are a pair for the same
    // reason 20/21 are: the claim is not "a ring exists", it is "the ring and
    // the press are two states a player can tell apart while in both at once".
    //
    // Reached by Tab, never by `.focus()`. Chrome grants `:focus-visible` on a
    // keyboard-driven focus change and withholds it from a programmatic focus,
    // so a harness that called `.focus()` would photograph a ring the player
    // never gets — and would keep passing if the rule were changed to the
    // `:focus` that leaves a ring on whatever a mouse last clicked.
    name: '24-cta-focused',
    note: 'BARS sheet, a buy button reached with Tab — the outset focus ring on the card (DUB-50)',
    seed: FRESH,
    drive: `
      const s = window.__clubStore.getState();
      s.setStar(null);
      s.openSheet('bars');
    `,
    tabTo: `el.classList.contains('cta') && (el.querySelector('.cta__label')?.textContent ?? '').startsWith('+ Lane')`,
    settleMs: 400,
  },
  {
    // The collision check. Space held on the focused button puts it in both
    // states: `:focus-visible` draws the outset ring, `:active` draws DUB-38's
    // inset one plus the price flash. What has to be visible here is the gap of
    // card colour between them — two rings, not one thick white band.
    //
    // `+ Lane` at £400 on a fresh club, so it is the dead-end press that owns
    // the ring. Space fires `click` on the way *up* and is never released, so
    // nothing is bought.
    name: '25-cta-focused-pressed',
    note: 'the same button focused and held with Space — the outset focus ring outside DUB-38’s inset press ring',
    seed: FRESH,
    drive: `
      const s = window.__clubStore.getState();
      s.setStar(null);
      s.openSheet('bars');
    `,
    tabTo: `el.classList.contains('cta') && (el.querySelector('.cta__label')?.textContent ?? '').startsWith('+ Lane')`,
    hold: 'Space',
    settleMs: 400,
  },

  // 26/27/28 are the same three-state comparison as 24/25, moved onto the
  // worst row in the game and with the last escape hatch taken away (DUB-50,
  // raised on the ticket from the DUB-91 re-review of DUB-38).
  //
  // Why the maxed row and not the locked one 24/25 use: a locked row answers a
  // dead-end press on *three* channels — the scale, the inset ring, and the
  // price flash. So "focused and pressed are different" is easy to satisfy
  // there for a reason that has nothing to do with the ring, and a shot of it
  // would pass even if the focus treatment were identical to the press.
  //
  // A maxed row strips the channels away one at a time:
  //
  //  - no price flash. A maxed row has a `.cta__done` badge where the price
  //    would be, so `.cta__price` is not in the DOM and the flash rule has
  //    nothing to match.
  //  - no scale, under `prefers-reduced-motion: reduce` — the media block drops
  //    `transform` for exactly the reason the ★ celebration does.
  //
  // What is left is one channel: the rings. Which is the point — if focus had
  // been built as the `box-shadow: inset` the ticket warned the next engineer
  // would reach for, these three PNGs would be two distinct renders and a
  // duplicate, and the duplicate would be the pair a keyboard player most needs
  // to tell apart. `--state-diff` measures that rather than leaving it to the
  // eye; these are the pictures of what it measured.
  {
    name: '26-cta-maxed-rm-focused',
    note: 'maxed row, reduced motion, focused by Tab — outset ring only, nothing inset (DUB-50)',
    seed: FRESH,
    reducedMotion: true,
    drive: MAXED_BARS_SHEET,
    tabTo: MAXED_CTA,
    settleMs: 400,
  },
  {
    // Pressed but *not* focused, and that is the second thing this shot proves.
    // The press arrives as a `pointerdown`, which does move focus in Chrome —
    // so a `:focus` rule would draw a ring here. `:focus-visible` does not, and
    // the absence of an outset ring in this PNG is what that looks like.
    name: '27-cta-maxed-rm-pressed',
    note: 'the same row under a finger — inset press ring, no outset ring, no scale, no flash (DUB-50)',
    seed: FRESH,
    reducedMotion: true,
    drive: `
      ${MAXED_BARS_SHEET}
      setTimeout(${PRESS_CTA}('Lv 30'), 400);
    `,
    settleMs: 1200,
  },
  {
    // The render the DUB-91 note says would be byte-identical to 26 if focus
    // and press shared an axis. White ring, 3px of card colour, white ring.
    name: '28-cta-maxed-rm-focused-pressed',
    note: 'the same row focused and held with Space — both rings, with the card showing between (DUB-50)',
    seed: FRESH,
    reducedMotion: true,
    drive: MAXED_BARS_SHEET,
    tabTo: MAXED_CTA,
    hold: 'Space',
    settleMs: 400,
  },
];

// ---------------------------------------------------------------------------
// The focus audit (DUB-50)
// ---------------------------------------------------------------------------

/**
 * The three screens the ticket asks to be tabbed through, at 1440x900.
 *
 * Shots 23/24 photograph one button on one sheet; this walks every stop on all
 * three and measures each one. Separate from `SHOTS` because it produces no
 * PNGs — a table of numbers is the deliverable, and it is the thing that lets
 * anyone re-derive the clearance figures quoted in `ui.css` rather than taking
 * the commit message's word for them.
 */
const FOCUS_WALKS = [
  { name: 'bars', drive: `window.__clubStore.getState().openSheet('bars');` },
  { name: 'door', drive: `window.__clubStore.getState().openSheet('door');` },
  { name: 'settings', drive: `window.__clubStore.getState().openSheet('settings');` },
] as const;

/** Tab all the way round once, measuring every stop. */
async function walkFocusRing(cdp: Cdp, limit = 40): Promise<readonly FocusStop[]> {
  await cdp.evaluate(`
    for (const node of document.querySelectorAll('[data-focus-audit]')) delete node.dataset.focusAudit;
    document.activeElement?.blur();
    return true;
  `);

  const stops: FocusStop[] = [];
  for (let press = 0; press < limit; press += 1) {
    const stop = await stepFocus(cdp, stops.length);
    // Focus left the document — Tab walked off the end into the browser's own
    // UI. That is the end of the ring, not a failure.
    if (stop === null) break;
    if (stop.seen !== null) break;
    stops.push(stop);
  }
  return stops;
}

/**
 * `npm run audit:focus` — every tab stop in the three sheets, measured.
 *
 * Fails the run on a stop with no ring (`:focus-visible` did not match) or a
 * clipped one (WCAG 2.4.11). Does *not* fail on a stop behind the scrim: those
 * are the bar buttons left in the tab ring by a dialog with no focus trap, they
 * are a real 1.4.11 failure, and they are DUB-72's to fix rather than something
 * the ring's own geometry can do anything about. Reported, counted, and called
 * by name so the gap cannot quietly become permanent.
 */
async function auditFocus(): Promise<void> {
  const desktop = VIEWPORTS.find((v) => v.name === 'desktop')!;

  const cdp = await Cdp.connect(await pageTarget());
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: desktop.width,
    height: desktop.height,
    deviceScaleFactor: desktop.scale,
    mobile: desktop.mobile,
  });

  const failures: string[] = [];
  let obscured = 0;

  console.log(`focus audit at ${desktop.width}x${desktop.height}\n`);

  for (const walk of FOCUS_WALKS) {
    await cdp.send('Page.navigate', { url: `${BASE_URL}/?noboot=1` });
    await sleep(400);
    await cdp.evaluate(`${FRESH} return true;`);
    await cdp.send('Page.navigate', { url: `${BASE_URL}/` });

    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(100);
      const ready = await cdp
        .evaluate<boolean>(`return Boolean(window.__clubStore) && Boolean(window.__club);`)
        .catch(() => false);
      if (ready) break;
    }

    await cdp.evaluate(`
      const s = window.__clubStore.getState();
      s.setStar(null);
      ${walk.drive}
      return true;
    `);
    await sleep(500);

    const stops = await walkFocusRing(cdp);
    console.log(`=== ${walk.name} === ${stops.length} stops`);
    if (stops.length === 0) failures.push(`${walk.name}: Tab reached nothing at all`);

    for (const stop of stops) {
      const ring = stop.ring === 0 ? 'NO RING' : `${stop.ring}+${stop.offset}px`;
      const note = stop.behindScrim ? '  behind the scrim (DUB-72)' : '';
      console.log(
        `  ${ring.padEnd(9)} gap ${String(stop.gap).padStart(6)}  ` +
          `clearance ${String(stop.clearance).padStart(6)}  ` +
          `vs ${stop.clippedBy.padEnd(34)} ${stop.label}${note}`,
      );

      if (stop.ring === 0) failures.push(`${walk.name}: no ring on ${stop.label}`);
      if (stop.clearance < 0) {
        failures.push(
          `${walk.name}: ${stop.label} clipped by ${stop.clippedBy} (${stop.clearance}px)`,
        );
      }
      if (stop.behindScrim) obscured += 1;
    }
    console.log('');
  }

  cdp.close();

  if (obscured > 0) {
    console.log(
      `${obscured} stop(s) sit behind the sheet scrim, where the ring composites to ~2.3:1 ` +
        `and fails WCAG 1.4.11. Not fixable in the ring — see DUB-72.\n`,
    );
  }

  if (failures.length > 0) {
    console.error(`focus audit FAILED\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log('focus audit passed: every stop draws a ring, and none of them is clipped.');
}

// ---------------------------------------------------------------------------
// The state diff (DUB-50)
// ---------------------------------------------------------------------------

/**
 * `npm run audit:states` — are focus, press, and both-at-once three different
 * pictures of the same button?
 *
 * This exists because "visually distinct from the press ring" is the one
 * acceptance criterion on DUB-50 that neither of the other two checks can
 * reach. `focusRing.test.ts` reads the stylesheet as text on node, so the most
 * it can prove is that one rule says `outline` and the other says `box-shadow:
 * inset` — not that the result differs on screen. `audit:focus` reads the
 * computed `outline-width`, so it proves a ring was *drawn* and is not clipped,
 * but it never looks at a pixel. A PNG looks at every pixel and is read by a
 * human who will not notice a regression six months from now.
 *
 * So: drive one button into three states, clip-capture it in each, and count
 * the pixels that differ between each pair. The run fails if any pair is
 * identical, which is the DUB-91 failure mode stated as an assertion —
 * `box-shadow: inset` for the focus ring instead of `outline` makes 26 and 28
 * the same picture, and this is what notices.
 *
 * Deliberately the maxed row under reduced motion, which is the row with the
 * fewest signals left: no price flash (a `.cta__done` badge sits where the
 * price would be) and no scale (the reduced-motion block drops `transform`).
 * Any other row would pass this for reasons that are not the ring's doing.
 */
interface StateShot {
  readonly label: string;
  readonly tab: boolean;
  readonly press: 'pointer' | 'space' | null;
}

const DIFF_STATES: readonly StateShot[] = [
  { label: 'rest', tab: false, press: null },
  { label: 'focused', tab: true, press: null },
  { label: 'pressed', tab: false, press: 'pointer' },
  { label: 'focused+pressed', tab: true, press: 'space' },
];

/**
 * The pixels of one element's box, inflated so the outset ring is inside the
 * capture.
 *
 * The inflation is not a guess: a clip tight to the border box would cut the
 * `outline` off entirely, and the diff would then "prove" that focus changes
 * nothing. Read off the element with `measureFocus` where possible so the
 * capture follows the tokens rather than duplicating them.
 */
async function captureControl(cdp: Cdp, selector: string, pad: number): Promise<Bitmap> {
  const box = await cdp.evaluate<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  `);
  if (box === null) throw new Error(`no element at ${selector}`);

  const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: {
      x: box.x - pad,
      y: box.y - pad,
      width: box.width + pad * 2,
      height: box.height + pad * 2,
      scale: 1,
    },
  });
  return decodePng(Buffer.from(data, 'base64'));
}

/** How many pixels differ, and by how much at the worst one. */
function diff(a: Bitmap, b: Bitmap): { pixels: number; worst: number } {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`capture sizes differ: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  let pixels = 0;
  let worst = 0;
  for (let i = 0; i < a.rgb.length; i += 3) {
    const delta =
      Math.abs(a.rgb[i]! - b.rgb[i]!) +
      Math.abs(a.rgb[i + 1]! - b.rgb[i + 1]!) +
      Math.abs(a.rgb[i + 2]! - b.rgb[i + 2]!);
    if (delta > 0) pixels += 1;
    if (delta > worst) worst = delta;
  }
  return { pixels, worst };
}

async function auditStates(): Promise<void> {
  const cdp = await Cdp.connect(await pageTarget());
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });

  const failures: string[] = [];

  for (const viewport of VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.scale,
      mobile: viewport.mobile,
    });
    // The whole point of the exercise: reduced motion, so the scale is gone and
    // the rings are the only channel left.
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });

    console.log(
      `\n=== ${viewport.name} ${viewport.width}x${viewport.height}, ` +
        `prefers-reduced-motion: reduce, maxed buy row ===`,
    );

    const shots = new Map<string, Bitmap>();
    let reach = 0;

    for (const state of DIFF_STATES) {
      await cdp.send('Page.navigate', { url: `${BASE_URL}/?noboot=1` });
      await sleep(400);
      await cdp.evaluate(`${FRESH} return true;`);
      await cdp.send('Page.navigate', { url: `${BASE_URL}/` });

      for (let attempt = 0; attempt < 60; attempt += 1) {
        await sleep(100);
        const ready = await cdp
          .evaluate<boolean>(`return Boolean(window.__clubStore) && Boolean(window.__club);`)
          .catch(() => false);
        if (ready) break;
      }

      await cdp.evaluate(`${MAXED_BARS_SHEET} return true;`);
      await sleep(700);

      // Mark the row so the clip and the shots are provably the same element,
      // whatever the tab order or the copy happens to be.
      const found = await cdp.evaluate<boolean>(`
        const el = [...document.querySelectorAll('.cta.cta--maxed')][0];
        if (!el) return false;
        el.dataset.stateDiff = '1';
        return true;
      `);
      if (!found) throw new Error('no .cta.cta--maxed on the BARS sheet after buyAll()');

      if (state.tab) {
        await tabTo(cdp, MAXED_CTA);
        // `tabTo` already asserts a ring was drawn and is not clipped, so the
        // reach it measured is the right pad for the clip.
        const stop = await measureFocus(cdp);
        reach = Math.max(reach, stop === null ? 0 : stop.ring + Math.max(stop.offset, 0));
      }

      if (state.press === 'pointer') {
        await cdp.evaluate(`(${PRESS_CTA}('Lv 30'))(); return true;`);
        await sleep(120);
      } else if (state.press === 'space') {
        await key(cdp, 'Space', 'keyDown');
        await sleep(120);
      }

      // A pad of at least the ring's reach, plus a pixel so the outer edge of
      // the ring is not the outermost row of the capture.
      const pad = Math.ceil(Math.max(reach, 6)) + 1;
      shots.set(state.label, await captureControl(cdp, '[data-state-diff]', pad));

      if (state.press === 'space') await key(cdp, 'Space', 'keyUp');
    }

    const labels = DIFF_STATES.map((s) => s.label);
    for (let i = 0; i < labels.length; i += 1) {
      for (let j = i + 1; j < labels.length; j += 1) {
        const a = labels[i]!;
        const b = labels[j]!;
        const { pixels, worst } = diff(shots.get(a)!, shots.get(b)!);
        const verdict = pixels === 0 ? 'IDENTICAL' : 'distinct';
        console.log(
          `  ${a.padEnd(15)} vs ${b.padEnd(15)} ` +
            `${String(pixels).padStart(6)} px differ, worst ${String(worst).padStart(3)}/765  ` +
            verdict,
        );
        if (pixels === 0) {
          failures.push(`${viewport.name}: "${a}" and "${b}" render identically on a maxed row`);
        }
      }
    }
  }

  cdp.close();

  if (failures.length > 0) {
    console.error(`\nstate diff FAILED\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log(
    '\nstate diff passed: rest, focused, pressed and focused+pressed are four ' +
      'different renders of the same maxed row, with no motion and no price flash.',
  );
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/**
 * Optional name filters from argv: `node tools/screenshots.ts 20-cta 21-cta`.
 *
 * The full set is two viewports of twenty-odd states and takes a few minutes.
 * Re-capturing one pair after a one-line CSS change should not cost that, and
 * a reviewer comparing two shots wants them taken minutes apart, not runs
 * apart. No argument still means everything, so CI and `npm run shots` are
 * unchanged.
 */
function selectedShots(): readonly Shot[] {
  const filters = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  if (filters.length === 0) return SHOTS;

  const chosen = SHOTS.filter((shot) => filters.some((f) => shot.name.includes(f)));
  if (chosen.length === 0) throw new Error(`no shot matches ${filters.join(', ')}`);
  return chosen;
}

async function main(): Promise<void> {
  // `--focus-audit` borrows the harness and captures nothing: same CDP client,
  // same page, same focus emulation, but the output is a table of measurements
  // rather than PNGs. Checked before `mkdir` so an audit run leaves no
  // `screenshots/` behind.
  if (process.argv.includes('--focus-audit')) {
    await auditFocus();
    return;
  }

  // `--state-diff` likewise: it captures, but it compares rather than saving,
  // so nothing lands in `screenshots/`.
  if (process.argv.includes('--state-diff')) {
    await auditStates();
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });
  const shots = selectedShots();

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

    for (const shot of shots) {
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

      // Keyboard last, and after the settle: the sheet has to be committed and
      // its animation finished before the tab ring means anything.
      if (shot.tabTo !== undefined) await tabTo(cdp, shot.tabTo);
      if (shot.hold !== undefined) {
        await key(cdp, shot.hold, 'keyDown');
        await sleep(80);
      }

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
