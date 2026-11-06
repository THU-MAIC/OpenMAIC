// @vitest-environment jsdom

/**
 * Cases where the timeline met the rest of the app badly: the renderer's real
 * empty-text cleanup, reads overtaken by saves, whole-document agent saves, and
 * write-backs that are not steps. They run the real TextElement, controller,
 * session and store rather than calling the session with hand-built snapshots.
 */

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
const { useStageStore, discardPendingStageChanges } = await import('@/lib/store/stage');
const {
  commitCourseEdit,
  recordAgentChange,
  stampGeneratedAudio,
  stepCourseTimeline,
  sweepExpiredCourseSteps,
} = await import('@/lib/edit/course-edit');
const {
  useCourseTimeline,
  AGENT_RUN_IDLE_MS,
  ASSET_RETENTION_MS,
  BURST_MAX_GAP_MS,
  applyTimelineEntry,
  diffCourse,
} = await import('@/lib/edit/course-timeline');
const { useCanvasStore } = await import('@/lib/store/canvas');
const { useSlideEditSession } = await import('@/components/edit/surfaces/slide/slide-edit-session');
const { keepLocalWhereUnchanged } = await import('@/lib/edit/scene-echo');
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

beforeEach(() => {
  discardPendingStageChanges(STAGE);
  useCourseTimeline.getState().clearCourse(STAGE);
  useCourseTimeline.setState({ agentRun: null });
  useSlideEditSession.getState().end();
});

describe('switching pages', () => {
  it('drops the selection, which could name an element with the same id on the next page', () => {
    load([slide('a', '<p>a</p>'), slide('b', '<p>b</p>', 2)], 'a');
    useCanvasStore.getState().setActiveElementIdList(['t-a']);
    useCanvasStore.getState().setEditingElementId('t-a');
    useStageStore.getState().setCurrentSceneId('a');
    expect(useCanvasStore.getState().activeElementIdList).toEqual(['t-a']);
    useStageStore.getState().setCurrentSceneId('b');
    expect(useCanvasStore.getState().activeElementIdList).toEqual([]);
    expect(useCanvasStore.getState().editingElementId).toBe('');
  });
});

describe('a commit that outlives its page', () => {
  it('writes to the scene it was built from, not the one open now', () => {
    load([slide('a', '<p>aaa</p>'), slide('b', '<p>bbb</p>', 2)], 'b');
    useSlideEditSession.getState().seed('b');
    const edited = structuredClone(sceneOf('a').content as SlideContent);
    edited.canvas.elements = [];
    useSlideEditSession.getState().commitContent('a', edited);
    expect(elementsOf('b').map((element) => element.id)).toEqual(['t-b']);
    expect(elementsOf('a')).toEqual([]);
  });
});

