import { OPENMAIC_GITHUB_REPO } from '@/lib/workbench/github-stars';

/** A successful answer is good for an hour; GitHub's unauthenticated limit is 60 requests an hour. */
export const GITHUB_STARS_TTL_MS = 60 * 60 * 1000;
/** A failure is remembered briefly, so an outage does not turn every page view into a request. */
export const GITHUB_STARS_FAILURE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

interface CacheEntry {
  readonly stars: number | null;
  readonly expiresAt: number;
}

let cached: CacheEntry | undefined;
let inFlight: Promise<number | null> | undefined;

async function fetchStars(): Promise<number | null> {
  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'OpenMAIC',
    };
    const token = process.env.GITHUB_TOKEN?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(`https://api.github.com/repos/${OPENMAIC_GITHUB_REPO}`, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { stargazers_count?: unknown };
    const stars = body.stargazers_count;
    return typeof stars === 'number' && Number.isFinite(stars) && stars >= 0 ? stars : null;
  } catch {
    return null;
  }
}

/**
 * The repository's star count, or `null` when GitHub cannot be reached. Cached
 * in process memory; concurrent callers share one request. Never throws.
 */
export async function getGitHubStars(): Promise<number | null> {
  if (cached && Date.now() < cached.expiresAt) return cached.stars;
  if (!inFlight) {
    inFlight = fetchStars()
      .then((stars) => {
        const ttl = stars === null ? GITHUB_STARS_FAILURE_TTL_MS : GITHUB_STARS_TTL_MS;
        cached = { stars, expiresAt: Date.now() + ttl };
        return stars;
      })
      .finally(() => {
        inFlight = undefined;
      });
  }
  return inFlight;
}
