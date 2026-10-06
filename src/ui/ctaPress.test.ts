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
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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
    const classes = ctaClassName({
      accent: 'cyan',
      affordable: true,
      inactive: false,
      maxed: false,
      pressed: true,
    });

    expect(classes.split(' ')[0]).toBe('cta');
    // `.cta.cta--pressed` is the selector ui.css relies on. If `cta` were ever
    // conditional, the press would silently lose to the accent fill.
    expect(classes).toContain('cta');
    expect(classes).toContain('cta--pressed');
  });

  it('fills a button whose tap buys something', () => {
    expect(
      ctaClassName({ accent: 'magenta', affordable: true, inactive: false, maxed: false, pressed: false }),
    ).toBe('cta cta--magenta cta--affordable');
  });

  it('withholds the fill when the tap buys nothing — unaffordable, maxed, or switched off', () => {
    const unaffordable = ctaClassName({
      accent: 'cyan',
      affordable: false,
      inactive: false,
      maxed: false,
      pressed: false,
    });
    const maxed = ctaClassName({
      accent: 'cyan',
      affordable: true,
      inactive: true,
      maxed: true,
      pressed: false,
    });
    const switchedOff = ctaClassName({
      accent: 'cyan',
      affordable: true,
      inactive: true,
      maxed: false,
      pressed: false,
    });

    expect(unaffordable).not.toContain('cta--affordable');
    expect(maxed).not.toContain('cta--affordable');
    expect(switchedOff).not.toContain('cta--affordable');
  });

  it('marks the press on a dead-end button too — that is the tap that had no answer', () => {
    expect(
      ctaClassName({ accent: 'cyan', affordable: false, inactive: false, maxed: false, pressed: true }),
    ).toBe('cta cta--cyan cta--pressed');
    expect(
      ctaClassName({ accent: 'magenta', affordable: true, inactive: true, maxed: false, pressed: true }),
    ).toBe('cta cta--magenta cta--pressed');
  });

  /*
   * DUB-42's guarantee, re-pinned here after the DUB-38 rebase.
   *
   * DUB-42 wrote `cta--maxed` as a literal in `Sheet.tsx` and asserted that
   * literal from `ctaContrast.test.ts`; DUB-38 moved class composition into
   * `ctaClassName`, so the literal no longer exists and the assertion had to
   * move with it. These are the tests that make the merge-time trap fail loudly:
   * dropping `maxed` to make the two sides fit puts the `aria-disabled` dim back
   * on the button, and the gold MAXED badge composites at 4.37:1 instead of
   * 11.68:1 — under AA, which is the whole of DUB-42.
   */
  it('puts cta--maxed on a maxed row, so the dim moves to the label and the badge clears AA (DUB-42)', () => {
    expect(
      ctaClassName({ accent: 'magenta', affordable: false, inactive: true, maxed: true, pressed: false }),
    ).toBe('cta cta--magenta cta--maxed');
  });

  it('withholds cta--maxed from a button that is merely switched off — only a badge row gets it', () => {
    // Narrower than `inactive` on purpose: `inactive` is `disabled || isDone`,
    // and a `disabled` row still shows a price, not a `--gold-vip` badge, so it
    // has no child that needs the dim moved off it.
    expect(
      ctaClassName({ accent: 'cyan', affordable: true, inactive: true, maxed: false, pressed: false }),
    ).not.toContain('cta--maxed');
  });

  it('keeps the press alongside the maxed treatment rather than replacing it', () => {
    // A maxed button still answers a tap (DUB-38) while still reading as inert
    // (DUB-42). Both classes have to survive on the same element.
    const classes = ctaClassName({
      accent: 'magenta',
      affordable: false,
      inactive: true,
      maxed: true,
      pressed: true,
    });

    expect(classes).toContain('cta--maxed');
    expect(classes).toContain('cta--pressed');
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

  it('still withholds the purchase itself from an inactive button', () => {
    expect(sheet).toContain('if (!inactive) onBuy();');
  });
});
