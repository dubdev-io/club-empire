/**
 * Which input events are allowed to spend the player's money (DUB-51).
 *
 * `BuyButton` buys on `pointerdown`, deliberately: on mobile `click` arrives up
 * to ~300 ms after the finger lands, and DUB-38 needs the purchase to land in
 * the same frame as the press. But keyboard activation of a `<button>` produces
 * a `click` and no `pointerdown` at all — so Enter and Space tabbed onto a buy
 * button got the press treatment and bought nothing. A convincing press for a
 * transaction that never happened.
 *
 * So the button listens on both, and the question becomes which of the two
 * events in front of it is a *fresh* activation rather than the tail of one it
 * already served. A pointer tap fires `pointerdown` and then, ~300 ms later, a
 * compatibility `click`; serving both would charge the player twice.
 *
 * Three facts answer that, and a `click` has to clear all three:
 *
 *  - **`event.detail`** is the click count, so it is `0` on a click no pointer
 *    produced — the keyboard's, and an assistive technology's synthetic one.
 *    This is the usual test and the one the ticket names. It is also the only
 *    guard that survives the button being torn down under the finger (see
 *    `buyActivationLog` below), which is why it stays even though the window
 *    would catch the ordinary tap on its own.
 *  - **the pointer window** — a `click` inside `POINTER_CLICK_WINDOW_MS` of the
 *    last pointer event of an activation we served is that activation's tail.
 *    It needs no assumption about what a given engine puts in `detail` for a
 *    touch-derived click, which is the assumption the player's money would be
 *    riding on.
 *  - **not a key repeat** — a held Enter synthesises a `click` per repeat, each
 *    one indistinguishable from a fresh keypress by the two facts above. See
 *    `keyDown`/`keyUp`.
 *
 * Requiring all three is not belt-and-braces for its own sake. The failures are
 * not equally bad: a swallowed keypress is the bug we are fixing, while a
 * double purchase takes money the player did not agree to spend. So the guards
 * that cannot be fooled by a touch engine's `detail` value get the veto, and
 * `detail` rules out the clicks they cannot see.
 *
 * **Accepted residual.** A synthetic `click` carrying `detail !== 0` with no
 * pointer events behind it — voice control and some switch-access software
 * dispatch a real `MouseEvent` rather than calling `element.click()` — is
 * rejected and the button does not work for it. That is the price of letting
 * `detail` veto, and it is the right side of the trade: the alternative is a
 * retargeted compat click buying an upgrade nobody pressed. It is a named case
 * in QA's plan, not an unknown.
 *
 * It all lives here rather than inline in `Sheet.tsx` because "exactly one
 * `onBuy` per activation, by either route" is a claim about a *sequence* of
 * events, and `vitest` runs on the node environment with no DOM to dispatch
 * them into. As a pure function over a mutable log, a clock and the one or two
 * fields of the event that matter, the sequence is a unit test — see
 * `ctaPress.test.ts`.
 */

/**
 * How long after a pointer activation a `click` is still read as its tail.
 *
 * The compatibility click follows the finger lifting by up to ~300 ms. The
 * window is generous against that because of what the two errors cost: too
 * short double-charges the player, while too long only means a synthetic
 * activation dispatched within a second of a real tap on the same button is
 * ignored and has to be repeated.
 *
 * It is a window and not a flag so that it *expires*. A `pointerdown` taken
 * over by a scroll fires `pointercancel` and never produces a click at all, and
 * a flag set by that gesture would stand indefinitely, swallowing the next
 * synthetic activation — a screen reader's first press doing nothing is a
 * miserable thing to debug from behind a screen reader.
 */
export const POINTER_CLICK_WINDOW_MS = 1000;

/** `performance.now()` in the app; a controllable counter in a test. */
export interface ActivationClock {
  readonly now: () => number;
}

/**
 * The app's clock.
 *
 * `performance.now()` and not `Date.now()`: the window is a duration, and a
 * clock the user or NTP can step backwards would reopen a closed window or
 * hold one open. It is the same clock the game loop runs on.
 */
export const performanceClock: ActivationClock = { now: () => performance.now() };

/**
 * What one button remembers between events — except that it is not one
 * button's, it is every buy button's.
 *
 * Hoisted out of the component on purpose. A per-instance `useRef` is reset by
 * a remount, and a purchase remounts its own row: in `BarsSheet` buying
 * `Unlock` tears the locked row down and mounts `Upgrade` and `+ Lane` in its
 * place, with fresh refs, while the finger is still down and the compatibility
 * click is still in flight. The suppression has to outlive the element that
 * armed it, and the click it has to suppress may land on a *different* button
 * than the one that was pressed.
 */
export interface BuyActivationLog {
  /**
   * Clock reading of the most recent pointer event belonging to an activation
   * we served, or `-Infinity` when there is none outstanding.
   *
   * Refreshed on the way up, not cleared: with implicit touch capture
   * `pointerup` and `pointerleave` both land *before* the compatibility click,
   * so clearing there would leave `detail` alone against it — and stamping
   * there is what keeps a long press from double-buying when its click arrives
   * a second after the finger landed.
   */
  pointerServedAt: number;
  /**
   * Whether a `pointerdown` we served has not yet ended.
   *
   * The reason the stamp is not simply refreshed by every `pointerleave`: on a
   * desktop that event fires whenever the mouse crosses the button, pressed or
   * not, and a window reopened by a passing cursor would swallow a synthetic
   * activation for a second at a time.
   */
  pointerDown: boolean;
  /**
   * Set while the activation key currently held is repeating, so the `click`
   * the repeat synthesises can be told from a fresh press.
   */
  keyRepeating: boolean;
}

