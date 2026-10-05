/**
 * Which input events are allowed to act (DUB-51, generalised in DUB-59).
 *
 * Every control in this app acts on `pointerdown`, deliberately: on mobile
 * `click` arrives up to ~300 ms after the finger lands, and DUB-38 needs the
 * response to land in the same frame as the press. But keyboard activation of a
 * `<button>` produces a `click` and no `pointerdown` at all — so Enter and
 * Space tabbed onto one of these buttons got the press treatment and did
 * nothing.
 *
 * On a buy button that was a convincing press for a transaction that never
 * happened (DUB-51). Everywhere else it was worse, and DUB-59 is the sweep: the
 * three bottom-bar tabs are the only way into Bars, Door and Settings, so a
 * keyboard player could reach none of the game; the offline-return and
 * club-complete cards are not in the overlay stack `App` closes on `Escape`, so
 * their single CTA was the only way out and it did not work; and the four
 * controls inside Settings — three `role="switch"` toggles and the button that
 * deletes the save — were announced as operable and were not.
 *
 * So each control listens on both routes, and the question becomes which of the
 * events in front of it is a *fresh* activation rather than the tail of one it
 * already served. A pointer tap fires `pointerdown` and then, ~300 ms later, a
 * compatibility `click`; serving both would act twice — which on a buy button
 * charges the player twice.
 *
 * Three facts answer that, and a `click` has to clear all three:
 *
 *  - **`event.detail`** is the click count, so it is `0` on a click no pointer
 *    produced — the keyboard's, and an assistive technology's synthetic one.
 *    This is the usual test and the one the ticket names. It is also the only
 *    guard that survives the button being torn down under the finger (see
 *    `activationLog` below), which is why it stays even though the window
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
 * double activation does something the player asked for once — on a buy button,
 * money they did not agree to spend; in Settings, a save deleted by a key they
 * leaned on. So the guards that cannot be fooled by a touch engine's `detail`
 * value get the veto, and `detail` rules out the clicks they cannot see.
 *
 * **Every one of the three is a window, never a flag.** Twice in DUB-51 a guard
 * was written as a boolean cleared by an event that is not guaranteed to arrive
 * — the pointer gate a `pointercancel` orphaned (R4), then the key-repeat gate a
 * mid-hold `blur` orphaned (R5) — and both times the cost fell on the input that
 * has no other way in: a synthetic `click` with no pointer and no key behind it,
 * which is a screen reader's. A guard that spends the player's money when it is
 * absent must be able to expire when its clearing event never comes. Both are
 * stamps, and each has the event that normally clears it *plus* a backstop
 * duration.
 *
 * DUB-59 widens who that costs. As a buy-button module an orphaned guard
 * deafened the buy buttons; shared by all thirteen controls it would deafen the
 * bottom-bar tabs too, and a screen-reader player who cannot open a sheet has
 * no game rather than an unbuyable upgrade. The guards arrive here already
 * expiring, which is the reason this branch was asked to start from the
 * reviewed module rather than the copy it was cut from.
 *
 * Two of the controls would survive a double activation unharmed — opening the
 * sheet that is already open, closing the sheet that is already closed — and
 * the guards still apply to them. The cost of applying them is nothing, and the
 * cost of deciding case by case is a reader having to check which controls are
 * safe before touching one.
 *
 * **Accepted residual.** A synthetic `click` carrying `detail !== 0` with no
 * pointer events behind it — voice control and some switch-access software
 * dispatch a real `MouseEvent` rather than calling `element.click()` — is
 * rejected and the button does not work for it. That is the price of letting
 * `detail` veto, and it is the right side of the trade: the alternative is a
 * retargeted compat click buying an upgrade nobody pressed. It is a named case
 * in QA's plan, not an unknown.
 *
 * It all lives here rather than inline in the components because "exactly one
 * action per activation, by every route" is a claim about a *sequence* of
 * events, and `vitest` runs on the node environment with no DOM to dispatch
 * them into. As a pure function over a mutable log, a clock and the one or two
 * fields of the event that matter, the sequence is a unit test — see
 * `ctaPress.test.ts` for the sequence and `activation.test.ts` for the wiring
 * and the call sites.
 *
 * Thirteen controls route through `activationProps` below. Eight handlers each,
 * and the only variation between them is whether a press class exists for
 * `setPressed` to drive — which it does on `BuyButton` and nowhere else. That
 * is the whole reason this is a props object and not four lines copied
 * thirteen times: the set has to be identical everywhere, and `onKeyDown` is
 * the one whose absence is invisible until a double-tap acts twice.
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

/**
 * How long after the last auto-repeat of a held activation key a `click` is
 * still read as that repeat's, when no `keyup` and no `blur` ever arrive.
 *
 * This is only a backstop. The repeat stamp's real clear is the `keyup`, and it
 * has to stay: a held Space's one genuine click arrives immediately after the
 * last repeat, so any duration long enough to cover Enter's repeat clicks would
 * also swallow Space's real one. The stamp earns its keep in the case where
 * neither clearing event comes — focus taken mid-hold by a React unmount, which
 * fires no `blur` — and it needs to outlast only the gap between two repeats.
 * The slowest rate a platform offers is about 2 Hz (macOS) or 2.5 Hz (Windows),
 * so the gap to cover is ~500 ms and this is double it.
 */
