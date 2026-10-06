/**
 * The keyboard player has to be able to see where they are (DUB-50).
 *
 * `grep -rn focus src/` used to return nothing: no `:focus-visible` rule, no
 * `outline` declaration, no token. The game is played on desktop — there is a
 * committed 1440x900 screenshot set — and the sheets are reachable with Tab, so
 * "whatever the browser draws by default" was the whole of the focus design.
 *
 * Three different kinds of fact are pinned here, and they fail for three
 * different reasons:
 *
 *  - **Shape.** One rule, keyed on `:focus-visible`, drawn with `outline`. Not a
 *    per-component list (a list is a thing someone forgets to extend) and not
 *    `:focus` (which would leave a ring on whatever a mouse last clicked, since
 *    every control in this game fires on `pointerdown`).
 *  - **Non-collision.** DUB-38 spent the inset-ring axis on the press. Focus
 *    takes the outset one. A keyboard player holding Space is focused *and*
 *    pressed at the same time, so if a later change moves focus onto
 *    `box-shadow: inset` the two states stop being distinguishable — and
 *    nothing on screen would look broken, which is why it needs a test.
 *  - **Measurement.** WCAG 1.4.11 wants 3:1 for the indicator and 2.4.11 wants
 *    it unclipped. The parts of both that are arithmetic on the tokens are
 *    checkable here rather than only in a screenshot: the ratio against the
 *    three flat surfaces a ring lands on, and the ring's reach against the
 *    tightest padding in the game.
 *
 * What is *not* here, and the boundary matters because this file is the gate CI
 * runs:
 *
 *  - **Whether the ring renders at all.** `vitest` runs on the node environment
 *    with no DOM and no CSSOM. That belongs to `npm run audit:focus`, which
 *    tabs the real ring and reads `outline-width` off `document.activeElement`,
 *    and to QA on a device — the same split `ctaPress.test.ts` draws.
 *  - **Composited contrast.** The arithmetic below is flat-colour arithmetic. It
 *    is right for a ring on the sheet, the card or the room, and it says nothing
 *    about a ring under a translucent layer. There used to be exactly one such
 *    case and it failed 1.4.11 at 2.27:1; DUB-72's focus trap removed the
 *    surface, so there is no composited ring left to measure. If a translucent
 *    layer is ever put over a *focusable* control again, this file cannot judge
 *    it and `audit:focus` is what would notice.
 *  - **Clipping by anything but the two scroll containers.** Six `overflow:
 *    hidden` boxes clip without scrolling (`.meter__track`,
 *    `.star-progress__track`, `.confetti`, `.boot__progress`,
 *    `.visually-hidden`, and `body` itself); none contains a focusable control
 *    today, and `audit:focus` is what would notice if one appeared.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tokensCss = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');
const globalCss = readFileSync(new URL('../styles/global.css', import.meta.url), 'utf8');
const uiCss = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');

/** Comments stripped, so prose quoting a rule never reads as the rule. */
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

const tokenRules = strip(tokensCss);
const globalRules = strip(globalCss);
const uiRules = strip(uiCss);

/** Everything between a selector and its closing brace, comments included. */
function block(css: string, selector: string): string {
  const at = css.indexOf(selector);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open));
}

/**
 * The body of the one rule whose selector list mentions `inSelector` and whose
 * declarations mention `inBody`.
 *
 * Preferred over `block` whenever the rule is someone else's: a literal
 * selector string pins the other author's formatting — their selector order,
 * their line breaks — and breaks on a reformat that changed nothing. This file
 * reads the DUB-38 press rule, which is on a branch that still has to be
 * rebased onto `phase1-build`, so it asks for "the pressed rule that draws a
 * ring" rather than for two exact lines with an exact newline between them.
 */
function blockMatching(css: string, inSelector: string, inBody: string): string {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
    ([, selector, body]) => selector!.includes(inSelector) && body!.includes(inBody),
  );

  expect(rules.length, `expected one rule with ${inSelector} declaring ${inBody}`).toBe(1);
  return rules[0]![2]!;
}

