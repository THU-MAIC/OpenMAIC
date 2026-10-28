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

  it('does not count a read as working on a course: only writes and generation do', () => {
    // "Make a grade-5 version of my refraction course": the original is read,
    // a new course is created, and the original is not this conversation's.
    expect(
      conversationTargetStageIds([
        { key: 'u', kind: 'user', text: 'make a grade-5 version of my refraction course' },
        tool('r', 'read_stage', { stageId: 'stage-b' }),
        tool('o', 'read_stage_outline', { stageId: 'stage-b' }),
        tool('l', 'list_scenes', { stageId: 'stage-b' }),
        tool('c', 'create_stage', { title: 'Grade 5' }),
      ]),
    ).toEqual([]);
    // Editing it is working on it.
    expect(
      conversationTargetStageIds([
        tool('r', 'read_stage', { stageId: 'stage-b' }),
        tool('p', 'patch_stage', { stageId: 'stage-b' }),
      ]),
    ).toEqual(['stage-b']);
  });

  it('still keeps a conversation bound to a course it only reads off the preview', () => {
    expect(
      worksOnExistingCourses(
        [
          { key: 'u', kind: 'user', text: 'tighten page 2' },
          tool('r', 'read_stage', { stageId: 'b' }),
        ],
        'b',
      ),
    ).toBe(true);
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