export const KEY_REPEAT_WINDOW_MS = 1000;

/**
 * How old a `pointerdown` of ours may be and still have its release refresh the
 * window (N1).
 *
 * A pointer whose release never reaches a handler leaves its entry in
 * `downPointers` — an action can tear the capture target down mid-press, and on
 * a bottom-bar tab that is the normal case rather than the exception: the tap
 * mounts a whole sheet over the button that was pressed. A touch id never
 * recurs, so a stale touch entry is inert, but the mouse's `pointerId` is
 * stable: without a cap, a cursor merely crossing any control minutes later
 * would find the stale entry, pass the gate and open a window no press opened,
 * which is the one thing the gate exists to prevent.
 *
 * Long rather than tight, because the two errors are not equal: too long only
 * narrows N1, while too short refuses to refresh a genuine slow release and
 * puts its compatibility click back on `detail` alone. Thirty seconds is beyond
 * any press a player makes on purpose and well under the age of the stale
 * entries this is here for.
 */
export const POINTER_DOWN_MAX_AGE_MS = 30_000;

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
 * What one control remembers between events — except that it is not one
 * control's, it is every control's.
 *
 * Hoisted out of the component on purpose, and shared across all of them
 * rather than one log per control. A per-instance `useRef` is reset by a
 * remount, and an action remounts its own surroundings: in `BarsSheet` buying
 * `Unlock` tears the locked row down and mounts `Upgrade` and `+ Lane` in its
 * place, with fresh refs, while the finger is still down and the compatibility
 * click is still in flight; a bottom-bar tap mounts a whole sheet over the
 * button that was pressed. The suppression has to outlive the element that
 * armed it, and the click it has to suppress may land on a *different* element
 * than the one that was pressed — which is exactly why one shared log is the
 * right shape and a log per control is not.
 */
export interface ActivationLog {
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
   * The pointers currently down on one of these controls, each against the
   * clock reading of its `pointerdown`.
   *
   * It is a map and not a boolean because the log is shared by every control
   * and a phone has more than one finger (R6). `BarsSheet` puts `Upgrade` and
   * `+ Lane` side by side in one row, and two thumbs on two buttons is how
   * people play an incremental game. With one slot the first release consumed
   * it and the second release refreshed nothing, so the second finger's
   * compatibility click fell back to `detail` alone — the assumption about a
   * touch engine that this module is written not to bet money on.
   *
   * Its presence is also the gate on refreshing the window, which is why the
   * entry is needed at all rather than just a count: on a desktop
   * `pointerleave` fires whenever the mouse crosses the button, pressed or not,
   * and a window reopened by a passing cursor would swallow a synthetic
   * activation for a second at a time.
   */
  downPointers: Map<number, number>;
  /**
   * Clock reading of the most recent auto-repeat of a held activation key, or
   * `-Infinity` when no key is repeating — so the `click` a repeat synthesises
   * can be told from a fresh press.
   *
   * A stamp and not a boolean for the reason in the header: as a boolean its
   * only clear was an activation-key `keyup` on a control that still exists and
   * still has focus, and a hold interrupted by a blur or an unmount left it
   * standing for the rest of the session, vetoing every synthetic activation
   * (R5). See `KEY_REPEAT_WINDOW_MS`.
   */
  keyRepeatingAt: number;
}

export function createActivationLog(): ActivationLog {
  return { pointerServedAt: -Infinity, downPointers: new Map(), keyRepeatingAt: -Infinity };
}

/** The one log every control in the app shares. See `ActivationLog`. */
export const activationLog = createActivationLog();

/**
 * The only field of a `click` this decision reads.
 *
 * Typed structurally so a test can pass `{ detail: 0 }` and a component can
 * pass React's `MouseEvent`, which has it.
 */
export interface ActivationClick {
  readonly detail: number;
}

