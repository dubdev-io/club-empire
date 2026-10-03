/**
 * Number and time formatting (§9).
 *
 * The rule from the brief is "`1.2k`, `34k`, `1.75M`, `2.4B` — 3 significant
 * figures, tabular figures, reserve width so a number never reflows the
 * layout". Reading those four examples back: three significant figures with
 * trailing zeros trimmed, a lowercase `k` and uppercase everything above it.
 *
 *   1_200      -> 1.2k    (1.20k, trimmed)
 *   34_000     -> 34k     (34.0k, trimmed)
 *   1_750_000  -> 1.75M
 *   2_400_000_000 -> 2.4B (2.40B, trimmed)
 *
 * Width reservation is CSS's job (`ch` units plus `tabular-nums`), but it only
 * works if the formatter has a bounded output length, which this does: at most
 * four characters plus a suffix.
 */

const SUFFIXES = ['', 'k', 'M', 'B', 'T', 'Qa', 'Qi'] as const;

/** The longest string `formatMoney` can return, for reserving width in CSS. */
export const MONEY_MAX_CHARS = 6;

export function formatMoney(value: number): string {
  if (!Number.isFinite(value)) return '0';

  const sign = value < 0 ? '-' : '';
  let n = Math.abs(value);

  let tier = 0;
  while (n >= 1000 && tier < SUFFIXES.length - 1) {
    n /= 1000;
    tier += 1;
  }

  // Under a thousand, keep three significant figures too.
  //
  // Flooring here was wrong in the place it mattered most: the opening minute
  // runs at 1.26/s and the income readout showed "£1/s" through several
  // upgrades, so the single number that is supposed to prove an upgrade did
  // something sat still. Above 10 the integer is the right read — nobody needs
  // "237.41".
  if (tier === 0) {
    return `${sign}${n < 10 ? trimZeros(n.toFixed(2)) : String(Math.floor(n))}`;
  }

  // Three significant figures: one before the point for 1-9, two for 10-99,
  // three for 100-999.
  const decimals = n < 10 ? 2 : n < 100 ? 1 : 0;
  let fixed = n.toFixed(decimals);

  // `toFixed` can round up across a magnitude: 999.9995 at the thousands tier
  // becomes "1000", and the counter reads "1000M" where it should read "1B".
  // Caught on a screenshot, which is the expensive way to find it.
  if (Number.parseFloat(fixed) >= 1000 && tier < SUFFIXES.length - 1) {
    n /= 1000;
    tier += 1;
    fixed = n.toFixed(n < 10 ? 2 : n < 100 ? 1 : 0);
  }

  return `${sign}${trimZeros(fixed)}${SUFFIXES[tier]}`;
}

/** `1.20` -> `1.2`, `34.0` -> `34`, `237` -> `237`. */
function trimZeros(text: string): string {
  if (!text.includes('.')) return text;
  return text.replace(/\.?0+$/, '');
}

/** The club's currency. One place, so it is one edit if it ever changes. */
export const CURRENCY = '£';

export function formatCash(value: number): string {
  return `${CURRENCY}${formatMoney(value)}`;
}

/** `formatMoney` with a `/s`. Used for the income readout. */
export function formatRate(value: number): string {
  return `${formatCash(value)}/s`;
}

/**
 * Exact, comma-grouped, for the one place a precise figure reads better than a
 * compact one: the offline-earnings card, which the brief draws as `£ 4,820`.
 *
 * Falls back to the compact form above 100,000, where an exact number starts
 * to overflow the card's 40 px type and stops being readable at a glance
 * anyway.
 */
export function formatCashExact(value: number): string {
  if (!Number.isFinite(value) || value < 0) return `${CURRENCY}0`;
  if (value >= 100_000) return formatCash(value);
  return `${CURRENCY}${Math.floor(value).toLocaleString('en-GB')}`;
}

/**
 * `2h 14m` / `3m 20s` / `47s` — for the offline card's "You were away" line.
 *
 * Two units at most. "2h 14m 9s" is three facts where the player wanted one.
 */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${total % 60}s`;
}

/** `10 min` — for the offline cap copy, which the brief quotes verbatim. */
export function formatMinutes(seconds: number): string {
  return `${Math.round(seconds / 60)} min`;
}

/** `0.42/s` — guest arrival and capacity rates in the DOOR sheet. */
export function formatGuestRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0/s';
  return `${value < 10 ? value.toFixed(2) : value.toFixed(1)}/s`;
}
