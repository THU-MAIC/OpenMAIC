import { describe, expect, test } from 'vitest';

import type { AgentSessionStore, AgentSessionUrlStore } from '../src/agent-session/types.js';

export type AgentSessionUrlContractStore = AgentSessionStore & AgentSessionUrlStore;

/**
 * Backend-neutral semantics for the durable per-session URL trust gate.
 *
 * The anchor mirrors the reference: only user messages and web_search results
 * introduce origins through `registerSessionUrls`, and `isSessionUrlAllowed`
 * answers by WHATWG origin so default ports normalize and a string prefix like
 * `https://arxiv.org` never matches `https://arxiv.org.evil.com`. These checks
 * run against every PostgreSQL-backed store variant (embedded PGlite in the
 * default suite, real PostgreSQL in the PG suite).
 */
export function runAgentSessionUrlContract(
  name: string,
  makeStore: () => AgentSessionUrlContractStore,
): void {
  describe(`AgentSessionUrlStore contract: ${name}`, () => {
    test('registers normalized http(s) URLs idempotently and returns them', async () => {
      const store = makeStore();
      await store.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });

      const registered = await store.registerSessionUrls(
        'session-1',
        ['https://EXAMPLE.com/a?q=1', 'https://example.com/a?q=1', 'not a url', 'ftp://x'],
        'user',
      );
      // WHATWG normalization (lowercased host) plus dropping of malformed and
      // non-http(s) values, deduplicated.
      expect(registered).toEqual(['https://example.com/a?q=1']);

      // Re-registering the same URL from a different source is a no-op but
      // still returns the normalized candidate set (reference return shape).
      const again = await store.registerSessionUrls(
        'session-1',
        ['https://example.com/a?q=1'],
        'web_search',
      );
      expect(again).toEqual(['https://example.com/a?q=1']);
      expect(await store.isSessionUrlAllowed('session-1', 'https://example.com/a?q=1')).toBe(true);
    });

    test('normalizes scheme, host, path, and default ports for the allowlist', async () => {
      const store = makeStore();
      await store.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });
      const OBSERVED = 'https://arxiv.org/abs/2409.03512';
      await store.registerSessionUrls('session-1', [OBSERVED], 'user');

      // A different path on the same origin (abs page -> direct pdf link).
      await expect(
        store.isSessionUrlAllowed('session-1', 'https://arxiv.org/pdf/2409.03512'),
      ).resolves.toBe(true);
      // The exact observed URL is still allowed.
      await expect(store.isSessionUrlAllowed('session-1', OBSERVED)).resolves.toBe(true);
      // An explicit default port is the same origin.
      await expect(
        store.isSessionUrlAllowed('session-1', 'https://arxiv.org:443/pdf/2409.03512'),
      ).resolves.toBe(true);
    });

    test('rejects origin variants, suffix domains, and userinfo tricks', async () => {
      const store = makeStore();
      await store.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });
      await store.registerSessionUrls('session-1', ['https://arxiv.org/abs/2409.03512'], 'user');

      // Same host under a different scheme.
      await expect(
        store.isSessionUrlAllowed('session-1', 'http://arxiv.org/abs/2409.03512'),
      ).resolves.toBe(false);
      // Same host on a different port.
      await expect(
        store.isSessionUrlAllowed('session-1', 'https://arxiv.org:8443/abs/2409.03512'),
      ).resolves.toBe(false);
      // A suffix domain that only shares a string prefix.
      await expect(
        store.isSessionUrlAllowed('session-1', 'https://arxiv.org.evil.com/pdf/2409.03512'),
      ).resolves.toBe(false);
      await expect(
        store.isSessionUrlAllowed('session-1', 'https://arxiv.org.evil.com:443/pdf/2409.03512'),
      ).resolves.toBe(false);
      // A userinfo trick that names the whitelisted host.
      await expect(
        store.isSessionUrlAllowed('session-1', 'https://arxiv.org@evil.com/pdf/2409.03512'),
      ).resolves.toBe(false);
      // A completely unrelated domain.
      await expect(
        store.isSessionUrlAllowed('session-1', 'https://example.com/other'),
      ).resolves.toBe(false);
    });

    test('fails closed on malformed, non-http(s), and empty allowlists', async () => {
      const store = makeStore();
      await store.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });
      await store.createSession({ id: 'session-2', ownerId: 'owner-a', prompt: 'p' });
      await store.registerSessionUrls('session-1', ['https://example.com/a'], 'user');

      // Malformed and non-http(s) candidates never consult the allowlist.
      await expect(store.isSessionUrlAllowed('session-1', 'not a url')).resolves.toBe(false);
      await expect(store.isSessionUrlAllowed('session-1', 'ftp://example.com/a')).resolves.toBe(
        false,
      );
      // A session with no observations fails closed.
      await expect(store.isSessionUrlAllowed('session-2', 'https://example.com/a')).resolves.toBe(
        false,
      );
    });

    test('scopes observations per session', async () => {
      const store = makeStore();
      await store.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });
      await store.createSession({ id: 'session-2', ownerId: 'owner-a', prompt: 'p' });
      await store.registerSessionUrls('session-1', ['https://example.com/a'], 'user');
      await store.registerSessionUrls('session-2', ['https://other.example/x'], 'user');

      await expect(store.isSessionUrlAllowed('session-1', 'https://other.example/y')).resolves.toBe(
        false,
      );
      await expect(store.isSessionUrlAllowed('session-2', 'https://example.com/b')).resolves.toBe(
        false,
      );
      await expect(store.isSessionUrlAllowed('session-2', 'https://other.example/z')).resolves.toBe(
        true,
      );
    });

    test('revokes URL authority when a session is soft-deleted', async () => {
      const store = makeStore();
      await store.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });
      await store.registerSessionUrls('session-1', ['https://example.com/a'], 'user');
      await store.softDeleteSession('session-1', 'owner-a');

      await expect(store.isSessionUrlAllowed('session-1', 'https://example.com/b')).resolves.toBe(
        false,
      );
      await store.registerSessionUrls(
        'session-1',
        ['https://after-delete.example/a'],
        'web_search',
      );
      await expect(
        store.isSessionUrlAllowed('session-1', 'https://after-delete.example/b'),
      ).resolves.toBe(false);
    });
  });
}
