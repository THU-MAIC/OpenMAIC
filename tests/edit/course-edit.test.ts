import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultSlide, createDefaultTextElement } from '@/lib/edit/slide-edit-elements';
import type { Scene, SlideContent, Stage } from '@/lib/types/stage';

vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: vi.fn(async () => ({ failedChanges: [] })),
  saveStageDataIncremental: vi.fn(async () => ({ failedChanges: [] })),
}));

const { useStageStore, snapshotPendingStageChangesForDeletion, discardPendingStageChanges } =
  await import('@/lib/store/stage');
const { commitCourseEdit, recordAgentChange, stepCourseTimeline, sweepExpiredCourseSteps } =
  await import('@/lib/edit/course-edit');
const { useCourseTimeline, ASSET_RETENTION_MS } = await import('@/lib/edit/course-timeline');
const { useCanvasStore } = await import('@/lib/store/canvas');
const { useSlideEditSession } = await import('@/components/edit/surfaces/slide/slide-edit-session');
const { useQuizEditSession } = await import('@/components/edit/surfaces/quiz/quiz-edit-session');

const STAGE = 'stage-1';

function slide(id: string, textId = `t-${id}`, content = '<p>Hello</p>'): Scene {
  const canvas = createDefaultSlide(`c-${id}`);
  canvas.elements.push({ ...createDefaultTextElement(textId), content });
  return {
    id,
    stageId: STAGE,
    type: 'slide',
    title: id,
    order: 1,
    content: { type: 'slide', schemaVersion: 1, canvas },
    actions: [],
    createdAt: 1,
    updatedAt: 1,
  } as unknown as Scene;
}

const contentOf = (id: string) =>
  useStageStore.getState().scenes.find((scene) => scene.id === id)?.content as SlideContent;
const textOf = (id: string) =>
  contentOf(id).canvas.elements[0] as { content: string; left: number; height: number };
const line = () => useCourseTimeline.getState().lines[STAGE];
const steps = () => line()?.past.length ?? 0;
const pending = () => snapshotPendingStageChangesForDeletion(STAGE);

function withElement(id: string, patch: Record<string, unknown>): SlideContent {
  const next = structuredClone(contentOf(id));
  Object.assign(next.canvas.elements[0], patch);
  return next;
}

beforeEach(() => {
  discardPendingStageChanges(STAGE);
  useCourseTimeline.getState().clearCourse(STAGE);
  useCourseTimeline.getState().endAgentRun(0);
  useStageStore.setState({
    stage: { id: STAGE, name: 'Course' } as unknown as Stage,
    scenes: [slide('p1'), slide('p2'), slide('p3')],
    currentSceneId: 'p1',
  });
  useSlideEditSession.getState().seed('p1');
  useCanvasStore.getState().setActiveElementIdList([]);
});

