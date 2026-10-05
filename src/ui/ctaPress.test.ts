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
 * above is also what a *keypress* gets, via `:active`, and for a while that was
 * all it got — Enter and Space produced a convincing press and bought nothing,
 * because the purchase was on `pointerdown`. `buyActivation` is pure too, so
 * which events transact is the third kind of fact here and the strongest: a
 * real unit test over a real sequence of events.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buyActivation } from './buyActivation.ts';
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
    // `onKeyDown` is what tells the click handler the click is a keypress.
    for (const handler of ['onClick', 'onKeyDown']) {
      expect(sheet).toContain(`${handler}=`);
    }
  });

  it('routes every one of them through the one module that decides', () => {
    // Not an aesthetic preference. A handler written inline here is a handler
    // outside the sequence test below, and the whole defect was a sequence.
    expect(sheet).toContain('buyActivation({ pointerServed, inactive, onBuy, setPressed })');
    for (const handler of ['pointerDown', 'release', 'keyDown', 'click']) {
      expect(sheet).toContain(`activation.${handler}`);
    }
  });
});

/**
 * The purchase itself: exactly one `onBuy` per activation, by either route.
 *
 * The two halves pull in opposite directions and that is the whole difficulty.
 * Touch must transact on `pointerdown` or it feels dead (DUB-38), the keyboard
 * only ever delivers a `click` (DUB-51), and a tap delivers *both* — so the
 * same button has to answer two events while charging the player once.
 */
describe('buyActivation', () => {
  /** A button mid-render, with its ref box and a spy for the purchase. */
  function button({ inactive = false } = {}) {
    const onBuy = vi.fn();
    const setPressed = vi.fn();
    const pointerServed = { current: false };

    return {
      onBuy,
      setPressed,
      pointerServed,
      handlers: buyActivation({ pointerServed, inactive, onBuy, setPressed }),
    };
  }

  /**
   * One tap, in the order a browser fires it.
   *
   * `pointerup` and `pointerleave` both land before the compatibility `click` —
   * touch has implicit capture, so the pointer ceases to exist on release and
   * the leave is fired for it. Which is exactly why the flag that suppresses
   * the click cannot be cleared by either of them.
   */
  function tap(handlers: ReturnType<typeof buyActivation>, detail = 1): void {
    handlers.pointerDown();
    handlers.release();
    handlers.click({ detail });
  }

  /**
   * One keypress on a focused button.
   *
   * Enter and Space differ in where the browser puts the activation — Enter
   * synthesises the click from the keydown's default action, Space swallows the
   * keydown and clicks on the way up — but both reduce to the same two events
   * reaching this module, in this order, and that is the point: neither of them
   * is a `pointerdown`, which is why neither of them used to buy anything.
   */
  function pressKey(handlers: ReturnType<typeof buyActivation>): void {
    handlers.keyDown();
    handlers.click({ detail: 0 });
  }

  it('buys once on a tap, on the pointer down and not on the click after it', () => {
    const { handlers, onBuy } = button();

    handlers.pointerDown();
    // The purchase is already made here — before `pointerup`, let alone before
    // the ~300 ms `click`. That is criterion 2's 100 ms budget.
    expect(onBuy).toHaveBeenCalledTimes(1);

    handlers.release();
    handlers.click({ detail: 1 });
    expect(onBuy).toHaveBeenCalledTimes(1);
  });

  it('buys once on Enter, and once on Space', () => {
    const enter = button();
    pressKey(enter.handlers);
    expect(enter.onBuy).toHaveBeenCalledTimes(1);

    const space = button();
    pressKey(space.handlers);
    expect(space.onBuy).toHaveBeenCalledTimes(1);
  });

  it('does not double-buy a tap whose click claims not to come from a pointer', () => {
    // The reason `detail` is not the only guard. It is the click count, so a
    // touch-derived click *should* report 1 — but that is an assumption about
    // an engine, and the cost of it being wrong is the player's money. The
    // `pointerServed` flag does not need the assumption.
    const { handlers, onBuy } = button();

    tap(handlers, 0);

    expect(onBuy).toHaveBeenCalledTimes(1);
  });

  it('suppresses one click per pointer down, not every click thereafter', () => {
    const { handlers, onBuy } = button();

    tap(handlers);
    tap(handlers);

    expect(onBuy).toHaveBeenCalledTimes(2);
  });

  it('lets the keyboard through after a tap that never produced a click', () => {
    // A tap taken over by a scroll: `pointercancel`, no click, and the flag
    // left standing. The next `keydown` is what clears it — which is the other
    // reason `keydown` has a handler at all.
    const { handlers, onBuy } = button();

    handlers.pointerDown();
    handlers.release();
    expect(onBuy).toHaveBeenCalledTimes(1);

    pressKey(handlers);
    expect(onBuy).toHaveBeenCalledTimes(2);
  });

  it('ignores a click no pointer and no key produced, unless it is synthetic', () => {
    const { handlers, onBuy } = button();

    // A stray mouse click with no `pointerdown` of ours behind it: not ours.
    handlers.click({ detail: 1 });
    expect(onBuy).not.toHaveBeenCalled();

    // `element.click()`, and an assistive technology's activation: detail 0,
    // no pointer sequence. That is a real activation and it buys.
    handlers.click({ detail: 0 });
    expect(onBuy).toHaveBeenCalledTimes(1);
  });

  it('never buys on `keydown` itself, so a held Space does not buy per repeat', () => {
    const { handlers, onBuy } = button();

    handlers.keyDown();
    handlers.keyDown();
    handlers.keyDown();

    expect(onBuy).not.toHaveBeenCalled();
  });

  describe('a button whose press buys nothing — unaffordable, maxed, switched off', () => {
    it('answers the press and withholds the purchase, on both routes alike', () => {
      const tapped = button({ inactive: true });
      tap(tapped.handlers);

      expect(tapped.onBuy).not.toHaveBeenCalled();
      // The press treatment is the whole of DUB-38's answer to a dead-end tap.
      expect(tapped.setPressed).toHaveBeenCalledWith(true);

      const keyed = button({ inactive: true });
      pressKey(keyed.handlers);

      expect(keyed.onBuy).not.toHaveBeenCalled();
      // No `setPressed` on the keyboard route and none wanted: `:active` holds
      // the same treatment for the length of the keypress, which is longer than
      // a class set on `click` could last. See `buyActivation.ts`.
      expect(keyed.setPressed).not.toHaveBeenCalled();
    });

    it('does not let the dead-end tap bank a purchase for the click to make', () => {
      // The button is inactive when the finger lands and affordable by the time
      // the click arrives — a price that just dropped, or a tick of income
      // between the two events. The click must not transact: the player pressed
      // a button that could not be bought, and nothing has been pressed since.
      const onBuy = vi.fn();
      const pointerServed = { current: false };

      buyActivation({ pointerServed, inactive: true, onBuy, setPressed: vi.fn() }).pointerDown();
      // The re-render. Same ref box, same element, `inactive` now false.
      buyActivation({ pointerServed, inactive: false, onBuy, setPressed: vi.fn() }).click({ detail: 0 });

      expect(onBuy).not.toHaveBeenCalled();
    });
  });
});
