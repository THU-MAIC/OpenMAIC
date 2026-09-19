import { describe, expect, test } from 'vitest';
import { buildStructuredPrompt } from '@/lib/orchestration/prompt-builder';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { getActionDescriptions } from '@/lib/orchestration/tool-schemas';
import type { StatelessChatRequest } from '@/lib/types/chat';

const agent: AgentConfig = {
  id: 'teacher-1',
  name: 'Teacher',
  role: 'teacher',
  persona: 'A clear math teacher.',
  avatar: '',
  color: '#000000',
  allowedActions: ['wb_draw_text', 'wb_draw_latex'],
  priority: 100,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  isDefault: true,
};

const storeState: StatelessChatRequest['storeState'] = {
  stage: null,
  scenes: [],
  currentSceneId: null,
  mode: 'autonomous',
  whiteboardOpen: false,
};

describe('whiteboard LaTeX prompt guardrails', () => {
  test('wb_draw_text excludes formulas and directs equations to wb_draw_latex', () => {
    const description = getActionDescriptions(['wb_draw_text']);

    expect(description.toLowerCase()).not.toContain('formulas');
    expect(description).toContain('Use wb_draw_latex for mathematical equations');
  });

  test('structured prompt warns against raw LaTeX in wb_draw_text', () => {
    const prompt = buildStructuredPrompt(agent, storeState);

    expect(prompt).toContain(
      "Don't pass raw LaTeX to wb_draw_text; use wb_draw_latex for equations!",
    );
  });
});
