/**
 * Sound, synthesised at runtime.
 *
 * The asset budget allowed ~720 KB of audio. This spends none of it: every
 * sound in the game is a few oscillators and an envelope, built from the Web
 * Audio API when the player first touches the screen. That buys three things —
 * nothing to download, nothing to licence or credit, and no decode stall on a
 * mid-range phone the first time a coin is collected.
 *
 * Two browser rules shape the structure:
 *
 *  - **An `AudioContext` created before a user gesture starts suspended.** So
 *    the context is not created at boot at all; `unlock()` is called from the
 *    first pointer event. The brief already requires audio to load after first
 *    interaction, and the autoplay policy requires it independently.
 *  - **Scheduling must run ahead of the clock.** `setTimeout` jitter is
 *    audible on a bassline, so notes are scheduled against
 *    `AudioContext.currentTime`, which is sample-accurate.
 *
 * The music is a 120 BPM four-on-the-floor bed, and its beat is driven by the
 * *same* fixed tick that lights the dance floor — the scene calls `beat()`. So
 * "the dance floor pulses on the audio beat" is true by construction rather
 * than by two timers that drift apart over a twenty-minute session.
 */

export interface GameAudio {
  /** Create the context. Must be called from inside a user-gesture handler. */
  unlock(): void;
  setEnabled(enabled: boolean): void;
  /** One beat of the bed. Called from the scene's beat, so the two cannot drift. */
  beat(index: number): void;
  /** A collected tip. VIP tips are louder and brighter (§ guest types). */
  coin(vip: boolean): void;
  upgrade(): void;
  /** ★ at 10/20/30. The biggest event in the run gets the only chord. */
  star(stars: number): void;
  /** Last Call fired: the filter opens and the room gets louder. */
  lastCall(active: boolean): void;
  destroy(): void;
}

/** A no-op implementation, for when audio is off or Web Audio is missing. */
const SILENT: GameAudio = {
  unlock: () => {},
  setEnabled: () => {},
  beat: () => {},
  coin: () => {},
  upgrade: () => {},
  star: () => {},
  lastCall: () => {},
  destroy: () => {},
};

