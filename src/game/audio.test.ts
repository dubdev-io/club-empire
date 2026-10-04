/**
 * The autoplay-policy contract: no `AudioContext` before a user gesture.
 *
 * DUB-6 requires audio to load after first interaction, and the DUB-6 QA pass
 * found a context being built during boot (DUB-11 defect 1). QA pinned it to
 * `setEnabled` by flipping the seeded `settings.audio`; the cause is wider than
 * that, and these tests are written against the wider rule rather than the one
 * call site — `beat()` fires off the fixed tick within the first second of boot
 * and used to open a context too, which no amount of care at the `setEnabled`
 * call site would have caught.
 *
 * So the assertion is a count, not a call graph: construct the module, do
 * everything boot does, and demand zero contexts until `unlock()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAudio } from './audio.ts';

/** Every context constructed in this test, in order. */
const contexts: FakeAudioContext[] = [];

/** How many contexts have been constructed in this test. */
let constructed = 0;

/** The context the module is currently using, if it has opened one at all. */
function latest(): FakeAudioContext | undefined {
  return contexts.at(-1);
}

class FakeAudioParam {
  value = 0;
  cancelScheduledValues(): void {}
  setValueAtTime(): this {
    return this;
  }
  linearRampToValueAtTime(): this {
    return this;
  }
  exponentialRampToValueAtTime(): this {
    return this;
  }
  setTargetAtTime(): this {
    return this;
  }
}

class FakeNode {
  gain = new FakeAudioParam();
  frequency = new FakeAudioParam();
  Q = new FakeAudioParam();
  type = '';
  connect(): void {}
  start(): void {}
  stop(): void {}
}

class FakeAudioContext {
  state: 'running' | 'suspended' | 'closed' = 'running';
  currentTime = 0;
  destination = new FakeNode();
  resumes = 0;
  suspends = 0;

  constructor() {
    constructed += 1;
    contexts.push(this);
  }

  createGain(): FakeNode {
    return new FakeNode();
  }
  createBiquadFilter(): FakeNode {
    return new FakeNode();
  }
  createOscillator(): FakeNode {
    return new FakeNode();
  }
  resume(): Promise<void> {
    this.resumes += 1;
    this.state = 'running';
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    this.suspends += 1;
    this.state = 'suspended';
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
}

beforeEach(() => {
  constructed = 0;
  contexts.length = 0;
  // The tests run on the `node` environment, so `window` is ours to define.
  // `createAudio` reads `window.AudioContext` once, at creation.
  vi.stubGlobal('window', { AudioContext: FakeAudioContext });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('no AudioContext before the first gesture', () => {
  it('does not construct one when the boot path enables audio', () => {
    const audio = createAudio();

    // Exactly what `startGame` does with a restored save that has sound on.
    audio.setEnabled(true);

    expect(constructed).toBe(0);
  });

  it('does not construct one for the beat off the fixed tick', () => {
    const audio = createAudio();
    audio.setEnabled(true);

    // `scene.onBeat` runs from the simulation tick, not from a gesture, and
    // fires inside the first second of boot. This is the path QA's seeded flip
    // could not distinguish from `setEnabled`.
    for (let i = 0; i < 8; i += 1) audio.beat(i);

    expect(constructed).toBe(0);
  });

  it('does not construct one for any other sound reached before a gesture', () => {
    const audio = createAudio();
    audio.setEnabled(true);

    audio.coin(false);
    audio.coin(true);
    audio.upgrade();
    audio.star(1);
    audio.lastCall(true);
    audio.lastCall(false);

    expect(constructed).toBe(0);
  });

  it('does not construct one when the app returns to the foreground', () => {
    const audio = createAudio();

    // `visibilitychange` is not a gesture either: the player swiping back to a
    // backgrounded tab must not be treated as a tap.
    audio.setEnabled(false);
    audio.setEnabled(true);

    expect(constructed).toBe(0);
  });
});

describe('the first gesture opens the hardware, once', () => {
  it('constructs exactly one context on unlock', () => {
    const audio = createAudio();
    audio.setEnabled(true);
    expect(constructed).toBe(0);

    audio.unlock();

    expect(constructed).toBe(1);
  });

  it('reuses the context across every later tap and sound', () => {
    const audio = createAudio();
    audio.setEnabled(true);

    audio.unlock();
    audio.unlock();
    audio.unlock();
    audio.beat(0);
    audio.coin(true);
    audio.upgrade();

    expect(constructed).toBe(1);
  });

  it('still plays nothing while audio is off, gesture or not', () => {
    const audio = createAudio();
    audio.setEnabled(false);

    audio.unlock();

    expect(constructed).toBe(0);
  });

  it('opens the context when the player turns audio on after unlocking', () => {
    const audio = createAudio();
    audio.setEnabled(false);
    audio.unlock();
    expect(constructed).toBe(0);

    // The settings toggle is a gesture, and `runtime.ts` calls `unlock()` from
    // the subscriber so this route works for a player who has only ever tapped
    // DOM buttons and never the canvas.
    audio.setEnabled(true);
    audio.unlock();

    expect(constructed).toBe(1);
  });
});

describe('suspend and resume once a context exists', () => {
  it('suspends when audio is turned off and resumes when it comes back', () => {
    const audio = createAudio();
    audio.setEnabled(true);
    audio.unlock();
    expect(latest()).toBeDefined();

    audio.setEnabled(false);
    expect(latest()?.suspends).toBe(1);
    expect(latest()?.state).toBe('suspended');

    audio.setEnabled(true);
    expect(latest()?.resumes).toBe(1);
    expect(latest()?.state).toBe('running');
    // And no second context for the round trip.
    expect(constructed).toBe(1);
  });
});

describe('a browser without Web Audio', () => {
  it('is silent rather than broken', () => {
    vi.stubGlobal('window', {});
    const audio = createAudio();

    expect(() => {
      audio.setEnabled(true);
      audio.unlock();
      audio.beat(0);
      audio.coin(true);
      audio.destroy();
    }).not.toThrow();
    expect(constructed).toBe(0);
  });
});
