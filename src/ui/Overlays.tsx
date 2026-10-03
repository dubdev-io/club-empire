import { OFFLINE_CAP_SECONDS, STATION_DEFS } from '../config/economy.ts';
import { useGameStore } from '../state/store.ts';
import { formatCash, formatCashExact, formatDuration, formatMinutes } from './format.ts';

/**
 * The offline-return card (§5).
 *
 * The copy is the specification, almost word for word, and the things it does
 * *not* say are as load-bearing as the things it does. No countdown. No "your
 * club is dying". No "watch to double". No loss framing anywhere — the player
 * was away, the club carried on, here is the money.
 *
 * Tapping outside collects, exactly as tapping the button does. §9: never trap
 * the player in a modal they have to aim at.
 */
export function OfflineCard(): React.JSX.Element | null {
  const show = useGameStore((s) => s.showOffline);
  const offline = useGameStore((s) => s.offline);
  const actions = useGameStore((s) => s.actions);

  if (!show) return null;

  return (
    <div className="overlay">
      <div className="overlay__scrim" onPointerDown={actions.collectOffline} aria-hidden="true" />

      <div className="card" role="dialog" aria-modal="true" aria-labelledby="offline-title">
        <h2 className="card__title" id="offline-title">
          The night carried on
        </h2>
        <hr className="card__rule" />

        <p className="card__line">You were away {formatDuration(offline.awaySeconds)}</p>
        <p className="card__line card__line--dim">
          Earned {offline.capped ? `(capped at ${formatMinutes(OFFLINE_CAP_SECONDS)})` : ''}
        </p>

        <p className="card__amount">{formatCashExact(offline.amount)}</p>

        {offline.capped && (
          <p className="card__note">
            Capped at {formatMinutes(OFFLINE_CAP_SECONDS)} — the club only runs itself so far
          </p>
        )}

        <button type="button" className="cta cta--magenta cta--solo" onPointerDown={actions.collectOffline}>
          COLLECT
        </button>
      </div>
    </div>
  );
}

/**
 * The ★ celebration at levels 10, 20 and 30 (~800 ms, auto-dismissing).
 *
 * Reduced motion replaces the shake and the confetti with a **static flash and
 * the number** — criterion 6 is explicit that the feedback is never simply
 * removed. Doubling a bar's drink price is the biggest single event in the run
 * and a player who has asked their OS for less motion still deserves to be
 * told it happened.
 *
 * Auto-dismiss is a timer the player cannot miss anything by being slow for:
 * nothing is claimed here and nothing expires.
 */
