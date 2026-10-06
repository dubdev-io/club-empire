import { useEffect, useRef } from 'react';

/**
 * The focus trap that makes `aria-modal="true"` true (DUB-72).
 *
 * Every `role="dialog"` in this game already claimed to be modal, and none of
 * them was: `App` renders `<Hud />`, `<Banners />` and `<BottomBar />` before the
 * overlays, nothing was `inert`, and so the first three stops in the tab ring of
 * an open sheet were the three bottom-bar buttons — behind `.overlay__scrim`.
 * Two failures from one cause. The attribute was a false claim to every AT that
 * trusts it, and the ring DUB-50 drew composited *under* the scrim at 2.27:1,
 * failing WCAG 1.4.11 with no colour available to fix it (only a ring below
 * L 0.265 would clear 3:1 there, and that ring fails on every unobscured
 * surface instead).
 *
 * ## Why a Tab handler, and not `inert` or `<dialog>`
 *
 * **`inert` on the siblings** is the mechanism that would also remove the
 * behind-content from the accessibility tree, which is strictly more than this
 * does. It is rejected on cost, not on merit. `App` renders the behind-content
 * as four flat children of `#ui-root`, which is the `display: flex` column the
 * whole portrait layout hangs off — the HUD at the top, `.club-spacer` taking
 * the slack, the bar above the home indicator. Wrapping them to get one element
 * to mark collapses four flex items into one, and the alternative is mutating
 * `inert` on four nodes React owns, on open and on close, which is the version
 * that silently stops covering a fifth child the day someone adds one.
 *
 * **A real `<dialog>` + `showModal()`** gets the trap, the top layer and the
 * backdrop from the browser. It is rejected because it owns too much: it brings
 * its own Escape handling and its own close semantics, and `App`'s
 * `useOverlayDismissal` already routes Escape *and* Android back through one
 * history entry per overlay. Two dismissal authorities on the same overlay is a
 * worse bug than the one being fixed, and the top layer takes `.sheet` out of
 * the stacking context `ui.css` positions it in.
 *
 * So: Tab is intercepted, and only at the two places where the browser's own
 * answer would leave the dialog.
 *
 * ## What it does on the two non-sheet overlays
 *
 * `OfflineCard` and `ClubComplete` are `.overlay` with a `role="dialog"` card
 * and one CTA each, and they made exactly the same false claim — so they call
 * this too, and get the same trap. The reason this is a module-level stack and
 * not one listener per overlay is that they can be open *over* a sheet: buying
 * the last upgrade in `BarsSheet` raises `ClubComplete` with the sheet still
 * mounted. Two independent traps in that state fight over focus. One stack with
 * one pair of listeners cannot: the trap that mounted last is the top, and the
 * card gets the ring while the sheet behind it loses it, which is the same rule
 * `topOverlay()` applies to Escape. When the card closes, the stack pops and the
 * sheet is the top again.
 *
 * `StarBurst` is deliberately not in here. It is `role="status"`, holds no
 * controls, auto-dismisses, and is pointer-transparent to the canvas on purpose
 * — trapping focus in it would be trapping focus in a toast.
 */

/** One open dialog. `returnTo` is where focus came from, for the way back. */
interface Trap {
  readonly container: HTMLElement;
  readonly returnTo: HTMLElement | null;
}

/**
 * The open dialogs, innermost last.
 *
 * Module-level rather than context, because the thing that needs to be single
 * is the pair of window listeners, not a React value — see the stacking note
 * above.
 */
const stack: Trap[] = [];

/**
 * What the game can actually put in the tab ring.
 *
 * `[tabindex]:not([tabindex="-1"])` rather than a bare `[tabindex]` so the
 * dialog container itself — which carries `tabindex={-1}` so it can be focused
 * on open — never counts as one of its own stops.
 */
const TABBABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * The stops inside one dialog, in document order.
 *
 * `disabled`, not `aria-disabled`: every unaffordable control in this game is
 * `aria-disabled` and stays live on purpose (DUB-38 — a disabled button answers
 * a tap with nothing at all), so it stays in the tab ring too. A keyboard player
 * has to be able to reach the locked price and read it.
 *
 * `getClientRects()` rather than `offsetParent`, which is null for the
 * `position: fixed` overlay itself and would need a special case.
 */
function stopsWithin(container: HTMLElement): readonly HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (el) => !el.hasAttribute('disabled') && el.getClientRects().length > 0,
  );
}

