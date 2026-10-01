/**
 * What `POST /api/generation-runs` and the commands accept, and how a run
 * classifies a step failure for its retries (as the step's route would).
 */
import { describe, expect, it, vi } from 'vitest';

import { StepRefusal } from '@/lib/server/generation/steps/context';
import {
  parseCommandId,
  parseConfirmOutline,
  parseRunInput,
} from '@/lib/server/generation/run/input';
import { withRouteRetry } from '@/lib/server/generation/run/retry';

describe('run input', () => {
  it('fills the defaults: no materials, generated agents, waiting outline review', () => {
    expect(parseRunInput({ requirement: 'Teach fractions' })).toEqual({
      ok: true,
      value: {
        requirement: 'Teach fractions',
        materialIds: [],
        interactive: false,
        taskEngine: false,
        agents: { mode: 'auto' },
        outlineReview: 'wait',
      },
    });
  });

  it('keeps every field a run reads, and no keys or models', () => {
    const parsed = parseRunInput({
      requirement: 'Teach fractions',
      materialIds: ['mat_00000000000000000000000000', 'mat_00000000000000000000000000'],
      interactive: true,
      taskEngine: true,
      agents: { mode: 'preset', agentIds: ['default-1', 'default-1', 'default-2'] },
      learnerProfile: { nickname: ' Sam ', bio: '' },
      outlineReview: 'auto',
      voice: { providerId: 'openai-tts', voiceId: 'alloy', speed: 1.25 },
      apiKey: 'sk-ignored',
      model: 'ignored',
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        requirement: 'Teach fractions',
        materialIds: ['mat_00000000000000000000000000'],
        interactive: true,
        taskEngine: true,
        agents: { mode: 'preset', agentIds: ['default-1', 'default-2'] },
        learnerProfile: { nickname: 'Sam' },
        outlineReview: 'auto',
        voice: { providerId: 'openai-tts', voiceId: 'alloy', speed: 1.25 },
      },
    });
  });

  it.each([
    [{}, /requirement/],
    [{ requirement: '  ' }, /requirement/],
    [{ requirement: 'x', materialIds: ['nope'] }, /materialIds/],
    [{ requirement: 'x', agents: { mode: 'preset', agentIds: [] } }, /agentIds/],
    [{ requirement: 'x', agents: { mode: 'random' } }, /agents must be/],
    [{ requirement: 'x', outlineReview: 'skip' }, /outlineReview/],
    [{ requirement: 'x', interactive: 'yes' }, /interactive/],
    [
      { requirement: 'x', voice: { providerId: 'openai-tts', voiceId: 'alloy', speed: 9 } },
      /voice/,
    ],
  ])('refuses %j', (body, message) => {
    const parsed = parseRunInput(body);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.message).toMatch(message);
  });

  it('checks commands', () => {
    expect(parseCommandId('a1:b-2.c_3')).toEqual({ ok: true, value: 'a1:b-2.c_3' });
    expect(parseCommandId('has space').ok).toBe(false);
    expect(parseConfirmOutline({ commandId: 'c', outlineRevision: 0 }).ok).toBe(false);
    expect(parseConfirmOutline({ commandId: 'c', outlineRevision: 2 })).toEqual({
      ok: true,
      value: { commandId: 'c', outlineRevision: 2 },
    });
    const outline = { id: 'o1', type: 'slide', title: 'T', order: 1 };
    expect(
      parseConfirmOutline({ commandId: 'c', outlineRevision: 1, outlines: [outline, outline] }),
    ).toMatchObject({ ok: false, message: /repeat/ });
    expect(
      parseConfirmOutline({ commandId: 'c', outlineRevision: 1, outlines: [{ id: 'o1' }] }).ok,
    ).toBe(false);
    expect(
      parseConfirmOutline({ commandId: 'c', outlineRevision: 1, outlines: [outline] }),
    ).toEqual({ ok: true, value: { commandId: 'c', outlineRevision: 1, outlines: [outline] } });
  });
});

describe('step retries', () => {
  const options = (refusalStatus: 400 | 500) => ({
    label: 'test',
    maxRetries: 2,
    refusalStatus,
    sleep: async () => undefined,
  });

  it('retries what the route answers with a 5xx or 429, and nothing it answers with a 4xx', async () => {
    const flaky = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue('ok');
    expect(await withRouteRetry(flaky, options(500))).toBe('ok');
    expect(flaky).toHaveBeenCalledTimes(2);

    const limited = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('slow down'), { statusCode: 429 }))
      .mockResolvedValue('ok');
    expect(await withRouteRetry(limited, options(500))).toBe('ok');

    const unauthorized = Object.assign(new Error('no'), { statusCode: 401 });
    const refused = vi.fn().mockRejectedValue(unauthorized);
    await expect(withRouteRetry(refused, options(500))).rejects.toBe(unauthorized);
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it('retries a refusal where the route answers it with a 500, not where it answers a 400', async () => {
    const refusal = new StepRefusal('generation-failed', 'empty');
    const content = vi.fn().mockRejectedValue(refusal);
    await expect(withRouteRetry(content, options(500))).rejects.toBe(refusal);
    expect(content).toHaveBeenCalledTimes(3);
    const narration = vi.fn().mockRejectedValue(refusal);
    await expect(withRouteRetry(narration, options(400))).rejects.toBe(refusal);
    expect(narration).toHaveBeenCalledTimes(1);
  });
});
