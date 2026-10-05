/**
 * A tap on a buy button has to produce something a person can see (DUB-38).
 *
 * The bug was not that the press feedback was subtle. `.cta:active` repainted
 * the button to `--bg-raised`, and the `.station-row` it sits in *is*
 * `--bg-raised`, and `.cta`'s border is `1px solid var(--bg-raised)` — so the
 * press made the button the colour of the card behind it and dropped its
 * outline in the same frame. 1:1 against its own container, measured on the
 * live DOM at 390x844. Meanwhile a comment in `Sheet.tsx` justified leaving an
 * unaffordable button un-`disabled` on the grounds that pressing it "flashes
 * the price", which nothing in the codebase did.
 *
 * Two kinds of assertion here, for two kinds of fact:
 *
 *  - `ctaClassName` is a pure function, so the cascade's *inputs* get a real
 *    unit test: which classes land on the element, and in particular that the
 *    press class is never alone on a button that also carries an accent fill.
 *  - whether the stylesheet then *uses* those classes, and uses them on an axis
 *    the parent card cannot cancel, is a source assertion. `vitest` runs on the
 *    node environment with no DOM and no CSSOM, so a rendered-contrast check
 *    belongs to the screenshot harness (`npm run shots`, shots 20-22) and to QA
 *    on a device. What this file pins is that the rules cannot be quietly
 *    reverted to a background swap between those passes.
 *
 * DUB-51 then added the other half of the same button: the press treatment
 * above is also what a *keypress* gets, and for a while that was all it got —
 * Enter and Space produced a convincing press and bought nothing, because the
 * purchase was on `pointerdown`. `buyActivation` is pure too, so which events
 * transact is the third kind of fact here and the strongest: a real unit test
 * over a real sequence of events, including the sequences a browser only fires
 * when a key is held down.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  buyActivation,
  createBuyActivationLog,
  POINTER_CLICK_WINDOW_MS,
} from './buyActivation.ts';
import type { ActivationClock } from './buyActivation.ts';
import { ctaClassName } from './ctaClass.ts';

const css = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');
const sheet = readFileSync(new URL('./Sheet.tsx', import.meta.url), 'utf8');

/**
 * The stylesheet with its comments removed.
 *
 * Needed because the comment above the pressed rule quotes the old declaration
 * verbatim — the explanation of the bug would otherwise read as the bug.
 */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Everything between a selector list and its closing brace. */
