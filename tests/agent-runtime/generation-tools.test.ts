import { describe, expect, it, vi } from 'vitest';
import type { AgentTool } from '@earendil-works/pi-agent-core';

import type { CourseDocument, CourseStore } from '@/lib/server/agent-runtime/course-tools';
import { buildDslCourseToolset } from '@/lib/server/agent-runtime/course-tools';
import {
  buildGenerationTools,
  collectUnresolvedMediaPlaceholders,
  filterKnownActions,
} from '@/lib/server/agent-runtime/generation-tools';
import type { Scene } from '@/lib/types/stage';

function slide(id: string, order: number, title = id): Scene {
  return {
    id,
    stageId: 'stage-test',
    order,
    title,
    type: 'slide',
    content: {
      type: 'slide',
      canvas: {
        id: `canvas-${id}`,
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#fff',
          themeColors: ['#2463eb'],
          fontColor: '#111',
          fontName: 'Inter',
        },
        elements: [],
      },
    },
    actions: [],
  } as Scene;
}

function document(scenes: Scene[]): CourseDocument {
  return {
    stage: { id: 'stage-test', name: 'Test', createdAt: 1, updatedAt: 1 },
    scenes,
    outline: {
      outlines: scenes.map((scene) => ({
        id: scene.outlineId ?? scene.id,
        order: scene.order,
        title: scene.title,
        type: scene.type,
        description: `${scene.title} brief`,
        keyPoints: [],
      })),
      createdAt: 1,
      updatedAt: 1,
    },
  } as CourseDocument;
}

function state(initial: CourseDocument | null) {
  let doc = initial ? structuredClone(initial) : null;
  const store = {
    loadDocument: vi.fn(async () => doc),
    putScene: vi.fn(async (_stageId: string, scene: Scene) => {
      if (!doc) throw new Error('missing');
      const index = doc.scenes.findIndex((item) => item.id === scene.id);
      doc.scenes =
        index < 0
          ? [...doc.scenes, scene]
          : doc.scenes.map((item) => (item.id === scene.id ? scene : item));
    }),
    saveDocument: vi.fn(async (next: CourseDocument) => {
      doc = structuredClone(next);
    }),
  } as unknown as CourseStore;
  return { store, get: () => doc };
}

function find(tools: AgentTool<never, never>[], name: string) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`missing ${name}`);
  return tool;
}

function deps(store: CourseStore, extra: Record<string, unknown> = {}) {
  return {
    store,
    stageAccess: async () => ({ kind: 'owned' as const }),
    sessionId: 'session-a',
    onCheckpoint: vi.fn(),
    synthesizeTts: vi.fn(async () => ({
      available: true,
      changed: false,
      generated: 0,
      skipped: 0,
      failed: [],
    })),
    ...extra,
  };
}