describe('reading back a scene nobody changed', () => {
  it('a PBL scene with learner progress reads back as unchanged', () => {
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
    expect(keepLocalWhereUnchanged([local], [persisted])[0]).toBe(local);
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
    stampGeneratedAudio('a', '1', 'ONE', 'tts_1');
    stampGeneratedAudio('a', '2', 'two', 'tts_2');
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

describe('audio generated from text that has since changed', () => {
  it('stays off the line, and comes back with the text on redo', () => {
    const scene = slide('a', '<p>x</p>');
    (scene as unknown as { actions: unknown[] }).actions = [
      { id: '1', type: 'speech', text: 'old' },
    ];
    load([scene], 'a');
    commitCourseEdit({}, () =>
      useStageStore.getState().updateScene('a', {
        actions: [{ id: '1', type: 'speech', text: 'new' }] as never,
      }),
    );
    // Generating from 'new' when the undo lands.
    stepCourseTimeline('undo');
    stampGeneratedAudio('a', '1', 'new', 'tts_new');
    const audio = () => (sceneOf('a').actions![0] as unknown as { audioId?: string }).audioId;
    expect((sceneOf('a').actions![0] as unknown as { text: string }).text).toBe('old');
    expect(audio()).toBeUndefined();
    stepCourseTimeline('redo');
    expect(audio()).toBe('tts_new');
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

describe('an agent run across an undo', () => {
  it('starts a new step: undo does not jump past where the run had got to', () => {
    load([slide('a', '<p>a</p>')], 'a');
    const agentTitle = (title: string) => {
      const before = useStageStore.getState();
      useStageStore.setState({
        scenes: before.scenes.map((scene) => ({ ...scene, title }) as Scene),
      });
      recordAgentChange(before);
    };
    useCourseTimeline.getState().beginAgentRun(Date.now());
    agentTitle('A1');
    commitCourseEdit({}, () => useStageStore.getState().updateScene('a', { notes: 'h' } as never));
    agentTitle('A2');
    stepCourseTimeline('undo');
    stepCourseTimeline('undo');
    expect(sceneOf('a').title).toBe('A1');
    agentTitle('A3');
    stepCourseTimeline('undo');
    expect(sceneOf('a').title).toBe('A1');
  });
});

describe('a PBL v2 project', () => {
  const project = (title: string, submissions: unknown[]) => ({
    uiPhase: 'workspace',
    title,
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
          { id: 'microtask-1', title: 'T', status: 'todo', assignee: 'user', hints: [], order: 0 },
        ],
      },
    ],
    submissions,
    evaluations: [],
    threads: [],
    engagementEvents: [],
    runtimeEvents: [],
    createdAt: '2026-08-07T08:00:00.000Z',
    updatedAt: '2026-08-07T08:00:03.000Z',
  });
  const pbl = (projectV2: unknown) =>
    ({
      id: 'p',
      stageId: STAGE,
      type: 'pbl',
      title: 'P',
      order: 1,
      actions: [],
      content: { type: 'pbl', projectV2 },
    }) as unknown as Scene;

  it('keeps learner work done after a design change that is undone', () => {
    load([pbl(project('Design one', []))], 'p');
    const before = useStageStore.getState();
    useStageStore.setState({ scenes: [pbl(project('Design two', []))] });
    recordAgentChange(before);
    // The learner works: not a step.
    const work = [
      {
        id: 'submission-1',
        microtaskId: 'microtask-1',
        milestoneId: 'milestone-1',
        kind: 'text',
        content: 'learner work',
        createdAt: '2026-08-07T08:00:04.000Z',
      },
    ];
    useStageStore.getState().updateScene('p', {
      content: { type: 'pbl', projectV2: project('Design two', work) } as never,
    });
    stepCourseTimeline('undo');
    const now = (
      sceneOf('p').content as unknown as { projectV2: { title: string; submissions: unknown[] } }
    ).projectV2;
    expect(now.title).toBe('Design one');
    expect(now.submissions).toHaveLength(1);
  });

  // The sync brings the server's copy back without the learner state this browser
  // holds (here, the runtime event outbox).
  const runtimeEvent = { id: 'event-1', type: 'microtask_started', at: '2026-08-07T08:00:05Z' };
  const withEvents = (projectV2: Record<string, unknown>) => ({
    ...projectV2,
    runtimeEvents: [runtimeEvent],
  });
  const withoutEvents = (projectV2: Record<string, unknown>) => {
    const { runtimeEvents: _events, ...rest } = projectV2;
    return rest;
  };

  it('puts no step on the line for a change to learner state only', () => {
    load([pbl(withEvents(project('Design one', [])))], 'p');
    const before = useStageStore.getState();
    useStageStore.setState({ scenes: [pbl(withoutEvents(project('Design one', [])))] });
    recordAgentChange(before);
    expect(past()).toBe(0);
  });

  it('records only the design part of a change that also moves learner state', () => {
    load([pbl(withEvents(project('Design one', [])))], 'p');
    const before = useStageStore.getState();
    useStageStore.setState({ scenes: [pbl(withoutEvents(project('Design two', [])))] });
    recordAgentChange(before);
    // The learner's outbox fills again, then the sync takes it away again.
    useStageStore.setState({ scenes: [pbl(withEvents(project('Design two', [])))] });
    const synced = useStageStore.getState();
    useStageStore.setState({ scenes: [pbl(withoutEvents(project('Design two', [])))] });
    recordAgentChange(synced);
    expect(past()).toBe(1);
    const recorded = Object.values(line().past[0].scenes)[0];
    expect(JSON.stringify(recorded)).not.toContain('event-1');
    stepCourseTimeline('undo');
    const now = (sceneOf('p').content as unknown as { projectV2: { title: string } }).projectV2;
    expect(now.title).toBe('Design one');
  });

  const submission = (id: string) => ({
    id,
    microtaskId: 'microtask-1',
    milestoneId: 'milestone-1',
    kind: 'text',
    content: id,
    createdAt: '2026-08-07T08:00:04.000Z',
  });
  const submissionsOf = (id: string) =>
    (sceneOf(id).content as unknown as { projectV2: { submissions: { id: string }[] } }).projectV2
      .submissions;
  const deletePage = () => commitCourseEdit({}, () => useStageStore.getState().deleteScene('p'));

  it('brings a deleted page back with its learner work', () => {
    load([slide('a', 'A'), pbl(project('Design one', [submission('submission-1')]))], 'p');
    deletePage();
    stepCourseTimeline('undo');
    expect(submissionsOf('p').map((item) => item.id)).toEqual(['submission-1']);
  });

  it('brings a page back again with the learner work done since it last came back', () => {
    load([slide('a', 'A'), pbl(project('Design one', [submission('submission-1')]))], 'p');
    deletePage();
    stepCourseTimeline('undo');
    // The learner works on the restored page: not a step.
    useStageStore.getState().updateScene('p', {
      content: {
        type: 'pbl',
        projectV2: withEvents(
          project('Design one', [submission('submission-1'), submission('submission-2')]),
        ),
      } as never,
    });
    stepCourseTimeline('redo');
    expect(useStageStore.getState().scenes.some((scene) => scene.id === 'p')).toBe(false);
    stepCourseTimeline('undo');
    expect(submissionsOf('p').map((item) => item.id)).toEqual(['submission-1', 'submission-2']);
    const restored = (
      sceneOf('p').content as unknown as { projectV2: { runtimeEvents?: unknown[] } }
    ).projectV2;
    expect(restored.runtimeEvents).toEqual([runtimeEvent]);
  });
});

describe('a course coming back from another tab', () => {
  const other = (id: string) =>
    ({ ...slide(`${id}-1`, '<p>x</p>'), stageId: id }) as unknown as Scene;
  const switchTo = (stageId: string, scenes: Scene[]) =>
    useStageStore.setState({
      stage: { id: stageId, name: stageId } as unknown as Stage,
      scenes,
      currentSceneId: scenes[0].id,
    });

  it('does not take a measured text height for a change, and keeps redo', () => {
    load([slide('a', '<p>a</p>')], 'a');
    commitCourseEdit({}, () => useStageStore.getState().updateScene('a', { title: 'renamed' }));
    stepCourseTimeline('undo');
    const left = useStageStore.getState().scenes;
    switchTo('other', [other('other')]);
    const back = structuredClone(left);
    ((back[0].content as SlideContent).canvas.elements[0] as { height: number }).height = 92;
    switchTo(STAGE, back);
    expect([past(), future()]).toEqual([0, 1]);
  });

  it('dates media gone while it was away from the departure', () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
    try {
      const withImage = slide('a', '<p>a</p>');
      (withImage.content as SlideContent).canvas.elements.push({
        id: 'img',
        type: 'image',
        left: 0,
        top: 0,
        width: 10,
        height: 10,
        rotate: 0,
        fixedRatio: true,
        src: 'asset:ast_image_1',
      } as never);
      load([withImage], 'a');
      commitCourseEdit({}, () => useStageStore.getState().updateScene('a', { title: 'renamed' }));
      const left = useStageStore.getState().scenes;
      switchTo('other', [other('other')]);
      vi.setSystemTime(1_000_000 + ASSET_RETENTION_MS + 60_000);
      const back = structuredClone(left);
      (back[0].content as SlideContent).canvas.elements = (
        back[0].content as SlideContent
      ).canvas.elements.filter((element) => element.id !== 'img');
      switchTo(STAGE, back);
      expect(past()).toBe(2);
      expect(sweepExpiredCourseSteps()).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('typing bursts', () => {
  it('a burst that cancels out does not let the next edit fold into an older step', () => {
    load([slide('a', '<p>a</p>')], 'a');
    const type = (title: string) =>
      commitCourseEdit({ coalesceKey: 'text:t-a' }, () =>
        useStageStore.getState().updateScene('a', { title }),
      );
    type('typed');
    commitCourseEdit({}, () => useStageStore.getState().updateScene('a', { notes: 'x' } as never));
    stepCourseTimeline('undo');
    expect(sceneOf('a').title).toBe('typed');
    type('typed more');
    type('typed');
    expect(past()).toBe(1);
    type('typed again');
    expect(past()).toBe(2);
    stepCourseTimeline('undo');
    expect(sceneOf('a').title).toBe('typed');
  });

  it('text with the same element id on two pages stays two steps', () => {
    const shared = (id: string, order: number) => {
      const scene = slide(id, '<p>start</p>', order);
      (scene.content as SlideContent).canvas.elements[0].id = 'same-id';
      return scene;
    };
    load([shared('a', 1), shared('b', 2)], 'a');
    const text = (id: string, content: string) => {
      const next = structuredClone(sceneOf(id).content as SlideContent);
      (next.canvas.elements[0] as unknown as { content: string }).content = content;
      useSlideEditSession.getState().commitContent(id, next);
    };
    text('a', '<p>on a</p>');
    text('b', '<p>on b</p>');
    expect(past()).toBe(2);
  });

  it('text operations with the same element id on two pages stay two steps', () => {
    const shared = (id: string, order: number) => {
      const scene = slide(id, '<p>start</p>', order);
      (scene.content as SlideContent).canvas.elements[0].id = 'same-id';
      return scene;
    };
    load([shared('a', 1), shared('b', 2)], 'a');
    const typeIn = (id: string, content: string) => {
      useSlideEditSession.getState().seed(id);
      useSlideEditSession.getState().applyTransaction({
        origin: 'canvas',
        history: 'record',
        operations: [{ type: 'text.updateContent', elementId: 'same-id', content }],
      } as never);
    };
    typeIn('a', '<p>on a</p>');
    typeIn('b', '<p>on b</p>');
    expect(past()).toBe(2);
  });

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
