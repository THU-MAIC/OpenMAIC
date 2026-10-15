import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { generateSceneActions, generateSceneContent } from '@openmaic/generation';
import type { AICallFn } from '@openmaic/generation';
import type {
  GeneratedInteractiveContent,
  SceneOutline,
  UserRequirements,
} from '@openmaic/generation';

function baseInteractiveOutline(overrides: Partial<SceneOutline> = {}): SceneOutline {
  return {
    id: 'scene-widget',
    type: 'interactive',
    title: 'Energy Widget',
    description: 'Explore how energy changes with the slider.',
    keyPoints: ['Observe the slider', 'Set a higher energy value', 'Reveal the formula'],
    order: 0,
    widgetType: 'simulation',
    widgetOutline: { concept: 'Energy transfer', keyVariables: ['energy'] },
    ...overrides,
  };
}

describe('widget actions direct pipeline', () => {
  it('generates widget content without a second teacherActions call', async () => {
    const capturedUsers: string[] = [];
    const aiCall: AICallFn = async (_system, user) => {
      capturedUsers.push(user);
      return '<!DOCTYPE html><html><body><div id="energy-slider"></div></body></html>';
    };

    const content = await generateSceneContent(baseInteractiveOutline(), aiCall, {
      languageDirective: 'Teach in English.',
    });

    expect(capturedUsers).toHaveLength(1);
    expect(content).toMatchObject({
      html: expect.stringContaining('energy-slider'),
      widgetType: 'simulation',
    });
    expect(content && 'teacherActions' in content).toBe(false);
  });

  it('uses interactive action generation directly and preserves all four widget action types', async () => {
    const capturedUsers: string[] = [];
    const aiCall: AICallFn = async (_system, user) => {
      capturedUsers.push(user);
      return JSON.stringify([
        {
          type: 'action',
          name: 'widget_highlight',
          params: { target: '#energy-slider', content: 'Watch this control first.' },
        },
        {
          type: 'action',
          name: 'widget_setState',
          params: { state: { energy: 82 }, content: 'Set energy to a high value.' },
        },
        {
          type: 'action',
          name: 'widget_annotation',
          params: { target: '#result-card', content: 'This result reflects the new state.' },
        },
        {
          type: 'action',
          name: 'widget_reveal',
          params: { target: '#hidden-formula', content: 'Reveal the formula behind it.' },
        },
      ]);
    };
    const legacyContent = {
      html: '<!DOCTYPE html><html><body><div id="energy-slider"></div></body></html>',
      widgetType: 'simulation',
      teacherActions: [
        {
          id: 'legacy-highlight',
          type: 'highlight',
          target: '#legacy',
          content: 'Legacy action should be ignored.',
        },
      ],
    } as unknown as GeneratedInteractiveContent;

    const actions = await generateSceneActions(baseInteractiveOutline(), legacyContent, aiCall, {
      languageDirective: 'Teach in English.',
    });

    expect(capturedUsers).toHaveLength(1);
    expect(capturedUsers[0]).toContain('widget_highlight');
    expect(actions.map((action) => action.type)).toEqual([
      'widget_highlight',
      'widget_setState',
      'widget_annotation',
      'widget_reveal',
    ]);
    expect(actions).toEqual([
      expect.objectContaining({
        type: 'widget_highlight',
        target: '#energy-slider',
        content: 'Watch this control first.',
      }),
      expect.objectContaining({
        type: 'widget_setState',
        state: { energy: 82 },
        content: 'Set energy to a high value.',
      }),
      expect.objectContaining({
        type: 'widget_annotation',
        target: '#result-card',
        content: 'This result reflects the new state.',
      }),
      expect.objectContaining({
        type: 'widget_reveal',
        target: '#hidden-formula',
        content: 'Reveal the formula behind it.',
      }),
    ]);
  });

  it('defaults widget_setState.state to {} when the LLM omits it', async () => {
    const aiCall: AICallFn = async () =>
      JSON.stringify([
        {
          type: 'action',
          name: 'widget_setState',
          params: { content: 'Update the widget.' },
        },
      ]);
    const content = {
      html: '<!DOCTYPE html><html><body></body></html>',
      widgetType: 'simulation',
    } as unknown as GeneratedInteractiveContent;

    const actions = await generateSceneActions(baseInteractiveOutline(), content, aiCall, {
      languageDirective: 'Teach in English.',
    });

    expect(actions).toEqual([
      expect.objectContaining({
        type: 'widget_setState',
        state: {},
        content: 'Update the widget.',
      }),
    ]);
  });
});

