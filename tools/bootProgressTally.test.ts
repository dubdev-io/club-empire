/**
 * The DUB-21 instrument must not report a pass it did not measure.
 *
 * This is here because the instrument got it wrong twice. The first version
 * counted frames, and since a blocked main thread fires no `requestAnimationFrame`
 * a slow boot window sampled nothing and scored zero missing frames — it passed
 * a build where the bar was never in the DOM at all. The second version fixed
 * that and then exited 0 on a run where every row read `.boot window: never`,
 * which the PR #15 review hit for real: `vite preview` was serving the build at
 * a base it was not built for, so the bundle never executed and there was no
 * boot screen on any of the eight loads.
 *
 * Both are the same mistake. Silence is not agreement, and the only verdicts
 * that can produce an exit of 0 are the ones that came from a measurement.
 */
import { describe, expect, it } from 'vitest';
import { envCount, tally } from './boot-progress.ts';

type Verdict = 'pass' | 'fail' | 'n/a' | 'no-boot';

/** Only `verdict` is read by `tally`; the rest of a `RunReport` is padding. */
const run = (verdict: Verdict): Parameters<typeof tally>[0][number] =>
  ({ verdict }) as unknown as Parameters<typeof tally>[0][number];

describe('the run-level verdict', () => {
  it('passes a run where every measured load had its bar', () => {
    expect(tally([run('pass'), run('pass'), run('n/a')]).code).toBe(0);
  });

  it('fails a run where any load was owed a bar and did not have one', () => {
    expect(tally([run('pass'), run('fail'), run('n/a')]).code).toBe(1);
  });

  it('does not pass a run that measured nothing at all', () => {
    // Every load finished before the threshold: no frame owed a bar, so there
    // is nothing to have an opinion about. Raise the throttle rates.
    expect(tally([run('n/a'), run('n/a'), run('n/a')]).code).toBe(3);
    expect(tally([]).code).toBe(3);
  });

  it('does not pass a run where the boot screen never appeared', () => {
    // The review's run, exactly: eight rows of `.boot window: never`, exit 0.
    expect(tally([run('no-boot'), run('no-boot')]).code).toBe(3);
  });

  it('does not let measured passes absorb a load it could not read', () => {
    // The trap in the obvious fix. Gating only on "were there zero measured
    // loads" lets one unreadable load hide behind the ones that worked, and an
    // intermittent broken load is exactly the shape of this ticket's defect.
    expect(tally([run('pass'), run('pass'), run('no-boot')]).code).toBe(3);
  });

  it('reports a real failure ahead of an unreadable load', () => {
    // Both are non-zero, but `1` is the one that means the bar is broken.
    expect(tally([run('fail'), run('no-boot')]).code).toBe(1);
  });

  it('counts only measurements as measurements', () => {
    const { overdue, unbooted, failures } = tally([
      run('pass'),
      run('fail'),
      run('n/a'),
      run('no-boot'),
    ]);

    expect(overdue).toHaveLength(2);
    expect(failures).toHaveLength(1);
    expect(unbooted).toHaveLength(1);
  });
});

describe('the environment knobs', () => {
  it('treats unset and empty alike as the default', () => {
    // `CLUB_BOOT_WAIT_MS=` is `Number('')`, which is 0. A zero wait budget reads
    // back every load before it booted, so the whole run reports `no-boot` for a
    // reason that is nowhere in the output.
    expect(envCount('CLUB_BOOT_WAIT_MS', 5_000, undefined)).toBe(5_000);
    expect(envCount('CLUB_BOOT_WAIT_MS', 5_000, '')).toBe(5_000);
    expect(envCount('CLUB_BOOT_WAIT_MS', 5_000, '   ')).toBe(5_000);
  });

  it('takes a value that was actually given', () => {
    expect(envCount('CLUB_BOOT_WAIT_MS', 5_000, '12000')).toBe(12_000);
    expect(envCount('CLUB_BOOT_REPEATS', 1, '3')).toBe(3);
  });

  it('refuses a value that is present but not a positive number', () => {
    // Present-but-unusable is operator error, not a request for the default:
    // silently substituting one would hide the typo behind a plausible run.
    for (const raw of ['0', '-1', 'soon', 'NaN']) {
      expect(() => envCount('CLUB_BOOT_WAIT_MS', 5_000, raw)).toThrow(/not a positive number/);
    }
  });
});
