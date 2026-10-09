import { useState } from 'react';
import { useGameStore } from '../state/store.ts';
import { Sheet } from './Sheet.tsx';

/**
 * Settings: audio, reduced motion, haptics, reset.
 *
 * Phase 1 scope is explicit that there are **no settings beyond audio and
 * reduced-motion** (haptics rides along because §9 requires the 10 ms vibrate
 * to sit behind a toggle). No account, no cloud save, no difficulty, no
 * language. The list being short is the feature.
 */
export function SettingsSheet(): React.JSX.Element {
  const closeSheet = useGameStore((s) => s.closeSheet);
  const settings = useGameStore((s) => s.settings);
  const setSettings = useGameStore((s) => s.setSettings);
  const actions = useGameStore((s) => s.actions);
  const storageUnavailable = useGameStore((s) => s.storageUnavailable);

  const [confirmingReset, setConfirmingReset] = useState(false);

  /**
   * The whole behaviour change: discard the override and follow the device
   * again. `useReducedMotionSync` (App.tsx) already re-subscribes to the media
   * query whenever the preference changes, so writing `'auto'` recomputes the
   * resolved boolean and reattaches the OS listener on its own. Nothing else
   * is touched — in particular this is a settings patch, not a reset, so the
   * saved club survives.
   */
  const revert = (): void => setSettings({ ...settings, reducedMotion: 'auto' });

  return (
    <Sheet title="Settings" onClose={closeSheet}>
      <Toggle
        label="Sound"
        hint="Music and effects. Loads on your first tap."
        on={settings.audio}
        onChange={(audio) => setSettings({ ...settings, audio })}
      />

      {/*
        The switch is two-state but the setting is three, so once a player taps
        it `auto` is unreachable — and on a device that asks to reduce motion
        the first tap lands on `off`, turning motion *on* against the device's
        request (DUB-74). This action is the way back, and it does a second
        job: its presence is what makes `auto` legible, without widening the
        row into a three-state control.

        It is a *sibling* of the toggle, never a child. `Toggle` renders a
        `<button role="switch">`, and a nested button is invalid HTML and
        unreachable by tap.
      */}
      <div className="setting-group">
        <Toggle
          label="Reduced motion"
          hint={
            settings.reducedMotion === 'auto'
              ? 'Following your device setting. Shake and confetti become a flash.'
              : 'Shake and confetti become a flash. Feedback is never removed.'
          }
          on={resolveReducedMotionToggle(settings.reducedMotion)}
          onChange={(on) => setSettings({ ...settings, reducedMotion: on ? 'on' : 'off' })}
        />

        {settings.reducedMotion !== 'auto' && (
          <button
            type="button"
            className="setting-revert"
            // The visible string is contained in the accessible name, so
            // WCAG 2.5.3 Label in Name holds.
            aria-label="Reduced motion: follow my device setting"
            // `onPointerDown` for the sub-100 ms touch response the rest of
            // the UI holds itself to; the `click` guard is keyboard only. A
            // keyboard-synthesised click carries `detail === 0` and a
            // pointer-driven one does not, so a tap never fires this twice.
            onPointerDown={revert}
            onClick={(e) => {
              if (e.detail === 0) revert();
            }}
          >
            Follow my device setting
          </button>
        )}
      </div>

      <Toggle
        label="Vibration"
        hint="A 10 ms tap on every press, where the device supports it."
        on={settings.haptics}
        onChange={(haptics) => setSettings({ ...settings, haptics })}
      />

      <div className="settings-reset">
        <h3 className="settings-reset__title">Reset club</h3>
        <p className="settings-reset__hint">
          {storageUnavailable
            ? 'Nothing is saved in this browser mode, so there is nothing stored to clear.'
            : 'Deletes your saved club and starts over. This cannot be undone.'}
        </p>

        {/*
          Two steps, and the destructive one is the second. The first press
          only reveals the choice — nobody loses a twenty-minute club to a
          mis-tap in the thumb zone. The cancel option is phrased plainly;
          §"no dark patterns" rules out making it feel like the wrong choice.
        */}
        {confirmingReset ? (
          <div className="settings-reset__confirm">
            <button
              type="button"
              className="cta cta--danger"
              onPointerDown={() => {
                actions.resetSave();
                setConfirmingReset(false);
              }}
            >
              Delete my club
            </button>
            <button
              type="button"
              className="cta cta--quiet"
              onPointerDown={() => setConfirmingReset(false)}
            >
              Keep it
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="cta cta--quiet"
            onPointerDown={() => setConfirmingReset(true)}
          >
            Reset club…
          </button>
        )}
      </div>
    </Sheet>
  );
}

/**
 * `auto` is shown as the resolved device preference rather than as a third
 * state. Three-state toggles in a settings list are a usability tax, and the
 * hint line already says which it is following.
 */
function resolveReducedMotionToggle(value: 'auto' | 'on' | 'off'): boolean {
  if (value === 'on') return true;
  if (value === 'off') return false;
  return typeof window !== 'undefined'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

interface ToggleProps {
  readonly label: string;
  readonly hint: string;
  readonly on: boolean;
  readonly onChange: (on: boolean) => void;
}

/**
 * A switch with a state *word* as well as a position.
 *
 * §9: never signal state by colour alone. A knob that slides is a position
 * change, which is fine, but "On"/"Off" next to it means the state survives
 * any rendering, any colour vision, and a screen reader.
 */
function Toggle({ label, hint, on, onChange }: ToggleProps): React.JSX.Element {
  return (
    <button
      type="button"
      className="toggle"
      role="switch"
      aria-checked={on}
      onPointerDown={() => onChange(!on)}
    >
      <span className="toggle__text">
        <span className="toggle__label">{label}</span>
        <span className="toggle__hint">{hint}</span>
      </span>
      <span className="toggle__control">
        <span className="toggle__state">{on ? 'On' : 'Off'}</span>
        <span className={`toggle__track${on ? ' toggle__track--on' : ''}`} aria-hidden="true">
          <span className="toggle__knob" />
        </span>
      </span>
    </button>
  );
}
