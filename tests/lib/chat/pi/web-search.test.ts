import { describe, expect, it, vi } from 'vitest';
import { buildDirectorWebSearchTool } from '@/lib/chat/pi/tools/web-search';

const responsesConfig = () => ({
  providerId: 'responses' as const,
  apiKey: 'responses-key',
  baseUrl: 'https://responses-proxy.test/v1',
  model: 'search-model',
});

describe('Pi Director web_search', () => {
  it('returns bounded external evidence with URLs and retrieval time', async () => {
    const logCall = vi.fn();
    const onEvidence = vi.fn();
    const searchResponses = vi.fn(async () => ({
      answer: 'Argentina won the final after a penalty shootout.',
      query: 'latest football world cup final result',
      responseTime: 0.25,
      sources: [
        {
          title: 'Official match report',
          url: 'https://example.test/match-report',
          content: 'The final score and shootout details are recorded here.',
          score: 0.98,
        },
      ],
    }));
    const tool = buildDirectorWebSearchTool({
      stageId: 'stage-1',
      resolveConfig: responsesConfig,
      searchResponses,
      logCall,
      onEvidence,
      now: () => new Date('2026-07-21T06:00:00.000Z'),
    });

    const result = await tool.execute('search-1', {
      query: 'latest football world cup final result',
      maxResults: 3,
    });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';

    expect((result as { isError?: boolean }).isError).not.toBe(true);
    expect(text).toContain('retrievedAt=2026-07-21T06:00:00.000Z');
    expect(text).toContain('https://example.test/match-report');
    expect(text).toContain('untrusted external data');
    expect(result.details).toMatchObject({
      status: 'ok',
      provider: 'responses',
      retrievedAt: '2026-07-21T06:00:00.000Z',
      sourceCount: 1,
    });
    expect(logCall).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'responses', status: 'success', stageId: 'stage-1' }),
    );
    expect(onEvidence).toHaveBeenCalledWith({
      query: 'latest football world cup final result',
      retrievedAt: '2026-07-21T06:00:00.000Z',
      answer: 'Argentina won the final after a penalty shootout.',
      sources: [
        {
          title: 'Official match report',
          url: 'https://example.test/match-report',
          excerpt: 'The final score and shootout details are recorded here.',
        },
      ],
    });
  });

  it('fails explicitly when Responses web search is not fully configured', async () => {
    const searchResponses = vi.fn();
    const tool = buildDirectorWebSearchTool({
      resolveConfig: () => undefined,
      searchResponses,
      now: () => new Date('2026-07-21T06:00:00.000Z'),
    });

    const result = await tool.execute('search-2', { query: 'current result' });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(searchResponses).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ status: 'not_configured', sourceCount: 0 });
  });

  it('passes the tool cancellation signal into the Responses adapter', async () => {
    const searchResponses = vi.fn(async () => ({
      answer: 'Current result with citations.',
      query: 'current result',
      responseTime: 0.5,
      sources: [
        {
          title: 'Official result',
          url: 'https://example.test/result',
          content: 'Primary-source match report.',
          score: 1,
        },
      ],
    }));
    const tool = buildDirectorWebSearchTool({
      resolveConfig: responsesConfig,
      searchResponses,
      logCall: vi.fn(),
    });
    const controller = new AbortController();

    await tool.execute('search-responses', { query: 'current result' }, controller.signal);

    expect(searchResponses).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'responses-key',
        baseUrl: 'https://responses-proxy.test/v1',
        model: 'search-model',
        signal: controller.signal,
      }),
    );
  });

  it('trims, deduplicates, and rejects non-HTTP(S) source URLs before installing evidence', async () => {
    const onEvidence = vi.fn();
    const tool = buildDirectorWebSearchTool({
      resolveConfig: responsesConfig,
      searchResponses: vi.fn(async () => ({
        answer: 'A mixed-quality result.',
        query: 'current result',
        responseTime: 0.1,
        sources: [
          {
            title: 'Official source',
            url: ' https://example.test/official ',
            content: 'Evidence.',
            score: 1,
          },
          {
            title: 'Duplicate source',
            url: 'https://example.test/official',
            content: 'Duplicate.',
            score: 0.9,
          },
          { title: 'Relative', url: '/relative', content: 'Invalid.', score: 0.8 },
          { title: 'Javascript', url: 'javascript:alert(1)', content: 'Invalid.', score: 0.7 },
          { title: 'Blank', url: '   ', content: 'Invalid.', score: 0.6 },
        ],
      })),
      onEvidence,
      logCall: vi.fn(),
    });

    const result = await tool.execute('search-filter', { query: 'current result' });

    expect(result.details).toMatchObject({ status: 'ok', sourceCount: 1 });
    expect(result.details.sources).toEqual([
      expect.objectContaining({ url: 'https://example.test/official' }),
    ]);
    expect(onEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [expect.objectContaining({ url: 'https://example.test/official' })],
      }),
    );
  });

  it('fails closed when every returned source URL is invalid', async () => {
    const onEvidence = vi.fn();
    const logCall = vi.fn();
    const tool = buildDirectorWebSearchTool({
      resolveConfig: responsesConfig,
      searchResponses: vi.fn(async () => ({
        answer: 'An unsupported current answer.',
        query: 'current result',
        responseTime: 0.1,
        sources: [
          { title: 'Relative', url: '/relative', content: 'Invalid.', score: 1 },
          { title: 'Blank', url: '', content: 'Invalid.', score: 0.5 },
        ],
      })),
      onEvidence,
      logCall,
    });

    const result = await tool.execute('search-no-sources', { query: 'current result' });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(result.details).toMatchObject({ status: 'insufficient_evidence', sourceCount: 0 });
    expect(onEvidence).not.toHaveBeenCalled();
    expect(logCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', error: expect.stringContaining('without any') }),
    );
  });

  it('clears prior evidence before every new search, including failures', async () => {
    const lifecycle: string[] = [];
    const searchResponses = vi
      .fn()
      .mockResolvedValueOnce({
        answer: 'Supported answer.',
        query: 'first query',
        responseTime: 0.1,
        sources: [
          {
            title: 'Official source',
            url: 'https://example.test/official',
            content: 'Evidence.',
            score: 1,
          },
        ],
      })
      .mockRejectedValueOnce(new Error('provider failed'));
    const tool = buildDirectorWebSearchTool({
      resolveConfig: responsesConfig,
      searchResponses,
      logCall: vi.fn(),
      onSearchStart: () => lifecycle.push('clear'),
      onEvidence: () => lifecycle.push('install'),
    });

    await tool.execute('search-first', { query: 'first query' });
    await tool.execute('search-second', { query: 'second query' });

    expect(lifecycle).toEqual(['clear', 'install', 'clear']);
  });

  it('returns an auditable failure instead of fabricating evidence', async () => {
    const logCall = vi.fn();
    const tool = buildDirectorWebSearchTool({
      stageId: 'stage-1',
      resolveConfig: responsesConfig,
      searchResponses: vi.fn(async () => {
        throw new Error('provider timeout');
      }),
      logCall,
    });

    const result = await tool.execute('search-3', { query: 'current result' });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text).toContain('provider timeout');
    expect(text).toContain('Do not invent current facts');
    expect(result.details).toMatchObject({ status: 'error', provider: 'responses' });
    expect(logCall).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'responses',
        status: 'error',
        error: 'provider timeout',
      }),
    );
  });
});
