// @vitest-environment jsdom

/**
 * Cases where the timeline met the rest of the app badly: the renderer's real
 * empty-text cleanup, reads overtaken by saves, whole-document agent saves, and
 * write-backs that are not steps. They run the real TextElement, controller,
 * session and store rather than calling the session with hand-built snapshots.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene, SlideContent, Stage } from '@/lib/types/stage';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: vi.fn(async () => ({ failedChanges: [] })),
  saveStageDataIncremental: vi.fn(async () => ({ failedChanges: [] })),
}));
vi.mock('@/lib/hooks/use-history-snapshot', () => ({
  useHistorySnapshot: () => ({ addHistorySnapshot: async () => {} }),
}));
vi.mock('@/components/slide-renderer/components/element/ProsemirrorEditor', () => ({
  ProsemirrorEditor: () => null,
}));

const { createDefaultSlide, createDefaultTextElement } =
  await import('@/lib/edit/slide-edit-elements');
const { useStageStore, discardPendingStageChanges, hasUnsavedSceneEdit } =
  await import('@/lib/store/stage');
const { commitCourseEdit, recordAgentChange, stampAudioOnTimeline, stepCourseTimeline } =
  await import('@/lib/edit/course-edit');
const { useCourseTimeline, AGENT_RUN_IDLE_MS, BURST_MAX_GAP_MS, applyTimelineEntry, diffCourse } =
  await import('@/lib/edit/course-timeline');
const { useSlideEditSession } = await import('@/components/edit/surfaces/slide/slide-edit-session');
const { useSlideCanvasController } =
  await import('@/components/edit/surfaces/slide/use-slide-surface');
const { SceneProvider } = await import('@/lib/contexts/scene-context');
const { TextElement } = await import('@/components/slide-renderer/components/element/TextElement');
const { forgetSceneWrites, noteScenesWritten, noteStructureWritten, reconcileFetchedScenes } =
  await import('@/lib/edit/scene-echo');
const { stripToDesignTemplate } = await import('@/lib/pbl/v2/runtime/learner-state');

const STAGE = 'stage-1';

function slide(id: string, text: string, order = 1): Scene {
  const canvas = createDefaultSlide(`c-${id}`);
  canvas.elements.push({ ...createDefaultTextElement(`t-${id}`), content: text });
  return {
    id,
    stageId: STAGE,
    type: 'slide',
    title: id,
    order,
    content: { type: 'slide', schemaVersion: 1, canvas },
    actions: [],
    createdAt: 1,
    updatedAt: 1,
  } as unknown as Scene;
}

const sceneOf = (id: string) => useStageStore.getState().scenes.find((scene) => scene.id === id)!;
const elementsOf = (id: string) =>
  (sceneOf(id).content as SlideContent).canvas.elements as unknown as {
    id: string;
    content: string;
  }[];
const line = () => useCourseTimeline.getState().lines[STAGE];
const past = () => line()?.past.length ?? 0;
const future = () => line()?.future.length ?? 0;

function load(scenes: Scene[], currentSceneId: string) {
  useStageStore.setState({
    stage: { id: STAGE, name: 'Course' } as unknown as Stage,
    scenes,
    currentSceneId,
  });
}

function Canvas() {
  const current = useStageStore((state) => state.currentSceneId);
  const { controller } = useSlideCanvasController();
  const content = useStageStore(
    (state) => state.scenes.find((scene) => scene.id === current)?.content,
  ) as SlideContent | undefined;
  return createElement(
    SceneProvider,
    { controller } as never,
    (content?.canvas.elements ?? []).map((element) =>
      createElement(TextElement, { key: element.id, elementInfo: element } as never),
    ),
  );
}

async function mountCanvas() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Canvas)));
  return root;
}

const pause = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

/** Clear the text the way typing does: a commit from outside any pointer gesture. */
function clearText(id: string) {
  const next = structuredClone(sceneOf(id).content as SlideContent);
  (next.canvas.elements[0] as unknown as { content: string }).content = '<p></p>';
  useSlideEditSession.getState().commitContent(id, next, false);
}

beforeEach(() => {
  discardPendingStageChanges(STAGE);
  forgetSceneWrites(STAGE);
  useCourseTimeline.getState().clearCourse(STAGE);
  useCourseTimeline.setState({ agentRun: null });
  useSlideEditSession.getState().end();
});

