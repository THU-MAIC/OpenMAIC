/**
 * Host adapter for the durable per-session URL trust gate.
 *
 * The pure normalization helpers are re-exported from the package and pinned
 * here (WHATWG normalization, prose stripping, malformed/non-http rejection).
 * The origin-comparison semantics live in the package's contract suite
 * (packages/@openmaic/storage/test/agent-session-url-contract.ts); this file
 * pins that the adapter resolves the package store and delegates with the
 * exact arguments, including the producer source.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAgentSessionStore: vi.fn(),
}));

vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: mocks.getAgentSessionStore,
}));

import {
  extractObservedUrls,
  isSessionUrlAllowed,
  normalizeObservedUrl,
  registerSessionUrls,
} from '@/lib/server/agent-runtime/session-urls';

function fakeStore() {
  return {
    registerSessionUrls: vi.fn(async () => []),
    isSessionUrlAllowed: vi.fn(async () => false),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('session URL observation normalization', () => {
  it('extracts and WHATWG-normalizes user-authored URLs', () => {
    expect(extractObservedUrls('See https://EXAMPLE.com/a?q=1, and http://2130706433.')).toEqual([
      'https://example.com/a?q=1',
      'http://127.0.0.1/',
    ]);
  });

  it('stops a URL match at CJK punctuation instead of swallowing prose', () => {
    // U+FF0C is the fullwidth comma; the reference normalizes CJK-punctuated
    // prose the same way, and the helper keeps that behavior via code-point
    // escapes so the source stays plain ASCII.
    expect(extractObservedUrls('See https://example.com/a\u{FF0C}then http://b.example/')).toEqual([
      'https://example.com/a',
      'http://b.example/',
    ]);
  });

  it('ignores malformed and non-http URLs', () => {
    expect(normalizeObservedUrl('file:///etc/passwd')).toBeNull();
    expect(extractObservedUrls('no urls here, only example.com')).toEqual([]);
  });
});

describe('host adapter delegation', () => {
  it('delegates registration to the package store with the producer source', async () => {
    const store = fakeStore();
    mocks.getAgentSessionStore.mockResolvedValue(store);

    await registerSessionUrls('ses_1', ['https://example.com/a'], 'web_search');

    expect(store.registerSessionUrls).toHaveBeenCalledWith(
      'ses_1',
      ['https://example.com/a'],
      'web_search',
    );
  });

  it('defaults the source to user for prompt/message registration', async () => {
    const store = fakeStore();
    mocks.getAgentSessionStore.mockResolvedValue(store);

    await registerSessionUrls('ses_1', ['https://example.com/a']);

    expect(store.registerSessionUrls).toHaveBeenCalledWith(
      'ses_1',
      ['https://example.com/a'],
      'user',
    );
  });

  it('delegates allowlist checks to the package store', async () => {
    const store = fakeStore();
    store.isSessionUrlAllowed.mockResolvedValue(true);
    mocks.getAgentSessionStore.mockResolvedValue(store);

    await expect(isSessionUrlAllowed('ses_1', 'https://example.com/x')).resolves.toBe(true);
    expect(store.isSessionUrlAllowed).toHaveBeenCalledWith('ses_1', 'https://example.com/x');
  });
});
