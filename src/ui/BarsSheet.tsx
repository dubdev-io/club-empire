import { MAX_LANES, MAX_STATION_LEVEL } from '../config/economy.ts';
import { useGameStore, type StationView } from '../state/store.ts';
import { stationDiagnosis } from './diagnosis.ts';
import { formatCash, formatGuestRate } from './format.ts';
import { BuyButton, Sheet } from './Sheet.tsx';

/**
 * The BARS sheet: one row per station, with the two purchases that station has.
 *
 * This is the panel half of the design's central split — **level is bought in a
 * panel and is exponential, capacity is bought and visible on the floor and is
 * linear-ish**. So each row shows both axes next to each other, with what the
 * station is *actually doing* underneath: served vs capacity, and whether it
 * has a queue or an idle bartender. That line is the reason the player can
 * diagnose the economy without a tutorial, and it is the same `ClubFlow` the
 * floor renders, not a second estimate.
 */
export function BarsSheet(): React.JSX.Element {
  const closeSheet = useGameStore((s) => s.closeSheet);
  const stations = useGameStore((s) => s.stations);

  return (
    <Sheet
      title="Bars"
      subtitle="Level raises what each guest pays. Lanes raise how many you can serve."
      onClose={closeSheet}
    >
      {stations.map((station) => (
        <StationRow key={station.key} station={station} />
      ))}
    </Sheet>
  );
}

function StationRow({ station }: { readonly station: StationView }): React.JSX.Element {
  const cash = useGameStore((s) => s.cash);
  const actions = useGameStore((s) => s.actions);
  // One primitive per value, which is what the fast/structure split exists
  // for. Selecting a snapshot object here would hand every row a fresh
  // reference ten times a second; selecting the numbers means a row re-renders
  // only when a number it reads actually changes.
  const turnedAway = useGameStore((s) => s.turnedAwayPerSecond);
  const arrivals = useGameStore((s) => s.arrivalsPerSecond);
  const doorMaxed = useGameStore((s) => s.doorMaxed);

  if (!station.unlocked) {
    const cost = station.unlockCost ?? 0;
    return (
      <section className="station-row station-row--locked">
        <header className="station-row__head">
          <h3 className="station-row__name">
            <span aria-hidden="true">🔒</span> {station.name}
          </h3>
          <span className="station-row__meta">Locked</span>
        </header>
        <p className="station-row__flow">
          {formatCash(station.pricePerGuest)} a guest once it opens — the highest in the club so far.
        </p>
        <BuyButton
          label="Unlock"
          price={formatCash(cost)}
          affordable={cash >= cost}
          accent="cyan"
          onBuy={() => actions.unlockStation(station.key)}
        />
      </section>
    );
  }

  const diagnosis = stationDiagnosis(station, turnedAway, arrivals, doorMaxed);

  return (
    <section className="station-row">
      <header className="station-row__head">
        <h3 className="station-row__name">{station.name}</h3>
        {/* The header states the level and the stars state how far through the
            station is. It used to say MAXED here *and* on the upgrade row;
            design review asked for one of them, so the terminal state is said
            where the action used to be. */}
        <span className="station-row__meta">
          <Stars count={station.stars} />
          <span className="station-row__level">Lv {station.level}</span>
        </span>
      </header>

      {/* Progress toward the next ★, which is where the x2 price jump is. The
          one piece of forward-looking information in the sheet, and it is a
          count of levels rather than a time estimate.

          The label sits *above* the track, not inside it. Design review caught
          the fill terminating mid-string — "(x2 | price)" — which the eye parses
          as a rendering bug before it parses it as a meter. Nothing crosses a
          glyph now, so the fill can also be read at full strength. */}
      {station.levelsToNextStar !== null && (
        <div className="star-progress">
          <span className="star-progress__label">
            {station.levelsToNextStar} to ★ (×2 price)
          </span>
          <div className="star-progress__track">
            <div
              className="star-progress__fill"
              style={{ width: `${starProgressPercent(station)}%` }}
            />
          </div>
        </div>
      )}

      <p className="station-row__flow">
        Serving <strong>{formatGuestRate(station.servedPerSecond)}</strong> of{' '}
        {formatGuestRate(station.capacityPerSecond)} · {formatCash(station.pricePerGuest)} a guest
      </p>

      {/* Two axes, neither of them this station's saturation on its own: a lane
          that can be bought decides whether advice is given, and the club's
          door queue decides whether it shouts — see `stationDiagnosis`. The
          `<strong>` and the sentence share one span for
          the same reason the Door sheet does it: the paragraph is a flex row,
          so a bare `<strong>` becomes its own column and "Full house" breaks
          across two lines with the sentence beside it. */}
      {diagnosis !== null && (
        <p
          className={`station-row__diagnosis${
            diagnosis.warn ? ' station-row__diagnosis--warn' : ''
          }`}
        >
          <span aria-hidden="true">{diagnosis.glyph}</span>
          <span>
            {diagnosis.lead !== null && (
              <>
                <strong>{diagnosis.lead}</strong> —{' '}
              </>
            )}
            {diagnosis.body}
          </span>
        </p>
      )}

      <div className="station-row__buys">
        {/* Neither button may read as an action once its axis is finished:
            "Upgrade to Lv 30" at Lv 30, or "+ Lane 3" at three lanes, is
            literally wrong. So the label states where the axis is and the price
            slot says how far through it is — the same `Lv 8 of 8` shape the
            Door sheet uses.

            The badge deliberately carries no stars. The header two rows up
            already shows ★★★ and the level, and design review asked for one of
            them rather than the same two facts twice within 140 px. */}
        <BuyButton
          label={
            station.maxed
              ? `Lv ${MAX_STATION_LEVEL} — maxed`
              : `Upgrade to Lv ${station.level + 1}`
          }
          price={formatCash(station.upgradeCost ?? 0)}
          affordable={station.upgradeCost !== null && cash >= station.upgradeCost}
          doneLabel={station.maxed ? `Lv ${MAX_STATION_LEVEL} of ${MAX_STATION_LEVEL}` : undefined}
          onBuy={() => actions.upgradeStation(station.key)}
        />
        <BuyButton
          label={
            station.laneCost === null
              ? `${MAX_LANES} lanes — maxed`
              : `+ Lane ${Math.min(station.lanes + 1, MAX_LANES)}`
          }
          price={formatCash(station.laneCost ?? 0)}
          affordable={station.laneCost !== null && cash >= station.laneCost}
          doneLabel={station.laneCost === null ? `${MAX_LANES} of ${MAX_LANES}` : undefined}
          accent="cyan"
          onBuy={() => actions.buyLane(station.key)}
        />
      </div>
    </section>
  );
}

/** How far through the current ★ band this station is. */
function starProgressPercent(station: StationView): number {
  if (station.levelsToNextStar === null) return 100;
  // Bands are ten levels wide (★ at 10, 20, 30), so the fill is the position
  // within the current band of ten.
  const into = 10 - station.levelsToNextStar;
  return Math.max(0, Math.min(100, (into / 10) * 100));
}

function Stars({ count }: { readonly count: number }): React.JSX.Element {
  return (
    <span className="stars" aria-label={`${count} of 3 stars`}>
      {/* Earned and unearned differ in glyph, not only in colour (§9). The
          dimmed ★ was legible next to "N to ★" and the level, but a hollow ☆
          carries the state in shape for free. */}
      {[0, 1, 2].map((i) => (
        <span key={i} className={i < count ? 'stars__on' : 'stars__off'} aria-hidden="true">
          {i < count ? '★' : '☆'}
        </span>
      ))}
    </span>
  );
}
