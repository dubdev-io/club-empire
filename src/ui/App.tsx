import { StatusLine } from './StatusLine.tsx';
import { TopBar } from './TopBar.tsx';
import { UpgradeButton } from './UpgradeButton.tsx';
import './ui.css';

/**
 * The whole UI layer. Every panel, counter and button in this game is DOM —
 * React owns them. Pixi owns the club floor and nothing else.
 */
export function App(): React.JSX.Element {
  return (
    <>
      <TopBar />
      <StatusLine />
      <div className="spacer" />
      <UpgradeButton />
    </>
  );
}
