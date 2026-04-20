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

  test('assistant prompt carries TEACHING ASSISTANT guideline', () => {
    const assistantAgent: AgentConfig = { ...baseAgent, role: 'assistant' };
    const out = buildStructuredPrompt(assistantAgent, slideState);
    expect(out).toContain('TEACHING ASSISTANT');
    expect(out).not.toContain('LEAD TEACHER');
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

describe('optional sections toggle on / off correctly', () => {
  test('peer context appears when other agents have spoken this round', () => {
    const out = buildStructuredPrompt(baseAgent, slideState, undefined, undefined, undefined, [
      {
        agentId: 'other',
        agentName: 'Lily',
        contentPreview: 'quick thought',
        actionCount: 1,
        whiteboardActions: [],
      },
    ]);
    expect(out).toContain("This Round's Context");
    expect(out).toContain('Lily');
  });

  test('peer context is absent when agentResponses is empty/undefined', () => {
    const out = buildStructuredPrompt(baseAgent, slideState);
    expect(out).not.toContain("This Round's Context");
  });

  test('language constraint is omitted when stage.languageDirective is absent', () => {
    const stateNoLang: StatelessChatRequest['storeState'] = {
      ...slideState,
      stage: { ...slideState.stage!, languageDirective: undefined },
    };
    const out = buildStructuredPrompt(baseAgent, stateNoLang);
    expect(out).not.toContain('# Language (CRITICAL)');
  });
});

describe('director routing contract', () => {
  test('output spec mentions next_agent JSON field', () => {
    const out = buildDirectorPrompt([baseAgent], 'No history', [], 0);
    expect(out).toContain('next_agent');
  });

  test('Q&A mode omits Discussion Mode block', () => {
    const out = buildDirectorPrompt([baseAgent], 'No history', [], 0);
    expect(out).not.toContain('Discussion Mode');
  });

  test('discussion mode inserts Discussion Mode block with topic', () => {
    const out = buildDirectorPrompt(
      [baseAgent],
      'No history',
      [],
      0,
      { topic: 'Force decomposition', prompt: 'Think of real examples' },
      'student_1',
    );
    expect(out).toContain('# Discussion Mode');
    expect(out).toContain('Force decomposition');
    expect(out).toContain('student_1');
  });
});

describe('pbl-design template fills all repeated placeholders', () => {
  test('issueCount is substituted at every occurrence (3x in template)', () => {
    const UNIQUE = 42;
    const out = buildPBLSystemPrompt({
      projectTopic: 'Smart Garden',
      projectDescription: 'IoT project',
      targetSkills: ['IoT'],
      issueCount: UNIQUE,
      languageDirective: 'en',
    });
    // Template references {{issueCount}} at 3 positions:
    // "Suggested Number of Issues: N", "Create N sequential issues", "Create exactly N issues"
    const occurrences = out.match(new RegExp(`\\b${UNIQUE}\\b`, 'g'))?.length ?? 0;
    expect(occurrences).toBeGreaterThanOrEqual(3);
  });
});

describe('placeholder naming convention lint', () => {
  // The `interpolateVariables` regex is /\{\{(\w+)\}\}/, which is
  // strictly [A-Za-z0-9_]. Kebab-case placeholders would silently pass
  // through. Convention (per README) is camelCase. This test scans every
  // template for non-conforming placeholders.
  //
  // slide-content/{system,user}.md predates the convention and still uses
  // snake_case ({{canvas_width}}, {{canvas_height}}). Grandfather it here;
  // new templates must be camelCase.
  test('templates (excluding grandfathered) use camelCase placeholders', async () => {
    const { readdirSync, readFileSync, statSync } = await import('fs');
    const { join } = await import('path');

    const templatesDir = join(process.cwd(), 'lib', 'prompts', 'templates');
    const GRANDFATHERED = new Set(['slide-content']);

    const offenders: string[] = [];
    for (const promptId of readdirSync(templatesDir)) {
      if (GRANDFATHERED.has(promptId)) continue;
      const promptDir = join(templatesDir, promptId);
      if (!statSync(promptDir).isDirectory()) continue;

      for (const file of ['system.md', 'user.md']) {
        const p = join(promptDir, file);
        try {
          const content = readFileSync(p, 'utf-8');
          // Match {{placeholder}} but NOT {{snippet:name}}
          const matches = content.match(/\{\{(?!snippet:)([^}]+)\}\}/g) || [];
          for (const m of matches) {
            const name = m.slice(2, -2);
            // camelCase: starts with lowercase, rest alphanumeric; reject _ and -
            if (!/^[a-z][a-zA-Z0-9]*$/.test(name)) {
              offenders.push(`${promptId}/${file}: ${m}`);
            }
          }
        } catch {
          // user.md is optional
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
