/**
 * Regression tests for GitHub issue #472:
 * `languageDirective` is dropped or hardcoded across the scene generation pipeline,
 * silently breaking prompt-level language control.
 *
 * The bug caused `{{languageDirective}}` to leak as a literal placeholder into
 * LLM user messages. These tests thread a sentinel directive through every affected
 * code path and assert it both reaches the rendered prompt AND the literal
 * placeholder is gone.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';

import { generateSceneContent, generateSceneActions } from '@/lib/generation/scene-generator';
import { buildSceneFromOutline } from '@/lib/generation/scene-builder';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import type {
  SceneOutline,
  GeneratedSlideContent,
  GeneratedQuizContent,
  GeneratedInteractiveContent,
  GeneratedPBLContent,
} from '@/lib/types/generation';

const DIRECTIVE = '<<LANG-DIRECTIVE-SENTINEL>>';

function makeCapturingAiCall(response: string): {
  aiCall: AICallFn;
  lastUser: () => string;
  lastSystem: () => string;
} {
  let lastUser = '';
  let lastSystem = '';
  const aiCall: AICallFn = async (system, user) => {
    lastSystem = system;
    lastUser = user;
    return response;
  };
  return {
    aiCall,
    lastUser: () => lastUser,
    lastSystem: () => lastSystem,
  };
}

function baseOutline(overrides: Partial<SceneOutline> = {}): SceneOutline {
  return {
    id: 'scene-1',
    type: 'slide',
    title: 'Test Scene',
    description: 'A scene for testing language directive threading.',
    keyPoints: ['point a', 'point b'],
    order: 0,
    ...overrides,
  };
}

describe('scene-generator language directive threading (issue #472)', () => {
  describe('content generation', () => {
    it('threads languageDirective into slide content prompt', async () => {
      const { aiCall, lastUser } = makeCapturingAiCall(
        JSON.stringify({ elements: [], background: null, remark: '' }),
      );

      await generateSceneContent(baseOutline({ type: 'slide' }), aiCall, {
        languageDirective: DIRECTIVE,
      });

      expect(lastUser()).toContain(DIRECTIVE);
      expect(lastUser()).not.toContain('{{languageDirective}}');
    });

    it('threads languageDirective into quiz content prompt', async () => {
      const { aiCall, lastUser } = makeCapturingAiCall(JSON.stringify([]));

      await generateSceneContent(
        baseOutline({
          type: 'quiz',
          quizConfig: {
            questionCount: 1,
            difficulty: 'easy',
            questionTypes: ['single'],
          },
        }),
        aiCall,
        { languageDirective: DIRECTIVE },
      );

      expect(lastUser()).toContain(DIRECTIVE);
      expect(lastUser()).not.toContain('{{languageDirective}}');
    });
  });

  describe('actions generation', () => {
    it('threads languageDirective into slide actions prompt', async () => {
      const { aiCall, lastUser } = makeCapturingAiCall('[]');
      const content: GeneratedSlideContent = {
        elements: [
          {
            id: 'text_1',
            type: 'text',
            left: 0,
            top: 0,
            width: 100,
            height: 40,
            content: '<p>hi</p>',
            defaultFontName: '',
            defaultColor: '#000',
            rotate: 0,
          },
        ],
        background: undefined,
        remark: '',
      };

      await generateSceneActions(baseOutline({ type: 'slide' }), content, aiCall, {
        languageDirective: DIRECTIVE,
      });

      expect(lastUser()).toContain(DIRECTIVE);
      expect(lastUser()).not.toContain('{{languageDirective}}');
    });

    it('threads languageDirective into quiz actions prompt', async () => {
      const { aiCall, lastUser } = makeCapturingAiCall('[]');
      const content: GeneratedQuizContent = {
        questions: [
          {
            id: 'q1',
            type: 'single',
            question: 'x?',
            options: [{ value: 'A', label: 'yes' }],
            answer: ['A'],
            hasAnswer: true,
          },
        ],
      };

      await generateSceneActions(baseOutline({ type: 'quiz' }), content, aiCall, {
        languageDirective: DIRECTIVE,
      });

      expect(lastUser()).toContain(DIRECTIVE);
      expect(lastUser()).not.toContain('{{languageDirective}}');
    });

    it('threads languageDirective into interactive actions prompt', async () => {
      const { aiCall, lastUser } = makeCapturingAiCall('[]');
      const content: GeneratedInteractiveContent = {
        html: '<div />',
        // No widgetType/teacherActions so we hit the normal actions path
      };

      await generateSceneActions(baseOutline({ type: 'interactive' }), content, aiCall, {
        languageDirective: DIRECTIVE,
      });

      expect(lastUser()).toContain(DIRECTIVE);
      expect(lastUser()).not.toContain('{{languageDirective}}');
    });

    it('threads languageDirective into pbl actions prompt', async () => {
      const { aiCall, lastUser } = makeCapturingAiCall('[]');
      const content: GeneratedPBLContent = {
        projectConfig: {
          projectInfo: { title: 't', description: 'd' },
          agents: [],
          issueboard: { agent_ids: [], issues: [], current_issue_id: null },
          chat: { messages: [] },
        },
      };

      await generateSceneActions(
        baseOutline({
          type: 'pbl',
          pblConfig: {
            projectTopic: 't',
            projectDescription: 'd',
            targetSkills: [],
          },
        }),
        content,
        aiCall,
        { languageDirective: DIRECTIVE },
      );

      expect(lastUser()).toContain(DIRECTIVE);
      expect(lastUser()).not.toContain('{{languageDirective}}');
    });
  });

  describe('widget generation (interactive scenes)', () => {
    it('threads languageDirective into widget content AND widget-teacher-actions prompts', async () => {
      const captured: string[] = [];
      // 1st call: widget HTML content; 2nd call: widget-teacher-actions JSON
      const aiCall: AICallFn = async (_system, user) => {
        captured.push(user);
        return captured.length === 1
          ? '<!DOCTYPE html><html><body>widget</body></html>'
          : JSON.stringify({ actions: [] });
      };

      await generateSceneContent(
        baseOutline({
          type: 'interactive',
          widgetType: 'simulation',
          widgetOutline: { concept: 'Projectile', keyVariables: ['angle'] },
        }),
        aiCall,
        { languageDirective: DIRECTIVE },
      );

      expect(captured).toHaveLength(2);
      for (const user of captured) {
        expect(user).toContain(DIRECTIVE);
        expect(user).not.toContain('{{languageDirective}}');
        expect(user).not.toContain('{{language}}');
      }
    });
  });

  describe('buildSceneFromOutline (high-level pipeline)', () => {
    it('threads languageDirective through content AND actions for a slide', async () => {
      const captured: string[] = [];
      const aiCall: AICallFn = async (_system, user) => {
        captured.push(user);
        // First call is content (expects JSON); second is actions (expects array)
        return captured.length === 1
          ? JSON.stringify({ elements: [], background: null, remark: '' })
          : '[]';
      };

      await buildSceneFromOutline(
        baseOutline({ type: 'slide' }),
        aiCall,
        'stage-1',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        DIRECTIVE,
      );

      expect(captured).toHaveLength(2);
      for (const user of captured) {
        expect(user).toContain(DIRECTIVE);
        expect(user).not.toContain('{{languageDirective}}');
      }
    });
  });

  describe('pbl content honors caller-provided directive', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('forwards options.languageDirective to generatePBLContent', async () => {
      const pblModule = await import('@/lib/pbl/generate-pbl');
      const spy = vi.spyOn(pblModule, 'generatePBLContent').mockResolvedValue({
        projectInfo: { title: '', description: '' },
        agents: [],
        issueboard: { agent_ids: [], issues: [], current_issue_id: null },
        chat: { messages: [] },
      });

      const aiCall: AICallFn = async () => '';

      await generateSceneContent(
        baseOutline({
          type: 'pbl',
          pblConfig: {
            projectTopic: 't',
            projectDescription: 'd',
            targetSkills: [],
          },
        }),
        aiCall,
        {
          languageDirective: DIRECTIVE,
          languageModel: {} as unknown as import('ai').LanguageModel,
        },
      );

      expect(spy).toHaveBeenCalledTimes(1);
      const config = spy.mock.calls[0][0];
      expect(config.languageDirective).toBe(DIRECTIVE);
    });
  });
});