describe('a commit that outlives its page', () => {
  it('writes to the scene it was built from, not the one open now', () => {
    load([slide('a', '<p>aaa</p>'), slide('b', '<p>bbb</p>', 2)], 'b');
    useSlideEditSession.getState().seed('b');
    const edited = structuredClone(sceneOf('a').content as SlideContent);
    edited.canvas.elements = [];
    useSlideEditSession.getState().commitContent('a', edited, true);
    expect(elementsOf('b').map((element) => element.id)).toEqual(['t-b']);
    expect(elementsOf('a')).toEqual([]);
  });

  it('a page flip off an empty text box leaves the next page alone', async () => {
    load([slide('a', '<p></p>'), slide('b', '<p>bbb</p>', 2)], 'a');
    const root = await mountCanvas();
    await act(async () => useStageStore.getState().setCurrentSceneId('b'));
    await pause(400);
    expect(elementsOf('b').map((element) => element.id)).toEqual(['t-b']);
    await act(async () => root.unmount());
  });
});

describe('the empty text box cleanup', () => {
  it('undo brings the text back and stays back', async () => {
    load([slide('a', '<p>abc</p>')], 'a');
    const root = await mountCanvas();
    await pause(350);
    expect(past()).toBe(0);

    await act(async () => clearText('a'));
    await pause(400);
    expect(elementsOf('a')).toEqual([]);
    expect(past()).toBe(1);

    await act(async () => stepCourseTimeline('undo'));
    await pause(400);
    expect(elementsOf('a').map((element) => element.content)).toEqual(['<p>abc</p>']);
    expect([past(), future()]).toEqual([0, 1]);
    await act(async () => root.unmount());
  });

  it('an undo inside the wait cancels the removal it would have overtaken', async () => {
    load([slide('a', '<p>abc</p>')], 'a');
    const root = await mountCanvas();
    await act(async () => clearText('a'));
    await pause(50);
    await act(async () => stepCourseTimeline('undo'));
    await pause(400);
    expect(elementsOf('a').map((element) => element.content)).toEqual(['<p>abc</p>']);
    await act(async () => root.unmount());
  });

  it('redo lands on the emptied box without losing the way back', async () => {
    load([slide('a', '<p>abc</p>')], 'a');
    const root = await mountCanvas();
    await act(async () => clearText('a'));
    await pause(400);
    await act(async () => stepCourseTimeline('undo'));
    await pause(50);
    await act(async () => stepCourseTimeline('redo'));
    await pause(400);
    expect(elementsOf('a')).toEqual([]);
    expect([past(), future()]).toEqual([1, 0]);
    await act(async () => stepCourseTimeline('undo'));
    await pause(400);
    expect(elementsOf('a').map((element) => element.content)).toEqual(['<p>abc</p>']);
    await act(async () => root.unmount());
  });

  it('keeps a box with no text whose fill makes it a shape', async () => {
    const scene = slide('a', '<p></p>');
    const box = (scene.content as SlideContent).canvas.elements[0] as unknown as { fill: string };
    box.fill = '#ff0000';
    load([scene], 'a');
    const root = await mountCanvas();
    await pause(400);
    expect(elementsOf('a')).toHaveLength(1);
    await act(async () => root.unmount());
  });

  it('is not a step even while a drag on another element is in flight', async () => {
    load([slide('a', '<p></p>')], 'a');
    commitCourseEdit({}, () => useStageStore.getState().updateScene('a', { title: 'renamed' }));
    stepCourseTimeline('undo');
    const root = await mountCanvas();
    const { withTidyWrite } = await import('@/lib/edit/tidy-write');
    const empty = structuredClone(sceneOf('a').content as SlideContent);
    empty.canvas.elements = [];
    withTidyWrite(() => useSlideEditSession.getState().commitContent('a', empty, true));
    expect(elementsOf('a')).toEqual([]);
    expect([past(), future()]).toEqual([0, 1]);
    await act(async () => root.unmount());
  });

  it('opening a page with an empty box is not an edit and keeps redo', async () => {
    load([slide('a', '<p>x</p>'), slide('b', '<p></p>', 2)], 'a');
    commitCourseEdit({}, () => useStageStore.getState().updateScene('a', { title: 'renamed' }));
    stepCourseTimeline('undo');
    await act(async () => useStageStore.getState().setCurrentSceneId('b'));
    const root = await mountCanvas();
    await pause(400);
    expect(elementsOf('b')).toEqual([]);
    expect([past(), future()]).toEqual([0, 1]);
    await act(async () => root.unmount());
  });
});

