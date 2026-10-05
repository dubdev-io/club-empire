import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The MAXED badge keeps clearing AA (DUB-42).
 *
 * The real measurement is `tools/contrast.ts` against a live page — a ratio
 * worked out from the stylesheet is exactly how DUB-36 came to quote 3.13:1 for
 * a badge that actually rendered at 4.31:1. This file is not that measurement.
 * It is the cheap guard that keeps the fix from being undone silently, because
 * the browser probe needs Chrome and a dev server and so cannot run in CI.
 *
 * It pins the two halves of the fix:
 *
 *  - the arithmetic: --gold-vip on --bg-surface clears 4.5:1 undimmed, and does
 *    not clear it under the 0.55 disabled dim. The second half is why the rule
 *    exists, so it is worth failing on if a token moves.
 *  - the wiring: the blanket dim no longer reaches the badge, the maxed row
 *    still dims its label, and `BuyButton` only puts `cta--maxed` on the row
 *    that has a badge.
 *
 * A test that only checked the first half would pass with the fix reverted.
 */

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const TOKENS_CSS = read('../styles/tokens.css');
const UI_CSS = read('./ui.css');
const SHEET_TSX = read('./Sheet.tsx');

type Rgb = readonly [number, number, number];

/**
 * Match or throw. These run while the module loads, before any `it`, so a
 * selector that has been renamed has to fail loudly rather than quietly make
 * every assertion below vacuous.
 */
function must(match: RegExpExecArray | null, what: string): RegExpExecArray {
  if (match === null) throw new Error(what);
  return match;
}

function token(name: string): Rgb {
  const match = must(
    new RegExp(`${name}\\s*:\\s*#([0-9a-f]{6})\\b`, 'i').exec(TOKENS_CSS),
    `${name} is missing from tokens.css`,
  );
  const value = Number.parseInt(match[1]!, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** WCAG 2.x relative luminance of an 8-bit sRGB triplet. */
function luminance([r, g, b]: Rgb): number {
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `over` seen through `colour` at `alpha` — what an ancestor `opacity` does. */
function composite(colour: Rgb, alpha: number, over: Rgb): Rgb {
  return [0, 1, 2].map((i) => colour[i]! * alpha + over[i]! * (1 - alpha)) as unknown as Rgb;
}

/** The body of the first rule whose selector matches, whitespace collapsed. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = must(
    new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(UI_CSS),
    `no rule for \`${selector}\` in ui.css`,
  );
  return match[1]!.replace(/\s+/g, ' ').trim();
}

/** The `opacity` the disabled dim applies, read from the rule itself. */
const DISABLED_OPACITY = Number.parseFloat(
  must(
    /opacity:\s*([\d.]+)/.exec(rule(".cta[aria-disabled='true']")),
    'the disabled-dim rule no longer sets an opacity',
  )[1]!,
);

const BG_SURFACE = token('--bg-surface');
const GOLD_VIP = token('--gold-vip');
const INK_PRIMARY = token('--ink-primary');

describe('the MAXED badge clears AA (DUB-42)', () => {
  // The acceptance criterion names --bg-surface as the badge's backdrop, and the
  // reason that is the right surface is this rule: an undimmed button paints its
  // own opaque --bg-surface, whatever card it sits on. Once the dim is off the
  // button, the badge composites against this and nothing else.
  it('paints the button on an opaque --bg-surface of its own', () => {
    expect(rule('.cta')).toContain('background: var(--bg-surface)');
  });

  it('clears 4.5:1 undimmed — 14px/600 is not large text', () => {
    expect(contrast(GOLD_VIP, BG_SURFACE)).toBeGreaterThanOrEqual(4.5);
  });

  it('would not clear 4.5:1 under the disabled dim, which is why the rule exists', () => {
    // 4.31:1 — the figure DUB-42 measured. The dim pulls the badge towards the
    // backdrop *and* leaves the backdrop where it was, so it loses both ways.
    const dimmed = composite(GOLD_VIP, DISABLED_OPACITY, BG_SURFACE);
    expect(contrast(dimmed, BG_SURFACE)).toBeLessThan(4.5);
  });

  it('exempts the maxed row from the button-level dim', () => {
    // A child cannot be more opaque than its parent, so the only way the badge
    // reaches full --gold-vip is for the button itself not to be dimmed.
    expect(rule(".cta--maxed[aria-disabled='true']")).toContain('opacity: 1');
  });

  it('leaves every other disabled control dimmed exactly as before', () => {
    expect(DISABLED_OPACITY).toBe(0.55);
  });

  it('still dims the maxed row, so it reads as inert beside a live one', () => {
    // The label carries the inert signal now, at exactly the opacity the whole
    // button used to carry. Losing this line would make the maxed row look
    // pressable, which is the regression the AA fix must not introduce.
    expect(rule(".cta--maxed[aria-disabled='true'] .cta__label")).toContain(
      `opacity: ${String(DISABLED_OPACITY)}`,
    );
  });

  it('keeps the dimmed label above AA as well', () => {
    // The inert signal is not allowed to cost the label its legibility: the row
    // still has to say which station it is.
    const dimmed = composite(INK_PRIMARY, DISABLED_OPACITY, BG_SURFACE);
    expect(contrast(dimmed, BG_SURFACE)).toBeGreaterThanOrEqual(4.5);
  });

  it('puts cta--maxed on the row with a badge, and only that row', () => {
    // `isDone` is `doneLabel !== undefined`, which is also the condition for
    // rendering `.cta__done`. Tying the class to the same flag is what keeps
    // the exemption from leaking onto an ordinary unaffordable button.
    expect(SHEET_TSX).toMatch(/isDone \? ' cta--maxed' : ''/);
    expect(SHEET_TSX).toMatch(/\{isDone \? \(\s*<span className="cta__done">/);
  });
});