export function createAudio(): GameAudio {
  type Ctor = typeof AudioContext;
  const AudioContextCtor: Ctor | undefined =
    typeof window === 'undefined'
      ? undefined
      : (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext);

  if (AudioContextCtor === undefined) return SILENT;

  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  /** The one filter the Last Call "music filter opens" effect moves. */
  let filter: BiquadFilterNode | null = null;
  let enabled = true;
  let boosted = false;

  const ensure = (): boolean => {
    if (!enabled) return false;
    if (ctx !== null) {
      // iOS re-suspends the context when the app is backgrounded.
      if (ctx.state === 'suspended') void ctx.resume();
      return true;
    }

    try {
      ctx = new AudioContextCtor();
    } catch {
      // A browser that refuses to create a context at all. Silence is a
      // perfectly good outcome; a thrown error from a pointer handler is not.
      return false;
    }

    filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    // Closed-ish at rest so Last Call opening it is audible as a lift rather
    // than just a volume change.
    filter.frequency.value = 1400;
    filter.Q.value = 0.8;

    master = ctx.createGain();
    master.gain.value = 0.22;

    filter.connect(master);
    master.connect(ctx.destination);
    return true;
  };

  /** One enveloped oscillator. The whole synth is this function. */
  const tone = (options: {
    freq: number;
    type: OscillatorType;
    duration: number;
    gain: number;
    /** Sweep to this frequency over the note. Used for the kick and the whoosh. */
    sweepTo?: number;
    delay?: number;
    /** Bypass the Last Call filter — UI feedback must stay crisp. */
    dry?: boolean;
  }): void => {
    if (ctx === null || master === null || filter === null) return;

    const start = ctx.currentTime + (options.delay ?? 0);
    const osc = ctx.createOscillator();
    const env = ctx.createGain();

    osc.type = options.type;
    osc.frequency.setValueAtTime(options.freq, start);
    if (options.sweepTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, options.sweepTo), start + options.duration);
    }

    // A 4 ms attack rather than an instant one: a square wave starting at full
    // amplitude clicks, and the click is louder than the note.
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(options.gain, start + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, start + options.duration);

    osc.connect(env);
    env.connect(options.dry === true ? master : filter);
    osc.start(start);
    osc.stop(start + options.duration + 0.02);
  };

  return {
    unlock: () => {
      ensure();
    },

    setEnabled: (next) => {
      enabled = next;
      if (master !== null && ctx !== null) {
        // Ramped, not stepped. Setting a gain to zero instantly is an audible
        // click on every browser.
        master.gain.cancelScheduledValues(ctx.currentTime);
        master.gain.setTargetAtTime(next ? 0.22 : 0, ctx.currentTime, 0.02);
      }
      if (!next && ctx !== null && ctx.state === 'running') void ctx.suspend();
      if (next) ensure();
    },

    beat: (index) => {
      if (!ensure()) return;

      // Kick on every beat: a fast downward sweep, which is what a kick drum
      // is.
      tone({ freq: 150, sweepTo: 46, type: 'sine', duration: 0.17, gain: 0.9 });

      // Hat on the off-beat, bass note on the bar. Enough to feel like music
      // without becoming a loop the player notices repeating.
      if (index % 2 === 1) {
        tone({ freq: 7800, type: 'square', duration: 0.03, gain: 0.05 });
      }
      if (index % 4 === 0) {
        const bass = [55, 55, 73.42, 65.41][(index / 4) % 4]!;
        tone({ freq: bass, type: 'sawtooth', duration: 0.3, gain: 0.3 });
      }
    },

    coin: (vip) => {
      if (!ensure()) return;
      // A soft two-note click. The VIP version is a fifth higher and twice as
      // loud — the brief asks for "a louder coin sound", and pitch carries it
      // further than volume alone on a phone speaker.
      const root = vip ? 1320 : 880;
      tone({ freq: root, type: 'triangle', duration: 0.07, gain: vip ? 0.5 : 0.28, dry: true });
      tone({ freq: root * 1.5, type: 'triangle', duration: 0.09, gain: vip ? 0.4 : 0.2, delay: 0.045, dry: true });
    },

    upgrade: () => {
      if (!ensure()) return;
      tone({ freq: 420, sweepTo: 760, type: 'triangle', duration: 0.1, gain: 0.3, dry: true });
    },

    star: (stars) => {
      if (!ensure()) return;
      // A major triad arpeggiated upward, one step higher per star earned. The
      // only chord in the game, for the only x2 in the game.
      const base = 523.25 * Math.pow(1.122, stars - 1);
      const intervals = [1, 1.26, 1.5, 2];
      for (let i = 0; i < intervals.length; i += 1) {
        tone({
          freq: base * intervals[i]!,
          type: 'triangle',
          duration: 0.45,
          gain: 0.26,
          delay: i * 0.07,
          dry: true,
        });
      }
    },

    lastCall: (active) => {
      if (!ensure()) return;
      if (ctx === null || filter === null) return;

      boosted = active;
      // The filter sweep *is* the effect. 1.4 kHz -> 9 kHz over 400 ms reads
      // as the room opening up, which is what a club does at last call.
      filter.frequency.cancelScheduledValues(ctx.currentTime);
      filter.frequency.setTargetAtTime(boosted ? 9000 : 1400, ctx.currentTime, boosted ? 0.12 : 0.6);

      if (active) {
        tone({ freq: 180, sweepTo: 1800, type: 'sawtooth', duration: 0.6, gain: 0.22 });
      }
    },

    destroy: () => {
      if (ctx !== null) void ctx.close();
      ctx = null;
      master = null;
      filter = null;
    },
  };
}

/**
 * A 10 ms vibrate, behind the settings toggle (§9).
 *
 * Wrapped rather than called directly because `navigator.vibrate` is absent on
 * iOS entirely and throws on some Android WebViews when the page is not
 * visible, and neither is worth a crash in a tap handler.
 */
export function vibrate(enabled: boolean, ms = 10): void {
  if (!enabled) return;
  if (typeof navigator === 'undefined') return;
  const api = navigator as Navigator & {
    vibrate?: ((this: void, pattern: number) => boolean) | undefined;
  };
  if (typeof api.vibrate !== 'function') return;
  try {
    api.vibrate(ms);
  } catch {
    /* unsupported; the visual feedback already happened */
  }
}
