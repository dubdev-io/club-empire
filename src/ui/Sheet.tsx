import type { ReactNode } from 'react';

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
 * `onPointerDown`, not `onClick`: on mobile `click` fires up to ~300 ms after
 * the finger lands, and that delay is the whole difference between a button
 * that feels connected and one that feels dead. Criterion 2 is a 100 ms
 * budget — `click` alone can miss it on its own.
 *
 * Unaffordable is signalled two ways, because §9 forbids colour alone: a lock
 * glyph before the price, and the price itself in `--ink-disabled`. The
 * `aria-disabled` opacity is not one of them — `inactive` is `disabled ||
 * isDone`, never `!affordable`, so an unaffordable button keeps full opacity.
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

  return (
    <button
      type="button"
      // `cta--maxed` is what lets the gold badge stay readable: the disabled
      // dim cannot sit on a button that contains a child which must clear
      // 4.5:1, so that row dims its label instead. See `.cta--maxed` in ui.css.
      className={`cta cta--${accent}${affordable && !inactive ? ' cta--affordable' : ''}${
        isDone ? ' cta--maxed' : ''
      }`}
      // Not `disabled`: an unaffordable button that cannot be pressed gives no
      // feedback at all, and §9 requires every tap to produce a visible
      // change. Pressing it flashes the price instead, which tells the player
      // the thing they wanted costs more than they have.
      aria-disabled={inactive}
      onPointerDown={inactive ? undefined : onBuy}
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
