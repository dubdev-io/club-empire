/**
 * Measure text contrast on the **live DOM**, from rendered pixels.
 *
 *   npm run measure:contrast           # dev server + Chrome --remote-debugging-port
 *   CLUB_URL=http://host:5173 node tools/contrast.ts
 *
 * Why this exists: a contrast ratio worked out from `tokens.css` is a guess.
 * DUB-36 quoted the MAXED badge at 3.13:1 from source; the real composited
 * figure was 4.31:1. The difference is a blanket `opacity` on an ancestor, and
 * no amount of reading the stylesheet tells you what the pixel ended up being.
 *
 * So this drives the real page, asks Chrome for the actual painted pixels over
 * each probe's box, and reports the ratio between the glyph colour it finds and
 * the surface behind it. The only inputs are pixels and the WCAG formula.
 *
 * It reports the **before** figure in the same run, by removing the class under
 * test from the live element and measuring again. One run, both numbers, same
 * browser, same font rasterisation.
 */

import { SAVE_STORAGE_KEY } from '../src/save/schema.ts';
import { Cdp, pageTarget, sleep } from './cdp.ts';
import { type Bitmap, decodePng } from './png.ts';

const BASE_URL = process.env.CLUB_URL ?? 'http://127.0.0.1:5173';

/** The viewports design review asks for. */
const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, scale: 2, mobile: true },
  { name: 'desktop', width: 1440, height: 900, scale: 1, mobile: false },
] as const;

interface Scene {
  readonly name: string;
  /** Reached through the real purchase functions, never by faking the UI. */
  readonly drive: string;
  readonly probes: readonly Probe[];
}

interface Probe {
  readonly name: string;
  /** What this number has to clear, and why it is on the list. */
  readonly note: string;
  readonly selector: string;
  /** WCAG AA floor. 4.5 for normal text, 3 for large text and non-text. */
  readonly floor: number;
  /**
   * A class to strip from the probe's `.cta` ancestor to recover the previous
   * rendering, so the run reports a measured before as well as an after.
   */
  readonly withoutClass?: string;
}

const BADGE: Probe = {
  name: 'MAXED badge',
  note: 'the reward the player earned — 14px/600, so 4.5:1 (DUB-42)',
  selector: '.cta--maxed .cta__done',
  floor: 4.5,
  withoutClass: 'cta--maxed',
};

const LABEL: Probe = {
  name: 'MAXED label',
  note: 'the dimmed half of the inert row — it carries the inert signal and still has to read',
  selector: '.cta--maxed .cta__label',
  floor: 4.5,
};

const SCENES: readonly Scene[] = [
  {
    // `grant(1e7)` leaves plenty of cash, so `+ Lane 2` on the same card stays
    // affordable — which is what makes the inert-beside-live comparison real.
    name: 'BARS, Tap Bar at Lv 30',
    drive: `
      window.__club.grant(1e7);
      for (let i = 0; i < 40; i++) window.__clubStore.getState().actions.upgradeStation('tap');
      window.__clubStore.getState().setStar(null);
      window.__clubStore.getState().openSheet('bars');
    `,
    probes: [
      BADGE,
      LABEL,
      {
        name: 'affordable price',
        note: 'the live row on the same card, for the inert-beside-live comparison',
        selector: '.cta:not([aria-disabled="true"]) .cta__price--affordable',
        floor: 4.5,
      },
    ],
  },
  {
    // The other place a badge can appear, and it sits on a different backdrop:
    // the DOOR sheet's button is on --bg-surface, not on a --bg-raised card.
    name: 'DOOR at max level',
    drive: `
      window.__club.buyAll();
      const s = window.__clubStore.getState();
      s.setShowComplete(false);
      s.setStar(null);
      s.openSheet('door');
    `,
    probes: [BADGE, LABEL],
  },
];

// ---------------------------------------------------------------------------
// WCAG
// ---------------------------------------------------------------------------

type Rgb = readonly [number, number, number];

/** WCAG 2.x relative luminance of an 8-bit sRGB triplet. */
function luminance([r, g, b]: Rgb): number {
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const hex = ([r, g, b]: Rgb): string =>
  `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/**
 * Pick the glyph colour and the surface colour out of a patch of text.
 *
 * The surface is the most common pixel: a text box is mostly background. The
 * glyph is the pixel furthest from it in luminance — the interior of a stem,
 * where antialiasing has not diluted the colour. Taking the extreme rather than
 * an average is deliberate: WCAG asks about the text colour as specified, and
 * an average over a glyph's soft edge would flatter every ratio.
 */
function sample(bitmap: Bitmap): { text: Rgb; surface: Rgb; pixels: number } {
  const counts = new Map<number, number>();
  for (let i = 0; i < bitmap.rgb.length; i += 3) {
    const key = (bitmap.rgb[i]! << 16) | (bitmap.rgb[i + 1]! << 8) | bitmap.rgb[i + 2]!;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let surfaceKey = 0;
  let best = -1;
  for (const [key, count] of counts) {
    if (count > best) {
      best = count;
      surfaceKey = key;
    }
  }
  const surface: Rgb = [(surfaceKey >> 16) & 0xff, (surfaceKey >> 8) & 0xff, surfaceKey & 0xff];
  const surfaceLuminance = luminance(surface);

  let text = surface;
  let furthest = 0;
  for (const key of counts.keys()) {
    const pixel: Rgb = [(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff];
    const distance = Math.abs(luminance(pixel) - surfaceLuminance);
    if (distance > furthest) {
      furthest = distance;
      text = pixel;
    }
  }

  return { text, surface, pixels: bitmap.width * bitmap.height };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The painted colours over one element's box, at 4x for a clean glyph core. */
async function measure(
  cdp: Cdp,
  selector: string,
): Promise<{ text: Rgb; surface: Rgb; pixels: number } | null> {
  const box = await cdp.evaluate<Box | null>(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  `);
  if (box === null) return null;

  const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { ...box, scale: 4 },
  });
  return sample(decodePng(Buffer.from(data, 'base64')));
}

