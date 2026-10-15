import { createHash } from 'node:crypto';
import { jsonSchema } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  isProviderKeyRequired: vi.fn(),
  generateSceneOutlinesFromRequirements: vi.fn(),
  applyOutlineFallbacks: vi.fn(),
  generateSceneContent: vi.fn(),
  generateSceneActions: vi.fn(),
  createSceneWithActions: vi.fn(),
  persistClassroom: vi.fn(),
  callLLM: vi.fn(),
  retryOptions: vi.fn(),
  prepareClassroomSpeechForTTS: vi.fn(),
  generateTTSForClassroom: vi.fn(),
  generateMediaForClassroom: vi.fn(),
  replaceMediaPlaceholders: vi.fn(),
  createClassroomContentCallbacks: vi.fn(),
  reviewClassroomContent: vi.fn(),
  matchesClassroomContentProof: vi.fn(),
}));
const PBLGenerationErrorMock = vi.hoisted(
  () =>
    class PBLGenerationError extends Error {
      readonly statusCode?: number;

      constructor(message: string, options?: { statusCode?: number }) {
        super(message);
        this.name = 'PBLGenerationError';
        this.statusCode = options?.statusCode;
      }
    },
);

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModel: mocks.resolveModel,
}));

vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  // The module graph now reaches the settings store (stage store -> settings),
  // whose init reads PROVIDERS - keep the real exports and stub only the probe.
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  isProviderKeyRequired: mocks.isProviderKeyRequired,
}));

vi.mock('@/lib/ai/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/llm')>()),
  callLLM: mocks.callLLM,
}));

vi.mock('@openmaic/generation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openmaic/generation')>();
  return {
    ...actual,
    generateSceneOutlinesFromRequirements: mocks.generateSceneOutlinesFromRequirements,
    applyOutlineFallbacks: mocks.applyOutlineFallbacks,
    generateSceneContent: mocks.generateSceneContent,
    generateSceneActions: mocks.generateSceneActions,
    PBLGenerationError: PBLGenerationErrorMock,
    withGenerationRetry: (...args: Parameters<typeof actual.withGenerationRetry>) => {
      mocks.retryOptions(args[1]);
      return actual.withGenerationRetry(...args);
    },
  };
});

vi.mock('@/lib/server/scene-generation', () => ({
  createSceneWithActions: mocks.createSceneWithActions,
}));

vi.mock('@/lib/server/classroom-storage', () => ({
  persistClassroom: mocks.persistClassroom,
}));

vi.mock('@/lib/server/classroom-media-generation', () => ({
  prepareClassroomSpeechForTTS: mocks.prepareClassroomSpeechForTTS,
  generateTTSForClassroom: mocks.generateTTSForClassroom,
  generateMediaForClassroom: mocks.generateMediaForClassroom,
  replaceMediaPlaceholders: mocks.replaceMediaPlaceholders,
}));

