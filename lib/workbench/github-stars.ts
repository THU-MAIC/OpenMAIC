import { OPENMAIC_GITHUB_URL } from '@/lib/workbench/shell-links';

/** `owner/repo` of the project's repository, derived from its public URL. */
export const OPENMAIC_GITHUB_REPO = new URL(OPENMAIC_GITHUB_URL).pathname.replace(/^\/|\/$/g, '');

/** The route the home badge reads the star count from. */
export const GITHUB_STARS_ENDPOINT = '/api/github-stars';

const compactFormatter = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** A star count as a badge shows it: 999 → "999", 1234 → "1.2k", 12400 → "12.4k". */
export function formatStarCount(stars: number): string {
  return compactFormatter.format(stars).toLowerCase();
}