const correctionSource: UserRequirements = {
  requirement: 'Explain the supplied code and a separate hand simulation.',
  codeContextRequired: true,
  codemateSource: {
    title: 'Echo',
    content: 'Read and print the given value.',
    code: 'value = input()\nprint(value)\n',
    correctedCode: 'value = input()\nprint(value)\n',
    language: 'Python3',
  },
};

const controls = [
  '<button type="button" id="step-next" data-role="next">Next</button>',
  '<button type="button" id="step-back" data-role="back">Back</button>',
  '<button type="button" id="step-reset" data-role="reset">Reset</button>',
  '<span id="step-status" data-role="status">Initial</span>',
  '<span id="step-progress" data-role="progress">Initial</span>',
];
function declaredWidget(
  variables: unknown = ['energy'],
  markup = controls.join(''),
): GeneratedInteractiveContent {
  return {
    widgetType: 'simulation',
    html:
      '<!DOCTYPE html><html><body>' +
      markup +
      '<script type="application/json" id="widget-config">' +
      JSON.stringify({ type: 'simulation', exposedVariables: variables }) +
      '</script></body></html>',
    widgetConfig: { type: 'simulation', exposedVariables: ['staleMetadata'] },
  };
}
const compactOptions = { userRequirements: correctionSource, targetLanguage: 'zh-CN' };

