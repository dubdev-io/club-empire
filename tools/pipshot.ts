/**
 * Is an unearned ★ pip identifiable as unearned in greyscale?
 *
 *   npm run shots:pips            # dev server must already be running
 *
 * DUB-56's acceptance criterion, as something that can be re-run rather than
 * taken on trust — the designer who wrote the asset spec has to be able to
 * check whether the stroke reads. Drives the real game to Lv 10 (★ ☆ ☆) and
 * Lv 20 (★ ★ ☆) on the Tap Bar, captures the pip row at 390x844 at DPR 2 and
 * DPR 3 in colour and in greyscale, and reports each pip's ink coverage.
 *
 * Coverage is the objective form of the acceptance criterion. A filled star and
 * a hollow one of the same silhouette differ by the area of the interior, so two
 * numbers far apart mean the shape is carrying the signal and the hue is not
 * needed to read it. Two numbers close together would mean the stroke has
 * effectively filled the star in and the fix does nothing.
 *
 * The crop is computed, not eyeballed: the design space *is* 390x844, so
 * `stage.ts`'s letterbox scale is 1 at the review viewport and a design pixel is
 * a CSS pixel. Greyscale is applied in the page as a real CSS filter, so the
 * capture is a rendering and not a post-hoc image edit.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { Cdp, pageTarget, sleep } from './cdp.ts';
import { SAVE_STORAGE_KEY } from '../src/save/schema.ts';
import { STATION_SLOT_HEIGHT, STATION_SLOT_WIDTH, stationSlot } from '../src/render/layout.ts';

const BASE_URL = process.env.CLUB_URL ?? 'http://127.0.0.1:5190';
const CDP_URL = process.env.CLUB_CDP ?? 'http://127.0.0.1:9242';
const OUT = process.env.PIPSHOT_OUT ?? 'pipshots';

/** Mirrors the pip placement in `clubScene.ts`. */
const PIP_SIZE = 14;
const PIP_SPACING = 18;
const slot = stationSlot('tap');
const PIP_CENTRE_X = slot.x + STATION_SLOT_WIDTH / 2;
const PIP_CENTRE_Y = slot.y + STATION_SLOT_HEIGHT - 9;

/**
 * One `PIP_SPACING` column per pip, so splitting the capture in three is a
 * clean per-pip split. Tall enough to hold a whole pip with a little air.
 */
const CLIP = {
  x: PIP_CENTRE_X - PIP_SPACING * 1.5,
  y: PIP_CENTRE_Y - (PIP_SIZE + 4) / 2,
  width: PIP_SPACING * 3,
  height: PIP_SIZE + 4,
};

const LEVELS = [10, 20] as const;
const DPRS = [2, 3] as const;

/**
 * Wait for the dev hooks to exist, rather than guessing a settle time.
 * Software GL boots an order of magnitude slower than a real device.
 */
async function waitForBoot(cdp: Cdp): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await sleep(250);
    const ready = await cdp
      .evaluate<boolean>(`return typeof window.__club?.grant === 'function';`)
      .catch(() => false);
    if (ready) {
      // One more beat so the first frames have drawn.
      await sleep(600);
      return;
    }
  }
  throw new Error('game never booted');
}

async function shoot(cdp: Cdp, path: string, scale = 1): Promise<string> {
  const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
    clip: { ...CLIP, scale },
    captureBeyondViewport: false,
  });
  await writeFile(path, Buffer.from(shot.data, 'base64'));
  return shot.data;
}

/**
 * Per-pip ink coverage, read back out of the captured PNG.
 *
 * Decoded by handing the PNG back to the page rather than by adding an image
 * library: the browser already has a decoder, and a 2D canvas `getImageData` on
 * a composited screenshot is reliable in a way `drawImage` off a live WebGL
 * canvas is not (Pixi runs with `preserveDrawingBuffer: false`).
 */
interface PipRead {
  /** Share of the pip's column that is ink. A hollow star is much less than a filled one. */
  readonly coverage: number;
  /** Mean luminance of the star's middle — solid for ★, background for ☆. */
  readonly centre: number;
}