export function StarBurst(): React.JSX.Element | null {
  const star = useGameStore((s) => s.star);
  const reducedMotion = useGameStore((s) => s.reducedMotion);
  const setStar = useGameStore((s) => s.setStar);

  if (star === null) return null;

  const name = STATION_DEFS.find((s) => s.key === star.station)?.name ?? 'Bar';

  return (
    <div
      className={`star-burst${reducedMotion ? ' star-burst--still' : ''}`}
      role="status"
      // Tapping it dismisses early. The overlay is pointer-transparent to the
      // canvas underneath everywhere else, so a tap meant for a bubble during
      // the celebration still reaches the bubble.
      onPointerDown={() => setStar(null)}
    >
      <div className="star-burst__panel">
        <div className="star-burst__stars" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span key={i} className={i < star.stars ? 'star-burst__on' : 'star-burst__off'}>
              ★
            </span>
          ))}
        </div>
        <p className="star-burst__headline">×2 drink price</p>
        <p className="star-burst__sub">
          {name} · Lv {star.level}
        </p>
      </div>
      {!reducedMotion && (
        <div className="confetti" aria-hidden="true">
          {CONFETTI.map((piece, i) => (
            <span
              key={i}
              className="confetti__piece"
              style={{
                left: `${piece.left}%`,
                animationDelay: `${piece.delay}ms`,
                background: `var(${piece.token})`,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Fixed confetti, not random.
 *
 * Twelve pieces, under the §11 particle cap of 60 with room to spare, and
 * deterministic so the celebration looks the same every time — a burst that
 * reshuffles reads as a glitch rather than a flourish. Colours come from the
 * tokens; nothing here is an inline hex.
 */
const CONFETTI = [
  { left: 12, delay: 0, token: '--neon-magenta' },
  { left: 24, delay: 60, token: '--gold-vip' },
  { left: 33, delay: 20, token: '--neon-cyan' },
  { left: 41, delay: 110, token: '--neon-violet' },
  { left: 49, delay: 40, token: '--cash-green' },
  { left: 56, delay: 90, token: '--neon-magenta' },
  { left: 63, delay: 10, token: '--gold-vip' },
  { left: 71, delay: 130, token: '--neon-cyan' },
  { left: 79, delay: 50, token: '--neon-violet' },
  { left: 86, delay: 100, token: '--cash-green' },
  { left: 92, delay: 30, token: '--neon-magenta' },
  { left: 6, delay: 80, token: '--gold-vip' },
] as const;

/**
 * The club-complete screen.
 *
 * Phase 1 scope item 13: it ends in "Phase 2: a second venue" and is **never a
 * dead end** — the club keeps earning, the player is never locked out, and
 * [KEEP PLAYING] puts them straight back on the floor. There is no score to
 * beat and nothing to share, because there is nobody to share it with.
 */
export function ClubComplete(): React.JSX.Element | null {
  const show = useGameStore((s) => s.showComplete);
  const actions = useGameStore((s) => s.actions);
  const totalEarned = useGameStore((s) => s.totalEarned);
  const purchaseCount = useGameStore((s) => s.purchaseCount);
  const bubblesCollected = useGameStore((s) => s.bubblesCollected);
  const lastCallFiredCount = useGameStore((s) => s.lastCallFiredCount);
  const baseIncome = useGameStore((s) => s.baseIncomePerSecond);
  const elapsedSeconds = useGameStore((s) => s.elapsedSeconds);

  if (!show) return null;

  return (
    <div className="overlay">
      <div className="overlay__scrim" onPointerDown={actions.acknowledgeComplete} aria-hidden="true" />

      <div className="card card--tall" role="dialog" aria-modal="true" aria-labelledby="complete-title">
        <div className="star-burst__stars" aria-hidden="true">
          <span className="star-burst__on">★</span>
          <span className="star-burst__on">★</span>
          <span className="star-burst__on">★</span>
        </div>

        <h2 className="card__title" id="complete-title">
          Club complete
        </h2>
        <hr className="card__rule" />

        <dl className="stats">
          <Stat label="Time to build" value={formatDuration(elapsedSeconds)} />
          <Stat label="Earning" value={`${formatCash(baseIncome)}/s`} />
          <Stat label="Total earned" value={formatCash(totalEarned)} />
          <Stat label="Upgrades bought" value={String(purchaseCount)} />
          {/* "Cash bubbles" everywhere, including here — the brief has one word
              for the most-tapped object in the game and this said "tips". */}
          <Stat label="Cash bubbles tapped" value={String(bubblesCollected)} />
          <Stat label="Last Calls" value={String(lastCallFiredCount)} />
        </dl>

        <p className="card__note card__note--next">
          Every bar at Lv 30, three lanes each, the door at Lv 8. Next:{' '}
          <strong>Phase 2 — a second venue.</strong>
        </p>

        <button
          type="button"
          className="cta cta--magenta cta--solo"
          onPointerDown={actions.acknowledgeComplete}
        >
          KEEP PLAYING
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return (
    <div className="stats__row">
      <dt className="stats__label">{label}</dt>
      <dd className="stats__value">{value}</dd>
    </div>
  );
}

/**
 * The inline banners: a save we could not read, and storage we cannot write.
 *
 * Both are states the player has to be *told* about rather than left to infer.
 * A save that fails to load and silently starts a fresh club is the single
 * worst bug this game could ship, because the player's only evidence is that
 * their club is gone.
 */
export function Banners(): React.JSX.Element | null {
  const saveStatus = useGameStore((s) => s.saveStatus);
  const storageUnavailable = useGameStore((s) => s.storageUnavailable);
  const dismissed = useGameStore((s) => s.dismissedBanners);
  const dismissBanner = useGameStore((s) => s.dismissBanner);

  const showCorrupt = saveStatus === 'corrupt' && !dismissed.corrupt;
  const showStorage = storageUnavailable && !dismissed.storage;

  if (!showCorrupt && !showStorage) return null;

  return (
    <div className="banners" role="status">
      {showCorrupt && (
        <div className="banner banner--warn">
          <span aria-hidden="true">⚠</span>
          <span className="banner__text">We couldn&rsquo;t read your saved club. Starting fresh.</span>
          <button
            type="button"
            className="banner__action"
            onPointerDown={() => dismissBanner('corrupt')}
          >
            Start fresh
          </button>
        </div>
      )}

      {showStorage && (
        <div className="banner">
          <span aria-hidden="true">ⓘ</span>
          <span className="banner__text">Progress won&rsquo;t be saved in this browser mode.</span>
          <button
            type="button"
            className="banner__action"
            onPointerDown={() => dismissBanner('storage')}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Boot / loading.
 *
 * A club silhouette and a spinner, target under 1.5 s on mid-range Android.
 * The progress bar only appears after a second, because a bar that flashes up
 * and vanishes makes a fast load *feel* slow.
 */
export function BootScreen(): React.JSX.Element {
  const progress = useGameStore((s) => s.bootProgress);

  return (
    <div className="boot" role="status" aria-label="Loading Club Empire">
      <div className="boot__silhouette" aria-hidden="true">
        <span className="boot__bar" />
        <span className="boot__bar" />
        <span className="boot__bar" />
      </div>
      <p className="boot__title">CLUB EMPIRE</p>
      <div className="boot__spinner" aria-hidden="true" />
      {progress > 0 && (
        <div className="boot__progress" aria-hidden="true">
          <div className="boot__progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

/**
 * WebGL unavailable.
 *
 * A text screen naming the problem, not a silent black canvas. The player can
 * do something about it, so tell them what.
 */
export function WebglUnavailable(): React.JSX.Element {
  return (
    <div className="fatal" role="alert">
      <h1 className="fatal__title">This browser can&rsquo;t run the club</h1>
      <p className="fatal__body">
        Club Empire draws the dance floor with WebGL, and this browser has it disabled or
        unavailable.
      </p>
      <p className="fatal__body fatal__body--dim">
        Chrome or Safari on a recent phone will run it. If you are in a private window with
        hardware acceleration off, turning it back on is usually enough.
      </p>
    </div>
  );
}

/**
 * Landscape.
 *
 * §9: portrait only, and in landscape show a rotate prompt — do not attempt a
 * landscape layout. Attempting one is how you end up maintaining two.
 */
export function RotatePrompt(): React.JSX.Element {
  return (
    <div className="fatal fatal--rotate" role="alert">
      <div className="fatal__rotate-glyph" aria-hidden="true" />
      <h1 className="fatal__title">Turn your phone upright</h1>
      <p className="fatal__body">Club Empire is built for portrait.</p>
    </div>
  );
}
