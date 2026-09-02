/**
 * Durable per-session URL trust gate — host-side adapter.
 *
 * Only origins the user exposed (in the session prompt or a follow-up message)
 * or that web_search surfaced may later be fetched by the fetch_url tool (a
 * later slice). The trust anchor lives in the package store: `registerSessionUrls`
 * records WHATWG-normalized absolute http(s) URLs idempotently, and
 * `isSessionUrlAllowed` answers by WHATWG origin (scheme + host + port, default
 * ports dropped) so a prefix like `https://arxiv.org` never matches
 * `https://arxiv.org.evil.com`. Links scraped from fetched pages are never
 * registered, so a page cannot widen the allowlist by itself.
 *
 * `isSessionUrlAllowed` is currently producer-only: no consumer exists yet.
 * Both producers are wired — user-authored prompt/message text through the
 * store hooks in `store.ts`, and web_search results through the runner — and
 * the check itself is pinned by the package's contract suite.
 */
import {
  extractObservedUrls,
  normalizeObservedUrl,
  type AgentSessionTransaction,
  type AgentSessionUrlSource,
} from '@openmaic/storage';

import { getAgentSessionStore } from './store';

export { extractObservedUrls, normalizeObservedUrl };

/**
 * Register observed URLs for a session, returning the normalized set that was
 * considered (malformed and non-http(s) values are dropped). Pass a transaction
 * to commit the observations atomically with the business write that produced
 * them; a registration failure then aborts that write.
 */
export async function registerSessionUrls(
  sessionId: string,
  urls: string[],
  source: AgentSessionUrlSource = 'user',
  transaction?: AgentSessionTransaction,
): Promise<string[]> {
  const store = await getAgentSessionStore();
  return transaction === undefined
    ? store.registerSessionUrls(sessionId, urls, source)
    : store.registerSessionUrls(sessionId, urls, source, transaction);
}

/** Whether a future fetch of `url` is within a session-observed origin. */
export async function isSessionUrlAllowed(sessionId: string, url: string): Promise<boolean> {
  const store = await getAgentSessionStore();
  return store.isSessionUrlAllowed(sessionId, url);
}
