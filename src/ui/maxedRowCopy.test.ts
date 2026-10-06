import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A finished row says each thing once (DUB-55).
 *
 * The duplication this pins against was never written on purpose. The Bars and
 * Door sheets grew their terminal states separately, both reached for "say it
 * is finished", and both put it in *both* columns: `Lv 30 — maxed` beside
 * `Lv 30 of 30`. Nothing failed, so it survived two design passes and was only
 * caught once DUB-42 made the badge bright enough to read.
 *
 * So the guard is on the shape of the pair, not on the exact words. The rule a
 * future edit has to keep is the column contract the live rows establish:
 *
 *      Upgrade to Lv 8   £282      left: what you get. right: the deal.
 *      + Lane 2          £7k
 *      Lv 30             MAXED     a finished axis fills the same two slots.
 *      3 lanes           MAXED
 *
 * Which gives two checks. The badge is the single state word, carrying no
 * number — so a pair physically cannot state the level twice. And the label
 * keeps stating the thing, so it must not say "maxed" as well.
 *
 * This reads source rather than rendering, for the same reason
 * `ctaContrast.test.ts` does: there is no React renderer in devDependencies,
 * and the cheap guard that runs in CI is worth more than no guard at all.
 *
 * The first version of this file was reviewed and sent back, which is worth
 * recording here because the failure is the one the whole file is about. Its
 * matcher was anchored to a single line. Review restored the exact old copy,
 * hand-wrapped the prop across three lines — the house style — and the suite
 * came back green: the regression was back on the page wearing a passing
 * check. A guard that reads source has two ways to be wrong, and only one of
 * them is loud. So every matcher below is either brace-scanned or
 * count-pinned, and `ROWS` fails the moment a matcher finds a different number
 * of rows than the file has.
 */

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const SHEETS = [
  { file: 'BarsSheet.tsx', source: read('./BarsSheet.tsx') },
  { file: 'DoorSheet.tsx', source: read('./DoorSheet.tsx') },
] as const;

/**
 * How many buy rows each sheet has, and how many of them can finish.
 *
 * Pinned, not derived, because "the matcher quietly found nothing" and "the
 * sheet quietly lost a row" look identical to every assertion below. Adding or
 * removing a row is a deliberate edit, so updating these two numbers is part
 * of making it.
 */
const ROWS = {
  'BarsSheet.tsx': { buttons: 3, terminal: 2 },
  'DoorSheet.tsx': { buttons: 1, terminal: 1 },
} as const satisfies Record<(typeof SHEETS)[number]['file'], { buttons: number; terminal: number }>;

const stripComments = (source: string): string => source.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

/**
 * The copy inside a prop value — the quoted and backticked literals only.
 *
 * `station.maxed ? \`Lv ${MAX}\` : …` is a ternary whose *condition* contains
 * the word "maxed". That is a variable name, not something the player reads, so
 * asserting over the raw expression would fail on the identifier and tell us
 * nothing. Only the literals are copy.
 *
 * `${…}` holes are replaced with a digit rather than dropped, so a template
 * reduces to the shape the player sees: `Lv ${MAX_STATION_LEVEL}` -> `Lv 0`.
 */