vi.mock('@/lib/server/classroom-content-review', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/classroom-content-review')>()),
  createClassroomContentCallbacks: mocks.createClassroomContentCallbacks,
  reviewClassroomContent: mocks.reviewClassroomContent,
  matchesClassroomContentProof: mocks.matchesClassroomContentProof,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const outline = {
  id: 'outline-1',
  type: 'slide',
  title: 'Retry Basics',
  description: 'Explain retries',
  keyPoints: ['Retry transient failures'],
  order: 1,
} as const;

const slideContent = {
  elements: [],
  remark: 'Retry transient failures',
};

// Typed pipeline fixtures only; these are not source facts or semantic acceptance.
function contentForOutline(sceneOutline: { type: string }) {
  if (sceneOutline.type === 'interactive') {
    return {
      html: '<button id="fixture-reset">Reset fixture</button>',
      widgetType: 'simulation' as const,
      widgetConfig: {},
    };
  }
  if (sceneOutline.type === 'quiz') {
    return {
      questions: [
        {
          id: 'fixture-question',
          type: 'single' as const,
          question: 'Pipeline fixture only',
          options: [{ label: 'Fixture option', value: 'A' }],
          answer: ['A'],
          analysis: 'Fixture only',
        },
      ],
    };
  }
  return structuredClone(slideContent);
}

// Only pipeline ordering is tested here. This stub is not a factual pass.
const testProof = { contentPass: true, testOnly: 'pipeline-ordering' };
const sequence: string[] = [];

function requiredInput(overrides: Record<string, unknown> = {}) {
  const correctedCode = 'value = input()\nprint(value)\n';
  return {
    requirement: 'Explain the complete supplied problem and original program.',
    codeContextRequired: true,
    codemateSource: {
      title: 'Program echo',
      content: 'Read one token and print it.\n',
      code: 'value = input()\nprint(value)\n',
      correctedCode,
      language: 'Python',
      referenceValidation: {
        status: 'stored-passed' as const,
        scope: 'original_validation_run_current_suite_not_revalidated_for_classroom',
        codeHash: createHash('sha256').update(correctedCode).digest('hex'),
      },
    },
    ...overrides,
  };
}

async function generateRequiredWithProgress(
  overrides: Record<string, unknown> = {},
  signal?: AbortSignal,
) {
  const progress: Array<{ step: string; message: string }> = [];
  const { generateClassroom } = await import('@/lib/server/classroom-generation');
  const result = await generateClassroom(requiredInput(overrides), {
    baseUrl: 'http://localhost',
    signal,
    onProgress: (event) => {
      progress.push({ step: event.step, message: event.message });
    },
  });
  return { result, progress };
}

async function generateWithProgress() {
  const progress: Array<{ message: string }> = [];
  const { generateClassroom } = await import('@/lib/server/classroom-generation');
  const result = await generateClassroom(
    { requirement: 'Teach retry basics' },
    {
      baseUrl: 'http://localhost',
      onProgress: (event) => {
        progress.push({ message: event.message });
      },
    },
  );
  return { result, progress };
}

describe('classroom scene generation retries', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    sequence.length = 0;
    mocks.resolveModel.mockResolvedValue({
      model: { id: 'language-model' },
      modelInfo: {},
      modelString: 'test:model',
      providerId: 'test',
      apiKey: '',
    });
    mocks.isProviderKeyRequired.mockReturnValue(false);
    mocks.callLLM.mockResolvedValue({ text: 'ok' });
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: {
        languageDirective: 'Use English.',
        outlines: [outline],
      },
    });
    mocks.applyOutlineFallbacks.mockImplementation((value) => value);
    mocks.generateSceneContent.mockImplementation(contentForOutline);
    mocks.generateSceneActions.mockResolvedValue([]);
    mocks.prepareClassroomSpeechForTTS.mockImplementation(() => {
      sequence.push('prepare');
    });
    mocks.createClassroomContentCallbacks.mockReturnValue({ review: vi.fn(), repair: vi.fn() });
    mocks.reviewClassroomContent.mockImplementation(async ({ material }) => {
      sequence.push('review');
      return { material, proof: testProof };
    });
    mocks.generateTTSForClassroom.mockImplementation(async () => {
      sequence.push('tts');
      return {
        status: 'completed',
        ready: true,
        required: true,
        inputSpeechCount: 1,
        total: 1,
        succeeded: 1,
        failed: 0,
        failures: [],
      };
    });
    mocks.matchesClassroomContentProof.mockImplementation(() => {
      sequence.push('matches');
      return true;
    });
    mocks.generateMediaForClassroom.mockResolvedValue({});
    mocks.createSceneWithActions.mockImplementation((sceneOutline, content, actions, api) => {
      const sceneResult = api.scene.create({
        type: sceneOutline.type,
        title: sceneOutline.title,
        order: sceneOutline.order,
        content:
          sceneOutline.type === 'interactive'
            ? {
                type: 'interactive',
                html: content.html,
                url: '',
                widgetType: content.widgetType,
                widgetConfig: content.widgetConfig,
              }
            : sceneOutline.type === 'quiz'
              ? { type: 'quiz', questions: content.questions }
              : {
                  type: 'slide',
                  canvas: {
                    id: 'slide-1',
                    viewportSize: 1000,
                    viewportRatio: 0.5625,
                    elements: content.elements,
                  },
                },
        actions,
      });
      return sceneResult.success ? (sceneResult.data ?? null) : null;
    });
    mocks.persistClassroom.mockImplementation(async ({ id, stage, scenes }, _baseUrl, options) => {
      options?.validateBeforeWrite?.({ stage, scenes });
      sequence.push('persist');
      return {
        id,
        stage,
        scenes,
        url: `http://localhost/classroom/${id}`,
        scenesCount: scenes.length,
        createdAt: '2026-06-22T00:00:00.000Z',
      };
    });
  });

  it('retries an empty scene content result before skipping the scene', async () => {
    mocks.generateSceneContent.mockResolvedValueOnce(null).mockResolvedValueOnce(slideContent);

    const { result, progress } = await generateWithProgress();

    expect(result.scenesCount).toBe(1);
    expect(mocks.generateSceneContent).toHaveBeenCalledTimes(2);
    expect(progress.some((event) => event.message.includes('Retrying scene 1/1 content'))).toBe(
      true,
    );
  });

  it('forwards classroom thinking config to scene retry LLM calls', async () => {
    const thinkingConfig = { enabled: true, effort: 'high' };
    mocks.resolveModel.mockResolvedValue({
      model: { id: 'language-model' },
      modelInfo: {},
      modelString: 'test:model',
      providerId: 'test',
      apiKey: '',
      thinkingConfig,
    });
    mocks.generateSceneContent.mockImplementation(async (_outline, aiCall) => {
      await aiCall('system', 'user');
      return slideContent;
    });

    await generateWithProgress();

    expect(mocks.callLLM).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetries: 0 }),
      'generate-classroom-scene',
      undefined,
      thinkingConfig,
    );
  });

  it('retries retryable action generation errors', async () => {
    mocks.generateSceneContent.mockImplementation(contentForOutline);
    mocks.generateSceneActions
      .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { statusCode: 429 }))
      .mockResolvedValueOnce([]);

    const { result, progress } = await generateWithProgress();

    expect(result.scenesCount).toBe(1);
    expect(mocks.generateSceneActions).toHaveBeenCalledTimes(2);
    expect(progress.some((event) => event.message.includes('Retrying scene 1/1 actions'))).toBe(
      true,
    );
  });

  it('does not retry non-retryable action generation errors', async () => {
    const unauthorized = Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    mocks.generateSceneContent.mockImplementation(contentForOutline);
    mocks.generateSceneActions.mockRejectedValue(unauthorized);

    await expect(generateWithProgress()).rejects.toBe(unauthorized);

    expect(mocks.generateSceneActions).toHaveBeenCalledTimes(1);
  });

  it('converts only PBLGenerationError to a null scene result', async () => {
    const { containPBLGenerationError } = await import('@/lib/server/classroom-generation');

    expect(
      containPBLGenerationError(
        new PBLGenerationErrorMock('both planners failed'),
        'Failed PBL scene',
      ),
    ).toBeNull();

    const unrelated = new Error('unrelated failure');
    expect(() => containPBLGenerationError(unrelated, 'Other scene')).toThrow(unrelated);
  });

  it('does not retry a status-less PBL failure and completes surrounding slides', async () => {
    const outlines = [
      { ...outline, id: 'outline-slide-1', title: 'Opening slide', order: 0 },
      {
        ...outline,
        id: 'outline-pbl',
        type: 'pbl' as const,
        title: 'Practice project',
        order: 1,
        pblConfig: {
          projectTopic: 'Retries',
          projectDescription: 'Practice resilient generation',
          targetSkills: ['Retry handling'],
        },
      },
      { ...outline, id: 'outline-slide-2', title: 'Closing slide', order: 2 },
    ];
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'Use English.', outlines },
    });
    mocks.generateSceneContent.mockImplementation(async (sceneOutline) => {
      if (sceneOutline.type === 'pbl') {
        throw new PBLGenerationErrorMock('both planners failed');
      }
      return slideContent;
    });

    const { result } = await generateWithProgress();
    const pblCalls = mocks.generateSceneContent.mock.calls.filter(
      ([sceneOutline]) => sceneOutline.type === 'pbl',
    );

    expect(result.scenesCount).toBe(2);
    expect(result.scenes.map((scene) => scene.title)).toEqual(['Opening slide', 'Closing slide']);
    expect(pblCalls).toHaveLength(1);
  });

  it('does not retry a 401 PBL failure and completes surrounding slides', async () => {
    const outlines = [
      { ...outline, id: 'outline-slide-1', title: 'Opening slide', order: 0 },
      {
        ...outline,
        id: 'outline-pbl',
        type: 'pbl' as const,
        title: 'Practice project',
        order: 1,
        pblConfig: {
          projectTopic: 'Retries',
          projectDescription: 'Practice resilient generation',
          targetSkills: ['Retry handling'],
        },
      },
      { ...outline, id: 'outline-slide-2', title: 'Closing slide', order: 2 },
    ];
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'Use English.', outlines },
    });
    mocks.generateSceneContent.mockImplementation(async (sceneOutline) => {
      if (sceneOutline.type === 'pbl') {
        throw new PBLGenerationErrorMock('provider key rejected', { statusCode: 401 });
      }
      return slideContent;
    });

    const { result } = await generateWithProgress();
    const pblCalls = mocks.generateSceneContent.mock.calls.filter(
      ([sceneOutline]) => sceneOutline.type === 'pbl',
    );

    expect(result.scenesCount).toBe(2);
    expect(result.scenes.map((scene) => scene.title)).toEqual(['Opening slide', 'Closing slide']);
    expect(pblCalls).toHaveLength(1);
  });

  it('retries a 429 PBL failure before skipping it and completing surrounding slides', async () => {
    vi.useFakeTimers();
    try {
      const outlines = [
        { ...outline, id: 'outline-slide-1', title: 'Opening slide', order: 0 },
        {
          ...outline,
          id: 'outline-pbl',
          type: 'pbl' as const,
          title: 'Practice project',
          order: 1,
          pblConfig: {
            projectTopic: 'Retries',
            projectDescription: 'Practice resilient generation',
            targetSkills: ['Retry handling'],
          },
        },
        { ...outline, id: 'outline-slide-2', title: 'Closing slide', order: 2 },
      ];
      mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
        success: true,
        data: { languageDirective: 'Use English.', outlines },
      });
      mocks.generateSceneContent.mockImplementation(async (sceneOutline) => {
        if (sceneOutline.type === 'pbl') {
          throw new PBLGenerationErrorMock('provider rate limited', { statusCode: 429 });
        }
        return slideContent;
      });

      const generation = generateWithProgress();
      await vi.runAllTimersAsync();
      const { result } = await generation;
      const pblCalls = mocks.generateSceneContent.mock.calls.filter(
        ([sceneOutline]) => sceneOutline.type === 'pbl',
      );

      expect(result.scenesCount).toBe(2);
      expect(result.scenes.map((scene) => scene.title)).toEqual(['Opening slide', 'Closing slide']);
      expect(pblCalls).toHaveLength(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes the same complete source to every native scene content and action request', async () => {
    const requirement = '完整题面\r\n' + 'full context '.repeat(12000) + 'last-line  \r\n';
    const codemateSource = {
      title: 'Source-bound classroom',
      content: 'Every full statement line\r\n',
      code: 'cin >> row;  \r\n',
      correctedCode: 'cout << row;\r\n',
      language: 'cpp',
      analysis: { summary: 'Unverified hypothesis' },
      referenceValidation: {
        status: 'stored-passed' as const,
        scope: 'original_validation_run_current_suite_not_revalidated_for_classroom',
        codeHash: createHash('sha256').update('cout << row;\r\n').digest('hex'),
      },
    };
    const expected = { requirement, codeContextRequired: true, codemateSource };
    mocks.generateSceneContent.mockImplementation(contentForOutline);
    const { generateClassroom } = await import('@/lib/server/classroom-generation');
    await generateClassroom(expected, { baseUrl: 'http://localhost' });
    expect(mocks.generateSceneOutlinesFromRequirements).not.toHaveBeenCalled();
    expect(mocks.generateSceneContent).toHaveBeenCalledTimes(3);
    expect(mocks.generateSceneActions).toHaveBeenCalledTimes(3);
    const snapshot = mocks.generateSceneContent.mock.calls[0][2].userRequirements;
    for (const call of mocks.generateSceneContent.mock.calls)
      expect(call[2].userRequirements).toBe(snapshot);
    for (const call of mocks.generateSceneActions.mock.calls)
      expect(call[3].userRequirements).toBe(snapshot);
    expect(snapshot).toEqual(expected);
    expect(mocks.reviewClassroomContent.mock.calls[0][0].requirements).toBe(snapshot);
    expect(snapshot.codemateSource.code).toBe(codemateSource.code);
    expect(snapshot.requirement).toBe(requirement);
    expect(snapshot.codemateSource).not.toBe(codemateSource);
  });

  it('uses three server task shells without outline AI even when the original code equals its reference', async () => {
    mocks.generateSceneOutlinesFromRequirements.mockRejectedValue(
      new Error('outline AI must be skipped'),
    );
    const { result } = await generateRequiredWithProgress();
    expect(mocks.generateSceneOutlinesFromRequirements).not.toHaveBeenCalled();
    const plans = mocks.generateSceneContent.mock.calls.map(([plan]) => plan);
    expect(plans.map((plan) => plan.type)).toEqual(['slide', 'interactive', 'quiz']);
    expect(plans.map((plan) => plan.order)).toEqual([1, 2, 3]);
    expect(plans[0].title).toBe('源码分析与修复核对');
    expect(plans[1]).toMatchObject({
      widgetType: 'simulation',
      widgetOutline: { concept: '源码行为与修复核对' },
    });
    expect(plans[2].quizConfig).toEqual({
      questionCount: 2,
      difficulty: 'easy',
      questionTypes: ['single'],
    });
    const real =
      await vi.importActual<typeof import('@openmaic/generation')>('@openmaic/generation');
    expect(real.applyOutlineFallbacks(plans[1], true).type).toBe('interactive');
    expect(result.scenes.map((scene) => scene.type)).toEqual(['slide', 'interactive', 'quiz']);
    expect(result.stage.name).toBe(requiredInput().codemateSource.title);
    expect(result.stage.languageDirective).toContain('简体中文');
  });

  describe('correction language and quiz defaults reach actual generation prompts', () => {
    type SceneOutline = import('@openmaic/generation').SceneOutline;
    type PromptCall = { phase: 'content' | 'actions'; type: string; system: string; user: string };

    async function useActualSceneGenerators() {
      const actual =
        await vi.importActual<typeof import('@openmaic/generation')>('@openmaic/generation');
      const calls: PromptCall[] = [];
      const output = (plan: SceneOutline) => {
        if (plan.type === 'quiz') {
          return JSON.stringify([
            {
              type: 'single',
              question: 'Offline fixture question',
              options: ['First', 'Second'],
              correctAnswer: 'A',
              analysis: 'Offline fixture only',
            },
          ]);
        }
        if (plan.type === 'interactive') {
          return '<!DOCTYPE html><html><body><button id="reset">Reset fixture</button><script type="application/json" id="widget-config">{}</script></body></html>';
        }
        return JSON.stringify(slideContent);
      };
      mocks.generateSceneContent.mockImplementation((plan, aiCall, context) =>
        actual.generateSceneContent(
          plan,
          async (system, user, images) => {
            calls.push({ phase: 'content', type: plan.type, system, user });
            mocks.callLLM.mockResolvedValueOnce({ text: output(plan) });
            return aiCall(system, user, images);
          },
          context,
        ),
      );
      mocks.generateSceneActions.mockImplementation((plan, content, aiCall, context) =>
        actual.generateSceneActions(
          plan,
          content,
          async (system, user, images) => {
            calls.push({ phase: 'actions', type: plan.type, system, user });
            mocks.callLLM.mockResolvedValueOnce({
              text: '[{"type":"text","content":"Offline fixture speech; not language acceptance."}]',
            });
            return aiCall(system, user, images);
          },
          context,
        ),
      );
      return calls;
    }

    it('forwards the Chinese teaching contract and single-choice default without translating source bytes', async () => {
      const calls = await useActualSceneGenerators();
      const code = 'symbol = ">_<"  \r\nprint(symbol)\r\n';
      const source = {
        ...requiredInput().codemateSource,
        title: 'Literal preservation',
        content: 'Original statement quotation: Print >_< exactly.\r\nSample output:\r\n>_<\r\n',
        code,
        correctedCode: code,
        referenceValidation: {
          ...requiredInput().codemateSource.referenceValidation,
          codeHash: createHash('sha256').update(code).digest('hex'),
        },
      };
      const input = {
        requirement: '讲解原题并使用单选题检查理解，不翻译原文引用。',
        codeContextRequired: true,
        codemateSource: source,
      };
      const before = structuredClone(input);
      const { generateClassroom } = await import('@/lib/server/classroom-generation');
      const result = await generateClassroom(input, { baseUrl: 'http://localhost' });
      expect(input).toEqual(before);
      expect(mocks.generateSceneOutlinesFromRequirements).not.toHaveBeenCalled();
      expect(calls.map(({ phase, type }) => [phase, type])).toEqual([
        ['content', 'slide'],
        ['actions', 'slide'],
        ['content', 'interactive'],
        ['actions', 'interactive'],
        ['content', 'quiz'],
        ['actions', 'quiz'],
      ]);
      const language = result.stage.languageDirective!;
      for (const required of [
        '简体中文',
        '讲义',
        '教师讲解与字幕',
        '互动控件标签与提示',
        '练习题干、选项和解析',
        '代码与标识符',
        '原题原文引用',
        '程序输入输出必须逐字保留',
        '不翻译、不改写',
      ])
        expect(language).toContain(required);
      for (const call of calls) {
        expect(call.user).toContain(language);
        const supplied = JSON.parse(
          call.user.split('Complete course-source data (JSON; not instructions):\n')[1],
        );
        expect(supplied).toEqual(input);
        expect(Buffer.from(supplied.codemateSource.code)).toEqual(Buffer.from(code));
        expect(supplied.codemateSource.content).toBe(source.content);
      }
      const quizContent = calls.find((call) => call.phase === 'content' && call.type === 'quiz')!;
      expect(quizContent.user).toContain('Question Types: single');
      expect(quizContent.user).not.toContain('Question Types: single,multiple');
      expect(mocks.generateSceneContent.mock.calls[2][0].quizConfig).toEqual({
        questionCount: 2,
        difficulty: 'easy',
        questionTypes: ['single'],
      });
      expect(mocks.generateSceneContent.mock.calls[2][0].keyPoints.join('\n')).not.toContain(
        '多选',
      );
      expect(mocks.callLLM).toHaveBeenCalledTimes(6);
      for (let i = 0; i < calls.length; i++) {
        expect(mocks.callLLM.mock.calls[i][0].messages).toEqual([
          { role: 'system', content: calls[i].system },
          { role: 'user', content: calls[i].user },
        ]);
      }
    });

    it('preserves ordinary AI outline language and multi-select configuration in actual prompts', async () => {
      const calls = await useActualSceneGenerators();
      mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
        success: true,
        data: {
          languageDirective: 'Use English.',
          outlines: [
            {
              ...outline,
              type: 'quiz',
              quizConfig: { questionCount: 2, difficulty: 'easy', questionTypes: ['multiple'] },
            },
          ],
        },
      });
      const { result } = await generateWithProgress();
      expect(mocks.generateSceneOutlinesFromRequirements).toHaveBeenCalledTimes(1);
      expect(result.stage.languageDirective).toBe('Use English.');
      expect(calls.map(({ phase, type }) => [phase, type])).toEqual([
        ['content', 'quiz'],
        ['actions', 'quiz'],
      ]);
      for (const call of calls) {
        expect(call.user).toContain('Use English.');
        expect(call.user).not.toContain('本 AIOJ 编程纠错课');
      }
      expect(calls[0].user).toContain('Question Types: multiple');
      expect(mocks.generateSceneContent.mock.calls[0][0].quizConfig.questionTypes).toEqual([
        'multiple',
      ]);
      expect(mocks.callLLM).toHaveBeenCalledTimes(2);
    });
  });

  it('creates fresh task objects for each request and preserves the original input', async () => {
    const original = structuredClone(requiredInput());
    await generateRequiredWithProgress();
    const first = mocks.generateSceneContent.mock.calls[0][0];
    first.keyPoints.push('test-only mutation');
    await generateRequiredWithProgress();
    const second = mocks.generateSceneContent.mock.calls[3][0];
    expect(second).not.toBe(first);
    expect(second.keyPoints).not.toBe(first.keyPoints);
    expect(second.keyPoints).not.toContain('test-only mutation');
    expect(requiredInput()).toEqual(original);
  });

  it('keeps repeated shell outline IDs separate from real scene and classroom storage identities', async () => {
    const real = await vi.importActual<typeof import('@/lib/server/scene-generation')>(
      '@/lib/server/scene-generation',
    );
    mocks.createSceneWithActions.mockImplementation(real.createSceneWithActions);
    const first = (await generateRequiredWithProgress()).result;
    const second = (await generateRequiredWithProgress()).result;
    expect(first.id).not.toBe(second.id);
    expect(first.stage.id).not.toBe(second.stage.id);
    const outlineIds = [
      'correction-source-analysis',
      'correction-interactive-demo',
      'correction-understanding-check',
    ];
    expect(first.scenes.map((scene) => scene.outlineId)).toEqual(outlineIds);
    expect(second.scenes.map((scene) => scene.outlineId)).toEqual(outlineIds);
    const sceneIds = [...first.scenes, ...second.scenes].map((scene) => scene.id);
    expect(new Set(sceneIds).size).toBe(6);
    for (const scene of first.scenes) expect(scene.stageId).toBe(first.stage.id);
    for (const scene of second.scenes) expect(scene.stageId).toBe(second.stage.id);
    expect(sceneIds.some((id) => outlineIds.includes(id))).toBe(false);
    expect(mocks.persistClassroom).toHaveBeenCalledTimes(2);
    expect(mocks.persistClassroom.mock.calls.map(([data]) => data.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it('retains AI outlines for a source-bearing request with the trusted flag false', async () => {
    const { result } = await generateRequiredWithProgress({ codeContextRequired: false });
    expect(mocks.generateSceneOutlinesFromRequirements).toHaveBeenCalledTimes(1);
    expect(result.scenesCount).toBe(1);
    expect(mocks.reviewClassroomContent).not.toHaveBeenCalled();
    expect(mocks.generateTTSForClassroom).not.toHaveBeenCalled();
  });

  it('still stops before audio and persistence when the real TTS progress callback rejects', async () => {
    const stop = new Error('test-only static stop');
    const { generateClassroom } = await import('@/lib/server/classroom-generation');
    await expect(
      generateClassroom(requiredInput(), {
        baseUrl: 'http://localhost',
        onProgress: (event) => {
          if (event.step === 'generating_tts') throw stop;
        },
      }),
    ).rejects.toBe(stop);
    expect(mocks.reviewClassroomContent).toHaveBeenCalledTimes(1);
    expect(mocks.generateTTSForClassroom).not.toHaveBeenCalled();
    expect(mocks.persistClassroom).not.toHaveBeenCalled();
  });

  it('rejects missing explicitly required source before resolving or calling a model', async () => {
    const { generateClassroom } = await import('@/lib/server/classroom-generation');
    await expect(
      generateClassroom(
        { requirement: 'request', codeContextRequired: true },
        { baseUrl: 'http://localhost' },
      ),
    ).rejects.toThrow('source context');
    expect(mocks.resolveModel).not.toHaveBeenCalled();
    expect(mocks.callLLM).not.toHaveBeenCalled();
    expect(mocks.persistClassroom).not.toHaveBeenCalled();
  });

  it('orders required speech preparation, content review, required TTS, final binding and persistence', async () => {
    mocks.generateSceneContent.mockImplementation(contentForOutline);
    const controller = new AbortController();
    const { result, progress } = await generateRequiredWithProgress(
      { enableTTS: true },
      controller.signal,
    );

    expect(sequence).toEqual([
      'prepare',
      'review',
      'tts',
      'matches',
      'matches',
      'persist',
      'matches',
    ]);
    expect(progress.at(-1)?.step).toBe('completed');
    expect(result.scenesCount).toBe(3);
    expect(mocks.reviewClassroomContent).toHaveBeenCalledTimes(1);
    const request = mocks.reviewClassroomContent.mock.calls[0][0];
    expect(request.requirements.codeContextRequired).toBe(true);
    expect(request.requirements.codemateSource).toEqual(requiredInput().codemateSource);
    expect(request.expectedSceneCount).toBe(3);
    expect(request.callbacks).toBe(mocks.createClassroomContentCallbacks.mock.results[0].value);
    expect(request.material.scenes).toHaveLength(3);
    expect(mocks.prepareClassroomSpeechForTTS.mock.calls[0][0]).toBe(request.material.scenes);
    const [ttsScenes, ttsStageId, baseUrl, ttsOptions] =
      mocks.generateTTSForClassroom.mock.calls[0];
    expect(ttsScenes).toBe(request.material.scenes);
    expect(ttsStageId).toBe(request.material.stage.id);
    expect(baseUrl).toBe('http://localhost');
    expect(ttsOptions).toMatchObject({ required: true });
    expect(ttsOptions.signal).toBeInstanceOf(AbortSignal);
    expect(ttsOptions.signal.aborted).toBe(false);
    expect(mocks.matchesClassroomContentProof).toHaveBeenCalledWith(
      request.requirements,
      request.material,
      testProof,
    );
    expect(mocks.matchesClassroomContentProof).toHaveBeenCalledTimes(3);
    expect(mocks.persistClassroom.mock.calls[0][0]).toMatchObject({
      stage: request.material.stage,
      scenes: request.material.scenes,
    });
  });

  it('still requires final review and complete speech audio when a code-bound caller sets enableTTS false', async () => {
    mocks.generateSceneContent.mockImplementation(contentForOutline);
    await generateRequiredWithProgress({ enableTTS: false });
    expect(sequence).toEqual([
      'prepare',
      'review',
      'tts',
      'matches',
      'matches',
      'persist',
      'matches',
    ]);
    expect(mocks.generateTTSForClassroom.mock.calls[0][3]).toMatchObject({ required: true });
  });

  it('synthesizes and persists the helper-returned reviewed material instead of the old store objects', async () => {
    mocks.generateSceneContent.mockImplementation(contentForOutline);
    let reviewedMaterial: { stage: unknown; scenes: Array<{ title: string }> } | undefined;
    mocks.reviewClassroomContent.mockImplementation(async ({ material }) => {
      sequence.push('review');
      reviewedMaterial = structuredClone(material);
      reviewedMaterial!.scenes[0].title = 'Reviewed final title';
      return { material: reviewedMaterial, proof: testProof };
    });
    const { result } = await generateRequiredWithProgress();
    expect(result.scenes[0].title).toBe('Reviewed final title');
    expect(mocks.generateTTSForClassroom.mock.calls[0][0]).toBe(reviewedMaterial!.scenes);
    expect(mocks.persistClassroom.mock.calls[0][0].scenes).toBe(reviewedMaterial!.scenes);
    expect(mocks.persistClassroom.mock.calls[0][0].stage).toBe(reviewedMaterial!.stage);
    expect(mocks.matchesClassroomContentProof.mock.calls[0][1]).toEqual(reviewedMaterial);
  });

  it('does not synthesize, persist or report completed after content review rejects', async () => {
    mocks.generateSceneContent.mockImplementation(contentForOutline);
    const { ClassroomContentReviewError } = await import('@/lib/server/classroom-content-review');
    const failure = new ClassroomContentReviewError('requires_regeneration');
    mocks.reviewClassroomContent.mockImplementation(async () => {
      sequence.push('review');
      throw failure;
    });
    const steps: string[] = [];
    const { generateClassroom } = await import('@/lib/server/classroom-generation');
    await expect(
      generateClassroom(requiredInput(), {
        baseUrl: 'http://localhost',
        onProgress: (event) => {
          steps.push(event.step);
        },
      }),
    ).rejects.toBe(failure);
    expect(sequence).toEqual(['prepare', 'review']);
    expect(mocks.generateTTSForClassroom).not.toHaveBeenCalled();
    expect(mocks.matchesClassroomContentProof).not.toHaveBeenCalled();
    expect(mocks.persistClassroom).not.toHaveBeenCalled();
    expect(steps).not.toContain('completed');
  });

  it('does not persist or report completed after required speech synthesis fails', async () => {
    mocks.generateSceneContent.mockImplementation(contentForOutline);
    const failure = new Error('required speech unavailable');
    mocks.generateTTSForClassroom.mockImplementation(async () => {
      sequence.push('tts');
      throw failure;
    });
    const steps: string[] = [];
    const { generateClassroom } = await import('@/lib/server/classroom-generation');
    await expect(
      generateClassroom(requiredInput(), {
        baseUrl: 'http://localhost',
        onProgress: (event) => {
          steps.push(event.step);
        },
      }),
    ).rejects.toBe(failure);
    expect(sequence).toEqual(['prepare', 'review', 'tts']);
    expect(mocks.matchesClassroomContentProof).not.toHaveBeenCalled();
    expect(mocks.persistClassroom).not.toHaveBeenCalled();
    expect(steps).not.toContain('completed');
  });

  it('does not persist or report completed when the post-TTS material no longer matches reviewed bytes', async () => {
    mocks.generateSceneContent.mockImplementation(contentForOutline);
    mocks.matchesClassroomContentProof.mockImplementation(() => {
      sequence.push('matches');
      return false;
    });
    const steps: string[] = [];
    const { generateClassroom } = await import('@/lib/server/classroom-generation');
    await expect(
      generateClassroom(requiredInput(), {
        baseUrl: 'http://localhost',
        onProgress: (event) => {
          steps.push(event.step);
        },
      }),
    ).rejects.toMatchObject({ code: 'binding_mismatch' });
    expect(sequence).toEqual(['prepare', 'review', 'tts', 'matches']);
    expect(mocks.persistClassroom).not.toHaveBeenCalled();
    expect(steps).not.toContain('completed');
  });

  it('rejects a code-bound classroom with one planned scene missing before terminal review, synthesis or persistence', async () => {
    mocks.generateSceneContent.mockImplementation(contentForOutline);
    const create = mocks.createSceneWithActions.getMockImplementation()!;
    mocks.createSceneWithActions.mockImplementationOnce(create).mockReturnValueOnce(null);
    const steps: string[] = [];
    const { generateClassroom } = await import('@/lib/server/classroom-generation');
    await expect(
      generateClassroom(requiredInput(), {
        baseUrl: 'http://localhost',
        onProgress: (event) => {
          steps.push(event.step);
        },
      }),
    ).rejects.toThrow();
    expect(mocks.createSceneWithActions).toHaveBeenCalledTimes(3);
    expect(mocks.prepareClassroomSpeechForTTS).not.toHaveBeenCalled();
    expect(mocks.reviewClassroomContent).not.toHaveBeenCalled();
    expect(mocks.generateTTSForClassroom).not.toHaveBeenCalled();
    expect(mocks.persistClassroom).not.toHaveBeenCalled();
    expect(steps).not.toContain('completed');
  });

  it('does no provider resolution, model work, speech work or writes for an already aborted job', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(generateRequiredWithProgress({}, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    for (const mock of [
      mocks.resolveModel,
      mocks.isProviderKeyRequired,
      mocks.callLLM,
      mocks.generateSceneOutlinesFromRequirements,
      mocks.generateSceneContent,
      mocks.generateSceneActions,
      mocks.createSceneWithActions,
      mocks.prepareClassroomSpeechForTTS,
      mocks.reviewClassroomContent,
      mocks.generateTTSForClassroom,
      mocks.generateMediaForClassroom,
      mocks.persistClassroom,
    ]) {
      expect(mock).not.toHaveBeenCalled();
    }
  });

  it('threads cancellation and zero SDK retries into all called native LLM closures and one outer scene retry', async () => {
    const controller = new AbortController();
    mocks.generateSceneOutlinesFromRequirements.mockRejectedValue(
      new Error('outline AI must be skipped'),
    );
    mocks.generateSceneContent.mockImplementation(async (sceneOutline, aiCall) => {
      await aiCall('content system', 'content user');
      return contentForOutline(sceneOutline);
    });
    mocks.generateSceneActions.mockImplementation(async (_outline, _content, aiCall) => {
      await aiCall('actions system', 'actions user');
      return [];
    });
    mocks.createClassroomContentCallbacks.mockImplementation((aiCall) => ({
      review: async () => {
        await aiCall('review system', 'review user');
      },
      repair: vi.fn(),
    }));
    mocks.reviewClassroomContent.mockImplementation(async ({ material, callbacks }) => {
      sequence.push('review');
      await callbacks.review();
      return { material, proof: testProof };
    });
    await generateRequiredWithProgress({}, controller.signal);
    expect(mocks.callLLM).toHaveBeenCalledTimes(7);
    for (const [parameters] of mocks.callLLM.mock.calls) {
      expect(parameters.maxRetries).toBe(0);
      expect(parameters.abortSignal).toBeInstanceOf(AbortSignal);
      expect(parameters.abortSignal.aborted).toBe(false);
    }
    expect(mocks.generateSceneOutlinesFromRequirements).not.toHaveBeenCalled();
    const retryOptions = mocks.retryOptions.mock.calls.map(([options]) => options);
    expect(retryOptions).toHaveLength(6);
    expect(retryOptions.map((options) => options.label)).toEqual([
      'scene 1/3 content',
      'scene 1/3 actions',
      'scene 2/3 content',
      'scene 2/3 actions',
      'scene 3/3 content',
      'scene 3/3 actions',
    ]);
    for (const options of retryOptions) {
      expect(options.maxRetries).toBe(1);
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('propagates caller cancellation during a scene call and stops later review, audio and writes', async () => {
    const controller = new AbortController();
    mocks.generateSceneContent.mockImplementation(async (_outline, aiCall) => {
      mocks.callLLM.mockImplementationOnce(async (parameters) => {
        controller.abort();
        expect(parameters.abortSignal.aborted).toBe(true);
        throw new DOMException('Aborted', 'AbortError');
      });
      await aiCall('content system', 'content user');
      return slideContent;
    });
    await expect(generateRequiredWithProgress({}, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
    expect(mocks.generateSceneContent).toHaveBeenCalledTimes(1);
    expect(mocks.generateSceneActions).not.toHaveBeenCalled();
    expect(mocks.reviewClassroomContent).not.toHaveBeenCalled();
    expect(mocks.generateTTSForClassroom).not.toHaveBeenCalled();
    expect(mocks.persistClassroom).not.toHaveBeenCalled();
  });

  it('caps a required scene at two total attempts using the real retry helper', async () => {
    vi.useFakeTimers();
    try {
      const failure = Object.assign(new Error('rate limited'), { statusCode: 429 });
      mocks.generateSceneContent.mockRejectedValue(failure);
      const rejected = expect(generateRequiredWithProgress()).rejects.toBe(failure);
      await vi.runAllTimersAsync();
      await rejected;
      expect(mocks.generateSceneContent).toHaveBeenCalledTimes(2);
      expect(mocks.generateSceneActions).not.toHaveBeenCalled();
      expect(mocks.reviewClassroomContent).not.toHaveBeenCalled();
      expect(mocks.generateTTSForClassroom).not.toHaveBeenCalled();
      expect(mocks.persistClassroom).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps optional ordinary classrooms compatible with disabled content review and TTS', async () => {
    mocks.generateSceneContent.mockImplementation(contentForOutline);
    await generateWithProgress();
    expect(mocks.reviewClassroomContent).not.toHaveBeenCalled();
    expect(mocks.prepareClassroomSpeechForTTS).not.toHaveBeenCalled();
    expect(mocks.generateTTSForClassroom).not.toHaveBeenCalled();
    expect(mocks.persistClassroom).toHaveBeenCalledTimes(1);
  });

  it('uses the dedicated structured hook only for complete review and repair, retaining raw result.text', async () => {
    const model = { id: 'language-model' };
    const thinking = { enabled: true, effort: 'high' as const };
    mocks.resolveModel.mockResolvedValue({
      model,
      modelInfo: { outputWindow: 4096 },
      modelString: 'test:model',
      providerId: 'test',
      apiKey: '',
      thinkingConfig: thinking,
    });
    const raw = ' \n{"transport":"raw text, not a factual pass"}\n ';
    mocks.callLLM.mockResolvedValue({ text: raw, output: { normalized: 'must not be returned' } });
    mocks.generateSceneOutlinesFromRequirements.mockRejectedValue(
      new Error('outline AI must be skipped'),
    );
    mocks.generateSceneContent.mockImplementation(async (sceneOutline, aiCall) => {
      if (sceneOutline.type === 'slide')
        expect(await aiCall('ordinary-system', 'ordinary-user')).toBe(raw);
      return contentForOutline(sceneOutline);
    });
    const definition = {
      type: 'object' as const,
      properties: { transport: { type: 'string' as const } },
      required: ['transport'],
      additionalProperties: false,
    };
    const schema = jsonSchema(definition, {
      validate: (value) =>
        value &&
        typeof value === 'object' &&
        'transport' in value &&
        typeof value.transport === 'string'
          ? { success: true, value }
          : { success: false, error: new Error('Offline wiring fixture mismatch') },
    });
    mocks.createClassroomContentCallbacks.mockImplementation((_aiCall, options) => {
      expect(typeof options.structuredCall).toBe('function');
      return {
        review: () =>
          options.structuredCall('complete-review-system', 'complete-review-user', schema),
        repair: () =>
          options.structuredCall('complete-repair-system', 'complete-repair-user', schema),
      };
    });
    // Pipeline wiring only: the real helper's strict validation has its own tests.
    mocks.reviewClassroomContent.mockImplementation(async ({ material, callbacks }) => {
      expect(await callbacks.review()).toBe(raw);
      expect(await callbacks.repair()).toBe(raw);
      return { material, proof: testProof };
    });
    await generateRequiredWithProgress();
    expect(mocks.callLLM).toHaveBeenCalledTimes(3);
    const [ordinary, review, repair] = mocks.callLLM.mock.calls;
    expect(ordinary[0]).not.toHaveProperty('output');
    expect(await review[0].output.responseFormat).toEqual({
      type: 'json',
      schema: definition,
      name: 'classroom_content_response',
    });
    expect(await repair[0].output.responseFormat).toEqual({
      type: 'json',
      schema: definition,
      name: 'classroom_content_response',
    });
    for (const [index, [parameters, source, retry, actualThinking]] of [
      ordinary,
      review,
      repair,
    ].entries()) {
      expect(parameters.model).toBe(model);
      expect(parameters.maxOutputTokens).toBe(4096);
      expect(parameters.maxRetries).toBe(0);
      expect(parameters.abortSignal).toBeInstanceOf(AbortSignal);
      expect(source).toBe(index === 0 ? 'generate-classroom-scene' : 'generate-classroom');
      expect(retry).toBeUndefined();
      expect(actualThinking).toBe(thinking);
    }
  });

  for (const [delay, shouldComplete] of [
    [100000, true],
    [150000, false],
  ] as const) {
    it(`uses a separate bounded full-material review and rejects a late result (${delay}ms)`, async () => {
      vi.useFakeTimers();
      const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
        const controller = new AbortController();
        setTimeout(
          () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
          milliseconds,
        );
        return controller.signal;
      });
      try {
        mocks.generateSceneContent.mockImplementation(contentForOutline);
        mocks.createClassroomContentCallbacks.mockImplementation((aiCall) => ({
          review: () => aiCall('complete-content-review', 'complete-material'),
          repair: vi.fn(),
        }));
        mocks.reviewClassroomContent.mockImplementation(async ({ material, callbacks }) => {
          await callbacks.review();
          return { material, proof: testProof };
        });
        let providerSignal: AbortSignal | undefined;
        mocks.callLLM.mockImplementationOnce(async (parameters) => {
          providerSignal = parameters.abortSignal;
          // Deliberately ignore cancellation to test the caller's late-result gate.
          await new Promise((resolve) => setTimeout(resolve, delay));
          return { text: 'test-only review response' };
        });
        const operation = generateRequiredWithProgress();
        const outcome = shouldComplete
          ? expect(operation).resolves.toHaveProperty('result.id')
          : expect(operation).rejects.toMatchObject({ name: 'TimeoutError' });
        await vi.advanceTimersByTimeAsync(75001);
        expect(providerSignal).toBeInstanceOf(AbortSignal);
        expect(providerSignal!.aborted).toBe(false);
        expect(mocks.generateTTSForClassroom).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(delay - 75001);
        await outcome;
        expect(mocks.callLLM).toHaveBeenCalledTimes(1);
        const [parameters] = mocks.callLLM.mock.calls[0];
        expect(parameters.maxRetries).toBe(0);
        expect(mocks.generateTTSForClassroom).toHaveBeenCalledTimes(shouldComplete ? 1 : 0);
        expect(mocks.persistClassroom).toHaveBeenCalledTimes(shouldComplete ? 1 : 0);
        if (!shouldComplete) expect(providerSignal!.aborted).toBe(true);
      } finally {
        timeout.mockRestore();
        vi.useRealTimers();
      }
    });
  }

  describe('code-bound scene thinking defaults', () => {
    const flash = { provider: 'openai.chat', modelId: 'deepseek-ai/DeepSeek-V4-Flash' };
    type Thinking = import('@/lib/types/provider').ThinkingConfig;
    const resolved = (thinkingConfig?: Thinking, model = flash) => ({
      model,
      modelInfo: {},
      modelString: 'offline:flash',
      providerId: 'offline',
      apiKey: '',
      thinkingConfig,
    });
    function probeSceneCalls() {
      mocks.generateSceneContent.mockImplementation(async (sceneOutline, aiCall, context) => {
        await aiCall(
          'content-system',
          'content:' + sceneOutline.type + JSON.stringify(context.userRequirements),
        );
        return contentForOutline(sceneOutline);
      });
      mocks.generateSceneActions.mockImplementation(
        async (sceneOutline, _content, aiCall, context) => {
          await aiCall(
            'actions-system',
            'actions:' + sceneOutline.type + JSON.stringify(context.userRequirements),
          );
          return [];
        },
      );
    }
    const sceneCalls = () =>
      mocks.callLLM.mock.calls.filter((call) => call[1] === 'generate-classroom-scene');
    beforeEach(() => {
      vi.stubEnv('LLM_THINKING_DISABLED', 'false');
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    it('defaults only required content/actions to disabled while preserving complete source and review high4096', async () => {
      mocks.resolveModel.mockResolvedValue(resolved());
      probeSceneCalls();
      mocks.createClassroomContentCallbacks.mockImplementation((aiCall) => ({
        review: () => aiCall('review-system', 'review-user'),
      }));
      mocks.reviewClassroomContent.mockImplementation(async ({ material, callbacks }) => {
        await callbacks.review();
        return { material, proof: testProof };
      });
      await generateRequiredWithProgress();
      expect(sceneCalls()).toHaveLength(6);
      for (const [params, , retry, thinking] of sceneCalls()) {
        expect(thinking).toEqual({ mode: 'disabled', enabled: false });
        expect(params.model).toBe(flash);
        expect(params.maxRetries).toBe(0);
        expect(params.maxOutputTokens).toBeUndefined();
        expect(params.output).toBeUndefined();
        expect(retry).toBeUndefined();
        const message = params.messages[1].content as string;
        const supplied = JSON.parse(message.slice(message.indexOf('{')));
        expect(supplied.codemateSource).toEqual(requiredInput().codemateSource);
      }
      const review = mocks.callLLM.mock.calls.find((call) => call[1] === 'generate-classroom')!;
      expect(review[0].maxOutputTokens).toBe(4096);
      expect(review[3]).toEqual({
        mode: 'enabled',
        enabled: true,
        effort: 'high',
        compatRequestScope: 'classroom-content-review',
      });
      expect(mocks.reviewClassroomContent.mock.calls[0][0].requirements).toEqual(requiredInput());
      expect(mocks.retryOptions.mock.calls.every(([options]) => options.maxRetries === 1)).toBe(
        true,
      );
    });
    for (const thinking of [
      {},
      { mode: 'enabled', enabled: true, effort: 'high' },
      { mode: 'disabled', enabled: false },
      { mode: 'auto' },
    ] as Thinking[]) {
      it(
        'preserves an explicit classroom setting by identity: ' + JSON.stringify(thinking),
        async () => {
          vi.stubEnv('LLM_THINKING_DISABLED', 'true');
          mocks.resolveModel.mockResolvedValue(resolved(thinking));
          probeSceneCalls();
          const llm = await import('@/lib/ai/llm');
          const global = vi.spyOn(llm, 'getGlobalThinkingConfig');
          await generateRequiredWithProgress();
          expect(sceneCalls()).toHaveLength(6);
          expect(sceneCalls().every((call) => call[3] === thinking)).toBe(true);
          expect(global).not.toHaveBeenCalled();
        },
      );
    }
    it('uses the shared global getter, including future values, ahead of the new default', async () => {
      mocks.resolveModel.mockResolvedValue(resolved());
      probeSceneCalls();
      const globalThinking: Thinking = { mode: 'enabled', enabled: true, effort: 'max' };
      const llm = await import('@/lib/ai/llm');
      const global = vi.spyOn(llm, 'getGlobalThinkingConfig').mockReturnValue(globalThinking);
      await generateRequiredWithProgress();
      expect(sceneCalls().every((call) => call[3] === globalThinking)).toBe(true);
      expect(global).toHaveBeenCalledTimes(6);
    });
    it('preserves the actual global disabled parser rather than copying its environment logic', async () => {
      vi.stubEnv('LLM_THINKING_DISABLED', 'true');
      mocks.resolveModel.mockResolvedValue(resolved());
      probeSceneCalls();
      const llm = await import('@/lib/ai/llm');
      const global = vi.spyOn(llm, 'getGlobalThinkingConfig');
      await generateRequiredWithProgress();
      expect(global).toHaveBeenCalledTimes(6);
      expect(
        sceneCalls().every((call) => call[3]?.mode === 'disabled' && call[3]?.enabled === false),
      ).toBe(true);
    });
    it('preserves explicit per-type/action routes ahead of classroom and global defaults', async () => {
      vi.stubEnv('LLM_THINKING_DISABLED', 'true');
      const settings: Record<string, Thinking> = {
        'scene-content:slide': {},
        'scene-content:interactive': { mode: 'auto' },
        'scene-content:quiz': { mode: 'enabled', effort: 'high' },
        'scene-actions': { mode: 'disabled', enabled: false },
      };
      const routes = await import('@/lib/server/model-routes');
      vi.spyOn(routes, 'getStageModel').mockImplementation((stage) =>
        stage && stage in settings ? 'offline:flash' : undefined,
      );
      mocks.resolveModel.mockImplementation(async ({ stage }) => resolved(settings[stage]));
      probeSceneCalls();
      await generateRequiredWithProgress();
      const expected = [
        settings['scene-content:slide'],
        settings['scene-actions'],
        settings['scene-content:interactive'],
        settings['scene-actions'],
        settings['scene-content:quiz'],
        settings['scene-actions'],
      ];
      expect(sceneCalls().map((call) => call[3])).toEqual(expected);
      sceneCalls().forEach((call, index) => expect(call[3]).toBe(expected[index]));
    });
    it('keeps ordinary forwarded parameters exactly unchanged and does not pre-resolve its global fallback', async () => {
      vi.stubEnv('LLM_THINKING_DISABLED', 'true');
      mocks.resolveModel.mockResolvedValue(resolved());
      probeSceneCalls();
      await generateWithProgress();
      expect(sceneCalls()).toHaveLength(2);
      const source = JSON.stringify({ requirement: 'Teach retry basics' });
      const expectedMessages = [
        [
          { role: 'system', content: 'content-system' },
          { role: 'user', content: 'content:slide' + source },
        ],
        [
          { role: 'system', content: 'actions-system' },
          { role: 'user', content: 'actions:slide' + source },
        ],
      ];
      sceneCalls().forEach(([params, source, retry, thinking], index) => {
        const { abortSignal, ...rest } = params;
        expect(rest).toEqual({
          model: flash,
          messages: expectedMessages[index],
          maxOutputTokens: undefined,
          maxRetries: 0,
        });
        expect(abortSignal.aborted).toBe(false);
        expect(source).toBe('generate-classroom-scene');
        expect(retry).toBeUndefined();
        expect(thinking).toBeUndefined();
      });
      expect(mocks.reviewClassroomContent).not.toHaveBeenCalled();
    });
    for (const model of [
      { provider: 'openai.chat', modelId: 'other-custom-model' },
      { provider: 'anthropic.messages', modelId: flash.modelId },
    ]) {
      it(
        'does not select a new default for another actual SDK model: ' + JSON.stringify(model),
        async () => {
          mocks.resolveModel.mockResolvedValue(resolved(undefined, model));
          probeSceneCalls();
          await generateRequiredWithProgress();
          expect(
            sceneCalls().every((call) => call[0].model === model && call[3] === undefined),
          ).toBe(true);
        },
      );
    }
  });
});
