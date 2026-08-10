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
import { describe, expect, it } from 'vitest';

import { generateSceneContent, generateSceneActions } from '@/lib/generation/scene-generator';
import { buildSceneFromOutline } from '@/lib/generation/scene-builder';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import { normalizeLegacyPBLContent } from '@/lib/pbl/legacy/read';
import { legacyPBLSceneFixture } from '@/tests/fixtures/pbl-v1-scene';
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
      };

      await generateSceneActions(baseOutline({ type: 'interactive' }), content, aiCall, {
        languageDirective: DIRECTIVE,
      });

      expect(lastUser()).toContain(DIRECTIVE);
      expect(lastUser()).not.toContain('{{languageDirective}}');
    });

    it('threads languageDirective into pbl actions prompt', async () => {
      const { aiCall, lastUser, lastSystem } = makeCapturingAiCall('[]');
      const content: GeneratedPBLContent = {
        projectV2: {} as GeneratedPBLContent['projectV2'],
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
      expect(lastSystem()).toContain('Project title: t');
      expect(lastSystem()).toContain('Driving goal: d');
      expect(lastSystem()).not.toContain('undefined');
      expect(lastSystem()).not.toContain('{{projectSummary}}');
    });

    it('grounds the pbl actions prompt in the generated project plan', async () => {
      const { aiCall, lastSystem } = makeCapturingAiCall('[]');
      const legacyContent = structuredClone(legacyPBLSceneFixture.content);
      if (legacyContent.type !== 'pbl') {
        throw new Error('expected a PBL fixture');
      }
      const normalized = normalizeLegacyPBLContent(legacyContent);
      if (!('projectV2' in normalized) || !normalized.projectV2) {
        throw new Error('expected the legacy PBL fixture to normalize to projectV2');
      }
      const content: GeneratedPBLContent = {
        projectV2: normalized.projectV2,
      };

      await generateSceneActions(baseOutline({ type: 'pbl' }), content, aiCall);

      expect(lastSystem()).toContain('Project title: Community Garden Data Project');
      expect(lastSystem()).toContain('1. Inspect the measurements');
      expect(lastSystem()).toContain('2. Recommend a watering plan');
      expect(lastSystem()).not.toContain('{{projectSummary}}');
    });

    it('tolerates non-string leaves in a container-valid pbl project summary', async () => {
      const { aiCall, lastSystem } = makeCapturingAiCall('[]');
      const content = {
        projectV2: {
          title: 42,
          description: 42,
          gains: [42],
          roles: [{ id: 'role_instructor', type: 'instructor', name: 'Instructor' }],
          milestones: [
            { title: 42, order: 0, microtasks: [{ id: 'task_1', title: 'First task' }] },
            {
              title: 'Valid milestone',
              order: 1,
              microtasks: [{ id: 'task_2', title: 'Second task' }],
            },
          ],
          submissions: [],
          evaluations: [],
          threads: [],
          engagementEvents: [],
        },
      } as unknown as GeneratedPBLContent;

      await expect(
        generateSceneActions(
          baseOutline({
            type: 'pbl',
            pblConfig: {
              projectTopic: 'Fallback project',
              projectDescription: 'Fallback description',
              targetSkills: [],
            },
          }),
          content,
          aiCall,
        ),
      ).resolves.toEqual(expect.any(Array));

      expect(lastSystem()).toContain('Project title: Fallback project');
      expect(lastSystem()).toContain('Driving goal: Fallback description');
      expect(lastSystem()).toContain('1. Task 1');
      expect(lastSystem()).toContain('2. Valid milestone');
      expect(lastSystem()).not.toContain('Learner gains: 42');
    });
  });

  describe('widget generation (interactive scenes)', () => {
    it('threads languageDirective into the widget content prompt', async () => {
      const captured: string[] = [];
      const aiCall: AICallFn = async (_system, user) => {
        captured.push(user);
        return '<!DOCTYPE html><html><body>widget</body></html>';
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

      expect(captured).toHaveLength(1);
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
});