function copyIn(expression: string): readonly string[] {
  return [...expression.matchAll(/`([^`]*)`|'([^']*)'|"([^"]*)"/g)]
    .map((m) => (m[1] ?? m[2] ?? m[3]!).replace(/\$\{[^}]*\}/g, '0'))
    .filter((text) => text.length > 0);
}

/** Every `<BuyButton … />` element in a sheet, as its raw block of props. */
function buyButtons(source: string): readonly string[] {
  return [...stripComments(source).matchAll(/<BuyButton\b([\s\S]*?)\/>/g)].map((m) => m[1]!);
}

/**
 * One prop's value as written, or null when the element has no such prop.
 *
 * Hand-scanned to the matching brace rather than regex-matched. This is the
 * required fix from review: the regex it replaces was `^\s*doneLabel=\{(.*)\}$`
 * per line, so wrapping a prop made it match nothing, and nothing downstream
 * noticed — the *other* row's `MAXED` kept the collected set correct. A brace
 * scanner cannot stop matching for a formatting reason, and a prop that is
 * genuinely absent comes back null rather than silently empty.
 *
 * Nested `${…}` holes balance, so depth counting handles them. A literal brace
 * inside a string would not, but it would come back as unbalanced and fail the
 * non-null assertions at the call sites rather than pass quietly.
 */
function propValue(element: string, name: string): string | null {
  // `(?:^|\s)` so `label` cannot also match the tail of `doneLabel`.
  const found = new RegExp(`(?:^|\\s)${name}=`).exec(element);
  if (found === null) return null;

  const start = found.index + found[0].length;
  const quote = element[start];
  if (quote === '"' || quote === "'") {
    const end = element.indexOf(quote, start + 1);
    return end === -1 ? null : element.slice(start, end + 1);
  }
  if (quote !== '{') return null;

  let depth = 0;
  for (let i = start; i < element.length; i += 1) {
    if (element[i] === '{') depth += 1;
    else if (element[i] === '}') {
      depth -= 1;
      if (depth === 0) return element.slice(start + 1, i);
    }
  }
  return null;
}

describe('a maxed row states each fact once (DUB-55)', () => {
  for (const { file, source } of SHEETS) {
    describe(file, () => {
      const buttons = buyButtons(source);
      const terminal = buttons.filter((b) => propValue(b, 'doneLabel') !== null);

      it('finds every buy row, so the checks below are not vacuous', () => {
        // The guard on the guard. If `buyButtons` or `propValue` stops seeing
        // the shape of the file, this is what says so — rather than three
        // assertions passing over an empty list.
        expect(buttons, `${file}: buy rows found`).toHaveLength(ROWS[file].buttons);
        expect(terminal, `${file}: rows that can finish`).toHaveLength(ROWS[file].terminal);
      });

      it('puts the bare state word in the badge, and nothing else', () => {
        for (const button of terminal) {
          const badge = propValue(button, 'doneLabel');
          // `Maxed` and only `Maxed`. Anything that interpolates — the old
          // `Lv ${MAX} of ${MAX}` — reduces to `Lv 0 of 0` here and fails,
          // which is the point: it puts a number back in the column the player
          // reads as "the deal".
          expect(new Set(copyIn(badge!)), `${file}: the badge is the state word`).toEqual(
            new Set(['Maxed']),
          );
        }
      });

      it('leaves the terminal word out of the label, so it is said once', () => {
        for (const button of buttons) {
          const label = propValue(button, 'label');
          expect(label, `${file}: every buy row has a label`).not.toBeNull();

          for (const text of copyIn(label!)) {
            expect(text.toLowerCase(), `${file}: the badge already says it`).not.toContain('maxed');
          }
        }
      });

      it('still names the thing in the label — the badge is not the whole row', () => {
        // The third candidate in the ticket was dropping the label entirely and
        // letting the badge sit alone. It was rejected: the left edge is how the
        // eye tracks the column past the live rows above. So a finished row
        // keeps copy on the left, never a bare badge.
        //
        // Only the rows that can finish. Review caught this asserting over
        // every braced label in the sheet, which made an unrelated edit — the
        // locked row's `label="Unlock"` becoming interpolated — fail the DUB-55
        // guard with a message about terminal state.
        for (const button of terminal) {
          const label = propValue(button, 'label')!;
          // Each is a ternary over the terminal condition, so both branches
          // have to carry copy. `copyIn` drops empty literals, which is what
          // makes `? '' :` fail here rather than pass silently.
          expect(copyIn(label), `${file}: both branches of ${label.trim()} need copy`).toHaveLength(
            2,
          );
        }
      });
    });
  }

  it('the lane row keeps its count', () => {
    const bars = SHEETS.find((s) => s.file === 'BarsSheet.tsx')!.source;
    expect(bars).toContain('`${MAX_LANES} lanes`');
  });

  it('the badge is uppercased by the stylesheet, not by the copy', () => {
    // The badge renders MAXED but the JSX says `Maxed`, which is the house
    // pattern: `.door-compare__label` ("Arriving", "Can serve") and
    // `.card__title` both pair this same `0.08em` tracking with a
    // `text-transform`, and sentence-case copy keeps a screen reader from
    // getting the chance to spell a caps word out.
    //
    // Pinned because the two halves live in different files. Drop the rule and
    // the badge quietly becomes the only sentence-case thing in a row of caps,
    // which is exactly the kind of silent drift this file exists for.
    const css = read('./ui.css');
    const rule = /\.cta__done\s*\{([^}]*)\}/.exec(css);
    expect(rule, 'ui.css: .cta__done rule found').not.toBeNull();
    expect(rule![1]).toContain('text-transform: uppercase');
  });
});
