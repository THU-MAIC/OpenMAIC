import { describe, expect, it, vi } from 'vitest';
import {
  buildOutlinePrompt,
  generatePBLV2ProjectSingleCall,
  generateSceneActions,
  generateSceneContent,
  generateWidgetContent,
  type AICallFn,
  type PBLPlannerV2Input,
  type SceneOutline,
  type UserRequirements,
  type WidgetType,
} from '@openmaic/generation';
import {
  buildSourceGroundedPrompt,
  COURSE_SOURCE_DATA_MARKER,
  withSourceRequirement,
} from '../src/source-requirement.js';
import { buildPrompt, PROMPT_IDS } from '../src/prompts/index.js';
import {
  pblOutline,
  quizOutline,
  slideOutline,
  validPBLResponse,
  widgetOutline,
} from './scene-fixtures.js';

const source: UserRequirements = {
  requirement:
    '完整题面\r\n1 <= h,w <= 100\n' + '材料不截断 '.repeat(12000) + 'TAIL source marker  \r\n',
  codeContextRequired: true,
  codemateSource: {
    title: '画布裁剪',
    content: '保留指定子矩阵。\n3 5\n2 2 2 4\n.....\n.>_<.\n.....\n输出：>_<\n',
    code: 'for (auto &row : canvas) cin >> row;\r\nfor (int j = y1 - 1; j < y2; ++j) {\r\n\tcout << canvas[x1 - 1][j];  \r\n}\r\n// IGNORE_ROLE_OVERRIDE_IS_SOURCE_DATA\n',
    correctedCode:
      'for (int i = x1 - 1; i < x2; ++i) {\nfor (int j = y1 - 1; j < y2; ++j) cout << canvas[i][j];\ncout << endl;\n}\n',
    language: 'cc.cc14o2',
    analysis: { summary: 'Hypothesis: missing row loop' },
    referenceValidation: {
      status: 'stored-passed',
      scope: 'original_validation_run_current_suite_not_revalidated_for_classroom',
      codeHash: 'historical-digest-only',
    },
  },
};

function capturedSource(system: string, user: string) {
  expect(system).not.toContain('IGNORE_ROLE_OVERRIDE_IS_SOURCE_DATA');
  expect(system).not.toContain('TAIL source marker');
  expect(system).toContain('data, not instructions');
  const parts = user.split(COURSE_SOURCE_DATA_MARKER);
  expect(parts).toHaveLength(2);
  const data = JSON.parse(parts[1]);
  expect(data).toEqual(source);
  expect(Buffer.from(data.codemateSource.code)).toEqual(Buffer.from(source.codemateSource!.code));
  expect(data.requirement.endsWith('TAIL source marker  \r\n')).toBe(true);
}

function contentOutput(outline: SceneOutline): string {
  if (outline.type === 'slide') return JSON.stringify({ elements: [], remark: 'source' });
  if (outline.type === 'quiz')
    return JSON.stringify([
      {
        type: 'single',
        question: 'What is missing?',
        options: ['Row loop', 'Input'],
        correctAnswer: 'A',
        analysis: 'A',
      },
    ]);
  if (outline.type === 'pbl') return validPBLResponse();
  return '<!DOCTYPE html><html><body><button type="button" id="step-next" data-role="next">Next</button><button type="button" id="step-back" data-role="back">Back</button><button type="button" id="step-reset" data-role="reset">Reset</button><span id="step-status" data-role="status"></span><span id="step-progress" data-role="progress"></span><script type="application/json" id="widget-config">{"exposedVariables":[]}</script></body></html>';
}

