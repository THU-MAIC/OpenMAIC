import { APICallError } from 'ai';
import { createInstance } from 'i18next';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createLogger } from '@/lib/logger';
import {
  configureGenerationRunHooks,
  resetGenerationRunHooksForTests,
} from '@/lib/server/generation-run-hooks/registry';
import { chatGPTPlanLanguageModel } from '@/lib/server/chatgpt-plan/model';
import { runFailureCode } from '@/lib/server/generation/run/failure-code';
import { generateOutlines, type OutlineEvent } from '@/lib/server/generation/steps/outline';
import { planCallError } from '@/lib/server/chatgpt-plan/errors';
import { loadLocaleResource } from '@/lib/i18n/load-resource';
import { runFailureText } from '@/lib/generation-run-client/failure-message';

vi.mock('server-only', () => ({}));
const { request } = vi.hoisted(() => ({ request: vi.fn<() => Promise<Response>>() }));
vi.mock('@/lib/server/chatgpt-plan/http', () => ({ inferenceFetch: request }));
vi.mock('@/lib/server/chatgpt-plan/session', () => ({ chatGPTPlanAccessToken: () => 'test' }));

beforeEach(() => request.mockReset());
afterEach(() => resetGenerationRunHooksForTests());

function outline(emit?: (event: OutlineEvent) => void) {
  return generateOutlines(
    {
      requirements: { requirement: 'Teach fractions' },
      model: {
        model: chatGPTPlanLanguageModel('plan-model'),
        modelString: 'chatgpt-plan:plan-model',
        modelInfo: null,
        thinkingConfig: undefined,
        serverManaged: true,
      },
    },
    {
      workspaceId: null,
      log: createLogger('OutlineTest'),
      resolveVisionImages: async () => [],
      emit,
    },
  );
}

function streamedScene(title: string, refusal?: string) {
  const scene = {
    id: 's1',
    type: 'slide',
    title,
    description: 'A complete scene',
    keyPoints: ['One half'],
  };
  const delta = refusal
    ? `{"outlines":[${JSON.stringify(scene)},`
    : JSON.stringify({ outlines: [scene] });
  const frames = [
    { type: 'response.created', response: { id: 'r1', created_at: 1, model: 'plan-model' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1' } },
    {
      type: 'response.output_text.delta',
      item_id: 'm1',
      output_index: 0,
      content_index: 0,
      delta,
    },
    refusal
      ? {
          type: 'response.failed',
          response: { error: { code: refusal, message: 'private upstream text' } },
        }
      : { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ];
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

it('fails an outline if the provider refuses the stream after sending a complete scene', async () => {
  request.mockImplementation(async () =>
    streamedScene('Partial scene', 'subscription_sharing_usage_limit_exceeded'),
  );
  const emit = vi.fn();
  await expect(
    outline(emit).catch((error) => Promise.reject(runFailureCode(error))),
  ).rejects.toMatchObject({
    errorCode: 'PROVIDER_ACTION_REQUIRED',
    statusCode: 429,
  });
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'outline' }));
  expect(request).toHaveBeenCalledTimes(1);
});

it('retries a transient partial stream and returns only scenes from the completed attempt', async () => {
  request.mockResolvedValueOnce(
    streamedScene('Partial scene', 'subscription_sharing_usage_unavailable'),
  );
  request.mockResolvedValueOnce(streamedScene('Completed scene'));
  const result = await outline();
  expect(result.outlines.map((scene) => scene.title)).toEqual(['Completed scene']);
  expect(request).toHaveBeenCalledTimes(2);
});

it('honors a host that classifies a marked quota refusal as retryable', async () => {
  configureGenerationRunHooks({
    name: 'test',
    classifyFailure: (error) =>
      APICallError.isInstance(error) && error.statusCode === 429
        ? { errorCode: 'HOST_RETRY', retryable: true }
        : undefined,
  });
  request.mockResolvedValueOnce(
    streamedScene('Partial scene', 'subscription_sharing_usage_limit_exceeded'),
  );
  request.mockResolvedValueOnce(streamedScene('Host retry'));
  expect((await outline()).outlines.map((scene) => scene.title)).toEqual(['Host retry']);
  expect(request).toHaveBeenCalledTimes(2);
});

it.each([
  [400, 'subscription_sharing_unsupported_capability'],
  [403, 'subscription_sharing_user_not_eligible'],
  [413, 'request_too_large'],
] as const)(
  'does not repeat an outline request the provider rejected with %i',
  async (status, code) => {
    request.mockImplementation(async () => Response.json({ error: { code } }, { status }));
    await expect(outline()).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it('keeps the quota reason on a paused run and renders actionable Chinese copy', async () => {
  const reason = 'subscription_sharing_usage_limit_exceeded';
  const cause = planCallError({ status: 429, code: reason }, { url: 'https://provider.test' });
  const failure = runFailureCode(new Error('internal wrapper', { cause }));
  expect(failure).toMatchObject({ messageKey: 'settings.chatgptPlan.usageLimit' });
  expect(failure.message).not.toContain(reason);
  const text = runFailureText({ message: 'internal wrapper', ...failure, step: 'outline' });
  const i18n = createInstance();
  await i18n.init({
    lng: 'zh-CN',
    resources: { 'zh-CN': { translation: await loadLocaleResource('zh-CN') } },
  });
  const message = 'key' in text ? i18n.t(text.key) : text.text;
  expect(message).toMatch(/额度|用量/);
  expect(message).toContain('https://chatgpt.com/settings/usage');
  expect(message).not.toContain(reason);
});
