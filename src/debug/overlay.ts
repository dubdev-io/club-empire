/**
 * The `?debug=1` frame-rate overlay (DUB-9).
 *
 * This is a measurement instrument, not a feature, and it is built to three
 * rules that follow from that.
 *
 * **1. It costs nothing when the flag is off.** This module is reached only by
 * a dynamic `import()` in `main.tsx`, so Rolldown emits it as its own chunk and
 * the browser never fetches it in normal play. Every DOM node, every listener
 * and the `rAF` hook below are created inside `mountDebugOverlay` — there is no
 * top-level side effect, so even importing this file does nothing until it is
 * called. Its CSS is injected from here for the same reason.
 *
 * **2. It measures the frame, not itself.** The sampling loop allocates
 * nothing: frame times go into pre-sized typed arrays, the scene counts are
 * written into one reused object, and the text is rebuilt five times a second
 * rather than sixty. A probe that triggers GC is measuring its own garbage —
 * dropped frames are a tail problem and GC pauses are what the tail is made of.
 *
 * **3. It never lies about what it does not know.** `heap_mb` is a
 * Chrome-only, non-standard API and prints `n/a` on WebKit rather than
 * guessing. `draw_calls` needs the WebGL context and prints `n/a` if Pixi came
 * up on WebGPU or software canvas. The whole point of DUB-8 was to get *one
 * honest number* off a real phone, which a plausible-looking fabrication would
 * defeat.
 *
 * Field names are a contract: QA reads them off this overlay for the DUB-6 C1
 * frame-budget numbers. They are listed in the README and must not be renamed
 * without saying so on DUB-6.
 */

import type { GameRuntime } from '../game/runtime.ts';
import type { RenderCounts } from '../render/clubScene.ts';

/** Length of the 60 s measurement, in ms. The number DUB-9 asks for. */
const MEASURE_MS = 60_000;

/**
 * Frame-time samples kept per window.
 *
 * 8192 covers 60 s at 120 Hz with room to spare, which matters because
 * `fps_p1_worst` is a percentile over the *whole* window — a ring buffer that
 * wrapped would quietly turn "slowest 1% of the 60 s run" into "slowest 1% of
 * the last few seconds", and the stutter it is there to catch usually happens
 * once.
 */
const MAX_SAMPLES = 8192;

/** Timestamps kept for the 1 s rolling average. 256 covers 1 s at 240 Hz. */
const RECENT = 256;

/** How often the text is rebuilt. 5 Hz is readable and 12x cheaper than per-frame. */
const REDRAW_MS = 200;

export interface DebugOverlayInfo {
  /** Short commit SHA, injected at build time. */
  readonly build: string;
  /** True when `stress=1` put the game into the DUB-6 C1 scene. */
  readonly stress: boolean;
}

export interface DebugOverlay {
  destroy(): void;
}

/**
 * Chrome's non-standard heap readout. Absent on WebKit and on Firefox.
 *
 * Typed locally rather than declared as a global so nothing outside this file
 * can come to depend on it existing.
 */
interface ChromeMemory {
  readonly usedJSHeapSize: number;
}