/**
 * The only field of a pointer event this decision reads.
 *
 * `React.PointerEvent` has it, so a component spreads these props straight onto
 * its `<button>` as before and a test passes `{ pointerId: 1 }`.
 */
export interface ActivationPointer {
  readonly pointerId: number;
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

export interface ActivationInput {
  readonly log: ActivationLog;
  readonly clock: ActivationClock;
  /**
   * The action is withheld: feedback yes, action no. On `BuyButton` that is
   * nothing left to buy, or buying switched off.
   *
   * Optional because it is the only control with such a state. A tab, a close
   * button, a banner dismiss and a settings toggle are always live, and saying
   * `inactive: false` at those call sites would be noise standing in for a
   * state they do not have.
   */
  readonly inactive?: boolean | undefined;
  readonly onAct: () => void;
  /**
   * Drives a press class the component sets itself.
   *
   * Optional, and only `BuyButton` passes it. `.cta.cta--pressed` exists
   * because DUB-38 found that a `:active`-only press can reach an iPhone as no
   * feedback at all: iOS Safari withholds `:active` on touch unless a touch
   * handler sits in the element's ancestor chain, and React's root-level
   * delegation is not one. The other twelve controls have no such class —
   * `.bar-button:active` is a plain background swap that its container cannot
   * cancel, and `.icon-button`/`.banner__action` have no `:active` rule at all
   * — so for them the press half is genuinely absent rather than a callback
   * doing nothing, and every `setPressed` below is optional-chained.
   *
   * That `.icon-button` and `.banner__action` therefore answer a tap with
   * nothing visible is DUB-38's class of defect rather than this one's. It is
   * flagged on the ticket, not fixed here: it needs a design decision about
   * what their press should look like, which is not a handler change.
   */
  readonly setPressed?: ((pressed: boolean) => void) | undefined;
}

export interface ActivationHandlers {
  readonly pointerDown: (event: ActivationPointer) => void;
  /** `pointerup`, `pointercancel`, `pointerleave`. */
  readonly pointerEnd: (event: ActivationPointer) => void;
  readonly keyDown: (event: ActivationKey) => void;
  readonly keyUp: (event: ActivationKey) => void;
  readonly click: (event: ActivationClick) => void;
  /** `blur`: end a key press that will get no `keyup` here. */
  readonly cancelPress: () => void;
}

export function activation({
  log,
  clock,
  inactive = false,
  onAct,
  setPressed,
}: ActivationInput): ActivationHandlers {
  return {
    pointerDown: (event) => {
      // Unconditionally, and before the action: the tap that buys nothing is
      // exactly the one DUB-38 found the buy button swallowing.
      setPressed?.(true);
      // Stamped even on an inactive control. The compatibility `click` comes
      // either way, and by then the button may be affordable — the purchase
      // this event could not make is not one the click should make for it.
      log.pointerServedAt = clock.now();
      log.downPointers.set(event.pointerId, clock.now());
      if (!inactive) onAct();
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
     *
     * Per pointer, so that a second finger's release refreshes the window its
     * own click will be measured against and not the first finger's (R6). A
     * pointer with no entry is one whose `pointerdown` this log never saw — a
     * cursor crossing the button — and it changes nothing, including the press
     * class, which may belong to a key currently held (N2).
     */
    pointerEnd: (event) => {
      const downAt = log.downPointers.get(event.pointerId);
      if (downAt === undefined) return;
      log.downPointers.delete(event.pointerId);
      // An entry older than any real press is one whose release never reached
      // a handler, left behind by an action tearing its own control down — a
      // tab mounting a sheet over itself. There is no click coming for it, and
      // refreshing on a stale one is how a passing cursor would open a window
      // no press opened (N1).
      if (clock.now() - downAt < POINTER_DOWN_MAX_AGE_MS) log.pointerServedAt = clock.now();
      setPressed?.(false);
    },

    /*
     * A key going down acts on nothing. Enter's activation is the click
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
      if (event.repeat === true) {
        log.keyRepeatingAt = clock.now();
      } else {
        log.keyRepeatingAt = -Infinity;
        log.pointerServedAt = -Infinity;
      }
      // The press treatment, for the same reason the pointer sets it rather
      // than leaving it to `:active`: the buy button must answer every press,
      // and on a dead-end one CSS is otherwise the only answer there is.
      // `:active` is reliably held for a held Space, but Enter's is a browser's
      // own business and may be nothing at all. A no-op on the twelve controls
      // that pass no `setPressed`.
      setPressed?.(true);
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
      log.keyRepeatingAt = -Infinity;
      setPressed?.(false);
    },

    click: (event) => {
      // The pointer path already transacted, on `pointerdown`.
      if (clock.now() - log.pointerServedAt < POINTER_CLICK_WINDOW_MS) return;
      if (event.detail !== 0) return;
      if (clock.now() - log.keyRepeatingAt < KEY_REPEAT_WINDOW_MS) return;

      if (!inactive) onAct();
    },

    /*
     * `blur`. Focus can be taken while a key is held — a click elsewhere, the
     * purchase replacing the row the button is in, a tab's action mounting a
     * sheet over it — and then no `keyup` reaches this element at all.
     *
     * So this ends the key press in both of its effects: the class, which would
     * otherwise stick, and the repeat stamp, which as a bare flag stood for the
     * rest of the session and vetoed every synthetic activation after it (R5).
     * It is the clear for the gesture you can make with one hand and a mouse:
     * hold Enter on a control, click away, release.
     *
     * Nothing about the pointer window changes here — a blur is not the end of
     * a pointer activation, and the compatibility click of a tap that moved
     * focus is still on its way. That matters more here than on a buy button:
     * a tab's own action moves focus into the sheet it just mounted.
     */
    cancelPress: () => {
      log.keyRepeatingAt = -Infinity;
      setPressed?.(false);
    },
  };
}

/**
 * The same decision as a set of props to spread onto a `<button>`.
 *
 * DUB-59 was thirteen controls that each had `onPointerDown` and nothing else,
 * and the point of the spread is that there is now no way to wire a fourteenth
 * and get one of the eight wrong. **All eight** are load-bearing beyond the
 * press class and none of them is optional:
 *
 *  - `onPointerDown` acts, and stamps the window;
 *  - the three release events *refresh* the window rather than clear it, which
 *    is what holds a long press to one action — leaving them off a control
 *    that has no press class would quietly reintroduce the double activation;
 *  - `onKeyDown`/`onKeyUp` are the keyboard's route and the key-repeat guard;
 *  - `onClick` is the activation itself on that route;
 *  - `onBlur` clears the repeat stamp. This is the one that changed under this
 *    branch: before R5 it only dropped the press class, so it was the single
 *    handler a press-less control could arguably have gone without. Now it is
 *    one of the two clears that keep an orphaned stamp from deafening every
 *    synthetic activation in the app — and with one log shared by thirteen
 *    controls, "in the app" is literal.
 *
 * A control without `setPressed` gets a handler whose press calls are
 * optional-chained away, which is cheaper to read than two wirings to compare.
 *
 * Structurally typed rather than in terms of React's handler types, so this
 * module stays testable on the node environment. A handler taking
 * `ActivationClick` is assignable to React's `MouseEventHandler` because
 * React's synthetic event has `detail`; the same goes for `ActivationPointer`
 * and `pointerId`, and `ActivationKey` and `key`/`repeat`.
 */
export interface ActivationProps {
  readonly onPointerDown: (event: ActivationPointer) => void;
  readonly onPointerUp: (event: ActivationPointer) => void;
  readonly onPointerCancel: (event: ActivationPointer) => void;
  readonly onPointerLeave: (event: ActivationPointer) => void;
  readonly onKeyDown: (event: ActivationKey) => void;
  readonly onKeyUp: (event: ActivationKey) => void;
  readonly onClick: (event: ActivationClick) => void;
  readonly onBlur: () => void;
}

/**
 * Everything a call site has to say, which is the action and — for the one
 * control that has a press class — how to set it.
 *
 * `log` and `clock` default to the app's, so a component never names them and
 * a test can inject both. There is no hook here and none needed: the log is
 * module-level, so this is a plain function and a call site is free to sit
 * wherever its control does, including after an early return.
 */
export type ActivationCall = Omit<ActivationInput, 'log' | 'clock'> &
  Partial<Pick<ActivationInput, 'log' | 'clock'>>;

export function activationProps({
  log = activationLog,
  clock = performanceClock,
  ...rest
}: ActivationCall): ActivationProps {
  const handlers = activation({ log, clock, ...rest });

  return {
    onPointerDown: handlers.pointerDown,
    onPointerUp: handlers.pointerEnd,
    // A finger is implicitly captured by the element that got `pointerdown`, so
    // touch always delivers its `up` here. `pointercancel` covers the gesture
    // being taken over (a scroll starting), and `pointerleave` the mouse, which
    // is *not* captured: dragged off the button before release it fires neither.
    onPointerCancel: handlers.pointerEnd,
    onPointerLeave: handlers.pointerEnd,
    onKeyDown: handlers.keyDown,
    onKeyUp: handlers.keyUp,
    onClick: handlers.click,
    onBlur: handlers.cancelPress,
  };
}
