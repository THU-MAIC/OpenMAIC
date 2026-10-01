import { beforeEach, describe, expect, it, vi } from 'vitest';

import { research } from '@/lib/server/generation/steps/research';
import type { WebSearchConfig } from '@/lib/server/web-search-config';
import { SEARCH_QUERY_REWRITE_EXCERPT_LENGTH } from '@/lib/server/search-query-builder';

import { fakeModel, jsonRequest, testLogger } from './helpers';

const mocks = vi.hoisted(() => ({
  searchWeb: vi.fn(),
  callLLM: vi.fn(),
  resolveModelFromRequest: vi.fn(),
}));

vi.mock('@/lib/web-search', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/web-search')>()),
  searchWeb: mocks.searchWeb,
}));
vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
}));

const config = { providerId: 'tavily', apiKey: 'search-key' } as WebSearchConfig;
const searchResult = {
  answer: 'Fractions name parts of a whole.',
  sources: [{ title: 'Fractions', url: 'https://example.com/f', content: 'Parts of a whole.' }],
  query: 'fractions',
  responseTime: 0.2,
};

describe('research step', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mocks.searchWeb.mockReset();
    mocks.searchWeb.mockResolvedValue(searchResult);
    mocks.callLLM.mockReset();
    mocks.callLLM.mockResolvedValue({ text: 'fractions for ten year olds' });
    mocks.resolveModelFromRequest.mockReset();
  });

  it('searches the raw requirement without a rewrite model', async () => {
    const result = await research(
      { query: 'Teach fractions', pdfText: 'Chapter 1', config },
      { log: testLogger() },
    );
    expect(mocks.callLLM).not.toHaveBeenCalled();
    expect(mocks.searchWeb).toHaveBeenCalledWith({ ...config, query: 'Teach fractions' });
    expect(result).toMatchObject({ ...searchResult });
    expect(result.context).toContain('Fractions');
  });

  it('rewrites the query from an excerpt of the material with a rewrite model', async () => {
    const model = fakeModel({ serverManaged: true });
    await research(
      {
        query: 'Teach fractions',
        pdfText: 'x'.repeat(SEARCH_QUERY_REWRITE_EXCERPT_LENGTH + 500),
        config,
        rewriteModel: model,
      },
      { log: testLogger() },
    );
    const [params, source, , , fallback] = mocks.callLLM.mock.calls[0]!;
    expect(source).toBe('web-search-query-rewrite');
    expect(fallback).toEqual({ serverManaged: true });
    expect(params).toMatchObject({ model: model.model, maxOutputTokens: 256 });
    // Only an excerpt of the material reaches the rewrite prompt.
    expect(JSON.stringify(params.messages)).not.toContain(
      'x'.repeat(SEARCH_QUERY_REWRITE_EXCERPT_LENGTH + 1),
    );
  });

  it('answers the route exactly as the step does', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'search-key');
    mocks.resolveModelFromRequest.mockResolvedValue(fakeModel());
    const body = { query: 'Teach fractions', pdfText: 'Chapter 1' };
    const { POST } = await import('@/app/api/web-search/route');
    const response = await POST(jsonRequest('http://localhost/api/web-search', body));
    expect(response.status).toBe(200);
    const routed = await response.json();
    const { query: _query, ...routedConfig } = mocks.searchWeb.mock.calls[0]![0];
    const routedRewrite = mocks.callLLM.mock.calls[0];

    mocks.searchWeb.mockClear();
    mocks.callLLM.mockClear();
    const stepped = await research(
      { ...body, config: routedConfig, rewriteModel: fakeModel() },
      { log: testLogger() },
    );
    expect(routed).toEqual({ success: true, ...stepped });
    expect(mocks.callLLM.mock.calls[0]).toEqual(routedRewrite);
  });
});