async function main(): Promise<void> {
  const cdp = await Cdp.connect(await pageTarget());
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });

  let failures = 0;

  for (const viewport of VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.scale,
      mobile: viewport.mobile,
    });

    for (const scene of SCENES) {
      // Clear the save on the no-boot page first, then load the real one. A
      // scene that drives `buyAll()` writes that club to `localStorage` on
      // `pagehide`, and the next scene would load it: the BARS scene silently
      // became "everything already maxed", with no affordable row left to
      // compare against. Same ordering as `screenshots.ts`, for the same reason.
      await cdp.send('Page.navigate', { url: `${BASE_URL}/?noboot=1` });
      await sleep(400);
      await cdp.evaluate(`localStorage.removeItem(${JSON.stringify(SAVE_STORAGE_KEY)}); return true;`);

      await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await sleep(100);
        const ready = await cdp
          .evaluate<boolean>('return Boolean(window.__clubStore) && Boolean(window.__club);')
          .catch(() => false);
        if (ready) break;
      }
      await cdp.evaluate(`${scene.drive} return true;`);

      // Wait for the row rather than for a fixed delay. `buyAll()` fires the ★
      // celebration, and how long that takes to clear the sheet is not something
      // to guess at: a 900 ms sleep measured the DOOR sheet correctly at
      // 1440x900 and found nothing at all at 390x844.
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await sleep(100);
        const shown = await cdp
          .evaluate<boolean>(
            `const el = document.querySelector('.cta--maxed .cta__done');
             return el !== null && el.getBoundingClientRect().width > 0;`,
          )
          .catch(() => false);
        if (shown) break;
      }
      await sleep(300);

      console.log(
        `\n${viewport.name}  ${viewport.width}x${viewport.height} @${viewport.scale}x  —  ${scene.name}`,
      );

      failures += await report(cdp, scene.probes);
    }
  }

  cdp.close();
  if (failures > 0) {
    console.error(`\n${failures} probe(s) below the AA floor.`);
    process.exit(1);
  }
  console.log('\nEvery probe clears its AA floor.');
}

/** Measure each probe on the page as it stands, and return the failure count. */
async function report(cdp: Cdp, probes: readonly Probe[]): Promise<number> {
  let failures = 0;
  for (const probe of probes) {
    const after = await measure(cdp, probe.selector);
    if (after === null) {
      console.log(`  ${probe.name.padEnd(18)} NOT FOUND (${probe.selector})`);
      failures += 1;
      continue;
    }

    const ratio = contrast(after.text, after.surface);
    const verdict = ratio >= probe.floor ? 'PASS' : 'FAIL';
    if (ratio < probe.floor) failures += 1;
    console.log(
      `  ${probe.name.padEnd(18)} ${ratio.toFixed(2).padStart(5)}:1  ` +
        `${hex(after.text)} on ${hex(after.surface)}  needs ${probe.floor.toFixed(1)}:1  ${verdict}`,
    );
    console.log(`  ${''.padEnd(18)} ${probe.note}`);

    if (probe.withoutClass !== undefined) {
      // Measured before: strip the class on the live element and look again.
      const stripped = await cdp.evaluate<boolean>(`
          const el = document.querySelector(${JSON.stringify(probe.selector)});
          const cta = el?.closest('.cta');
          if (!cta) return false;
          cta.classList.remove(${JSON.stringify(probe.withoutClass)});
          return true;
        `);
      if (stripped) {
        // The probe's selector named the class we just removed, so re-aim it
        // at the same element by what is left of it.
        const bare = probe.selector.replace(
          `.${probe.withoutClass} `,
          '.cta[aria-disabled="true"] ',
        );
        const before = await measure(cdp, bare);
        if (before !== null) {
          console.log(
            `  ${''.padEnd(18)} before (no .${probe.withoutClass}): ` +
              `${contrast(before.text, before.surface).toFixed(2)}:1  ` +
              `${hex(before.text)} on ${hex(before.surface)}`,
          );
        }
        await cdp.evaluate(`
            document
              .querySelector('.cta__done')
              ?.closest('.cta')
              ?.classList.add(${JSON.stringify(probe.withoutClass)});
            return true;
          `);
      }
    }
  }
  return failures;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
