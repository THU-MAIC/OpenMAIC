import { describe, expect, it } from 'vitest';
import {
  conversationTargetStageIds,
  worksOnExistingCourses,
} from '@/lib/workbench/conversation-course';
import type { ChatNode } from '@/lib/workbench/session-store';

const tool = (key: string, toolName: string, toolArgs?: Record<string, unknown>): ChatNode => ({
  key,
  kind: 'tool',
  text: '',
  toolName,
  ...(toolArgs ? { toolArgs } : {}),
});

describe('the courses a conversation works on', () => {
  it('collects every stage its calls name, but not create_stage or calls without one', () => {
    expect(
      conversationTargetStageIds([
        { key: 'u', kind: 'user', text: 'x' },
        tool('s', 'web_search', { query: 'q' }),
        tool('c', 'create_stage', { title: 'New', stageId: 'ignored' }),
        tool('r', 'read_stage', { stageId: 'stage-a' }),
        tool('p', 'patch_stage', { stageId: 'stage-a' }),
        tool('g', 'generate_scene', { stageId: 'stage-b', order: 1 }),
      ]),
    ).toEqual(['stage-a', 'stage-b']);
  });
});

describe('a conversation working on existing courses', () => {
  const lookThrough = [
    { key: 'u', kind: 'user', text: 'x' } as ChatNode,
    tool('l', 'list_folder_stages'),
    tool('q', 'ask_user'),
  ];
  it('is one bound beside a course whose calls look through existing courses', () => {
    expect(worksOnExistingCourses(lookThrough, 'stage-a')).toBe(true);
  });
  it('is not one that is unbound, only researches, or creates its own course', () => {
    expect(worksOnExistingCourses(lookThrough, null)).toBe(false);
    expect(worksOnExistingCourses([tool('s', 'web_search')], 'stage-a')).toBe(false);
    expect(worksOnExistingCourses([...lookThrough, tool('c', 'create_stage')], 'stage-a')).toBe(
      false,
    );
  });
});