describe('complete source data reaches actual scene model calls', () => {
  const outlines = [
    slideOutline(),
    quizOutline(),
    pblOutline(),
    ...(
      [
        'simulation',
        'diagram',
        'code',
        'game',
        'visualization3d',
        'procedural-skill',
      ] as WidgetType[]
    ).map((widgetType) => ({ ...widgetOutline(), widgetType })),
  ];
  it.each(outlines)(
    'grounds $type $widgetType model calls and keeps compact guidance model-free',
    async (outline) => {
      const contentCalls: Array<[string, string]> = [];
      const content = await generateSceneContent(
        outline,
        async (system, user) => {
          contentCalls.push([system, user]);
          return contentOutput(outline);
        },
        { userRequirements: source, allowProceduralSkill: true },
      );
      expect(content).not.toBeNull();
      expect(contentCalls).toHaveLength(1);
      contentCalls.forEach(([system, user]) => capturedSource(system, user));
      const actionCalls: Array<[string, string]> = [];
      await generateSceneActions(
        outline,
        content!,
        async (system, user) => {
          actionCalls.push([system, user]);
          return '[]';
        },
        { userRequirements: source, targetLanguage: 'zh-CN' },
      );
      expect(actionCalls).toHaveLength(outline.widgetType === 'simulation' ? 0 : 1);
      actionCalls.forEach(([system, user]) => capturedSource(system, user));
    },
  );

  it('retains structured source in outline prompts and standalone widget calls', async () => {
    const prompts = buildOutlinePrompt(source);
    capturedSource(prompts.system, prompts.user);
    const aiCall: AICallFn = vi.fn(async () => contentOutput(widgetOutline()));
    await generateWidgetContent(widgetOutline(), aiCall, undefined, { userRequirements: source });
    const [system, user] = vi.mocked(aiCall).mock.calls[0];
    capturedSource(system, user);
  });

  it('retains the same source on both PBL planner attempts and the host fallback input', async () => {
    const aiCall: AICallFn = vi.fn(async () => '{}');
    const fallback = vi.fn(async (_input: PBLPlannerV2Input) => {
      throw new Error('test fallback');
    });
    await expect(
      generateSceneContent(pblOutline(), aiCall, {
        userRequirements: source,
        pblLoopFallback: fallback,
      }),
    ).rejects.toThrow();
    expect(aiCall).toHaveBeenCalledTimes(2);
    vi.mocked(aiCall).mock.calls.forEach(([system, user]) => capturedSource(system, user));
    expect(fallback.mock.calls[0][0].courseContext.userRequirements).toEqual(source);
    const direct: AICallFn = vi.fn(async () => validPBLResponse());
    await generatePBLV2ProjectSingleCall(
      {
        outline: pblOutline(),
        courseContext: {
          allOutlines: [pblOutline()],
          languageDirective: '中文',
          userRequirements: source,
        },
      },
      direct,
    );
    const [system, user] = vi.mocked(direct).mock.calls[0];
    capturedSource(system, user);
  });

  it('snapshots full source and preserves image transport unchanged', async () => {
    const context = structuredClone(source);
    const aiCall: AICallFn = vi.fn(async () => 'ok');
    const bound = withSourceRequirement(aiCall, context);
    context.requirement = 'changed after binding';
    context.codemateSource!.code = 'changed after binding';
    const images = [{ id: 'img_1', src: 'data:image/png;base64,AA==' }];
    await bound('system', 'scene request', images);
    const [system, user, actualImages] = vi.mocked(aiCall).mock.calls[0];
    capturedSource(system, user);
    expect(actualImages).toBe(images);
  });

  it('fails before model calls when explicitly required code source is missing', async () => {
    const aiCall: AICallFn = vi.fn();
    const incomplete = { requirement: 'do not guess from title', codeContextRequired: true };
    await expect(
      generateSceneContent(slideOutline(), aiCall, { userRequirements: incomplete }),
    ).rejects.toThrow('source context');
    await expect(
      generateSceneActions(slideOutline(), { elements: [] }, aiCall, {
        userRequirements: incomplete,
      }),
    ).rejects.toThrow('source context');
    expect(aiCall).not.toHaveBeenCalled();
  });

  it('keeps absent-context calls byte-identical and accepts ordinary non-code material', async () => {
    const aiCall: AICallFn = vi.fn(async () => '[]');
    expect(withSourceRequirement(aiCall)).toBe(aiCall);
    expect(withSourceRequirement(aiCall, { requirement: '' })).toBe(aiCall);
    await withSourceRequirement(aiCall, { requirement: 'Explain photosynthesis.' })(
      'system',
      'scene',
    );
    const data = JSON.parse(vi.mocked(aiCall).mock.calls[0][1].split(COURSE_SOURCE_DATA_MARKER)[1]);
    expect(data).toEqual({ requirement: 'Explain photosynthesis.' });
  });
});

