/**
 * Reduced motion has one source, and the CSS reads it (DUB-49).
 *
 * The bug was not a missing suppression — it was two suppressions that
 * disagreed. `store.reducedMotion` composed `prefers-reduced-motion` with the
 * Settings toggle and surfaced as `.meter--still` / `.star-burst--still`, while
 * three rules in `ui.css` keyed off a bare
 * `@media (prefers-reduced-motion: reduce)` and never saw the toggle at all:
 * the sheet entrance, the card entrance, and the buy button's press scale.
 * Both directions were wrong, and neither is visible in a screenshot taken
 * with emulated media alone:
 *
 *   toggle `on`, OS unset    -> ★ burst still, sheet/card/press still moved
 *   toggle `off`, OS reduce  -> ★ burst moved, sheet/card/press suppressed
 *
 * Three kinds of assertion, for three kinds of fact:
 *
 *  - the resolution rule is a pure function, so all four rows of that table get
 *    a real unit test through `resolveReducedMotion` + `applyMotionRootClass`;
 *  - which *signal* each CSS rule listens to is structural, so the stylesheet is
 *    parsed: every `prefers-reduced-motion` block has to be scoped to the root
 *    flag, and every scoped block has to have a resolved twin. That is the guard
 *    against the next animation arriving with a bare media query — which is how
 *    this bug got in;
 *  - whether the suppression is then *visible* is a rendered fact, and belongs
 *    to the screenshot harness (`npm run shots`, shots 24-25, which tap the real
 *    Settings toggle rather than emulating the media query) and to QA on a
 *    device.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ctaClassName } from './ctaClass.ts';
import {
  applyMotionRootClass,
  MOTION_MOVING_CLASS,
  MOTION_STILL_CLASS,
  resolveReducedMotion,
} from './motion.ts';

const css = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const sheet = readFileSync(new URL('./Sheet.tsx', import.meta.url), 'utf8');

/** A `classList.toggle` recorder, since vitest runs with no DOM. */
function fakeRoot(): { readonly classes: Set<string>; readonly classList: { toggle: (c: string, on?: boolean) => boolean } } {
  const classes = new Set<string>();
  return {
    classes,
    classList: {
      toggle(name: string, on?: boolean): boolean {
        const next = on ?? !classes.has(name);
        if (next) classes.add(name);
        else classes.delete(name);
        return next;
      },
    },
  };
}

function rootClasses(preference: 'auto' | 'on' | 'off', osPrefersReduce: boolean): string[] {
  const root = fakeRoot();
  applyMotionRootClass(root, resolveReducedMotion(preference, osPrefersReduce));
  return [...root.classes].sort();
}

describe('the resolved flag', () => {
  // The four rows of the ticket's table, in order.
  it('row 1 — toggle `on` with no OS preference suppresses motion', () => {
    // The accessibility failure. The toggle was the only signal saying "still",
    // and three rules could not hear it.
    expect(resolveReducedMotion('on', false)).toBe(true);
    expect(rootClasses('on', false)).toEqual([MOTION_STILL_CLASS]);
  });

  it('row 2 — toggle `off` with the OS set to reduce allows motion', () => {
    expect(resolveReducedMotion('off', true)).toBe(false);
    expect(rootClasses('off', true)).toEqual([MOTION_MOVING_CLASS]);
  });

  it('row 3 — `auto` with the OS set to reduce suppresses motion', () => {
    expect(resolveReducedMotion('auto', true)).toBe(true);
    expect(rootClasses('auto', true)).toEqual([MOTION_STILL_CLASS]);
  });

  it('row 4 — `auto` with no OS preference allows motion', () => {
    expect(resolveReducedMotion('auto', false)).toBe(false);
    expect(rootClasses('auto', false)).toEqual([MOTION_MOVING_CLASS]);
  });

  it('states "motion is allowed" rather than implying it from an absent class', () => {
    // `is-moving` is load-bearing: it is what stops the media fallback from
    // overruling an explicit `off`. One class would make row 2 indistinguishable
    // from a page that has not resolved yet, which is exactly the state the
    // fallback is supposed to own.
    expect(rootClasses('off', true)).not.toContain(MOTION_STILL_CLASS);
    expect(rootClasses('off', true)).toContain(MOTION_MOVING_CLASS);
  });

  it('flips both classes when the answer changes, leaving no stale flag behind', () => {
    const root = fakeRoot();
    applyMotionRootClass(root, true);
    applyMotionRootClass(root, false);
    expect([...root.classes]).toEqual([MOTION_MOVING_CLASS]);
    applyMotionRootClass(root, true);
    expect([...root.classes]).toEqual([MOTION_STILL_CLASS]);
  });
});

