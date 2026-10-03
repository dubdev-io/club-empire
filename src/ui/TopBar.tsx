import { useGameStore } from '../state/store.ts';
import { formatMoney, formatRate } from './format.ts';

/**
 * The money counter. Subscribes to three primitive fields rather than the
 * whole store, so React only re-renders this component when one of those
 * numbers actually changes — not when, say, the save status does.
 */
export function TopBar(): React.JSX.Element {
  const money = useGameStore((s) => s.money);
  const incomePerSecond = useGameStore((s) => s.incomePerSecond);
  const barLevel = useGameStore((s) => s.barLevel);

  return (
    <div className="top-bar">
      <div>
        <div className="top-bar__money">{formatMoney(money)}</div>
        <div className="top-bar__rate">{formatRate(incomePerSecond)}</div>
      </div>
      <div className="top-bar__level">
        Bar
        <br />
        Lv {barLevel}
      </div>
    </div>
  );
}
