/**
 * What DUB-59 added to DUB-51's activation module: the other twelve controls.
 *
 * DUB-51 fixed the buttons that spend money, because that is where the money
 * is. Every other control in the app had the same single `onPointerDown` and no
 * keyboard route at all, and the result there was worse than a missed purchase:
 *
 *  - the three bottom-bar tabs are the **only** way into Bars, Door and
 *    Settings, so a keyboard player could tab onto all three and open none —
 *    not a degraded game but no game;
 *  - the offline-return and club-complete cards are not in the overlay stack
 *    `App` closes on `Escape` and their scrims are `aria-hidden`, so each one's
 *    single CTA was the only way out and it did not work. Those two trapped;
 *  - both save banners could not be dismissed and stayed for the session;
 *  - every sheet's ✕ was a dead control (mild: `Escape` still worked);
 *  - and the four inside Settings — three `role="switch"` toggles plus the
 *    button that deletes the save — were announced as operable and were not.
 *
 * The sequence itself, which is the hard part and which DUB-57 reviewed in
 * detail, is tested in `ctaPress.test.ts` and is not re-tested here. What this
 * file covers is what the generalisation is actually at risk of getting wrong:
 *
 *  - **the press callback being optional.** `BuyButton` passes `setPressed`
 *    because `.cta--pressed` exists for it; the other twelve pass nothing, and
 *    the module must act identically either way rather than throwing or
 *    quietly skipping a guard.
 *  - **the wiring.** `activationProps` is pure, so the set of handlers a
 *    control ends up with is checkable. All eight, always — six of them are
 *    load-bearing beyond the press class, and "the ones for the press are
 *    optional" is the mistake this pins against.
 *  - **the call sites.** That each of the thirteen routes through the module is
 *    a source assertion. Components are not unit-testable on the node
 *    environment, and a handler written inline at a call site is a handler
 *    outside every sequence test there is — which is the shape of the original
 *    bug, thirteen times over.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { activation, activationProps, createActivationLog, POINTER_CLICK_WINDOW_MS } from './activation.ts';
import type { ActivationClock } from './activation.ts';

function source(file: string): string {
  return readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
}

/** A clock a test drives by hand, so the window is a number and not a wait. */
function stoppedClock(): ActivationClock & { advance: (ms: number) => void } {
  let t = 1000;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

/**
 * One pointer id, for the tests here that are not about having two.
 *
 * The down state is keyed by `pointerId` because the log is shared and a phone
 * has more than one finger (DUB-51 R6). Two fingers on two controls is
 * `ctaPress.test.ts`'s case; what this file needs is only that a release is
 * matched to its own press.
 */
const MOUSE = 1;

/**
 * A control with no press class: a tab, a sheet's ✕, a banner dismiss, a
 * settings toggle. Twelve of the thirteen.
 */
function pressless() {
  const onAct = vi.fn();
  const clock = stoppedClock();

  return { onAct, clock, handlers: activation({ log: createActivationLog(), clock, onAct }) };
}

describe('a control that passes no press callback', () => {
  it('acts on a tap, on the pointer down', () => {
    const { handlers, onAct } = pressless();

    handlers.pointerDown({ pointerId: MOUSE });

    expect(onAct).toHaveBeenCalledTimes(1);
  });

  it('acts on Enter, and on Space', () => {
    // The whole of DUB-59. Enter's click is synthesised from the keydown's
    // default action and Space's from the keyup's, but both arrive here as a
    // `keydown` and then a `detail: 0` click, and neither is a `pointerdown`.
    const enter = pressless();
    enter.handlers.keyDown({ key: 'Enter' });
    enter.handlers.click({ detail: 0 });
    expect(enter.onAct).toHaveBeenCalledTimes(1);

    const space = pressless();
    space.handlers.keyDown({ key: ' ' });
    space.handlers.keyUp({ key: ' ' });
    space.handlers.click({ detail: 0 });
    expect(space.onAct).toHaveBeenCalledTimes(1);
  });

  it('acts once on a tap, not twice, with no press callback to notice the difference', () => {
    // The compatibility click still has to be suppressed, and the guard that
    // suppresses it is the pointer window — which the release handlers refresh.
    // A press-less control that dropped them would double-act here.
    const { handlers, onAct, clock } = pressless();

    handlers.pointerDown({ pointerId: MOUSE });
    handlers.pointerEnd({ pointerId: MOUSE });
    clock.advance(300);
    handlers.click({ detail: 0 });

    expect(onAct).toHaveBeenCalledTimes(1);
  });

  it('holds a long press to one action, which is the release handlers doing it', () => {
    // Held for three seconds, the click lands well outside a window measured
    // from the `pointerdown` — so the stamp refreshed on the way up is the only
    // thing in front of it.
    const { handlers, onAct, clock } = pressless();

    handlers.pointerDown({ pointerId: MOUSE });
    clock.advance(3000);
    handlers.pointerEnd({ pointerId: MOUSE });
    clock.advance(300);
    handlers.click({ detail: 0 });

    expect(onAct).toHaveBeenCalledTimes(1);
  });

  it('acts once on a held Enter, not once per repeat', () => {
    // The key-repeat guard is not about the press class either, so it has to
    // work without one. A leaned-on Enter on "Delete my club" is the case.
    const { handlers, onAct } = pressless();

    handlers.keyDown({ key: 'Enter', repeat: false });
    handlers.click({ detail: 0 });
    for (let i = 0; i < 20; i += 1) {
      handlers.keyDown({ key: 'Enter', repeat: true });
      handlers.click({ detail: 0 });
    }

    expect(onAct).toHaveBeenCalledTimes(1);
  });

  it('runs every handler without a press callback to call', () => {
    // `setPressed` is optional-chained in five places. Any one of them left as
    // a bare call is a crash on an ordinary press, on twelve of the thirteen
    // controls, and the crash is in a handler rather than in a render — so it
    // would not show up as a blank screen in review.
    const { handlers } = pressless();

    expect(() => {
      handlers.pointerDown({ pointerId: MOUSE });
      handlers.keyDown({ key: 'Enter' });
      handlers.keyUp({ key: 'Enter' });
      handlers.click({ detail: 0 });
      handlers.pointerEnd({ pointerId: MOUSE });
      handlers.cancelPress();
    }).not.toThrow();
  });

  it('is active by default, because none of the twelve has an inactive state', () => {
    // A tab, a close button, a banner dismiss and a toggle are always live.
    // `inactive: false` at those call sites would be noise standing in for a
    // state they do not have — so the default has to be the live one.
    const { handlers, onAct } = pressless();

    handlers.pointerDown({ pointerId: MOUSE });

    expect(onAct).toHaveBeenCalledTimes(1);
  });
});

/**
 * One log, shared by all thirteen.
 *
 * DUB-57's R3 hoisted the log out of the component because a purchase remounts
 * the row it was pressed in. Sharing it across *different kinds* of control is
 * the same argument carried further: a bottom-bar tap mounts an entire sheet
 * over the tab that was pressed, so the click to suppress may land on a button
 * that did not exist when the finger went down.
 */
describe('the shared log, across controls of different kinds', () => {
  it('suppresses a compat click that lands on whatever is now under the finger', () => {
    const log = createActivationLog();
    const clock = stoppedClock();
    const tabAct = vi.fn();
    const buyAct = vi.fn();

    // The tab is pressed and opens a sheet over itself.
    const tab = activation({ log, clock, onAct: tabAct });
    tab.pointerDown({ pointerId: MOUSE });
    tab.pointerEnd({ pointerId: MOUSE });

    // The compatibility click arrives ~300 ms later, at the buy button the
    // sheet has just mounted under the finger. Nobody pressed it.
    clock.advance(300);
    activation({ log, clock, onAct: buyAct, setPressed: vi.fn() }).click({ detail: 0 });

    expect(tabAct).toHaveBeenCalledTimes(1);
    expect(buyAct).not.toHaveBeenCalled();
  });

  it('still lets a keypress through on the control the tap moved focus to', () => {
    // The other side of the trade: a shared window must not swallow a genuine
    // keypress. A fresh Enter or Space clears it, which is what makes "tap a
    // tab, then press the button it revealed" two activations rather than one.
    const log = createActivationLog();
    const clock = stoppedClock();
    const buyAct = vi.fn();

    activation({ log, clock, onAct: vi.fn() }).pointerDown({ pointerId: MOUSE });

    const buy = activation({ log, clock, onAct: buyAct, setPressed: vi.fn() });
    buy.keyDown({ key: 'Enter', repeat: false });
    buy.click({ detail: 0 });

    expect(buyAct).toHaveBeenCalledTimes(1);
  });

  it('expires on its own, so an orphaned press cannot deafen the whole app', () => {
    // A `pointerdown` taken over by a scroll fires `pointercancel` and never
    // produces a click. With one log for thirteen controls, a stamp that never
    // expired would swallow the next synthetic activation anywhere in the app —
    // which, for a screen-reader user, is every control going quiet at once.
    const log = createActivationLog();
    const clock = stoppedClock();
    const onAct = vi.fn();

    activation({ log, clock, onAct: vi.fn() }).pointerDown({ pointerId: MOUSE });
    clock.advance(POINTER_CLICK_WINDOW_MS + 1);
    activation({ log, clock, onAct }).click({ detail: 0 });

    expect(onAct).toHaveBeenCalledTimes(1);
  });
});

/**
 * The wiring. Eight handlers, the same eight everywhere.
 */
describe('activationProps', () => {
  const eight = [
    'onBlur',
    'onClick',
    'onKeyDown',
    'onKeyUp',
    'onPointerCancel',
    'onPointerDown',
    'onPointerLeave',
    'onPointerUp',
  ];

  it('gives a control with a press class all eight', () => {
    const props = activationProps({ onAct: vi.fn(), setPressed: vi.fn() });

    expect(Object.keys(props).sort()).toEqual(eight);
  });

  it('gives a control without one the same eight, not a shorter set', () => {
    // The tempting mistake, and the reason this test exists: only `onBlur` is
    // purely about the press class. The three release events refresh the
    // suppression window and `onKeyUp` ends a repeat run, so trimming the set
    // for a press-less control would reintroduce the double activation and the
    // held-key repeat on twelve controls at once.
    const props = activationProps({ onAct: vi.fn() });

    expect(Object.keys(props).sort()).toEqual(eight);
  });

  it('defaults the log and the clock, so a call site names neither', () => {
    // Thirteen call sites that had to pass a module-level singleton and a clock
    // by hand would be thirteen chances to pass the wrong one.
    const onAct = vi.fn();
    const props = activationProps({ onAct });

    props.onKeyDown({ key: 'Enter', repeat: false });
    props.onClick({ detail: 0 });

    expect(onAct).toHaveBeenCalledTimes(1);
  });
});

/**
 * Every control, in every file. Source assertions, because what is pinned is a
 * fact about the files rather than about any function.
 */
describe('the call sites', () => {
  const controls = {
    'BottomBar.tsx': 3, // BARS, DOOR, Settings
    'Sheet.tsx': 2, // the ✕, and BuyButton
    'Overlays.tsx': 4, // COLLECT, KEEP PLAYING, and both banner dismisses
    'SettingsSheet.tsx': 4, // reveal, confirm, cancel, and the shared Toggle
  } as const;

  it('is thirteen controls, which is what the module comment claims', () => {
    expect(Object.values(controls).reduce((a, b) => a + b, 0)).toBe(13);
    expect(source('activation.ts')).toContain('Thirteen controls');
  });

  for (const [file, count] of Object.entries(controls)) {
    it(`${file}: ${count} control(s), each through the one module`, () => {
      const text = source(file);

      expect(text).toContain("from './activation.ts'");
      expect(text.match(/activationProps\(\{/g) ?? []).toHaveLength(count);
    });
  }

  /**
   * What is left on a bare `onPointerDown`, and why each is allowed to be.
   *
   * Every one of these is an element with no keyboard route *by design*, so the
   * count is the assertion: a new `onPointerDown` on anything focusable moves
   * the number and fails this.
   */
  const bare = {
    'BottomBar.tsx': 0,
    // The scrim. `aria-hidden`, no label, and must not be focusable — the ✕ it
    // duplicates is reachable by keyboard and so is `Escape`.
    'Sheet.tsx': 1,
    // Two scrims, plus the star burst: a `role="status"` div that auto-dismisses
    // after ~800 ms and is tappable early as a convenience. Not focusable,
    // nothing is claimed through it, and nothing is lost by never pressing it,
    // so there is no keyboard activation for it to be missing.
    'Overlays.tsx': 3,
    'SettingsSheet.tsx': 0,
  } as const;

  for (const [file, count] of Object.entries(bare)) {
    it(`${file}: ${count} element(s) left on \`pointerdown\` alone, none focusable`, () => {
      expect(source(file).match(/onPointerDown=\{/g) ?? []).toHaveLength(count);
    });
  }

  it('still has the star burst on a pointer handler, so the count above is the right one', () => {
    // Pinned by name as well as by count, so a reader of the count does not
    // have to go looking for which element it is.
    expect(source('Overlays.tsx')).toContain('onPointerDown={() => setStar(null)}');
  });

  it('leaves `setPressed` to BuyButton alone', () => {
    // Not a style rule. A press class passed from a call site that has no such
    // class in `ui.css` would be a `useState` re-rendering a button on every
    // press to no visible effect — and would read as feedback that exists.
    for (const file of Object.keys(controls)) {
      if (file === 'Sheet.tsx') continue;
      expect(source(file), file).not.toContain('setPressed');
    }
    expect(source('Sheet.tsx')).toContain('setPressed');
  });
});
