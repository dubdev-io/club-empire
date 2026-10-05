/**
 * Which input events are allowed to spend the player's money (DUB-51, DUB-60).
 *
 * Three facts about this button pull against each other, and this module is
 * where they are reconciled:
 *
 *  - The **press has to be answered in the same frame** the finger lands, or the
 *    button feels dead. That is DUB-38, and it is why `pointerdown` has a
 *    handler at all; `click` on mobile arrives up to ~300 ms later and misses
 *    criterion 2's 100 ms budget on its own.
 *  - The **keyboard never produces a `pointerdown`**. Enter and Space on a
 *    focused `<button>` produce a `click` and nothing else, so for a while the
 *    keyboard got the press treatment (`:active` does apply while Space is
 *    held) and bought nothing — a convincing press for a transaction that never
 *    happened. That is DUB-51.
 *  - The **press is not yet a decision to buy**. The BARS sheet scrolls and is
 *    mostly made of buy buttons, so the surface a player starts a scroll from
 *    is almost always one of them. Buying on `pointerdown` therefore charged
 *    for a scroll: QA measured a 200 px upward drag started on an affordable
 *    `Upgrade to Lv 2` taking the money before the gesture was ever recognised
 *    as a scroll. That is DUB-60.
 *
 * So the press and the purchase are split. **Feedback stays on `pointerdown`**,
 * unchanged and unconditional — DUB-38 is not weakened by any of this.
 * **The purchase moves to `pointerup`**, which is not the slow event: `click`
 * is the one that waits ~300 ms for a possible double-tap or gesture, while
 * `pointerup` is dispatched as the finger leaves the glass. The purchase lands
 * in the frame the player lets go, and a gesture that turns into a scroll never
 * gets there, because the browser sends `pointercancel` instead of `pointerup`.
 *
 * A release only buys if all of these hold, and each one is a gesture that is
 * known not to be something else:
 *
 *  - **It is the pointer we armed.** `armedPointerId` records the pointer whose
 *    `pointerdown` we served. A `pointerup` for any other pointer is a second
 *    finger, not this one lifting.
 *  - **The gesture was never taken over or abandoned.** `pointercancel` (a
 *    scroll claiming the touch) and `pointerleave` (a mouse dragged off — it has
 *    no implicit capture, so its `pointerup` lands elsewhere) both disarm.
 *  - **The release is on the button.** Touch *is* implicitly captured, so a
 *    finger dragged clear off still delivers `pointerup` here; without a
 *    geometry check, "drag off the control and let go" — the one gesture every
 *    touch platform treats as "I changed my mind" — would buy.
 *  - **The press was not a dead end.** `inactive` is read at press *and* at
 *    release, so a button that was maxed or switched off when the finger landed
 *    cannot be bought by letting go after it goes live.
 *
 * And `pointerServed` keeps the compatibility `click` that trails every tap
 * from charging the player a second time. Which of the two events gets to spend
 * money is decided by two independent facts, and both must agree before a
 * `click` is allowed to buy:
 *
 *  - **`event.detail`** is the click count, so it is `0` on a click no pointer
 *    produced — the keyboard's, and an assistive technology's synthetic one.
 *    This is the usual test and it is the one DUB-51 names.
 *  - **`pointerServed`** records that we have already run a `pointerdown` for
 *    this button, and is cleared by the next `keydown`. It needs no assumption
 *    about what a given engine puts in `detail` for a touch-derived click, and
 *    a `keydown` always precedes the keyboard's `click` — Enter synthesises it
 *    from the keydown's default action, Space from the keyup's.
 *
 * Requiring both is not belt-and-braces for its own sake. The two failures are
 * not equally bad: a swallowed keypress is an input that does nothing, while a
 * double purchase takes money the player did not agree to spend. The same
 * asymmetry settles every other close call in here — notably `pointerleave`
 * disarming the gesture rather than waiting to see whether the pointer comes
 * back. A mouse pressed on the button, dragged off and brought back before
 * release buys nothing, where the browser's own `click` would have fired. That
 * is a deliberate cost: it is a gesture that spends two thirds of its life
 * looking like a cancellation, on the input this game does not ship on, and the
 * alternative is a pointer id left armed across gestures on a device whose
 * mouse reuses the same id forever.
 *
 * It all lives here rather than inline in `Sheet.tsx` because "exactly one
 * `onBuy` per activation, by either route, and none at all for a scroll" is a
 * claim about a *sequence* of events, and `vitest` runs on the node environment
 * with no DOM to dispatch them into. As a pure function over two mutable boxes
 * and the few fields of the events that matter, the sequence is a unit test —
 * see `ctaPress.test.ts`.
 */

/** The mutable half: a `useRef` in the component, a plain object in a test. */
export interface ActivationFlag {
  current: boolean;
}

/** The pointer currently armed to buy, or `null` for none. */
export interface ActivationPointerBox {
  current: number | null;
}

/**
 * How far past its own edge a release still counts as on the button.
 *
 * Two reasons it cannot be zero. The press transform is `scale(0.97)`, and
 * `getBoundingClientRect` reports the *transformed* box — on a full-width CTA at
 * 390 px that is about 5 px lost from each side at the exact moment we measure,
 * so an honest release on the last few pixels of the button would read as off
 * it. And a thumb on a 56 px target drifts a little between landing and
 * lifting; a tolerance window is what makes a control feel fair rather than
 * fussy. 12 px covers both and is still a long way short of the next button
 * down, so "slide off and let go" remains a cancellation.
 */