describe('validated compact deterministic control guidance', () => {
  it('returns conditional actual-control guidance without any model call or mutation', async () => {
    const content = declaredWidget();
    const beforeContent = structuredClone(content);
    const beforeSource = structuredClone(correctionSource);
    const aiCall: AICallFn = vi.fn(async () => {
      throw new Error('No model call is permitted');
    });
    const actions = await generateSceneActions(
      baseInteractiveOutline(),
      content,
      aiCall,
      compactOptions,
    );
    expect(aiCall).not.toHaveBeenCalled();
    expect(content).toEqual(beforeContent);
    expect(correctionSource).toEqual(beforeSource);
    expect(actions.map((a) => a.type)).toEqual([
      'speech',
      'widget_highlight',
      'widget_highlight',
      'speech',
      'widget_highlight',
      'widget_highlight',
      'speech',
    ]);
    expect(actions.filter((a) => a.type === 'widget_highlight').map((a) => a.target)).toEqual([
      '#step-status',
      '#step-next',
      '#step-back',
      '#step-reset',
    ]);
    const text = JSON.stringify(actions.map(({ id: _id, ...action }) => action));
    expect(text).toContain('每次点击前进后');
    expect(text).toContain('需要重新观察时');
    expect(text).toContain('不代表原程序实际运行或评测结果');
    expect(text).not.toMatch(/检查|不能据此认定|页面更新前|不一致/);
    expect(text).not.toMatch(
      /widget_setState|currentStep|第[一二三四五六七八九十0-9]+步|已点击|已完成|energy|staleMetadata/,
    );
  });

  it('validates complete source before document or locale preflight in direct package calls', async () => {
    const aiCall: AICallFn = vi.fn();
    await expect(
      generateSceneActions(baseInteractiveOutline(), declaredWidget(null), aiCall, {
        userRequirements: { requirement: 'No inferred source', codeContextRequired: true },
      }),
    ).rejects.toThrow('source context');
    expect(aiCall).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 'energy', ['energy', 'energy'], [''], [17]])(
    'rejects immutable missing/malformed configuration before any provider (%j)',
    async (variables) => {
      const content = declaredWidget(variables);
      if (variables === undefined)
        content.html = '<html><body>' + controls.join('') + '</body></html>';
      const aiCall: AICallFn = vi.fn();
      await expect(
        generateSceneActions(baseInteractiveOutline(), content, aiCall, compactOptions),
      ).rejects.toMatchObject({ name: 'CorrectionWidgetActionError', isRetryable: false });
      expect(aiCall).not.toHaveBeenCalled();
    },
  );

  it.each([
    '<script id="widget-config" type="application/json">',
    "<script  id = 'widget-config'\n type = 'application/json' >",
    '<SCRIPT TYPE="application/json" ID="widget-config">',
  ])('accepts equivalent actual configuration attribute syntax (%s)', async (opening) => {
    const content = declaredWidget([]);
    content.html = content.html.replace(
      '<script type="application/json" id="widget-config">',
      opening,
    );
    const aiCall: AICallFn = vi.fn();
    await expect(
      generateSceneActions(baseInteractiveOutline(), content, aiCall, compactOptions),
    ).resolves.toHaveLength(7);
    expect(aiCall).not.toHaveBeenCalled();
  });

  it('uses HTML-decoded actual IDs instead of raw string matching', async () => {
    const content = declaredWidget();
    content.html = content.html.replace('id="step-next"', "id='step-&#110;ext'");
    const aiCall: AICallFn = vi.fn();
    await expect(
      generateSceneActions(baseInteractiveOutline(), content, aiCall, compactOptions),
    ).resolves.toHaveLength(7);
    expect(aiCall).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2, 3, 4])(
    'rejects a missing actual contract element at index %i',
    async (missing) => {
      const aiCall: AICallFn = vi.fn();
      await expect(
        generateSceneActions(
          baseInteractiveOutline(),
          declaredWidget([], controls.filter((_, i) => i !== missing).join('')),
          aiCall,
          compactOptions,
        ),
      ).rejects.toMatchObject({
        isRetryable: false,
        message: expect.stringContaining('missing_or_invalid_controls'),
      });
      expect(aiCall).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['comment', (markup: string) => '<!--' + markup + '-->'],
    ['script', (markup: string) => '<script>const fake = ' + JSON.stringify(markup) + ';</script>'],
    ['template', (markup: string) => '<template>' + markup + '</template>'],
    ['noscript', (markup: string) => '<noscript>' + markup + '</noscript>'],
    ['textarea', (markup: string) => '<textarea>' + markup + '</textarea>'],
    ['style', (markup: string) => '<style>' + markup + '</style>'],
  ] as const)('does not count fake controls inside %s as real elements', async (_name, wrap) => {
    const aiCall: AICallFn = vi.fn();
    await expect(
      generateSceneActions(
        baseInteractiveOutline(),
        declaredWidget([], wrap(controls.join(''))),
        aiCall,
        compactOptions,
      ),
    ).rejects.toMatchObject({ isRetryable: false });
    expect(aiCall).not.toHaveBeenCalled();
  });

  it('ignores fake duplicate controls in inert contents when real controls exist', async () => {
    const content = declaredWidget();
    const fake = controls.join('').replace('id="step-next"', 'id="step-next" id="fake"');
    content.html = content.html.replace(
      '</body>',
      '<template>' + fake + '</template><!--' + fake + '--></body>',
    );
    const aiCall: AICallFn = vi.fn();
    await expect(
      generateSceneActions(baseInteractiveOutline(), content, aiCall, compactOptions),
    ).resolves.toHaveLength(7);
    expect(aiCall).not.toHaveBeenCalled();
  });

  it.each([
    (html: string) => html.replace('type="button"', 'type="submit"'),
    (html: string) => html.replace('type="button"', ''),
    (html: string) => html.replace('data-role="next"', 'data-role="reset"'),
    (html: string) =>
      html
        .replace('<button type="button" id="step-next"', '<div type="button" id="step-next"')
        .replace('Next</button>', 'Next</div>'),
    (html: string) => html.replace('data-role="status"', 'data-role="progress"'),
    (html: string) => html + '<div id="step-next"></div>',
    (html: string) => html.replace('id="step-next"', 'id="step-next" id="other"'),
  ])('rejects wrong control semantics or duplicate IDs/attributes', async (modify) => {
    const aiCall: AICallFn = vi.fn();
    await expect(
      generateSceneActions(
        baseInteractiveOutline(),
        declaredWidget([], modify(controls.join(''))),
        aiCall,
        compactOptions,
      ),
    ).rejects.toMatchObject({ isRetryable: false });
    expect(aiCall).not.toHaveBeenCalled();
  });

  it('does not accept an inert or duplicate configuration declaration', async () => {
    const content = declaredWidget([]);
    const script = content.html.match(/<script[\s\S]*?<\/script>/)![0];
    for (const replacement of [
      '<template>' + script + '</template>',
      '<!--' + script + '-->',
      script + script,
    ]) {
      const aiCall: AICallFn = vi.fn();
      await expect(
        generateSceneActions(
          baseInteractiveOutline(),
          { ...content, html: content.html.replace(script, replacement) },
          aiCall,
          compactOptions,
        ),
      ).rejects.toMatchObject({ isRetryable: false });
      expect(aiCall).not.toHaveBeenCalled();
    }
  });

  it.each([undefined, '', 'en-US', 'zh-TW', 'ja-JP'])(
    'requires an explicitly supported teaching locale (%j)',
    async (targetLanguage) => {
      const aiCall: AICallFn = vi.fn();
      await expect(
        generateSceneActions(baseInteractiveOutline(), declaredWidget(), aiCall, {
          userRequirements: correctionSource,
          targetLanguage,
          languageDirective: '请使用简体中文',
        }),
      ).rejects.toMatchObject({
        isRetryable: false,
        message: expect.stringContaining('unsupported_guidance_locale'),
      });
      expect(aiCall).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, false])(
    'preserves ordinary simulation model behavior when trusted flag is %j',
    async (flag) => {
      const aiCall: AICallFn = vi.fn(
        async () => '[{"type":"text","content":"Ordinary model response"}]',
      );
      const actions = await generateSceneActions(
        baseInteractiveOutline(),
        declaredWidget(null, ''),
        aiCall,
        {
          userRequirements: { ...correctionSource, codeContextRequired: flag },
          targetLanguage: 'ja-JP',
        },
      );
      expect(aiCall).toHaveBeenCalledTimes(1);
      expect(actions).toEqual([expect.objectContaining({ text: 'Ordinary model response' })]);
    },
  );

  it.each(['game', 'procedural-skill'] as const)(
    'does not replace the %s action model path',
    async (widgetType) => {
      const aiCall: AICallFn = vi.fn(
        async () => '[{"type":"text","content":"Other widget response"}]',
      );
      await generateSceneActions(
        baseInteractiveOutline({ widgetType }),
        {
          html: '<html><body>Other widget</body></html>',
          widgetType,
        },
        aiCall,
        { userRequirements: correctionSource },
      );
      expect(aiCall).toHaveBeenCalledTimes(1);
    },
  );
});

