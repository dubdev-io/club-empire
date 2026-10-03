const SUFFIXES = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi'] as const;

/**
 * Compact money formatting for an idle game: 1234 -> "1.23K".
 *
 * Idle numbers grow past what a reader can parse digit by digit, so the
 * counter shows three significant figures and a magnitude suffix.
 */
export function formatMoney(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const sign = value < 0 ? '-' : '';
  let n = Math.abs(value);

  let tier = 0;
  while (n >= 1000 && tier < SUFFIXES.length - 1) {
    n /= 1000;
    tier += 1;
  }

  const digits = tier === 0 ? 0 : n < 10 ? 2 : n < 100 ? 1 : 0;
  return `${sign}${n.toFixed(digits)}${SUFFIXES[tier]}`;
}

export function formatRate(value: number): string {
  return `${formatMoney(value)}/s`;
}

/** "2h 14m" / "47s" — for the offline-time readout. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${total % 60}s`;
}