describe('slide edits on the timeline', () => {
  it('records typing with no pointer gesture as one step, and a burst stays one step', () => {
    useSlideEditSession.getState().commitContent('p1', withElement('p1', { content: '<p>H</p>' }));
    useSlideEditSession.getState().commitContent('p1', withElement('p1', { content: '<p>Hi</p>' }));
    expect(steps()).toBe(1);
    stepCourseTimeline('undo');
    expect(textOf('p1').content).toBe('<p>Hello</p>');
    stepCourseTimeline('redo');
    expect(textOf('p1').content).toBe('<p>Hi</p>');
  });

  it('writes auto-height with no step, and does not clear redo', () => {
    useSlideEditSession.getState().commitContent('p1', withElement('p1', { left: 7 }));
    stepCourseTimeline('undo');
    useSlideEditSession.getState().commitMeasurement('p1', withElement('p1', { height: 321 }));
    expect(textOf('p1').height).toBe(321);
    expect(steps()).toBe(0);
    expect(line().future).toHaveLength(1);
  });

  it('records a user resize of the same field made inside a pointer gesture', () => {
    useSlideEditSession.getState().commitContent('p1', withElement('p1', { height: 321 }));
    expect(steps()).toBe(1);
  });

  it('records a move even if the gesture flag was lost', () => {
    useSlideEditSession.getState().commitContent('p1', withElement('p1', { left: 44 }));
    expect(steps()).toBe(1);
  });

  it('gives a drag then typing two steps', () => {
    useSlideEditSession.getState().commitContent('p1', withElement('p1', { left: 44 }));
    useSlideEditSession.getState().commitContent('p1', withElement('p1', { content: '<p>x</p>' }));
    expect(steps()).toBe(2);
  });

  it('maps editor history modes: record a step, neutral none, navigate folds into the burst', () => {
    const session = useSlideEditSession.getState();
    const text = (content: string, history: 'record' | 'neutral' | 'navigate') => ({
      origin: 'canvas' as const,
      history,
      operations: [{ type: 'text.updateContent' as const, elementId: 't-p1', content }],
    });
    session.applyTransactionForScene('p1', text('<p>a</p>', 'record'));
    session.applyTransactionForScene('p1', text('<p>ab</p>', 'record'));
    expect(steps()).toBe(1);
    session.applyTransactionForScene('p1', text('<p>a</p>', 'navigate'));
    expect(steps()).toBe(1);
    expect(textOf('p1').content).toBe('<p>a</p>');
    session.applyTransactionForScene('p1', text('<p>Hello</p>', 'navigate'));
    expect(steps()).toBe(0);
    session.applyTransactionForScene('p1', {
      origin: 'system',
      history: 'neutral',
      operations: [{ type: 'element.update', elementId: 't-p1', patch: { height: 200 } }],
    });
    expect(steps()).toBe(0);
    expect(textOf('p1').height).toBe(200);
  });

  it('rejects a transaction captured by a previous scene', () => {
    useSlideEditSession.getState().seed('p2');
    useSlideEditSession.getState().applyTransactionForScene('p1', {
      origin: 'toolbar',
      history: 'record',
      operations: [{ type: 'element.update', elementId: 't-p1', patch: { left: 999 } }],
    });
    expect(textOf('p1').left).not.toBe(999);
    expect(steps()).toBe(0);
  });
});

describe('the #1529 case', () => {
  const agentWrite = (patch: (content: SlideContent) => void) => {
    const before = useStageStore.getState();
    const content = structuredClone(contentOf('p1'));
    patch(content);
    useStageStore.setState({
      scenes: before.scenes.map((scene) =>
        scene.id === 'p1' ? ({ ...scene, content } as Scene) : scene,
      ),
    });
    recordAgentChange(before);
  };
  const addAgentElement = (content: SlideContent) =>
    content.canvas.elements.push({ ...createDefaultTextElement('agent-text'), content: 'agent' });
  const ids = () => contentOf('p1').canvas.elements.map((element) => element.id);

  it('a local edit builds on an agent change instead of overwriting it', () => {
    agentWrite(addAgentElement);
    useSlideEditSession.getState().commitContent('p1', withElement('p1', { left: 5 }));
    expect(ids()).toContain('agent-text');
    useSlideEditSession
      .getState()
      .applyOp({ type: 'element.update', elementId: 't-p1', patch: { left: 6 } });
    expect(ids()).toContain('agent-text');
  });

  it('undo is strictly ordered: the agent step, then the hand edit, and redo returns both', () => {
    useSlideEditSession.getState().commitContent('p1', withElement('p1', { left: 5 }));
    agentWrite(addAgentElement);
    expect(steps()).toBe(2);
    expect(line().past[1].origin).toBe('agent');

    stepCourseTimeline('undo');
    expect(ids()).not.toContain('agent-text');
    expect(textOf('p1').left).toBe(5);

    stepCourseTimeline('undo');
    expect(textOf('p1').left).not.toBe(5);

    stepCourseTimeline('redo');
    expect(textOf('p1').left).toBe(5);
    expect(ids()).not.toContain('agent-text');

    stepCourseTimeline('redo');
    expect(ids()).toContain('agent-text');
  });

  it('one run is one step; an undo in the middle closes it', () => {
    useCourseTimeline.getState().beginAgentRun(Date.now());
    agentWrite(addAgentElement);
    agentWrite((content) => {
      content.canvas.background = { type: 'solid', color: '#000000' };
    });
    expect(steps()).toBe(1);
    stepCourseTimeline('undo');
    expect(ids()).not.toContain('agent-text');
    agentWrite((content) => {
      content.canvas.background = { type: 'solid', color: '#111111' };
    });
    expect(steps()).toBe(1);
    expect(line().future).toHaveLength(0);
    useCourseTimeline.getState().endAgentRun(Date.now());
  });
});

