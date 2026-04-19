/**
 * Structural assertion tests for the orchestration prompt templates.
 *
 * These replace the byte-equal snapshot suite that was initially added — the
 * goal here is catching real regressions (missing variables, broken role
 * dispatch, broken scene-type stripping) without forcing a snapshot update
 * for every intentional prompt-content tweak.
 */

import { describe, test, expect } from 'vitest';
import { buildStructuredPrompt } from '@/lib/orchestration/prompt-builder';
import { buildDirectorPrompt } from '@/lib/orchestration/director-prompt';
import { buildPBLSystemPrompt } from '@/lib/pbl/pbl-system-prompt';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { StatelessChatRequest } from '@/lib/types/chat';

const baseAgent: AgentConfig = {
  id: 'a1',
  name: 'Mr. Chen',
  role: 'teacher',
  persona: 'Patient physics teacher.',
  avatar: '',
  color: '#000',
  allowedActions: [
    'spotlight',
    'laser',
    'wb_open',
    'wb_draw_text',
    'wb_draw_latex',
    'wb_draw_shape',
    'wb_close',
  ],
  priority: 100,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  isDefault: true,
};

const slideState: StatelessChatRequest['storeState'] = {
  stage: {
    id: 's1',
    name: 'Test',
    createdAt: 0,
    updatedAt: 0,
    languageDirective: 'zh-CN',
  },
  scenes: [
    {
      id: 'sc1',
      stageId: 's1',
      type: 'slide',
      title: 'T',
      order: 0,
      content: {
        type: 'slide',
        canvas: {
          id: 'c1',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          theme: {
            backgroundColor: '#fff',
            themeColors: [],
            fontColor: '#333',
            fontName: 'YaHei',
          },
          elements: [],
        },
      },
    },
  ],
  currentSceneId: 'sc1',
  mode: 'autonomous',
  whiteboardOpen: false,
};

const quizState: StatelessChatRequest['storeState'] = {
  ...slideState,
  scenes: [
    {
      ...slideState.scenes[0],
      type: 'quiz',
      content: { type: 'quiz', questions: [] },
    },
  ],
};

// Matches any surviving {{placeholder}} token in rendered output
const UNRESOLVED_PLACEHOLDER = /\{\{\w[\w-]*\}\}/;

describe('no surviving placeholders', () => {
  test('agent-system / teacher / slide', () => {
    const out = buildStructuredPrompt(baseAgent, slideState);
    expect(out).not.toMatch(UNRESOLVED_PLACEHOLDER);
  });

  test('director prompt', () => {
    const out = buildDirectorPrompt([baseAgent], 'No history', [], 0);
    expect(out).not.toMatch(UNRESOLVED_PLACEHOLDER);
  });

  test('pbl-design prompt', () => {
    const out = buildPBLSystemPrompt({
      projectTopic: 'Smart Garden',
      projectDescription: 'IoT project',
      targetSkills: ['IoT', 'Python'],
      issueCount: 3,
      languageDirective: 'en',
    });
    expect(out).not.toMatch(UNRESOLVED_PLACEHOLDER);
  });
});

describe('role dispatch', () => {
  test('teacher prompt carries LEAD TEACHER guideline', () => {
    const out = buildStructuredPrompt(baseAgent, slideState);
    expect(out).toContain('LEAD TEACHER');
  });

  test('student prompt does NOT carry LEAD TEACHER guideline', () => {
    const studentAgent: AgentConfig = { ...baseAgent, role: 'student' };
    const out = buildStructuredPrompt(studentAgent, slideState);
    expect(out).not.toContain('LEAD TEACHER');
    expect(out).toContain('STUDENT');
  });
});

describe('scene-type action stripping', () => {
  test('slide scene exposes spotlight action description', () => {
    const out = buildStructuredPrompt(baseAgent, slideState);
    expect(out).toMatch(/^- spotlight:/m);
  });

  test('quiz scene strips spotlight + laser from action descriptions', () => {
    const out = buildStructuredPrompt(baseAgent, quizState);
    expect(out).not.toMatch(/^- spotlight:/m);
    expect(out).not.toMatch(/^- laser:/m);
  });
});

describe('director routing contract', () => {
  test('output spec mentions next_agent JSON field', () => {
    const out = buildDirectorPrompt([baseAgent], 'No history', [], 0);
    expect(out).toContain('next_agent');
  });
});