async function coverage(cdp: Cdp, pngBase64: string): Promise<PipRead[]> {
  // `Cdp.evaluate` wraps the body in a plain IIFE, so this returns the promise
  // for `awaitPromise` rather than using `await` directly.
  return cdp.evaluate<PipRead[]>(`
    const img = new Image();
    img.src = 'data:image/png;base64,${pngBase64}';
    return img.decode().then(() => {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      const colWidth = img.width / 3;
      const out = [];
      for (let col = 0; col < 3; col++) {
        const x0 = Math.round(col * colWidth);
        const w = Math.round(colWidth);
        const data = ctx.getImageData(x0, 0, w, img.height).data;
        let lit = 0, total = 0;
        for (let i = 0; i < data.length; i += 4) {
          total += 1;
          // --bg-raised, the tile the pips sit on, is well under this.
          if (lum(data, i) > 70) lit += 1;
        }
        // The body of the star, a third of the pip box wide and centred on it.
        // A five-pointed star's waist sits well outside this, so a filled pip is
        // solid here and a hollow one is whatever is behind it.
        const inner = Math.max(2, Math.round(w / 3));
        const cx = x0 + Math.round((w - inner) / 2);
        const cy = Math.round((img.height - inner) / 2);
        const mid = ctx.getImageData(cx, cy, inner, inner).data;
        let sum = 0, n = 0;
        for (let i = 0; i < mid.length; i += 4) { sum += lum(mid, i); n += 1; }
        out.push({
          coverage: Math.round((lit / total) * 1000) / 10,
          centre: Math.round((sum / n) * 10) / 10,
        });
      }
      return out;
    });
  `);
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const cdp = await Cdp.connect(await pageTarget(CDP_URL));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  console.log(`clip ${JSON.stringify(CLIP)} (design px == css px at 390x844)`);

  for (const dpr of DPRS) {
    for (const level of LEVELS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: dpr,
        mobile: true,
      });

      // Seed on `?noboot=1`, then navigate to the real page — the same dance
      // `screenshots.ts` documents. Clearing the save on a page with a running
      // game does not work: navigating away fires `pagehide` and the outgoing
      // game writes its level straight back over the clear, which is how the
      // first attempt at this reported Lv 19 for a Lv 10 run.
      await cdp.send('Page.navigate', { url: `${BASE_URL}/?noboot=1` });
      // Poll rather than sleep: touching `localStorage` before the new document
      // has replaced `about:blank` throws a SecurityError on the opaque origin.
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await sleep(250);
        const cleared = await cdp
          .evaluate<boolean>(
            `localStorage.removeItem(${JSON.stringify(SAVE_STORAGE_KEY)}); return true;`,
          )
          .catch(() => false);
        if (cleared) break;
      }
      await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
      await waitForBoot(cdp);

      await cdp.evaluate(`
        window.__club.grant(1e9);
        for (let i = 0; i < ${level - 1}; i++) {
          window.__clubStore.getState().actions.upgradeStation('tap');
        }
        window.__clubStore.getState().setStar(null);
        return window.__club.state().stations.find((s) => s.key === 'tap').level;
      `);
      await sleep(1000);

      const reached = await cdp.evaluate<number>(
        `return window.__club.state().stations.find((s) => s.key === 'tap').level;`,
      );

      const name = `pips-lv${level}-dpr${dpr}`;
      await shoot(cdp, `${OUT}/${name}.png`);

      await cdp.evaluate(`document.documentElement.style.filter = 'grayscale(1)'; return 1;`);
      await sleep(350);
      const greyData = await shoot(cdp, `${OUT}/${name}-grey.png`);
      // The same greyscale frame magnified, for a human to judge the stroke on.
      // Coverage is measured off the 1:1 capture above, never off this one.
      await shoot(cdp, `${OUT}/${name}-grey-x8.png`, 8);
      const cov = await coverage(cdp, greyData);
      await cdp.evaluate(`document.documentElement.style.filter = ''; return 1;`);

      console.log(
        `${name}  tap Lv ${reached}  greyscale  ` +
          cov.map((c) => `[ink ${c.coverage}% centre ${c.centre}]`).join(' '),
      );
    }
  }

  cdp.close();
}

await main();
