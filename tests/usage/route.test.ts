import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/usage/route';
import { readUsageRecords, type UsageRecord } from '@/lib/server/usage-storage';

vi.mock('@/lib/server/usage-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/usage-storage')>();
  return {
    ...actual,
    readUsageRecords: vi.fn(),
  };
});

describe('GET /api/usage', () => {
  it('does not add cache detail fields again to displayed token totals', async () => {
    const record: UsageRecord = {
      id: '1',
      createdAt: Date.UTC(2026, 5, 29),
      kind: 'llm',
      source: 'chat',
      providerId: 'openai',
      modelId: 'gpt-x',
      modelString: 'openai:gpt-x',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 10,
      reasoningTokens: 0,
      unit: 'token',
    };
    vi.mocked(readUsageRecords).mockResolvedValueOnce([record]);

    const response = await GET(new NextRequest('http://localhost/api/usage'));
    const body = await response.json();

    expect(body.totals.llmTokens).toBe(120);
    expect(body.byModel[0].totalTokens).toBe(120);
    expect(body.byModel[0].cacheReadTokens).toBe(30);
    expect(body.byModel[0].cacheCreationTokens).toBe(10);
  });
});
