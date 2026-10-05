import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { buyActivation } from './buyActivation.ts';
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
 * The press and the purchase are two different events here. The *press* is
 * answered on `onPointerDown`, because on mobile `click` fires up to ~300 ms
 * after the finger lands and that delay is the whole difference between a
 * button that feels connected and one that feels dead — criterion 2 is a 100 ms
 * budget, and `click` alone can miss it on its own.
 *
 * The *purchase* is committed on `onPointerUp`, which is not that slow event:
 * `pointerup` is dispatched as the finger leaves the glass. Waiting for it is
 * what stops a scroll of this sheet from buying whatever its first pixel landed
 * on (DUB-60) — a gesture the browser hands to the scroller arrives here as
 * `pointercancel` and never as `pointerup`.
 *
 * `onClick` is there as well, but only for the activation a pointer never
 * makes: Enter and Space on a focused button produce a `click` and no pointer
 * events at all, so for a keyboard player the pointer path was no path at all
 * (DUB-51). Which of the events gets to spend money, how a tap is kept from
 * spending it twice, and which releases are not purchases, is
 * `buyActivation.ts`.
 *
 * Unaffordable is signalled three ways, because §9 forbids colour alone:
 * reduced opacity, a lock glyph, and the price in `--ink-disabled`.
 *
 * Those three are all *at rest*. The press is signalled separately, and from
 * pointer events rather than left to CSS `:active` — see `pressed` below.
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
   * The pressed state, driven from pointer events instead of CSS `:active`.
   *
   * `.cta:active` is still in the stylesheet and still carries the mouse and
   * the keyboard, but it cannot be the *only* source on the device this game
   * targets. iOS Safari withholds `:active` on touch unless a touch handler
   * sits in the element's ancestor chain, and React's root-level `pointerdown`
   * delegation is not one; `global.css` also clears
   * `-webkit-tap-highlight-color` document-wide, so the platform's own press
   * affordance is gone too. A `:active`-only press can therefore reach a phone
   * as no feedback at all — which is the whole of DUB-38. A class we set
   * ourselves cannot.
   *
   * One `useState` per button, set on `pointerdown` and cleared on the way up.
   * This is sheet UI, not the game loop: it re-renders one button, and it does
   * it in the same event, so the paint lands on the next frame either way.
   */
  const [pressed, setPressed] = useState(false);

  /*
   * The gesture so far. Refs, not state: they are read and written inside the
   * handlers and must never cause a render.
   *
   * `pointerServed` is which events may buy — see `buyActivation.ts` for what
   * it means and why `pointerup` does not clear it. `armedPointerId` is the
   * pointer whose release is allowed to transact, which is how a scroll, a
   * second finger, and a drag off the button all end up buying nothing.
   */
  const pointerServed = useRef(false);
  const armedPointerId = useRef<number | null>(null);
  const activation = buyActivation({ pointerServed, armedPointerId, inactive, onBuy, setPressed });

  return (
    <button
      type="button"
      className={ctaClassName({ accent, affordable, inactive, pressed })}
      // Not `disabled`: a disabled button takes no pointer events and gets no
      // `:active` either, so an unaffordable one would answer a tap with
      // nothing at all — and §9 requires every tap to produce a visible
      // change. So the button stays live and the tap is answered by the press
      // treatment instead (`.cta--pressed` in ui.css): the button shrinks, its
      // edge lights up where it used to dissolve into the card behind it, and
      // on a tap that buys nothing the price lights up with it. `onBuy` is
      // still withheld. A keypress on the same button reads the same, from the
      // `:active` half of those rules, and is withheld the same way.
      aria-disabled={inactive}
      onPointerDown={activation.pointerDown}
      // A finger is implicitly captured by the element that got `pointerdown`,
      // so touch always delivers its `up` here — including when it has been
      // dragged well clear of the button, which is why the handler hit-tests
      // the release rather than trusting its target.
      onPointerUp={activation.pointerUp}
      // The two ways a gesture stops being a tap. `pointercancel` is it being
      // taken over, which for this sheet means a scroll starting; `pointerleave`
      // is the mouse, which is *not* captured: dragged off the button before
      // release it fires neither of the other two, and the press class would
      // stick.
      onPointerCancel={activation.abort}
      onPointerLeave={activation.abort}
      // The keyboard's two events. `onKeyDown` buys nothing — it only tells the
      // click handler that the click on its way is a keypress and not the tail
      // of an earlier tap.
      onKeyDown={activation.keyDown}
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