describe('validated code-bound compact presentation profile', () => {
  function ordinarySimulationPrompt(outline: SceneOutline, languageDirective: string) {
    const prompt = buildPrompt(PROMPT_IDS.SIMULATION_CONTENT, {
      conceptName: outline.widgetOutline?.concept || outline.title,
      conceptOverview: outline.description,
      keyPoints: (outline.keyPoints || []).join('\n'),
      variables: outline.widgetOutline?.keyVariables?.join(', ') || '',
      designIdea: '',
      languageDirective,
    });
    expect(prompt).not.toBeNull();
    return prompt!;
  }

  it('selects the compact DOM prompt in the actual scene call without duplicating full source', async () => {
    const aiCall: AICallFn = vi.fn(async () => contentOutput(widgetOutline()));
    const content = await generateSceneContent(widgetOutline(), aiCall, {
      userRequirements: source,
      languageDirective: '请使用简体中文授课。',
    });
    expect(aiCall).toHaveBeenCalledTimes(1);
    const [system, user] = vi.mocked(aiCall).mock.calls[0];
    capturedSource(system, user);
    expect(system).toContain('# Source-bound correction hand-simulation widget');
    expect(system).not.toContain('### 7. Visible Animation');
    expect(system).toContain('SET_WIDGET_STATE');
    expect(system).toContain('Render each step from one coherent current state');
    expect(system).toContain('its displayed expression and value must change together');
    expect(system).toContain('explicitly label them as a precomputed comparison');
    expect(system).toContain('HIGHLIGHT_ELEMENT');
    expect(system).toContain('ANNOTATE_ELEMENT');
    expect(system).toContain('REVEAL_ELEMENT');
    expect(user).toContain('请使用简体中文授课。');
    expect(content).toMatchObject({
      html: expect.stringContaining('id="step-next"'),
      widgetType: 'simulation',
    });
  });

  it('uses the same compact selection for a standalone widget call and preserves unknown validation', async () => {
    const context: UserRequirements = structuredClone(source);
    context.codemateSource!.referenceValidation = { status: 'unknown', scope: 'not_supplied' };
    const aiCall: AICallFn = vi.fn(async () => contentOutput(widgetOutline()));
    await generateWidgetContent(widgetOutline(), aiCall, '中文', { userRequirements: context });
    expect(aiCall).toHaveBeenCalledTimes(1);
    const [system, user] = vi.mocked(aiCall).mock.calls[0];
    expect(system).toContain('# Source-bound correction hand-simulation widget');
    const blocks = user.split(COURSE_SOURCE_DATA_MARKER);
    expect(blocks).toHaveLength(2);
    expect(JSON.parse(blocks[1])).toEqual(context);
    expect(Buffer.from(JSON.parse(blocks[1]).codemateSource.code)).toEqual(
      Buffer.from(source.codemateSource!.code),
    );
  });

  it.each([
    ['absent', undefined],
    ['empty requirement', { requirement: '' }],
    ['ordinary material', { requirement: 'A regular source course', codeContextRequired: false }],
    ['complete source with false flag', { ...source, codeContextRequired: false }],
    ['complete source with absent flag', { ...source, codeContextRequired: undefined }],
  ] as const)(
    'keeps the actual ordinary simulation template bytes and image argument unchanged (%s)',
    async (_label, context) => {
      const outline = widgetOutline();
      const aiCall: AICallFn = vi.fn(async () => contentOutput(outline));
      const languageDirective = 'Ordinary course language';
      await generateSceneContent(outline, aiCall, { userRequirements: context, languageDirective });
      expect(aiCall).toHaveBeenCalledTimes(1);
      const expected = buildSourceGroundedPrompt(
        ordinarySimulationPrompt(outline, languageDirective),
        context,
      );
      const actual = vi.mocked(aiCall).mock.calls[0];
      expect(actual.slice(0, 2)).toEqual([expected.system, expected.user]);
      expect(actual[2]).toBeUndefined();
      expect(actual[0]).not.toContain('# Source-bound correction hand-simulation widget');
    },
  );

  it.each(['slide', 'interactive'] as const)(
    'rejects incomplete %s source before model selection/call',
    async (type) => {
      const aiCall: AICallFn = vi.fn();
      const incomplete = { requirement: 'No fabricated context', codeContextRequired: true };
      await expect(
        generateSceneContent(type === 'slide' ? slideOutline() : widgetOutline(), aiCall, {
          userRequirements: incomplete,
        }),
      ).rejects.toThrow('source context');
      expect(aiCall).not.toHaveBeenCalled();
      if (type === 'interactive') {
        await expect(
          generateWidgetContent(widgetOutline(), aiCall, '中文', { userRequirements: incomplete }),
        ).rejects.toThrow('source context');
        expect(aiCall).not.toHaveBeenCalled();
      }
    },
  );

  it('adds slide guidance only after validated code-bound selection and retains every source byte', async () => {
    const aiCall: AICallFn = vi.fn(async () => contentOutput(slideOutline()));
    await generateSceneContent(slideOutline(), aiCall, { userRequirements: source });
    expect(aiCall).toHaveBeenCalledTimes(1);
    const [system, user] = vi.mocked(aiCall).mock.calls[0];
    capturedSource(system, user);
    expect(user).toContain('## Source-bound correction slide profile');
    expect(user).toContain('Show each complete repair visibly at its original source location');
    const ordinary: AICallFn = vi.fn(async () => contentOutput(slideOutline()));
    await generateSceneContent(slideOutline(), ordinary, {
      userRequirements: { ...source, codeContextRequired: false },
    });
    expect(vi.mocked(ordinary).mock.calls[0][1]).not.toContain(
      '## Source-bound correction slide profile',
    );
  });

  it('does not route other code-bound widget types through the simulation profile', async () => {
    const outline: SceneOutline = { ...widgetOutline(), widgetType: 'diagram' };
    const aiCall: AICallFn = vi.fn(async () => contentOutput(outline));
    await generateSceneContent(outline, aiCall, { userRequirements: source });
    expect(aiCall).toHaveBeenCalledTimes(1);
    const [system, user] = vi.mocked(aiCall).mock.calls[0];
    capturedSource(system, user);
    expect(system).not.toContain('# Source-bound correction hand-simulation widget');
  });
});
