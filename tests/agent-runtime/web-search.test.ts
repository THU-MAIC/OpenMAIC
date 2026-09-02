/**
 * resolveWebSearchCapability — capability registration must follow the
 * resolver's own per-provider usability rules, including keyless providers
 * (brave/searxng carry no API key by definition) and the capability force-off
 * plumbing (a disabled-only config must count as not configured). An
 * extra non-empty-key check on top would silently unregister web_search on
 * exactly the keyless deployments.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { searchWebMock } = vi.hoisted(() => ({ searchWebMock: vi.fn() }));

vi.mock('@/lib/server/web-search-config', () => ({
  resolveClassroomWebSearchConfig: vi.fn(),
}));
vi.mock('@/lib/web-search', () => ({
  searchWeb: searchWebMock,
  formatSearchResultsAsContext: vi.fn(() => 'search context'),
}));

import { resolveClassroomWebSearchConfig } from '@/lib/server/web-search-config';
import {
  buildWebSearchTool,
  resolveWebSearchCapability,
  type WebSearchCapability,
} from '@/lib/server/agent-runtime/web-search';

const mocked = vi.mocked(resolveClassroomWebSearchConfig);

afterEach(() => {
  mocked.mockReset();
  searchWebMock.mockReset();
});

describe('resolveWebSearchCapability', () => {
  it('registers when a keyed provider resolves', () => {
    mocked.mockReturnValue({
      providerId: 'tavily',
      apiKey: 'tvly-test',
      baseUrl: 'https://api.tavily.com',
    });
    expect(resolveWebSearchCapability()).toEqual({
      providerId: 'tavily',
      apiKey: 'tvly-test',
      baseUrl: 'https://api.tavily.com',
    });
  });

  it('registers a KEYLESS provider (empty apiKey is a valid configuration)', () => {
    mocked.mockReturnValue({
      providerId: 'searxng',
      apiKey: '',
      baseUrl: 'https://searx.example',
    });
    const capability = resolveWebSearchCapability();
    expect(capability).not.toBeNull();
    expect(capability?.providerId).toBe('searxng');
  });

  it('stays unregistered when the resolver finds nothing usable', () => {
    mocked.mockReturnValue(undefined);
    expect(resolveWebSearchCapability()).toBeNull();
  });
});

describe('web_search abort handling', () => {
  const capability: WebSearchCapability = {
    providerId: 'searxng',
    apiKey: '',
    baseUrl: 'https://search.example',
  };

  it('fails fast without calling the provider when the run signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const tool = buildWebSearchTool(capability);
    await expect(
      tool.execute('call_1', { query: 'q' } as never, controller.signal),
    ).rejects.toThrow('aborted');
    expect(searchWebMock).not.toHaveBeenCalled();
  });

  it('throws aborted when the signal fires after the provider fetch resolves', async () => {
    const controller = new AbortController();
    searchWebMock.mockImplementation(async () => {
      controller.abort();
      return {
        answer: '',
        query: 'q',
        responseTime: 0.1,
        sources: [{ title: 'A', url: 'https://a.example/', content: 'a', score: 1 }],
      };
    });
    const tool = buildWebSearchTool(capability);
    await expect(
      tool.execute('call_1', { query: 'q' } as never, controller.signal),
    ).rejects.toThrow('aborted');
  });
});

describe('web_search URL observation', () => {
  const capability: WebSearchCapability = {
    providerId: 'searxng',
    apiKey: '',
    baseUrl: 'https://search.example',
  };

  it('registers every result URL before returning when a callback is supplied', async () => {
    searchWebMock.mockResolvedValue({
      answer: '',
      query: 'q',
      responseTime: 0.1,
      sources: [
        { title: 'A', url: 'https://a.example/', content: 'a', score: 1 },
        { title: 'B', url: 'https://b.example/path?q=1', content: 'b', score: 1 },
      ],
    });
    const onUrlsObserved = vi.fn(async () => undefined);
    const tool = buildWebSearchTool(capability, onUrlsObserved);

    const output = await tool.execute('call_1', { query: 'q' } as never, undefined);

    expect(onUrlsObserved).toHaveBeenCalledWith([
      'https://a.example/',
      'https://b.example/path?q=1',
    ]);
    // Registration happens before the tool result resolves, and the result is
    // still returned normally.
    expect(output).toMatchObject({ content: [{ type: 'text', text: 'search context' }] });
  });

  it('skips registration when no callback is supplied', async () => {
    searchWebMock.mockResolvedValue({
      answer: '',
      query: 'q',
      responseTime: 0.1,
      sources: [{ title: 'A', url: 'https://a.example/', content: 'a', score: 1 }],
    });
    const tool = buildWebSearchTool(capability);

    await expect(tool.execute('call_1', { query: 'q' } as never, undefined)).resolves.toBeDefined();
  });

  it('lets a registration failure fail the tool call (reference semantics)', async () => {
    searchWebMock.mockResolvedValue({
      answer: '',
      query: 'q',
      responseTime: 0.1,
      sources: [{ title: 'A', url: 'https://a.example/', content: 'a', score: 1 }],
    });
    const onUrlsObserved = vi.fn(async () => {
      throw new Error('store unavailable');
    });
    const tool = buildWebSearchTool(capability, onUrlsObserved);

    // The reference awaits registration inside execute without swallowing, so
    // a store failure surfaces as a failed tool call rather than returning
    // results the trust gate cannot back.
    await expect(tool.execute('call_1', { query: 'q' } as never, undefined)).rejects.toThrow(
      'store unavailable',
    );
  });
});
