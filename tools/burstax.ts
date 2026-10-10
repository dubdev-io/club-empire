/**
 * Does the ★ burst actually expose its star count?
 *
 *   npm run a11y:burst            # dev server must already be running
 *
 * Reads Chrome's own accessibility tree for the `role="status"` burst at one,
 * two and three stars and prints what a screen reader would be handed. The
 * DUB-56 nit was that all three announced identically, because the glyph row
 * was `aria-hidden`; three different names here is the evidence that they no
 * longer do, and it is a check on the browser's computed tree rather than on
 * what the JSX looks like it should produce.
 */

import { Cdp, pageTarget, sleep } from './cdp.ts';
import { SAVE_STORAGE_KEY } from '../src/save/schema.ts';

const BASE_URL = process.env.CLUB_URL ?? 'http://127.0.0.1:5190';
const CDP_URL = process.env.CLUB_CDP ?? 'http://127.0.0.1:9242';

interface AXNode {
  nodeId: string;
  role?: { value?: string };
  name?: { value?: string };
  childIds?: string[];
  ignored?: boolean;
}

async function waitForBoot(cdp: Cdp): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await sleep(250);
    const ready = await cdp
      .evaluate<boolean>(`return typeof window.__club?.grant === 'function';`)
      .catch(() => false);
    if (ready) {
      await sleep(600);
      return;
    }
  }
  throw new Error('game never booted');
}

async function main(): Promise<void> {
  const cdp = await Cdp.connect(await pageTarget(CDP_URL));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Accessibility.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });

  for (const stars of [1, 2, 3]) {
    await cdp.send('Page.navigate', { url: `${BASE_URL}/?noboot=1` });
    await sleep(500);
    await cdp.evaluate(`localStorage.removeItem(${JSON.stringify(SAVE_STORAGE_KEY)}); return 1;`);
    await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
    await waitForBoot(cdp);

    // Fire the burst through the real store, at the level that earns `stars`.
    await cdp.evaluate(`
      window.__clubStore.getState().setStar({
        station: 'tap', level: ${stars * 10}, stars: ${stars},
      });
      return 1;
    `);
    await sleep(400);

    const { nodes } = await cdp.send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree');
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));

    const status = nodes.find((n) => n.role?.value === 'status');
    if (status === undefined) {
      console.log(`${stars} star(s): no role=status node in the tree`);
      continue;
    }

    // The whole subtree, roles and names, in tree order — no guessing at which
    // roles Chrome uses.
    const lines: string[] = [];
    const walk = (node: AXNode | undefined, depth: number): void => {
      if (node === undefined) return;
      const name = node.name?.value?.trim() ?? '';
      const role = node.role?.value ?? '?';
      lines.push(
        `${'  '.repeat(depth)}${role}${node.ignored === true ? ' (ignored)' : ''}` +
          (name === '' ? '' : ` "${name}"`),
      );
      for (const id of node.childIds ?? []) walk(byId.get(id), depth + 1);
    };
    walk(status, 1);

    console.log(`--- ${stars} star(s) ---`);
    console.log(lines.join('\n'));
  }

  cdp.close();
}

await main();
