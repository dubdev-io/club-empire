export interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Read `env(safe-area-inset-*)` as numbers.
 *
 * CSS `env()` is not available to JavaScript directly, so the trick is to let
 * CSS write the four values into custom properties on `:root` (see
 * `src/styles/global.css`) and read them back off the computed style. The DOM
 * UI layer uses the CSS variables directly; the Pixi canvas needs the numbers
 * so it can keep the club floor out from under a notch or a home indicator.
 */
export function readSafeAreaInsets(): SafeAreaInsets {
  if (typeof window === 'undefined') return { top: 0, right: 0, bottom: 0, left: 0 };

  const style = getComputedStyle(document.documentElement);
  return {
    top: parsePx(style.getPropertyValue('--safe-top')),
    right: parsePx(style.getPropertyValue('--safe-right')),
    bottom: parsePx(style.getPropertyValue('--safe-bottom')),
    left: parsePx(style.getPropertyValue('--safe-left')),
  };
}

function parsePx(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
