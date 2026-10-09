/**
 * The rotate prompt lays out against the viewport, not the portrait stage
 * (DUB-90).
 *
 * `#ui-root` is sized from `--stage-width`/`--stage-height`, so at 844x390 it
 * is a 180 px column in the middle of the window. Measured there in Chrome
 * before the fix: `.fatal` 180.2x390, `.fatal__title` 132.2x69 — "Turn your
 * phone upright" over three lines, two of them one word. After: `.fatal`
 * 844x390 at left 0, a 302.5 px (34ch) content column, title on one line.
 *
 * These are source assertions because the subject is a stylesheet and the
 * vitest environment is `node` with no layout engine. The real verification is
 * the CDP measurement above; this test exists so the one rule that escapes the
 * letterbox cannot be quietly dropped — and, just as importantly, so nobody
 * widens it to `.fatal` and drags `WebglUnavailable` out of the stage with it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');
const tokens = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');
const overlays = readFileSync(new URL('./Overlays.tsx', import.meta.url), 'utf8');

/** The declarations of the first rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const match = new RegExp(`(?:^|\\n)${selector.replaceAll('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css);
  const body = match?.[1];
  if (body === undefined) throw new Error(`no rule for ${selector}`);
  return body;
}

const rotate = ruleBody('.fatal--rotate');

describe('the rotate prompt escapes the stage letterbox', () => {
  it('is positioned against the viewport, not #ui-root', () => {
    // `absolute` resolves against #ui-root, which *is* the letterbox. `fixed`
    // takes the viewport as its containing block, which is the whole fix.
    expect(rotate).toMatch(/position:\s*fixed/);
  });

  it('gives the content a column of at least --rotate-column-min', () => {
    expect(tokens).toMatch(/--rotate-column-min:\s*280px/);
    expect(rotate).toMatch(/minmax\(\s*min\(var\(--rotate-column-min\), 100%\), 34ch\s*\)/);
  });

  it('centres that column in both axes', () => {
    expect(rotate).toMatch(/align-content:\s*center/);
    expect(rotate).toMatch(/justify-content:\s*center/);
  });

  it('writes no width of its own outside the token scale', () => {
    // Tokens only: the 280 px lives in tokens.css with the measurement that
    // chose it, and 34ch is the measure `.fatal__body` already asks for.
    expect(rotate).not.toMatch(/\d+px/);
  });
});

describe('the screens it shares a base with are untouched', () => {
  it('leaves `.fatal` itself inside the stage', () => {
    // WebglUnavailable renders in portrait, where the letterbox is correct.
    expect(ruleBody('.fatal')).toMatch(/position:\s*absolute/);
  });

  it('is the only overlay carrying the variant', () => {
    expect((overlays.match(/fatal--rotate/g) ?? []).length).toBe(1);
    expect(overlays).toMatch(/className="fatal fatal--rotate"/);
  });

  it('leaves the glyph and its animation alone (DUB-49)', () => {
    const glyph = ruleBody('.fatal__rotate-glyph');
    expect(glyph).toMatch(/width:\s*var\(--space-6\)/);
    expect(glyph).toMatch(/height:\s*var\(--space-7\)/);
    expect(glyph).toMatch(/animation:\s*rotate-hint/);
    // The --space-3 gap above the title comes from the `.fatal` base and the
    // variant must not restate it.
    expect(ruleBody('.fatal')).toMatch(/gap:\s*var\(--space-3\)/);
    expect(rotate).not.toMatch(/\bgap:/);
  });
});
