import { useState } from 'react';
import type { ReactNode } from 'react';
import { buyActivation, buyActivationLog, performanceClock } from './buyActivation.ts';
import { ctaClassName } from './ctaClass.ts';

/**
 * The bottom sheet every panel in the game uses.
 *
 * §9's sheet rules, all of them enforced here rather than per-panel: max 70% of
 * the viewport, internally scrollable, a visible drag handle, and a 44x44 close
 * button in the top-right. Tapping the scrim closes it, and so does `Escape` —
 * that part lives in `App` because it is one listener for the whole overlay
 * stack rather than one per sheet.
 *
 * The drag handle is a signifier, not a control: §9 fixes Phase 1 to tap only,
 * no drag. It is there because a sheet without one does not read as
 * dismissable, and the two things that do dismiss it are both larger than the
 * handle.
 */
export interface SheetProps {
  readonly title: string;
  /** Optional line under the title. Reading material, not a control. */
  readonly subtitle?: ReactNode | undefined;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

export function Sheet({ title, subtitle, onClose, children }: SheetProps): React.JSX.Element {
  return (
    <div className="overlay" role="presentation">
      {/*
        The scrim is a tap target for dismissal, not a button — it carries no
        label and must not be reachable by keyboard, because the close button
        and Escape already are.
      */}
      <div className="overlay__scrim" onPointerDown={onClose} aria-hidden="true" />

      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet__handle" aria-hidden="true" />

        <header className="sheet__header">
          <div>
            <h2 className="sheet__title">{title}</h2>
            {subtitle !== undefined && <p className="sheet__subtitle">{subtitle}</p>}
          </div>
          <button type="button" className="icon-button" onPointerDown={onClose} aria-label={`Close ${title}`}>
            {/* A glyph, not an icon font: no webfont in Phase 1. */}
            <span aria-hidden="true">✕</span>
          </button>
        </header>

        <div className="sheet__body">{children}</div>
      </div>
    </div>
  );
}

/**
 * The primary action in a sheet: 56 px tall, full width minus two gutters.
 *
 * The pointer buys on `onPointerDown`, not `onClick`: on mobile `click` fires
 * up to ~300 ms after the finger lands, and that delay is the whole difference
 * between a button that feels connected and one that feels dead. Criterion 2 is
 * a 100 ms budget — `click` alone can miss it on its own.
 *
 * `onClick` is there as well, but only for the activation a pointer never
 * makes: Enter and Space on a focused button produce a `click` and no
 * `pointerdown`, so for a keyboard player the fast path above was no path at
 * all (DUB-51). Which event gets to spend money — and how a tap is kept from
 * spending it twice, and a leaned-on Enter key from spending it thirty times a
 * second — is `buyActivation.ts`.
 *
 * Unaffordable is signalled two ways, because §9 forbids colour alone: a lock
 * glyph before the price, and the price itself in `--ink-disabled`. The
 * `aria-disabled` opacity is not one of them — `inactive` is `disabled ||
 * isDone`, never `!affordable`, so an unaffordable button keeps full opacity.
 *
 * Both of those are *at rest*. The press is signalled separately, and from
 * the input events rather than left to CSS `:active` — see `pressed` below.
 */
export interface BuyButtonProps {
  readonly label: string;
  readonly price: string;
  readonly affordable: boolean;
  readonly disabled?: boolean | undefined;
  /** Shown instead of the price when there is nothing left to buy. */
  readonly doneLabel?: string | undefined;
  readonly accent?: 'magenta' | 'cyan' | undefined;
  readonly onBuy: () => void;
}

export function BuyButton({
  label,
  price,
  affordable,
  disabled = false,
  doneLabel,
  accent = 'magenta',
  onBuy,
}: BuyButtonProps): React.JSX.Element {
  const isDone = doneLabel !== undefined;
  const inactive = disabled || isDone;

  /*
   * The pressed state, driven from input events instead of CSS `:active`.
   *
   * `.cta:active` is still in the stylesheet and still carries the mouse, but
   * it cannot be the *only* source on either of the inputs that matter here.
   * iOS Safari withholds `:active` on touch unless a touch handler
   * sits in the element's ancestor chain, and React's root-level `pointerdown`
   * delegation is not one; `global.css` also clears
   * `-webkit-tap-highlight-color` document-wide, so the platform's own press
   * affordance is gone too. A `:active`-only press can therefore reach a phone
   * as no feedback at all — which is the whole of DUB-38. A class we set
   * ourselves cannot.
   *
   * The keyboard has the narrower version of the same problem. A held Space is
   * reliably `:active`, but Enter's activation is instantaneous and whether it
   * paints `:active` at all is the browser's own business — so on a dead-end
   * button, where the press treatment is the entire answer to the press, an
   * Enter could have produced nothing to see. So the key events set the class
   * too (DUB-51).
   *
   * One `useState` per button, set on `pointerdown`/`keydown` and cleared on
   * the way up. This is sheet UI, not the game loop: it re-renders one button,
   * and it does it in the same event, so the paint lands on the next frame
   * either way.
   */
  const [pressed, setPressed] = useState(false);

  /*
   * Which events may buy.
   *
   * The log is module-level rather than a `useRef`, because a purchase remounts
   * its own row — buying `Unlock` in `BarsSheet` replaces the pressed button
   * with two new ones — and the compatibility click that must be suppressed
   * arrives after that, at whatever button is now under the finger. A per-
   * instance ref is reset exactly when it is needed. See `buyActivation.ts`.
   */
  const activation = buyActivation({
    log: buyActivationLog,
    clock: performanceClock,
    inactive,
    onBuy,
    setPressed,
  });

  return (
    <button
      type="button"
      // `maxed: isDone` carries DUB-42: `cta--maxed` is what lets the gold
      // badge stay readable, because the disabled dim cannot sit on a button
      // that contains a child which must clear 4.5:1, so that row dims its
      // label instead. See `.cta--maxed` in ui.css.
      className={ctaClassName({ accent, affordable, inactive, maxed: isDone, pressed })}
      // Not `disabled`: a disabled button takes no pointer events and gets no
      // `:active` either, so an unaffordable one would answer a tap with
      // nothing at all — and §9 requires every tap to produce a visible
      // change. So the button stays live and the tap is answered by the press
      // treatment instead (`.cta--pressed` in ui.css): the button shrinks, its
      // edge lights up where it used to dissolve into the card behind it, and
      // on a tap that buys nothing the price lights up with it. `onBuy` is
      // still withheld. A keypress on the same button reads the same, because
      // the key handlers set the same class, and is withheld the same way.
      aria-disabled={inactive}
      onPointerDown={activation.pointerDown}
      onPointerUp={activation.pointerEnd}
      // A finger is implicitly captured by the element that got `pointerdown`,
      // so touch always delivers its `up` here. `pointercancel` covers the
      // gesture being taken over (a scroll starting), and `pointerleave` the
      // mouse, which is *not* captured: dragged off the button before release
      // it fires neither, and the class would stick.
      onPointerCancel={activation.pointerEnd}
      onPointerLeave={activation.pointerEnd}
      // Focus can be taken while a key is held — a click elsewhere, or the row
      // this button sits in being replaced by the purchase itself — and then
      // the `keyup` never arrives here. Without this the press class sticks,
      // and so does the held key's suppression of clicks it will never make
      // again, which costs the next synthetic activation its purchase.
      onBlur={activation.cancelPress}
      // The keyboard's three events. Neither key event buys: they set the press
      // treatment, and they tell the click handler whether the click on its way
      // is a fresh keypress, a key *repeat*, or the tail of an earlier tap.
      onKeyDown={activation.keyDown}
      onKeyUp={activation.keyUp}
      onClick={activation.click}
    >
      <span className="cta__label">{label}</span>
      {isDone ? (
        <span className="cta__done">{doneLabel}</span>
      ) : (
        <span className={`cta__price${affordable ? ' cta__price--affordable' : ''}`}>
          {!affordable && (
            <span className="cta__lock" aria-hidden="true">
              🔒
            </span>
          )}
          {price}
        </span>
      )}
    </button>
  );
}
