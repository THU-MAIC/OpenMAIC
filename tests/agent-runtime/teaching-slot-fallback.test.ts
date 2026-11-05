import { afterEach, expect, it, vi } from 'vitest';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { APICallError } from 'ai';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ lookupSlot: vi.fn(), slotLanguageModel: vi.fn() }));
vi.mock('@/lib/server/usage-storage', () => ({ recordUsage: vi.fn(async () => undefined) }));
vi.mock('@/lib/server/model-config/runtime', async (original) => ({
  ...(await original<typeof import('@/lib/server/model-config/runtime')>()),
  lookupSlot: mocks.lookupSlot,
}));
vi.mock('@/lib/server/model-config/llm', () => ({ slotLanguageModel: mocks.slotLanguageModel }));

import * as providers from '@/lib/ai/providers';
import { attachModelFallback } from '@/lib/ai/model-fallbacks';
import { resolveAgentDriverModel } from '@/lib/server/agent-runtime/agent-driver-model';
import { createCallLlmStreamFn } from '@/lib/agent/runtime/stream-fn';
import { teachingModelBudget } from '@/lib/server/pbl-v3/context-budget';
import { createTeachingContextProjection } from '@/lib/server/pbl-v3/context-projection';

afterEach(() => vi.restoreAllMocks());

it.each([8192, undefined])(
  'serves a real connector fallback without a primary-only output cap (%s)',
  async (fallbackOutput) => {
    const primary = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'primary',
      doStream: async () => {
        throw new APICallError({
          message: 'insufficient_quota',
          url: 'https://example.invalid',
          requestBodyValues: {},
          statusCode: 429,
          isRetryable: true,
          responseBody: JSON.stringify({
            error: { code: 'insufficient_quota', message: 'Quota exhausted' },
          }),
        });
      },
    });
    const fallback = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'backup',
      doStream: async (params) => {
        // A provider rejects a primary's 32K output request against its 8K maximum.
        expect(params.maxOutputTokens === undefined || params.maxOutputTokens <= 8192).toBe(true);
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: '1' },
              { type: 'text-delta', id: '1', delta: 'Recovered on backup.' },
              { type: 'text-end', id: '1' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              },
            ],
          }),
        };
      },
    });
    attachModelFallback(primary, async () => ({ model: fallback, modelString: 'mock:backup' }));
    mocks.lookupSlot.mockResolvedValue({
      status: 'assigned',
      requirements: [],
      api: 'openai-completions',
      fallback: { registryId: 'openai', modelId: 'backup' },
    });
    mocks.slotLanguageModel.mockResolvedValue({
      model: primary,
      modelId: 'primary',
      providerId: 'mock',
      modelInfo: { contextWindow: 200_000, outputWindow: 32_768 },
    });
    vi.spyOn(providers, 'getModelInfo').mockReturnValue({
      contextWindow: 64_000,
      outputWindow: fallbackOutput,
    } as never);
    const driver = await resolveAgentDriverModel(),
      target = driver.teaching;
    const budget = teachingModelBudget(target.piModel);
    const stream = createCallLlmStreamFn({
      languageModel: driver.connection.model,
      maxOutputTokens: target.wireMaxOutputTokens === undefined ? undefined : budget.outputTokens,
      omitMaxOutputTokens: target.wireMaxOutputTokens === undefined,
      thinkingConfig: { mode: 'disabled' },
    });
    const result = await (
      await stream(target.piModel, {
        messages: [{ role: 'user', content: 'Continue.', timestamp: 0 }],
      })
    ).result();
    expect(result.stopReason).toBe('stop');
    expect(result.content).toContainEqual({ type: 'text', text: 'Recovered on backup.' });
    expect(fallback.doStreamCalls).toHaveLength(1);
    expect(fallback.doStreamCalls[0]!.maxOutputTokens).toBe(fallbackOutput);
    expect(target.piModel.contextWindow).toBe(64_000);

    // Projection uses that same smaller window, even before a primary outage.
    const summary = vi.fn();
    const projection = createTeachingContextProjection(summary);
    await expect(
      projection.prepare(
        { messages: [{ role: 'user', content: 'x'.repeat(70_000), timestamp: 0 }] },
        { stageKey: 'm1:3', studentTurns: 1 },
        target.piModel,
      ),
    ).rejects.toThrow('PBL_CONTEXT_CAPACITY');
    expect(summary).not.toHaveBeenCalled();
    projection.dispose();
  },
);