describe('App publishes the resolution', () => {
  it('reads the store, not a second media query of its own', () => {
    // One `matchMedia('(prefers-reduced-motion: reduce)')` in App.tsx, inside
    // the hook that feeds `resolveReducedMotion`. A second one would be a
    // second source of truth, which is the whole defect.
    const queries = app.match(/matchMedia\('\(prefers-reduced-motion: reduce\)'\)/g) ?? [];
    expect(queries).toHaveLength(1);
    expect(app).toContain('resolveReducedMotion(preference, query.matches)');
    expect(app).toContain('applyMotionRootClass(root, state.reducedMotion)');
  });

  it('applies the class from the live store on mount, not from a render snapshot', () => {
    // `useReducedMotionSync` runs its effect first and writes the store; reading
    // `getState()` here is what makes the first class the resolved value rather
    // than the store's `false` default, which would flash `is-moving` at a
    // player whose OS asked for reduce.
    expect(app).toContain('applyMotionRootClass(root, useGameStore.getState().reducedMotion)');
    const syncAt = app.indexOf('useReducedMotionSync();');
    const rootAt = app.indexOf('useMotionRootClass();');
    expect(syncAt).toBeGreaterThan(-1);
    expect(rootAt).toBeGreaterThan(syncAt);
  });

  it('publishes the class above the landscape early return, so the rotate prompt sees it', () => {
    // The reason `.fatal__rotate-glyph` can read the resolved flag at all
    // (DUB-66). Move `useMotionRootClass()` below this return and the rotate
    // prompt silently falls back to the OS preference, which is the bug.
    const rootAt = app.indexOf('useMotionRootClass();');
    const returnAt = app.indexOf('if (landscape) return <RotatePrompt />;');
    expect(returnAt).toBeGreaterThan(-1);
    expect(rootAt).toBeLessThan(returnAt);
  });
});

describe('the rotate prompt', () => {
  it('freezes the glyph upright from the resolved flag, not the OS preference alone', () => {
    // A landscape player cannot tap their way off this screen, so an infinite 2s
    // 90° loop running against an explicit `on` is a WCAG 2.2.2 (Pause, Stop,
    // Hide) failure with no exit. `rotate(0deg)` is the resting pose the
    // `auto`/reduce row already shipped, and the copy carries the instruction.
    expect(ruleBody('html.is-still .fatal__rotate-glyph')).toContain('animation: none');
    expect(ruleBody('html.is-still .fatal__rotate-glyph')).toContain('transform: rotate(0deg)');
  });

  it('keeps rotating under an explicit `off`, the same as every other animation', () => {
    // Row 2. `:not(.is-moving)` on the fallback is what buys this: before the
    // fix a reduce-preferring OS froze the glyph even for a player who had
    // switched reduced motion off.
    expect(css).toContain(`${ROOT_SCOPE} .fatal__rotate-glyph`);
    expect(css).not.toMatch(/^\s*\.fatal__rotate-glyph\s*\{\s*animation: none/m);
  });
});

/** The declarations of the first rule with this exact selector. */
function ruleBody(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at === -1) throw new Error(`no rule for \`${selector}\` in ui.css`);
  return css.slice(at, css.indexOf('}', at));
}