/**
 * Where Tab has to be *sent*, as an index into the dialog's stops — or `null`
 * when the browser's own Tab already lands inside the dialog and should be left
 * to do it.
 *
 * `null` is the answer for every stop in the middle of the ring, and that is the
 * point of returning it rather than always moving focus by hand. Chrome grants
 * `:focus-visible` on a keyboard-driven focus change and withholds it from a
 * bare programmatic `.focus()`, so a trap that intercepted *every* Tab would
 * erase the ring DUB-50 exists to draw. Only the three cases the browser gets
 * wrong are taken over:
 *
 *  - `from < 0` — focus is outside the dialog, or on the dialog panel itself
 *    just after it opened. The browser would walk into the bottom bar; go to the
 *    near end of the dialog instead.
 *  - the last stop, tabbing forward — wrap to the first.
 *  - the first stop, tabbing backward — wrap to the last.
 */
export function tabDestination(count: number, from: number, backwards: boolean): number | null {
  if (count === 0) return null;
  if (from < 0) return backwards ? count - 1 : 0;
  if (backwards) return from === 0 ? count - 1 : null;
  return from === count - 1 ? 0 : null;
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Tab' || event.defaultPrevented) return;
  const trap = stack[stack.length - 1];
  if (trap === undefined) return;

  const stops = stopsWithin(trap.container);

  // A dialog with nothing tabbable in it. Not a state the game ships — every
  // sheet has its ✕ and every card its CTA — but the panel is focusable, so
  // there is somewhere honest to put focus rather than letting Tab out.
  if (stops.length === 0) {
    event.preventDefault();
    trap.container.focus();
    return;
  }

  const active = document.activeElement;
  const from = active instanceof HTMLElement ? stops.indexOf(active) : -1;
  const to = tabDestination(stops.length, from, event.shiftKey);
  if (to === null) return;

  event.preventDefault();
  stops[to]?.focus();
}

/**
 * The second half of the trap: focus that arrives from outside Tab.
 *
 * A mouse press is the one that matters, and it is specific to this game. Every
 * control here acts on `pointerdown`, which fires *before* `mousedown` — so
 * pressing BARS opens the sheet, and only then does `mousedown`'s default action
 * focus the BARS button, which is now behind the scrim. Tab-trapping alone
 * cannot see that, because no Tab was pressed.
 */
function onFocusIn(event: FocusEvent): void {
  const trap = stack[stack.length - 1];
  if (trap === undefined) return;
  const target = event.target;
  if (target instanceof Node && trap.container.contains(target)) return;
  trap.container.focus();
}

/**
 * Trap focus inside a dialog for as long as it is open.
 *
 * Returns the ref to put on the `role="dialog"` element itself — the same
 * element, not the `.overlay` wrapper, because the scrim is a sibling inside the
 * wrapper and the trap's boundary has to be the thing that claims to be modal.
 * That element also needs `tabIndex={-1}`, which is what lets focus land on the
 * panel rather than on its ✕ when the sheet opens: a screen reader then reads
 * the dialog and its label before its first control, and no stray ring appears
 * on a button the player has not chosen.
 *
 * `active` exists because the two cards are not mounted the way the sheets are.
 * `BarsSheet` and friends are rendered only while open, so for `Sheet` the
 * default is the whole truth; `OfflineCard` and `ClubComplete` are always
 * mounted and return `null` until their flag is set, so the ref arrives long
 * after mount and the effect has to re-run when the card actually appears.
 */
export function useFocusTrap<T extends HTMLElement>(active = true): React.RefObject<T | null> {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const container = ref.current;
    if (!active || container === null) return;

    const previous = document.activeElement;
    const trap: Trap = {
      container,
      returnTo: previous instanceof HTMLElement ? previous : null,
    };

    if (stack.length === 0) {
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('focusin', onFocusIn);
    }
    stack.push(trap);
    container.focus();

    return () => {
      // Off the stack and off the window *before* focus is moved back, or the
      // guard above reads the dialog that is closing as the top one and hauls
      // focus straight back into it.
      const at = stack.indexOf(trap);
      if (at >= 0) stack.splice(at, 1);
      if (stack.length === 0) {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('focusin', onFocusIn);
      }

      // Back to the control that opened this, which for a keyboard player is
      // the bar button they pressed Enter on. `isConnected` is the guard that
      // matters: a purchase can replace the row its button was in, so the thing
      // focus came from may no longer be in the document.
      //
      // A card closing over a still-open sheet returns to the sheet instead —
      // its `returnTo` is whatever was focused when the card appeared, which is
      // inside that sheet only by luck.
      const below = stack[stack.length - 1];
      if (below !== undefined) below.container.focus();
      else if (trap.returnTo?.isConnected === true) trap.returnTo.focus();
    };
  }, [active]);

  return ref;
}