describe('generation and deck tools', () => {
  it('reports active-skill diagnostics against the persisted stage after generation', async () => {
    const current = state(document([]));
    const onCheckpoint = vi.fn();
    let calls = 0;
    const generate = find(
      buildGenerationTools(
        deps(current.store, {
          onCheckpoint,
          getActiveSkill: () => ({
            id: 'workshop-style',
            name: 'workshop-style',
            description: 'Workshop',
            content: '# Workshop',
            filePath: '/skills/workshop-style/SKILL.md',
            constraints: { sceneCount: { min: 2 } },
            source: 'builtin',
          }),
          aiCall: vi.fn(async () => {
            calls += 1;
            return calls === 1
              ? JSON.stringify([{ id: 'q1', type: 'short_answer', question: 'Try it?' }])
              : JSON.stringify([{ type: 'text', content: 'Narration' }]);
          }),
        }),
      ),
      'generate_scene',
    );
    const response = await generate.execute('call', {
      stageId: 'stage-test',
      order: 1,
      title: 'Practice',
      type: 'quiz',
      brief: 'Try the idea',
    } as never);
    expect((response.content[0] as { text?: string } | undefined)?.text).toContain(
      'SKILL CONSTRAINT CHECK',
    );
    expect(response.details).toMatchObject({
      skill: 'workshop-style',
      skillViolations: ['1 scenes, the skill requires at least 2'],
    });
    expect(onCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ skill: 'workshop-style', skillViolations: expect.any(Array) }),
    );
  });

  it('keeps an earlier page after a later page generation crashes', async () => {
    const current = state(document([]));
    let contentCalls = 0;
    const aiCall = vi.fn(async () => {
      contentCalls += 1;
      if (contentCalls === 1)
        return JSON.stringify([{ id: 'q1', type: 'short_answer', question: 'First?' }]);
      if (contentCalls === 2) return JSON.stringify([{ type: 'text', content: 'First narration' }]);
      throw new Error('mid-generation failure');
    });
    const tools = buildGenerationTools(deps(current.store, { aiCall }));
    const generate = find(tools, 'generate_scene');
    await generate.execute('first', {
      stageId: 'stage-test',
      order: 1,
      title: 'First',
      type: 'quiz',
      brief: 'First brief',
    } as never);
    await expect(
      generate.execute('second', {
        stageId: 'stage-test',
        order: 2,
        title: 'Second',
        type: 'quiz',
        brief: 'Second brief',
      } as never),
    ).rejects.toThrow('mid-generation failure');
    expect(current.get()?.scenes.map(({ order, title }) => ({ order, title }))).toEqual([
      { order: 1, title: 'First' },
    ]);
  });

  it('refuses destructive PBL type changes and unresolved generation media', async () => {
    const pbl = slide('project', 1, 'Project') as Scene;
    pbl.type = 'pbl';
    pbl.content = { type: 'pbl', projectV2: { id: 'project' } } as never;
    const current = state(document([pbl]));
    const generate = find(buildGenerationTools(deps(current.store)), 'generate_scene');
    const typeChange = await generate.execute('type-change', {
      stageId: 'stage-test',
      order: 1,
      title: 'Replacement',
      type: 'slide',
      brief: 'Replace the project',
    } as never);
    expect(typeChange).toMatchObject({ isError: true, details: { blocked: 'pbl-type-change' } });
    const badMedia = await generate.execute('bad-media', {
      stageId: 'stage-test',
      order: 2,
      title: 'Media',
      type: 'slide',
      brief: 'Use media',
      media: [{ src: 'image:pending', description: 'Pending image' }],
    } as never);
    expect(badMedia).toMatchObject({ isError: true, details: { error: 'media-placeholder-src' } });
    expect(current.get()?.scenes).toHaveLength(1);
  });

  it('detects slide media placeholders without returning page bodies', () => {
    const scene = slide('media', 1);
    (scene.content as Extract<Scene['content'], { type: 'slide' }>).canvas.elements = [
      { id: 'image-1', type: 'image', src: 'image:pending' },
      { id: 'video-1', type: 'video', src: '', mediaRef: 'video:pending' },
    ] as never;
    expect(collectUnresolvedMediaPlaceholders(scene)).toEqual([
      { elementId: 'image-1', type: 'image', placeholder: 'image:pending' },
      { elementId: 'video-1', type: 'video', placeholder: 'video:pending' },
    ]);
  });

  it('makes duplicate_scene idempotent for a replayed call id', async () => {
    const current = state(document([slide('source', 1)]));
    const duplicate = find(buildGenerationTools(deps(current.store)), 'duplicate_scene');
    const params = { stageId: 'stage-test', templateSceneId: 'source', targetOrder: 2 };
    await duplicate.execute('same-call', params as never);
    const replay = await duplicate.execute('same-call', params as never);
    expect(current.get()?.scenes).toHaveLength(2);
    expect(replay.details).toMatchObject({ replay: true });
  });

  it('renumbers scenes and outline entries together for reorder and delete', async () => {
    const a = slide('a', 1, 'A');
    a.outlineId = 'oa';
    const b = slide('b', 2, 'B');
    b.outlineId = 'ob';
    const c = slide('c', 3, 'C');
    c.outlineId = 'oc';
    const current = state(document([a, b, c]));
    const edit = find(buildDslCourseToolset(deps(current.store)), 'edit_deck');
    await edit.execute('reorder', {
      stageId: 'stage-test',
      op: 'reorder',
      orderedIds: ['c', 'a', 'b'],
    } as never);
    await edit.execute('delete', { stageId: 'stage-test', op: 'delete', sceneId: 'a' } as never);
    expect(current.get()?.scenes.map((scene) => [scene.id, scene.order])).toEqual([
      ['c', 1],
      ['b', 2],
    ]);
    expect(
      (current.get()?.outline as { outlines: Array<{ id: string; order: number }> }).outlines.map(
        (entry) => [entry.id, entry.order],
      ),
    ).toEqual([
      ['oc', 1],
      ['ob', 2],
    ]);
  });

  it('drops action types unknown to the shared DSL', () => {
    expect(
      filterKnownActions([
        { id: 'speech', type: 'speech', text: 'Known' },
        { id: 'future', type: 'future_action' } as never,
      ]),
    ).toEqual([{ id: 'speech', type: 'speech', text: 'Known' }]);
  });

  it('marks every new document writer sequential', () => {
    const tools = buildDslCourseToolset(deps(state(document([slide('a', 1)])).store));
    for (const name of [
      'generate_scene',
      'generate_actions',
      'duplicate_scene',
      'generate_tts',
      'edit_deck',
    ]) {
      expect(find(tools, name)).toMatchObject({ executionMode: 'sequential' });
    }
    for (const name of ['list_scenes', 'read_stage', 'grep_stage']) {
      expect(find(tools, name)).not.toHaveProperty('executionMode');
    }
  });

  it('fails closed through an owner-bound store for every new write tool', async () => {
    const foreign = state(null);
    const tools = buildDslCourseToolset(deps(foreign.store));
    const calls: Array<[string, Record<string, unknown>]> = [
      ['generate_scene', { stageId: 'foreign', order: 1, title: 'X', type: 'slide', brief: 'X' }],
      ['generate_actions', { stageId: 'foreign', order: 1 }],
      ['duplicate_scene', { stageId: 'foreign', templateOrder: 1, targetOrder: 2 }],
      ['generate_tts', { stageId: 'foreign', order: 1 }],
      ['edit_deck', { stageId: 'foreign', op: 'delete', order: 1 }],
    ];
    for (const [name, params] of calls) {
      const response = await find(tools, name).execute(`call-${name}`, params as never);
      expect(response).toMatchObject({ isError: true });
    }
    expect(foreign.get()).toBeNull();
  });
});