describe('reading back a scene nobody changed', () => {
  const quiz = (title: string, order = 1) =>
    ({
      id: 'q',
      stageId: STAGE,
      type: 'quiz',
      title,
      order,
      content: { type: 'quiz', questions: [] },
      actions: [],
      createdAt: 1,
      updatedAt: 1,
    }) as unknown as Scene;

  it('an unsaved first edit survives an agent saving the whole document', () => {
    load([quiz('V0')], 'q');
    useStageStore.getState().updateScene('q', { title: 'V1' });
    const result = reconcileFetchedScenes({
      stageId: STAGE,
      current: useStageStore.getState().scenes,
      fetched: [quiz('V0')],
      removedIds: [],
      addedIds: [],
      isSceneDirty: (id) => hasUnsavedSceneEdit(STAGE, id),
      structureDirty: false,
    });
    expect(result.fetched[0].title).toBe('V1');
    expect([...result.deferredIds]).toEqual(['q']);
  });

  it('an undo stays undone when a whole-document save re-reads the value it undid', () => {
    load([quiz('V0')], 'q');
    const before = useStageStore.getState();
    useStageStore.setState({
      scenes: before.scenes.map((scene) => ({ ...scene, title: 'AGENT' }) as Scene),
    });
    recordAgentChange(before);
    stepCourseTimeline('undo');
    expect(sceneOf('q').title).toBe('V0');
    const result = reconcileFetchedScenes({
      stageId: STAGE,
      current: useStageStore.getState().scenes,
      fetched: [quiz('AGENT')],
      removedIds: [],
      addedIds: [],
      isSceneDirty: (id) => hasUnsavedSceneEdit(STAGE, id),
      structureDirty: false,
    });
    expect(result.fetched[0].title).toBe('V0');
    expect([...result.deferredIds]).toEqual(['q']);
  });

  it('a real change to another value still lands over the unsaved edit', () => {
    load([quiz('V0')], 'q');
    useStageStore.getState().updateScene('q', { title: 'V1' });
    const result = reconcileFetchedScenes({
      stageId: STAGE,
      current: useStageStore.getState().scenes,
      fetched: [quiz('agent')],
      removedIds: [],
      addedIds: [],
      isSceneDirty: (id) => hasUnsavedSceneEdit(STAGE, id),
      structureDirty: false,
    });
    expect(result.fetched[0].title).toBe('agent');
  });

  it('a read older than a landed reorder keeps the local order, and reads again', () => {
    const now = 1_000_000;
    const local = [quiz('A', 2), { ...quiz('B', 1), id: 'b' } as Scene];
    noteScenesWritten(STAGE, local, now - 1_000);
    noteStructureWritten(STAGE, now - 1_000);
    const result = reconcileFetchedScenes({
      stageId: STAGE,
      current: local,
      fetched: [quiz('A', 1), { ...quiz('B', 2), id: 'b' } as Scene],
      removedIds: [],
      addedIds: [],
      isSceneDirty: () => false,
      structureDirty: false,
      now,
    });
    expect(result.fetched.map((scene) => scene.order)).toEqual([2, 1]);
    expect([...result.deferredIds].sort()).toEqual(['b', 'q']);
  });

  it('a page the server added brings the server order, even right after a local save', () => {
    const now = 1_000_000;
    noteStructureWritten(STAGE, now - 1_000);
    const result = reconcileFetchedScenes({
      stageId: STAGE,
      current: [quiz('A', 2)],
      fetched: [quiz('A', 3), { ...quiz('N', 2), id: 'n' } as Scene],
      removedIds: [],
      addedIds: ['n'],
      isSceneDirty: () => false,
      structureDirty: false,
      now,
    });
    expect(result.fetched.map((scene) => scene.order).sort()).toEqual([2, 3]);
  });

  it('a read older than a landed page deletion does not bring the page back', () => {
    const now = 1_000_000;
    noteScenesWritten(STAGE, [quiz('A')], now - 60_000);
    noteStructureWritten(STAGE, now - 1_000);
    const result = reconcileFetchedScenes({
      stageId: STAGE,
      current: [],
      fetched: [quiz('A')],
      removedIds: [],
      addedIds: [],
      isSceneDirty: () => false,
      structureDirty: false,
      now,
    });
    expect(result.fetched).toEqual([]);
    expect([...result.deferredIds]).toEqual(['q']);
  });

  it('a page deleted by the agent after the window is taken', () => {
    const now = 1_000_000;
    noteStructureWritten(STAGE, now - 60_000);
    const result = reconcileFetchedScenes({
      stageId: STAGE,
      current: [quiz('A')],
      fetched: [],
      removedIds: ['q'],
      addedIds: [],
      isSceneDirty: () => false,
      structureDirty: false,
      now,
    });
    expect(result.removedIds).toEqual(['q']);
  });

  it('a PBL scene with learner progress reads back as an echo after the window', () => {
    const project = {
      uiPhase: 'workspace',
      title: 'p',
      description: 'd',
      proficiency: 'intermediate',
      language: 'en-US',
      tags: [],
      status: 'active',
      roles: [{ id: 'instructor-1', type: 'instructor', name: 'Instructor' }],
      milestones: [
        {
          id: 'milestone-1',
          title: 'M',
          status: 'active',
          order: 0,
          microtasks: [
            {
              id: 'microtask-1',
              title: 'T',
              status: 'completed',
              assignee: 'user',
              hints: [],
              order: 0,
              completionReason: 'done',
            },
          ],
        },
      ],
      submissions: [
        {
          id: 'submission-1',
          microtaskId: 'microtask-1',
          milestoneId: 'milestone-1',
          kind: 'text',
          content: 'learner work',
          createdAt: '2026-08-07T08:00:02.000Z',
        },
      ],
      evaluations: [],
      threads: [],
      engagementEvents: [],
      runtimeEvents: [],
      createdAt: '2026-08-07T08:00:00.000Z',
      updatedAt: '2026-08-07T08:00:03.000Z',
    };
    const local = {
      id: 'p',
      stageId: STAGE,
      type: 'pbl',
      title: 'P',
      order: 1,
      actions: [],
      content: { type: 'pbl', projectV2: project },
    } as unknown as Scene;
    const persisted = JSON.parse(
      JSON.stringify({
        ...local,
        content: {
          type: 'pbl',
          projectV2: stripToDesignTemplate(project as never),
        },
      }),
    ) as Scene;
    const now = 1_000_000;
    noteScenesWritten(STAGE, [persisted], now - 60_000);
    const result = reconcileFetchedScenes({
      stageId: STAGE,
      current: [local],
      fetched: [persisted],
      removedIds: [],
      addedIds: [],
      isSceneDirty: () => false,
      structureDirty: false,
      now,
    });
    expect(result.fetched[0]).toBe(local);
  });
});