function block(selector: string): string {
  const at = css.indexOf(selector);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

describe('ctaClassName', () => {
  it('always puts the bare `cta` class first, so the press rule can be (0,2,0)', () => {
    const classes = ctaClassName({ accent: 'cyan', affordable: true, inactive: false, pressed: true });

    expect(classes.split(' ')[0]).toBe('cta');
    // `.cta.cta--pressed` is the selector ui.css relies on. If `cta` were ever
    // conditional, the press would silently lose to the accent fill.
    expect(classes).toContain('cta');
    expect(classes).toContain('cta--pressed');
  });

  it('fills a button whose tap buys something', () => {
    expect(ctaClassName({ accent: 'magenta', affordable: true, inactive: false, pressed: false })).toBe(
      'cta cta--magenta cta--affordable',
    );
  });

  it('withholds the fill when the tap buys nothing — unaffordable, maxed, or switched off', () => {
    const unaffordable = ctaClassName({ accent: 'cyan', affordable: false, inactive: false, pressed: false });
    const maxed = ctaClassName({ accent: 'cyan', affordable: true, inactive: true, pressed: false });

    expect(unaffordable).not.toContain('cta--affordable');
    expect(maxed).not.toContain('cta--affordable');
  });

  it('marks the press on a dead-end button too — that is the tap that had no answer', () => {
    expect(ctaClassName({ accent: 'cyan', affordable: false, inactive: false, pressed: true })).toBe(
      'cta cta--cyan cta--pressed',
    );
    expect(ctaClassName({ accent: 'magenta', affordable: true, inactive: true, pressed: true })).toBe(
      'cta cta--magenta cta--pressed',
    );
  });
});

describe('the pressed rule in ui.css', () => {
  it('still agrees with the card it sits on about what made the old press invisible', () => {
    // The premise of the whole fix. If either of these changes, the reasoning
    // in the comment above `.cta.cta--pressed` needs re-measuring, not just the
    // rule.
    expect(block('.station-row {')).toContain('background: var(--bg-raised)');
    expect(block('.cta {')).toContain('border: 1px solid var(--bg-raised)');
  });

  it('does not answer a press with a background change at all', () => {
    expect(block('.cta.cta--pressed,\n.cta:active {')).not.toContain('background');
    // And specifically not with the colour of the container, which is what the
    // rule this replaced did.
    expect(rules).not.toMatch(/\.cta:active\s*{[^}]*background:\s*var\(--bg-raised\)/);
  });

  it('moves geometry, which the parent card cannot cancel', () => {
    expect(block('.cta.cta--pressed,\n.cta:active {')).toContain('transform: scale(');
  });

  it('gives a dead-end tap a ring where the border used to vanish', () => {
    const dead = block('.cta.cta--pressed:not(.cta--affordable),\n.cta:active:not(.cta--affordable) {');

    expect(dead).toContain('border-color: var(--ink-primary)');
    // Inset, not a wider border: `border-width` is in the layout box.
    expect(dead).toContain('box-shadow: inset');
  });

  it('flashes the price on a dead-end tap — the thing the Sheet.tsx comment promises', () => {
    const price = block(
      '.cta.cta--pressed:not(.cta--affordable) .cta__price,\n.cta:active:not(.cta--affordable) .cta__price {',
    );

    expect(price).toContain('color: var(--ink-primary)');
    expect(price).toContain('transform: scale(');
    // At rest the price is `--ink-disabled`; the flash is the largest step the
    // ink ramp offers from there.
    expect(block('.cta__price {')).toContain('color: var(--ink-disabled)');
  });

  it('drops the movement under reduced motion but keeps the feedback', () => {
    const reduced = css.slice(css.indexOf('.cta.cta--pressed,\n.cta:active {'));
    const query = reduced.slice(reduced.indexOf('@media (prefers-reduced-motion: reduce)'));
    const body = query.slice(0, query.indexOf('\n}\n'));

    expect(body).toContain('.cta.cta--pressed');
    expect(body).toContain('transform: none');
    // The ring and the price colour are not motion and must survive.
    expect(body).not.toContain('box-shadow');
    expect(body).not.toContain('border-color');
    expect(body).not.toContain('color: var(--ink-primary)');
  });
});

describe('BuyButton', () => {
  it('names the class the comment points at, so the comment describes the code', () => {
    // The original defect was documentary as much as visual: the comment
    // explained away `aria-disabled` with a price flash that was never built.
    expect(sheet).toContain('cta--pressed');
    expect(css).toContain('.cta.cta--pressed');
    expect(sheet).not.toContain('flashes the price instead');
  });

  it('takes the press handlers unconditionally, including when the tap buys nothing', () => {
    // The old code was `onPointerDown={inactive ? undefined : onBuy}`, so a
    // maxed or switched-off button had no handler and therefore no feedback.
    expect(sheet).not.toContain('onPointerDown={inactive ? undefined : onBuy}');
    for (const handler of ['onPointerDown', 'onPointerUp', 'onPointerCancel', 'onPointerLeave']) {
      expect(sheet).toContain(`${handler}=`);
    }
  });

  it('listens for the keyboard as well, which a pointer handler cannot hear', () => {
    // DUB-51: Enter and Space produce a `click` and no `pointerdown` at all.
    // The key events are what tell the click handler which click is coming.
    for (const handler of ['onClick', 'onKeyDown', 'onKeyUp']) {
      expect(sheet).toContain(`${handler}=`);
    }
  });

  it('routes every one of them through the one module that decides', () => {
    // Not an aesthetic preference. A handler written inline here is a handler
    // outside the sequence test below, and the whole defect was a sequence.
    // Asserted per-name rather than as one source literal: the previous
    // version pinned the whole call expression and broke on a reformat.
    expect(sheet).toContain('buyActivation({');
    for (const handler of ['pointerDown', 'pointerEnd', 'cancelPress', 'keyDown', 'keyUp', 'click']) {
      expect(sheet).toContain(`activation.${handler}`);
    }
  });

  it('shares one activation log across buttons, because a purchase remounts one', () => {
    // R3 from the DUB-57 review. Buying `Unlock` in `BarsSheet` replaces the
    // pressed button with two new ones, so suppression held in a `useRef` is
    // reset while the compatibility click is still in flight.
    expect(sheet).toContain('buyActivationLog');
    expect(sheet).not.toContain('useRef(false)');
  });
});

/**
 * The purchase itself: exactly one `onBuy` per activation, by every route.
 *
 * The halves pull in opposite directions and that is the whole difficulty.
 * Touch must transact on `pointerdown` or it feels dead (DUB-38), the keyboard
 * only ever delivers a `click` (DUB-51), a tap delivers *both* — so the same
 * button has to answer two events while charging the player once — and a held
 * key delivers a stream of clicks that look exactly like fresh keypresses.
 *
 * Every sequence below is written in the order a browser fires it, with the
 * clock advanced by hand, because the only thing being tested is order and
 * timing. The four regressions named R1-R4 are the DUB-57 review's.
 */
describe('buyActivation', () => {
  /** A clock the test steps, standing in for `performance.now()`. */
  function stopwatch(): ActivationClock & { advance: (ms: number) => void } {
    let t = 1_000;
    return { now: () => t, advance: (ms) => void (t += ms) };
  }

  /**
   * A button mid-render, with a spy for the purchase.
   *
   * `log` and `clock` are parameters so that two buttons can share them — which
   * is the whole of R3, and is also what the real component does.
   */
  function button({
    inactive = false,
    log = createBuyActivationLog(),
    clock = stopwatch(),
  } = {}) {
    const onBuy = vi.fn();
    const setPressed = vi.fn();

    return {
      onBuy,
      setPressed,
      log,
      clock,
      handlers: buyActivation({ log, clock, inactive, onBuy, setPressed }),
    };
  }

  /**
   * One tap, in the order a browser fires it.
   *
   * `pointerup` and `pointerleave` both land before the compatibility `click` —
   * touch has implicit capture, so the pointer ceases to exist on release and
   * the leave is fired for it. Which is why the window that suppresses the
   * click is refreshed by them rather than cleared.
   */
  function tap(
    b: ReturnType<typeof button>,
    { detail = 1, holdMs = 80, clickAfterMs = 300 } = {},
  ): void {
    b.handlers.pointerDown();
    b.clock.advance(holdMs);
    b.handlers.pointerEnd();
    b.clock.advance(clickAfterMs);
    b.handlers.click({ detail });
  }

  /**
   * One Enter press. The browser synthesises the `click` from the keydown's
   * default action, so it arrives between the two key events.
   */
  function pressEnter(b: ReturnType<typeof button>, { repeats = 0 } = {}): void {
    b.handlers.keyDown({ key: 'Enter', repeat: false });
    b.handlers.click({ detail: 0 });
    for (let i = 0; i < repeats; i += 1) {
      // ~30 Hz, which is roughly a platform's repeat rate.
      b.clock.advance(33);
      b.handlers.keyDown({ key: 'Enter', repeat: true });
      b.handlers.click({ detail: 0 });
    }
    b.handlers.keyUp({ key: 'Enter', repeat: false });
  }

  /**
   * One Space press. Space swallows the keydown — that is why it does not
   * scroll the page — and activates on the way up, so its single `click`
   * follows the `keyup` however long the key was held.
   */
  function pressSpace(b: ReturnType<typeof button>, { repeats = 0 } = {}): void {
    b.handlers.keyDown({ key: ' ', repeat: false });
    for (let i = 0; i < repeats; i += 1) {
      b.clock.advance(33);
      b.handlers.keyDown({ key: ' ', repeat: true });
    }
    b.handlers.keyUp({ key: ' ', repeat: false });
    b.handlers.click({ detail: 0 });
  }

  it('buys once on a tap, on the pointer down and not on the click after it', () => {
    const b = button();

    b.handlers.pointerDown();
    // The purchase is already made here — before `pointerup`, let alone before
    // the ~300 ms `click`. That is criterion 2's 100 ms budget.
    expect(b.onBuy).toHaveBeenCalledTimes(1);

    b.clock.advance(80);
    b.handlers.pointerEnd();
    b.clock.advance(300);
    b.handlers.click({ detail: 1 });
    expect(b.onBuy).toHaveBeenCalledTimes(1);
  });

  it('buys once on Enter, and once on Space', () => {
    const enter = button();
    pressEnter(enter);
    expect(enter.onBuy).toHaveBeenCalledTimes(1);

    const space = button();
    pressSpace(space);
    expect(space.onBuy).toHaveBeenCalledTimes(1);
  });

  it('does not double-buy a tap whose click claims not to come from a pointer', () => {
    // The reason `detail` is not the only guard. It is the click count, so a
    // touch-derived click *should* report 1 — but that is an assumption about
    // an engine, and the cost of it being wrong is the player's money. The
    // pointer window does not need the assumption.
    const b = button();

    tap(b, { detail: 0 });

    expect(b.onBuy).toHaveBeenCalledTimes(1);
  });

  it('charges two taps in a row twice, and no more', () => {
    const b = button();

    tap(b);
    tap(b);

    expect(b.onBuy).toHaveBeenCalledTimes(2);
  });

  it('does not double-buy a long press, whose click lands a second after the finger', () => {
    // The window is refreshed on the way up, not just stamped on the way down.
    // Held for three seconds, the compatibility click is 3.3 s after the
    // `pointerdown` — outside any window measured from it.
    const b = button();

    tap(b, { detail: 0, holdMs: 3_000 });

    expect(b.onBuy).toHaveBeenCalledTimes(1);
  });

  describe('a held key (R1)', () => {
    it('buys once on a held Enter, not once per repeat', () => {
      // R1: Enter re-synthesises its click on every repeat, each one with
      // `detail: 0` and nothing in front of it to say it is not a fresh press.
      // At ~30 Hz a leaned-on Enter key walked the player up every tier they
      // could afford. 20 repeats is about two thirds of a second.
      const b = button();

      pressEnter(b, { repeats: 20 });

      expect(b.onBuy).toHaveBeenCalledTimes(1);
    });

    it('buys once on a held Space, on the way up', () => {
      // The other half of the same rule, and the reason the repeat flag is
      // cleared by `keyup` rather than by the next fresh `keydown`: Space's one
      // genuine click arrives *after* a run of repeats.
      const b = button();

      pressSpace(b, { repeats: 20 });

      expect(b.onBuy).toHaveBeenCalledTimes(1);
    });

    it('still buys on the next press after a held one', () => {
      const b = button();

      pressEnter(b, { repeats: 5 });
      pressEnter(b);
      pressSpace(b, { repeats: 5 });

      expect(b.onBuy).toHaveBeenCalledTimes(3);
    });
  });

  it('is not re-armed by a key that cannot activate a button (R2)', () => {
    // R2: `keydown` fires for Tab, Shift and the arrows, and clearing the
    // window on any of them let a stray keypress inside the ~300 ms
    // compatibility window reopen the double buy. The click here reports
    // `detail: 0` — the touch engine we do not trust — so the window is the
    // only thing standing between the player and a second charge.
    const b = button();

    b.handlers.pointerDown();
    b.handlers.pointerEnd();
    for (const key of ['Tab', 'Shift', 'ArrowDown', 'a']) {
      b.handlers.keyDown({ key, repeat: false });
      b.handlers.keyUp({ key, repeat: false });
    }
    b.clock.advance(300);
    b.handlers.click({ detail: 0 });

    expect(b.onBuy).toHaveBeenCalledTimes(1);
  });

  it('suppresses the compatibility click even when the purchase remounted the button (R3)', () => {
    // R3: buying `Unlock` in `BarsSheet` tears down the row it was pressed on
    // and mounts `Upgrade` and `+ Lane` in its place, so the click ~300 ms
    // later reaches a *different* button with a fresh instance. Suppression
    // held per-instance is reset exactly when it is needed; a shared log is
    // not. Note the click is `detail: 0` — on an engine that reports it
    // honestly `detail` would catch this, and this is the case where it is the
    // shared log or nothing.
    const log = createBuyActivationLog();
    const clock = stopwatch();
    const onBuy = vi.fn();

    const first = buyActivation({
      log,
      clock,
      inactive: false,
      onBuy,
      setPressed: vi.fn(),
    });
    first.pointerDown();
    clock.advance(80);
    first.pointerEnd();

    // The re-render that the purchase caused: a new button, a new instance.
    const second = buyActivation({
      log,
      clock,
      inactive: false,
      onBuy,
      setPressed: vi.fn(),
    });
    clock.advance(300);
    second.click({ detail: 0 });

    expect(onBuy).toHaveBeenCalledTimes(1);
  });

  describe('a pointer activation that never produces a click (R4)', () => {
    it('stops swallowing synthetic activations once its window is up', () => {
      // R4: a `pointerdown` taken over by a scroll fires `pointercancel` and
      // no click at all. A flag set by that gesture stood indefinitely, so the
      // next activation with no `keydown` in front of it — `element.click()`,
      // a screen reader going through the accessibility tree — was swallowed.
      // A first press that does nothing is a miserable thing to debug from
      // behind a screen reader. The window expires on its own.
      const b = button();

      b.handlers.pointerDown();
      b.handlers.pointerEnd(); // `pointercancel`: the scroll took the gesture.
      expect(b.onBuy).toHaveBeenCalledTimes(1);

      b.clock.advance(POINTER_CLICK_WINDOW_MS);
      b.handlers.click({ detail: 0 });

      expect(b.onBuy).toHaveBeenCalledTimes(2);
    });

    it('still suppresses a click that arrives inside the window', () => {
      // The other side of the boundary, so the test above cannot pass by the
      // window being zero.
      const b = button();

      b.handlers.pointerDown();
      b.handlers.pointerEnd();
      b.clock.advance(POINTER_CLICK_WINDOW_MS - 1);
      b.handlers.click({ detail: 0 });

      expect(b.onBuy).toHaveBeenCalledTimes(1);
    });

    it('lets the keyboard through immediately, without waiting for the window', () => {
      // A player who taps a button and then presses it has made two
      // activations and the second must land. A fresh Enter or Space is never
      // the tail of a tap, so it clears the window outright.
      const b = button();

      b.handlers.pointerDown();
      b.handlers.pointerEnd();
      pressEnter(b);

      expect(b.onBuy).toHaveBeenCalledTimes(2);
    });
  });

  it('ignores a click no pointer and no key produced, unless it is synthetic', () => {
    const b = button();

    // A stray mouse click with no `pointerdown` of ours behind it: not ours.
    // This is also the accepted residual in `buyActivation.ts` — voice control
    // and some switch-access software dispatch a real `MouseEvent`, and this
    // button will not answer it.
    b.handlers.click({ detail: 1 });
    expect(b.onBuy).not.toHaveBeenCalled();

    // `element.click()`, and an assistive technology's activation: detail 0,
    // no pointer sequence. That is a real activation and it buys.
    b.handlers.click({ detail: 0 });
    expect(b.onBuy).toHaveBeenCalledTimes(1);
  });

  it('never buys on a key event itself, whichever key and however many', () => {
    const b = button();

    for (const key of ['Enter', ' ', 'Tab']) {
      b.handlers.keyDown({ key, repeat: false });
      b.handlers.keyDown({ key, repeat: true });
      b.handlers.keyUp({ key, repeat: false });
    }

    expect(b.onBuy).not.toHaveBeenCalled();
  });

  describe('a button whose press buys nothing — unaffordable, maxed, switched off', () => {
    it('answers the press and withholds the purchase, on both routes alike', () => {
      const tapped = button({ inactive: true });
      tap(tapped);

      expect(tapped.onBuy).not.toHaveBeenCalled();
      // The press treatment is the whole of DUB-38's answer to a dead-end tap.
      expect(tapped.setPressed).toHaveBeenCalledWith(true);

      // And criterion 4: the keyboard gets the same treatment, from the same
      // class and not from `:active`. A held Space is reliably `:active`, but
      // Enter's is the browser's own business — so on the button where the
      // press treatment is the only answer there is, CSS alone could have left
      // an Enter press with nothing at all to show.
      const keyed = button({ inactive: true });
      pressEnter(keyed);

      expect(keyed.onBuy).not.toHaveBeenCalled();
      expect(keyed.setPressed).toHaveBeenCalledWith(true);
      expect(keyed.setPressed).toHaveBeenLastCalledWith(false);

      const spaced = button({ inactive: true });
      pressSpace(spaced);

      expect(spaced.onBuy).not.toHaveBeenCalled();
      expect(spaced.setPressed).toHaveBeenCalledWith(true);
    });

    it('does not let the dead-end tap bank a purchase for the click to make', () => {
      // The button is inactive when the finger lands and affordable by the time
      // the click arrives — a price that just dropped, or a tick of income
      // between the two events. The click must not transact: the player pressed
      // a button that could not be bought, and nothing has been pressed since.
      const log = createBuyActivationLog();
      const clock = stopwatch();
      const onBuy = vi.fn();

      buyActivation({ log, clock, inactive: true, onBuy, setPressed: vi.fn() }).pointerDown();
      clock.advance(380);
      // The re-render. Same log, same element, `inactive` now false.
      buyActivation({ log, clock, inactive: false, onBuy, setPressed: vi.fn() }).click({
        detail: 0,
      });

      expect(onBuy).not.toHaveBeenCalled();
    });
  });
});