export const RELEASE_SLOP_PX = 12;

/**
 * The fields of a `click` this decision reads.
 *
 * Typed structurally so a test can pass `{ detail: 0 }` and `Sheet.tsx` can
 * pass React's `MouseEvent`, which has it.
 */
export interface ActivationClick {
  readonly detail: number;
}

/** A `pointerdown`: only the identity of the pointer matters. */
export interface ActivationPress {
  readonly pointerId: number;
}

/** The part of a `DOMRect` a hit test needs. */
export interface ActivationRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** A `pointerup`: which pointer lifted, and where. */
export interface ActivationRelease extends ActivationPress {
  readonly clientX: number;
  readonly clientY: number;
  readonly currentTarget: { readonly getBoundingClientRect: () => ActivationRect };
}

export interface BuyActivationInput {
  /**
   * Set when we serve a `pointerdown`, cleared on `keydown`. Survives
   * `pointerup`/`pointercancel` on purpose: the compatibility `click` it has to
   * suppress arrives *after* those.
   */
  readonly pointerServed: ActivationFlag;
  /**
   * The pointer whose release may buy. Armed by a `pointerdown` on a live
   * button, and cleared the moment the gesture resolves — by the release itself,
   * or by `pointercancel`/`pointerleave` taking it away.
   */
  readonly armedPointerId: ActivationPointerBox;
  /** Nothing left to buy, or buying is switched off: feedback yes, purchase no. */
  readonly inactive: boolean;
  readonly onBuy: () => void;
  /** Drives `.cta--pressed`. */
  readonly setPressed: (pressed: boolean) => void;
}

export interface BuyActivationHandlers {
  readonly pointerDown: (event: ActivationPress) => void;
  /** `pointerup` — the purchase, if the gesture earned it. */
  readonly pointerUp: (event: ActivationRelease) => void;
  /** `pointercancel`, `pointerleave` — the gesture is no longer a tap. */
  readonly abort: () => void;
  readonly keyDown: () => void;
  readonly click: (event: ActivationClick) => void;
}

/** Was the pointer still on the button when it lifted? */
function releasedOnButton(event: ActivationRelease): boolean {
  const rect = event.currentTarget.getBoundingClientRect();

  return (
    event.clientX >= rect.left - RELEASE_SLOP_PX &&
    event.clientX <= rect.right + RELEASE_SLOP_PX &&
    event.clientY >= rect.top - RELEASE_SLOP_PX &&
    event.clientY <= rect.bottom + RELEASE_SLOP_PX
  );
}

export function buyActivation({
  pointerServed,
  armedPointerId,
  inactive,
  onBuy,
  setPressed,
}: BuyActivationInput): BuyActivationHandlers {
  return {
    pointerDown: (event) => {
      // Unconditionally, and whatever the gesture turns out to be: the tap that
      // buys nothing is exactly the one DUB-38 found this button swallowing,
      // and a scroll that starts here should still light the button up under
      // the finger before it moves.
      setPressed(true);
      // Marked even on an inactive button, and even though no purchase has been
      // made yet. The compatibility `click` comes either way, and by then the
      // button may be live — the purchase this gesture did not make is not one
      // the click should make for it.
      pointerServed.current = true;
      // A dead-end press is never armed. Nothing that happens between here and
      // the release can turn it into a purchase.
      armedPointerId.current = inactive ? null : event.pointerId;
    },

    pointerUp: (event) => {
      // The press class goes whatever else is true: the finger is off the glass.
      setPressed(false);

      // Not the pointer we armed — a second finger, or a gesture `pointercancel`
      // or `pointerleave` already took away. Leave the box alone: if another
      // pointer is still armed on this button, its own release is still good.
      if (armedPointerId.current !== event.pointerId) return;
      armedPointerId.current = null;

      // Switched off or maxed out while the finger was down.
      if (inactive) return;
      // Dragged off and released — every touch platform's "I changed my mind".
      if (!releasedOnButton(event)) return;

      onBuy();
    },

    // The gesture stopped being a tap. `pointercancel` is a scroll claiming the
    // touch, which is the whole of DUB-60; `pointerleave` is a mouse leaving
    // the button, which is not captured and will deliver its `pointerup`
    // somewhere else entirely.
    abort: () => {
      setPressed(false);
      armedPointerId.current = null;
    },

    // A key is down, so the click that follows it is the keyboard's and not the
    // tail of some earlier tap on this same button. Nothing is bought here:
    // letting `keydown` buy would charge a held Space once per repeat, and
    // Space's own activation is on the way up.
    keyDown: () => {
      pointerServed.current = false;
    },

    click: (event) => {
      // A pointer gesture ran on this button, and it has already had its one
      // chance to transact on `pointerup`. Consume the flag: one `pointerdown`
      // suppresses one `click`, not every click thereafter.
      if (pointerServed.current) {
        pointerServed.current = false;
        return;
      }
      if (event.detail !== 0) return;

      // No press treatment to set here. For the keyboard it is CSS's: `:active`
      // is held for the length of a Space press, which is longer than anything
      // this handler could time, and a class set on `click` would paint for one
      // frame after the key is already up.
      if (!inactive) onBuy();
    },
  };
}
