/**
 * What the agent is told about a course a generation run is still producing.
 *
 * Such a course is read-only until its run completes, and an agent that read
 * it without knowing offered to edit it or to "generate the remaining pages" —
 * the very thing the run was doing. The list tools mark it, the read tools
 * start their result with a notice, a classroom the user names carries the
 * same notice, and a write still gets the store's own refusal text.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { PPTTextElement } from '@openmaic/dsl';
import { describe, expect, it, vi } from 'vitest';

import {
  courseGenerationNotice,
  withCourseGenerationNotice,
  type CourseGeneration,
} from '@/lib/server/agent-runtime/course-generation';
import type { CourseDocument, CourseStore } from '@/lib/server/agent-runtime/course-tools';
import {
  buildCurriculumTools,
  type CurriculumToolDeps,
} from '@/lib/server/agent-runtime/curriculum-tools';
import { buildDslCourseTools } from '@/lib/server/agent-runtime/dsl-tools';
import {
  buildPersonalHistoryTools,
  type PersonalHistorySource,
} from '@/lib/server/agent-runtime/personal-history-tools';
import { composeCourseRefsText, composeFollowUpText } from '@/lib/server/agent-runtime/runner';
import { CourseGeneratingError } from '@/lib/server/generation/run/store';
import type { Scene } from '@/lib/types/stage';

const GENERATING = 'stage-generating';
const READY = 'stage-ready';
const generation: CourseGeneration = { state: 'generating', scenesCompleted: 2, scenesTotal: 8 };
const lookup = async () => new Map([[GENERATING, generation]]);

const NOTICE =
  'This course is still being generated (2/8 pages); it is read-only until generation completes. Do not offer to edit or generate its pages; tell the user to wait.';

interface ToolResultShape {
  content: Array<{ type: string; text?: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

const textOf = (result: ToolResultShape) => result.content[0]?.text ?? '';

function slideScene(stageId: string): Scene {
  return {
    id: 'scene_slide',
    stageId,
    order: 1,
    title: 'Opening',
    type: 'slide',
    content: {
      type: 'slide',
      canvas: {
        id: 'canvas-1',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#fff',
          themeColors: ['#2563eb'],
          fontColor: '#111',
          fontName: 'Inter',
        },
        elements: [
          {
            id: 'el-title',
            type: 'text',
            left: 10,
            top: 10,
            width: 400,
            height: 80,
            rotate: 0,
            content: '<p>Hello</p>',
            defaultFontName: 'Inter',
            defaultColor: '#111',
            fill: '#fff',
          } as PPTTextElement,
        ],
      },
    },
    actions: [{ id: 'act-1', type: 'speech', text: 'Welcome' }],
  } as Scene;
}

function documentOf(stageId: string, name: string): CourseDocument {
  return {
    stage: { id: stageId, name, createdAt: 1, updatedAt: 1 },
    scenes: [slideScene(stageId)],
  } as CourseDocument;
}

function storeOf(putScene: CourseStore['putScene'] = async () => {}): CourseStore {
  const docs = new Map([
    [GENERATING, documentOf(GENERATING, 'Labour Day lesson')],
    [READY, documentOf(READY, 'Essay writing')],
  ]);
  return {
    loadDocument: async (stageId: string) => docs.get(stageId) ?? null,
    saveDocument: async () => {},
    putScene,
    listFolders: async () => [],
    listDocuments: async () =>
      [...docs.values()].map((doc) => ({
        id: doc.stage.id,
        name: doc.stage.name,
        sceneCount: doc.scenes.length,
        createdAt: 1,
        updatedAt: 1,
      })),
  } as unknown as CourseStore;
}

function dslTools(store: CourseStore) {
  return buildDslCourseTools({
    store,
    stageAccess: async () => ({ kind: 'owned' }),
    onCheckpoint: () => {},
  }) as unknown as AgentTool[];
}

async function run(tools: readonly AgentTool[], name: string, params: Record<string, unknown>) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} not registered`);
  return (await tool.execute('call-1', params as never)) as unknown as ToolResultShape;
}

describe('read tools on a course being generated', () => {
  it('start the result with the notice and carry the flag', async () => {
    const tools = withCourseGenerationNotice(dslTools(storeOf()), lookup);

    const read = await run(tools, 'read_stage', { stageId: GENERATING });
    expect(textOf(read).startsWith(`${NOTICE}\n\n`)).toBe(true);
    expect(read.details?.generation).toEqual({
      generating: true,
      generationState: 'generating',
      scenesCompleted: 2,
      scenesTotal: 8,
    });

    const grep = await run(tools, 'grep_stage', { stageId: GENERATING, query: 'Hello' });
    expect(textOf(grep).startsWith(NOTICE)).toBe(true);
  });

  it('leave a finished course, an error result and every other tool alone', async () => {
    const base = dslTools(storeOf());
    const tools = withCourseGenerationNotice(base, lookup);

    const ready = await run(tools, 'read_stage', { stageId: READY });
    expect(textOf(ready)).not.toContain('still being generated');
    expect(ready.details).not.toHaveProperty('generation');

    const failed = await run(tools, 'read_stage', { stageId: GENERATING, path: '/nope' });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).not.toContain('still being generated');

    const patch = tools.find((tool) => tool.name === 'patch_stage');
    expect(patch).toBe(base.find((tool) => tool.name === 'patch_stage'));
  });

  it('read_stage_outline starts with the notice too', async () => {
    const deps = {
      store: storeOf(),
      ownerId: 'user:u1',
      sessionId: 'session-1',
      stageAccess: async (stageId: string) => ({
        kind: 'owned',
        stage: { stageId, name: 'Labour Day lesson' },
      }),
    } as CurriculumToolDeps;
    const tools = withCourseGenerationNotice(
      buildCurriculumTools(deps) as unknown as AgentTool[],
      lookup,
    );
    const outline = await run(tools, 'read_stage_outline', { stageId: GENERATING });
    expect(textOf(outline).startsWith(NOTICE)).toBe(true);
  });

  it('a paused run says the course waits for a Retry', () => {
    expect(courseGenerationNotice({ ...generation, state: 'paused' })).toContain(
      'tell the user to retry the failed page from the classroom',
    );
  });
});

describe('list tools mark a course being generated', () => {
  it('list_folder_stages', async () => {
    const tools = buildCurriculumTools({
      store: storeOf(),
      ownerId: 'user:u1',
      sessionId: 'session-1',
      stageAccess: async () => ({ kind: 'missing' }),
      courseGenerations: lookup,
    });
    const listed = (await tools
      .find((tool) => tool.name === 'list_folder_stages')!
      .execute('call-1', {} as never)) as unknown as ToolResultShape;

    expect(listed.details?.courses).toEqual([
      expect.objectContaining({
        stageId: GENERATING,
        generating: true,
        generationState: 'generating',
        scenesCompleted: 2,
        scenesTotal: 8,
      }),
      expect.not.objectContaining({ generating: true }),
    ]);
    expect(textOf(listed)).toContain(
      `"Labour Day lesson" (${GENERATING}, 1 page(s), still being generated: 2/8 pages, read-only until generation completes)`,
    );
    expect(textOf(listed)).toContain(`"Essay writing" (${READY}, 1 page(s))`);
  });

  it('search_classrooms', async () => {
    const row = (id: string, title: string) => ({
      ownerId: 'user:u1',
      id,
      title,
      description: null,
      updatedAt: 1,
      outline: undefined,
      pageCount: 1,
    });
    const source = {
      listClassrooms: async () => [row(GENERATING, 'Labour Day'), row(READY, 'Essay')],
    } as unknown as PersonalHistorySource;
    const tools = buildPersonalHistoryTools('user:u1', source, undefined, lookup);
    const found = (await tools
      .find((tool) => tool.name === 'search_classrooms')!
      .execute('call-1', {} as never)) as unknown as ToolResultShape;
    const items = found.details?.items as Array<Record<string, unknown>>;
    expect(items.find((item) => item.id === GENERATING)).toMatchObject({
      generating: true,
      scenesCompleted: 2,
      scenesTotal: 8,
    });
    expect(items.find((item) => item.id === READY)).not.toHaveProperty('generating');
  });
});

describe('a classroom the user names while it is being generated', () => {
  it('carries the notice in the message the agent receives', () => {
    const refs = [
      { kind: 'course' as const, stageId: GENERATING, title: 'Labour Day lesson' },
      { kind: 'course' as const, stageId: READY, title: 'Essay writing' },
    ];
    const text = composeFollowUpText({
      text: 'Can you edit this lesson now?',
      courseRefs: refs,
      courseRefGenerations: { [GENERATING]: generation },
    });
    expect(text).toContain(`"Labour Day lesson": ${NOTICE}`);
    expect(text).not.toContain('"Essay writing": This course');
    // Without a run, the ref block is exactly what it was.
    expect(composeCourseRefsText('', refs.slice(1))).toBe(
      `\n\n[The user named this classroom: "Essay writing" (${READY}). Work on the named classroom for this message.]`,
    );
  });
});

describe('a write into a course being generated', () => {
  it('reaches the agent as the store refusal text', async () => {
    const putScene = vi.fn(async () => {
      throw new CourseGeneratingError(GENERATING);
    });
    const tools = dslTools(storeOf(putScene as unknown as CourseStore['putScene']));
    const patched = await run(tools, 'patch_stage', {
      stageId: GENERATING,
      target: '/scenes/scene_slide',
      intent: 'Reword the narration',
      ops: [{ op: 'set', path: '/actions/0/text', value: 'Welcome back' }],
    });
    expect(putScene).toHaveBeenCalled();
    expect(patched.isError).toBe(true);
    expect(textOf(patched)).toContain(
      'This course is still being generated; it can be edited once its generation completes.',
    );
  });
});
