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
 */

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const SHEETS = [
  { file: 'BarsSheet.tsx', source: read('./BarsSheet.tsx') },
  { file: 'DoorSheet.tsx', source: read('./DoorSheet.tsx') },
] as const;

const stripComments = (source: string): string => source.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

/**
 * The copy inside a prop expression — the quoted and backticked literals only.
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
  return [...expression.matchAll(/`([^`]*)`|'([^']*)'/g)]
    .map((m) => (m[1] ?? m[2]!).replace(/\$\{[^}]*\}/g, '0'))
    .filter((text) => text.length > 0);
}

/**
 * The copy in every `doneLabel={...}` prop in a file.
 *
 * Greedy to the last `}` on the line, not lazy to the first: the shape being
 * guarded against is `` `Lv ${MAX} of ${MAX}` ``, which carries its own closing
 * braces. A lazy match stops inside the first `${…}` and hands back an
 * expression with no literal in it, so the regression would sail through.
 */
function doneLabelCopy(source: string): readonly string[] {
  return [...stripComments(source).matchAll(/^\s*doneLabel=\{(.*)\}\s*$/gm)].flatMap((m) =>
    copyIn(m[1]!),
  );
}

/**
 * Every `label={...}` prop expression, one entry per button.
 *
 * `label=` is matched at a line start so it cannot also catch `doneLabel=`, and
 * the value runs to the line that closes it. Both sheets write these as a whole
 * prop per line or per block, and the non-empty assertions below are what fail
 * loudly if that stops being true.
 */
function labelProps(source: string): readonly string[] {
  return [...stripComments(source).matchAll(/\n\s*label=\{([\s\S]*?)\}\n/g)].map((m) => m[1]!);
}

/** The copy in every `label={...}` prop in a file, flattened. */
function labelCopy(source: string): readonly string[] {
  return labelProps(source).flatMap(copyIn);
}

describe('a maxed row states each fact once (DUB-55)', () => {
  for (const { file, source } of SHEETS) {
    describe(file, () => {
      it('puts the bare state word in the badge, and nothing else', () => {
        const found = doneLabelCopy(source);
        // A sheet that stopped using `doneLabel` would make every assertion
        // below vacuous, so the count is part of the test.
        expect(found).not.toHaveLength(0);

        // `MAXED` and only `MAXED`. Anything that interpolates — the old
        // `Lv ${MAX} of ${MAX}` — reduces to `Lv 0 of 0` here and fails, which
        // is the point: it puts a number back in the column the player reads
        // as "the deal".
        expect(new Set(found), `${file}: the badge is the state word`).toEqual(new Set(['MAXED']));
      });

      it('leaves the terminal word out of the label, so it is said once', () => {
        const found = labelCopy(source);
        expect(found).not.toHaveLength(0);

        for (const text of found) {
          expect(text.toLowerCase(), `${file}: the badge already says it`).not.toContain('maxed');
        }
      });

      it('still names the thing in the label — the badge is not the whole row', () => {
        // The third candidate in the ticket was dropping the label entirely and
        // letting the badge sit alone. It was rejected: the left edge is how the
        // eye tracks the column past the live rows above. So a finished row
        // keeps copy on the left, never a bare badge.
        //
        // Each label is a ternary over the terminal condition, so both branches
        // have to carry copy. `copyIn` drops empty literals, which is what makes
        // `?  '' :` fail here rather than pass silently.
        for (const prop of labelProps(source)) {
          expect(copyIn(prop), `${file}: both branches of ${prop.trim()} need copy`).toHaveLength(
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
});