describe('the buy button reads the store', () => {
  it('emits `cta--still` from the resolved flag', () => {
    const still = ctaClassName({
      accent: 'cyan',
      affordable: true,
      inactive: false,
      maxed: false,
      pressed: true,
      still: true,
    });

    expect(still.split(' ')).toContain('cta--still');
    // Alongside the press class, not instead of it: the ring and the price
    // flash are keyed off `cta--pressed` and must survive.
    expect(still.split(' ')).toContain('cta--pressed');
  });

  it('emits it at rest too, because `:active` arrives without a render', () => {
    const atRest = ctaClassName({
      accent: 'cyan',
      affordable: true,
      inactive: false,
      maxed: false,
      pressed: false,
      still: true,
    });
    expect(atRest.split(' ')).toContain('cta--still');
  });

  it('withholds it when motion is allowed', () => {
    const moving = ctaClassName({
      accent: 'cyan',
      affordable: true,
      inactive: false,
      maxed: false,
      pressed: true,
      still: false,
    });
    expect(moving).not.toContain('cta--still');
  });

  it('is threaded the store value by `Sheet.tsx`, not a media query', () => {
    // Two assertions rather than one literal of the whole argument list. The
    // DUB-38/DUB-42 rebase added `maxed: isDone` to this same call, and a
    // literal of the full list failed on a change that had nothing to do with
    // motion — a brittle assertion that cried wolf. What has to hold is that
    // `still` is passed as the shorthand, and that the binding that shorthand
    // names is the resolved store value.
    expect(sheet).toContain('const still = useGameStore((s) => s.reducedMotion)');
    expect(sheet).toMatch(/ctaClassName\(\{[^}]*\bstill\s*[,}]/);
    expect(sheet).not.toContain('matchMedia');
  });

  it('sits alongside the maxed treatment, which met it on this same call (DUB-42)', () => {
    // `maxed` and `still` were threaded through `ctaClassName` by two different
    // tickets and met at merge time. Both have to survive: dropping `maxed` to
    // make the two fit puts the `aria-disabled` dim back on the button and the
    // gold MAXED badge under AA, and dropping `still` gives a player who asked
    // for less motion a button that shrinks under the thumb anyway.
    const classes = ctaClassName({
      accent: 'magenta',
      affordable: false,
      inactive: true,
      maxed: true,
      pressed: true,
      still: true,
    }).split(' ');

    expect(classes).toContain('cta--maxed');
    expect(classes).toContain('cta--still');
    expect(classes).toContain('cta--pressed');
  });

  it('cancels the scale with a selector a whole class clear of the press rule', () => {
    // `.cta--still` alone would be (0,1,0) and lose to `.cta.cta--pressed`
    // (0,2,0) — the specificity trap DUB-38 documented and the Door sheet fell
    // into before it.
    expect(classCount('.cta.cta--still.cta--pressed')).toBeGreaterThan(classCount('.cta.cta--pressed'));
    expect(classCount('.cta.cta--still:active')).toBeGreaterThan(classCount('.cta:active'));
    expect(css).toContain('.cta.cta--still.cta--pressed,');
  });
});

/** Class-ish components of a specificity, which is all these comparisons need. */
function classCount(selector: string): number {
  return (selector.match(/[.:][a-z-]+/g) ?? []).filter((part) => !part.startsWith('.cta--affordable')).length;
}

/* ---------------------------------------------------------------------------
 * The structural half: which signal does each rule in ui.css actually listen to?
 * ------------------------------------------------------------------------- */

const MEDIA_AT_RULE = '@media (prefers-reduced-motion: reduce)';
const ROOT_SCOPE = 'html:not(.is-moving)';

/**
 * The one screen that genuinely precedes the store. The boot spinner runs before
 * the saved preference has been read, and its block slows the spin (900ms ->
 * 2.4s) rather than stopping it, so there is no suppression here for the toggle
 * to be heard about.
 *
 * `.fatal__rotate-glyph` was on this list and should not have been (DUB-66).
 * Both halves of its recorded reason were false: `useMotionRootClass` runs above
 * the landscape early return in `App.tsx`, so the root class *does* reach the
 * rotate prompt; and the glyph *does* stop under the media query, which the
 * `auto`/reduce row has always shipped with the copy carrying the instruction
 * alone. The cost of the mistake was a 2s infinite 90° loop on an untappable
 * screen, served to a player who had just asked Settings for less motion.
 *
 * A reason that does not hold is worse than no reason, so anything added here
 * gets both halves checked: can the store speak for this screen, and does the
 * media query actually stop the animation?
 */