describe('undo and redo across the course', () => {
  it('jumps to the page, clears the selection, and restores a deleted page in place', () => {
    useSlideEditSession.getState().commitContent('p1', withElement('p1', { left: 5 }));
    useStageStore.getState().setCurrentSceneId('p3');
    commitCourseEdit({}, () => useStageStore.getState().deleteScene('p2'));
    useCanvasStore.getState().setActiveElementIdList(['t-p3']);

    stepCourseTimeline('undo');
    expect(useStageStore.getState().scenes.map((scene) => scene.id)).toEqual(['p1', 'p2', 'p3']);
    expect(useStageStore.getState().currentSceneId).toBe('p2');
    expect(useCanvasStore.getState().activeElementIdList).toEqual([]);

    stepCourseTimeline('undo');
    expect(useStageStore.getState().currentSceneId).toBe('p1');
    expect(textOf('p1').left).not.toBe(5);

    stepCourseTimeline('redo');
    expect(textOf('p1').left).toBe(5);
    stepCourseTimeline('redo');
    expect(useStageStore.getState().scenes.map((scene) => scene.id)).toEqual(['p1', 'p3']);
  });

  it('marks exactly what changed for saving', () => {
    commitCourseEdit({}, () => useStageStore.getState().updateScene('p2', { title: 'New' }));
    discardPendingStageChanges(STAGE);
    stepCourseTimeline('undo');
    expect(pending()).toEqual(
      expect.arrayContaining([{ kind: 'scene', sceneId: 'p2' }, { kind: 'currentScene' }]),
    );
    expect(pending().some((change) => change.kind === 'structure')).toBe(false);

    commitCourseEdit({}, () => useStageStore.getState().deleteScene('p3'));
    discardPendingStageChanges(STAGE);
    stepCourseTimeline('undo');
    expect(pending()).toEqual(expect.arrayContaining([{ kind: 'structure' }]));
  });

  it('survives leaving the course and coming back', () => {
    commitCourseEdit({}, () => useStageStore.getState().updateScene('p1', { title: 'Mine' }));
    const scenes = useStageStore.getState().scenes;
    useStageStore.setState({
      stage: { id: 'other', name: 'Other' } as unknown as Stage,
      scenes: [{ ...slide('o1'), stageId: 'other' }],
    });
    expect(line().past).toHaveLength(1);
    useStageStore.setState({ stage: { id: STAGE, name: 'Course' } as unknown as Stage, scenes });
    expect(line().past).toHaveLength(1);
    stepCourseTimeline('undo');
    expect(useStageStore.getState().scenes[0].title).toBe('p1');
  });

  it('puts a change made while the course was away on the line', () => {
    commitCourseEdit({}, () => useStageStore.getState().updateScene('p1', { title: 'Mine' }));
    const scenes = useStageStore.getState().scenes;
    useStageStore.setState({
      stage: { id: 'other', name: 'Other' } as unknown as Stage,
      scenes: [{ ...slide('o1'), stageId: 'other' }],
    });
    useStageStore.setState({
      stage: { id: STAGE, name: 'Course' } as unknown as Stage,
      scenes: scenes.map((scene) =>
        scene.id === 'p2' ? ({ ...scene, title: 'Agent, away' } as Scene) : scene,
      ),
    });
    expect(line().past).toHaveLength(2);
    expect(line().past[1].origin).toBe('agent');
  });

  it('skips a step that no longer changes anything', () => {
    commitCourseEdit({}, () => useStageStore.getState().updateScene('p1', { title: 'One' }));
    commitCourseEdit({}, () => useStageStore.getState().updateScene('p2', { title: 'Two' }));
    useStageStore.setState({
      scenes: useStageStore.getState().scenes.filter((scene) => scene.id !== 'p2'),
    });
    stepCourseTimeline('undo');
    expect(useStageStore.getState().scenes[0].title).toBe('p1');
    expect(steps()).toBe(0);
  });

  it('expires a step whose media left the document 45 minutes ago', () => {
    const withImage = {
      ...slide('p1'),
      content: {
        type: 'slide',
        canvas: {
          ...createDefaultSlide('c'),
          elements: [
            { id: 'img', type: 'image', src: 'asset-1', left: 0, top: 0, width: 1, height: 1 },
          ],
        },
      },
    } as unknown as Scene;
    useStageStore.setState({ scenes: [withImage, slide('p2')] });
    const removedAt = Date.now();
    commitCourseEdit({}, () => useStageStore.getState().deleteScene('p1'));
    expect(steps()).toBe(1);
    expect(sweepExpiredCourseSteps(removedAt + ASSET_RETENTION_MS - 60_000)).toBe(0);
    expect(sweepExpiredCourseSteps(removedAt + ASSET_RETENTION_MS + 60_000)).toBe(1);
    expect(steps()).toBe(0);
  });
});