/**
 * Every `@media (prefers-reduced-motion: reduce)` block in the file, in full.
 *
 * `block` cannot read one: it slices to the first `}`, which inside an at-rule
 * is the end of the *first nested rule* rather than the end of the block. And
 * there are five of these in `ui.css`, so taking the first match by `indexOf`
 * would silently read `.sheet`'s and claim something about the CTA's. Brace
 * matching, all of them, so an assertion about "reduced motion" is about every
 * place reduced motion is handled.
 */
function reducedMotionBlocks(css: string): readonly string[] {
  const blocks: string[] = [];
  const marker = '@media (prefers-reduced-motion: reduce)';

  for (let at = css.indexOf(marker); at !== -1; at = css.indexOf(marker, at + 1)) {
    const open = css.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          blocks.push(css.slice(open + 1, i));
          break;
        }
      }
    }
  }

  expect(blocks.length, 'no reduced-motion block at all').toBeGreaterThan(0);
  return blocks;
}

/** `--name: value;` for one token, as written. */
function token(name: string): string {
  const match = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(tokenRules);
  expect(match, `no ${name} token`).not.toBeNull();
  return match![1]!.trim();
}

/** A token whose value is a bare `Npx`, in px. */
function pxToken(name: string): number {
  const value = token(name);
  const match = /^(\d+(?:\.\d+)?)px$/.exec(value);
  expect(match, `${name} is "${value}", not a px length`).not.toBeNull();
  return Number.parseFloat(match![1]!);
}

/** Follow `var(--x)` indirection until a literal falls out. */
function resolve(value: string, depth = 0): string {
  const match = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(value.trim());
  if (match === null) return value.trim();
  expect(depth, `token indirection loops at ${value}`).toBeLessThan(8);
  return resolve(token(match[1]!), depth + 1);
}

// --- WCAG 1.4.11 arithmetic, per the sRGB formulae in the spec --------------

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.040_45 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  expect(match, `${hex} is not a six-digit hex colour`).not.toBeNull();
  const n = Number.parseInt(match![1]!, 16);
  return (
    0.2126 * channel((n >> 16) & 0xff) +
    0.7152 * channel((n >> 8) & 0xff) +
    0.0722 * channel(n & 0xff)
  );
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/*
 * `channels`, `composite` and `translucentToken` lived here, to composite the
 * ring and the room under `--scrim` at 72% and measure the 2.27:1 that came out.
 * They went with the test that used them (DUB-72): no stop can be behind the
 * scrim now, so there is no such pair of colours to measure. `git show` has them
 * if the scrim ever needs weighing again.
 */