// External real HTML is never committed or repaired by this check.
const captureRoot = process.env.CLASSROOM_WIDGET_ACTION_PRIVATE_FIXTURE_ROOT;
describe.skipIf(!captureRoot)('private actual compact HTML with deterministic guidance', () => {
  it('keeps actual HTML/source untouched and uses no provider despite old model narration', async () => {
    const read = (name: string) => JSON.parse(readFileSync(join(captureRoot!, name), 'utf8'));
    const { outline, returnedContent } = read('content-attempt-1.private.json');
    const source = read('requirements.private.json');
    const original = JSON.stringify(returnedContent);
    const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
    const htmlBefore = sha256(returnedContent.html);
    const sourceBefore = sha256(JSON.stringify(source));
    const aiCall: AICallFn = vi.fn(async () => {
      throw new Error('No model call');
    });
    const actions = await generateSceneActions(outline, returnedContent, aiCall, {
      userRequirements: source.requirements ?? source,
      targetLanguage: 'zh-CN',
    });
    expect(aiCall).not.toHaveBeenCalled();
    expect(JSON.stringify(returnedContent)).toBe(original);
    expect(sha256(returnedContent.html)).toBe(htmlBefore);
    expect(sha256(JSON.stringify(source))).toBe(sourceBefore);
    expect(actions).toHaveLength(7);
    expect(
      actions.every((action) => action.type === 'speech' || action.type === 'widget_highlight'),
    ).toBe(true);
    const output = process.env.CLASSROOM_WIDGET_ACTION_PRIVATE_OUTPUT;
    if (output)
      writeFileSync(
        output,
        JSON.stringify(
          {
            scope:
              'actual generateSceneActions structural guidance only; HTML teaching correctness is unaccepted',
            providerCalls: 0,
            htmlBefore,
            htmlAfter: sha256(returnedContent.html),
            sourceBefore,
            sourceAfter: sha256(JSON.stringify(source)),
            actions,
          },
          null,
          2,
        ) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
    // This checks only structural guidance. The real HTML's known human-reviewed
    // initial-state/table defects remain unchanged for the existing final review.
  });
});