export function mountDebugOverlay(runtime: GameRuntime, info: DebugOverlayInfo): DebugOverlay {
  const debug = runtime.debug;

  // --- sampling state -----------------------------------------------------
  const samples = new Float32Array(MAX_SAMPLES);
  const recent = new Float64Array(RECENT);
  const sorted = new Float32Array(MAX_SAMPLES);
  const counts: RenderCounts = { guests: 0, bartenders: 0, queues: 0, particles: 0 };

  let sampleCount = 0;
  let dropped = 0;
  let recentCursor = 0;
  let recentFilled = 0;

  let windowStart = performance.now();
  let lastFrameAt = windowStart;
  let lastRedrawAt = 0;
  /** Set when "Start 60 s measurement" is armed; null when free-running. */
  let measureUntil: number | null = null;
  let frozen = false;
  let peakFps = 0;
  let status = 'free-running — tap “Start 60 s measurement” to take a reading';

  const drawCalls = installDrawCallCounter(debug.renderer());

  // --- DOM ----------------------------------------------------------------
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'ce-debug';
  // The panel as a whole is transparent to touch. Only the two buttons take a
  // tap, and they sit in the top band §9 reserves for reading — so nothing the
  // overlay adds is over a tappable control, and the owner can still tap cash
  // bubbles and fire Last Call while a measurement is running.
  root.setAttribute('role', 'status');

  const bar = document.createElement('div');
  bar.className = 'ce-debug__bar';

  const startButton = document.createElement('button');
  startButton.type = 'button';
  startButton.className = 'ce-debug__btn';
  startButton.textContent = 'Start 60 s measurement';

  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'ce-debug__btn';
  copyButton.textContent = 'Copy report';

  bar.append(startButton, copyButton);

  // The report is rendered as the *same* plain-text block that "Copy report"
  // writes to the clipboard, not as a prettier parallel view. Clipboard
  // permission fails silently on iOS Safari, so the fallback has to be the
  // real thing rather than an approximation of it.
  const out = document.createElement('pre');
  out.className = 'ce-debug__out';

  const statusLine = document.createElement('div');
  statusLine.className = 'ce-debug__status';

  root.append(bar, out, statusLine);
  document.body.appendChild(root);

  // --- report -------------------------------------------------------------
  function buildReport(now: number): string {
    const elapsedMs = (frozen && measureUntil !== null ? measureUntil : now) - windowStart;
    const canvas = debug.canvas();
    const frames = debug.frames();

    const n = sampleCount;
    let sum = 0;
    let max = 0;
    for (let i = 0; i < n; i += 1) {
      const value = samples[i]!;
      sum += value;
      if (value > max) max = value;
      sorted[i] = value;
    }
    // `Float32Array.prototype.sort` is numeric and in place: no comparator
    // closure, no copy.
    const view = sorted.subarray(0, n);
    view.sort();

    // The slowest 1% of frames, expressed as the fps they correspond to. The
    // p99 frame *time* is the p1 frame *rate* — the same tail, read from the
    // end the owner cares about.
    const p99Index = Math.min(n - 1, Math.floor(n * 0.99));
    const p99Ms = n > 0 ? view[p99Index]! : 0;

    // Split across two lines rather than one: every row has to fit a column
    // 30 characters wide (see `CSS`), and a full ISO timestamp on its own is
    // 24 of them.
    const stamp = new Date().toISOString();

    const rows: [string, string][] = [
      ['build', info.build],
      ['scene', info.stress ? 'stress' : 'normal'],
      ['state', frozen ? 'FROZEN' : 'live'],
      ['date', stamp.slice(0, 10)],
      ['time', stamp.slice(11, 19) + 'Z'],
      ['fps', fixed(rollingFps(now), 1)],
      ['fps_p1_worst', p99Ms > 0 ? fixed(1000 / p99Ms, 1) : 'n/a'],
      ['frame_ms_mean', n > 0 ? fixed(sum / n, 2) : 'n/a'],
      ['frame_ms_max', n > 0 ? fixed(max, 2) : 'n/a'],
      ['refresh_cap_hz', peakFps > 0 ? String(Math.round(peakFps)) : 'n/a'],
      ['draw_calls', drawCalls === null ? 'n/a' : String(drawCalls.lastFrame)],
      ['guests_rendered', String(counts.guests)],
      ['bartenders_rendered', String(counts.bartenders)],
      ['queues_rendered', String(counts.queues)],
      ['particles_rendered', String(counts.particles)],
      ['dpr', fixed(window.devicePixelRatio || 1, 2)],
      ['canvas_px', canvas === null ? 'n/a' : `${canvas.width}x${canvas.height}`],
      [
        'canvas_css',
        canvas === null ? 'n/a' : `${Math.round(canvas.clientWidth)}x${Math.round(canvas.clientHeight)}`,
      ],
      ['heap_mb', heapMb()],
      ['elapsed_s', fixed(elapsedMs / 1000, 1)],
      ['window_frames', String(n + dropped)],
      ['sim_ms_p95', fixed(frames.phases.sim.p95Ms, 2)],
      ['scene_ms_p95', fixed(frames.phases.scene.p95Ms, 2)],
      ['publish_ms_p95', fixed(frames.phases.publish.p95Ms, 2)],
      ['gpu_ms_p95', fixed(frames.phases.gpu.p95Ms, 2)],
    ];

    let text = '';
    for (const [key, value] of rows) text += `${key.padEnd(19, ' ')} ${value}\n`;
    if (dropped > 0) {
      text += `${'dropped'.padEnd(19, ' ')} ${dropped}\n`;
    }
    return text;
  }

  /** Frames in the trailing second, as fps. The field DUB-9 calls `fps`. */
  function rollingFps(now: number): number {
    const cutoff = now - 1000;
    let inWindow = 0;
    let oldest = now;
    for (let i = 0; i < recentFilled; i += 1) {
      const at = recent[i]!;
      if (at < cutoff) continue;
      inWindow += 1;
      if (at < oldest) oldest = at;
    }
    if (inWindow < 2) return 0;
    const span = now - oldest;
    return span > 0 ? ((inWindow - 1) * 1000) / span : 0;
  }

  function heapMb(): string {
    // Non-standard and Chrome-only. DUB-9 is explicit: print `n/a` on Safari
    // rather than guessing, because a made-up memory number is worse than no
    // memory number.
    const memory = (performance as Performance & { memory?: ChromeMemory }).memory;
    if (memory === undefined || typeof memory.usedJSHeapSize !== 'number') return 'n/a';
    return fixed(memory.usedJSHeapSize / (1024 * 1024), 1);
  }

  function resetWindow(now: number): void {
    sampleCount = 0;
    dropped = 0;
    recentCursor = 0;
    recentFilled = 0;
    peakFps = 0;
    windowStart = now;
    lastFrameAt = now;
    drawCalls?.reset();
  }

  // --- buttons ------------------------------------------------------------
  startButton.addEventListener('click', () => {
    const now = performance.now();
    frozen = false;
    resetWindow(now);
    measureUntil = now + MEASURE_MS;
    status = 'measuring 60 s — leave the phone alone';
    applyFrozenClass();
    debug.counts(counts);
    out.textContent = buildReport(now);
    statusLine.textContent = status;
  });

  copyButton.addEventListener('click', () => {
    // iOS Safari only honours a clipboard write that happens inside the user
    // gesture. So the text is built and handed over synchronously here, before
    // any `await` — the promise is only used to report the outcome afterwards.
    const text = out.textContent ?? '';

    // Freeze on copy as well as on timeout. `user-select` is off document-wide
    // and the panel is touch-transparent while live, so this is what makes the
    // on-screen text actually selectable when the clipboard write fails
    // quietly — which on iOS it does.
    frozen = true;
    measureUntil = null;
    applyFrozenClass();

    const clipboard = navigator.clipboard;
    if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
      const written = clipboard.writeText(text);
      status = 'copying…';
      statusLine.textContent = status;
      written.then(
        () => {
          status = 'copied — display frozen, text is selectable';
          statusLine.textContent = status;
        },
        () => {
          status = legacyCopy(text)
            ? 'copied (fallback) — display frozen, text is selectable'
            : 'clipboard refused — select the text above and copy by hand';
          statusLine.textContent = status;
        },
      );
      return;
    }

    status = legacyCopy(text)
      ? 'copied (fallback) — display frozen, text is selectable'
      : 'no clipboard API — select the text above and copy by hand';
    statusLine.textContent = status;
  });

  function applyFrozenClass(): void {
    // Selectable only while frozen: a `<pre>` whose text is replaced five
    // times a second cannot hold a selection, and while live the panel has to
    // stay transparent to taps so it is not sitting on the game.
    root.classList.toggle('ce-debug--frozen', frozen);
  }

  // --- the sampling loop --------------------------------------------------
  // A second `requestAnimationFrame` hook rather than a tap into the game's
  // loop. `rAF` callbacks fire once per presented frame whatever order they
  // were registered in, so the interval between two of these *is* the frame
  // interval — and keeping it separate means the game's frame loop is byte for
  // byte the one that ships.
  let rafHandle = requestAnimationFrame(tick);
  let alive = true;

  function tick(now: number): void {
    if (!alive) return;
    rafHandle = requestAnimationFrame(tick);

    if (!frozen) {
      const delta = now - lastFrameAt;
      lastFrameAt = now;

      if (sampleCount < MAX_SAMPLES) {
        samples[sampleCount] = delta;
        sampleCount += 1;
      } else {
        dropped += 1;
      }

      if (recentFilled < RECENT) {
        recent[recentFilled] = now;
        recentFilled += 1;
        recentCursor = recentFilled % RECENT;
      } else {
        recent[recentCursor] = now;
        recentCursor = (recentCursor + 1) % RECENT;
      }

      const fps = rollingFps(now);
      if (fps > peakFps) peakFps = fps;

      if (measureUntil !== null && now >= measureUntil) {
        frozen = true;
        status = 'measurement complete — frozen, tap “Copy report”';
        applyFrozenClass();
        out.textContent = buildReport(now);
        statusLine.textContent = status;
        drawCalls?.commit();
        return;
      }
    }

    drawCalls?.commit();

    if (now - lastRedrawAt < REDRAW_MS) return;
    lastRedrawAt = now;
    if (frozen) return;

    debug.counts(counts);
    out.textContent = buildReport(now);
    statusLine.textContent = status;
  }

  out.textContent = buildReport(windowStart);
  statusLine.textContent = status;

  return {
    destroy: () => {
      alive = false;
      cancelAnimationFrame(rafHandle);
      drawCalls?.restore();
      root.remove();
      style.remove();
    },
  };
}