describe('the focus ring token', () => {
  it('exists, once, as tokens rather than as a literal at a call site', () => {
    for (const name of ['--focus-ring-width', '--focus-ring-offset', '--focus-ring-color']) {
      expect(token(name)).not.toBe('');
    }
  });

  it('derives its reach instead of restating width plus offset', () => {
    // Two places to edit is one place to forget. `scroll-padding` keys off this.
    const reach = token('--focus-ring-reach');

    expect(reach).toContain('calc(');
    expect(reach).toContain('var(--focus-ring-width)');
    expect(reach).toContain('var(--focus-ring-offset)');
  });

  it('keeps the ring off the accent fills, where white would be 1.4:1', () => {
    // The offset is what puts the ring on the card instead of on the button's
    // own background. Zero offset and the cyan fill is the surface being
    // measured against, which no near-white ring can pass.
    expect(pxToken('--focus-ring-offset')).toBeGreaterThan(0);
  });

  it('clears 3:1 on each of the three flat surfaces (WCAG 1.4.11)', () => {
    const ring = resolve(token('--focus-ring-color'));

    // The three opaque backgrounds in the game. Because the offset holds the
    // ring outside the button, an *unobscured* ring lands on one of these —
    // the sheet, the station card, or the room behind the bottom bar. Three
    // surfaces, not "every surface": the scrim makes a fourth, below.
    for (const surface of ['--bg-room', '--bg-surface', '--bg-raised']) {
      expect(contrast(ring, resolve(token(surface))), `ring on ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });

  /*
   * There was a fourth surface here: the room *behind the scrim*, where a stop
   * left in the tab ring by an untrapped dialog drew a ring at 2.27:1. The test
   * asserted the failure rather than hiding it, and said to delete it when the
   * trap landed, because the surface would stop existing.
   *
   * It landed — `focusTrap.ts`, DUB-72 — and no stop can be behind the scrim any
   * more, so there is nothing left to measure. What replaced the assertion is
   * `focusTrap.test.ts` plus `npm run audit:focus`, which tabs all three sheets
   * in a real browser and now reports 0 stops behind the scrim where it used to
   * report 9.
   */

  it('reaches less far than the tightest container it sits in (WCAG 2.4.11)', () => {
    // `.bottom-bar`'s block-start padding is the smallest gap between a control
    // and an edge anywhere in the game. The ring has to fit inside it or the
    // bar buttons' rings get cut off along the top.
    //
    // The block-start edge only: this reads the first value of a three-value
    // `padding`, deliberately. The inline budget is `.bottom-bar`'s 8 px `gap`,
    // shared, so 4 px each — which the reach already exceeds and is allowed to,
    // because the ring overlaps a *sibling* button rather than being clipped by
    // anything, and only one of them is focused at a time.
    const barPadding = resolve(block(uiRules, '.bottom-bar {').match(/padding:\s*([^\s;]+)/)![1]!);
    const reach = pxToken('--focus-ring-width') + pxToken('--focus-ring-offset');

    expect(reach).toBeLessThanOrEqual(Number.parseFloat(barPadding));
  });
});

describe('the focus ring rule', () => {
  it('is one document-wide rule, not a per-component list', () => {
    // A bare `:focus-visible` cannot be forgotten by the next button added.
    expect(globalRules).toContain(':focus-visible {');
    expect(globalRules.match(/:focus-visible/g)).toHaveLength(1);
    expect(uiRules, 'the ring belongs in global.css, once').not.toContain(':focus-visible');
  });

  it('draws the ring from the tokens', () => {
    const rule = block(globalRules, ':focus-visible {');

    expect(rule).toContain('outline: var(--focus-ring-width) solid var(--focus-ring-color)');
    expect(rule).toContain('outline-offset: var(--focus-ring-offset)');
  });

  it('is :focus-visible and never :focus, so a mouse press leaves nothing behind', () => {
    // Every control here fires on `pointerdown`, and a mouse press focuses what
    // it lands on. A `:focus` rule would strand a ring on the last thing
    // clicked.
    for (const [file, css] of [
      ['global.css', globalRules],
      ['ui.css', uiRules],
    ] as const) {
      // `(?![\w-])` and not `(?!-visible)\b`: the latter reports `:focus-within`
      // as a bare `:focus`, because `\b` sits happily between `s` and `-`. Any
      // `:focus-*` pseudo-class is fine here; it is `:focus` alone that strands
      // a ring on whatever the mouse last clicked.
      expect(css.match(/:focus(?![\w-])/g), `bare :focus in ${file}`).toBeNull();
    }
  });

  it('never cancels itself with an outline reset', () => {
    // The usual way a focus ring dies: a reset somewhere downstream. All four
    // spellings, because `outline: 0`, `outline: 0px`, `outline-width: 0` and
    // `outline-style: none` kill it identically — and a `\b` after the `0`
    // would let `0px` through, since there is no word boundary inside `0px`.
    for (const css of [globalRules, uiRules]) {
      expect(css).not.toMatch(/outline(?:-width|-style)?:\s*(?:none|0[a-z%]*)\s*(?:;|$)/m);
    }
  });
});

describe('focus against the DUB-38 press', () => {
  it('stays on the outset axis while the press keeps the inset one', () => {
    const focus = block(globalRules, ':focus-visible {');
    const press = blockMatching(uiRules, 'cta--pressed', 'box-shadow');

    // Both are legible at once only while they are on different axes. A
    // keyboard player holding Space is in both states.
    expect(press).toContain('box-shadow: inset');
    expect(focus).not.toContain('box-shadow');
    expect(focus).toContain('outline:');
    // And focus must not move the border either — that is the press's other
    // half (`border-color: var(--ink-primary)`).
    expect(focus).not.toContain('border');
  });

  it('leaves a gap of card colour between the two rings', () => {
    // Otherwise "focused and held" is one thick white band rather than two
    // rings, which is the collision this ticket was opened to prevent.
    const pressRing = /box-shadow:\s*inset 0 0 0 (\d+)px/.exec(uiRules);
    expect(pressRing, 'the DUB-38 press ring moved').not.toBeNull();

    expect(pxToken('--focus-ring-offset')).toBeGreaterThanOrEqual(Number.parseInt(pressRing![1]!, 10));
  });
});

/*
 * The maxed row, which is the worst case rather than merely another one.
 *
 * Raised on DUB-50 from the DUB-91 re-review of DUB-38. A dead-end press is
 * normally answered on three channels at once — the scale, the inset ring, and
 * the price flash — so "focused and pressed look different" is easy to satisfy
 * on a locked row for reasons that have nothing to do with the focus ring. A
 * maxed row removes two of the three:
 *
 *  - the price flash cannot fire, because a maxed row renders `.cta__done`
 *    where `.cta__price` would be and the flash rule has nothing to match;
 *  - the scale is dropped under `prefers-reduced-motion: reduce`.
 *
 * Which leaves one channel, the rings, and makes this the row where a focus
 * ring built on the press's own axis would render focused and held *identically*
 * — the same pixels, not merely similar ones.
 *
 * These are source assertions, so what they can prove is that the two channels
 * stay separate and that nothing re-dims or cancels the ring here. That the
 * three renders actually differ is a pixel question, and `npm run audit:states`
 * is the one that answers it: it drives this row into each state under reduced
 * motion and counts the pixels between each pair.
 */
describe('the maxed row, where focus and press have the fewest channels (DUB-91)', () => {
  it('does not dim its own focus ring, unlike every other aria-disabled control', () => {
    /*
     * `.cta[aria-disabled='true']` is `opacity: 0.55`, and `opacity` applies to
     * the element's whole rendering — the `outline` included. So on an ordinary
     * aria-disabled row the ring is *not* the token colour, and the 14.2:1 this
     * file asserts above is not what gets painted.
     *
     * The maxed row escapes that by accident of DUB-42, which moved the dim off
     * the button and onto the label so the gold MAXED badge could clear 4.5:1.
     * The focus ring is a free rider on that opt-out, and this test is here so
     * that it is a *noticed* free rider: reverting DUB-42's treatment would dim
     * the ring on the one row this ticket is now verified against, and nothing
     * else in the suite would say so.
     */
    const maxed = block(uiRules, ".cta--maxed[aria-disabled='true'] {");

    expect(maxed).toContain('opacity: 1');
  });

  it('keeps a dimmed ring above 3:1 on the rows that do dim (WCAG 1.4.11)', () => {
    /*
     * The other half of the above, measured rather than waved at. A non-maxed
     * `aria-disabled` row — buying switched off rather than finished — still
     * dims, so its ring composites at 0.55 over the card.
     *
     * Still legal, but the margin is nothing like the headline figure: 14.2:1
     * on `--bg-raised` becomes ~5.2:1. Pinned because the headline number is
     * what a future reader will reach for, and because the two inputs that
     * could cross 3:1 from here — a lighter card or a heavier dim — are both
     * ordinary design changes rather than exotic ones.
     */
    const ring = resolve(token('--focus-ring-color'));
    const dim = Number.parseFloat(block(uiRules, ".cta[aria-disabled='true'] {").match(/opacity:\s*([\d.]+)/)![1]!);

    for (const surface of ['--bg-room', '--bg-surface', '--bg-raised']) {
      const card = resolve(token(surface));
      // `opacity` composites the element over its own backdrop, which for a
      // ring held outside the button by the offset is the card.
      const dimmed = composite(card, ring, dim);

      expect(contrast(dimmed, card), `dimmed ring on ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('has no price to flash, so the press cannot borrow that channel', () => {
    // The component fact the DUB-91 note turns on. If a maxed row ever grew a
    // `.cta__price` again, the press would gain a second channel here and
    // `audit:states` would stop being a test of the rings alone — it would
    // start passing for the same reason the locked row does.
    const sheet = readFileSync(new URL('./Sheet.tsx', import.meta.url), 'utf8');
    const priceAt = sheet.indexOf('cta__price');
    const doneAt = sheet.indexOf('cta__done');

    expect(doneAt, 'the maxed row`s done badge').toBeGreaterThan(-1);
    // Rendered as the two arms of one conditional, badge first — so a row has
    // one or the other and never both.
    expect(doneAt).toBeLessThan(priceAt);
    expect(sheet.slice(doneAt, priceAt)).toContain(':');
  });

  it('keeps both rings when reduced motion takes the scale away', () => {
    /*
     * Reduced motion removes movement, not feedback. The CTA's block zeroes
     * `transform`, which is the whole reason this row is the worst case — and
     * it has to leave both rings alone. If it dropped the inset ring too, a
     * maxed row under reduced motion would answer a press with nothing at all,
     * and "pressed" would become the render identical to "rest" instead.
     *
     * Asserted across *every* reduced-motion block rather than the CTA's own,
     * because a later rule anywhere in the file would cancel the ring just as
     * effectively as that one would, and the ring's survival is the claim.
     */
    const blocks = reducedMotionBlocks(uiRules);

    expect(blocks.some((b) => b.includes('transform: none'))).toBe(true);
    for (const [index, body] of blocks.entries()) {
      expect(body, `reduced-motion block ${index} cancels the press ring`).not.toContain('box-shadow');
      expect(body, `reduced-motion block ${index} cancels the press border`).not.toContain('border-color');
      // And nothing there may reach the focus ring, from either direction.
      expect(body, `reduced-motion block ${index} touches the focus ring`).not.toContain('outline');
    }
  });
});

describe('scroll containers', () => {
  it('reserve the ring`s reach so scroll-into-view cannot clip it', () => {
    // `overflow-y: auto` clips. Tabbing to a control below the fold scrolls it
    // into view flush against that clipping edge, and the ring is what hangs
    // over it.
    for (const selector of ['.sheet__body {', '.card--tall {']) {
      const rule = block(uiRules, selector);

      expect(rule, selector).toMatch(/overflow(?:-[xy])?:\s*(?:auto|scroll)/);
      expect(rule, selector).toContain('scroll-padding-block: var(--focus-ring-reach)');
    }
  });

  it('gives the sheet`s first and last control somewhere to draw its ring', () => {
    // Separate from the scroll-padding above and not implied by it: the ends of
    // the sheet are flush with the clipping edge whether or not it scrolls.
    // With `padding: 0 var(--gutter)` the Door sheet's only buy button measured
    // 0.0 px of clearance at 1440x900.
    expect(block(uiRules, '.sheet__body {')).toContain('padding: var(--focus-ring-reach) var(--gutter)');
    // `.card--tall`'s ends are inside `.card`'s `--space-5` block padding,
    // which is already four times the reach.
    // Leading newline: `.card {` on its own would match `.overlay > .card {`.
    expect(block(uiRules, '\n.card {')).toContain('padding: var(--space-5)');
  });

  it('covers every scroll container in the stylesheet', () => {
    // If a third one appears, it needs the same padding and this test needs a
    // third entry above. Every spelling that makes a scroll container, not just
    // the two that happen to be written today: `overflow: auto` and
    // `overflow-y: scroll` scroll and clip exactly as `overflow-y: auto` does,
    // so a tripwire that only knew the long-hand-auto form would wave them
    // through. (`-webkit-overflow-scrolling` does not match — the pattern wants
    // a colon straight after the axis.)
    expect(uiRules.match(/overflow(?:-[xy])?:\s*(?:auto|scroll)/g)).toHaveLength(2);
  });
});
