/**
 * What `POST /api/generation-runs` and the commands accept, and how a run
 * classifies a step failure for its retries (as the step's route would).
 */
import { describe, expect, it, vi } from 'vitest';

import { StepRefusal } from '@/lib/server/generation/steps/context';
import {
  MAX_OUTLINE_JSON_BYTES,
  MAX_OUTLINE_SCENES,
  MAX_START_BODY_BYTES,
  parseCommandId,
  parseConfirmOutline,
  parseOutlines,
  parseRunInput,
  readJsonBody,
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
    ).toEqual({
      ok: true,
      value: {
        commandId: 'c',
        outlineRevision: 1,
        outlines: [{ ...outline, description: '', keyPoints: [] }],
      },
    });
  });
});

describe('outline validation', () => {
  const outline = (overrides: Record<string, unknown> = {}) => ({
    id: 'o1',
    type: 'slide',
    title: 'Intro',
    description: 'Why',
    keyPoints: ['a', 'b'],
    order: 1,
    ...overrides,
  });

  it('keeps the outline schema and drops members it does not know', () => {
    const parsed = parseOutlines([
      outline({
        mediaGenerations: [{ type: 'image', prompt: 'a leaf', elementId: 'gen_img_1' }],
        quizConfig: { questionCount: 3, difficulty: 'easy', questionTypes: ['single'] },
        widgetType: 'diagram',
        widgetOutline: { concept: 'flow', nodeCount: 4 },
        notes: 'not part of the schema',
      }),
    ]);
    expect(parsed).toEqual({
      ok: true,
      value: [
        {
          id: 'o1',
          type: 'slide',
          title: 'Intro',
          description: 'Why',
          keyPoints: ['a', 'b'],
          order: 1,
          mediaGenerations: [{ type: 'image', prompt: 'a leaf', elementId: 'gen_img_1' }],
          quizConfig: { questionCount: 3, difficulty: 'easy', questionTypes: ['single'] },
          widgetType: 'diagram',
          widgetOutline: { concept: 'flow', nodeCount: 4 },
        },
      ],
    });
  });

  it('is lenient where a model is loose: nulls are absent, wrong optional shapes dropped', () => {
    const modelStyle = [
      {
        id: 'o1',
        type: 'quiz',
        title: 'Check',
        description: null,
        keyPoints: ['a', '', '  ', 7, null, 'b'],
        teachingObjective: null,
        estimatedDuration: 'five minutes',
        order: 1,
        suggestedImageIds: null,
        mediaGenerations: [
          { type: 'image', prompt: 'a leaf', elementId: 'gen_img_1', aspectRatio: 'wide' },
          { type: 'gif', prompt: 'p', elementId: 'e' },
          null,
        ],
        quizConfig: { questionCount: 3, difficulty: 'tricky', questionTypes: ['single', 'essay'] },
        pblConfig: { projectTopic: 'Garden', projectDescription: null },
        widgetType: 'chart',
        widgetOutline: { concept: 'flow', nodes: null, steps: ['x', null] },
        extra: { anything: true },
      },
    ];
    const parsed = parseOutlines(modelStyle);
    expect(parsed).toEqual({
      ok: true,
      value: [
        {
          id: 'o1',
          type: 'quiz',
          title: 'Check',
          description: '',
          keyPoints: ['a', 'b'],
          order: 1,
          mediaGenerations: [{ type: 'image', prompt: 'a leaf', elementId: 'gen_img_1' }],
          pblConfig: { projectTopic: 'Garden' },
          widgetOutline: { concept: 'flow', steps: ['x'] },
        },
      ],
    });
    // The normal form is a fixed point: a normalized outline confirms unchanged.
    expect(parseOutlines(parsed.ok && parsed.value)).toEqual(parsed);
  });

  it('keeps a scene of a type it does not know (its content step decides), bounded', () => {
    const parsed = parseOutlines([outline({ type: 'video' })]);
    expect(parsed.ok && parsed.value[0]!.type).toBe('video');
  });

  it('keeps a quiz configuration only when the generator can use it as it is', () => {
    const quiz = (quizConfig: unknown) => {
      const parsed = parseOutlines([outline({ type: 'quiz', quizConfig })]);
      return parsed.ok ? parsed.value[0]!.quizConfig : 'refused';
    };
    const usable = { questionCount: 3, difficulty: 'easy', questionTypes: ['single', 'essay'] };
    expect(quiz(usable)).toEqual({
      questionCount: 3,
      difficulty: 'easy',
      questionTypes: ['single'],
    });
    expect(quiz({ ...usable, questionTypes: ['essay'] })).toBeUndefined();
    expect(quiz({ ...usable, difficulty: undefined })).toBeUndefined();
    expect(quiz({ ...usable, questionCount: 0 })).toBeUndefined();
    expect(quiz({ ...usable, questionCount: 101 })).toBeUndefined();
  });

  it('keeps at most 20 media requests per scene', () => {
    const media = Array.from({ length: 25 }, (_, i) => ({
      type: 'image',
      prompt: `p${i}`,
      elementId: `gen_img_${i}`,
    }));
    const parsed = parseOutlines([outline({ mediaGenerations: media })]);
    expect(parsed.ok && parsed.value[0]!.mediaGenerations).toHaveLength(20);
  });

  it("measures its size in UTF-8 bytes, the outline step's unit", () => {
    // Under the byte cap in UTF-16 code units, over it in UTF-8 bytes.
    const wide = '\u4e2d'.repeat(60_000);
    const outlines = Array.from({ length: 3 }, (_, i) =>
      outline({ id: `o${i}`, order: i, description: wide }),
    );
    expect(JSON.stringify(outlines).length).toBeLessThan(MAX_OUTLINE_JSON_BYTES);
    expect(parseOutlines(outlines)).toMatchObject({ ok: false, message: /bytes/ });
  });

  it.each([
    ['a scene without a type', [outline({ type: '' })], /type/],
    ['an overlong type', [outline({ type: 't'.repeat(65) })], /type/],
    ['an order out of bounds', [outline({ order: 10_001 })], /order/],
    ['a fractional order', [outline({ order: 1.5 })], /order/],
    ['a missing order', [outline({ order: null })], /order/],
    ['a missing id', [outline({ id: null })], /id/],
    ['a repeated order', [outline(), outline({ id: 'o2' })], /repeat an order/],
    ['a repeated id', [outline(), outline({ order: 2 })], /repeat an id/],
    ['a scene that is not an object', [outline(), 'scene'], /object/],
    ['no scenes', [], /1 to/],
    [
      'too many scenes',
      Array.from({ length: MAX_OUTLINE_SCENES + 1 }, (_, i) => outline({ id: `o${i}`, order: i })),
      /1 to/,
    ],
    [
      'too many bytes',
      Array.from({ length: 50 }, (_, i) =>
        outline({ id: `o${i}`, order: i, description: 'd'.repeat(12_000) }),
      ),
      /bytes/,
    ],
  ])('refuses %s', (_label, outlines, message) => {
    const parsed = parseOutlines(outlines);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.message).toMatch(message);
  });

  it('refuses a body over its byte limit, declared or not', async () => {
    const big = JSON.stringify({ requirement: 'x'.repeat(MAX_START_BODY_BYTES) });
    const declared = await readJsonBody(
      new Request('http://localhost/', { method: 'POST', body: big }),
      MAX_START_BODY_BYTES,
    );
    expect(declared).toMatchObject({ ok: false, status: 413 });
    const streamed = await readJsonBody(
      new Request('http://localhost/', {
        method: 'POST',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(big));
            controller.close();
          },
        }),
        duplex: 'half',
      } as RequestInit),
      MAX_START_BODY_BYTES,
    );
    expect(streamed).toMatchObject({ ok: false, status: 413 });
    expect(
      await readJsonBody(
        new Request('http://localhost/', { method: 'POST', body: '{"a":1}' }),
        MAX_START_BODY_BYTES,
      ),
    ).toEqual({ ok: true, value: { a: 1 } });
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
