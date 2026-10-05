/**
 * Which input events are allowed to spend the player's money (DUB-51).
 *
 * `BuyButton` buys on `pointerdown`, deliberately: on mobile `click` arrives up
 * to ~300 ms after the finger lands, and DUB-38 needs the purchase to land in
 * the same frame as the press. But keyboard activation of a `<button>` produces
 * a `click` and no `pointerdown` at all — so Enter and Space tabbed onto a buy
 * button got the press treatment (`.cta:active` is in the DUB-38 rule, and
 * `:active` does apply while Space is held) and bought nothing. A convincing
 * press for a transaction that never happened.
 *
 * So the button listens on both, and the question becomes which of the two
 * events in front of it is a *fresh* activation rather than the tail of one it
 * already served. A pointer tap fires `pointerdown` and then, ~300 ms later, a
 * compatibility `click`; serving both would charge the player twice.
 *
 * Two independent facts answer that, and this module requires both to agree
 * before a `click` is allowed to buy:
 *
 *  - **`event.detail`** is the click count, so it is `0` on a click no pointer
 *    produced — the keyboard's, and an assistive technology's synthetic one.
 *    This is the usual test and it is the one the ticket names.
 *  - **`pointerServed`** records that we have already run a `pointerdown` for
 *    this button, and is cleared by the next `keydown`. It needs no assumption
 *    about what a given engine puts in `detail` for a touch-derived click, and
 *    a `keydown` always precedes the keyboard's `click` — Enter synthesises it
 *    from the keydown's default action, Space from the keyup's.
 *
 * Requiring both is not belt-and-braces for its own sake. The two failures are
 * not equally bad: a swallowed keypress is the bug we are fixing, while a
 * double purchase takes money the player did not agree to spend. So the guard
 * that cannot be fooled by a touch engine's `detail` value is the one that gets
 * the veto, and `detail` rules out the clicks it already knows about.
 *
 * It all lives here rather than inline in `Sheet.tsx` because "exactly one
 * `onBuy` per activation, by either route" is a claim about a *sequence* of
 * events, and `vitest` runs on the node environment with no DOM to dispatch
 * them into. As a pure function over a mutable box and the one field of the
 * event that matters, the sequence is a unit test — see `ctaPress.test.ts`.
 */

/** The mutable half: a `useRef` in the component, a plain object in a test. */
export interface ActivationFlag {
  current: boolean;
}

/**
 * The only field of a `click` this decision reads.
 *
 * Typed structurally so a test can pass `{ detail: 0 }` and `Sheet.tsx` can
 * pass React's `MouseEvent`, which has it.
 */
export interface ActivationClick {
  readonly detail: number;
}

export interface BuyActivationInput {
  /**
   * Set when we serve a `pointerdown`, cleared on `keydown`. Survives
   * `pointerup`/`pointercancel` on purpose: the compatibility `click` it has to
   * suppress arrives *after* those.
   */
  readonly pointerServed: ActivationFlag;
  /** Nothing left to buy, or buying is switched off: feedback yes, purchase no. */
  readonly inactive: boolean;
  readonly onBuy: () => void;
  /** Drives `.cta--pressed`. */
  readonly setPressed: (pressed: boolean) => void;
}

export interface BuyActivationHandlers {
  readonly pointerDown: () => void;
  readonly keyDown: () => void;
  readonly click: (event: ActivationClick) => void;
  /** `pointerup`, `pointercancel`, `pointerleave` — the press class, nothing else. */
  readonly release: () => void;
}

export function buyActivation({
  pointerServed,
  inactive,
  onBuy,
  setPressed,
}: BuyActivationInput): BuyActivationHandlers {
  return {
    pointerDown: () => {
      // Unconditionally, and before the purchase: the tap that buys nothing is
      // exactly the one DUB-38 found this button swallowing.
      setPressed(true);
      // Marked even on an inactive button. The compatibility `click` comes
      // either way, and by then the button may be affordable — the purchase
      // this event could not make is not one the click should make for it.
      pointerServed.current = true;
      if (!inactive) onBuy();
    },

    // A key is down, so the click that follows it is the keyboard's and not the
    // tail of some earlier tap on this same button. Nothing is bought here:
    // letting `keydown` buy would charge a held Space once per repeat, and
    // Space's own activation is on the way up.
    keyDown: () => {
      pointerServed.current = false;
    },

    click: (event) => {
      // The pointer path already transacted on `pointerdown`. Consume the flag:
      // one `pointerdown` suppresses one `click`, not every click thereafter.
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

    release: () => {
      setPressed(false);
    },
  };
}