const OS_ONLY_SELECTORS = ['.boot__spinner'];

/**
 * Each root-scoped fallback and the resolved rule that has to exist alongside
 * it. Adding a motion suppression means adding a row here, which is the point:
 * the fallback cannot be the only path, or the toggle goes unheard again.
 */
const PAIRS = [
  { fallback: `${ROOT_SCOPE} .sheet`, resolved: 'html.is-still .sheet {' },
  { fallback: `${ROOT_SCOPE} .card`, resolved: 'html.is-still .card {' },
  { fallback: `${ROOT_SCOPE} .cta`, resolved: '.cta.cta--still.cta--pressed,' },
  {
    fallback: `${ROOT_SCOPE} .fatal__rotate-glyph`,
    resolved: 'html.is-still .fatal__rotate-glyph {',
  },
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The selector lists inside every `prefers-reduced-motion` block. */
function mediaBlockSelectors(source: string): string[][] {
  const blocks: string[][] = [];
  let from = 0;

  for (;;) {
    const at = source.indexOf(MEDIA_AT_RULE, from);
    if (at === -1) break;

    const open = source.indexOf('{', at);
    let depth = 0;
    let end = source.length;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    blocks.push(selectorsIn(source.slice(open + 1, end)));
    from = end;
  }

  return blocks;
}

function selectorsIn(body: string): string[] {
  const selectors: string[] = [];
  let depth = 0;
  let head = '';

  for (const char of body) {
    if (char === '{') {
      depth += 1;
      if (depth === 1) {
        selectors.push(
          ...head
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part.length > 0),
        );
        head = '';
      }
      continue;
    }
    if (char === '}') {
      depth -= 1;
      continue;
    }
    if (depth === 0) head += char;
  }

  return selectors;
}

describe('every reduced-motion rule in ui.css', () => {
  const blocks = mediaBlockSelectors(stripComments(css));

  it('is found by the parser at all', () => {
    // A sanity check on the parse, so a silent zero cannot pass the suite below.
    expect(blocks.length).toBeGreaterThanOrEqual(5);
    expect(blocks.flat().length).toBeGreaterThanOrEqual(blocks.length);
  });

  it('is either scoped to the resolved flag or a documented OS-only screen', () => {
    for (const selector of blocks.flat()) {
      const scoped = selector.startsWith(ROOT_SCOPE);
      const osOnly = OS_ONLY_SELECTORS.some((allowed) => selector.startsWith(allowed));

      expect(
        scoped || osOnly,
        `\`${selector}\` is suppressed by the OS preference alone, so the Settings ` +
          `toggle cannot reach it (DUB-49). Scope it \`${ROOT_SCOPE}\` and add a ` +
          `resolved rule, or add it to OS_ONLY_SELECTORS with the reason.`,
      ).toBe(true);
    }
  });

  it('has a resolved counterpart for every fallback, so the toggle is heard', () => {
    for (const selector of blocks.flat().filter((s) => s.startsWith(ROOT_SCOPE))) {
      const pair = PAIRS.find((candidate) => selector.startsWith(candidate.fallback));

      expect(pair, `no registered resolved rule for the fallback \`${selector}\``).toBeDefined();
      expect(css, `the resolved rule \`${pair?.resolved}\` is missing`).toContain(pair?.resolved ?? '');
    }
  });

  it('keeps the fallback, so first paint is still covered', () => {
    // The media query is not redundant. Before either root class is written,
    // and for a player who never opens Settings, it is the only signal there is.
    for (const pair of PAIRS) {
      expect(css).toContain(pair.fallback);
    }
  });

  it('never scopes a resolved rule behind the media query', () => {
    // `html.is-still` inside `@media (prefers-reduced-motion: reduce)` would
    // re-create the bug with extra steps: the toggle would only be honoured on
    // a device whose OS already agreed with it.
    for (const selector of blocks.flat()) {
      expect(selector).not.toContain(MOTION_STILL_CLASS);
      expect(selector).not.toContain('cta--still');
    }
  });
});