describe('write-backs that are not steps', () => {
  it('undo and redo keep generated audio that matches the text', () => {
    const scene = slide('a', '<p>x</p>');
    (scene as unknown as { actions: unknown[] }).actions = [
      { id: '1', type: 'speech', text: 'one' },
      { id: '2', type: 'speech', text: 'two' },
    ];
    load([scene], 'a');
    commitCourseEdit({}, () =>
      useStageStore.getState().updateScene('a', {
        actions: [
          { id: '1', type: 'speech', text: 'ONE' },
          { id: '2', type: 'speech', text: 'two' },
        ] as never,
      }),
    );
    const stamp = (id: string, text: string, audioId: string) => {
      useStageStore.getState().updateScene('a', {
        actions: sceneOf('a').actions!.map((action) =>
          action.id === id ? { ...action, audioId } : action,
        ) as never,
      });
      stampAudioOnTimeline('a', id, text, audioId);
    };
    stamp('1', 'ONE', 'tts_1');
    stamp('2', 'two', 'tts_2');
    expect(past()).toBe(1);

    const audio = () =>
      sceneOf('a').actions!.map(
        (action) => (action as unknown as { audioId?: string }).audioId ?? null,
      );
    stepCourseTimeline('undo');
    // Line 1's old text never had this clip; line 2's text is the one it was made for.
    expect(audio()).toEqual([null, 'tts_2']);
    stepCourseTimeline('redo');
    expect(audio()).toEqual(['tts_1', 'tts_2']);
  });
});