/** Last-resort clipboard path for browsers that refuse the async API. */
function legacyCopy(text: string): boolean {
  const scratch = document.createElement('textarea');
  scratch.value = text;
  scratch.setAttribute('readonly', 'readonly');
  scratch.style.position = 'fixed';
  scratch.style.opacity = '0';
  document.body.appendChild(scratch);
  try {
    scratch.select();
    scratch.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    scratch.remove();
  }
}

interface DrawCallCounter {
  /** Draw calls issued during the frame that just ended. */
  lastFrame: number;
  /** Roll the in-flight count into `lastFrame`. Called once per frame. */
  commit(): void;
  reset(): void;
  restore(): void;
}

/**
 * Count `draw*` calls by wrapping the WebGL context.
 *
 * Pixi 8 keeps no draw-call statistic of its own, and the batcher is internal,
 * so the only honest source is the context itself. `renderer.gl` is set by
 * `GlContextSystem` but is not on the public `Renderer` union type, hence the
 * narrow cast — if it is ever absent the overlay prints `n/a` rather than 0.
 *
 * Patching a hot GL function would normally be unacceptable, but this is a
 * debug-chunk-only path and a batched frame of this scene issues single-digit
 * draw calls, so the wrapper runs a handful of times per frame.
 */
function installDrawCallCounter(renderer: unknown): DrawCallCounter | null {
  const gl = (renderer as { gl?: WebGL2RenderingContext } | null)?.gl;
  if (gl === undefined || gl === null) return null;

  let pending = 0;

  // Bound up front. The four `draw*` functions live on
  // `WebGL2RenderingContext.prototype`, so assigning to `gl.draw*` below adds
  // an *own* property that shadows them — which is also what makes `restore`
  // a `delete` rather than a re-assignment: it puts the context back to
  // genuinely unpatched rather than to a wrapper that happens to forward.
  const drawArrays = gl.drawArrays.bind(gl);
  const drawElements = gl.drawElements.bind(gl);
  const drawArraysInstanced = gl.drawArraysInstanced.bind(gl);
  const drawElementsInstanced = gl.drawElementsInstanced.bind(gl);

  gl.drawArrays = (mode, first, count) => {
    pending += 1;
    drawArrays(mode, first, count);
  };
  gl.drawElements = (mode, count, type, offset) => {
    pending += 1;
    drawElements(mode, count, type, offset);
  };
  gl.drawArraysInstanced = (mode, first, count, instances) => {
    pending += 1;
    drawArraysInstanced(mode, first, count, instances);
  };
  gl.drawElementsInstanced = (mode, count, type, offset, instances) => {
    pending += 1;
    drawElementsInstanced(mode, count, type, offset, instances);
  };

  const counter: DrawCallCounter = {
    lastFrame: 0,
    commit: () => {
      counter.lastFrame = pending;
      pending = 0;
    },
    reset: () => {
      pending = 0;
      counter.lastFrame = 0;
    },
    restore: () => {
      const own = gl as unknown as Record<string, unknown>;
      delete own.drawArrays;
      delete own.drawElements;
      delete own.drawArraysInstanced;
      delete own.drawElementsInstanced;
    },
  };
  return counter;
}

