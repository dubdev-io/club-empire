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
 *    it unclipped. Both are arithmetic on the tokens, so both are checkable
 *    here rather than only in a screenshot: the ratio is computed against every
 *    surface the ring can land on, and the ring's reach is held under the
 *    tightest padding in the game.
 *
 * What is *not* here: whether the ring renders. `vitest` runs on the node
 * environment with no DOM and no CSSOM, so that belongs to the screenshot
 * harness (`npm run shots`, shots 23-24) and to QA on a device — the same split
 * `ctaPress.test.ts` draws.
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

  it('clears 3:1 against every surface a ring can land on (WCAG 1.4.11)', () => {
    const ring = resolve(token('--focus-ring-color'));

    // The three backgrounds in the game. Because the offset holds the ring
    // outside the button, the surface under it is always one of these — the
    // sheet, the station card, or the room behind the bottom bar.
    for (const surface of ['--bg-room', '--bg-surface', '--bg-raised']) {
      expect(contrast(ring, resolve(token(surface))), `ring on ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('reaches less far than the tightest container it sits in (WCAG 2.4.11)', () => {
    // `.bottom-bar`'s block-start padding is the smallest gap between a control
    // and an edge anywhere in the game. The ring has to fit inside it or the
    // bar buttons' rings get cut off along the top.
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
      expect(css.match(/:focus(?!-visible)\b/g), `bare :focus in ${file}`).toBeNull();
    }
  });

  it('never cancels itself with outline: none', () => {
    // The usual way a focus ring dies: a reset somewhere downstream.
    for (const css of [globalRules, uiRules]) {
      expect(css).not.toMatch(/outline:\s*(none|0)\b/);
    }
  });
});

describe('focus against the DUB-38 press', () => {
  it('stays on the outset axis while the press keeps the inset one', () => {
    const focus = block(globalRules, ':focus-visible {');
    const press = block(
      uiCss,
      '.cta.cta--pressed:not(.cta--affordable),\n.cta:active:not(.cta--affordable) {',
    );

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

describe('scroll containers', () => {
  it('reserve the ring`s reach so scroll-into-view cannot clip it', () => {
    // `overflow-y: auto` clips. Tabbing to a control below the fold scrolls it
    // into view flush against that clipping edge, and the ring is what hangs
    // over it.
    for (const selector of ['.sheet__body {', '.card--tall {']) {
      const rule = block(uiRules, selector);

      expect(rule, selector).toContain('overflow-y: auto');
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
    // third entry above.
    expect(uiRules.match(/overflow-y:\s*auto/g)).toHaveLength(2);
  });
});
