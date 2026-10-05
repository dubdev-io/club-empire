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
 *
 * A measurement harness that reports a wrong number is worse than no harness,
 * because the number carries authority. So three things here are deliberately
 * paranoid rather than merely convenient (DUB-54):
 *
 *  - every navigation waits for the *new* document to be the one answering, so
 *    a readiness poll can never be satisfied by the page being left behind;
 *  - every box is read twice `SETTLE_MS` apart and used only once the two reads
 *    agree, so a clip cannot land where the row used to be;
 *  - the glyph colour has to cover `glyphFloor` pixels, and the run prints how
 *    many it covered, so no single antialiased pixel can set a ratio.
 */

import { SAVE_STORAGE_KEY } from '../src/save/schema.ts';
import { Cdp, navigate, pageTarget, retry, sleep } from './cdp.ts';
import type { Sample } from './pixels.ts';
import { contrast, decodePng, hex, sample } from './pixels.ts';

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
// Run
// ---------------------------------------------------------------------------

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How far apart the two agreeing reads of a box have to be. */
const SETTLE_MS = 500;

/** One read of an element's box, or null if it is absent or has no area. */
async function readBox(cdp: Cdp, selector: string): Promise<Box | null> {
  return cdp
    .evaluate<Box | null>(`
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    `)
    .catch(() => null);
}

const sameBox = (a: Box, b: Box): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * An element's box, once it has stopped moving.
 *
 * A non-zero width is not a settled layout. The sheet animates in, so the box
 * can be read at one position and the screenshot clipped after the row has
 * moved — and the clip then lands on whatever is now under those coordinates.
 * That is DUB-54: the badge probe clipped the `+ Lane 2` button one row below
 * and reported 1.00:1 cyan-on-cyan for a probe that measures 11.68:1.
 *
 * So require two reads `SETTLE_MS` apart to agree before trusting either. No
 * flat sleep can do this job: 300 ms is too short for the ★ celebration to
 * clear the sheet at 390x844 and wasted time once it has.
 */
async function stableBox(cdp: Cdp, selector: string, timeoutMs = 15_000): Promise<Box | null> {
  const deadline = Date.now() + timeoutMs;
  let previous = await readBox(cdp, selector);
  while (Date.now() < deadline) {
    await sleep(SETTLE_MS);
    const current = await readBox(cdp, selector);
    if (current !== null && previous !== null && sameBox(previous, current)) return current;
    previous = current;
  }
  return null;
}

/**
 * Wait until the game has booted on the current document.
 *
 * Generous on purpose. The first scene of a run loads a **cold** dev server,
 * so Vite is transforming the module graph on demand while Chrome is bringing
 * up a software WebGL context and generating every texture; `window.__club`
 * only exists once `startGame` has resolved past all of that. A 6 s budget
 * measured the second and later scenes fine and lost the first one outright.
 * The deadline is here to produce a clear error, not to bound a healthy run —
 * a warm scene gets past it in well under a second.
 */
async function waitForBoot(cdp: Cdp, scene: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const booted = await cdp
      .evaluate<boolean>('return Boolean(window.__clubStore) && Boolean(window.__club);')
      .catch(() => false);
    if (booted) return;
    await sleep(100);
  }
  throw new Error(`the game did not boot within ${timeoutMs} ms for scene "${scene}"`);
}

/** The painted colours over one element's box, at 4x for a clean glyph core. */
async function measure(cdp: Cdp, selector: string): Promise<Sample | null> {
  const box = await stableBox(cdp, selector);
  if (box === null) return null;

  // 10 s rather than the client's 30 s default: a stalled capture is stalled
  // on the first frame, and the retry is the thing that recovers it.
  const { data } = await retry(`screenshot of ${selector}`, () =>
    cdp.send<{ data: string }>(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false, clip: { ...box, scale: 4 } },
      10_000,
    ),
  );
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
      // `navigate` does not return until the new document is the one
      // answering. Polling readiness without that barrier lets the *previous*
      // scene's booted page satisfy `window.__club !== undefined`, so the drive
      // script runs against a document that is about to be destroyed and the
      // whole scene is measured on a page nobody set up (DUB-54).
      await navigate(cdp, `${BASE_URL}/?noboot=1`);
      await cdp.evaluate(`localStorage.removeItem(${JSON.stringify(SAVE_STORAGE_KEY)}); return true;`);

      await navigate(cdp, `${BASE_URL}/`);
      await waitForBoot(cdp, scene.name);
      await cdp.evaluate(`${scene.drive} return true;`);

      // Wait for the badge row to stop moving, not merely to exist. `buyAll()`
      // fires the ★ celebration and the sheet animates in behind it; how long
      // that takes is not something to guess at — a 900 ms sleep measured the
      // DOOR sheet correctly at 1440x900 and found nothing at all at 390x844,
      // and a 300 ms one read the box mid-animation.
      if ((await stableBox(cdp, BADGE.selector)) === null) {
        throw new Error(`the MAXED badge never settled for scene "${scene.name}"`);
      }

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

    if (after.textPixels === 0) {
      // No colour in the patch cleared the coverage floor, so there is nothing
      // to call the glyph. Reporting a ratio here would be inventing one.
      console.log(
        `  ${probe.name.padEnd(18)} NO GLYPH over ${after.pixels} px ` +
          `(all of it ${hex(after.surface)}) — ${probe.selector}`,
      );
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
    console.log(
      `  ${''.padEnd(18)} glyph colour on ${after.textPixels} of ${after.pixels} sampled px`,
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
        if (before !== null && before.textPixels > 0) {
          console.log(
            `  ${''.padEnd(18)} before (no .${probe.withoutClass}): ` +
              `${contrast(before.text, before.surface).toFixed(2)}:1  ` +
              `${hex(before.text)} on ${hex(before.surface)}  ` +
              `(${before.textPixels} of ${before.pixels} px)`,
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