export function createBuyActivationLog(): BuyActivationLog {
  return { pointerServedAt: -Infinity, pointerDown: false, keyRepeating: false };
}

/** The one log every `BuyButton` shares. See `BuyActivationLog`. */
export const buyActivationLog = createBuyActivationLog();

/**
 * The only field of a `click` this decision reads.
 *
 * Typed structurally so a test can pass `{ detail: 0 }` and `Sheet.tsx` can
 * pass React's `MouseEvent`, which has it.
 */
export interface ActivationClick {
  readonly detail: number;
}

/** The two fields of a `keydown`/`keyup` this decision reads. */
export interface ActivationKey {
  readonly key: string;
  /** `true` on the auto-repeats of a held key; `keyup` is always a real one. */
  readonly repeat?: boolean | undefined;
}

/**
 * The two keys that activate a `<button>`, and so the only two whose `keydown`
 * says anything about the `click` that may follow.
 *
 * Narrow on purpose: `keydown` fires for Tab, Shift and the arrows too, and an
 * earlier version let any of them re-arm the click — a stray keypress inside
 * the compatibility window reopened the double buy for free.
 */
function isActivationKey(event: ActivationKey): boolean {
  return event.key === 'Enter' || event.key === ' ';
}

export interface BuyActivationInput {
  readonly log: BuyActivationLog;
  readonly clock: ActivationClock;
  /** Nothing left to buy, or buying is switched off: feedback yes, purchase no. */
  readonly inactive: boolean;
  readonly onBuy: () => void;
  /** Drives `.cta--pressed`. */
  readonly setPressed: (pressed: boolean) => void;
}

export interface BuyActivationHandlers {
  readonly pointerDown: () => void;
  /** `pointerup`, `pointercancel`, `pointerleave`. */
  readonly pointerEnd: () => void;
  readonly keyDown: (event: ActivationKey) => void;
  readonly keyUp: (event: ActivationKey) => void;
  readonly click: (event: ActivationClick) => void;
  /** `blur`: drop the press treatment, and nothing else. */
  readonly cancelPress: () => void;
}

export function buyActivation({
  log,
  clock,
  inactive,
  onBuy,
  setPressed,
}: BuyActivationInput): BuyActivationHandlers {
  return {
    pointerDown: () => {
      // Unconditionally, and before the purchase: the tap that buys nothing is
      // exactly the one DUB-38 found this button swallowing.
      setPressed(true);
      // Stamped even on an inactive button. The compatibility `click` comes
      // either way, and by then the button may be affordable — the purchase
      // this event could not make is not one the click should make for it.
      log.pointerServedAt = clock.now();
      log.pointerDown = true;
      if (!inactive) onBuy();
    },

    /*
     * The way up: the press treatment ends, and the window is *refreshed*
     * rather than cleared.
     *
     * Clearing here would be the obvious thing and is wrong. With implicit
     * touch capture the pointer ceases to exist on release, so `pointerup` and
     * the `pointerleave` fired for it both land before the compatibility click
     * — clearing would leave `detail` alone against exactly the input it is
     * least sure about. Refreshing is also what holds a long press to one
     * purchase: held for three seconds, its click is 3.3 s after the
     * `pointerdown` and outside any window measured from that.
     */
    pointerEnd: () => {
      if (log.pointerDown) {
        log.pointerServedAt = clock.now();
        log.pointerDown = false;
      }
      setPressed(false);
    },

    /*
     * A key going down buys nothing. Enter's activation is the click
     * synthesised from this event's default action and Space's is on the way
     * up, so transacting here would charge a held key once per repeat on top of
     * whatever the clicks do.
     *
     * What it does is tell the click handler which kind of click is coming:
     *
     *  - a *fresh* Enter or Space is never the tail of a tap, so it clears the
     *    pointer window — a player who taps a button and then presses it has
     *    made two activations and the second must land;
     *  - a *repeat* is the one case where `detail` and the window both say
     *    "fresh keypress" and both are wrong. Enter re-synthesises its click on
     *    every repeat, so a held Enter at ~30 Hz would buy 30 times a second
     *    and walk the player up every affordable tier. Native `<button>`s do
     *    behave that way; a button that spends money should not.
     */
    keyDown: (event) => {
      if (!isActivationKey(event)) return;
      log.keyRepeating = event.repeat === true;
      if (!log.keyRepeating) log.pointerServedAt = -Infinity;
      // The press treatment, for the same reason the pointer sets it rather
      // than leaving it to `:active`: this button must answer every press, and
      // on a dead-end one CSS is otherwise the only answer there is. `:active`
      // is reliably held for a held Space, but Enter's is a browser's own
      // business and may be nothing at all.
      setPressed(true);
    },

    /*
     * Space's activation point, and the end of a repeat run.
     *
     * Clearing the repeat flag here is what separates the two keys without
     * asking which one is held: Space's genuine single click follows a `keyup`,
     * and Enter's repeat clicks never do. So a held Space still buys exactly
     * once, on release, and a held Enter buys exactly once, on the first press.
     */
    keyUp: (event) => {
      if (!isActivationKey(event)) return;
      log.keyRepeating = false;
      setPressed(false);
    },

    click: (event) => {
      // The pointer path already transacted, on `pointerdown`.
      if (clock.now() - log.pointerServedAt < POINTER_CLICK_WINDOW_MS) return;
      if (event.detail !== 0) return;
      if (log.keyRepeating) return;

      if (!inactive) onBuy();
    },

    // Focus can be taken while a key is held — the purchase replaces the row
    // the button is in — and then no `keyup` reaches this button at all and the
    // press class would stick. Nothing about the pointer window changes here:
    // a blur is not the end of a pointer activation.
    cancelPress: () => {
      setPressed(false);
    },
  };
}
