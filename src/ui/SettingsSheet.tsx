import { useEffect, useRef, useState } from 'react';
import { useGameStore } from '../state/store.ts';
import { activationProps } from './activation.ts';
import { confirmFocusTarget } from './confirmFocus.ts';
import { Sheet } from './Sheet.tsx';

/**
 * Settings: audio, reduced motion, haptics, reset.
 *
 * Phase 1 scope is explicit that there are **no settings beyond audio and
 * reduced-motion** (haptics rides along because §9 requires the 10 ms vibrate
 * to sit behind a toggle). No account, no cloud save, no difficulty, no
 * language. The list being short is the feature.
 *
 * Every control in here had DUB-59's bug too, and none of them is in that
 * ticket's table — until the bottom-bar tabs were fixed, nobody on a keyboard
 * could open this sheet to find them. Four more `pointerdown`-only buttons,
 * including the one that deletes the save, and three of them carrying
 * `role="switch"` and `aria-checked`: announced to a screen reader as toggles
 * it could flip, and unflippable.
 */
export function SettingsSheet(): React.JSX.Element {
  const closeSheet = useGameStore((s) => s.closeSheet);
  const settings = useGameStore((s) => s.settings);
  const setSettings = useGameStore((s) => s.setSettings);
  const actions = useGameStore((s) => s.actions);
  const storageUnavailable = useGameStore((s) => s.storageUnavailable);

  const [confirmingReset, setConfirmingReset] = useState(false);

  /*
   * Both steps of the confirm unmount the button that was pressed, which
   * drops focus to `<body>` — see `confirmFocus.ts` for why that is a WCAG
   * 2.4.3 defect and why the repair has to land on "Keep it" rather than on
   * the destructive button.
   *
   * The previous value is a ref and not state because changing it must not
   * render: it is read inside the effect that the real state change already
   * scheduled.
   */
  const revealRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const wasConfirmingRef = useRef(confirmingReset);

  useEffect(() => {
    const target = confirmFocusTarget({
      confirming: confirmingReset,
      wasConfirming: wasConfirmingRef.current,
      // By the time an effect runs, React has already removed the old button
      // and the browser has already moved focus off it.
      focusLost: document.activeElement === null || document.activeElement === document.body,
    });
    wasConfirmingRef.current = confirmingReset;

    if (target === 'cancel') cancelRef.current?.focus();
    if (target === 'reveal') revealRef.current?.focus();
  }, [confirmingReset]);

  return (
    <Sheet title="Settings" onClose={closeSheet}>
      <Toggle
        label="Sound"
        hint="Music and effects. Loads on your first tap."
        on={settings.audio}
        onChange={(audio) => setSettings({ ...settings, audio })}
      />

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
            {/*
              The one action in the app that is destructive and unrecoverable,
              which is why it is behind the reveal above and why the key-repeat
              guard in `activation.ts` matters here more than anywhere: a
              leaned-on Enter must not delete the club it has just revealed.
            */}
            <button
              type="button"
              className="cta cta--danger"
              {...activationProps({
                onAct: () => {
                  actions.resetSave();
                  setConfirmingReset(false);
                },
              })}
            >
              Delete my club
            </button>
            {/*
              Focus lands here when the step opens, not on the button above
              it. The reveal is a question, and the answer it arrives already
              holding has to be the one that changes nothing.
            */}
            <button
              ref={cancelRef}
              type="button"
              className="cta cta--quiet"
              {...activationProps({ onAct: () => setConfirmingReset(false) })}
            >
              Keep it
            </button>
          </div>
        ) : (
          <button
            ref={revealRef}
            type="button"
            className="cta cta--quiet"
            {...activationProps({ onAct: () => setConfirmingReset(true) })}
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
 *
 * `role="switch"` is also a promise that Enter and Space flip it, which until
 * DUB-59 it did not keep.
 */
function Toggle({ label, hint, on, onChange }: ToggleProps): React.JSX.Element {
  return (
    <button
      type="button"
      className="toggle"
      role="switch"
      aria-checked={on}
      {...activationProps({ onAct: () => onChange(!on) })}
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
