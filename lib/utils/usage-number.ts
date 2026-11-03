/**
 * Compact number for the usage dashboard: 999 → "999", 12_300 → "12.3K",
 * 4_560_000 → "4.56M".
 *
 * The unit is picked from the rounded value, so a number that rounds up to the
 * next unit is shown in that unit ("1.00M", not "1000.0K"; "1.0K", not "1000").
 */
export function formatUsageNumber(n: number): string {
  if (n >= 999_950) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 999.5) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}