function fixed(value: number, places: number): string {
  return Number.isFinite(value) ? value.toFixed(places) : 'n/a';
}

/**
 * Injected from here rather than imported as a stylesheet so the flag-off
 * bundle carries none of it.
 *
 * Placement follows DUB-9: top-left, inside the safe-area insets, and clear of
 * every tappable control. `env(safe-area-inset-*)` is read directly rather
 * than through the app's `--safe-*` tokens, so the overlay still lands
 * correctly if it is ever mounted before the app's stylesheet.
 */
const CSS = `
.ce-debug {
  position: fixed;
  top: calc(env(safe-area-inset-top, 0px) + 6px);
  left: calc(env(safe-area-inset-left, 0px) + 6px);
  z-index: 2147483647;
  width: fit-content;
  max-width: calc(100vw - 12px);
  pointer-events: none;
  /* 9.5 px sounds small and is not: at the 3x device pixel ratio of the phone
     this is measured on, it rasterises at 28 device pixels. It is the largest
     size at which two 30-character columns fit inside 390 CSS px without
     clipping, and the primary way the numbers leave the device is "Copy
     report" rather than someone squinting at them. */
  font: 500 9.5px/1.25 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  color: #eafff4;
}

.ce-debug__bar {
  display: flex;
  gap: 6px;
  margin-bottom: 4px;
  pointer-events: auto;
}

.ce-debug__btn {
  /* 44 px is the §9 touch minimum and applies to a debug button too: the owner
     is tapping this with a thumb on a phone. */
  min-height: 44px;
  padding: 0 10px;
  border: 1px solid #38e8b0;
  border-radius: 8px;
  background: #06130f;
  color: #eafff4;
  font: inherit;
  font-weight: 600;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.ce-debug__btn:active {
  background: #10352a;
}

.ce-debug__out {
  margin: 0;
  padding: 6px 8px;
  border-radius: 8px;
  /* Opaque, not translucent: this is read against a club floor with coloured
     lights moving behind it. */
  background: #06130f;
  border: 1px solid #1d4d3e;
  white-space: pre;
  /* Two columns, which is the whole reason the rows are capped at 30
     characters. Twenty-four fields in one column is 450 px tall on a 390x844
     phone — over half the screen and sitting squarely on the cash bubbles,
     which are the one thing the owner has to be able to tap while a
     measurement is running. CSS multicol breaks on the line boxes of a
     "white-space: pre" block, so textContent is still the single plain-text
     report that "Copy report" puts on the clipboard. */
  column-count: 2;
  column-gap: 10px;
  column-fill: balance;
  /* Two 30-character columns plus the gap and the padding, in the element's
     own monospace ch unit. The longest row the report can produce is
     "bartenders_rendered" (19) + a space + a ten-character value. */
  width: calc(60ch + 10px + 18px);
  max-width: calc(100vw - 14px);
  user-select: none;
  -webkit-user-select: none;
}

.ce-debug__status {
  margin-top: 4px;
  padding: 4px 8px;
  border-radius: 8px;
  background: #06130f;
  border: 1px solid #1d4d3e;
  max-width: 100%;
  white-space: normal;
}

/* Frozen: the numbers have stopped moving, so the text becomes selectable and
   the panel starts taking taps. While live it stays transparent to touch so it
   is never in the way of a cash bubble. */
.ce-debug--frozen .ce-debug__out {
  pointer-events: auto;
  user-select: text;
  -webkit-user-select: text;
  border-color: #38e8b0;
}
`;