describe('saving what an undo changed', () => {
  it('still writes a change made while another save is on the wire', async () => {
    const storage = await import('@/lib/utils/stage-storage');
    const save = vi.mocked(storage.saveStageDataIncremental);
    vi.useFakeTimers();
    try {
      save.mockClear();
      let finishFirst!: (value: { failedChanges: never[] }) => void;
      save.mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)));

      commitCourseEdit({}, () => useStageStore.getState().updateScene('p1', { title: 'One' }));
      await vi.advanceTimersByTimeAsync(600);
      expect(save).toHaveBeenCalledTimes(1);

      commitCourseEdit({}, () => useStageStore.getState().updateScene('p2', { title: 'Two' }));
      stepCourseTimeline('undo');
      finishFirst({ failedChanges: [] });
      await vi.advanceTimersByTimeAsync(600);

      expect(save).toHaveBeenCalledTimes(2);
      const [, dirty] = save.mock.calls[1];
      expect(dirty).toEqual(expect.arrayContaining([{ kind: 'scene', sceneId: 'p2' }]));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('quiz edits on the timeline', () => {
  const quiz = (question: string) =>
    ({
      type: 'quiz',
      questions: [{ id: 'q', type: 'single', question, options: [], answer: [] }],
    }) as never;
  beforeEach(() => {
    useStageStore.setState({
      scenes: [{ ...slide('q1'), type: 'quiz', content: quiz('start') } as unknown as Scene],
      currentSceneId: 'q1',
    });
    useQuizEditSession.getState().seed('q1');
  });
  const question = () =>
    (useStageStore.getState().scenes[0].content as unknown as { questions: { question: string }[] })
      .questions[0].question;

  it('folds typing in one field, starts a new step on another field or a discrete commit', () => {
    const session = useQuizEditSession.getState();
    session.commitText(quiz('s'), 'q:question');
    session.commitText(quiz('st'), 'q:question');
    expect(steps()).toBe(1);
    session.commitText(quiz('other'), 'q:analysis');
    expect(steps()).toBe(2);
    session.commit(quiz('discrete'));
    session.commitText(quiz('again'), 'q:analysis');
    expect(steps()).toBe(4);
  });

  it('undoes and redoes on the canonical content, including a change made elsewhere', () => {
    const session = useQuizEditSession.getState();
    session.commit(quiz('mine'));
    const before = useStageStore.getState();
    useStageStore.setState({
      scenes: [{ ...before.scenes[0], content: quiz('agent') } as unknown as Scene],
    });
    recordAgentChange(before);
    session.commit(quiz('mine again'));
    stepCourseTimeline('undo');
    expect(question()).toBe('agent');
    stepCourseTimeline('undo');
    expect(question()).toBe('mine');
    stepCourseTimeline('undo');
    expect(question()).toBe('start');
    stepCourseTimeline('redo');
    expect(question()).toBe('mine');
  });
});
