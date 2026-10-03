/**
 * Per-system frame time at the §11 worst case.
 *
 *   npm run measure:frames        # dev server + headless Chrome must be up
 *
 * **This is not an fps measurement, and must not be reported as one.** QA's
 * container and this one have no GPU, so WebGL runs on a software rasteriser
 * and any frame rate measured here says more about the rasteriser than about a
 * Pixel 6a. Acceptance criterion 8 asks for >= 50 fps on mid-range Android, and
 * nothing in this environment can answer that honestly.
 *
 * What it *can* answer is the CPU-side half, which is the half we control:
 * simulation, scene update, UI publish, and draw-call submission, measured
 * separately at 30 rendered guests / 9 bartenders / 4 queues — the ceiling §11
 * permits. If that is already eating the 16.6 ms budget, no GPU will save it;
 * if it is a small fraction, the remaining risk is GPU-side and has to be
 * measured on a real device.
 *
 * Reported as p95, not mean. Dropped frames are a tail problem and a 60 fps
 * average with a 40 ms p95 stutters visibly.
 */

const BASE_URL = process.env.CLUB_URL ?? 'http://127.0.0.1:5173';
const DEBUG_URL = process.env.CLUB_CDP ?? 'http://127.0.0.1:9222';

/** How long to let the scene run before reading the distribution. */
const SAMPLE_MS = Number(process.env.CLUB_SAMPLE_MS ?? 20_000);

interface PhaseReport {
  avgMs: number;
  p95Ms: number;
  maxMs: number;
}

interface FrameReport {
  frames: number;
  windowFrames: number;
  avgFrameMs: number;
  p95FrameMs: number;
  maxFrameMs: number;
  estimatedFps: number;
  overBudgetPercent: number;
  phases: Record<string, PhaseReport>;
}

class Cdp {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String((event as MessageEvent).data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (message.id === undefined) return;
      const waiter = this.pending.get(message.id);
      if (waiter === undefined) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }

  static async connect(wsUrl: string): Promise<Cdp> {
    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`cannot connect to ${wsUrl}`)), { once: true });
    });
    return new Cdp(socket);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 120_000);
    });
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.send<{
      result: { value?: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value as T;
  }

  close(): void {
    this.socket.close();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function row(label: string, report: PhaseReport): string {
  return (
    `  ${label.padEnd(26)}` +
    `${report.avgMs.toFixed(3).padStart(10)} ms` +
    `${report.p95Ms.toFixed(3).padStart(11)} ms` +
    `${report.maxMs.toFixed(3).padStart(11)} ms`
  );
}

async function main(): Promise<void> {
  const targets = (await (await fetch(`${DEBUG_URL}/json/list`)).json()) as {
    type: string;
    webSocketDebuggerUrl: string;
  }[];
  const page = targets.find((t) => t.type === 'page');
  if (page === undefined) throw new Error('no page target; is Chrome running with --remote-debugging-port?');

  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // Without focus emulation a headless page is treated as backgrounded and
  // `requestAnimationFrame` is throttled to roughly 1 Hz, which would make the
  // measurement meaningless.
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });

  await cdp.send('Page.navigate', { url: `${BASE_URL}/?noboot=1` });
  await sleep(400);
  await cdp.evaluate(`localStorage.clear(); return true;`);
  await cdp.send('Page.navigate', { url: `${BASE_URL}/` });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    await sleep(100);
    if (await cdp.evaluate<boolean>('return Boolean(window.__club);').catch(() => false)) break;
  }

  const counts = await cdp.evaluate<{ guests: number; bartenders: number; queues: number } | null>(
    'return window.__club.stress();',
  );
  const renderer = await cdp.evaluate<string>(`
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return 'none';
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  `);

  console.log('');
  console.log('Club Empire — CPU-side frame time at the §11 ceiling');
  console.log(`  scene          ${counts?.guests ?? '?'} rendered guests, ${counts?.bartenders ?? '?'} bartenders, ${counts?.queues ?? '?'} station queues + door queue`);
  console.log(`  viewport       390x844 @ dpr 2`);
  console.log(`  WebGL renderer ${renderer}`);
  console.log(`  sampling       ${(SAMPLE_MS / 1000).toFixed(0)} s`);

  await sleep(SAMPLE_MS);
  const report = await cdp.evaluate<FrameReport>('return window.__club.frames();');

  console.log('');
  console.log(`  ${'phase'.padEnd(26)}${'avg'.padStart(13)}${'p95'.padStart(14)}${'max'.padStart(14)}`);
  console.log(`  ${'-'.repeat(65)}`);
  console.log(row('sim (fixed-step ticks)', report.phases.sim!));
  console.log(row('scene (update + lerp)', report.phases.scene!));
  console.log(row('publish (React/Zustand)', report.phases.publish!));
  console.log(row('gpu (draw submission)', report.phases.gpu!));
  console.log(`  ${'-'.repeat(65)}`);
  console.log(
    row('whole frame', { avgMs: report.avgFrameMs, p95Ms: report.p95FrameMs, maxMs: report.maxFrameMs }),
  );

  console.log('');
  console.log(`  frames sampled        ${report.windowFrames} (of ${report.frames} since reset)`);
  console.log(`  frames over 16.6 ms   ${report.overBudgetPercent.toFixed(1)}% (dominated by software rasterisation)`);
  const bench = await cdp.evaluate<{
    iterations: number;
    simNsPerTick: number;
    sceneNsPerTick: number;
    simMsPerFrameAt60: number;
  }>('return window.__club.benchTick();');

  console.log('');
  console.log('  Isolated tick cost (independent of the rasteriser, so it transfers)');
  console.log(`    simulation tick     ${bench.simNsPerTick.toFixed(0)} ns  (${bench.iterations.toLocaleString('en-GB')} iterations)`);
  console.log(`    scene tick          ${bench.sceneNsPerTick.toFixed(0)} ns  (30 guests)`);
  console.log(
    `    sim cost per frame  ${bench.simMsPerFrameAt60.toFixed(4)} ms at 60 fps ` +
      `(${((bench.simMsPerFrameAt60 / 16.6) * 100).toFixed(3)}% of the budget)`,
  );

  // The honest CPU-side total: the per-frame phases that are *not* distorted by
  // the rasteriser, plus the isolated simulation cost in place of the
  // catch-up-inflated `sim` row.
  const scenePerFrameMs = bench.sceneNsPerTick / 1_000_000 / 6;
  const cpuAvg =
    bench.simMsPerFrameAt60 +
    scenePerFrameMs +
    report.phases.scene!.avgMs +
    report.phases.publish!.avgMs +
    report.phases.gpu!.avgMs;
  const cpuP95 =
    bench.simMsPerFrameAt60 +
    scenePerFrameMs +
    report.phases.scene!.p95Ms +
    report.phases.publish!.p95Ms +
    report.phases.gpu!.p95Ms;

  console.log('');
  console.log('  CPU-side frame cost (the half this container can measure)');
  console.log(
    `    average             ${cpuAvg.toFixed(3)} ms  (${((cpuAvg / 16.6) * 100).toFixed(1)}% of the 16.6 ms budget)`,
  );
  console.log(
    `    p95                 ${cpuP95.toFixed(3)} ms  (${((cpuP95 / 16.6) * 100).toFixed(1)}% of the 16.6 ms budget)`,
  );

  console.log('');
  console.log('  The per-frame `sim` row above is inflated by the software rasteriser:');
  console.log('  a slow frame hands the fixed-step loop more ticks to catch up on, so it');
  console.log('  times many ticks rather than one. The isolated figures are the honest ones.');
  console.log('  The whole-frame figure includes software rasterisation and is NOT a');
  console.log('  device fps number. Criterion 8 needs a real Pixel 6a / Galaxy A54.');
  console.log('');

  cdp.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
