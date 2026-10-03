import { useGameStore } from '../state/store.ts';
import { formatMoney } from './format.ts';

/**
 * The single placeholder player action.
 *
 * `onPointerDown`, not `onClick`: on mobile, `click` fires up to ~300 ms after
 * the finger lands, and that delay is the whole difference between a button
 * that feels connected and one that feels dead.
 */
export function UpgradeButton(): React.JSX.Element {
  const money = useGameStore((s) => s.money);
  const upgradeCost = useGameStore((s) => s.upgradeCost);
  const requestUpgrade = useGameStore((s) => s.requestUpgrade);

  const affordable = money >= upgradeCost;

  return (
    <div className="action-bar">
      <button
        type="button"
        className="action-button"
        disabled={!affordable}
        onPointerDown={requestUpgrade}
      >
        <span>Upgrade bar</span>
        <span className="action-button__cost">{formatMoney(upgradeCost)}</span>
      </button>
    </div>
  );
}