describe('agent runs', () => {
  it('a run that never ended stops collecting after the silence limit', () => {
    const start = 1_000_000;
    const timeline = useCourseTimeline.getState();
    timeline.beginAgentRun(start);
    const first = useCourseTimeline.getState().activeRunId(start + 1);
    expect(first).toBeDefined();
    expect(useCourseTimeline.getState().activeRunId(start + AGENT_RUN_IDLE_MS + 1)).toBeUndefined();
    timeline.beginAgentRun(start + AGENT_RUN_IDLE_MS + 1);
    const next = useCourseTimeline.getState().activeRunId(start + AGENT_RUN_IDLE_MS + 2);
    expect(next).toBeDefined();
    expect(next).not.toBe(first);
  });

  it('a long run that keeps talking keeps collecting', () => {
    const start = 1_000_000;
    const timeline = useCourseTimeline.getState();
    timeline.beginAgentRun(start);
    const first = useCourseTimeline.getState().activeRunId(start + 1);
    const later = start + AGENT_RUN_IDLE_MS - 1_000;
    timeline.touchAgentRun(later);
    expect(useCourseTimeline.getState().activeRunId(later + AGENT_RUN_IDLE_MS - 1_000)).toBe(first);
    expect(
      useCourseTimeline.getState().activeRunId(later + AGENT_RUN_IDLE_MS + 1_000),
    ).toBeUndefined();
  });

  it('a crashed run resuming the same answer stays one run', () => {
    const start = 1_000_000;
    const timeline = useCourseTimeline.getState();
    timeline.beginAgentRun(start);
    const first = useCourseTimeline.getState().activeRunId(start + 1);
    timeline.beginAgentRun(start + 5_000);
    expect(useCourseTimeline.getState().activeRunId(start + 5_001)).toBe(first);
  });

  it('agent steps of one run, separated by nothing, fold together', () => {
    load([slide('a', '<p>a</p>'), slide('b', '<p>b</p>', 2)], 'a');
    useCourseTimeline.getState().beginAgentRun(Date.now());
    for (const id of ['a', 'b']) {
      const before = useStageStore.getState();
      useStageStore.setState({
        scenes: before.scenes.map((scene) =>
          scene.id === id ? ({ ...scene, title: `run-${id}` } as Scene) : scene,
        ),
      });
      recordAgentChange(before);
    }
    expect(past()).toBe(1);
  });
});

describe('typing bursts', () => {
  it('edits of one text far apart in time are separate steps', () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
    try {
      load([slide('a', '<p>a</p>')], 'a');
      const edit = (title: string) =>
        commitCourseEdit({ coalesceKey: 'text:t-a' }, () =>
          useStageStore.getState().updateScene('a', { title }),
        );
      edit('one');
      vi.setSystemTime(1_000_000 + BURST_MAX_GAP_MS - 1);
      edit('two');
      expect(past()).toBe(1);
      vi.setSystemTime(1_000_000 + 2 * BURST_MAX_GAP_MS);
      edit('three');
      expect(past()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the stage store', () => {
  it('does not load the sanitizer through scene-echo', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync('lib/store/stage.ts', 'utf8')).not.toMatch(
      /from '@\/lib\/edit\/scene-echo'/,
    );
  });
});

describe('the video manifest', () => {
  it('undo restores only the keys the step moved', () => {
    const before = {
      stage: {
        id: STAGE,
        name: 'c',
        videoManifest: { removed: { prompt: 'r' }, other: { prompt: 'old' } },
      } as unknown as Stage,
      scenes: [] as Scene[],
      currentSceneId: null,
    };
    const after = {
      ...before,
      stage: {
        ...before.stage,
        videoManifest: { other: { prompt: 'old' } },
      } as unknown as Stage,
    };
    const entry = diffCourse(before, after, { origin: 'user', at: 1 })!;
    const now = {
      ...after,
      stage: {
        ...after.stage,
        videoManifest: { other: { prompt: 'updated since' } },
      } as unknown as Stage,
    };
    const applied = applyTimelineEntry(now, entry, 'undo')!;
    expect(applied.stage?.videoManifest).toEqual({
      removed: { prompt: 'r' },
      other: { prompt: 'updated since' },
    });
  });
});
